import type { BoardSettings, Task } from "../cli/model.ts";
import { autoQueueSettings } from "../cli/auto-queue.ts";
import { boardReviewMode, taskReviewMode } from "../cli/model.ts";

type BoardState = {
  settings: BoardSettings;
  tasks: (Task & { reviewApproved?: boolean; reviewPending?: boolean })[];
  managerInbox?: { id: string; sequence: number; kind: string }[];
};

export function pendingReviewApprovals(board: BoardState) {
  if (board.settings.autoMode) return [];
  const eligible = new Set(board.tasks.filter(task => task.status === "review" && task.reviewApproved &&
    !task.reviewPending && !task.acceptanceRepair && taskReviewMode(task, board.settings) === "reviewer").map(task => task.id));
  return (board.managerInbox ?? []).filter(message => message.kind === "review-approve" && eligible.has(message.id));
}

// Queue changes wake board tools internally; they are never conversation messages.
export function automationDelivery(wake: () => void, signal: AbortSignal) {
  let previousSettings = "";
  let previousTasks = new Map<string, string>();
  let previousInbox = "";
  let lastError = "";
  let enabled = false;
  let disposed = false;
  let errors: { error: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed || timer || signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed && !signal.aborted) wake();
    }, 250);
  };
  const dispose = () => {
    disposed = true;
    clearTimeout(timer);
    timer = undefined;
    errors = [];
  };
  signal.addEventListener("abort", dispose, { once: true });
  return {
    observe(board: BoardState, activity: (id: string) => { running: boolean; reviewing: boolean }) {
      if (disposed || signal.aborted) return;
      const wasEnabled = enabled;
      enabled = board.settings.autoMode === true;
      if (!enabled && !wasEnabled) {
        const approvals = pendingReviewApprovals(board);
        const serialized = JSON.stringify(approvals.map(({ id, sequence }) => ({ id, sequence })));
        if (approvals.length && serialized !== previousInbox) schedule();
        previousInbox = serialized;
        return;
      }
      const settings = { enabled, reviewMode: boardReviewMode(board.settings), queue: autoQueueSettings(board.settings),
        limits: board.settings.taskLimits };
      const serializedSettings = JSON.stringify(settings);
      let changed = serializedSettings !== previousSettings;
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
          changed = true;
        }
      }
      for (const id of previousTasks.keys()) {
        if (!tasks.has(id)) changed = true;
      }
      previousTasks = tasks;
      const inbox = (board.managerInbox ?? []).map(({ id, sequence, kind }) => ({ id, sequence, kind }));
      const serializedInbox = JSON.stringify(inbox);
      if (serializedInbox !== previousInbox && inbox.length) changed = true;
      previousInbox = serializedInbox;
      if (changed) schedule();
    },
    event(event: { error: string }) {
      if (!enabled || disposed || signal.aborted || event.error === lastError) return;
      lastError = event.error;
      errors.push(event);
      schedule();
    },
    takeErrors() {
      const pending = errors;
      errors = [];
      return pending;
    },
    dispose() {
      dispose();
      signal.removeEventListener("abort", dispose);
    },
  };
}
