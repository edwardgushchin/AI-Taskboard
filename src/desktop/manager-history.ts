import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern } from "../cli/model.ts";
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

type Message = NonNullable<BoardActivity["userMessage"]> & { clientId?: string; at?: string };
type Run = {
  message?: Message;
  items: BoardActivity[];
  model?: string;
  durationMs?: number;
  lane?: "chat" | "work" | "notice";
  goalId?: string;
};
type Turn = { messages: Message[]; items: BoardActivity[]; durationMs?: number; lane?: Run["lane"]; goalId?: string };
// Status sync writes unscoped notices. Goal notices record exchanges with the owner.
const isStatusNotice = ({ lane, goalId }: Pick<Run, "lane" | "goalId">) => lane === "notice" && !goalId;
const cursorPrefix = "local:";
const filePattern = /^\d{13}-[0-9a-f-]{36}\.json$/i;
type ReadPosition = { at: number; file: string; index: number };
type UnreadState = { unread: string[]; through?: ReadPosition };
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

function unreadState(project: string): UnreadState {
  const path = join(project, ".tasks", "manager-unread.json");
  const saved = exists(path) ? readJson(path) : [];
  const state: UnreadState = Array.isArray(saved) ? { unread: saved } : saved as UnreadState;
  if (!state || !Array.isArray(state.unread) || state.unread.some(id => typeof id !== "string") ||
      (state.through && (!Number.isFinite(state.through.at) || !filePattern.test(state.through.file) || !Number.isSafeInteger(state.through.index) || state.through.index < 0))) {
    throw new Error("Invalid manager unread messages.");
  }
  const folder = join(project, ".tasks", "manager-chat");
  // Older versions used the same UUID for the notice item and its run file.
  // Preserve pending dialogue delivery and the saved read position.
  const candidates = new Set(state.unread);
  const statusIds = new Set<string>();
  const dialogueIds = new Set<string>();
  if (candidates.size && exists(folder)) for (const file of readdirSync(folder)) {
    if (!filePattern.test(file)) continue;
    const id = file.slice(14, -5);
    const run = readJson(join(folder, file)) as Run;
    if (run.lane !== "chat" || run.goalId) {
      if (candidates.has(id)) statusIds.add(id);
      for (const item of run.items) {
        if (candidates.has(item.id)) {
          statusIds.add(item.id);
        }
      }
    } else {
      for (const item of run.items) {
        dialogueIds.add(item.id);
      }
    }
  }
  state.unread = state.unread.filter(id => !statusIds.has(id) || dialogueIds.has(id));
  lastUnread.set(project, [...state.unread]);
  return state;
}

export function managerUnread(project: string): string[] {
  try { return unreadState(project).unread; }
  catch (error) {
    const previous = lastUnread.get(project);
    if (!previous) throw error;
    return [...previous];
  }
}

function updateManagerUnread(project: string, ids: string[], through = unreadState(project).through): boolean {
  const previous = unreadState(project);
  if (ids.length === previous.unread.length && ids.every((id, index) => id === previous.unread[index]) &&
      through?.at === previous.through?.at && through?.file === previous.through?.file && through?.index === previous.through?.index) return false;
  const state = { unread: ids, through };
  writeJson(join(project, ".tasks", "manager-unread.json"), state);
  lastUnread.set(project, [...ids]);
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
    return updateManagerUnread(project, state.unread.filter(id => {
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

export function saveManagerHistory(project: string, startedAt: number, id: string, run: Run) {
  if (!codexThreadPattern.test(id)) throw new Error("Invalid manager history ID.");
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-chat");
  const file = String(startedAt).padStart(13, "0") + "-" + id + ".json";
  return withRuntimeLock(board, () => {
    directory(folder, true);
    const path = join(folder, file);
    const incoming = incomingMessages(run);
    let changed = false;
    if (incoming.length) {
      const previous = exists(path) ? new Set(incomingMessages(readJson(path) as Run)) : new Set<string>();
      // Write unread first so replay can retain the marker after an interrupted write.
      const { unread, through } = unreadState(project);
      const added = incoming.filter(messageId => {
        if (previous.has(messageId)) return false;
        const index = run.items.findIndex(item => item.id === messageId);
        return !through || comparePosition(messagePosition(file, run.items[index], index), through) > 0;
      });
      changed = added.length > 0 && updateManagerUnread(project, [...new Set([...unread, ...added])], through);
    }
    writeJson(path, run);
    return changed;
  });
}

function displayTurns({ message, items, durationMs, lane, goalId }: Run): Turn[] {
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
  if (current.messages.length || current.items.length) turns.push({ ...current, durationMs });
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

function readGoalHistory(project: string, cursor: string | null) {
  const before = parseGoalCursor(cursor);
  const folder = join(project, ".tasks", "manager-chat");
  if (!exists(folder)) {
    return undefined;
  }
  directory(folder);
  const events: GoalEvent[] = [];
  for (const name of readdirSync(folder).filter(name => filePattern.test(name))) {
    const run = readJson(join(folder, name)) as Run;
    for (const event of goalEvents(name, run)) {
      events.push(event);
    }
  }
  events.sort((left, right) => compareGoalKeys(right.key, left.key));
  return goalPage(events, before);
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

function goalPage(events: GoalEvent[], before: GoalKey | undefined) {
  let start = 0;
  let end = events.length;
  while (before && start < end) {
    const middle = Math.floor((start + end) / 2);
    if (compareGoalKeys(events[middle]!.key, before) >= 0) start = middle + 1;
    else end = middle;
  }
  const selected: GoalEvent[] = [];
  let remaining = 4 * 1024 * 1024;
  for (let index = start; index < events.length && selected.length < 40; index++) {
    const event = events[index]!;
    const size = JSON.stringify(event.turn).length;
    if (selected.length && size > remaining) {
      break;
    }
    selected.push(event);
    remaining -= size;
  }
  const nextCursor = start + selected.length < events.length
    ? goalCursorPrefix + JSON.stringify(selected.at(-1)!.key) : null;
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
    return readGoalHistory(project, cursor);
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
    const turns = managerHistoryForView(displayTurns(run), view);
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
  events: GoalEvent[];
  available: boolean;
  coversProvider: boolean;
};
type GoalSnapshot = { runs: Map<string, GoalRun>; events: GoalEvent[]; available: boolean; cutoff: number };

// Confined to the history worker. Ordinary dialogue payloads are released after
// classification. Metadata is checked on every request to notice external writes.
export class GoalHistoryIndex {
  private snapshots = new Map<string, GoalSnapshot>();

  read(project: string, cursor: string | null, hasProvider: boolean) {
    const providerPage = cursor?.startsWith(providerCursorPrefix);
    const before = providerPage ? undefined : parseGoalCursor(cursor);
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
          events: goalEvents(name, run),
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
      const events = entries.flatMap(run => run.events);
      events.sort((left, right) => compareGoalKeys(right.key, left.key));
      let cutoff = Infinity;
      for (const [name, run] of runs) {
        if (run.coversProvider) cutoff = Math.min(cutoff, Number(name.slice(0, 13)));
      }
      snapshot = { runs, events, available: entries.some(run => run.available), cutoff };
    }
    this.snapshots.delete(project);
    this.snapshots.set(project, snapshot);
    if (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);

    const local = present && !providerPage ? goalPage(snapshot.events, before) : undefined;
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
  const cutoff = firstRun ? Number(firstRun.slice(0, 13)) : Infinity;
  return readManagerProviderHistory(cursor, view, cutoff, readLegacy);
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
