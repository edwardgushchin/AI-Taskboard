import { beginBoardOperation } from "../desktop/board-worklog.ts";
import { migrateIntegrationWorktree } from "./acceptance.ts";
import { migrateSavedWorktree } from "./saved-changes.ts";
import { readdirSync, rmSync, rmdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { readTask } from "./archive.ts";
import { directory, exists, onBoard, withTaskStartLock } from "./storage.ts";
import type { BoardLocation, BoardStore } from "./storage.ts";
import { cleanupRetryDeferred, maintenanceFailure, maintenanceSuccess } from "./maintenance-state.ts";
import { cleanTaskWorktree, findTaskWorktree, hasPending, isolateTaskWorktree, taskResourcesInUse, usableWorktree } from "./worktree.ts";
import { git, worktrees } from "./git.ts";
import { TaskboardError } from "./model.ts";

export function removeLegacyAttachments(store: BoardStore) {
  const root = store.location.root;
  const path = join(root, ".codex-attachments");
  if (!isAbsolute(root) || relative(root, path) !== ".codex-attachments") {
    throw new TaskboardError("UNMANAGED_PATH", "Invalid legacy attachment path.");
  }
  directory(root);
  if (exists(path)) {
    directory(path); // Refuse a symlink/junction, including one to another project.
    const finish = beginBoardOperation(root, "remove legacy attachments");
    try { rmSync(path, { recursive: true }); finish("removed legacy attachments"); }
    catch (error) { finish("failed; retry required"); throw error; }
  }
  maintenanceSuccess(store, "attachments");
}

// Called at startup and periodically, independently of auto mode or a manager goal.
export function maintainBoard(location: BoardLocation): string[] {
  const branches = new Set(location.repository ? git(location.repository.root,
    ["for-each-ref", "--format=%(refname)", "refs/heads/ai-taskboard/"]).trim().split("\n") : []);
  let known = new Set<string>();
  const ids = onBoard(location, store => {
    try { removeLegacyAttachments(store); }
    catch (error) { maintenanceFailure(store, "attachments", error); }
    known = new Set([...Object.keys(store.index.tasks), ...Object.keys(store.index.archive)]);
    return [...known].filter(id => {
      const task = readTask(store, id);
      return task.git && (branches.has(task.git.branch) || Boolean(task.git.worktree && exists(task.git.worktree)) || exists(store.pendingPath(id) + ".saved"));
    });
  });
  const cleaned: string[] = [];
  for (const id of ids) {
    try {
      withTaskStartLock(location, id, () => {
        const snapshot = onBoard(location, store => ({ store, task: readTask(store, id) }));
        const { store, task } = snapshot;
        const repo = location.repository;
        if (!repo || !task.git || hasPending(store, task) || taskResourcesInUse(store, id)) return;
        const closed = task.status === "done" || task.status === "cancelled";
        if (closed && cleanupRetryDeferred(store, id)) return;
        try {
          migrateSavedWorktree(store, task);
          migrateIntegrationWorktree(store, task);
          const item = findTaskWorktree(repo, task.git);
          if (!item || item.prunable) {
            maintenanceSuccess(store, "migration", id);
            if (closed) {
              try {
                const result = cleanTaskWorktree(store, task);
                if (result.removed || result.branchRemoved) cleaned.push(id);
              } catch { /* Private cleanup diagnostic. */ }
            }
            return;
          }
          const old = usableWorktree(item);
          const worktree = isolateTaskWorktree(store, repo, id, old);
          if (worktree !== task.git.worktree && Object.hasOwn(store.index.tasks, id)) onBoard(location, current => {
            const latest = readTask(current, id);
            current.save({ ...latest, git: { ...latest.git!, worktree } });
          });
          maintenanceSuccess(store, "migration", id);
          if (closed) {
            try {
              const result = cleanTaskWorktree(store, { ...task, git: { ...task.git, worktree } });
              if (result.removed || result.branchRemoved) cleaned.push(id);
            }
            catch { /* cleanTaskWorktree records the private diagnostic. */ }
          }
        } catch (error) { maintenanceFailure(store, "migration", error, id); }
      }, 0);
    } catch (error) {
      if (!(error instanceof TaskboardError && error.code === "BOARD_BUSY")) {
        onBoard(location, store => maintenanceFailure(store, "migration", error, id));
      }
    }
  }
  let projectFault = false;
  for (const path of [join(location.root, ".taskboard-worktrees"), join(location.directory, "worktrees")]) {
    if (!exists(path)) continue;
    try { directory(path); rmdirSync(path); }
    catch (error) {
      const nonempty = ["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "");
      const unknown = nonempty ? readdirSync(path).filter(name => !known.has(name)) : [];
      if (!nonempty || unknown.length) {
        projectFault = true;
        onBoard(location, store => maintenanceFailure(store, "migration", nonempty
          ? new TaskboardError("UNOWNED_LEGACY_FILES", "Legacy directory contains resources requiring ownership verification.", { path, entries: unknown.slice(0, 30) }) : error));
      }
    }
  }
  if (location.repository) {
    const orphans = worktrees(location.repository.root).filter(item =>
      item.branch?.startsWith("refs/heads/ai-taskboard/") && !known.has(item.branch.slice("refs/heads/ai-taskboard/".length)));
    if (orphans.length) {
      projectFault = true;
      onBoard(location, store => maintenanceFailure(store, "migration", new TaskboardError("ORPHANED_WORKTREE",
        "Registered task branches have no matching card; preserve them until ownership is verified.", { paths: orphans.map(item => item.path) })));
    }
  }
  if (!projectFault) onBoard(location, store => maintenanceSuccess(store, "migration"));
  return cleaned;
}
