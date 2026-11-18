import { beginBoardOperation } from "../desktop/board-worklog.ts";
import { migrateWorklog, removeMigratedWorklog } from "./worklog-migration.ts";
import { maintenanceFailure, maintenanceSuccess } from "./maintenance-state.ts";
import { inspectLocalChanges, saveLocalChanges } from "./saved-changes.ts";
import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { artifactFiles, removeSavedSource, saveArtifacts } from "./artifacts.ts";
import { dependencyStatus, unfinishedDependencies } from "./dependencies.ts";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  createInitialCommit, excludeBoard, git, invokeGit, isAncestor, isolatedWorktreesDirectory, localBranch,
  requireRepository, resolveCommit, worktrees,
} from "./git.ts";
import type { Repository, Worktree } from "./git.ts";
import { boardReviewMode, object, record, requireRevision, requireState, taskIdPattern, TaskboardError, text } from "./model.ts";
import { requireExpertPlan } from "./expert-team.ts";
import { boardActor } from "./tasks.ts";
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

export function findTaskWorktree(repo: Repository, { branch, worktree: recorded }: TaskGit, entries = worktrees(repo.root)): Worktree | undefined {
  const attached = findWorktree(repo, branch, entries);
  if (attached || !recorded || !isAbsolute(recorded)) return attached;
  let expected = recorded;
  const id = branch.slice("refs/heads/ai-taskboard/".length);
  if (branch.startsWith("refs/heads/ai-taskboard/") && taskIdPattern.test(id) &&
      [join(repo.root, ".tasks", "worktrees"), join(repo.root, ".taskboard-worktrees")].some(root => insideDirectory(root, recorded)) && !exists(recorded)) {
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

export function gitStatus(path: string, files: "unignored" | "tracked" | "all" = "unignored"): string {
  return git(path, [
    "status", "--porcelain=v2", "-z", "--no-renames",
    files === "tracked" ? "--untracked-files=no" : "--untracked-files=all",
    files === "tracked" ? "--ignore-submodules=untracked" : "--ignore-submodules=none",
    files === "all" ? "--ignored=traditional" : "--ignored=no",
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

function prepareMissingWorktree(store: BoardStore, repo: Repository, id: string, taskGit: TaskGit, entries: Worktree[]) {
  const { branch, worktree: recorded } = taskGit;
  const path = join(isolatedRoot(repo), id);
  const candidates = new Set([path, join(store.location.directory, "worktrees", id),
    join(repo.root, ".taskboard-worktrees", id)]);
  if (recorded && isAbsolute(recorded)) candidates.add(recorded);
  for (const candidate of candidates) {
    if (exists(candidate) || entries.some(entry => !relative(candidate, entry.path))) {
      throw new TaskboardError("WORKTREE_COLLISION", "A previous or canonical task worktree path is occupied.", { path: candidate });
    }
  }
  const base = retainedBranchHead(repo, branch);
  isolatedRoot(repo, true);
  return { managedPath: path, base };
}

function retainedBranchHead(repo: Repository, branch: string): string {
  // Resolve only the local branch. A tag or remote-tracking ref cannot replace it.
  const ref = invokeGit(repo.root, ["show-ref", "--verify", "--hash", branch]);
  const head = ref.stdout.trim();
  if (ref.code !== 0 || !head || resolveCommit(repo.root, head) !== head) {
    throw new TaskboardError("TASK_BRANCH_MISSING", "The task's local Git branch has no commit.", { branch });
  }
  return head;
}

export function hasPending(store: BoardStore, task: Task, holdsStartLock = false): boolean {
  const path = store.pendingPath(task.id);
  if (!exists(path)) return false;
  const repo = store.location.repository;
  const pending = object(readJson(path));
  if (pending.action === "start" && pending.restore === true) {
    if (!holdsStartLock && taskStartInProgress(store.location, task.id)) return true;
    if (repo && task.git && (exists(join(isolatedRoot(repo), task.id)) ||
        worktrees(repo.root).some(item => item.branch === task.git?.branch))) return true;
    // With no checkout left behind, the saved branch already identifies the task.
    removeFile(path);
    return false;
  }
  if (!repo || task.status !== "ready") return true;
  if (pending.action !== "start" || pending.revision !== task.revision) return true;
  if (!holdsStartLock && taskStartInProgress(store.location, task.id)) return true;

  const branch = worktreeBranch(task);
  const managedPaths = [isolatedRoot(repo), join(store.location.directory, "worktrees"), join(repo.root, ".taskboard-worktrees")]
    .map(root => join(root, task.id));
  if (managedPaths.some(exists) || resolveCommit(repo.root, branch) ||
      worktrees(repo.root).some(item => item.branch === branch || managedPaths.some(path => !relative(path, item.path)))) return true;

  // A task edit can abandon an attempted start that left no Git artifacts.
  removeFile(path);
  return false;
}

type StartedTask = { task: Task } & ({ worktree: string } | { cwd: string });
type StartIntent = { action: "start"; revision: number; target: string; base: string; actor?: "user" | "agent" | "manager"; isolatedWorktree?: true; restore?: true };
type TaskCheckout = {
  id: string; repo: Repository; branch: string; managedPath: string; intent: StartIntent;
  preparing: number; lockWaitMs: number;
};

function saveStart(store: BoardStore, task: Task, lockWaitMs: number, prepareMs: number, gitWorktreeAddMs?: number, actor: "user" | "agent" | "manager" = "agent",
  beforeSave?: (task: Task) => void) {
  const updated = record({ ...task, discussionReturn: undefined }, "start", actor, "in_progress");
  updated.history.at(-1)!.startTiming = {
    lockWaitMs, prepareMs, ...(gitWorktreeAddMs !== undefined ? { gitWorktreeAddMs } : {}),
  };
  beforeSave?.(updated);
  return store.save(updated);
}

export function prepareTaskStart(store: BoardStore, task: Task, input: Record<string, unknown>, lockWaitMs: number,
  beforeSave?: (task: Task) => void): StartedTask | TaskCheckout {
  const preparing = performance.now();
  const save = (card: Task) => saveStart(store, card, lockWaitMs, Math.round(performance.now() - preparing), undefined, boardActor(input), beforeSave);
  requireState(task, ["ready", "in_progress"]);
  if (store.index.settings.requireExpertPlans && !task.expertStage) {
    requireExpertPlan(task, "work");
    if (!task.schedule && boardReviewMode(store.index.settings) !== "human") requireExpertPlan(task, "review");
  }
  if (task.status === "ready" || input.actor === "user") {
    const dependencies = unfinishedDependencies(task, id => dependencyStatus(store, id));
    if (dependencies.length) {
      throw new TaskboardError("DEPENDENCIES_INCOMPLETE", "Complete the task dependencies before starting.", { dependencies });
    }
    if (task.status === "ready" && task.schedule && !(Date.parse(task.schedule.nextAt) <= Date.now())) {
      throw new TaskboardError("INVALID_TRANSITION", "The task is not due to run.", { nextAt: task.schedule.nextAt });
    }
  }
  requireRevision(task, input.revision);
  if (input.discussionReturn !== undefined && input.discussionReturn !== task.discussionReturn) {
    throw new TaskboardError("INVALID_TRANSITION", "This discussion return is no longer waiting to launch.");
  }
  if (task.workingDirectory) {
    if (task.git || input.target !== undefined || input.resolveConflicts === true) {
      throw new TaskboardError("INVALID_INPUT", "This task uses an existing directory and has no task branch.");
    }
    if (exists(store.pendingPath(task.id))) {
      throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted operation before starting.");
    }
    const cwd = taskWorkingDirectory(task.workingDirectory, true);
    return { task: task.status === "in_progress" && task.discussionReturn === undefined ? task : save(task), cwd };
  }
  const branch = worktreeBranch(task);
  const pendingPath = store.pendingPath(task.id);
  let pending = exists(pendingPath) ? object(readJson(pendingPath)) : undefined;
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
    const entries = worktrees(repo.root);
    const existing = findTaskWorktree(repo, task.git, entries);
    if (existing && (existing.prunable || !exists(existing.path))) {
      throw new TaskboardError("WORKTREE_MISSING", "Git still registers the task worktree at an unavailable path.", { path: existing.path });
    }
    if (pending?.restore === true) {
      if (existing) {
        const { revision, target, base } = pending;
        const managedPath = join(isolatedRoot(repo), task.id);
        if (typeof revision !== "number" || target !== task.git.target ||
            typeof base !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) {
          throw new TaskboardError("PENDING_OPERATION", "The interrupted worktree recovery does not match this task revision or target.");
        }
        if (revision === task.revision) {
          const intent: StartIntent = { action: "start", revision, target, base, actor: boardActor(pending), restore: true };
          return { id: task.id, repo, branch, managedPath, intent, preparing, lockWaitMs };
        }
        // The restored worktree and its start event may already be saved if removal of the intent was interrupted.
        const last = task.history.findLast(event => event.action !== "coordination");
        if (task.status !== "in_progress" || task.revision !== revision + 1 ||
            last?.action !== "start" || (last.from !== "ready" && last.from !== undefined) || !task.git.worktree ||
            relative(managedPath, task.git.worktree) || relative(managedPath, existing.path) || existing.head !== base) {
          throw new TaskboardError("PENDING_OPERATION", "The interrupted worktree recovery does not match this task revision or target.");
        }
      }
      removeFile(pendingPath);
      pending = undefined;
    }
    if (!existing) {
      if (pending) throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted start before restoring a missing worktree.");
      const { managedPath, base } = prepareMissingWorktree(store, repo, task.id, task.git, entries);
      const intent: StartIntent = { action: "start", revision: task.revision, target: task.git.target,
        base, actor: boardActor(input), restore: true };
      writeJson(pendingPath, intent);
      return { id: task.id, repo, branch, managedPath, intent, preparing, lockWaitMs };
    }
    const worktree = isolateTaskWorktree(store, repo, task.id, usableWorktree(existing));
    const updated = { ...task, git: { ...task.git, worktree } };
    if (pending) removeFile(pendingPath);
    if (task.status === "in_progress" && task.discussionReturn === undefined) return { task: worktree === task.git.worktree ? task : store.save(updated), worktree };
    return { task: save(updated), worktree };
  }

  const requested = input.target === undefined ? undefined : text(input.target, "target", true);
  const repo = store.location.repository ?? requireRepository(locateBoard(store.location.root, true, true).repository);
  excludeBoard(repo);
  const isolatedWorktree = true;
  const managedPath = join(isolatedRoot(repo, true), task.id);
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
  const intent: StartIntent = { action: "start", revision: task.revision, target, base, actor: boardActor(pending || input),
    ...((pending ? pending.isolatedWorktree === true : isolatedWorktree) ? { isolatedWorktree: true } : {}) };
  if (!pending) writeJson(pendingPath, intent);
  return { id: task.id, repo, branch, managedPath, intent, preparing, lockWaitMs };
}

export function checkoutTaskWorktree({ id, repo, branch, managedPath, intent: { base, restore } }: TaskCheckout) {
  if (restore) requireNoGitOperation(repo.root);
  const existing = findWorktree(repo, branch);
  let gitWorktreeAddMs: number | undefined;
  if (!existing) {
    if (exists(managedPath)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The worktree path already contains files.", { path: managedPath });
    }
    const existingCommit = restore ? retainedBranchHead(repo, branch) : resolveCommit(repo.root, branch);
    if (existingCommit && existingCommit !== base) {
      throw new TaskboardError("WORKTREE_COLLISION", "The task branch changed during the interrupted start.");
    }
    const name = branch.slice("refs/heads/".length);
    const args = existingCommit
      ? ["worktree", "add", "--no-guess-remote", "--", managedPath, name]
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
  const moved = [join(repo.root, ".tasks", "worktrees", id), join(repo.root, ".taskboard-worktrees", id), join(isolatedRoot(repo), id)].some(path => !relative(path, worktree));
  if (item?.head !== base || (!matches && (restore || !moved))) {
    throw new TaskboardError("WORKTREE_COLLISION", "The task worktree does not match the pending checkout.");
  }
  if (restore && existing) {
    requireNoGitOperation(worktree);
    // An interrupted Git command can leave a valid registration before populating the index and files.
    if (gitStatus(worktree, "tracked")) {
      throw new TaskboardError("WORKTREE_CHECKOUT_INCOMPLETE",
        "The interrupted checkout could not be verified: tracked files or the index differ from the saved commit. Inspect and preserve local changes before completing the checkout and retrying.",
        { path: worktree, head: base });
    }
  }
  return { worktree, gitWorktreeAddMs };
}

export function finishTaskStart(store: BoardStore, plan: TaskCheckout, checkout: ReturnType<typeof checkoutTaskWorktree>,
  finalLockWaitMs: number, isolate: boolean, beforeSave?: (task: Task) => void) {
  const { id, branch, intent, preparing, lockWaitMs } = plan;
  const task = store.card(id);
  requireState(task, intent.restore ? ["ready", "in_progress"] : ["ready"]);
  requireRevision(task, intent.revision, true);
  const dependencies = unfinishedDependencies(task, id => dependencyStatus(store, id));
  if (dependencies.length) throw new TaskboardError("DEPENDENCIES_INCOMPLETE", "Complete the task dependencies before starting.", { dependencies });
  const pendingPath = store.pendingPath(id);
  const pending = exists(pendingPath) && object(readJson(pendingPath));
  const { target, base, restore } = intent;
  if (!pending || pending.action !== intent.action || pending.revision !== intent.revision ||
      pending.target !== target || pending.base !== base || pending.restore !== restore ||
      pending.isolatedWorktree !== intent.isolatedWorktree) {
    throw new TaskboardError("PENDING_OPERATION", "The pending task checkout changed.");
  }
  const { gitWorktreeAddMs } = checkout;
  const worktree = isolateTaskWorktree(store, plan.repo, id, checkout.worktree);
  const prepareMs = Math.max(0, Math.round(performance.now() - preparing) - finalLockWaitMs);
  if (restore && (!task.git || task.git.branch !== branch || task.git.target !== target)) {
    throw new TaskboardError("PENDING_OPERATION", "The saved task branch or target changed during checkout.");
  }
  const updatedTask = { ...task, git: { ...(restore ? task.git! : { target, base, branch }), worktree } };
  const preserveRevision = task.status === "in_progress" && task.discussionReturn === undefined;
  if (preserveRevision) beforeSave?.(updatedTask);
  const updated = preserveRevision ? store.save(updatedTask) : saveStart(store, updatedTask,
    lockWaitMs + finalLockWaitMs, prepareMs, gitWorktreeAddMs, intent.actor, beforeSave);
  removeFile(pendingPath);
  return { task: updated, worktree };
}

export function taskResourcesInUse(store: BoardStore, id: string): boolean {
  const runtime = join(store.location.directory, "runtime.json");
  if (!exists(runtime)) return false;
  const entries = readJson(runtime);
  if (!Array.isArray(entries)) throw new TaskboardError("CORRUPT_STORAGE", "Invalid runtime registry.");
  const alive = (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  if (entries.some(entry => entry.task === id && entry.kind !== "queue" && alive(entry.pid ?? entry.owner))) return true;
  return entries.some(provider => {
    if (provider.kind !== "provider" || !alive(provider.pid)) return false;
    let entry = provider;
    const seen = new Set<string>();
    while (entry && !seen.has(entry.id)) {
      if (entry.task === id) return true;
      seen.add(entry.id);
      entry = entries.find(candidate => candidate.id === entry.parent);
    }
    return false;
  });
}

// Move only the assigned, registered Git worktree, under the task's start lock.
export function isolateTaskWorktree(store: BoardStore, repo: Repository, id: string, worktree: string): string {
  const legacyRoots = [join(store.location.directory, "worktrees"), join(repo.root, ".taskboard-worktrees")];
  if (!legacyRoots.some(root => !relative(join(root, id), worktree))) return worktree;
  const registered = findWorktree(repo, "refs/heads/ai-taskboard/" + id);
  if (!registered || relative(usableWorktree(registered), worktree)) {
    throw new TaskboardError("UNMANAGED_WORKTREE", "The legacy path is not the registered task worktree.");
  }
  directory(dirname(worktree));
  if (taskResourcesInUse(store, id)) return worktree;
  const target = join(isolatedRoot(repo, true), id);
  if (exists(target)) throw new TaskboardError("WORKTREE_COLLISION", "The isolated worktree path already contains files.", { path: target });
  const finish = beginBoardOperation(store.location.root, "migrate legacy worktree", id);
  try { git(repo.root, ["worktree", "move", "--", worktree, target]); finish("moved to managed directory"); }
  catch (error) { finish("failed; inspect worktree registration before retry"); throw error; }
  for (const root of legacyRoots) {
    if (!exists(root)) continue;
    try { rmdirSync(root); } catch (error) {
      if (!["ENOTEMPTY", "EEXIST", "EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
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
  let finish: ReturnType<typeof beginBoardOperation> | undefined;
  try {
    const result = cleanTaskWorktreeNow(store, task, artifacts, () => {
      finish = beginBoardOperation(store.location.root, "worktree cleanup", task.id);
    });
    maintenanceSuccess(store, "cleanup", task.id);
    finish?.(result.removed ? "worktree removed" : result.branchRemoved ? "retired branch removed" : "resources already absent");
    return result;
  } catch (error) {
    maintenanceFailure(store, "cleanup", error, task.id);
    finish?.("failed; resources retained for retry");
    throw error;
  }
}

function cleanTaskWorktreeNow(store: BoardStore, task: Task, artifacts: unknown, audit: () => void) {
  requireState(task, ["done", "cancelled"]);
  if (taskResourcesInUse(store, task.id)) throw new TaskboardError("WORKTREE_IN_USE", "A live agent still uses the task resources.");
  if (!task.git || task.git.branch !== worktreeBranch(task)) {
    return { removed: false };
  }
  const repo = requireRepository(store.location.repository);
  const item = findWorktree(repo, task.git.branch);
  const submitted = task.status === "done" ? task.git.submission?.sha ?? task.result?.noChanges?.head : undefined;
  const tip = submitted && resolveCommit(repo.root, task.git.branch);
  if (tip && tip !== submitted) {
    throw new TaskboardError("TASK_BRANCH_CHANGED", "The task branch no longer points to the confirmed submission.", { tip, submitted });
  }
  const orphan = item ? undefined : orphanedTaskWorktree(store, repo, task);
  if (!item && !orphan && !tip) return { removed: false };
  audit();
  let removed = false;
  if (item) {
    removeTaskWorktree(store, task, repo, item, Boolean(submitted && (task.git.accepted || task.result?.noChanges)), artifacts);
    removed = true;
  } else if (orphan) removed = removeEmptyWorktree(orphan);
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
  const expected = [join(store.location.directory, "worktrees"), join(repo.root, ".taskboard-worktrees"), isolatedRoot(repo)].map(root => join(root, task.id))
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

// Saved regular QA files have already been removed by hash. Never recursively delete
// remaining files or follow links: an unexpected/new file keeps its containing directory.
function clearEmptyQa(path: string): void {
  directory(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      try { unlinkSync(child); }
      catch (error) {
        if (process.platform !== "win32") throw error;
        rmdirSync(child); // A junction entry, never its target.
      }
    } else if (entry.isDirectory()) clearEmptyQa(child);
  }
  try { rmdirSync(path); }
  catch (error) {
    if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function removeTaskOutput(path: string, id: string, changes: string[]): boolean {
  // Diaries remain in place: only separately verified migration can authorize their removal.
  const roots = [`.codex-attachments/${id}`]
    .filter(root => changes.some(change => change.startsWith("! " + root + "/")));
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

function removeCrashpadDebugLog(path: string): boolean {
  const file = join(path, "debug.log");
  const before = lstatSync(file, { throwIfNoEntry: false });
  if (!before?.isFile() || !before.size || before.size > 64 * 1024) return false;
  const registrationError = /^\[\d{4}\/\d{6}\.\d{3}:ERROR:third_party[\\/]crashpad[\\/]crashpad[\\/]util[\\/]win[\\/]registration_protocol_win\.cc:\d+\] CreateFile: [^\x00-\x1f]+ \(0x5\)$/;
  const lines = readBinary(file).toString("utf8").trimEnd().split(/\r?\n/);
  if (!lines.every(line => registrationError.test(line))) return false;
  const after = lstatSync(file, { throwIfNoEntry: false });
  if (!after?.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return false;
  removeFile(file);
  return true;
}

function removeTaskWorktree(store: BoardStore, task: Task, repo: Repository, item: Worktree, accepted: boolean, artifacts?: unknown): void {
  if (item.locked) throw new TaskboardError("WORKTREE_LOCKED", "The task worktree is locked.");
  const path = usableWorktree(item);
  const managedRoot = [join(store.location.directory, "worktrees"), join(repo.root, ".taskboard-worktrees"), isolatedRoot(repo)].find(root => insideDirectory(root, path));
  if (!managedRoot) {
    throw new TaskboardError("UNMANAGED_WORKTREE", "Only worktrees in the managed directory can be removed.");
  }
  directory(managedRoot);
  requireNoGitOperation(path);
  if (exists(join(path, ".dev-diary"))) {
    if (git(path, ["ls-files", "-z", "--", ".dev-diary"])) migrateWorklog(store.location.root, [join(path, ".dev-diary")]);
    else removeMigratedWorklog(store.location.root, join(path, ".dev-diary"));
  }
  if (task.status === "cancelled") {
    const head = resolveCommit(path, "HEAD")!;
    const local = inspectLocalChanges(path, head);
    if (local) saveLocalChanges(store, task, path, head, local.token);
  }
  const legacyAttachments = join(path, ".codex-attachments");
  if (exists(legacyAttachments)) {
    directory(legacyAttachments);
    rmSync(legacyAttachments, { recursive: true });
  }
  const qa = git(path, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ".tasks/qa"])
    .split("\0").filter(source => {
      if (!source) return false;
      let cursor = path;
      for (const part of source.split("/")) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) return false;
      }
      return lstatSync(cursor).isFile();
    });
  const previouslySaved = new Set(artifactFiles(store, task.id).map(artifact => artifact.source));
  const newQa = qa.filter(source => !previouslySaved.has(source));
  if (newQa.length) saveArtifacts(store, task.id, path, newQa, true);
  if (artifacts !== undefined) saveArtifacts(store, task.id, path, artifacts, true);
  const saved = artifactFiles(store, task.id);
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
  const qaRoot = join(path, ".tasks", "qa");
  if (exists(qaRoot) && !retainedArtifacts.size) clearEmptyQa(qaRoot);
  let changes = gitStatus(path, "all");
  if (accepted && changes.split("\0").some(entry => entry === "? debug.log" || entry === "! debug.log") &&
      removeCrashpadDebugLog(path)) {
    changes = gitStatus(path, "all");
  }
  if (accepted && changes && !retainedArtifacts.size && removeTaskOutput(path, task.id, changes.split("\0").filter(Boolean))) {
    changes = gitStatus(path, "all");
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
