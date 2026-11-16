import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { TaskboardError, object } from "./model.ts";
import { readTask } from "./archive.ts";
import { isolatedWorktreesDirectory } from "./git.ts";
import { directory, exists, finishTestRecovery, readBinary, readJson, sha256, taskStartInProgress, withTaskRecoveryLock, writeAtomic, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

interface Fingerprint { path: string; bytes: number; sha256: string }

// Exact original bytes include identity, history and the sole test usage report.
const ipcIncidentCards: Record<string, string> = {
  "T-0014": "6a5798aedf9e34a8210d7161ee91b96671465b2730a43102d5c4509afd2bcb48",
  "T-0015": "0e12fb1d8232ed550e2528fc0a1d180133694dda342cdcfca6d3ab9e16bdacd2",
  "T-0016": "45fbf7e7686619dd4197671c3a0c83d29069096b4a9baddb26cae6a251490524",
};

// Deliberately restricted to proven fixtures without retained execution resources. This is
// not a general task deletion API: histories and execution resources need review.
export function recoverTestData(store: BoardStore, input: Record<string, unknown>) {
  return withTaskRecoveryLock(store.location, () => recoverTestDataLocked(store, input));
}

function recoverTestDataLocked(store: BoardStore, input: Record<string, unknown>) {
  const manifest = object(input.manifest);
  const fail = (message: string): never => { throw new TaskboardError("RECOVERY_REFUSED", message); };
  if (manifest.schema !== 1 || manifest.targetRoot !== store.location.root ||
      realpathSync(store.location.root) !== manifest.targetRoot) fail("Manifest must name the exact canonical project root.");
  if (input.apply !== undefined && typeof input.apply !== "boolean") fail("apply must be boolean; omission means dry-run.");
  if (!Array.isArray(manifest.cards) || !manifest.cards.length || !Array.isArray(manifest.pending)) fail("Specify cards and pending fingerprints.");
  if (manifest.incident !== undefined && manifest.incident !== "T-0082") fail("Unknown incident profile.");
  const ipcIncident = manifest.incident === "T-0082";
  if (ipcIncident && ((manifest.cards as unknown[]).length !== 3 || store.index.nextId < 17)) fail("Incomplete IPC incident selection.");
  const check = (value: unknown, path: string): Fingerprint => {
    const file = object(value);
    if (file.path !== path || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail("Invalid file fingerprint.");
    const bytes = readBinary(join(store.location.root, path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail("File changed: " + path);
    const metadata = statSync(join(store.location.root, path));
    if ((file.modifiedAt !== undefined && metadata.mtime.toISOString() !== file.modifiedAt) ||
        (file.createdAt !== undefined && metadata.birthtime.toISOString() !== file.createdAt)) fail("File timestamps changed: " + path);
    return file as unknown as Fingerprint;
  };
  check(manifest.boardIndex, ".tasks/board.json");
  if (manifest.nextId !== store.index.nextId) fail("nextId changed.");
  const ids = new Set<string>();
  const files: Fingerprint[] = [];
  for (const value of manifest.cards as unknown[]) {
    const entry = object(value);
    const identity = object(entry.identity);
    const id = String(identity.id);
    if (!/^T-[0-9]{4,}$/.test(id) || ids.has(id)) fail("Use distinct task IDs.");
    ids.add(id);
    files.push(check(entry, ".tasks/tasks/" + id + ".json"));
    const task = store.card(id);
    if (Object.hasOwn(store.index.archive, id)) fail("Task is also archived: " + id);
    if (Object.entries(identity).some(([key, value]) => (task as unknown as Record<string, unknown>)[key] !== value)) fail("Identity changed: " + id);
    if (ipcIncident) {
      if (!Object.hasOwn(ipcIncidentCards, id) || entry.sha256 !== ipcIncidentCards[id]) fail("IPC incident bytes changed: " + id);
    } else {
      if (task.status !== "cancelled" || task.codexThreadId || task.goalThreadId || task.git || task.schedule ||
          task.attachments.length || task.artifacts?.length || task.tokenUsage ||
          !task.workingDirectory || exists(task.workingDirectory)) fail("Task has execution resources: " + id);
      if (!/^(First|Second)$/.test(task.title) || !/[/\\]T-0068-live-[^/\\]+$/.test(task.workingDirectory!)) fail("Task is not an incident fixture: " + id);
    }
    if (taskStartInProgress(store.location, id)) fail("Task start is active: " + id);
    const pending = readdirSync(store.subdirectory("pending")).filter(name => name.startsWith(id + "."));
    if (pending.some(name => name !== id + ".start.sqlite")) fail("Pending operation: " + id);
    const roots = [store.subdirectory("attachments"), store.subdirectory("worktrees")];
    const isolated = join(store.location.root, isolatedWorktreesDirectory);
    if (exists(isolated)) {
      directory(isolated);
      roots.push(isolated);
    }
    for (const root of roots) {
      if (readdirSync(root).some(file => file === id || file.startsWith(id + "."))) fail("Task has extra storage: " + id);
    }
  }
  const pendingPaths = new Set<string>();
  for (const value of manifest.pending as unknown[]) {
    const file = object(value);
    const match = /^\.tasks\/pending\/(T-[0-9]{4,})\.start\.sqlite$/.exec(String(file.path));
    if (!match || !ids.has(match[1]) || pendingPaths.has(String(file.path))) fail("Invalid pending selection.");
    pendingPaths.add(String(file.path));
    files.push(check(file, String(file.path)));
  }
  for (const id of ids) {
    const path = ".tasks/pending/" + id + ".start.sqlite";
    if (exists(join(store.location.root, path)) !== pendingPaths.has(path)) fail("Incomplete pending manifest: " + id);
  }
  // Include archived cards and unknown fields. A conservative textual reference
  // check also catches links in prose, without assuming a fixed dependency schema.
  for (const id of [...Object.keys(store.index.tasks), ...Object.keys(store.index.archive)]) {
    if (ids.has(id)) continue;
    const serialized = JSON.stringify(readTask(store, id));
    if ([...ids].some(selected => new RegExp(selected + "(?![0-9])").test(serialized))) fail("Another card references a selected task.");
  }
  const before = readBinary(join(store.location.directory, "board.json"));
  const index = object(readJson(join(store.location.directory, "board.json")));
  const tasks = object(index.tasks);
  for (const id of ids) delete tasks[id];
  const after = JSON.stringify(index, null, 2) + "\n";
  const result = { project: store.location.root, dryRun: input.apply !== true, cards: [...ids], pending: [...pendingPaths],
    beforeIndexSha256: sha256(before), afterIndexSha256: sha256(Buffer.from(after)), nextId: store.index.nextId,
    preservedManagerHistory: true };
  if (input.apply === true) {
    writeJson(join(store.location.directory, "test-recovery.json"), { root: store.location.root,
      before: result.beforeIndexSha256, after: result.afterIndexSha256,
      files: files.map(file => ({ path: file.path.slice(".tasks/".length), sha256: file.sha256 })) });
    writeAtomic(join(store.location.directory, "board.json"), after);
    finishTestRecovery(store.location, true);
  }
  return result;
}
