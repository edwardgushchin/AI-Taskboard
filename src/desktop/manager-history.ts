import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";
import type { BoardActivity } from "./codex-chat.ts";
import { locateBoard, onBoard } from "../cli/storage.ts";
import { readTask } from "../cli/archive.ts";
import { statusNotice } from "../cli/task-messages.ts";

// Run under the board lock, shared by all windows and CLI writers. Persist the
// delivery batch before writing chat files so an interrupted replay is idempotent.
export function syncTaskStatusNotices(project: string, russian = true) {
  return onBoard(locateBoard(project), store => {
    const path = join(project, ".tasks", "manager-status-position.json");
    type Notice = { id: string; at: number; text: string };
    type Position = { through: Record<string, number>; pending: Notice[]; lastAt: number };
    const saved = exists(path) ? readJson(path) as Position : undefined;
    const position: Position = saved ?? { through: {}, pending: [], lastAt: 0 };
    let changed = false;
    const deliver = () => {
      for (const notice of position.pending) {
        changed = saveManagerHistory(project, notice.at, notice.id, { lane: "notice", items: [{
          id: notice.id, type: "agentMessage", title: "", phase: "final_answer",
          status: "completed", text: notice.text,
        }] }) || changed;
      }
      position.pending = [];
    };
    deliver();
    const events = [];
    for (const id of [...Object.keys(store.index.tasks), ...Object.keys(store.index.archive)]) {
      // Archived cards cannot acquire new transitions after their closure.
      if (store.index.archive[id] && position.through[id] === -1) continue;
      const task = readTask(store, id);
      if (saved) {
        for (let i = position.through[id] ?? 0; i < task.history.length; i++) {
          const event = task.history[i]!;
          const text = statusNotice(task, event, russian);
          if (text) events.push({ task: id, sequence: i + 1, at: event.at, text });
        }
      }
      position.through[id] = store.index.archive[id] ? -1 : task.history.length;
    }
    events.sort((a, b) => a.at.localeCompare(b.at) || a.task.localeCompare(b.task) || a.sequence - b.sequence);
    for (const event of events) {
      position.lastAt = Math.max(Date.parse(event.at), position.lastAt + 1);
      position.pending.push({ id: randomUUID(), at: position.lastAt, text: event.text });
    }
    writeJson(path, position);
    deliver();
    writeJson(path, position);
    return changed;
  });
}

type Message = NonNullable<BoardActivity["userMessage"]> & { clientId?: string };
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
const unreadByProject = new Map<string, string[]>();

export const isLocalManagerCursor = (cursor: string | null) => cursor?.startsWith(cursorPrefix) ?? false;

export function managerUnread(project: string): string[] {
  const cached = unreadByProject.get(project);
  if (cached) return cached;
  const path = join(project, ".tasks", "manager-unread.json");
  const saved: unknown = exists(path) ? readJson(path) : [];
  if (!Array.isArray(saved) || saved.some(id => typeof id !== "string")) {
    throw new Error("Invalid manager unread messages.");
  }
  unreadByProject.set(project, saved);
  return saved;
}

function updateManagerUnread(project: string, ids: string[]): boolean {
  const previous = managerUnread(project);
  if (ids.length === previous.length && ids.every((id, index) => id === previous[index])) return false;
  writeJson(join(project, ".tasks", "manager-unread.json"), ids);
  unreadByProject.set(project, ids);
  return true;
}

export function readManagerMessages(project: string, ids: string[]) {
  const read = new Set(ids);
  return updateManagerUnread(project, managerUnread(project).filter(id => !read.has(id)));
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
  const added = incoming.filter(id => !previous.has(id));
  // Write unread first: replay after an interrupted chat write must not lose
  // the unread marker. Existing messages retain their read state on replay.
  const changed = added.length > 0 && updateManagerUnread(project, [...new Set([...managerUnread(project), ...added])]);
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
