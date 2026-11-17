import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isolatedWorktreesDirectory, excludeBoard, git, invokeGit, requireRepository, resolveCommit, worktrees } from "./git.ts";
import { member, object, requireRevision, TaskboardError } from "./model.ts";
import type { Task } from "./model.ts";
import { directory, exists, readJson, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { checkProtectedPaths, collidingPaths, findWorktree, gitStatus, requireNoGitOperation, usableWorktree, taskResourcesInUse } from "./worktree.ts";

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const destinations = ["target", "worktree"] as const;

interface Backup {
  marker: string;
  base: string;
  restored?: { destination: typeof destinations[number]; path: string };
}

function backupPath(store: BoardStore, task: Task): string {
  return store.pendingPath(task.id) + ".saved";
}

function backupRef(task: Task, backup: Backup): string {
  return "refs/ai-taskboard/saved/" + task.id + "/" + backup.marker.slice(-36);
}

function readBackup(store: BoardStore, task: Task): Backup | undefined {
  const path = backupPath(store, task);
  if (!exists(path)) return undefined;
  const backup = object(readJson(path));
  const restored = backup.restored === undefined ? undefined : object(backup.restored);
  if (typeof backup.marker !== "string" || !backup.marker.startsWith("AI Taskboard " + task.id + " ") ||
      !/^AI Taskboard T-\d{4,} [a-f0-9-]{36}$/.test(backup.marker) ||
      typeof backup.base !== "string" || !oid.test(backup.base) ||
      (restored && (!destinations.some(value => value === restored.destination) || typeof restored.path !== "string"))) {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid saved changes record.");
  }
  return backup as unknown as Backup;
}

function savedCommit(repo: string, task: Task, backup: Backup): string | undefined {
  let sha = resolveCommit(repo, backupRef(task, backup));
  if (!sha && resolveCommit(repo, "refs/stash")) {
    // Recover the stash if the process stopped before pinning it to the task.
    const log = git(repo, ["reflog", "show", "--format=%H%x00%gs", "refs/stash"]);
    sha = log.split("\n").map(line => line.trimEnd().split("\0"))
      .find(([hash, subject]) => oid.test(hash) && subject?.endsWith(": " + backup.marker))?.[0];
  }
  return sha && resolveCommit(repo, sha + "^1") === backup.base && resolveCommit(repo, sha + "^2") ? sha : undefined;
}

export function describeSavedChanges(store: BoardStore, task: Task) {
  const backup = readBackup(store, task);
  if (!backup || !store.location.repository) return undefined;
  const sha = savedCommit(store.location.repository.root, task, backup);
  return sha ? { sha, restored: backup.restored } : undefined;
}

export function inspectLocalChanges(path: string, head: string, status = gitStatus(path)) {
  if (!status) return undefined;
  const paths: string[] = [];
  const untracked: string[] = [];
  const working: string[] = [];
  let indexDirty = false;
  let supported = true;
  for (const entry of status.split("\0").filter(Boolean)) {
    const tracked = /^1 \S+ (\S+) (?:\S+ ){5}([\s\S]+)$/.exec(entry);
    const name = tracked?.[2] ?? (entry.startsWith("? ") ? entry.slice(2) : undefined);
    if (name) paths.push(name);
    if (name && entry.startsWith("? ")) untracked.push(name);
    if (name && (!tracked || entry[3] !== ".")) working.push(name);
    if (tracked && entry[2] !== ".") indexDirty = true;
    if (!name || name.endsWith("/") || /^\.tasks(?:\/|$)/i.test(name) || (tracked && tracked[1] !== "N...")) {
      supported = false;
    }
  }
  const token = supported ? createHash("sha256").update(path + "\0" + head + "\0" + status).digest("hex") : undefined;
  return { path, paths, untracked, working, indexDirty, token };
}

function onlyUntracked(status: string): boolean {
  return status.split("\0").filter(Boolean).every(entry => entry.startsWith("? "));
}

export function saveLocalChanges(
  store: BoardStore, task: Task, path: string, head: string, token: unknown, includeUntracked = true,
): void {
  const local = inspectLocalChanges(path, head);
  if (!local?.token) {
    throw new TaskboardError("LOCAL_CHANGES_UNSUPPORTED", "These local changes cannot be saved automatically.", { path });
  }
  if (token !== local.token) {
    throw new TaskboardError("LOCAL_CHANGES_CHANGED", "Local changes have changed. Review the file list again.", { path });
  }
  let backup = readBackup(store, task);
  if (backup && !backup.restored && savedCommit(path, task, backup)) {
    throw new TaskboardError("SAVED_CHANGES_EXIST", "This task already has a backup. Restore it or clear the target worktree.", { path });
  }
  if (!backup || backup.restored || backup.base !== head) {
    backup = { base: head, marker: "AI Taskboard " + task.id + " " + randomUUID() };
    writeJson(backupPath(store, task), backup);
  }
  try {
    git(path, ["stash", "push", ...(includeUntracked ? ["--include-untracked"] : []), "--message", backup.marker]);
  } finally {
    const sha = savedCommit(path, task, backup);
    if (sha) git(path, ["update-ref", backupRef(task, backup), sha]);
  }
  const remaining = gitStatus(path);
  if (!savedCommit(path, task, backup) || (includeUntracked ? remaining : !onlyUntracked(remaining))) {
    throw new TaskboardError("SAVE_CHANGES_INCOMPLETE", "Git could not save and clear all local changes.", { path });
  }
}

function applyBackup(path: string, sha: string, displayPath = path): void {
  const applied = invokeGit(path, ["stash", "apply", "--index", sha]);
  if (applied.code !== 0) {
    const paths = git(path, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    throw new TaskboardError("RESTORE_CONFLICT", "Git could not restore the saved changes. The backup is still available.", {
      path: displayPath, paths, output: applied.stderr.trim(),
    });
  }
}

function checkRestorePaths(path: string, base: string, sha: string, untracked: string[] = []): void {
  const paths = [sha, sha + "^2"].flatMap(ref =>
    git(path, ["diff", "--no-renames", "--name-only", "-z", base, ref]).split("\0").filter(Boolean));
  if (resolveCommit(path, sha + "^3")) {
    paths.push(...git(path, ["ls-tree", "-r", "--name-only", "-z", sha + "^3"]).split("\0").filter(Boolean));
  }
  checkProtectedPaths(path, [...new Set(paths)]);
  const collisions = collidingPaths(path, paths, untracked);
  if (collisions.length) {
    throw new TaskboardError("RESTORE_CONFLICT", "The saved changes would overwrite local files.", { path, paths: collisions });
  }
}

function recoveryRoot(store: BoardStore): string {
  const repo = requireRepository(store.location.repository);
  excludeBoard(repo, isolatedWorktreesDirectory);
  const root = join(repo.root, isolatedWorktreesDirectory);
  directory(root, true);
  return root;
}

function checkApply(store: BoardStore, repo: string, head: string, sha: string, path: string): void {
  const scratch = mkdtempSync(join(recoveryRoot(store), ".restore-check-"));
  try {
    git(repo, ["worktree", "add", "--detach", scratch, head]);
    applyBackup(scratch, sha, path);
  } finally {
    if (invokeGit(repo, ["worktree", "remove", "--force", scratch]).code !== 0) {
      try { rmdirSync(scratch); } catch { /* Preserve any files from an interrupted checkout. */ }
    }
  }
}

export function checkPreserveChanges(
  store: BoardStore, path: string, head: string, tree: string, changed: string[],
  local: NonNullable<ReturnType<typeof inspectLocalChanges>>,
): void {
  const collisions = collidingPaths(path, changed, local.untracked);
  if (collisions.length) {
    throw new TaskboardError("LOCAL_CHANGES_CONFLICT", "The task would overwrite local files.", { path, paths: collisions });
  }
  // Create a tracked snapshot for the check while leaving the real index and files in place.
  const sha = git(path, ["stash", "create", "Taskboard local changes check"]).trim();
  if (!sha) throw new TaskboardError("LOCAL_CHANGES_CHANGED", "Local changes have changed. Review the task again.", { path });
  const checkHead = git(path, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", "Check local changes"]).trim();
  try {
    checkApply(store, path, checkHead, sha, path);
  } catch (error) {
    if (!(error instanceof TaskboardError) || error.code !== "RESTORE_CONFLICT") throw error;
    throw new TaskboardError("LOCAL_CHANGES_CONFLICT", "The task conflicts with local changes. The target was left untouched.", error.details);
  }
}

export function migrateSavedWorktree(store: BoardStore, task: Task): void {
  const backup = readBackup(store, task);
  if (!backup?.restored || backup.restored.destination !== "worktree" || taskResourcesInUse(store, task.id)) return;
  const repo = requireRepository(store.location.repository);
  const sha = savedCommit(repo.root, task, backup);
  if (!sha) return;
  const name = ".restore-" + task.id + "-" + sha.slice(0, 12);
  const source = backup.restored.path;
  if (![join(store.location.directory, "worktrees", name), join(repo.root, ".taskboard-worktrees", name)]
      .some(path => !relative(path, source))) return;
  const target = join(recoveryRoot(store), name);
  const entries = worktrees(repo.root);
  const item = entries.find(item => !relative(item.path, exists(source) ? source : target));
  if (!item || item.prunable || item.branch || item.head !== backup.base) {
    throw new TaskboardError("UNMANAGED_WORKTREE", "The saved recovery directory is not its registered detached worktree.");
  }
  if (item.locked) throw new TaskboardError("WORKTREE_LOCKED", "The recovery worktree is locked.");
  if (exists(source)) {
    directory(dirname(source));
    if (exists(target)) throw new TaskboardError("WORKTREE_COLLISION", "The recovery destination is occupied.");
    git(repo.root, ["worktree", "move", "--", usableWorktree(item), target]);
  }
  writeJson(backupPath(store, task), { ...backup, restored: { ...backup.restored, path: target } });
}

export function restoreSavedChanges(store: BoardStore, task: Task, input: Record<string, unknown>, finishingAcceptance = false) {
  requireRevision(task, input.revision, true);
  const destination = member(input.destination, destinations, "destination");
  migrateSavedWorktree(store, task);
  const repo = requireRepository(store.location.repository);
  const backup = readBackup(store, task);
  const sha = backup && savedCommit(repo.root, task, backup);
  if (!backup || !sha || !task.git) {
    throw new TaskboardError("SAVED_CHANGES_MISSING", "The saved changes are unavailable.");
  }
  if (backup.restored) {
    if (backup.restored.destination === destination) return backup.restored;
    throw new TaskboardError("ALREADY_RESTORED", "The saved changes have already been restored.", { path: backup.restored.path });
  }
  let path: string;
  if (destination === "worktree") {
    path = join(recoveryRoot(store), ".restore-" + task.id + "-" + sha.slice(0, 12));
    if (exists(path)) {
      throw new TaskboardError("WORKTREE_COLLISION", "The recovery worktree already exists.", { path });
    }
    git(repo.root, ["worktree", "add", "--detach", path, backup.base]);
    requireNoGitOperation(path);
    if (gitStatus(path)) {
      throw new TaskboardError("WORKTREE_CHANGED", "The new recovery worktree has local changes. The backup is still available.", { path });
    }
    checkRestorePaths(path, backup.base, sha);
  } else {
    if (!finishingAcceptance && task.status !== "done" && exists(store.pendingPath(task.id))) {
      throw new TaskboardError("PENDING_OPERATION", "Finish the pending acceptance or restore into a separate worktree.");
    }
    path = usableWorktree(findWorktree(repo, task.git.target));
    requireNoGitOperation(path);
    const status = gitStatus(path);
    if (status && !(finishingAcceptance && onlyUntracked(status))) {
      throw new TaskboardError("DIRTY_TARGET", "The target worktree has local changes. Restore into a separate worktree.", { path });
    }
    const head = resolveCommit(path, "HEAD")!;
    const untracked = inspectLocalChanges(path, head, status)?.untracked ?? [];
    checkRestorePaths(path, backup.base, sha, untracked);
    checkApply(store, repo.root, head, sha, path);
    if (resolveCommit(path, "HEAD") !== head || git(path, ["symbolic-ref", "HEAD"]).trimEnd() !== task.git.target || gitStatus(path) !== status) {
      throw new TaskboardError("TARGET_CHANGED", "The target worktree changed during the restore check.", { path });
    }
    requireNoGitOperation(path);
    checkRestorePaths(path, backup.base, sha, untracked);
  }
  applyBackup(path, sha);
  const restored = { destination, path };
  writeJson(backupPath(store, task), { ...backup, restored });
  return restored;
}
