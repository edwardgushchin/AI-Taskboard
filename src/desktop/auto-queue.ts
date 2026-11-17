import { priorities } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";

export type QueueTask = Pick<Task, "id" | "status" | "priority" | "dueDate" | "milestone" | "schedule"> & {
  readySince?: string; unfinishedDependencies?: string[];
};

// Lexicographic order; dates are deadlines, never start times.
export function compareReadyTasks(a: QueueTask, b: QueueTask, milestoneDates: ReadonlyMap<number, string | null>) {
  const date = (value?: string | null) => value ? Date.parse(value) : Infinity;
  const compare = (left: number, right: number) => left === right ? 0 : left < right ? -1 : 1;
  return compare(date(a.dueDate), date(b.dueDate)) || priorities.indexOf(b.priority) - priorities.indexOf(a.priority) ||
    compare(date(a.milestone && milestoneDates.get(a.milestone.number)), date(b.milestone && milestoneDates.get(b.milestone.number))) ||
    compare(date(a.readySince), date(b.readySince)) || a.id.localeCompare(b.id, "en", { numeric: true });
}

export function nextReadyTask<T extends QueueTask>(tasks: T[], milestoneDates: ReadonlyMap<number, string | null>, busy: (id: string) => boolean, now = Date.now()) {
  return tasks.filter(task => task.status === "ready" && !task.unfinishedDependencies?.length &&
    (!task.schedule || Date.parse(task.schedule.nextAt) <= now) && !busy(task.id))
    .sort((a, b) => compareReadyTasks(a, b, milestoneDates))[0];
}
