import { defaultColumns, validateColumns, isManual } from "./manual-board.ts";
import { isFileLink } from "./attachment-links.ts";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoverRepository, excludeBoard, git } from "./git.ts";
import type { Repository } from "./git.ts";
import { boardAgentRoles, defaultBoardAgents, githubRepositoryPattern, hexTagColor, legacyTagColors, reasoningEffortPattern, registerTags, reviewModes, scheduleTimePattern, tagKey, TaskboardError, taskIdPattern, taskStates, validAgentLimitOverrides, validDueDate, validScheduleDate } from "./model.ts";
import type { BoardIndex, Task } from "./model.ts";
import { parseUsageReport, tokenFields, totalTokenUsage } from "./token-usage.ts";

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

export function taskWorkingDirectory(path: string, pinned = false): string {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
    throw new TaskboardError("INVALID_INPUT", "Choose an absolute path for the task's working directory.");
  }
  try {
    const actual = realpathSync(path);
    if (pinned && actual !== path) throw new Error();
    directory(actual);
    return actual;
  } catch {
    throw new TaskboardError("WORKING_DIRECTORY_UNAVAILABLE", "The task's working directory is unavailable or now points somewhere else.", { path });
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
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 4 ||
            !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        // Windows readers or scanners can briefly prevent atomic replacement.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
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

export function locateBoard(path: string, initializing = false, initializeGit = false, manualInit = false): BoardLocation {
  const selected = realpathSync(resolve(path));
  if (!statSync(selected).isDirectory()) {
    throw new TaskboardError("INVALID_PROJECT", "Select a project directory.");
  }
  if (manualInit) return { root: selected, directory: join(selected, ".tasks"), repository: null };
  // Personal boards do not depend on a Git executable, repository or worktree.
  for (let cursor = selected; ; cursor = dirname(cursor)) {
    const boardPath = join(cursor, ".tasks", "board.json");
    if (exists(boardPath)) {
      const board = readJson(boardPath) as BoardIndex;
      if (board.settings?.boardType === "manual") return { root: cursor, directory: dirname(boardPath), repository: null };
      break;
    }
    if (exists(join(cursor, ".git")) || dirname(cursor) === cursor || initializing) break;
  }
  let repository = discoverRepository(selected);
  if (initializeGit && (!repository || (repository.bare
    ? repository.root !== selected
    : git(selected, ["rev-parse", "--show-prefix"]).trimEnd() !== ""))) {
    git(selected, ["init"]);
    repository = discoverRepository(selected);
  }
  let root = repository?.root ?? selected;
  // A repository discovered above the selected directory is not consent to
  // initialize its board. Actual worktree roots still share the clone's board.
  if (initializing && repository && !exists(join(selected, ".git")) && selected !== repository.root) {
    repository = null;
    root = selected;
  }
  if (!initializing) {
    for (let cursor = selected; ; cursor = dirname(cursor)) {
      const boardDir = join(cursor, ".tasks");
      if (exists(boardDir)) {
        directory(boardDir);
        if (exists(join(boardDir, "board.json"))) {
          root = cursor;
          if (root !== repository?.root) repository = null;
          break;
        }
      }
      if (cursor === repository?.root || exists(join(cursor, ".git")) || dirname(cursor) === cursor) break;
    }
  }
  return { root, directory: join(root, ".tasks"), repository };
}

function withSqliteLock<T>(lockPath: string, timeoutMs: 0 | 15_000, callback: (lockWaitMs: number, release: () => void) => T): T {
  requireRegular(lockPath);
  const lock = new DatabaseSync(lockPath);
  let closed = false;
  const release = () => {
    if (!closed) { lock.close(); closed = true; }
  };
  try {
    lock.exec("PRAGMA busy_timeout=" + timeoutMs);
    const waiting = performance.now();
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if (code === 5 || code === 6) {
        throw new TaskboardError("BOARD_BUSY", "Another command is working on this board. Retry shortly.");
      }
      throw error;
    }
    return callback(Math.round(performance.now() - waiting), release);
  } finally {
    release();
  }
}

export function withLock<T>(directoryPath: string, callback: (lockWaitMs: number) => T, timeoutMs: 0 | 15_000 = 15_000): T {
  return withSqliteLock(join(directoryPath, ".lock.sqlite"), timeoutMs, callback);
}

export function withRuntimeLock<T>(directoryPath: string, callback: () => T): T {
  return withSqliteLock(join(directoryPath, ".runtime.sqlite"), 15_000, callback);
}

function taskStartLockPath(location: BoardLocation, id: string): string {
  if (!taskIdPattern.test(id)) throw new TaskboardError("TASK_NOT_FOUND", "Invalid task ID.");
  const pending = join(location.directory, "pending");
  directory(pending);
  return join(pending, id + ".start.sqlite");
}

export function withTaskStartLock<T>(location: BoardLocation, id: string, callback: (waitMs: number) => T,
  timeoutMs: 0 | 15_000 = 15_000): T {
  requireBoard(location);
  // Recovery holds this stable gate while checking and removing pending files.
  // Release it once the task lock is acquired: different tasks can still start in parallel.
  return withSqliteLock(join(location.directory, ".start-gate.sqlite"), timeoutMs, (gateWaitMs, releaseGate) => {
    const index = readIndex(join(location.directory, "board.json"));
    if (!Object.hasOwn(index.tasks, id) && !Object.hasOwn(index.archive, id)) {
      throw new TaskboardError("TASK_NOT_FOUND", "Unknown task " + id + ".", { id });
    }
    return withSqliteLock(taskStartLockPath(location, id), timeoutMs, lockWaitMs => {
      releaseGate();
      return callback(gateWaitMs + lockWaitMs);
    });
  });
}

export function withTaskRecoveryLock<T>(location: BoardLocation, callback: () => T): T {
  // The caller holds the board lock. Never wait for a gate held by a start
  // that may itself be waiting for this board lock or another task lock.
  return withSqliteLock(join(location.directory, ".start-gate.sqlite"), 0, callback);
}

export function taskStartInProgress(location: BoardLocation, id: string): boolean {
  const path = taskStartLockPath(location, id);
  if (!exists(path)) return false;
  try {
    // The caller holds the board lock. A start holding this lock may need the board lock next.
    return withSqliteLock(path, 0, () => false);
  } catch (error) {
    if (error instanceof TaskboardError && error.code === "BOARD_BUSY") return true;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTagList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(name => typeof name === "string" && name.trim());
}

function validRoleSettings(value: unknown): boolean {
  return value == null || (isRecord(value) && (value.provider === undefined || value.provider === "codex") &&
    typeof value.model === "string" && Boolean(value.model.trim()) &&
    typeof value.effort === "string" && reasoningEffortPattern.test(value.effort));
}

function validTaskSchedule(value: unknown): boolean {
  if (!isRecord(value) || typeof value.nextAt !== "string" || !Number.isFinite(Date.parse(value.nextAt))) return false;
  if (value.paused !== undefined && typeof value.paused !== "boolean") return false;
  if (value.everyMinutes !== undefined) {
    return value.time === undefined && value.weekday === undefined && value.dayOfMonth === undefined && value.month === undefined &&
      Number.isSafeInteger(value.everyMinutes) && Number(value.everyMinutes) >= 1;
  }
  if (typeof value.time !== "string" || !scheduleTimePattern.test(value.time)) return false;
  if (value.dayOfMonth !== undefined || value.month !== undefined) {
    return value.weekday === undefined && validScheduleDate(value.dayOfMonth, value.month);
  }
  return value.weekday === undefined || (Number.isSafeInteger(value.weekday) && Number(value.weekday) >= 0 && Number(value.weekday) <= 6);
}

function readIndex(path: string): BoardIndex {
  const index = readJson(path);
  if (!isRecord(index) || index.version !== 1 || typeof index.nextId !== "number" ||
      !Number.isSafeInteger(index.nextId) || index.nextId < 1 || !isRecord(index.tasks) ||
      !isRecord(index.archive) || !isRecord(index.settings) ||
      (index.tags !== undefined && !Array.isArray(index.tags)) ||
      (index.settings.boardType !== undefined && !["agent", "manual"].includes(String(index.settings.boardType))) ||
      !["merge", "squash"].includes(String(index.settings.integrationMode)) ||
      (index.settings.name !== undefined && typeof index.settings.name !== "string") ||
      (index.settings.showCardPreviews !== undefined && typeof index.settings.showCardPreviews !== "boolean") ||
      (index.settings.autoMode !== undefined && typeof index.settings.autoMode !== "boolean") ||
      (index.settings.autoReview !== undefined && typeof index.settings.autoReview !== "boolean") ||
      (index.settings.reviewMode !== undefined && !reviewModes.some(mode => mode === (index.settings as Record<string, unknown>).reviewMode)) ||
      (index.settings.taskLimits !== undefined && !validAgentLimitOverrides(index.settings.taskLimits)) ||
      !boardAgentRoles.every(role => validRoleSettings((index.settings as Record<string, unknown>)[role])) ||
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
        (entry.updatedAt !== undefined && typeof entry.updatedAt !== "string") ||
        (entry.tags !== undefined && !isTagList(entry.tags))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid archive link in the board index.", { id });
    }
    const edit = entry.tagOverride;
    if (edit !== undefined && (!isRecord(edit) || !isTagList(edit.tags) ||
        !Array.isArray(edit.history) || !edit.history.length || edit.history.some(event =>
          !isRecord(event) || event.action !== "update" || typeof event.at !== "string" ||
          !["agent", "user", "manager"].includes(String(event.actor)) ||
          (event.text !== undefined && typeof event.text !== "string")))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid archived task tag history.", { id });
    }
  }
  if (Array.isArray(index.tags)) {
    const names = new Set<string>();
    index.tags = index.tags.map(tag => {
      if (!isRecord(tag) || typeof tag.name !== "string" || !tag.name.trim() || typeof tag.color !== "string") {
        throw new TaskboardError("CORRUPT_STORAGE", "Invalid tag in the board index.");
      }
      const key = tagKey(tag.name);
      const baseColor = Object.hasOwn(legacyTagColors, tag.color)
        ? legacyTagColors[tag.color as keyof typeof legacyTagColors]
        : tag.color;
      const color = tag.customColor === undefined ? baseColor : tag.customColor;
      if (names.has(key) || !hexTagColor.test(baseColor) || typeof color !== "string" || !hexTagColor.test(color)) {
        throw new TaskboardError("CORRUPT_STORAGE", "Invalid tag in the board index.", { name: tag.name });
      }
      names.add(key);
      return { name: tag.name, color: color.toUpperCase() };
    });
  }
  const { agentLimits: _legacyLimits, requireExpertPlans: _legacyExpertPlans, ...settings } = index.settings;
  const manager = settings.manager;
  if (isRecord(manager) && manager.model === "gpt-6.1-sol" && manager.effort === "medium") {
    settings.manager = defaultBoardAgents.manager;
  }
  return { ...index, settings: { ...defaultBoardAgents, ...settings } } as unknown as BoardIndex;
}

export function validateCard(value: unknown, id: string): Task {
  if (!isRecord(value) || value.id !== id || typeof value.title !== "string" ||
      !(taskStates.includes(value.status as typeof taskStates[number]) || typeof value.status === "string" && /^manual:[a-zA-Z0-9-]+$/.test(value.status)) || !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
      typeof value.description !== "string" || typeof value.summary !== "string" ||
      typeof value.nextStep !== "string" || !Array.isArray(value.history) ||
      (value.milestone !== undefined && (!isRecord(value.milestone) ||
        typeof value.milestone.repository !== "string" || !githubRepositoryPattern.test(value.milestone.repository) ||
        !Number.isSafeInteger(value.milestone.number) || Number(value.milestone.number) < 1 ||
        typeof value.milestone.title !== "string" || !value.milestone.title.trim())) ||
      (value.dependencies !== undefined && (!Array.isArray(value.dependencies) ||
        value.dependencies.some(entry => typeof entry !== "string" || !taskIdPattern.test(entry)))) ||
      (value.reviewModeOverride !== undefined && (!isRecord(value.reviewModeOverride) ||
        !reviewModes.some(mode => mode === (value.reviewModeOverride as Record<string, unknown>).mode) ||
        !Number.isSafeInteger(value.reviewModeOverride.version) || Number(value.reviewModeOverride.version) < 1)) ||
      (value.dueDate !== undefined && !validDueDate(value.dueDate)) ||
      (value.schedule !== undefined && !validTaskSchedule(value.schedule)) ||
      (value.toolGrants !== undefined && (!Array.isArray(value.toolGrants) || value.toolGrants.length > 256 ||
        value.toolGrants.some(entry => !isRecord(entry) || typeof entry.server !== "string" || !entry.server.trim() ||
          typeof entry.tool !== "string" || !entry.tool.trim() || entry.server === "ai_taskboard" ||
          [entry.server, entry.tool].some(name => name.length > 256 || /[\x00-\x1f\x7f]/.test(name))))) ||
      (value.execution !== undefined && (!isRecord(value.execution) ||
        typeof value.execution.model !== "string" || !value.execution.model.trim() ||
        (value.execution.effort !== undefined &&
          (typeof value.execution.effort !== "string" || !reasoningEffortPattern.test(value.execution.effort))))) ||
      !["criteria", "questions", "subtasks"].every(key => Array.isArray(value[key])) || !isTagList(value.tags) ||
      !Array.isArray(value.attachments) || value.attachments.some(entry => !isRecord(entry) ||
        typeof entry.name !== "string" || typeof entry.file !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 ||
        (entry.link === undefined ? typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) :
          !isFileLink(entry.link) || entry.link.size !== entry.bytes || entry.sha256 !== "")) ||
      new Set(value.attachments.map(entry => entry.file)).size !== value.attachments.length) {
    throw new TaskboardError("CORRUPT_STORAGE", "Invalid card for " + id + ".", { id });
  }
  const task = value as unknown as Task;
  if (task.tokenUsage !== undefined) {
    try {
      const usage = task.tokenUsage;
      if (!isRecord(usage) || !Array.isArray(usage.reports) || !Array.isArray(usage.byModel)) throw new Error();
      const reports = usage.reports.map(parseUsageReport);
      const totals = totalTokenUsage(reports.flatMap(report => report.records));
      if (new Set(reports.map(report => report.id)).size !== reports.length ||
          usage.byModel.length !== totals.length || usage.byModel.some((entry, index) =>
            !isRecord(entry) || (["model", "incomplete", ...tokenFields] as const).some(key => entry[key] !== totals[index][key]))) throw new Error();
    } catch {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid token usage for " + id + ".", { id });
    }
  }
  const files = new Set(task.attachments.map(file => file.file));
  for (const event of task.history) {
    if (event?.attachment !== undefined && (event.action !== "attach" || !files.has(event.attachment))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid attachment event for " + id + ".", { id });
    }
    if (event?.durationMs !== undefined && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid reply duration for " + id + ".", { id });
    }
    const start = event?.startTiming;
    if (start !== undefined && (event.action !== "start" || !isRecord(start) ||
        ![start.lockWaitMs, start.prepareMs, start.gitWorktreeAddMs === undefined ? 0 : start.gitWorktreeAddMs]
          .every(value => Number.isSafeInteger(value) && Number(value) >= 0))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid start timing for " + id + ".", { id });
    }
    if (event?.run !== undefined && ((event.action !== "run-log" && (event.action !== "chat" || event.actor !== "agent")) || !Array.isArray(event.run) ||
        event.run.some(item => !isRecord(item) ||
          !["id", "type", "title", "text", "status"].every(key => typeof item[key] === "string") ||
          (item.phase !== undefined && !["commentary", "final_answer"].includes(String(item.phase)))))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid run log for " + id + ".", { id });
    }
    const chat = event?.chat;
    if (chat === undefined) continue;
    if (!isRecord(chat) || event.action !== "chat" || !["agent", "user"].includes(event.actor) ||
        typeof chat.model !== "string" || typeof chat.effort !== "string" ||
        (chat.files !== undefined && (!Array.isArray(chat.files) || chat.files.some(file => !files.has(file)))) ||
        (chat.commentary !== undefined && (event.actor !== "agent" || !Array.isArray(chat.commentary) ||
          chat.commentary.some(item => typeof item !== "string" || !item.trim()))) ||
        (chat.usage !== undefined && (!isRecord(chat.usage) || !Number.isSafeInteger(chat.usage.used) ||
          Number(chat.usage.used) < 0 || !Number.isSafeInteger(chat.usage.limit) || Number(chat.usage.limit) < 1))) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid chat message for " + id + ".", { id });
    }
  }
  return task;
}

function migrateImplicitWorkflow(task: Task): boolean {
  let changed = false;
  for (const plan of [task.expertTeam?.work, task.expertTeam?.review]) {
    if (!plan) continue;
    for (const scope of [plan, ...(plan.stages ?? [])]) {
      if (!Array.isArray(scope.skills) || !scope.skills.includes("workflow") || Object.hasOwn(scope.skillChecks ?? {}, "workflow")) continue;
      scope.skills = scope.skills.filter(id => id !== "workflow");
      changed = true;
    }
  }
  return changed;
}

const lockedStores = new WeakSet<BoardStore>();

export class BoardStore {
  location: BoardLocation;
  index: BoardIndex;

  constructor(location: BoardLocation) {
    this.location = location;
    this.index = readIndex(join(location.directory, "board.json"));
    if (isManual(this.index.settings)) { validateColumns(this.index.settings.manualColumns); this.index.settings.autoMode = false; }
  }

  subdirectory(name: "tasks" | "pending" | "attachments" | "archive", create = false): string {
    const path = join(this.location.directory, name);
    directory(path, create);
    return path;
  }

  card(id: string): Task {
    if (!taskIdPattern.test(id) || !Object.hasOwn(this.index.tasks, id)) {
      throw new TaskboardError("TASK_NOT_FOUND", "Unknown task " + id + ".", { id });
    }
    try {
      const task = this.readCardFile(id);
      // This storage upgrade leaves the plan epoch and card revision intact.
      if (lockedStores.has(this) && migrateImplicitWorkflow(task)) this.save(task);
      return task;
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

  storedCards(): Task[] {
    return this.cardIds().map(id => this.readCardFile(id));
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
      archived: this.archivedCards(),
    };
  }

  archivedCards() {
    return Object.entries(this.index.archive).map(([id, { tagOverride, ...entry }]) =>
      ({ id, ...entry, tags: tagOverride?.tags ?? entry.tags,
        updatedAt: tagOverride?.history.at(-1)?.at ?? entry.updatedAt }));
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

export function initializeBoard<T>(location: BoardLocation, snapshot: (store: BoardStore) => T, boardType: unknown = "agent"): T {
  if (boardType !== "agent" && boardType !== "manual") throw new TaskboardError("INVALID_INPUT", "Unknown board type.");
  directory(location.directory, true);
  return withLock(location.directory, () => {
    const path = join(location.directory, "board.json");
    if (location.repository) excludeBoard(location.repository);
    if (!exists(path)) {
      for (const name of ["tasks", "attachments", "archive", "pending"]) {
        directory(join(location.directory, name), true);
      }
      const board: BoardIndex = {
        version: 1, nextId: 1,
        settings: { boardType, ...(boardType === "manual" ? { manualColumns: defaultColumns(), autoMode: false } : {}), archiveAfterDays: 90, integrationMode: "merge", reviewMode: "reviewer", ...defaultBoardAgents },
        tags: [], tasks: {}, archive: {},
      };
      writeJson(path, board);
    }
    const store = new BoardStore(location);
    if ((store.index.settings.boardType ?? "agent") !== boardType) throw new TaskboardError("IMMUTABLE_BOARD_TYPE", "Тип существующей доски нельзя изменить.");
    return snapshot(store);
  });
}

function requireBoard(location: BoardLocation): void {
  if (!exists(location.directory)) {
    throw new TaskboardError("BOARD_NOT_FOUND", "Create a board in this project first.");
  }
  directory(location.directory);
  if (!exists(join(location.directory, "board.json"))) {
    throw new TaskboardError("BOARD_NOT_FOUND", "Create a board in this project first.");
  }
}

export function readBoardSettings(location: BoardLocation): BoardIndex["settings"] {
  requireBoard(location);
  return new BoardStore(location).index.settings;
}

export function onBoard<T>(location: BoardLocation, callback: (store: BoardStore, lockWaitMs: number) => T, timeoutMs: 0 | 15_000 = 15_000): T {
  requireBoard(location);
  return withLock(location.directory, lockWaitMs => {
    finishTestRecovery(location);
    const store = new BoardStore(location);
    lockedStores.add(store);
    try {
      return callback(store, lockWaitMs);
    } finally {
      lockedStores.delete(store);
    }
  }, timeoutMs);
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// The index replacement is the commit point. Before it, no originals are removed.
// After it, every board command finishes deletion before doctor can rediscover an orphan.
export function finishTestRecovery(location: BoardLocation, startGateHeld = false): void {
  const journalPath = join(location.directory, "test-recovery.json");
  if (!exists(journalPath)) return;
  if (!startGateHeld) return withTaskRecoveryLock(location, () => finishTestRecovery(location, true));
  const journal = readJson(journalPath) as {
    root: string; before: string; after: string; files: { path: string; sha256: string }[];
  };
  const fail = () => { throw new TaskboardError("RECOVERY_CONFLICT", "Recovery journal requires inspection; no further board changes are allowed."); };
  if (journal.root !== location.root || !Array.isArray(journal.files) ||
      !journal.files.every(file => /^(tasks\/T-[0-9]{4,}\.json|pending\/T-[0-9]{4,}\.start\.sqlite)$/.test(file.path) && /^[a-f0-9]{64}$/.test(file.sha256))) fail();
  const ids = new Set(journal.files.map(file => /T-[0-9]{4,}/.exec(file.path)![0]));
  for (const id of ids) {
    if (taskStartInProgress(location, id)) {
      throw new TaskboardError("BOARD_BUSY", "A selected task start is active; recovery has not changed any files.");
    }
  }
  const current = sha256(readBinary(join(location.directory, "board.json")));
  if (current === journal.before) { removeFile(journalPath); return; }
  if (current !== journal.after) fail();
  for (const file of journal.files) {
    const path = join(location.directory, file.path);
    if (exists(path) && sha256(readBinary(path)) !== file.sha256) fail();
  }
  for (const file of journal.files) removeFile(join(location.directory, file.path));
  removeFile(journalPath);
}
