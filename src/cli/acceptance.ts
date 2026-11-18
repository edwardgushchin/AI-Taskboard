import { dirname, join, relative } from "node:path";
import { artifactFiles } from "./artifacts.ts";
import { isolatedWorktreesDirectory, excludeBoard, git, inspectMergeTree, isAncestor, localBranch, mergeTree, requireRepository, resolveCommit, skipAutoMaintenance, worktrees } from "./git.ts";
import type { Repository, Worktree } from "./git.ts";
import { boardReviewMode, member, number, object, record, requireRevision, requireState, TaskboardError, text } from "./model.ts";
import type { IntegrationMode, Task, TaskGit } from "./model.ts";
import { checkPreserveChanges, describeSavedChanges, inspectLocalChanges, restoreSavedChanges, saveLocalChanges } from "./saved-changes.ts";
import { directory, exists, readJson, removeFile, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { conventionalMessage, noChangesReviewIsStale } from "./submission.ts";
import { checkProtectedPaths, cleanTaskWorktree, collidingPaths, findWorktree, gitStatus, isolateTaskWorktree, requireNoGitOperation, usableWorktree } from "./worktree.ts";
import { withoutVerification } from "./tasks.ts";
import { currentReviewApproval } from "./task-messages.ts";

interface AcceptIntent {
  action: "accept";
  revision: number;
  target: string;
  parent: string;
  submitted: string;
  tree: string;
  mode: IntegrationMode;
  message: string;
  actor?: "manager" | "reviewer";
  reviewModeVersion?: number;
  restoreLocalChanges?: true;
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const diffOptions = ["--no-ext-diff", "--no-textconv"];
const mergeOptions = ["-s", "ort", "--no-autostash", "--no-overwrite-ignore", "--no-rerere-autoupdate"];

function splitPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function reviewed(task: Task): TaskGit & { submission: NonNullable<TaskGit["submission"]> } {
  const context = task.git;
  if (!context?.submission || context.branch !== "refs/heads/ai-taskboard/" + task.id ||
      !oid.test(context.submission.sha)) {
    throw new TaskboardError("SUBMISSION_REQUIRED", "Submit a task commit before accepting it.");
  }
  return { ...context, submission: context.submission };
}

function targetHead(repo: Repository, target: string): string {
  const head = resolveCommit(repo.root, target);
  if (!head) throw new TaskboardError("TARGET_UNAVAILABLE", "The target branch no longer has a commit.", { target });
  return head;
}

function reviewWorktreePath(item: Worktree | undefined): string | undefined {
  return item && !item.prunable && exists(item.path) ? usableWorktree(item) : undefined;
}

function submissionIsStale(item: Worktree | undefined, submitted: string): boolean {
  const path = item?.head === submitted ? reviewWorktreePath(item) : undefined;
  return !path || Boolean(gitStatus(path, "tracked"));
}

function reviewMerge(path: string, base: string, head: string, submitted: string) {
  if (base === submitted) return { status: "integrated" as const };
  return base === head ? { status: "clean" as const } : inspectMergeTree(path, head, submitted);
}

export function inspectReviewQueue(store: BoardStore, tasks: Task[]) {
  const repo = store.location.repository;
  const entries = repo && tasks.some(task => !task.result?.noChanges) ? worktrees(repo.root) : [];
  const targets = new Map<string, { branch: string; head: string; path: string }>();
  const settings = store.index.settings;
  const hybrid = boardReviewMode(settings) === "reviewer-human";
  return tasks.map(task => {
    const { id, title, revision, history } = task;
    const submittedAt = history.findLast(event => event.action === "submit" && event.to === "review")?.at;
    const approval = currentReviewApproval(task, settings)?.reviewApproval;
    const reviewStatus = (head: string | null) => approval && (!hybrid || approval.targetHead === head)
      ? { reviewerApproved: true } : {};
    const entry = { id, title, revision, submittedAt, summary: task.result?.summary ?? task.summary };
    try {
      if (exists(store.pendingPath(id))) return { ...entry, status: "pending" as const };
      if (task.result?.noChanges) {
        const stale = noChangesReviewIsStale(store, task, task.result.noChanges.head);
        return { ...entry, ...(!stale && reviewStatus(null)), status: stale ? "stale" as const : "noChanges" as const };
      }
      const { target, branch, submission: { sha } } = reviewed(task);
      const repository = requireRepository(repo);
      let snapshot = targets.get(target);
      if (!snapshot) {
        const targetBranch = localBranch(repository, target);
        snapshot = { branch: targetBranch, head: targetHead(repository, targetBranch),
          path: reviewWorktreePath(findWorktree(repository, targetBranch, entries)) ?? repository.root };
        targets.set(target, snapshot);
      }
      const gitEntry = { ...entry, target: snapshot.branch, targetHead: snapshot.head };
      if (submissionIsStale(findWorktree(repository, branch, entries), sha)) return { ...gitEntry, status: "stale" as const };
      const base = git(repository.root, ["merge-base", snapshot.head, sha]).trim();
      return { ...gitEntry, ...reviewStatus(snapshot.head), ...reviewMerge(snapshot.path, base, snapshot.head, sha) };
    } catch (error) {
      if (!(error instanceof TaskboardError)) throw error;
      return { ...entry, status: "unchecked" as const, error: { code: error.code, message: error.message } };
    }
  });
}

export function reviewDetails(store: BoardStore, task: Task, compact: boolean) {
  requireState(task, ["review"]);
  const path = store.pendingPath(task.id);
  const pending = exists(path);
  const fullGitReview = !compact && !task.result?.noChanges;
  return {
    pending,
    artifacts: compact ? artifactFiles(store, task.id) : [],
    intent: fullGitReview && pending ? readJson(path) : undefined,
    savedChanges: fullGitReview ? describeSavedChanges(store, task) : undefined,
  };
}

function reviewGitState(store: BoardStore, task: Task) {
  const context = reviewed(task);
  const repo = requireRepository(store.location.repository);
  const target = localBranch(repo, context.target);
  const head = targetHead(repo, target);
  const submitted = context.submission.sha;
  const stale = submissionIsStale(findWorktree(repo, context.branch), submitted);
  return { context, repo, target, head, submitted, stale };
}

export function verifyReviewDecision(store: BoardStore, task: Task, expectedHead: unknown) {
  requireState(task, ["review"]);
  const noChanges = task.result?.noChanges;
  const { stale, head } = noChanges
    ? { stale: noChangesReviewIsStale(store, task, noChanges.head), head: null }
    : reviewGitState(store, task);
  if (stale || expectedHead !== head) {
    throw new TaskboardError(stale ? "STALE_SUBMISSION" : "TARGET_CHANGED",
      "Review the current submission and target branch before recording the result.");
  }
  return head;
}

export function inspectReview(store: BoardStore, task: Task, snapshot: ReturnType<typeof reviewDetails>,
  compact: boolean, previousTargetHead?: unknown, previousSubmitted?: unknown) {
  const reviewMode = boardReviewMode(store.index.settings);
  const reviewModeVersion = store.index.settings.reviewModeVersion;
  const approval = currentReviewApproval(task, store.index.settings);
  const approvalState = (head: string | null, stale: boolean) => ({
    reviewMode, reviewModeVersion,
    ...(compact && snapshot.pending ? { pending: true } : {}),
    awaitingHumanAcceptance: reviewMode === "reviewer-human" && !stale && approval?.reviewApproval?.targetHead === head,
  });
  const details = compact ? { title: task.title, description: task.description, criteria: task.criteria,
    artifacts: snapshot.artifacts,
    submissionSequence: task.history.findLastIndex(event => event.action === "submit" && event.to === "review") + 1,
    ...(approval?.reviewApproval ? { reviewerApproval: { summary: approval.text, ...approval.reviewApproval } } : {}),
  } : undefined;
  if (task.result?.noChanges) {
    const stale = noChangesReviewIsStale(store, task, task.result.noChanges.head);
    return {
      ...approvalState(null, stale), noChanges: true as const, revision: task.revision, targetHead: null, paths: [],
      stale, result: task.result,
      ...(details ?? { diff: "" }),
    };
  }
  const { context, repo, target, head, submitted, stale } = reviewGitState(store, task);
  const base = git(repo.root, ["merge-base", head, submitted]).trim();
  const paths = splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", base, submitted]));
  const canCheckMerge = !stale && !snapshot.pending;
  const diverged = base !== head && base !== submitted;
  const checkout = !details || (canCheckMerge && diverged) ? findWorktree(repo, target) : undefined;
  const checkoutPath = reviewWorktreePath(checkout);
  const merge = canCheckMerge ? reviewMerge(checkoutPath ?? repo.root, base, head, submitted) : undefined;
  const summary = { ...approvalState(head, stale), revision: task.revision, targetHead: head, submitted, stale, paths, result: task.result, merge };
  if (details) {
    const targetChanges = base !== head && paths.length
      ? new Set(splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", base, head]))) : undefined;
    previousTargetHead ??= approval?.reviewApproval?.targetHead;
    const previous = typeof previousTargetHead === "string" && oid.test(previousTargetHead) &&
      previousTargetHead !== head ? resolveCommit(repo.root, previousTargetHead) : undefined;
    const changesSinceReview = previous && splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", previous, head]));
    const previousSubmission = typeof previousSubmitted === "string" && oid.test(previousSubmitted) &&
      previousSubmitted !== submitted ? resolveCommit(repo.root, previousSubmitted) : undefined;
    const submissionChanges = previousSubmission &&
      splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", previousSubmission, submitted]));
    return {
      ...summary, ...details, target, mode: store.index.settings.integrationMode,
      mergeBase: base, targetOverlaps: paths.filter(path => targetChanges?.has(path)),
      ...(changesSinceReview ? { targetChangesSinceReview: { paths: changesSinceReview.slice(0, 100), total: changesSinceReview.length } } : {}),
      ...(submissionChanges ? { submissionChangesSinceReview: { paths: submissionChanges.slice(0, 100), total: submissionChanges.length } } : {}),
    };
  }
  const retry = snapshot.pending ? parseIntent(snapshot.intent, task, target, submitted) : undefined;
  const local = checkoutPath ? inspectLocalChanges(checkoutPath, head) : undefined;
  return {
    ...summary, target, message: retry?.message ?? context.submission.message,
    mode: store.index.settings.integrationMode,
    savedChanges: snapshot.savedChanges,
    localChanges: local && {
      path: local.path, paths: local.paths, token: local.token,
      overlaps: collidingPaths(local.path, local.paths, paths),
    },
    pending: Boolean(retry),
    diff: git(repo.root, ["diff", ...diffOptions, "--binary", base, submitted]),
  };
}

function reviewHunkAtLine(diff: string, line: number, radius?: number): string {
  if ([...diff.matchAll(/^diff --git /gm)].length > 1) {
    throw new TaskboardError("INVALID_INPUT", "Select a single file diff when reading by line.");
  }
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\r\n]*)$/gm)];
  const selected = hunks.findIndex(([, , , start, count]) => {
    const first = Number(start);
    return line >= first && line < first + Math.max(1, Number(count ?? 1));
  });
  if (selected < 0) return "";
  const header = diff.slice(0, hunks[0].index);
  const hunk = hunks[selected];
  const end = hunks[selected + 1]?.index;
  if (radius === undefined) return header + diff.slice(hunk.index, end);

  const [, oldStart, oldCount, newStart, newCount, label] = hunk;
  let oldLine = Number(oldStart) + (oldCount === "0" ? 1 : 0);
  let newLine = Number(newStart) + (newCount === "0" ? 1 : 0);
  let beginning: { old: number; new: number } | undefined;
  let oldLines = 0;
  let newLines = 0;
  const rows: string[] = [];
  let keep = false;
  for (const text of diff.slice(hunk.index + hunk[0].length + 1, end).split(/(?<=\n)/)) {
    const kind = text[0];
    if (kind === " " || kind === "-" || kind === "+") {
      const anchor = newCount === "0" ? Number(newStart) : newLine;
      if (anchor > line + radius) break;
      keep = anchor >= line - radius;
      if (keep) {
        beginning ??= { old: oldLine, new: newLine };
        oldLines += kind === "+" ? 0 : 1;
        newLines += kind === "-" ? 0 : 1;
      }
      oldLine += kind === "+" ? 0 : 1;
      newLine += kind === "-" ? 0 : 1;
    }
    if (keep && text) rows.push(text);
  }
  if (!beginning) return "";
  const oldRange = oldLines ? beginning.old : beginning.old - 1;
  const newRange = newLines ? beginning.new : beginning.new - 1;
  return header + `@@ -${oldRange},${oldLines} +${newRange},${newLines} @@${label}\n` + rows.join("");
}

export function inspectReviewDiff(repository: Repository | null, task: Task, input: Record<string, unknown>) {
  requireState(task, ["review"]);
  requireRevision(task, input.revision, true);
  const paths = input.paths;
  if (!Array.isArray(paths) || !paths.length || !paths.every(path => typeof path === "string" && path.length > 0) ||
      new Set(paths).size !== paths.length || typeof input.targetHead !== "string" || !oid.test(input.targetHead)) {
    throw new TaskboardError("INVALID_INPUT", "Supply the reviewed target HEAD and distinct changed paths.");
  }
  const line = input.line === undefined ? undefined : number(input.line, "line", 1);
  const radius = input.lineRadius === undefined ? undefined : number(input.lineRadius, "lineRadius", 0);
  if (radius !== undefined && (line === undefined || radius > 100)) {
    throw new TaskboardError("INVALID_INPUT", "Use lineRadius between 0 and 100 with a line number.");
  }
  if (line !== undefined && paths.length !== 1) {
    throw new TaskboardError("INVALID_INPUT", "Select exactly one changed file when reading by line.");
  }
  const { target, submission: { sha: submitted } } = reviewed(task);
  const repo = requireRepository(repository);
  const head = input.pinnedTarget === true ? resolveCommit(repo.root, input.targetHead) : targetHead(repo, localBranch(repo, target));
  if (head !== input.targetHead) {
    throw new TaskboardError("TARGET_CHANGED", "The target branch advanced. Review the changes again.", { head });
  }
  const compareTarget = input.previousTargetHead !== undefined;
  if (compareTarget && input.previousSubmitted !== undefined) {
    throw new TaskboardError("INVALID_INPUT", "Select only one previous commit for comparison.");
  }
  const previous = compareTarget ? input.previousTargetHead : input.previousSubmitted;
  const compared = compareTarget ? head : submitted;
  const base = previous === undefined ? git(repo.root, ["merge-base", head, submitted]).trim() :
    typeof previous === "string" && oid.test(previous) && previous !== compared
      ? resolveCommit(repo.root, previous) : undefined;
  if (!base) throw new TaskboardError("INVALID_INPUT", "Supply a distinct previous commit for this comparison.");
  const changed = new Set(splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", base, compared])));
  if (paths.some(path => !changed.has(path))) {
    throw new TaskboardError("INVALID_INPUT", "Select exact paths returned by the review.");
  }
  const offset = input.offset === undefined ? 0 : number(input.offset, "offset", 0);
  const contextLines = input.contextLines === undefined ? undefined : number(input.contextLines, "contextLines", 0);
  if (contextLines !== undefined && contextLines > 100) {
    throw new TaskboardError("INVALID_INPUT", "Use between 0 and 100 context lines.");
  }
  const context = contextLines === undefined ? [] : ["--unified=" + contextLines];
  const format = line !== undefined ? ["--no-renames", "--submodule=short"] : compareTarget ? [] : ["--binary"];
  const fullDiff = git(repo.root, ["--literal-pathspecs", "diff", ...diffOptions, ...format, "--no-color", ...context, base, compared, "--", ...paths]);
  const diff = line === undefined ? fullDiff : reviewHunkAtLine(fullDiff, line, radius);
  if (offset > diff.length || /[\uDC00-\uDFFF]/.test(diff.charAt(offset))) {
    throw new TaskboardError("INVALID_INPUT", "Use the nextOffset returned for these paths.");
  }
  let end = offset + 16_000;
  if (/[\uDC00-\uDFFF]/.test(diff.charAt(end))) end--;
  return { paths, diff: diff.slice(offset, end), ...(end < diff.length ? { nextOffset: end } : {}) };
}

export function reopenConflictingReview(store: BoardStore, task: Task, input: Record<string, unknown>) {
  requireState(task, ["review"]);
  requireRevision(task, input.revision, true);
  if (exists(store.pendingPath(task.id))) {
    throw new TaskboardError("PENDING_OPERATION", "Finish the pending Git operation first.");
  }
  if (task.acceptanceRepair && task.acceptanceRepair.phase !== "queued") {
    throw new TaskboardError("REPAIR_UNFINISHED", "Conflict repair has already been claimed.");
  }
  const context = reviewed(task);
  const repo = requireRepository(store.location.repository);
  const target = localBranch(repo, context.target);
  const head = targetHead(repo, target);
  const currentPath = usableWorktree(findWorktree(repo, context.branch));
  try {
    mergeTree(repo.root, head, context.submission.sha);
  } catch (error) {
    if (!(error instanceof TaskboardError) || error.code !== "MERGE_CONFLICT") throw error;
    const worktree = input.isolatedWorktree === true && !task.acceptanceRepair ? isolateTaskWorktree(store, repo, task.id, currentPath) : currentPath;
    const updated = store.save(record({ ...task, ...(task.acceptanceRepair ? { acceptanceRepair: { ...task.acceptanceRepair, phase: "running" as const, targetHead: head, attempts: task.acceptanceRepair.attempts + 1 } } : {}), git: { ...context, worktree } }, "resolve-conflicts", "agent", task.acceptanceRepair ? "review" : "in_progress"));
    return { task: updated, worktree, target, targetHead: head, conflict: error.details };
  }
  if (task.acceptanceRepair) {
    const updated = store.save(record({ ...task, acceptanceRepair: { ...task.acceptanceRepair, phase: "running", targetHead: head,
      attempts: task.acceptanceRepair.attempts + 1 } }, "resolve-conflicts", "agent"));
    return { task: updated, worktree: currentPath, target, targetHead: head };
  }
  throw new TaskboardError("NO_MERGE_CONFLICT", "The reviewed submission can be merged into the current target.");
}

function targetPaths(path: string, parent: string, tree: string): string[] {
  return splitPaths(git(path, ["diff", "--no-renames", "--name-only", "-z", parent, tree]));
}

function temporaryTargetPath(store: BoardStore, task: Task): string {
  const repo = requireRepository(store.location.repository);
  excludeBoard(repo, isolatedWorktreesDirectory);
  const root = join(repo.root, isolatedWorktreesDirectory);
  directory(root, true);
  return join(root, ".accept-" + task.id);
}

function releaseTemporaryTarget(store: BoardStore, task: Task): void {
  const repo = store.location.repository;
  if (!repo || !task.git) return;
  try {
    const expected = temporaryTargetPath(store, task);
    if (!exists(expected)) return;
    const item = findWorktree(repo, task.git.target);
    if (!item || item.locked || relative(expected, item.path)) return;
    const path = usableWorktree(item);
    requireNoGitOperation(path);
    if (!gitStatus(path, "all")) git(repo.root, ["worktree", "remove", path]);
  } catch {
    // Keep the checkout if it cannot be safely inspected or removed.
  }
}

export function migrateIntegrationWorktree(store: BoardStore, task: Task): void {
  const repo = store.location.repository;
  if (!repo || !task.git) return;
  const target = task.git.target;
  let item = findWorktree(repo, target);
  if (item && [join(store.location.directory, "worktrees", ".accept-" + task.id),
      join(repo.root, ".taskboard-worktrees", ".accept-" + task.id)].some(path => !relative(path, item!.path))) {
    const path = usableWorktree(item);
    directory(dirname(path));
    const destination = temporaryTargetPath(store, task);
    if (exists(destination)) throw new TaskboardError("WORKTREE_COLLISION", "The integration worktree path is occupied.");
    git(repo.root, ["worktree", "move", "--", path, destination]);
    item = findWorktree(repo, target);
  }
}

function checkoutTarget(store: BoardStore, repo: Repository, task: Task, target: string): string {
  let item = findWorktree(repo, target);
  migrateIntegrationWorktree(store, task);
  item = findWorktree(repo, target);
  if (!item) {
    const path = temporaryTargetPath(store, task);
    if (exists(path)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The path for the target checkout already exists.", { path });
    }
    git(repo.root, ["worktree", "add", "--no-guess-remote", path, target.slice("refs/heads/".length)]);
    item = findWorktree(repo, target);
  }
  const path = usableWorktree(item);
  if (git(path, ["symbolic-ref", "HEAD"]).trim() !== target) {
    throw new TaskboardError("TARGET_UNAVAILABLE", "The target worktree changed branches.", { path, target });
  }
  return path;
}

function commitInfo(path: string, sha: string) {
  const [parents, tree, message] = git(path, ["show", "-s", "--format=%P%x00%T%x00%B", sha]).split("\0");
  return { parents: parents.split(" ").filter(Boolean), tree, message: message.trimEnd() };
}

function matchesCommit(path: string, sha: string, intent: AcceptIntent): boolean {
  const { parents, tree, message } = commitInfo(path, sha);
  return parents.join(" ") === (intent.mode === "merge" ? intent.parent + " " + intent.submitted : intent.parent) &&
    tree === intent.tree && message === intent.message;
}

function recoverCommit(repo: Repository, head: string, intent: AcceptIntent): string {
  if (matchesCommit(repo.root, head, intent)) return head;
  if (isAncestor(repo.root, intent.parent, head)) {
    const lines = git(repo.root, ["rev-list", "--ancestry-path", "--parents", intent.parent + ".." + head])
      .trim().split("\n").filter(Boolean);
    const possible = lines.filter(line => line.split(" ")[1] === intent.parent)
      .map(line => line.split(" ")[0]).filter(sha => matchesCommit(repo.root, sha, intent));
    if (possible.length === 1) return possible[0];
  }
  throw new TaskboardError("ACCEPTANCE_MISMATCH", "The target branch moved without the expected acceptance commit.", {
    head, target: intent.target,
  });
}

function readIntent(path: string, task: Task, target: string, submitted: string): AcceptIntent | undefined {
  return exists(path) ? parseIntent(readJson(path), task, target, submitted) : undefined;
}

function parseIntent(value: unknown, task: Task, target: string, submitted: string): AcceptIntent {
  const pending = object(value);
  if (pending.action !== "accept" || pending.revision !== task.revision || pending.target !== target ||
      pending.submitted !== submitted) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation first.");
  }
  if (typeof pending.parent !== "string" || !oid.test(pending.parent) ||
      typeof pending.tree !== "string" || !oid.test(pending.tree) ||
      (pending.mode !== "merge" && pending.mode !== "squash") ||
      (pending.restoreLocalChanges !== undefined && pending.restoreLocalChanges !== true) ||
      (pending.actor !== undefined && pending.actor !== "manager" && pending.actor !== "reviewer") ||
      (pending.reviewModeVersion !== undefined && (!Number.isSafeInteger(pending.reviewModeVersion) || Number(pending.reviewModeVersion) < 1)) ||
      typeof pending.message !== "string" || conventionalMessage(pending.message, task.id) !== pending.message) {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid acceptance recovery record.");
  }
  return pending as unknown as AcceptIntent;
}

function finish(store: BoardStore, task: Task, sha: string, restoreLocalChanges = false, actor: "user" | "manager" | "reviewer" = "user") {
  let localChangesWarning;
  if (restoreLocalChanges) {
    try {
      const saved = describeSavedChanges(store, task);
      if (saved && !saved.restored) restoreSavedChanges(store, task, { revision: task.revision, destination: "target" }, true);
    } catch (error) {
      localChangesWarning = error instanceof TaskboardError
        ? { code: error.code, message: error.message, details: error.details }
        : { code: "RESTORE_FAILED", message: String(error) };
    }
  }
  const context = reviewed(task);
  const completed = store.save(withoutVerification(record({ ...task, git: { ...context, accepted: sha } }, "accept", actor, "done", sha)));
  removeFile(store.pendingPath(task.id));
  return { ...completed, localChangesWarning };
}

function verifyExternal(repo: Repository, task: Task, head: string, submitted: string, value: unknown): string {
  const sha = text(value, "commit", true);
  if (!oid.test(sha) || !resolveCommit(repo.root, sha) || !isAncestor(repo.root, sha, head)) {
    throw new TaskboardError("ACCEPTANCE_MISMATCH", "Choose a commit in the target branch history.", { sha });
  }
  const { parents, message, tree } = commitInfo(repo.root, sha);
  if ((parents.length !== 1 && !(parents.length === 2 && parents[1] === submitted)) ||
      conventionalMessage(message, task.id) !== message) {
    throw new TaskboardError("ACCEPTANCE_MISMATCH", "The commit must integrate the submission and name the task.", { sha });
  }
  if (parents.length === 1 && commitInfo(repo.root, parents[0]).tree === tree) {
    throw new TaskboardError("ACCEPTANCE_MISMATCH", "The external squash commit did not apply any changes.", { sha });
  }
  if (mergeTree(repo.root, parents[0], submitted) !== tree) {
    throw new TaskboardError("ACCEPTANCE_MISMATCH", "The external commit differs from the submitted changes.", { sha });
  }
  return sha;
}

function preparedSquash(path: string, head: string, tree: string, status: string): boolean {
  const local = inspectLocalChanges(path, head, status);
  if (!local?.token || !local.indexDirty) return false;
  const squashFile = git(path, ["rev-parse", "--path-format=absolute", "--git-path", "SQUASH_MSG"]).trimEnd();
  return exists(squashFile) && git(path, ["write-tree"]).trim() === tree &&
    !collidingPaths(path, targetPaths(path, head, tree), local.working).length;
}

export function acceptTask(store: BoardStore, task: Task, input: Record<string, unknown>, userAcceptance: boolean) {
  try {
    return integrateTask(store, task, input, userAcceptance);
  } finally {
    releaseTemporaryTarget(store, task);
  }
}

export function compareAcceptedTree(repository: Repository | null, context: Task["git"]): boolean | undefined {
  const { accepted, submission } = context ?? {};
  if (!repository || !accepted || !submission) return;
  try {
    const [acceptedTree, submittedTree] = git(repository.root, ["--no-replace-objects", "rev-parse", "--revs-only", "--end-of-options",
      accepted + "^{tree}", submission.sha + "^{tree}"]).trim().split(/\s+/);
    if (oid.test(acceptedTree) && oid.test(submittedTree)) return acceptedTree === submittedTree;
  } catch {
    // A missing comparison must not turn a completed acceptance into a failure.
  }
}

export function cleanAcceptedTask(store: BoardStore, task: Task) {
  const result = { ...task, acceptedTreeMatchesSubmission: compareAcceptedTree(store.location.repository, task.git) };
  try {
    cleanTaskWorktree(store, task);
    return result;
  } catch (error) {
    // Cleanup diagnostics are persisted internally by cleanTaskWorktree.
    return result;
  }
}

function integrateTask(store: BoardStore, task: Task, input: Record<string, unknown>, userAcceptance: boolean): Task {
  const reviewMode = boardReviewMode(store.index.settings);
  const actor = input.actor === "manager" || input.actor === "reviewer" ? input.actor : undefined;
  const pendingPath = store.pendingPath(task.id);
  if (task.status === "done" && (task.git?.accepted || task.result?.noChanges)) {
    if (exists(pendingPath) && object(readJson(pendingPath)).action === "accept") removeFile(pendingPath);
    const compact = withoutVerification(task);
    return compact === task ? task : store.save(compact);
  }
  requireState(task, ["review"]);
  if (input.reviewModeVersion !== undefined && input.reviewModeVersion !== store.index.settings.reviewModeVersion) {
    throw new TaskboardError("REVIEW_MODE_CHANGED", "Open the current review before accepting.");
  }
  if (reviewMode === "reviewer-human") {
    if (!userAcceptance || input.actor !== "user" || input.autoMode === true) {
      throw new TaskboardError("HUMAN_ACCEPTANCE_REQUIRED", "The user must accept this submission.");
    }
    if (input.reviewModeVersion === undefined) {
      throw new TaskboardError("REVIEW_MODE_CHANGED", "Open the current review before accepting.");
    }
    requireRevision(task, input.revision, true);
    const approval = currentReviewApproval(task, store.index.settings)?.reviewApproval;
    if (!exists(pendingPath) && (!approval || approval.targetHead !== input.targetHead)) {
      throw new TaskboardError("REVIEW_REQUIRED", "The reviewer must approve the current submission and target before acceptance.");
    }
  }
  if (task.result?.noChanges) {
    requireRevision(task, input.revision, true);
    if (exists(pendingPath)) throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation first.");
    if (input.commit !== undefined || input.message !== undefined || input.integrationMode !== undefined ||
        (input.targetHead !== undefined && input.targetHead !== null)) {
      throw new TaskboardError("INVALID_INPUT", "This submission does not need an acceptance commit.");
    }
    if (noChangesReviewIsStale(store, task, task.result.noChanges.head)) {
      throw new TaskboardError("STALE_SUBMISSION", "The task worktree changed. Submit the task again.");
    }
    return store.save(withoutVerification(record(task, "accept", actor ?? "user", "done")));
  }
  const context = reviewed(task);
  const repo = requireRepository(store.location.repository);
  const target = localBranch(repo, context.target);
  const submitted = context.submission.sha;
  const head = targetHead(repo, target);
  let intent = readIntent(pendingPath, task, target, submitted);
  const mode = input.integrationMode === undefined ? intent?.mode ?? store.index.settings.integrationMode :
    member(input.integrationMode, ["merge", "squash"], "integration mode");
  if (head === intent?.parent && (intent.reviewModeVersion !== undefined || reviewMode === "reviewer-human") &&
      (reviewMode !== "reviewer-human" || intent.reviewModeVersion !== store.index.settings.reviewModeVersion)) {
    throw new TaskboardError("REVIEW_MODE_CHANGED", "The interrupted integration was confirmed under a different review mode.");
  }
  if (!intent || input.revision !== undefined) requireRevision(task, input.revision, !intent);
  if (intent && input.commit !== undefined) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted local acceptance first.");
  }
  if (intent && mode !== intent.mode) {
    throw new TaskboardError("PENDING_OPERATION", "Retry with the originally confirmed integration mode.");
  }
  if (intent && head !== intent.parent) return finish(store, task, recoverCommit(repo, head, intent), intent.restoreLocalChanges, intent.actor);
  if (input.targetHead !== undefined && input.targetHead !== head) {
    throw new TaskboardError("TARGET_CHANGED", "The target branch advanced. Review the changes again.", { head });
  }

  if (!intent && input.commit !== undefined) return finish(store, task, verifyExternal(repo, task, head, submitted, input.commit));

  const source = usableWorktree(findWorktree(repo, context.branch));
  requireNoGitOperation(source);
  if (resolveCommit(source, "HEAD") !== submitted || gitStatus(source, "tracked").length) {
    throw new TaskboardError("STALE_SUBMISSION", "The task worktree changed. Submit the task again.", { path: source });
  }
  if (!intent && isAncestor(repo.root, submitted, head)) {
    throw new TaskboardError("ALREADY_INTEGRATED", "The submission is already in the target branch. Select its acceptance commit.");
  }
  const path = checkoutTarget(store, repo, task, target);
  requireNoGitOperation(path);
  const status = gitStatus(path);
  const resumedSquash = Boolean(intent?.mode === "squash" && preparedSquash(path, head, intent.tree, status));
  const saveToken = input.saveLocalChanges;
  const local = resumedSquash ? undefined : inspectLocalChanges(path, head, status);
  if (local && intent && saveToken !== undefined) {
    throw new TaskboardError("DIRTY_TARGET", "The target worktree has local changes.", { path });
  }
  if (!status && !intent && saveToken !== undefined && !describeSavedChanges(store, task)) {
    throw new TaskboardError("LOCAL_CHANGES_CHANGED", "Local changes have changed. Review the file list again.", { path });
  }
  const retry = Boolean(intent);
  if (!intent) {
    const message = conventionalMessage(input.message ?? context.submission.message, task.id);
    const tree = mergeTree(path, head, submitted);
    if (mode === "squash" && commitInfo(path, head).tree === tree) {
      throw new TaskboardError("ALREADY_INTEGRATED", "The target branch already contains the submitted changes.");
    }
    intent = {
      action: "accept", revision: task.revision, target, parent: head, submitted, tree,
      mode, message,
      ...(actor ? { actor } : {}),
      ...(reviewMode === "reviewer-human" ? { reviewModeVersion: store.index.settings.reviewModeVersion } : {}),
    };
  } else {
    if (input.message !== undefined && conventionalMessage(input.message, task.id) !== intent.message) {
      throw new TaskboardError("PENDING_OPERATION", "Retry with the originally confirmed message.");
    }
  }
  const changed = resumedSquash ? [] : targetPaths(path, head, intent.tree);
  if (!resumedSquash) checkProtectedPaths(path, changed);
  const direct = local && !local.indexDirty && !collidingPaths(path, changed, local.paths).length;
  const preserve = local && saveToken === undefined && !direct;
  if (local && !local.token) {
    throw new TaskboardError("LOCAL_CHANGES_UNSUPPORTED", "These local changes cannot be preserved automatically.", { path });
  }
  if (preserve) {
    if (retry && !intent.restoreLocalChanges) {
      throw new TaskboardError("DIRTY_TARGET", "The target worktree changed during acceptance.", { path });
    }
    checkPreserveChanges(store, path, head, intent.tree, changed, local);
    intent.restoreLocalChanges = true;
  }
  if (resolveCommit(path, "HEAD") !== head || git(path, ["symbolic-ref", "HEAD"]).trim() !== target) {
    throw new TaskboardError("TARGET_CHANGED", "The target checkout moved before acceptance.", { path });
  }
  if (gitStatus(path) !== status) {
    throw new TaskboardError("LOCAL_CHANGES_CHANGED", "Local changes have changed. Review the task again.", { path });
  }
  if (preserve && !retry) writeJson(pendingPath, intent);
  if (local && (saveToken !== undefined || preserve)) {
    saveLocalChanges(store, task, path, head, saveToken ?? local.token, !preserve);
    if (resolveCommit(path, "HEAD") !== head || git(path, ["symbolic-ref", "HEAD"]).trim() !== target) {
      throw new TaskboardError("TARGET_CHANGED", "The target checkout moved after saving local changes.", { path });
    }
    checkProtectedPaths(path, changed);
  }
  if (!retry && !preserve) writeJson(pendingPath, intent);

  try {
    if (intent.mode === "merge") {
      git(path, [...skipAutoMaintenance, "merge", ...mergeOptions, "--no-squash", "--no-ff", "--no-edit", "--no-log",
        "--cleanup=verbatim", "-m", intent.message, submitted]);
    } else {
      if (!resumedSquash) git(path, ["merge", ...mergeOptions, "--squash", "--ff", submitted]);
      if (git(path, ["write-tree"]).trim() !== intent.tree) {
        throw new TaskboardError("ACCEPTANCE_MISMATCH", "The prepared squash differs from the reviewed merge tree.", { path });
      }
      git(path, [...skipAutoMaintenance, "commit", "--cleanup=verbatim", "-m", intent.message]);
    }
  } catch (error) {
    const beforeMerge = preserve ? local.untracked.map(name => "? " + name + "\0").join("") : direct && saveToken === undefined ? status : "";
    if (resolveCommit(path, "HEAD") === head && gitStatus(path) === beforeMerge) {
      removeFile(pendingPath);
      if (intent.restoreLocalChanges && describeSavedChanges(store, task)) {
        try {
          restoreSavedChanges(store, task, { revision: task.revision, destination: "target" }, true);
        } catch { /* The saved changes remain available in the task card. */ }
      }
    }
    throw error;
  }
  return finish(store, task, recoverCommit(repo, targetHead(repo, target), intent), intent.restoreLocalChanges, intent.actor);
}
