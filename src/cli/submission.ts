import { createHash, randomUUID } from "node:crypto";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { git, isAncestor, mergeTree, requireRepository, resolveCommit, skipAutoMaintenance } from "./git.ts";
import { number, object, record, requireRevision, requireState, strings, TaskboardError, text } from "./model.ts";
import type { Task, TaskGit } from "./model.ts";
import { exists, readJson, removeFile, taskWorkingDirectory, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { findTaskWorktree, gitStatus, requireNoGitOperation, usableWorktree } from "./worktree.ts";
import { saveArtifacts } from "./artifacts.ts";

interface Snapshot {
  head: string;
  tree: string;
  token: string;
  paths: string[];
}

interface SubmitIntent {
  action: "submit";
  revision: number;
  snapshot: Snapshot;
  message: string;
  result: NonNullable<Task["result"]>;
}

function taskCheckout(store: BoardStore, task: Task): { path: string; context: TaskGit } {
  const repo = requireRepository(store.location.repository);
  const context = task.git;
  if (!context || context.branch !== "refs/heads/ai-taskboard/" + task.id) {
    throw new TaskboardError("CORRUPT_STORAGE", "The task has no matching Git branch.");
  }
  const path = usableWorktree(findTaskWorktree(repo, context));
  requireNoGitOperation(path);
  if (git(path, ["symbolic-ref", "HEAD"]).trim() !== context.branch) {
    throw new TaskboardError("WORKTREE_BRANCH_CHANGED", "Check out the task branch in its worktree first.");
  }
  return { path, context };
}

function capture(store: BoardStore, task: Task, path: string, includeDiff: boolean) {
  const head = resolveCommit(path, "HEAD");
  if (!head) throw new TaskboardError("GIT_FAILED", "The task branch has no commit.");
  const index = git(path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trimEnd();
  const temporary = join(store.subdirectory("pending"), ".index-" + randomUUID());
  const env = { GIT_INDEX_FILE: temporary };
  try {
    if (exists(index)) copyFileSync(index, temporary);
    else git(path, ["read-tree", head], env);
    git(path, ["add", "-A", "--", "."], env);
    const tree = git(path, ["write-tree"], env).trim();
    const changedPaths = (range: string[]) => git(path, ["diff", "--no-renames", "--name-only", "-z", ...range], env)
      .split("\0").filter(Boolean);
    let range = ["--cached", head];
    let paths = changedPaths(range);
    let base: string | undefined;
    let commitMessage: string | undefined;
    if (!paths.length && task.git && !gitStatus(path).length) {
      base = git(path, ["merge-base", task.git.target, head]).trim();
      range = [base, head];
      paths = changedPaths(range);
      if (paths.length) commitMessage = git(path, ["show", "-s", "--format=%B", head]).trimEnd();
    }
    if (paths.some(name => /^\.tasks(?:\/|$)/i.test(name))) {
      throw new TaskboardError("TRACKED_BOARD", "The submission would commit paths under .tasks.");
    }
    const identity = [task.id, task.revision, head, tree];
    if (base) identity.push(base);
    const token = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const diff = includeDiff
      ? git(path, ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...range], env) : undefined;
    return { head, tree, token, paths, diff, commitMessage, base };
  } finally {
    removeFile(temporary);
    removeFile(temporary + ".lock");
  }
}

function indexTree(path: string): string {
  return git(path, ["write-tree"]).trim();
}

function requireCleanIndex(path: string, head: string): void {
  const staged = git(path, ["diff", "--cached", "--name-only", "-z", head]).split("\0").filter(Boolean);
  if (staged.length) {
    throw new TaskboardError("DIRTY_INDEX", "The task worktree has changes already staged.", { paths: staged });
  }
}

export function conventionalMessage(value: unknown, id: string): string {
  const message = text(value, "message", true).replaceAll("\r\n", "\n");
  const [subject, separator] = message.split("\n", 2);
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S.*$/i.test(subject) ||
      (separator !== undefined && separator !== "") || /[\r\0]/.test(message)) {
    throw new TaskboardError("INVALID_COMMIT_MESSAGE", "Use a Conventional Commit message such as feat(export): add CSV export.");
  }
  const trailers = [...message.matchAll(/^Task: (.*)$/gmi)];
  if (!trailers.length) return message + "\n\nTask: " + id;
  if (trailers.length !== 1 || trailers[0][0] !== "Task: " + id) {
    throw new TaskboardError("INVALID_COMMIT_MESSAGE", "The Task trailer must match " + id + ".");
  }
  return message;
}

function resultOf(input: Record<string, unknown>): SubmitIntent["result"] {
  return {
    summary: text(input.summary, "summary", true),
    checks: strings(input.checks, "checks"),
    limitations: input.limitations === undefined ? [] : strings(input.limitations, "limitations"),
  };
}

export function previewTask(store: BoardStore, id: string, revision?: number): Task {
  const task = store.card(id);
  requireRevision(task, revision);
  requireState(task, ["in_progress"]);
  if (exists(store.pendingPath(id))) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before preparing a new submission.");
  }
  return task;
}

export function previewSubmission(store: BoardStore, task: Task, compact: boolean, input: Record<string, unknown>) {
  if (task.workingDirectory && !task.git) {
    if (input.paths !== undefined) throw new TaskboardError("INVALID_INPUT", "This task has no Git diff.");
    return { token: directorySubmissionToken(task), paths: [], targetHead: null, noChanges: true, ...(compact ? {} : { diff: "" }) };
  }
  const { path, context } = taskCheckout(store, task);
  const page = input.paths !== undefined;
  const { base, ...snapshot } = capture(store, task, path, !compact && !page);
  requireCleanIndex(path, snapshot.head);
  if (!page) return { ...snapshot, target: context.target, targetHead: checkSubmissionMerge(path, context, snapshot) };
  if (snapshot.token !== text(input.token, "token", true)) {
    throw new TaskboardError("STALE_SNAPSHOT", "The worktree changed. Prepare a new submission.", { paths: snapshot.paths });
  }
  const paths = input.paths;
  const changed = new Set(snapshot.paths);
  if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length ||
      paths.some(name => typeof name !== "string" || !changed.has(name))) {
    throw new TaskboardError("INVALID_INPUT", "Select distinct paths returned by the preview.");
  }
  const diff = git(path, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--binary", "--no-color", base ?? snapshot.head, snapshot.tree, "--", ...paths]);
  const offset = input.offset === undefined ? 0 : number(input.offset, "offset", 0);
  if (offset > diff.length || /[\uDC00-\uDFFF]/.test(diff.charAt(offset))) {
    throw new TaskboardError("INVALID_INPUT", "Use the nextOffset returned for these paths.");
  }
  let end = offset + 16_000;
  if (/[\uDC00-\uDFFF]/.test(diff.charAt(end))) end--;
  return { token: snapshot.token, paths, diff: diff.slice(offset, end), ...(end < diff.length ? { nextOffset: end } : {}) };
}

function checkSubmissionMerge(path: string, context: TaskGit, snapshot: Snapshot & { commitMessage?: string }): string {
  const targetHead = resolveCommit(path, context.target);
  if (!targetHead) throw new TaskboardError("TARGET_UNAVAILABLE", "The target branch no longer has a commit.", { target: context.target });
  if (snapshot.paths.length && !isAncestor(path, targetHead, snapshot.head)) {
    // A temporary commit lets Git check the exact snapshot without staging it or moving any ref.
    const candidate = snapshot.commitMessage ? snapshot.head : git(path, [
      "-c", "user.name=AI Taskboard", "-c", "user.email=taskboard@localhost",
      "commit-tree", snapshot.tree, "-p", snapshot.head, "--no-gpg-sign", "-m", "Check task submission",
    ]).trim();
    mergeTree(path, targetHead, candidate);
  }
  return targetHead;
}

function readIntent(path: string, task: Task): SubmitIntent | undefined {
  if (!exists(path)) return undefined;
  const data = object(readJson(path));
  if (data.action !== "submit") throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation first.");
  if ((task.status === "review" ? task.revision - 1 : task.revision) !== data.revision) {
    throw new TaskboardError("PENDING_OPERATION", "The interrupted submission does not match the task revision.");
  }
  const snapshot = object(data.snapshot);
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (typeof snapshot.head !== "string" || !oid.test(snapshot.head) ||
      typeof snapshot.tree !== "string" || !oid.test(snapshot.tree) || typeof snapshot.token !== "string" ||
      !Array.isArray(snapshot.paths) || typeof data.message !== "string") {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid submission recovery record.");
  }
  return data as unknown as SubmitIntent;
}

function verifyCommit(path: string, head: string, intent: SubmitIntent, id: string): string {
  const parent = git(path, ["show", "-s", "--format=%P", head]).trim();
  const tree = git(path, ["show", "-s", "--format=%T", head]).trim();
  const message = git(path, ["show", "-s", "--format=%B", head]).trimEnd();
  if (parent !== intent.snapshot.head || tree !== intent.snapshot.tree ||
      message !== intent.message || conventionalMessage(message, id) !== message) {
    throw new TaskboardError("SUBMISSION_MISMATCH", "Git did not produce the confirmed submission commit.", { sha: head });
  }
  if (gitStatus(path).length) {
    throw new TaskboardError("DIRTY_WORKTREE", "Local changes remain after the submission commit.", { path, sha: head });
  }
  return message;
}

function directorySubmissionToken(task: Task) {
  return createHash("sha256").update(JSON.stringify([task.id, task.revision, task.workingDirectory])).digest("hex");
}

export function submitTask(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  if (task.schedule) throw new TaskboardError("INVALID_TRANSITION", "Record the recurring task result with progress instead of submitting it for review.");
  const pendingPath = store.pendingPath(task.id);
  let intent = readIntent(pendingPath, task);
  if (!intent) requireRevision(task, input.revision);
  if (task.status !== "review" || !intent) requireState(task, ["in_progress"]);
  if (task.workingDirectory && !task.git) {
    if (intent) throw new TaskboardError("PENDING_OPERATION", "This task has an unfinished Git operation.");
    if (input.noChanges !== true || input.message !== undefined) {
      throw new TaskboardError("INVALID_INPUT", "Submit this result with noChanges: true and without a commit message.");
    }
    if (directorySubmissionToken(task) !== text(input.token, "token", true)) {
      throw new TaskboardError("STALE_SNAPSHOT", "The task changed. Prepare a new submission.");
    }
    const result = resultOf(input);
    if (!result.checks.length) throw new TaskboardError("CHECKS_REQUIRED", "Report how you verified the result outside Git.");
    if (input.artifacts !== undefined) {
      saveArtifacts(store, task.id, taskWorkingDirectory(task.workingDirectory, true), input.artifacts);
    }
    return store.save(record({ ...task, result: { ...result, noChanges: { head: null } } },
      "submit", "agent", "review", result.summary));
  }
  const { path, context } = taskCheckout(store, task);
  let head = resolveCommit(path, "HEAD");
  if (!head) throw new TaskboardError("GIT_FAILED", "The task branch has no commit.");

  if (!intent) {
    const noChanges = input.noChanges === true;
    if (noChanges && input.message !== undefined) {
      throw new TaskboardError("INVALID_INPUT", "Omit the commit message for a submission without Git changes.");
    }
    const message = noChanges ? null : conventionalMessage(input.message, task.id);
    const result = resultOf(input);
    requireCleanIndex(path, head);
    const snapshot = capture(store, task, path, false);
    if (snapshot.token !== text(input.token, "token", true)) {
      throw new TaskboardError("STALE_SNAPSHOT", "The worktree changed. Prepare a new submission.", { paths: snapshot.paths });
    }
    if (message === null) {
      if (!result.checks.length) {
        throw new TaskboardError("CHECKS_REQUIRED", "Report how you verified the result outside Git.");
      }
      if (snapshot.paths.length || gitStatus(path).length) {
        throw new TaskboardError("CHANGES_PRESENT", "Submit the Git changes with a commit message.");
      }
      if (input.artifacts !== undefined) saveArtifacts(store, task.id, path, input.artifacts);
      return store.save(record({
        ...task, git: { ...context, submission: undefined }, result: { ...result, noChanges: { head: snapshot.head } },
      }, "submit", "agent", "review", result.summary));
    }
    checkSubmissionMerge(path, context, snapshot);
    if (snapshot.commitMessage !== undefined) {
      if (snapshot.commitMessage !== message) {
        throw new TaskboardError("INVALID_COMMIT_MESSAGE", "Confirm the existing Conventional Commit message with this task's trailer.");
      }
      if (input.artifacts !== undefined) saveArtifacts(store, task.id, path, input.artifacts);
      return store.save(record({
        ...task, result, git: { ...context, submission: { sha: snapshot.head, message } },
      }, "submit", "agent", "review", result.summary));
    }
    if (!snapshot.paths.length) {
      throw new TaskboardError("NO_CHANGES", "Use noChanges: true to submit a completed result without Git changes.");
    }
    if (input.artifacts !== undefined) saveArtifacts(store, task.id, path, input.artifacts);
    intent = { action: "submit", revision: task.revision, snapshot, message, result };
    writeJson(pendingPath, intent);
  }

  if (head === intent.snapshot.head) {
    const originalTree = git(path, ["show", "-s", "--format=%T", head]).trim();
    const staged = indexTree(path);
    if (staged !== originalTree && staged !== intent.snapshot.tree) {
      throw new TaskboardError("DIRTY_INDEX", "The real Git index no longer matches the prepared submission.", { path });
    }
    const current = capture(store, task, path, false);
    if (current.token !== intent.snapshot.token) {
      if (staged !== originalTree) git(path, ["reset", "--mixed", "--quiet", head]);
      removeFile(pendingPath);
      throw new TaskboardError("STALE_SNAPSHOT", "The worktree changed. Prepare a new submission.", { paths: current.paths });
    }
    git(path, ["add", "-A", "--", "."]);
    if (indexTree(path) !== intent.snapshot.tree) {
      throw new TaskboardError("STALE_SNAPSHOT", "The Git index changed during submission.", { path });
    }
    try {
      git(path, [...skipAutoMaintenance, "commit", "--cleanup=verbatim", "-m", intent.message]);
    } catch (error) {
      if (resolveCommit(path, "HEAD") === head && indexTree(path) === intent.snapshot.tree) {
        git(path, ["reset", "--mixed", "--quiet", head]);
        removeFile(pendingPath);
      }
      throw error;
    }
    head = resolveCommit(path, "HEAD");
    if (!head) throw new TaskboardError("SUBMISSION_MISMATCH", "Git did not return a submission commit.");
  }

  const message = verifyCommit(path, head, intent, task.id);
  if (task.status === "review" && task.git?.submission?.sha === head) {
    removeFile(pendingPath);
    return task;
  }
  const updated = store.save(record({
    ...task, result: intent.result, git: { ...context, submission: { sha: head, message } },
  }, "submit", "agent", "review", intent.result.summary));
  removeFile(pendingPath);
  return updated;
}

export function noChangesReviewIsStale(store: BoardStore, task: Task, head: string | null): boolean {
  if (head === null) return !task.workingDirectory || Boolean(task.git);
  try {
    const { path } = taskCheckout(store, task);
    return resolveCommit(path, "HEAD") !== head || Boolean(gitStatus(path, "tracked"));
  } catch (error) {
    if (error instanceof TaskboardError &&
        ["WORKTREE_MISSING", "WORKTREE_BRANCH_CHANGED", "GIT_OPERATION_IN_PROGRESS"].includes(error.code)) return true;
    throw error;
  }
}
