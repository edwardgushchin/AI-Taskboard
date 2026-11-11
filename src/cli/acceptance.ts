import { join, relative } from "node:path";
import { git, invokeGit, localBranch, requireRepository, resolveCommit } from "./git.ts";
import type { Repository } from "./git.ts";
import { object, record, requireRevision, requireState, TaskboardError, text } from "./model.ts";
import type { IntegrationMode, Task, TaskGit } from "./model.ts";
import { checkPreserveChanges, describeSavedChanges, inspectLocalChanges, restoreSavedChanges, saveLocalChanges } from "./saved-changes.ts";
import { exists, readJson, removeFile, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { conventionalMessage } from "./submission.ts";
import { checkProtectedPaths, collidingPaths, findWorktree, gitStatus, requireNoGitOperation, usableWorktree } from "./worktree.ts";

interface AcceptIntent {
  action: "accept";
  revision: number;
  target: string;
  parent: string;
  submitted: string;
  tree: string;
  mode: IntegrationMode;
  message: string;
  restoreLocalChanges?: true;
}

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const diffOptions = ["--no-ext-diff", "--no-textconv"];
const mergeOptions = ["-s", "ort", "--no-autostash", "--no-overwrite-ignore", "--no-rerere-autoupdate"];

function splitPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function isAncestor(path: string, older: string, newer: string): boolean {
  const result = invokeGit(path, ["merge-base", "--is-ancestor", older, newer]);
  if (result.code === 0 || result.code === 1) return result.code === 0;
  throw new TaskboardError("GIT_FAILED", "Git could not compare commits.", { output: result.stderr.trim() });
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

export function inspectReview(store: BoardStore, task: Task) {
  requireState(task, ["review"]);
  const context = reviewed(task);
  const repo = requireRepository(store.location.repository);
  const target = localBranch(repo, context.target);
  const head = targetHead(repo, target);
  const submitted = context.submission.sha;
  const base = git(repo.root, ["merge-base", head, submitted]).trim();
  const item = findWorktree(repo, context.branch);
  const stale = !item || item.prunable || item.head !== submitted || !exists(item.path) ||
    Boolean(gitStatus(usableWorktree(item)));
  const paths = splitPaths(git(repo.root, ["diff", "--no-renames", "--name-only", "-z", base, submitted]));
  const checkout = findWorktree(repo, target);
  const local = checkout && !checkout.prunable && exists(checkout.path)
    ? inspectLocalChanges(usableWorktree(checkout), head) : undefined;
  const savedChanges = describeSavedChanges(store, task);
  const retry = readIntent(store.pendingPath(task.id), task, target, submitted);
  return {
    target, targetHead: head, submitted, stale, revision: task.revision, message: retry?.message ?? context.submission.message,
    mode: store.index.settings.integrationMode,
    paths, savedChanges,
    localChanges: local && {
      path: local.path, paths: local.paths, token: local.token,
      overlaps: collidingPaths(local.path, local.paths, paths),
    },
    pending: Boolean(retry),
    diff: git(repo.root, ["diff", ...diffOptions, "--binary", base, submitted]),
  };
}

function mergeTree(path: string, parent: string, submitted: string): string {
  const result = invokeGit(path, ["merge-tree", "--write-tree", "--no-messages", parent, submitted]);
  if (result.code === 1) {
    throw new TaskboardError("MERGE_CONFLICT", "The submitted commit conflicts with the target branch.", {
      output: result.stdout.trim(),
    });
  }
  const tree = result.stdout.trim();
  if (result.code !== 0 || !oid.test(tree)) {
    throw new TaskboardError("GIT_FAILED", "Git could not calculate the merge result.", { output: result.stderr.trim() });
  }
  return tree;
}

function targetPaths(path: string, parent: string, tree: string): string[] {
  return splitPaths(git(path, ["diff", "--no-renames", "--name-only", "-z", parent, tree]));
}

function temporaryTargetPath(store: BoardStore, task: Task): string {
  return join(store.subdirectory("worktrees"), ".accept-" + task.id);
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
    if (!gitStatus(path, true)) git(repo.root, ["worktree", "remove", path]);
  } catch {
    // Keep the checkout if it cannot be safely inspected or removed.
  }
}

function checkoutTarget(store: BoardStore, repo: Repository, task: Task, target: string): string {
  let item = findWorktree(repo, target);
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
  if (!exists(path)) return undefined;
  const pending = object(readJson(path));
  if (pending.action !== "accept" || pending.revision !== task.revision || pending.target !== target ||
      pending.submitted !== submitted) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation first.");
  }
  if (typeof pending.parent !== "string" || !oid.test(pending.parent) ||
      typeof pending.tree !== "string" || !oid.test(pending.tree) ||
      (pending.mode !== "merge" && pending.mode !== "squash") ||
      (pending.restoreLocalChanges !== undefined && pending.restoreLocalChanges !== true) ||
      typeof pending.message !== "string" || conventionalMessage(pending.message, task.id) !== pending.message) {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid acceptance recovery record.");
  }
  return pending as unknown as AcceptIntent;
}

function finish(store: BoardStore, task: Task, sha: string, restoreLocalChanges = false) {
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
  const completed = store.save(record({ ...task, git: { ...context, accepted: sha } }, "accept", "user", "done", sha));
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

export function acceptTask(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  try {
    return integrateTask(store, task, input);
  } finally {
    releaseTemporaryTarget(store, task);
  }
}

function integrateTask(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  const pendingPath = store.pendingPath(task.id);
  if (task.status === "done" && task.git?.accepted) {
    if (exists(pendingPath) && object(readJson(pendingPath)).action === "accept") removeFile(pendingPath);
    return task;
  }
  requireState(task, ["review"]);
  const context = reviewed(task);
  const repo = requireRepository(store.location.repository);
  const target = localBranch(repo, context.target);
  const submitted = context.submission.sha;
  const head = targetHead(repo, target);
  let intent = readIntent(pendingPath, task, target, submitted);
  if (!intent || input.revision !== undefined) requireRevision(task, input.revision, !intent);
  if (intent && input.commit !== undefined) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted local acceptance first.");
  }
  if (intent && head !== intent.parent) return finish(store, task, recoverCommit(repo, head, intent), intent.restoreLocalChanges);
  if (!intent && input.commit !== undefined) return finish(store, task, verifyExternal(repo, task, head, submitted, input.commit));
  if (input.targetHead !== undefined && input.targetHead !== head) {
    throw new TaskboardError("TARGET_CHANGED", "The target branch advanced. Review the changes again.", { head });
  }

  const source = usableWorktree(findWorktree(repo, context.branch));
  requireNoGitOperation(source);
  if (resolveCommit(source, "HEAD") !== submitted || gitStatus(source).length) {
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
    if (store.index.settings.integrationMode === "squash" && commitInfo(path, head).tree === tree) {
      throw new TaskboardError("ALREADY_INTEGRATED", "The target branch already contains the submitted changes.");
    }
    intent = {
      action: "accept", revision: task.revision, target, parent: head, submitted, tree,
      mode: store.index.settings.integrationMode, message,
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
      git(path, ["merge", ...mergeOptions, "--no-squash", "--no-ff", "--no-edit", "--no-log",
        "--cleanup=verbatim", "-m", intent.message, submitted]);
    } else {
      if (!resumedSquash) git(path, ["merge", ...mergeOptions, "--squash", "--ff", submitted]);
      if (git(path, ["write-tree"]).trim() !== intent.tree) {
        throw new TaskboardError("ACCEPTANCE_MISMATCH", "The prepared squash differs from the reviewed merge tree.", { path });
      }
      git(path, ["commit", "--cleanup=verbatim", "-m", intent.message]);
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
  return finish(store, task, recoverCommit(repo, targetHead(repo, target), intent), intent.restoreLocalChanges);
}
