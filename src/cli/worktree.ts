import { realpathSync, rmSync, rmdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { artifactFiles, discardTaskArtifacts, removeSavedSource, saveArtifacts } from "./artifacts.ts";
import { dependencyStatus, unfinishedDependencies } from "./dependencies.ts";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  createInitialCommit, excludeBoard, git, invokeGit, isAncestor, isolatedWorktreesDirectory, localBranch,
  requireRepository, resolveCommit, worktrees,
} from "./git.ts";
import type { Repository, Worktree } from "./git.ts";
import { object, record, requireRevision, requireState, taskIdPattern, TaskboardError, text } from "./model.ts";
import type { Task, TaskGit } from "./model.ts";
import { directory, exists, locateBoard, readBinary, readJson, removeFile, taskStartInProgress, taskWorkingDirectory, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

export function findWorktree(repo: Repository, branch: string, entries = worktrees(repo.root)): Worktree | undefined {
  const matches = entries.filter(item => item.branch === branch);
  if (matches.length > 1) {
    throw new TaskboardError("AMBIGUOUS_WORKTREE", "Git reports multiple worktrees for " + branch + ".");
  }
  return matches[0];
}

export function usableWorktree(item: Worktree | undefined): string {
  if (!item || item.prunable || !exists(item.path)) {
    throw new TaskboardError("WORKTREE_MISSING", "Restore the task's Git worktree before continuing.");
  }
  directory(item.path);
  return realpathSync(item.path);
}

export function findTaskWorktree(repo: Repository, { branch, worktree: recorded }: TaskGit): Worktree | undefined {
  const entries = worktrees(repo.root);
  const attached = findWorktree(repo, branch, entries);
  if (attached || !recorded || !isAbsolute(recorded)) return attached;
  let expected = recorded;
  const id = branch.slice("refs/heads/ai-taskboard/".length);
  if (branch.startsWith("refs/heads/ai-taskboard/") && taskIdPattern.test(id) &&
      insideDirectory(join(repo.root, ".tasks", "worktrees"), recorded) && !exists(recorded)) {
    // Recover a detached rebase if Git moved the worktree before the card was saved.
    expected = join(isolatedRoot(repo), id);
  }
  const detached = entries.find(item => !item.branch && item.head && !item.prunable && !relative(expected, item.path));
  if (!detached || !exists(detached.path)) return undefined;
  const gitDir = git(usableWorktree(detached), ["rev-parse", "--absolute-git-dir"]).trimEnd();
  for (const operation of ["rebase-merge", "rebase-apply"]) {
    const state = join(gitDir, operation);
    if (!exists(state)) continue;
    directory(state);
    const original = join(state, "head-name");
    if (exists(original) && readBinary(original).toString("utf8").trimEnd() === branch) return detached;
  }
  return undefined;
}

export function taskWithCurrentWorktree(store: BoardStore, task: Task): Task & { cleanupAvailable?: boolean } {
  if (!task.git) return task;
  const repo = store.location.repository;
  const closed = task.status === "done" || task.status === "cancelled";
  const item = repo && (closed ? findWorktree(repo, task.git.branch) : findTaskWorktree(repo, task.git));
  const worktree = item && !item.prunable && exists(item.path) ? usableWorktree(item) : undefined;
  const cleanupAvailable = closed && Boolean(item || (repo && (
    orphanedTaskWorktree(store, repo, task) || (task.status === "done" && resolveCommit(repo.root, task.git.branch))
  )));
  return { ...task, git: { ...task.git, worktree }, cleanupAvailable };
}

export function gitStatus(path: string, ignored = false): string {
  return git(path, [
    "status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=none",
    ignored ? "--ignored=traditional" : "--ignored=no",
  ]);
}

export function collidingPaths(path: string, changed: string[], local: string[]): string[] {
  const ignoreCase = invokeGit(path, ["config", "--bool", "core.ignorecase"]).stdout.trim();
  const normalize = (name: string) => ignoreCase === "true" || (!ignoreCase && process.platform === "win32")
    ? name.normalize("NFC").toLowerCase() : name;
  const protectedPaths = new Set(local.map(normalize));
  const containing = new Set<string>();
  for (const name of protectedPaths) {
    for (let slash = name.indexOf("/"); slash !== -1; slash = name.indexOf("/", slash + 1)) {
      containing.add(name.slice(0, slash));
    }
  }
  return changed.filter(name => {
    const normalized = normalize(name);
    if (protectedPaths.has(normalized) || containing.has(normalized)) return true;
    for (let slash = normalized.indexOf("/"); slash !== -1; slash = normalized.indexOf("/", slash + 1)) {
      if (protectedPaths.has(normalized.slice(0, slash))) return true;
    }
    return false;
  });
}

export function checkProtectedPaths(path: string, changed: string[]): void {
  const ignored = git(path, [
    "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ".", ":(top,exclude).tasks",
  ]).split("\0").filter(Boolean);
  const collisions = collidingPaths(path, changed, [".tasks", ...ignored]);
  if (collisions.length) {
    throw new TaskboardError("PROTECTED_PATH_COLLISION", "The operation would touch local ignored files or board data.", {
      paths: collisions,
    });
  }
}

export function requireNoGitOperation(path: string): void {
  const gitDir = git(path, ["rev-parse", "--absolute-git-dir"]).trimEnd();
  const operation = [
    "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge",
    "rebase-apply", "sequencer", "BISECT_START",
  ].find(name => exists(join(gitDir, name)));
  if (operation) {
    throw new TaskboardError("GIT_OPERATION_IN_PROGRESS", "Finish the current Git operation first.", { path, operation });
  }
}

function worktreeBranch(task: Task): string {
  return "refs/heads/ai-taskboard/" + task.id;
}

function insideDirectory(parent: string, path: string): boolean {
  const inside = relative(parent, path);
  return Boolean(inside && inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside));
}

function isolatedRoot(repo: Repository, create = false): string {
  const path = join(repo.root, isolatedWorktreesDirectory);
  if (create) {
    excludeBoard(repo, isolatedWorktreesDirectory);
    directory(path, true);
  }
  return path;
}

export function hasPending(store: BoardStore, task: Task): boolean {
  const path = store.pendingPath(task.id);
  if (!exists(path)) return false;
  const repo = store.location.repository;
  if (!repo || task.status !== "ready") return true;
  const pending = object(readJson(path));
  if (pending.action !== "start" || pending.revision !== task.revision) return true;
  if (taskStartInProgress(store.location, task.id)) return true;

  const branch = worktreeBranch(task);
  const folder = pending.isolatedWorktree === true ? isolatedRoot(repo) : store.subdirectory("worktrees");
  const managedPath = join(folder, task.id);
  if (exists(managedPath) || resolveCommit(repo.root, branch) ||
      worktrees(repo.root).some(item => item.branch === branch || relative(managedPath, item.path) === "")) return true;

  // A task edit can abandon an attempted start that left no Git artifacts.
  removeFile(path);
  return false;
}

type StartedTask = { task: Task } & ({ worktree: string } | { cwd: string });
type StartIntent = { action: "start"; revision: number; target: string; base: string; isolatedWorktree?: true };
type TaskCheckout = {
  id: string; repo: Repository; branch: string; managedPath: string; intent: StartIntent;
  preparing: number; lockWaitMs: number;
};

function saveStart(store: BoardStore, task: Task, lockWaitMs: number, prepareMs: number, gitWorktreeAddMs?: number) {
  const updated = record(task, "start", "agent", "in_progress");
  updated.history.at(-1)!.startTiming = {
    lockWaitMs, prepareMs, ...(gitWorktreeAddMs !== undefined ? { gitWorktreeAddMs } : {}),
  };
  return store.save(updated);
}

export function prepareTaskStart(store: BoardStore, task: Task, input: Record<string, unknown>, lockWaitMs: number): StartedTask | TaskCheckout {
  const preparing = performance.now();
  const save = (card: Task) => saveStart(store, card, lockWaitMs, Math.round(performance.now() - preparing));
  requireState(task, ["ready", "in_progress"]);
  if (task.status === "ready") {
    const dependencies = unfinishedDependencies(task, id => dependencyStatus(store, id));
    if (dependencies.length) {
      throw new TaskboardError("DEPENDENCIES_INCOMPLETE", "Complete the task dependencies before starting.", { dependencies });
    }
  }
  requireRevision(task, input.revision);
  if (task.workingDirectory) {
    if (task.git || input.target !== undefined || input.resolveConflicts === true) {
      throw new TaskboardError("INVALID_INPUT", "This task uses an existing directory and has no task branch.");
    }
    if (exists(store.pendingPath(task.id))) {
      throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted operation before starting.");
    }
    const cwd = taskWorkingDirectory(task.workingDirectory, true);
    return { task: task.status === "in_progress" ? task : save(task), cwd };
  }
  const branch = worktreeBranch(task);
  const pendingPath = store.pendingPath(task.id);
  const pending = exists(pendingPath) ? object(readJson(pendingPath)) : undefined;
  if (pending && pending.action !== "start") {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before starting.");
  }
  if (task.git || task.status === "in_progress") {
    if (!task.git || task.git.branch !== branch) {
      throw new TaskboardError("CORRUPT_STORAGE", "The task has no matching Git branch.");
    }
    const repo = requireRepository(store.location.repository);
    if (task.status === "ready") {
      if (input.target !== undefined && localBranch(repo, text(input.target, "target", true)) !== task.git.target) {
        throw new TaskboardError("INVALID_INPUT", "Resume the task on its original target branch.");
      }
    }
    const currentPath = usableWorktree(findTaskWorktree(repo, task.git));
    const worktree = input.isolatedWorktree === true ? isolateTaskWorktree(store, repo, task.id, currentPath) : currentPath;
    const updated = { ...task, git: { ...task.git, worktree } };
    if (pending) removeFile(pendingPath);
    if (task.status === "in_progress") return { task: worktree === task.git.worktree ? task : store.save(updated), worktree };
    return { task: save(updated), worktree };
  }

  const requested = input.target === undefined ? undefined : text(input.target, "target", true);
  const repo = store.location.repository ?? requireRepository(locateBoard(store.location.root, true, true).repository);
  excludeBoard(repo);
  const isolatedWorktree = (pending ?? input).isolatedWorktree === true;
  const managedPath = join(isolatedWorktree ? isolatedRoot(repo, true) : store.subdirectory("worktrees"), task.id);
  let target: string;
  let base: string;
  if (pending) {
    if (pending.revision !== task.revision || typeof pending.target !== "string" ||
        typeof pending.base !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pending.base)) {
      throw new TaskboardError("PENDING_OPERATION", "The interrupted start does not match this task revision.");
    }
    target = localBranch(repo, pending.target);
    base = pending.base;
    if (requested && localBranch(repo, requested) !== target) {
      throw new TaskboardError("PENDING_OPERATION", "Retry with the original target branch.");
    }
  } else {
    target = localBranch(repo, requested);
    if (resolveCommit(repo.root, branch) || findWorktree(repo, branch) || exists(managedPath)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The task branch or worktree path is already in use.");
    }
    base = resolveCommit(repo.root, target) ?? createInitialCommit(repo, target);
  }
  const intent: StartIntent = { action: "start", revision: task.revision, target, base,
    ...(isolatedWorktree ? { isolatedWorktree: true } : {}) };
  if (!pending) writeJson(pendingPath, intent);
  return { id: task.id, repo, branch, managedPath, intent, preparing, lockWaitMs };
}

export function checkoutTaskWorktree({ id, repo, branch, managedPath, intent: { base, isolatedWorktree } }: TaskCheckout) {
  const existing = findWorktree(repo, branch);
  let gitWorktreeAddMs: number | undefined;
  if (!existing) {
    if (exists(managedPath)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The worktree path already contains files.", { path: managedPath });
    }
    const existingCommit = resolveCommit(repo.root, branch);
    if (existingCommit && existingCommit !== base) {
      throw new TaskboardError("WORKTREE_COLLISION", "The task branch changed during the interrupted start.");
    }
    const name = branch.slice("refs/heads/".length);
    const args = existingCommit
      ? ["worktree", "add", "--no-guess-remote", managedPath, name]
      : ["worktree", "add", "--no-guess-remote", "-b", name, managedPath, base];
    if (process.platform === "win32" && availableParallelism() >= 4 &&
        invokeGit(repo.root, ["config", "--get", "checkout.workers"]).code === 1) {
      args.unshift("-c", "checkout.workers=4");
    }
    const checkout = performance.now();
    git(repo.root, args);
    gitWorktreeAddMs = Math.round(performance.now() - checkout);
  }

  const item = existing ?? findWorktree(repo, branch);
  const worktree = usableWorktree(item);
  const matches = exists(managedPath) && realpathSync(managedPath) === worktree;
  // A previous Elevated start may have moved a legacy pending checkout before the card was saved.
  const moved = !isolatedWorktree && !relative(join(isolatedRoot(repo), id), worktree);
  if (item?.head !== base || (!matches && !moved)) {
    throw new TaskboardError("WORKTREE_COLLISION", "The task worktree does not match the pending checkout.");
  }
  return { worktree, gitWorktreeAddMs };
}

export function finishTaskStart(store: BoardStore, plan: TaskCheckout, checkout: ReturnType<typeof checkoutTaskWorktree>,
  finalLockWaitMs: number, isolate: boolean) {
  const { id, branch, intent, preparing, lockWaitMs } = plan;
  const task = store.card(id);
  requireState(task, ["ready"]);
  requireRevision(task, intent.revision, true);
  const pendingPath = store.pendingPath(id);
  const pending = exists(pendingPath) && object(readJson(pendingPath));
  const { target, base } = intent;
  if (!pending || pending.action !== intent.action || pending.revision !== intent.revision ||
      pending.target !== target || pending.base !== base || pending.isolatedWorktree !== intent.isolatedWorktree) {
    throw new TaskboardError("PENDING_OPERATION", "The pending task checkout changed.");
  }
  const { gitWorktreeAddMs } = checkout;
  const worktree = isolate ? isolateTaskWorktree(store, plan.repo, id, checkout.worktree) : checkout.worktree;
  const prepareMs = Math.max(0, Math.round(performance.now() - preparing) - finalLockWaitMs);
  const updated = saveStart(store, { ...task, git: { target, base, branch, worktree } },
    lockWaitMs + finalLockWaitMs, prepareMs, gitWorktreeAddMs);
  removeFile(pendingPath);
  return { task: updated, worktree };
}

// Move only the assigned, registered Git worktree, under the task's start lock.
export function isolateTaskWorktree(store: BoardStore, repo: Repository, id: string, worktree: string): string {
  if (!insideDirectory(store.subdirectory("worktrees"), worktree)) return worktree;
  const target = join(isolatedRoot(repo, true), id);
  if (exists(target)) throw new TaskboardError("WORKTREE_COLLISION", "The isolated worktree path already contains files.", { path: target });
  git(repo.root, ["worktree", "move", "--", worktree, target]);
  return realpathSync(target);
}

export function inspectCleanup(store: BoardStore, task: Task) {
  requireState(task, ["done", "cancelled"]);
  const current = taskWithCurrentWorktree(store, task);
  const path = current.git?.worktree;
  const repo = store.location.repository;
  const item = repo && current.git ? findWorktree(repo, current.git.branch) : undefined;
  const submitted = task.git?.submission?.sha ?? task.result?.noChanges?.head;
  const entries = path ? cleanupEntries(path) : [];
  const reason = !current.cleanupAvailable ? undefined
    : item?.locked ? "WORKTREE_LOCKED"
    : item && submitted && item.head !== submitted ? "TASK_BRANCH_CHANGED"
    : entries.length ? "DIRTY_WORKTREE" : undefined;
  return {
    pending: current.cleanupAvailable ?? false,
    path, reason, entries,
  };
}

function cleanupEntries(path: string): string[] {
  return git(path, ["-c", "core.quotepath=false", "status", "--short", "--no-renames",
    "--untracked-files=normal", "--ignored=traditional", "--ignore-submodules=none"]).trimEnd().split("\n").filter(Boolean);
}

export function cleanTaskWorktree(store: BoardStore, task: Task, artifacts?: unknown) {
  requireState(task, ["done", "cancelled"]);
  if (artifacts !== undefined) requireState(task, ["done"]);
  if (!task.git || task.git.branch !== worktreeBranch(task)) {
    discardTaskArtifacts(store, task.id);
    return { removed: false };
  }
  const repo = requireRepository(store.location.repository);
  const item = findWorktree(repo, task.git.branch);
  const submitted = task.status === "done" ? task.git.submission?.sha ?? task.result?.noChanges?.head : undefined;
  const tip = submitted && resolveCommit(repo.root, task.git.branch);
  if (tip && tip !== submitted) {
    throw new TaskboardError("TASK_BRANCH_CHANGED", "The task branch no longer points to the confirmed submission.", { tip, submitted });
  }
  let removed = false;
  if (item) {
    try {
      removeTaskWorktree(store, task, repo, item, Boolean(submitted && (task.git.accepted || task.result?.noChanges)), artifacts);
    } catch (error) {
      // The remaining local files stay in the worktree. Copies used during review can expire.
      if (error instanceof TaskboardError && error.code === "DIRTY_WORKTREE") discardTaskArtifacts(store, task.id);
      throw error;
    }
    removed = true;
  } else {
    const orphan = orphanedTaskWorktree(store, repo, task);
    if (orphan) removed = removeEmptyWorktree(orphan);
  }
  discardTaskArtifacts(store, task.id);
  if (!tip) return { removed };
  if (findWorktree(repo, task.git.branch)) {
    throw new TaskboardError("WORKTREE_LOCKED", "The task branch is still checked out.");
  }
  const target = resolveCommit(repo.root, task.git.target);
  if (!target || !isAncestor(repo.root, tip, target)) {
    // Squash retains the accepted result but leaves the submitted SHA outside the target history.
    git(repo.root, ["update-ref", "--no-deref", "refs/ai-taskboard/submissions/" + task.id + "/" + tip, tip]);
  }
  git(repo.root, ["update-ref", "--no-deref", "-d", task.git.branch, tip]);
  return { removed, branchRemoved: true };
}

function orphanedTaskWorktree(store: BoardStore, repo: Repository, task: Task): string | undefined {
  const recorded = task.git?.worktree;
  if (!recorded || !isAbsolute(recorded)) return undefined;
  const expected = [store.subdirectory("worktrees"), isolatedRoot(repo)].map(root => join(root, task.id))
    .find(path => !relative(path, recorded) && exists(path));
  if (!expected) return undefined;
  directory(dirname(expected));
  // Git for Windows can remove the registration while the directory itself is still in use.
  if (worktrees(repo.root).some(item => !relative(expected, item.path))) return undefined;
  return expected;
}

function worktreeAccessDenied(path: string, output: string): TaskboardError {
  return new TaskboardError("WORKTREE_ACCESS_DENIED",
    "Could not remove the worktree. Close programs using it or restore access, then retry cleanup.", { path, output });
}

function removeEmptyWorktree(path: string): boolean {
  directory(path);
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return false;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new TaskboardError("DIRTY_WORKTREE", "The unregistered worktree still contains local files.", { path });
    }
    if (code === "EACCES" || code === "EPERM" || code === "EBUSY") throw worktreeAccessDenied(path, message);
    throw error;
  }
}

function removeTaskOutput(path: string, changes: string[]): boolean {
  const roots = [".dev-diary", ".tasks/qa"].filter(root => changes.some(change => change.startsWith("! " + root + "/")));
  if (!roots.length || changes.some(change => !roots.some(root => change.startsWith("! " + root + "/")))) return false;
  if (git(path, ["ls-files", "-z", "--", ...roots])) return false;
  for (const root of roots) {
    const source = join(path, root);
    directory(dirname(source));
    directory(source);
  }
  for (const root of roots) {
    try {
      rmSync(join(path, root), { recursive: true });
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      if (code === "EACCES" || code === "EPERM" || code === "EBUSY") throw worktreeAccessDenied(path, message);
      throw error;
    }
  }
  return true;
}

function removeTaskWorktree(store: BoardStore, task: Task, repo: Repository, item: Worktree, accepted: boolean, artifacts?: unknown): void {
  if (item.locked) throw new TaskboardError("WORKTREE_LOCKED", "The task worktree is locked.");
  const path = usableWorktree(item);
  const managedRoot = [store.subdirectory("worktrees"), isolatedRoot(repo)].find(root => insideDirectory(root, path));
  if (!managedRoot) {
    throw new TaskboardError("UNMANAGED_WORKTREE", "Only worktrees in the managed directory can be removed.");
  }
  directory(managedRoot);
  requireNoGitOperation(path);
  if (artifacts !== undefined) saveArtifacts(store, task.id, path, artifacts, true);
  const saved = accepted ? artifactFiles(store, task.id) : [];
  const retainedArtifacts = new Set<string>();
  if (saved.length) {
    const ignored = new Set(git(path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0"));
    for (const artifact of saved.toReversed()) {
      if (ignored.has(artifact.source) && removeSavedSource(path, artifact)) ignored.delete(artifact.source);
    }
    for (const { source } of saved) {
      if (ignored.has(source)) retainedArtifacts.add(source);
    }
  }
  let changes = gitStatus(path, true);
  if (accepted && changes && !retainedArtifacts.size && removeTaskOutput(path, changes.split("\0").filter(Boolean))) {
    changes = gitStatus(path, true);
  }
  if (changes.length) {
    const entries = changes.split("\0").filter(Boolean);
    throw new TaskboardError("DIRTY_WORKTREE", "The task worktree still contains local files or changes.", {
      path, changes: entries.slice(0, 30), count: entries.length,
      output: cleanupEntries(path).slice(0, 30).join("\n"),
    });
  }
  try {
    git(repo.root, ["worktree", "remove", path]);
  } catch (error) {
    const details = error instanceof TaskboardError ? error.details as { output?: string } | undefined : undefined;
    if (process.platform === "win32" && details?.output && /permission denied|access is denied/i.test(details.output)) {
      throw worktreeAccessDenied(path, details.output);
    }
    throw error;
  }
}
