import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  excludeBoard, git, localBranch, requireRepository, resolveCommit, worktrees,
} from "./git.ts";
import type { Repository, Worktree } from "./git.ts";
import { object, record, requireRevision, requireState, TaskboardError, text } from "./model.ts";
import type { Task } from "./model.ts";
import { directory, exists, readJson, removeFile, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

export function findWorktree(repo: Repository, branch: string): Worktree | undefined {
  const matches = worktrees(repo.root).filter(item => item.branch === branch);
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

export function taskWithCurrentWorktree(store: BoardStore, task: Task): Task {
  if (!task.git) return task;
  const repo = store.location.repository;
  const item = repo && findWorktree(repo, task.git.branch);
  const worktree = item && !item.prunable && exists(item.path) ? usableWorktree(item) : undefined;
  return { ...task, git: { ...task.git, worktree } };
}

export function gitStatus(path: string, ignored = false): string {
  return git(path, [
    "status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=none",
    ignored ? "--ignored=traditional" : "--ignored=no",
  ]);
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

export function hasPending(store: BoardStore, task: Task): boolean {
  const path = store.pendingPath(task.id);
  if (!exists(path)) return false;
  const repo = store.location.repository;
  if (!repo || task.status !== "ready") return true;
  const pending = object(readJson(path));
  if (pending.action !== "start" || pending.revision !== task.revision) return true;

  const branch = worktreeBranch(task);
  const managedPath = join(store.subdirectory("worktrees"), task.id);
  if (exists(managedPath) || resolveCommit(repo.root, branch) ||
      worktrees(repo.root).some(item => item.branch === branch || relative(managedPath, item.path) === "")) return true;

  // A task edit can abandon an attempted start that left no Git artifacts.
  removeFile(path);
  return false;
}

export function startTask(store: BoardStore, task: Task, input: Record<string, unknown>) {
  requireState(task, ["ready", "in_progress"]);
  const repo = requireRepository(store.location.repository);
  const branch = worktreeBranch(task);
  const managedPath = join(store.subdirectory("worktrees"), task.id);
  const pendingPath = store.pendingPath(task.id);
  const pending = exists(pendingPath) ? object(readJson(pendingPath)) : undefined;
  if (pending && pending.action !== "start") {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before starting.");
  }
  if (task.status === "in_progress") {
    if (!task.git || task.git.branch !== branch) {
      throw new TaskboardError("CORRUPT_STORAGE", "The task has no matching Git branch.");
    }
    const worktree = usableWorktree(findWorktree(repo, branch));
    if (pending) removeFile(pendingPath);
    return { task, worktree };
  }

  requireRevision(task, input.revision);
  excludeBoard(repo);
  const requested = input.target === undefined ? undefined : text(input.target, "target", true);
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
    const commit = resolveCommit(repo.root, target);
    if (!commit) throw new TaskboardError("TARGET_HAS_NO_COMMIT", "The target branch needs an initial commit.");
    base = commit;
    if (resolveCommit(repo.root, branch) || findWorktree(repo, branch) || exists(managedPath)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The task branch or worktree path is already in use.");
    }
    writeJson(pendingPath, { action: "start", revision: task.revision, target, base });
  }

  const existing = findWorktree(repo, branch);
  if (existing) {
    if (existing.head !== base || realpathSync(managedPath) !== usableWorktree(existing)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The interrupted start no longer matches the worktree.");
    }
  } else {
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
    git(repo.root, args);
  }

  const worktree = usableWorktree(findWorktree(repo, branch));
  const updated = store.save(record({
    ...task, git: { target, base, branch, worktree },
  }, "start", "agent", "in_progress"));
  removeFile(pendingPath);
  return { task: updated, worktree };
}

export function cleanTaskWorktree(store: BoardStore, task: Task) {
  requireState(task, ["done", "cancelled"]);
  if (!task.git || task.git.branch !== worktreeBranch(task)) return { removed: false };
  const repo = requireRepository(store.location.repository);
  const item = findWorktree(repo, task.git.branch);
  if (!item) return { removed: false };
  if (item.locked) throw new TaskboardError("WORKTREE_LOCKED", "The task worktree is locked.");
  const path = usableWorktree(item);
  const managedRoot = realpathSync(store.subdirectory("worktrees"));
  const inside = relative(managedRoot, path);
  if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) {
    throw new TaskboardError("UNMANAGED_WORKTREE", "Only worktrees in the managed directory can be removed.");
  }
  requireNoGitOperation(path);
  const changes = gitStatus(path, true);
  if (changes.length) {
    throw new TaskboardError("DIRTY_WORKTREE", "The task worktree still contains local files or changes.", {
      path, changes: changes.split("\0").filter(Boolean),
    });
  }
  git(repo.root, ["worktree", "remove", path]);
  return { removed: true };
}
