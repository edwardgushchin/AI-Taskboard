import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern, taskStates } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";
import type { BoardActivity, readBoardHistory } from "./codex-chat.ts";
import { onBoard, withRuntimeLock } from "../cli/storage.ts";
import { runtimeLocation } from "./board-runtime.ts";
import { readTask } from "../cli/archive.ts";
import { statusNotice } from "../cli/task-messages.ts";
import localization from "./localization.cjs";

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
const statusLabels = new Map(Object.keys(localization.catalogs).flatMap(locale =>
  taskStates.map(status => [localization.text("status." + status, {}, locale), status] as const)));
const mergedPrefixes = Object.keys(localization.catalogs).map(locale => {
  const [prefix, suffix] = localization.text("status.merged",
    { p0: "{p0}", p1: "{p1}", p2: "", p3: "", p4: "" }, locale).split("{p0}");
  return { prefix, suffix: suffix?.split("{p1}")[0] };
});

// Only older records produced by status sync need their formatted fields recovered.
function noticeTransition(text: string): BoardActivity["statusTransition"] {
  const regular = /^(T-\d+) «[^\r\n]*?» — ([^\r\n]+?)(?:[.:]|$)/u.exec(text);
  const status = regular && statusLabels.get(regular[2]!);
  if (regular && status) return { task: regular[1]!, status };
  for (const { prefix, suffix } of mergedPrefixes) {
    if (!suffix || !text.startsWith(prefix!)) continue;
    const match = /^T-\d+/u.exec(text.slice(prefix!.length));
    if (match && text.startsWith(suffix, prefix!.length + match[0].length)) return { task: match[0], status: "cancelled" };
  }
}
const cursorPrefix = "local:";
const filePattern = /^\d{13}-[0-9a-f-]{36}\.json$/i;
type ReadPosition = { at: number; file: string; index: number };
type UnreadState = { unread: string[]; through?: ReadPosition };
const lastUnread = new Map<string, string[]>();

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
  const candidates = new Set(state.unread.filter(id => codexThreadPattern.test(id)));
  const statusIds = new Set<string>();
  if (candidates.size && exists(folder)) for (const file of readdirSync(folder)) {
    if (!filePattern.test(file)) continue;
    const id = file.slice(14, -5);
    if (candidates.has(id) && isStatusNotice(readJson(join(folder, file)) as Run)) statusIds.add(id);
  }
  state.unread = state.unread.filter(id => !statusIds.has(id));
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
  if (run.lane !== "chat" && (run.lane !== "notice" || isStatusNotice(run))) return [];
  return run.items.filter(item => item.type === "agentMessage" && item.phase === "final_answer" &&
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

function displayTurns({ message, items, durationMs, lane, goalId }: Run, startedAt?: number): Turn[] {
  const turns: Turn[] = [];
  const scope = { ...(lane ? { lane } : {}), ...(goalId ? { goalId } : {}) };
  let current: Turn = { messages: message ? [message] : [], items: [], ...scope };
  for (const [index, item] of items.entries()) {
    if (!item.userMessage) {
      // Old logs have only the tool start time. Cap its possible transition
      // at the next operation on the same card, or at the saved end of the run.
      const completedAt = item.completedAt ?? (startedAt !== undefined && item.taskChanges?.length ?
        items.slice(index + 1).find(next => next.at && next.taskChanges?.some(change =>
          item.taskChanges!.some(previous => change.id === previous.id)))?.at ??
        (durationMs !== undefined ? new Date(startedAt + durationMs).toISOString() : undefined) : undefined);
      current.items.push(item.taskChanges?.length && completedAt ? { ...item, completedAt } : item);
      continue;
    }
    if (current.messages.length || current.items.length) turns.push(current);
    current = { messages: [{ ...item.userMessage, clientId: item.id }], items: [], ...scope };
  }
  if (current.messages.length || current.items.length) turns.push({ ...current, durationMs });
  return turns;
}

const workTools = new Set([
  "manager_ack", "manager_inbox", "task_wait", "task_message", "team_inbox", "team_message",
  "task_approve", "task_start", "task_start_batch", "task_block", "task_unblock",
  "task_submit", "task_request_changes", "task_accept", "task_cancel",
]);

const isWorkActivity = (item: BoardActivity) =>
  Boolean(item.messagesOnly || item.messages?.length ||
    (item.type === "mcpToolCall" && item.title.startsWith("ai_taskboard / ") && workTools.has(item.title.slice("ai_taskboard / ".length))) ||
    (item.type === "dynamicToolCall" && workTools.has(item.title)));

export function managerChatItems(items: BoardActivity[]): BoardActivity[] {
  return items.filter(item => !isWorkActivity(item)).map(item =>
    item.title === "ai_taskboard / goal_read" || item.title === "ai_taskboard / goal_send" ? { ...item, text: "" } : item);
}

export function managerWorkItems(items: BoardActivity[], lane?: Turn["lane"]) {
  if (lane === "work") return items;
  return items.filter(isWorkActivity);
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
      return turn.lane === "work" || isStatusNotice(turn) || automatic ? [] : [{ ...turn, items: managerChatItems(turn.items) }];
    }
    const notice = isStatusNotice(turn);
    const items = notice ? turn.items.map(item => ({ ...item, statusTransition: item.statusTransition ?? noticeTransition(item.text) })) :
      managerWorkItems(turn.items, automatic ? "work" : turn.lane);
    const messages = turn.lane === "work" ? turn.messages : [];
    return items.length || messages.length ? [{ ...turn, items, messages }] : [];
  });
}

export function readManagerHistory(project: string, cursor: string | null = null, view?: "chat" | "work") {
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
    if (exceedsBudget && view !== "chat") break;
    const run = readJson(path) as Run;
    const turns = managerHistoryForView(displayTurns(run, view === "work" ? Number(name.slice(0, 13)) : undefined), view);
    if (view !== "chat" || turns.some(turn => turn.messages.length || turn.items.length)) {
      // An inline image can exceed the page budget after Base64 encoding.
      // Keep the first conversation together even if goal notices started the page.
      if (exceedsBudget && (!needsConversation || run.lane === "notice")) break;
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
  const beforeLocal = ({ at }: { at?: string }) => !at || Date.parse(at) < cutoff;
  let next = cursor?.startsWith(providerCursorPrefix) ? cursor.slice(providerCursorPrefix.length) || null : null;
  const visited = new Set<string | null>();
  do {
    visited.add(next);
    const legacy = await readLegacy(next);
    if (!legacy) return;
    const turns = managerHistoryForView(legacy.turns, view).map(turn => ({
      ...turn, messages: turn.messages.filter(beforeLocal), items: turn.items.filter(beforeLocal),
    })).filter(turn => turn.messages.length || turn.items.length);
    next = legacy.nextCursor;
    if (turns.length || !next || visited.has(next)) {
      return { ...legacy, turns, nextCursor: next && !visited.has(next) ? providerCursorPrefix + next : null };
    }
  } while (next);
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
