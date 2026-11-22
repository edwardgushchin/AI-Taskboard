import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { BoardStore, directory, exists, locateBoard, readJson, withLock, withRuntimeLock, writeJson } from "../cli/storage.ts";

export const backupHour = 60 * 60 * 1000;
export const backupLifetime = 24 * backupHour;
const snapshotId = /^(\d{13})-[0-9a-f-]{36}$/;
const temporaryFile = /^\..+\.[0-9a-f-]{36}\.tmp$/;
const folders = new Set([
  "tasks", "archive", "attachments", "artifacts", "worklog", "experts", "manager-chat",
  "manager-images", "manager-usage", "reviewer-chat", "maintenance-runs", "stage-run-history",
  "codex-daily-usage",
]);
const files = new Set([
  "board.json", "findings.json", "goal-messages.json", "manager-conversation.json", "manager-dialog.json",
  "manager-settings-background.json", "manager-settings-chat.json", "manager-settings-work.json",
  "manager-status-position.json", "manager-unread.json", "orchestrator.json", "review-history.json",
]);

function validateBoard(store: BoardStore): void {
  for (const taskId of Object.keys(store.index.tasks)) store.card(taskId);
  for (const entry of Object.values(store.index.archive)) {
    if (!exists(join(store.location.directory, entry.path))) {
      throw new Error("Missing archived card: " + entry.path);
    }
  }
}

export interface Backup {
  id: string;
  project: string;
  createdAt: number;
}

interface Manifest extends Backup {
  version: 1;
  inventory: [string, string][];
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}

function digest(path: string): string {
  const file = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    for (let count = readSync(file, chunk); count; count = readSync(file, chunk)) {
      hash.update(chunk.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

function inventory(root: string, measure: (path: string) => string, source = false): Manifest["inventory"] {
  directory(root);
  const result: Manifest["inventory"] = [];
  function walk(folder: string, prefix: string): void {
    for (const name of readdirSync(folder).sort()) {
      if (source && (temporaryFile.test(name) || /^\.lock\.sqlite(?:-|$)/.test(name))) continue;
      if (!prefix && !folders.has(name) && !files.has(name)) {
        if (source) continue;
        throw new Error("Unexpected item in the backup: " + name);
      }
      const key = prefix + name;
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && (prefix || folders.has(name))) {
        result.push([key, "/"]);
        walk(path, key + "/");
      } else if (stat.isFile() && (prefix || files.has(name))) {
        result.push([key, measure(path)]);
      } else {
        throw new Error("Expected a regular board file or directory: " + path);
      }
    }
  }
  walk(root, "");
  return result;
}

function copyInventory(from: string, to: string, entries: Manifest["inventory"]): void {
  mkdirSync(to);
  for (const [path, info] of entries) {
    const destination = join(to, path);
    if (info === "/") mkdirSync(destination);
    else copyFileSync(join(from, path), destination, constants.COPYFILE_EXCL);
  }
}

function manifestAt(root: string, id: string, now: number): Manifest {
  const match = snapshotId.exec(id);
  if (!match || now - Number(match[1]) >= backupLifetime) {
    throw new Error("This backup is unavailable or has expired.");
  }
  const folder = join(root, id);
  directory(folder);
  const manifest = readJson(join(folder, "manifest.json")) as Manifest;
  if (!manifest || manifest.version !== 1 || manifest.id !== id || manifest.createdAt !== Number(match[1]) ||
      typeof manifest.project !== "string" || !isAbsolute(manifest.project) || !Array.isArray(manifest.inventory)) {
    throw new Error("Invalid backup manifest.");
  }
  return manifest;
}

function descriptor({ id, project, createdAt }: Backup): Backup {
  return { id, project, createdAt };
}

export function listBackups(root: string, now: number): Backup[] {
  if (!exists(root)) return [];
  directory(root);
  return readdirSync(root).filter(id => snapshotId.test(id)).sort().reverse().flatMap(id => {
    try {
      return [descriptor(manifestAt(root, id, now))];
    } catch {
      return [];
    }
  });
}

export function pruneBackups(root: string, now: number): void {
  if (!exists(root)) return;
  directory(root);
  withLock(root, () => {
    for (const id of readdirSync(root)) {
      const match = snapshotId.exec(id);
      if ((match && now - Number(match[1]) >= backupLifetime) || /^\.creating-[a-zA-Z0-9]{6}$/.test(id)) {
        const path = join(root, id);
        if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true });
      }
    }
  }, 0);
}

export function createBackup(root: string, project: string, now: number): Backup {
  const location = locateBoard(project);
  if (inside(location.root, root)) {
    throw new Error("The backup folder must be outside the project.");
  }
  mkdirSync(root, { recursive: true });
  directory(root);
  if (inside(location.root, realpathSync(root))) {
    throw new Error("The backup folder must be outside the project.");
  }
  const id = now + "-" + randomUUID();
  return withLock(root, () => {
    const staging = mkdtempSync(join(root, ".creating-"));
    try {
      const data = join(staging, ".tasks");
      const save = (): void => {
        const board = location.directory;
        const store = new BoardStore(location);
        if (exists(join(board, "test-recovery.json"))) {
          throw new Error("Board recovery is pending. Retry the backup after it finishes.");
        }
        // Other local history writers use atomic replacement. Check that their files
        // did not change across the copy while the board and journal locks are held.
        const signature = (path: string) => {
          const stat = lstatSync(path, { bigint: true });
          return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
        };
        const before = inventory(board, signature, true);
        copyInventory(board, data, before);
        if (JSON.stringify(before) !== JSON.stringify(inventory(board, signature, true))) {
          throw new Error("Board files changed during backup. Retry shortly.");
        }
        validateBoard(store);
      };
      withLock(location.directory, () => {
        withRuntimeLock(location.directory, () => {
          const journal = join(location.directory, "worklog");
          // Create the shared lock even on a board that has not recorded its first block.
          mkdirSync(journal, { recursive: true });
          directory(journal);
          withLock(journal, save, 0);
        }, 0);
      }, 0);
      const manifest: Manifest = { version: 1, id, project: location.root, createdAt: now, inventory: inventory(data, digest) };
      writeJson(join(staging, "manifest.json"), manifest);
      renameSync(staging, join(root, id));
      return descriptor(manifest);
    } finally {
      if (exists(staging)) rmSync(staging, { recursive: true });
    }
  }, 0);
}

function verify(root: string, id: string, now: number) {
  const manifest = manifestAt(root, id, now);
  const data = join(root, id, ".tasks");
  const actual = inventory(data, digest);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) {
    throw new Error("Backup integrity check failed.");
  }
  const store = new BoardStore({ root: manifest.project, directory: data, repository: null });
  validateBoard(store);
  return { manifest, data, actual };
}

export function verifyBackup(root: string, id: string, now: number): Backup {
  return withLock(root, () => descriptor(verify(root, id, now).manifest), 0);
}

export function restoreBackup(root: string, id: string, parent: string, now: number): string {
  return withLock(root, () => {
    const { manifest, data, actual } = verify(root, id, now);
    const folder = realpathSync(parent);
    if (inside(realpathSync(root), folder)) throw new Error("Choose a folder outside the backup storage.");
    const destination = join(folder, "AI-Taskboard-" + id);
    if (exists(destination)) throw new Error("The restore destination already exists: " + destination);
    const staging = mkdtempSync(join(folder, ".taskboard-restore-"));
    try {
      const board = join(staging, ".tasks");
      copyInventory(data, board, actual);
      if (JSON.stringify(inventory(board, digest)) !== JSON.stringify(manifest.inventory)) {
        throw new Error("Backup integrity check failed.");
      }
      for (const name of ["tasks", "archive", "attachments", "pending"]) {
        mkdirSync(join(board, name), { recursive: true });
      }
      const store = new BoardStore({ root: destination, directory: board, repository: null });
      store.index.settings.autoMode = false;
      // A restored board must not resume queued actions against the original worktrees.
      if (store.index.settings.reviewMode === "reviewer-human") store.index.settings.reviewMode = "human";
      // Archived cards take their outstanding Codex archive requests from the index.
      for (const entry of Object.values(store.index.archive)) {
        delete entry.codexArchivePending;
      }
      writeJson(join(board, "board.json"), store.index);
      for (const taskId of Object.keys(store.index.tasks)) {
        const task = store.card(taskId);
        delete task.launchRequested;
        delete task.acceptanceRepair;
        delete task.discussionReturn;
        delete task.codexArchivePending;
        if (task.draftDiscussion?.phase === "queued" || task.draftDiscussion?.phase === "running") {
          delete task.draftDiscussion;
        }
        if (task.schedule && !task.schedule.paused) {
          task.schedule.paused = true;
        }
        if (task.reviewModeOverride?.mode === "reviewer-human") {
          task.reviewModeOverride.mode = "human";
        }
        writeJson(join(board, "tasks", taskId + ".json"), task);
      }
      mkdirSync(destination);
      try {
        renameSync(board, join(destination, ".tasks"));
      } catch (error) {
        rmdirSync(destination);
        throw error;
      }
      return destination;
    } finally {
      rmSync(staging, { recursive: true });
    }
  }, 0);
}
