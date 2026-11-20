import { join } from "node:path";
import type { BoardSettings } from "../cli/model.ts";
import { exists, readJson, writeJson } from "../cli/storage.ts";
import { launchableTasks, type QueueTask } from "./auto-queue.ts";

export type IterativeGoalState = {
  goalId: string;
  waitFor?: string;
  questions: string[];
  step?: string;
  retryAt?: number;
};

export function readIterativeGoal(project: string, goalId: string): IterativeGoalState {
  const path = join(project, ".tasks", "iterative-goal.json");
  const saved = exists(path) ? readJson(path) as IterativeGoalState : undefined;
  return saved?.goalId === goalId ? saved : { goalId, questions: [] };
}

export function saveIterativeGoal(project: string, state: IterativeGoalState) {
  writeJson(join(project, ".tasks", "iterative-goal.json"), state);
}

export function goalQueueCondition(tasks: QueueTask[], planned: QueueTask[], occupied: ReadonlySet<string>,
  limit: number, now: number, controls?: BoardSettings["autoQueue"]) {
  const ready = launchableTasks(planned, now, controls).filter(task => !occupied.has(task.id));
  const target = 2 * (limit || 1);
  if (controls?.paused || ready.length >= target) return { ready: ready.length, target };
  const available = new Set(ready.map(task => task.id));
  const blocked = tasks.filter(task => task.status === "ready" && !available.has(task.id) && !occupied.has(task.id))
    .map(task => ({
      id: task.id,
      held: controls?.held.includes(task.id) ?? false,
      dependencies: [...task.unfinishedDependencies ?? []].sort(),
      scheduled: Boolean(task.schedule && (task.schedule.paused || Date.parse(task.schedule.nextAt) > now)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { ready: ready.length, target, waitFor: JSON.stringify([target, [...available].sort(), blocked]) };
}
