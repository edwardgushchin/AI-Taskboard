import type { Task, TaskEvent } from "./model.ts";

const workActions = new Set([
  "start", "resume", "pause", "stop", "progress", "submit", "accept",
  "request-changes", "review-approve", "review-note",
]);

function statusChanged(event: TaskEvent) {
  return event.from !== event.to && event.to !== undefined;
}

export function taskActivity(task: Pick<Task, "history">) {
  const latest = (matches: (event: TaskEvent) => boolean) => {
    const index = task.history.findLastIndex(matches);
    if (index >= 0) return { at: task.history[index].at, sequence: index + 1 };
  };
  return {
    status: latest(statusChanged),
    blocked: latest(event => statusChanged(event) && event.to === "blocked"),
    submitted: latest(event => statusChanged(event) && (event.to === "review" || event.to === "done")),
    work: latest(event => statusChanged(event) || workActions.has(event.action) ||
      (event.action === "run-log" && event.durationMs !== undefined)),
  };
}
