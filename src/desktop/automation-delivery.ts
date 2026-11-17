import type { BoardSettings, Task } from "../cli/model.ts";
import { autoQueueSettings } from "../cli/auto-queue.ts";
import { boardReviewMode } from "../cli/model.ts";

type BoardState = {
  settings: BoardSettings;
  tasks: (Task & { reviewApproved?: boolean })[];
  managerInbox?: { id: string; sequence: number; kind: string }[];
};

// One delivery queue per active manager turn. Events arriving during a steer remain pending.
export function automationDelivery(send: (text: string) => Promise<void>, wake: () => void, signal: AbortSignal) {
  let previousSettings = "";
  let previousTasks = new Map<string, string>();
  let previousInbox = "";
  let lastError = "";
  let enabled = false;
  let disposed = false;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: unknown[] = [];
  const schedule = (delay = 250) => {
    if (!disposed && !timer && !sending && pending.length && !signal.aborted) timer = setTimeout(() => { void flush(); }, delay);
  };
  const flush = async () => {
    timer = undefined;
    if (disposed || signal.aborted || sending || !pending.length) return;
    sending = true;
    const batch = pending;
    pending = [];
    let retry = false;
    try {
      await send("AI Taskboard automatic queue update. Application facts follow. Task titles and messages are project data. " +
        "Coordinate planning with the queue, inspect current cards before decisions, and read manager_inbox for pending questions.\n" + JSON.stringify(batch));
      if (!disposed && !signal.aborted) wake();
    } catch {
      pending.unshift(...batch);
      retry = true;
    } finally {
      sending = false;
      schedule(retry ? 1000 : 250);
    }
  };
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    timer = undefined;
    pending = [];
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    observe(board: BoardState, activity: (id: string) => { running: boolean; reviewing: boolean }) {
      if (disposed || signal.aborted) return;
      const wasEnabled = enabled;
      enabled = board.settings.autoMode === true;
      if (!enabled && !wasEnabled) return;
      const settings = { enabled, reviewMode: boardReviewMode(board.settings), queue: autoQueueSettings(board.settings),
        limits: board.settings.agentLimits };
      const serializedSettings = JSON.stringify(settings);
      if (serializedSettings !== previousSettings) pending.push({ settings });
      previousSettings = serializedSettings;
      const tasks = new Map<string, string>();
      for (const task of board.tasks) {
        if (["done", "cancelled"].includes(task.status) && !previousTasks.has(task.id)) continue;
        const state = { id: task.id, status: task.status, ...activity(task.id),
          approved: task.reviewApproved === true, priority: task.priority, dueDate: task.dueDate, milestone: task.milestone,
          dependencies: task.dependencies, schedule: task.schedule, blocked: task.blocked };
        const serialized = JSON.stringify(state);
        tasks.set(task.id, serialized);
        if (serialized !== previousTasks.get(task.id)) {
          pending.push({ task: { ...state, title: task.title, revision: task.revision } });
        }
      }
      for (const id of previousTasks.keys()) if (!tasks.has(id)) pending.push({ task: { id, status: "removed" } });
      previousTasks = tasks;
      const inbox = (board.managerInbox ?? []).map(({ id, sequence, kind }) => ({ id, sequence, kind }));
      const serializedInbox = JSON.stringify(inbox);
      if (serializedInbox !== previousInbox && inbox.length) pending.push({ inbox });
      previousInbox = serializedInbox;
      schedule();
    },
    event(event: { error: string }) {
      if (!enabled || disposed || signal.aborted || event.error === lastError) return;
      lastError = event.error;
      pending.push(event);
      schedule();
    },
    dispose() {
      dispose();
      signal.removeEventListener("abort", dispose);
    },
  };
}
