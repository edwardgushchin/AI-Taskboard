import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";
import type { BoardActivity } from "./codex-chat.ts";
import { locateBoard, onBoard, withRuntimeLock } from "../cli/storage.ts";
import { readTask } from "../cli/archive.ts";
import { statusNotice } from "../cli/task-messages.ts";

// Run under the board lock, shared by all windows and CLI writers. Persist the
// delivery batch before writing chat files so an interrupted replay is idempotent.
export function syncTaskStatusNotices(project: string, language: string | boolean = true) {
  return onBoard(locateBoard(project), store => {
    const path = join(project, ".tasks", "manager-status-position.json");
    type Notice = { id: string; at: number; eventAt?: string; text: string };
    type Position = { through: Record<string, number>; pending: Notice[]; lastAt: number };
    const saved = exists(path) ? readJson(path) as Position : undefined;
    const position: Position = saved ?? { through: {}, pending: [], lastAt: 0 };
    let changed = false;
    const deliver = () => {
      for (const notice of position.pending) {
        changed = saveManagerHistory(project, notice.at, notice.id, { lane: "notice", items: [{
          id: notice.id, at: notice.eventAt ?? new Date(notice.at).toISOString(), type: "agentMessage", title: "", phase: "final_answer",
          status: "completed", text: notice.text,
        }] }) || changed;
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
          if (text) events.push({ task: id, sequence: i + 1, at: event.at, text });
        }
      }
      position.through[id] = store.index.archive[id] ? -1 : task.history.length;
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.task.localeCompare(b.task) || a.sequence - b.sequence);
    for (const event of events) {
      position.lastAt = Math.max(Date.parse(event.at), position.lastAt + 1);
      position.pending.push({ id: randomUUID(), at: position.lastAt, eventAt: event.at, text: event.text });
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
const cursorPrefix = "local:";
const filePattern = /^\d{13}-[0-9a-f-]{36}\.json$/i;
type ReadPosition = { at: number; file: string; index: number };
type UnreadState = { unread: string[]; through?: ReadPosition };

export const isLocalManagerCursor = (cursor: string | null) => cursor?.startsWith(cursorPrefix) ?? false;

function unreadState(project: string): UnreadState {
  const path = join(project, ".tasks", "manager-unread.json");
  const saved = exists(path) ? readJson(path) : [];
  const state: UnreadState = Array.isArray(saved) ? { unread: saved } : saved as UnreadState;
  if (!state || !Array.isArray(state.unread) || state.unread.some(id => typeof id !== "string") ||
      (state.through && (!Number.isFinite(state.through.at) || !filePattern.test(state.through.file) || !Number.isSafeInteger(state.through.index) || state.through.index < 0))) {
    throw new Error("Invalid manager unread messages.");
  }
  return state;
}

export function managerUnread(project: string): string[] {
  return unreadState(project).unread;
}

function updateManagerUnread(project: string, ids: string[], through = unreadState(project).through): boolean {
  const previous = unreadState(project);
  if (ids.length === previous.unread.length && ids.every((id, index) => id === previous.unread[index]) &&
      through?.at === previous.through?.at && through?.file === previous.through?.file && through?.index === previous.through?.index) return false;
  const state = { unread: ids, through };
  writeJson(join(project, ".tasks", "manager-unread.json"), state);
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

function incomingMessages({ lane, items }: Run) {
  if (lane !== "chat" && lane !== "notice") return [];
  return items.filter(item => item.type === "agentMessage" && item.phase === "final_answer" &&
    item.status === "completed" && item.text.trim()).map(item => item.id);
}

export function saveManagerHistory(project: string, startedAt: number, id: string, run: Run) {
  if (!codexThreadPattern.test(id)) throw new Error("Invalid manager history ID.");
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-chat");
  directory(folder, true);
  const path = join(folder, String(startedAt).padStart(13, "0") + "-" + id + ".json");
  const incoming = incomingMessages(run);
  const previous = incoming.length && exists(path) ? new Set(incomingMessages(readJson(path) as Run)) : new Set<string>();
  const file = String(startedAt).padStart(13, "0") + "-" + id + ".json";
  // Write unread first: replay after an interrupted chat write must not lose
  // the unread marker. Existing messages retain their read state on replay.
  const changed = incoming.length > 0 && withRuntimeLock(board, () => {
    const { unread, through } = unreadState(project);
    const added = incoming.filter(messageId => !previous.has(messageId) && (!through ||
      comparePosition(messagePosition(file, run.items.find(item => item.id === messageId)!, run.items.findIndex(item => item.id === messageId)), through) > 0));
    return added.length > 0 && updateManagerUnread(project, [...new Set([...unread, ...added])], through);
  });
  writeJson(path, run);
  return changed;
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
    current = { messages: [{ ...item.userMessage, clientId: item.id }], items: [], ...scope };
  }
  if (current.messages.length || current.items.length) turns.push({ ...current, durationMs });
  return turns;
}

export function managerChatItems(items: BoardActivity[]): BoardActivity[] {
  return items.flatMap(item => {
    if (item.messagesOnly) return [];
    if (item.title === "ai_taskboard / goal_read" || item.title === "ai_taskboard / goal_send") return [{ ...item, text: "" }];
    if (!item.messages?.length) return [item];
    const { messages: _messages, ...activity } = item;
    // The tool result can contain the same conversation as the extracted messages.
    return [{ ...activity, text: "" }];
  });
}

export function managerWorkItems(items: BoardActivity[], lane?: Turn["lane"]) {
  if (lane === "work") return items;
  return items.filter(item => item.messages?.length);
}

const automaticReviewPrefixes = [
  "AI Taskboard: the reviewer approved these submissions. Use task_review",
  "AI Taskboard: ревьюер согласовал следующие сдачи. Открой их через task_review",
  "AI Taskboard automatic review. Follow the board's review mode",
  "Автоматическая проверка AI Taskboard. Проверь сдачи в режиме, выбранном на доске",
];

export function managerHistoryForView(turns: Turn[], view?: "chat" | "work") {
  return turns.flatMap(turn => {
    if (!view) return [turn];
    const first = turn.messages[0];
    const automatic = !turn.lane && turn.messages.length === 1 && first && !first.clientId && !first.files.length &&
      automaticReviewPrefixes.some(prefix => first.text.startsWith(prefix));
    if (view === "chat") {
      return turn.lane === "work" || automatic ? [] : [{ ...turn, items: managerChatItems(turn.items) }];
    }
    const items = managerWorkItems(turn.items, automatic ? "work" : turn.lane);
    const messages = turn.lane === "work" ? turn.messages : [];
    return items.length || messages.length ? [{ ...turn, items, messages }] : [];
  });
}

export function readManagerHistory(project: string, cursor: string | null = null, view?: "chat" | "work", noticesOnly = false) {
  const before = cursor === null ? undefined : cursor.slice(cursorPrefix.length);
  if (before !== undefined && (!isLocalManagerCursor(cursor) || !filePattern.test(before))) {
    throw new Error("Invalid manager history cursor.");
  }
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-chat");
  if (!exists(folder)) return undefined;
  directory(folder);
  const names = readdirSync(folder).filter(name => filePattern.test(name) && (!before || name < before) &&
    (!noticesOnly || (readJson(join(folder, name)) as Run).lane === "notice")).sort().reverse();
  const runs: Run[] = [];
  let remaining = 4 * 1024 * 1024;
  for (const name of names.slice(0, 20)) {
    const path = join(folder, name);
    remaining -= statSync(path).size;
    if (remaining < 0 && runs.length) break;
    runs.push(readJson(path) as Run);
  }
  const model = runs.find(run => run.model)?.model;
  const nextCursor = runs.length < names.length ? cursorPrefix + names[runs.length - 1] : null;
  const turns = managerHistoryForView(runs.reverse().flatMap(displayTurns), view);
  return { model, turns, nextCursor };
}

type GoalMessage = {
  id: string;
  text: string;
  status: "pending" | "applied" | "declined";
  reply?: string;
};

type GoalMessageResult = { id: string; status: "applied" | "declined"; reply: string };
export function goalMessages(project: string, goalId: string): GoalMessage[];
export function goalMessages(project: string, goalId: string, change: { text: string }): GoalMessage;
export function goalMessages(project: string, goalId: string, change: GoalMessageResult): GoalMessage | undefined;
export function goalMessages(project: string, goalId: string, change?: { text: string } | GoalMessageResult) {
  if (!codexThreadPattern.test(goalId)) throw new Error("Invalid goal ID.");
  const board = join(project, ".tasks");
  directory(board);
  const path = join(board, "goal-messages.json");
  const previous = exists(path) ? readJson(path) as { goalId: string; messages: GoalMessage[] } : undefined;
  const messages = previous?.goalId === goalId ? previous.messages : [];
  if (!change) return messages;
  if ("text" in change) {
    const message = { id: randomUUID(), text: change.text, status: "pending" as const };
    writeJson(path, { goalId, messages: [...messages, message] });
    return message;
  }
  const message = messages.find(entry => entry.id === change.id);
  if (!message || message.status !== "pending") return undefined;
  Object.assign(message, { status: change.status, reply: change.reply });
  const completed = new Set(messages.filter(entry => entry.status !== "pending").slice(-20));
  writeJson(path, { goalId, messages: messages.filter(entry => entry.status === "pending" || completed.has(entry)) });
  return message;
}
