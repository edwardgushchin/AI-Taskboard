import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexThreadPattern, TaskboardError } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";
import type { BoardActivity, readBoardHistory } from "./codex-chat.ts";
import { onBoard, withRuntimeLock } from "../cli/storage.ts";
import { runtimeLocation } from "./board-runtime.ts";
import { readTask } from "../cli/archive.ts";
import { statusNotice } from "../cli/task-messages.ts";
import { imageViewPath } from "./run-images.ts";

// Run under the board lock, shared by all windows and CLI writers. Persist the
// delivery batch before writing chat files so an interrupted replay is idempotent.
export function syncTaskStatusNotices(project: string, language: string | boolean = true) {
  return onBoard(runtimeLocation(project), store => {
    const path = join(project, ".tasks", "manager-status-position.json");
    type Notice = { id: string; at: number; eventAt?: string; text: string; statusTransition?: BoardActivity["statusTransition"] };
    type Position = { through: Record<string, number>; pending: Notice[]; lastAt: number };
    const saved = exists(path) ? readJson(path) as Position : undefined;
    const position: Position = saved ?? { through: {}, pending: [], lastAt: 0 };
    let changed = false;
    const deliver = () => {
      for (const notice of position.pending) {
        saveManagerHistory(project, notice.at, notice.id, { lane: "notice", items: [{
          id: notice.id, at: notice.eventAt ?? new Date(notice.at).toISOString(), type: "agentMessage", title: "", phase: "final_answer",
          status: "completed", text: notice.text, statusTransition: notice.statusTransition,
        }] });
        changed = true;
      }
      position.pending = [];
    };
    const before = JSON.stringify(position);
    deliver();
    const events = [];
    for (const id of [...Object.keys(store.index.tasks), ...Object.keys(store.index.archive)]) {
      // Archived cards cannot acquire new transitions after their closure.
      if (store.index.archive[id] && position.through[id] === -1) continue;
      const task = readTask(store, id);
      if (saved) {
        for (let i = position.through[id] ?? 0; i < task.history.length; i++) {
          const event = task.history[i]!;
          const text = statusNotice(task, event, language);
          if (text && event.to) events.push({ task: id, status: event.to, sequence: i + 1, at: event.at, text });
        }
      }
      position.through[id] = store.index.archive[id] ? -1 : task.history.length;
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.task.localeCompare(b.task) || a.sequence - b.sequence);
    for (const event of events) {
      position.lastAt = Math.max(Date.parse(event.at), position.lastAt + 1);
      position.pending.push({ id: randomUUID(), at: position.lastAt, eventAt: event.at, text: event.text,
        statusTransition: { task: event.task, status: event.status } });
    }
    if (!saved || JSON.stringify(position) !== before) writeJson(path, position);
    if (position.pending.length) {
      deliver();
      writeJson(path, position);
    }
    return changed;
  }, 0);
}

type Message = Omit<NonNullable<BoardActivity["userMessage"]>, "files"> & {
  clientId?: string; at?: string;
  files: { name: string; url?: string; link?: import("../cli/attachment-links.ts").FileLink }[];
};
type ProviderTurn = { threadId: string; clientId: string; turnId?: string };
type Run = {
  message?: Message;
  items: BoardActivity[];
  model?: string;
  durationMs?: number;
  lane?: "chat" | "work" | "notice";
  goalId?: string;
  outcome?: { status: "running" | "completed" | "interrupted"; reason?: string };
  provider?: ProviderTurn;
  recoveryProviders?: ProviderTurn[];
};
type Turn = { messages: Message[]; items: BoardActivity[]; durationMs?: number; lane?: Run["lane"]; goalId?: string;
  outcome?: Run["outcome"]; recovery?: string };
// Status sync writes unscoped notices. Goal notices record exchanges with the owner.
const isStatusNotice = ({ lane, goalId }: Pick<Run, "lane" | "goalId">) => lane === "notice" && !goalId;
const cursorPrefix = "local:";
const filePattern = /^\d{13}-[0-9a-f-]{36}\.json$/i;
type ReadPosition = { at: number; file: string; index: number };
type UnreadState = { unread: string[]; through?: ReadPosition; dialogueOnly?: true };
const lastUnread = new Map<string, string[]>();

export function hasManagerImageView(project: string, path: string): boolean {
  const board = join(project, ".tasks");
  const folder = join(board, "manager-chat");
  directory(board);
  if (!exists(folder)) return false;
  directory(folder);
  return readdirSync(folder).filter(name => filePattern.test(name)).sort().reverse().some(name => {
    try {
      const run = readJson(join(folder, name)) as Run;
      return (run.lane === "chat" || Boolean(run.goalId)) &&
        run.items.some(item => imageViewPath(item) === path);
    } catch {
      return false;
    }
  });
}

export const isLocalManagerCursor = (cursor: string | null) => cursor?.startsWith(cursorPrefix) ?? false;

function readUnreadState(project: string): UnreadState {
  const path = join(project, ".tasks", "manager-unread.json");
  const saved = exists(path) ? readJson(path) : [];
  const state: UnreadState = Array.isArray(saved) ? { unread: saved } : saved as UnreadState;
  if (!state || !Array.isArray(state.unread) || state.unread.some(id => typeof id !== "string") ||
      (state.through && (!Number.isFinite(state.through.at) || !filePattern.test(state.through.file) || !Number.isSafeInteger(state.through.index) || state.through.index < 0))) {
    throw new Error("Invalid manager unread messages.");
  }
  return state;
}

function legacyUnreadFilter(unread: string[]) {
  // Older versions used the same UUID for the notice item and its run file.
  // Preserve pending dialogue delivery and the saved read position.
  const candidates = new Set(unread);
  const statusIds = new Set<string>();
  const dialogueIds = new Set<string>();
  function visit(file: string, run: Run) {
    const id = file.slice(14, -5);
    if (run.lane !== "chat" || run.goalId) {
      if (candidates.has(id)) statusIds.add(id);
      for (const item of run.items) {
        if (candidates.has(item.id)) {
          statusIds.add(item.id);
        }
      }
    } else {
      for (const item of run.items) {
        if (candidates.has(item.id)) dialogueIds.add(item.id);
      }
    }
  }
  return { visit, result: () => unread.filter(id => !statusIds.has(id) || dialogueIds.has(id)) };
}

function unreadState(project: string): UnreadState {
  const state = readUnreadState(project);
  if (state.dialogueOnly !== true && state.unread.length) {
    const folder = join(project, ".tasks", "manager-chat");
    const filter = legacyUnreadFilter(state.unread);
    if (exists(folder)) for (const file of readdirSync(folder)) {
      if (filePattern.test(file)) filter.visit(file, readJson(join(folder, file)) as Run);
    }
    state.unread = filter.result();
  }
  lastUnread.set(project, [...state.unread]);
  return state;
}

// A new snapshot needs only the small unread file. Legacy files are normalized
// separately so building an Electron frame never has to walk the chat history.
export function managerUnreadSnapshot(project: string): string[] | undefined {
  try {
    const state = readUnreadState(project);
    if (state.dialogueOnly !== true && state.unread.length) return undefined;
    lastUnread.set(project, [...state.unread]);
    return state.unread;
  } catch {
    return lastUnread.get(project) ?? [];
  }
}

export async function normalizeManagerUnread(project: string, signal: AbortSignal): Promise<boolean> {
  const state = readUnreadState(project);
  if (state.dialogueOnly === true || !state.unread.length) return true;
  const board = join(project, ".tasks");
  const folder = join(board, "manager-chat");
  const directoryStat = await lstat(folder).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (directoryStat && !directoryStat.isDirectory()) {
    throw new TaskboardError("INVALID_STORAGE_PATH", "Expected a real directory at " + folder + ".");
  }
  const files = directoryStat ? (await readdir(folder)).filter(file => filePattern.test(file)) : [];
  const filter = legacyUnreadFilter(state.unread);
  for (let offset = 0; offset < files.length; offset += 8) {
    signal.throwIfAborted();
    await Promise.all(files.slice(offset, offset + 8).map(async file => {
      const path = join(folder, file);
      if (!(await lstat(path)).isFile()) {
        throw new TaskboardError("INVALID_STORAGE_PATH", "Expected a regular file at " + path + ".");
      }
      const contents = await readFile(path, { encoding: "utf8", signal });
      filter.visit(file, JSON.parse(contents) as Run);
    }));
  }
  signal.throwIfAborted();
  return withRuntimeLock(board, () => {
    const current = readUnreadState(project);
    if (current.dialogueOnly === true || !current.unread.length) return true;
    if (JSON.stringify(current) !== JSON.stringify(state)) return false;
    if (lstatSync(folder, { throwIfNoEntry: false })?.mtimeMs !== directoryStat?.mtimeMs) return false;
    persistManagerUnread(project, filter.result(), state.through);
    return true;
  }, 0);
}

export function managerUnread(project: string): string[] {
  try { return unreadState(project).unread; }
  catch (error) {
    const previous = lastUnread.get(project);
    if (!previous) throw error;
    return [...previous];
  }
}

function persistManagerUnread(project: string, ids: string[], through?: ReadPosition) {
  writeJson(join(project, ".tasks", "manager-unread.json"), { unread: ids, through, dialogueOnly: true });
  lastUnread.set(project, [...ids]);
}

function updateManagerUnread(project: string, previous: UnreadState, ids: string[], through: ReadPosition | undefined): boolean {
  if (ids.length === previous.unread.length && ids.every((id, index) => id === previous.unread[index]) &&
      through?.at === previous.through?.at && through?.file === previous.through?.file && through?.index === previous.through?.index) return false;
  persistManagerUnread(project, ids, through);
  return true;
}

const comparePosition = (a: ReadPosition, b: ReadPosition) =>
  a.at - b.at || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.index - b.index);

function messagePosition(file: string, item: BoardActivity, index: number): ReadPosition {
  const eventAt = item.at ? Date.parse(item.at) : NaN;
  return { at: Number.isFinite(eventAt) ? eventAt : Number(file.slice(0, 13)), file, index };
}

export function readManagerMessages(project: string, ids: string[]) {
  const requested = new Set(ids);
  const positions = new Map<string, ReadPosition>();
  const folder = join(project, ".tasks", "manager-chat");
  if (exists(folder)) for (const file of readdirSync(folder).filter(name => filePattern.test(name)).sort()) {
    const run = readJson(join(folder, file)) as Run;
    for (const [index, item] of run.items.entries()) {
      if (incomingMessages({ ...run, items: [item] }).length) positions.set(item.id, messagePosition(file, item, index));
    }
  }
  return withRuntimeLock(join(project, ".tasks"), () => {
    const state = unreadState(project);
    let through = state.through;
    for (const id of requested) {
      const position = positions.get(id);
      if (position && (!through || comparePosition(position, through) > 0)) through = position;
    }
    return updateManagerUnread(project, state, state.unread.filter(id => {
      const position = positions.get(id);
      return !position || !through || comparePosition(position, through) > 0;
    }), through);
  });
}

function incomingMessages(run: Run) {
  if (run.lane !== "chat" || run.goalId) return [];
  return run.items.filter(item => item.type === "agentMessage" && item.phase === "final_answer" &&
    item.status === "completed" && item.text.trim()).map(item => item.id);
}

export function hasManagerMessage(project: string, id: string, created: number) {
  const folder = join(project, ".tasks", "manager-chat");
  if (!exists(folder)) return false;
  directory(folder);
  // Compare only the runs that could have accepted this queued message.
  return readdirSync(folder).some(name => {
    if (!filePattern.test(name)) return false;
    const path = join(folder, name);
    if ((statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0) < created - 1000) return false;
    const run = readJson(path) as Run;
    return run.message?.clientId === id || run.items.some(item => item.id === id && item.userMessage);
  });
}

export function readManagerRecovery(project: string, file: string) {
  if (!filePattern.test(file)) return;
  const folder = join(project, ".tasks", "manager-chat");
  if (!exists(folder)) return;
  directory(folder);
  const path = join(folder, file);
  if (!exists(path)) return;
  const run = readJson(path) as Run;
  const latest = displayTurns(run, file).at(-1);
  if (!latest?.recovery || !run.message || !latest.messages[0]) return;
  return { ...run, originalMessage: run.message, message: latest.messages[0],
    startedAt: Number(file.slice(0, 13)), id: file.slice(14, -5) };
}

export function completedManagerAnswer(items: BoardActivity[]) {
  return items.findLast(item => item.status === "completed" &&
    ((item.type === "agentMessage" && item.phase === "final_answer" && item.text.trim()) || item.generatedImage?.file));
}

export function managerHistoryFile(startedAt: number, id: string) {
  return String(startedAt).padStart(13, "0") + "-" + id + ".json";
}

export function saveManagerHistory(project: string, startedAt: number, id: string, run: Run) {
  if (!codexThreadPattern.test(id)) throw new Error("Invalid manager history ID.");
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-chat");
  const file = managerHistoryFile(startedAt, id);
  return withRuntimeLock(board, () => {
    directory(folder, true);
    const path = join(folder, file);
    const incoming = incomingMessages(run);
    let changed = false;
    if (incoming.length) {
      const previous = exists(path) ? new Set(incomingMessages(readJson(path) as Run)) : new Set<string>();
      // Write unread first so replay can retain the marker after an interrupted write.
      const state = unreadState(project);
      const { unread, through } = state;
      const added = incoming.filter(messageId => {
        if (previous.has(messageId)) return false;
        const index = run.items.findIndex(item => item.id === messageId);
        return !through || comparePosition(messagePosition(file, run.items[index], index), through) > 0;
      });
      changed = added.length > 0 && updateManagerUnread(project, state, [...new Set([...unread, ...added])], through);
    }
    writeJson(path, run);
    return changed;
  });
}

function displayTurns({ message, items, durationMs, lane, goalId, outcome }: Run, file?: string): Turn[] {
  const turns: Turn[] = [];
  const scope = { ...(lane ? { lane } : {}), ...(goalId ? { goalId } : {}) };
  let current: Turn = { messages: message ? [message] : [], items: [], ...scope };
  for (const item of items) {
    if (!item.userMessage) {
      current.items.push(item);
      continue;
    }
    if (current.messages.length || current.items.length) turns.push(current);
    current = { messages: [{ ...item.userMessage, clientId: item.id,
      ...(item.at ? { at: item.userMessage.at ?? item.at } : {}) }], items: [], ...scope };
  }
  if (current.messages.length || current.items.length) {
    if (lane === "chat" && message) {
      const completed = outcome?.status === "completed" || Boolean(completedManagerAnswer(current.items));
      turns.push({ ...current, durationMs, outcome: completed ? { status: "completed" } : outcome,
        recovery: completed ? undefined : file });
    } else {
      turns.push({ ...current, durationMs });
    }
  }
  return turns;
}

const workTools = new Set([
  "manager_ack", "manager_inbox", "task_wait", "task_message", "team_inbox", "team_message",
  "task_approve", "task_start", "task_start_batch", "task_block", "task_unblock",
  "task_submit", "task_request_changes", "task_accept", "task_cancel", "task_return_to_draft",
]);

const isWorkActivity = (item: BoardActivity) =>
  Boolean(item.messagesOnly || item.messages?.length ||
    (item.type === "mcpToolCall" && item.title.startsWith("ai_taskboard / ") && workTools.has(item.title.slice("ai_taskboard / ".length))) ||
    (item.type === "dynamicToolCall" && workTools.has(item.title)));

export function managerChatItems(items: BoardActivity[]): BoardActivity[] {
  const dialogue: BoardActivity[] = [];
  let hasLaterAnswer = false;
  // Codex can restart a final answer under a new item ID without completing the draft.
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (isWorkActivity(item)) continue;
    if (item.userMessage) hasLaterAnswer = false;
    if (item.type === "agentMessage" && item.phase === "final_answer") {
      if (item.status === "completed" && item.text.trim()) hasLaterAnswer = true;
      else if (hasLaterAnswer && item.status === "inProgress") continue;
    }
    dialogue.push(item.title === "ai_taskboard / goal_read" || item.title === "ai_taskboard / goal_send"
      ? { ...item, text: "" } : item);
  }
  return dialogue.reverse();
}

export function managerWorkItems(items: BoardActivity[], lane?: Turn["lane"]) {
  if (lane === "work") return items;
  return items.filter(isWorkActivity);
}

export function managerHistoryForView(turns: Turn[], view?: "chat" | "work") {
  return turns.flatMap(turn => {
    if (!view) return [turn];
    // A shared legacy session has no trustworthy conversation/goal attribution.
    if (!turn.lane && !turn.goalId) {
      return [];
    }
    if (isStatusNotice(turn)) return [];
    if (view === "chat") {
      return turn.lane !== "chat" || turn.goalId ? [] : [{ ...turn, items: managerChatItems(turn.items) }];
    }
    if (!turn.goalId) {
      return [];
    }
    const items = turn.items;
    const messages = turn.messages;
    return items.length || messages.length ? [{ ...turn, items, messages }] : [];
  });
}

export function hasGoalHistory(project: string) {
  const folder = join(project, ".tasks", "manager-chat");
  if (!exists(folder)) {
    return false;
  }
  directory(folder);
  return readdirSync(folder).some(name => {
    if (!filePattern.test(name)) {
      return false;
    }
    const run = readJson(join(folder, name)) as Run;
    return Boolean(run.goalId && (run.message || run.items.length));
  });
}

export function readDialogueReference(project: string) {
  directory(join(project, ".tasks"));
  const folder = join(project, ".tasks", "manager-chat");
  const messages: { id: string; author: "user" | "manager"; at: string; text: string }[] = [];
  let remaining = 16_000;
  if (!exists(folder)) {
    return { referenceOnly: true, messages };
  }
  directory(folder);
  for (const name of readdirSync(folder).filter(name => filePattern.test(name)).sort().reverse()) {
    const run = readJson(join(folder, name)) as Run;
    if (run.lane !== "chat" || run.goalId) {
      continue;
    }
    const at = new Date(Number(name.slice(0, 13))).toISOString();
    const turns = displayTurns(run);
    const entries = turns.flatMap((turn, index) => [
      ...turn.messages.map((message, part) => ({ id: message.clientId ?? name + ":user:" + index + ":" + part,
        author: "user" as const, at: message.at ?? at, text: message.text })),
      ...managerChatItems(turn.items).filter(item => item.type === "agentMessage" && item.status === "completed")
        .map(item => ({ id: item.id, author: "manager" as const, at: item.at ?? at, text: item.text })),
    ]);
    for (const entry of entries.reverse()) {
      if (!entry.text.trim()) {
        continue;
      }
      const text = entry.text.slice(0, Math.min(2000, remaining));
      if (!text) {
        break;
      }
      messages.unshift({ ...entry, text });
      remaining -= text.length;
      if (messages.length === 40 || remaining === 0) {
        break;
      }
    }
    if (messages.length === 40 || remaining === 0) {
      break;
    }
  }
  return { referenceOnly: true, messages };
}

export function goalActivityItems(items: BoardActivity[], fallbackAt?: string): BoardActivity[] {
  const events: BoardActivity[] = [];
  for (const { messages, ...item } of items) {
    const at = item.userMessage?.at ?? item.at ?? fallbackAt;
    if (!item.messagesOnly) {
      events.push(at === undefined ? item : { ...item, at });
    }
    for (const message of messages ?? []) {
      events.push({
        ...item, id: "coordination:" + message.id + "/" + message.sequence,
        at: message.at ?? at, messages: [message], messagesOnly: true,
      });
    }
  }
  return events;
}

const goalCursorPrefix = "goal:";
type GoalKey = [time: number, id: string, file: string, index: number];
type GoalEvent = { key: GoalKey; file: string; turn: Turn; model?: string };
type GoalPosition = { key: GoalKey; size: number };
class GoalPageChanged extends Error {}

function compareGoalKeys(left: GoalKey, right: GoalKey) {
  const [leftTime, leftId, leftFile, leftIndex] = left;
  const [rightTime, rightId, rightFile, rightIndex] = right;
  // Match goalTimeline in chat.js. File and index only distinguish copies of one event.
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1;
  }
  if (leftFile !== rightFile) {
    return leftFile < rightFile ? -1 : 1;
  }
  return leftIndex - rightIndex;
}

function parseGoalCursor(cursor: string | null): GoalKey | undefined {
  if (!cursor) return undefined;
  let value: unknown;
  try {
    value = cursor.startsWith(goalCursorPrefix) ? JSON.parse(cursor.slice(goalCursorPrefix.length)) : null;
  } catch {
    throw new Error("Invalid goal history cursor.");
  }
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("Invalid goal history cursor.");
  }
  const [time, id, file, index] = value;
  if (!Number.isSafeInteger(time) || typeof id !== "string" ||
      typeof file !== "string" || !filePattern.test(file) || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Invalid goal history cursor.");
  }
  return [time, id, file, index];
}

function goalEvents(name: string, run: Run): GoalEvent[] {
  if (!run.goalId) return [];
  const events: GoalEvent[] = [];
  const scope = { lane: run.lane, goalId: run.goalId };
  const append = (turn: Turn, id: string, at: string | undefined, index: number) => {
    const key: GoalKey = [Date.parse(at ?? "") || 0, id, name, index];
    events.push({ key, file: name, turn, model: run.model });
  };
  const startedAt = new Date(Number(name.slice(0, 13))).toISOString();
  if (run.message) {
    const message = { ...run.message, at: run.message.at ?? startedAt, clientId: run.message.clientId ?? name };
    append({ ...scope, messages: [message], items: [] }, message.clientId, message.at, 0);
  }
  const items = goalActivityItems(run.items, startedAt);
  items.forEach((item, index) => {
    const turn: Turn = item.userMessage
      ? { ...scope, messages: [{ ...item.userMessage, clientId: item.id, at: item.at }], items: [] }
      : { ...scope, messages: [], items: [item], ...(index === items.length - 1 ? { durationMs: run.durationMs } : {}) };
    append(turn, item.id, item.at, index + 1);
  });
  return events;
}

function goalPage(folder: string, positions: GoalPosition[], before: GoalKey | undefined) {
  let start = 0;
  let end = positions.length;
  while (before && start < end) {
    const middle = Math.floor((start + end) / 2);
    if (compareGoalKeys(positions[middle]!.key, before) >= 0) start = middle + 1;
    else end = middle;
  }
  end = start;
  let remaining = 4 * 1024 * 1024;
  for (; end < positions.length && end - start < 40; end++) {
    const { size } = positions[end]!;
    if (end > start && size > remaining) break;
    remaining -= size;
  }
  const nextCursor = end < positions.length ? goalCursorPrefix + JSON.stringify(positions[end - 1]!.key) : null;
  const selected: GoalEvent[] = [];
  const byFile = Map.groupBy(positions.slice(start, end).entries(), ([, position]) => position.key[2]);
  for (const [file, page] of byFile) {
    const events = goalEvents(file, readJson(join(folder, file)) as Run);
    const first = events[0]?.key[3] ?? 0;
    for (const [index, { key, size }] of page) {
      const event = events[key[3] - first];
      if (!event || compareGoalKeys(event.key, key) !== 0 || JSON.stringify(event.turn).length !== size) {
        throw new GoalPageChanged("Goal history changed while reading a page.");
      }
      selected[index] = event;
    }
  }
  const turns: Turn[] = [];
  let previousFile: string | undefined;
  // Keep adjacent events from one run together so generated results retain
  // their answer and provider-turn context. Interleaved notices stay in order.
  for (const event of selected.toReversed()) {
    const previous = turns.at(-1);
    if (previous && previousFile === event.file && !event.turn.messages.length) {
      previous.items.push(...event.turn.items);
      if (event.turn.durationMs !== undefined) {
        previous.durationMs = event.turn.durationMs;
      }
    } else {
      turns.push({ ...event.turn, items: [...event.turn.items] });
    }
    previousFile = event.file;
  }
  return { model: selected.find(event => event.model)?.model, turns, nextCursor };
}

export function readManagerHistory(project: string, cursor: string | null = null, view?: "chat" | "work") {
  if (view === "work") {
    directory(join(project, ".tasks"));
    return new GoalHistoryIndex().readLocal(project, cursor, false).local;
  }
  const before = cursor === null ? undefined : cursor.slice(cursorPrefix.length);
  if (before !== undefined && (!isLocalManagerCursor(cursor) || !filePattern.test(before))) {
    throw new Error("Invalid manager history cursor.");
  }
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-chat");
  if (!exists(folder)) return undefined;
  directory(folder);
  const names = readdirSync(folder).filter(name => filePattern.test(name) && (!before || name < before)).sort().reverse();
  const pages: Turn[][] = [];
  let model: string | undefined;
  let consumed = 0;
  let conversations = 0;
  let remaining = 4 * 1024 * 1024;
  for (const name of names) {
    if (pages.length >= 20 && (view !== "chat" || conversations >= 2)) break;
    const path = join(folder, name);
    const size = statSync(path).size;
    const exceedsBudget = size > remaining && pages.length > 0;
    const needsConversation = view === "chat" && conversations === 0;
    const run = readJson(path) as Run;
    if (view && (isStatusNotice(run) || (!run.lane && !run.goalId))) {
      consumed++;
      continue;
    }
    const turns = managerHistoryForView(displayTurns(run, name), view);
    if (view !== "chat" || turns.some(turn => turn.messages.length || turn.items.length)) {
      // An inline image can exceed the page budget after Base64 encoding.
      // Keep the first conversation together even if goal notices started the page.
      if (exceedsBudget && (view !== "chat" || !needsConversation || run.lane === "notice")) break;
      remaining -= size;
      pages.push(turns);
      model ??= run.model;
      if (run.lane !== "notice") conversations++;
    }
    consumed++;
  }
  const nextCursor = consumed < names.length ? cursorPrefix + names[consumed - 1] : null;
  return { model, turns: pages.reverse().flat(), nextCursor };
}

type LegacyHistoryReader = (cursor: string | null) => ReturnType<typeof readBoardHistory>;
const providerCursorPrefix = "provider:";

type GoalRun = {
  stamp: string;
  positions: GoalPosition[];
  available: boolean;
  coversProvider: boolean;
};
type GoalSnapshot = { runs: Map<string, GoalRun>; positions: GoalPosition[]; available: boolean; cutoff: number };

// Cache event locations and page sizes. Read message and tool payloads only for
// the requested page. File metadata is checked on every request for external writes.
export class GoalHistoryIndex {
  private snapshots = new Map<string, GoalSnapshot>();

  read(project: string, cursor: string | null, hasProvider: boolean) {
    if (cursor?.startsWith(providerCursorPrefix)) {
      // Provider pages need the cutoff before the remote read. Availability is
      // checked separately afterwards, as in the original history route.
      return {
        local: undefined,
        providerCutoff: hasProvider ? managerProviderCutoff(project, "work") : undefined,
        goalLogAvailable: undefined,
      };
    }
    return this.readLocal(project, cursor, hasProvider);
  }

  readLocal(project: string, cursor: string | null, hasProvider: boolean) {
    const before = parseGoalCursor(cursor);
    try {
      return this.readPage(project, before, hasProvider);
    } catch (error) {
      if (!(error instanceof GoalPageChanged) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.readPage(project, before, hasProvider);
    }
  }

  private readPage(project: string, before: GoalKey | undefined, hasProvider: boolean) {
    const board = join(project, ".tasks");
    const folder = join(board, "manager-chat");
    directory(board);
    const present = exists(folder);
    if (present) directory(folder);
    const previous = this.snapshots.get(project);
    const runs = new Map<string, GoalRun>();
    let changed = !previous;
    for (const name of present ? readdirSync(folder) : []) {
      if (!filePattern.test(name)) continue;
      const path = join(folder, name);
      const info = lstatSync(path, { bigint: true });
      const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
      let entry = previous?.runs.get(name);
      if (!info.isFile() || entry?.stamp !== stamp) {
        const run = readJson(path) as Run;
        entry = {
          stamp,
          positions: goalEvents(name, run).map(({ key, turn }) => ({ key, size: JSON.stringify(turn).length })),
          available: Boolean(run.goalId && (run.message || run.items.length)),
          coversProvider: run.lane !== "notice" && Boolean(run.message || run.items?.length),
        };
        changed = true;
      }
      runs.set(name, entry);
    }

    let snapshot = previous;
    if (!snapshot || changed || runs.size !== snapshot.runs.size) {
      const entries = [...runs.values()];
      const positions = entries.flatMap(run => run.positions);
      positions.sort((left, right) => compareGoalKeys(right.key, left.key));
      let cutoff = Infinity;
      for (const [name, run] of runs) {
        if (run.coversProvider) cutoff = Math.min(cutoff, Number(name.slice(0, 13)));
      }
      snapshot = { runs, positions, available: entries.some(run => run.available), cutoff };
    }
    this.snapshots.delete(project);
    this.snapshots.set(project, snapshot);
    if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);

    const local = present ? goalPage(folder, snapshot.positions, before) : undefined;
    const goalLogAvailable = snapshot.available;
    if (local && (local.turns.length || local.nextCursor || !hasProvider)) {
      return {
        local: { ...local, nextCursor: local.nextCursor ?? (hasProvider ? providerCursorPrefix : null) },
        goalLogAvailable,
      };
    }
    return { goalLogAvailable, providerCutoff: hasProvider ? snapshot.cutoff : undefined };
  }
}

export async function readManagerDialogue(project: string, cursor: string | null, readLegacy?: LegacyHistoryReader) {
  return readManagerView(project, cursor, "chat", readLegacy);
}

export async function readManagerView(project: string, cursor: string | null, view: "chat" | "work", readLegacy?: LegacyHistoryReader) {
  if (!cursor?.startsWith(providerCursorPrefix)) {
    const local = readManagerHistory(project, cursor, view);
    if (local?.turns.length || local?.nextCursor || !readLegacy) {
      return local && { ...local, nextCursor: local.nextCursor ?? (readLegacy ? providerCursorPrefix : null) };
    }
  }
  if (!readLegacy) return;
  return readManagerProviderHistory(cursor, view, managerProviderCutoff(project, view), readLegacy);
}

function managerProviderCutoff(project: string, view: "chat" | "work") {
  // Resumed threads can still have an old binding even though later runs are
  // journaled locally. Only the provider's history before that journal is needed.
  const folder = join(project, ".tasks", "manager-chat");
  const firstRun = exists(folder) ? readdirSync(folder).filter(name => filePattern.test(name)).sort()
    .find(name => {
      const run = readJson(join(folder, name)) as Run;
      if (run.lane === "notice") return false;
      if (view === "work") return Boolean(run.message || run.items.length);
      return managerHistoryForView(displayTurns(run), "chat").some(turn => turn.messages.length);
    }) : undefined;
  return firstRun ? Number(firstRun.slice(0, 13)) : Infinity;
}

export async function readManagerProviderHistory(
  cursor: string | null, view: "chat" | "work", cutoff: number, readLegacy: LegacyHistoryReader,
) {
  const beforeLocal = ({ at }: { at?: string }) => !at || Date.parse(at) < cutoff;
  let next = cursor?.startsWith(providerCursorPrefix) ? cursor.slice(providerCursorPrefix.length) || null : null;
  const visited = new Set<string | null>();
  do {
    visited.add(next);
    const legacy = await readLegacy(next);
    if (!legacy) return;
    const turns = managerHistoryForView(legacy.turns, view).map(turn => ({
      ...turn, messages: turn.messages.filter(beforeLocal),
      items: (view === "work" ? goalActivityItems(turn.items) : turn.items).filter(beforeLocal),
    })).filter(turn => turn.messages.length || turn.items.length);
    next = legacy.nextCursor;
    if (turns.length || !next || visited.has(next)) {
      return { ...legacy, turns, nextCursor: next && !visited.has(next) ? providerCursorPrefix + next : null };
    }
  } while (next);
}

export type GoalMessage = {
  id: string;
  at?: string;
  text: string;
  status: "pending" | "applied" | "declined";
  reply?: string;
};

type GoalMessageResult = { id: string; status: "applied" | "declined"; reply: string };
export function goalMessages(project: string, goalId: string): GoalMessage[];
export function goalMessages(project: string, goalId: string, change: { text: string; id?: string }): GoalMessage;
export function goalMessages(project: string, goalId: string, change: GoalMessageResult): GoalMessage | undefined;
export function goalMessages(project: string, goalId: string, change?: { text: string; id?: string } | GoalMessageResult) {
  if (!codexThreadPattern.test(goalId)) throw new Error("Invalid goal ID.");
  const board = join(project, ".tasks");
  directory(board);
  const lock = join(board, "goal-inbox");
  directory(lock, true);
  return withRuntimeLock(lock, () => {
    const path = join(board, "goal-messages.json");
    const previous = exists(path) ? readJson(path) as { goalId: string; messages: GoalMessage[] } : undefined;
    const messages = previous?.goalId === goalId ? previous.messages : [];
    if (!change) {
      return messages;
    }
    if ("text" in change) {
      if (change.id && !codexThreadPattern.test(change.id)) {
        throw new Error("Invalid goal message ID.");
      }
      const existing = change.id && messages.find(message => message.id === change.id);
      if (existing) {
        if (existing.text !== change.text) {
          throw new Error("Goal message ID already has different text.");
        }
        return existing;
      }
      const message = { id: change.id ?? randomUUID(), at: new Date().toISOString(), text: change.text, status: "pending" as const };
      writeJson(path, { goalId, messages: [...messages, message] });
      return message;
    }
    const message = messages.find(entry => entry.id === change.id);
    if (!message) {
      return undefined;
    }
    if (message.status !== "pending") {
      return message.status === change.status && message.reply === change.reply ? message : undefined;
    }
    Object.assign(message, { status: change.status, reply: change.reply });
    // Closed IDs survive compaction and retries for the lifetime of this goal.
    writeJson(path, { goalId, messages });
    return message;
  });
}

export function sendGoalMessage(project: string, goalId: string, text: string, id?: string) {
  const message = goalMessages(project, goalId, { text, ...(id ? { id } : {}) });
  if (message.at) {
    saveManagerHistory(project, Date.parse(message.at), message.id, {
      lane: "notice", goalId, message: { text: message.text, clientId: message.id, at: message.at, files: [] }, items: [],
    });
  }
  return message;
}
