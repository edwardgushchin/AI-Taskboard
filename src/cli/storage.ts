import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoverRepository, excludeBoard } from "./git.ts";
import type { Repository } from "./git.ts";
import { registerTags, tagColors, tagKey, TaskboardError, taskIdPattern, taskStates } from "./model.ts";
import type { BoardIndex, Task } from "./model.ts";

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function exists(path: string): boolean {
  return stat(path) !== undefined;
}

export function directory(path: string, create = false): void {
  if (create) {
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!stat(path)?.isDirectory()) {
    throw new TaskboardError("INVALID_STORAGE_PATH", "Expected a real directory at " + path + ".");
  }
}

function requireRegular(path: string): void {
  const entry = stat(path);
  if (entry && !entry.isFile()) {
    throw new TaskboardError("INVALID_STORAGE_PATH", "Expected a regular file at " + path + ".");
  }
}

export function readBinary(path: string): Buffer {
  requireRegular(path);
  return readFileSync(path);
}

export function readJson(path: string): unknown {
  requireRegular(path);
  const data = readFileSync(path, "utf8");
  try {
    return JSON.parse(data);
  } catch {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid JSON in " + path + ".");
  }
}

export function writeAtomic(path: string, contents: string | Uint8Array): void {
  requireRegular(path);
  const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
  const file = openSync(temporary, "wx");
  try {
    try {
      writeFileSync(file, contents);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } finally {
    removeFile(temporary);
  }
}

export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface BoardLocation {
  root: string;
  directory: string;
  repository: Repository | null;
}

export function locateBoard(path: string, initializing = false): BoardLocation {
  const selected = realpathSync(resolve(path));
  if (!statSync(selected).isDirectory()) {
    throw new TaskboardError("INVALID_PROJECT", "Select a project directory.");
  }
  const repository = discoverRepository(selected);
  let root = repository?.root ?? selected;
  if (!repository && !initializing) {
    for (let cursor = selected; ; cursor = dirname(cursor)) {
      const boardDir = join(cursor, ".tasks");
      if (exists(boardDir)) {
        directory(boardDir);
        if (exists(join(boardDir, "board.json"))) {
          root = cursor;
          break;
        }
      }
      if (dirname(cursor) === cursor) break;
    }
  }
  return { root, directory: join(root, ".tasks"), repository };
}

function withLock<T>(location: BoardLocation, callback: () => T): T {
  const lockPath = join(location.directory, ".lock.sqlite");
  requireRegular(lockPath);
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec("PRAGMA busy_timeout=15000");
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) {
        throw new TaskboardError("BOARD_BUSY", "Another command is working on this board. Retry shortly.");
      }
      throw error;
    }
    return callback();
  } finally {
    lock.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTagList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(name => typeof name === "string" && name.trim());
}

function readIndex(path: string): BoardIndex {
  const index = readJson(path);
  if (!isRecord(index) || index.version !== 1 || typeof index.nextId !== "number" ||
      !Number.isSafeInteger(index.nextId) || index.nextId < 1 || !isRecord(index.tasks) ||
      !isRecord(index.archive) || !isRecord(index.settings) ||
      (index.tags !== undefined && (!Array.isArray(index.tags) || index.tags.some(tag =>
        !isRecord(tag) || typeof tag.name !== "string" || !tag.name.trim() || !tagColors.some(color => color === tag.color)) ||
        new Set(index.tags.map(tag => tagKey(tag.name))).size !== index.tags.length)) ||
      !["merge", "squash"].includes(String(index.settings.integrationMode)) ||
      !(index.settings.archiveAfterDays === null ||
        (Number.isSafeInteger(index.settings.archiveAfterDays) && Number(index.settings.archiveAfterDays) >= 0))) {
    throw new TaskboardError("CORRUPT_STORAGE", "Unsupported or invalid board index at " + path + ".");
  }
  for (const [id, entry] of Object.entries(index.tasks)) {
    if (!taskIdPattern.test(id) || entry !== "tasks/" + id + ".json" || Object.hasOwn(index.archive, id)) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid task link in the board index.", { id });
    }
  }
  for (const [id, entry] of Object.entries(index.archive)) {
    if (!taskIdPattern.test(id) || !isRecord(entry) ||
        !["archive/" + id + ".json.gz", "archive/" + id + ".zip"].includes(String(entry.path)) ||
        typeof entry.title !== "string" || !["done", "cancelled"].includes(String(entry.status)) ||
        typeof entry.closedAt !== "string" || typeof entry.archivedAt !== "string" ||
        (entry.tags !== undefined && !isTagList(entry.tags))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid archive link in the board index.", { id });
    }
  }
  return index as unknown as BoardIndex;
}

export function validateCard(value: unknown, id: string): Task {
  if (!isRecord(value) || value.id !== id || typeof value.title !== "string" ||
      !taskStates.includes(value.status as Task["status"]) || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      typeof value.description !== "string" || typeof value.summary !== "string" ||
      typeof value.nextStep !== "string" || !Array.isArray(value.history) ||
      !["criteria", "questions", "subtasks"].every(key => Array.isArray(value[key])) || !isTagList(value.tags) ||
      !Array.isArray(value.attachments) || value.attachments.some(entry => !isRecord(entry) ||
        typeof entry.name !== "string" || typeof entry.file !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 ||
        typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) ||
      new Set(value.attachments.map(entry => entry.file)).size !== value.attachments.length) {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid card for " + id + ".", { id });
  }
  return value as unknown as Task;
}

export class BoardStore {
  location: BoardLocation;
  index: BoardIndex;

  constructor(location: BoardLocation) {
    this.location = location;
    this.index = readIndex(join(location.directory, "board.json"));
  }

  subdirectory(name: "tasks" | "worktrees" | "pending" | "attachments" | "archive", create = false): string {
    const path = join(this.location.directory, name);
    directory(path, create);
    return path;
  }

  card(id: string): Task {
    if (!taskIdPattern.test(id) || !Object.hasOwn(this.index.tasks, id)) {
      throw new TaskboardError("TASK_NOT_FOUND", "Unknown task " + id + ".", { id });
    }
    try {
      return this.readCardFile(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TaskboardError("CORRUPT_STORAGE", "The index points to a missing task file.", { id });
      }
      throw error;
    }
  }

  cardPath(id: string): string {
    if (!taskIdPattern.test(id)) throw new TaskboardError("TASK_NOT_FOUND", "Invalid task ID.");
    return join(this.subdirectory("tasks"), id + ".json");
  }

  private readCardFile(id: string): Task {
    return validateCard(readJson(this.cardPath(id)), id);
  }

  save(task: Task): Task {
    writeJson(join(this.subdirectory("tasks"), task.id + ".json"), task);
    return task;
  }

  saveIndex(): void {
    writeJson(join(this.location.directory, "board.json"), this.index);
  }

  private cardIds(): string[] {
    return readdirSync(this.subdirectory("tasks"))
      .filter(name => name.endsWith(".json") && taskIdPattern.test(name.slice(0, -5)))
      .map(name => name.slice(0, -5));
  }

  allocateId(): string {
    const ids = [...this.cardIds(), ...Object.keys(this.index.tasks), ...Object.keys(this.index.archive)];
    let next = this.index.nextId;
    for (const id of ids) {
      const issued = Number(id.slice(2));
      if (Number.isSafeInteger(issued)) next = Math.max(next, issued + 1);
    }
    if (!Number.isSafeInteger(next + 1)) {
      throw new TaskboardError("ID_EXHAUSTED", "No more task numbers are available.");
    }
    return "T-" + String(next).padStart(4, "0");
  }

  create(task: Task): Task {
    this.save(task);
    this.index.nextId = Number(task.id.slice(2)) + 1;
    this.index.tasks[task.id] = "tasks/" + task.id + ".json";
    this.saveIndex();
    return task;
  }

  snapshot() {
    return {
      project: this.location.root,
      settings: this.index.settings,
      tags: this.index.tags ?? [],
      tasks: Object.keys(this.index.tasks).map(id => this.card(id)),
      archived: Object.entries(this.index.archive).map(([id, entry]) => ({ id, ...entry })),
    };
  }

  doctor(repair: boolean) {
    const issues: { id: string; problem: string }[] = [];
    const recovered: string[] = [];
    for (const id of Object.keys(this.index.tasks)) {
      try {
        this.card(id);
      } catch (error) {
        issues.push({ id, problem: (error as Error).message });
      }
    }
    for (const id of this.cardIds()) {
      if (Object.hasOwn(this.index.tasks, id)) continue;
      if (Object.hasOwn(this.index.archive, id)) {
        issues.push({ id, problem: "An archived card still has an original copy." });
        continue;
      }
      try {
        const task = this.readCardFile(id);
        if (repair) {
          this.index.tasks[id] = "tasks/" + id + ".json";
          if (this.index.tags) registerTags(this.index.tags, task.tags);
          recovered.push(id);
        } else {
          issues.push({ id, problem: "Unindexed task file." });
        }
      } catch (error) {
        issues.push({ id, problem: (error as Error).message });
      }
    }
    if (recovered.length) {
      this.index.nextId = Number(this.allocateId().slice(2));
      this.saveIndex();
    }
    return { issues, recovered };
  }

  pendingPath(id: string): string {
    return join(this.subdirectory("pending"), id + ".json");
  }
}

export function initializeBoard<T>(location: BoardLocation, snapshot: (store: BoardStore) => T): T {
  directory(location.directory, true);
  return withLock(location, () => {
    const path = join(location.directory, "board.json");
    if (!exists(path)) {
      if (location.repository) excludeBoard(location.repository);
      for (const name of ["tasks", "attachments", "archive", "pending", "worktrees"]) {
        directory(join(location.directory, name), true);
      }
      const board: BoardIndex = {
        version: 1, nextId: 1, settings: { archiveAfterDays: 90, integrationMode: "merge" }, tags: [], tasks: {}, archive: {},
      };
      writeJson(path, board);
    }
    return snapshot(new BoardStore(location));
  });
}

export function onBoard<T>(location: BoardLocation, callback: (store: BoardStore) => T): T {
  if (!exists(location.directory)) {
    throw new TaskboardError("BOARD_NOT_FOUND", "Create a board in this project first.");
  }
  directory(location.directory);
  if (!exists(join(location.directory, "board.json"))) {
    throw new TaskboardError("BOARD_NOT_FOUND", "Create a board in this project first.");
  }
  return withLock(location, () => callback(new BoardStore(location)));
}
