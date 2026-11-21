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
  enabled?: boolean;
  intervalMs?: number;
  nextAt?: number;
};

export function iterativeEnabled(settings: BoardSettings, state: IterativeGoalState) {
  return state.enabled ?? settings.iterativeGoal === state.goalId;
}

export function intervalDeadline(state: IterativeGoalState, resumedAt: number) {
  if (!state.intervalMs || state.nextAt === undefined) return;
  return Math.max(state.nextAt, resumedAt + state.intervalMs);
}

export function advanceInterval(nextAt: number, intervalMs: number, now: number) {
  return nextAt + (1 + Math.floor((now - nextAt) / intervalMs)) * intervalMs;
}

export function ownerIterationDirective(objective: string) {
  // Ignore quoted passages, including quotations that span several lines.
  const unquoted = objective.replace(/«[^»]*(?:»|$)|“[^”]*(?:”|$)|"[^"]*(?:"|$)|<!--[\s\S]*?(?:-->|$)/g,
    passage => passage.replace(/[^\r\n]/g, " "));
  let fence: string | undefined;
  let blockQuote = false;
  let enabled: boolean | undefined;
  let intervalMs: number | undefined;
  for (const line of unquoted.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) {
        fence = undefined;
      }
      continue;
    }
    const command = line.trim();
    if (!command) {
      blockQuote = false;
      continue;
    }
    if (command.startsWith(">")) {
      blockQuote = true;
    }
    if (blockQuote || /^(?: {4}|\t)/.test(line)) {
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    const mode = /^(включи|выключи|отключи) итеративный режим[.!]?$/iu.exec(command);
    const interval = /^(?:(включи) итеративный режим и )?(?:настрой (?:проверку [^"'«»“”`<>]+? каждые|интервал(?: на)?)|измени интервал(?: на)?) ([1-9]\d{0,5}) (секунд[уы]?|минут[уы]?|час(?:а|ов)?)[.!]?$/iu.exec(command);
    if (mode) {
      enabled = mode[1].toLowerCase() === "включи";
    }
    if (interval) {
      const unit = interval[3].toLowerCase();
      const duration = Number(interval[2]) * (unit.startsWith("сек") ? 1000 : unit.startsWith("мин") ? 60000 : 3600000);
      if (duration <= 86400000 && duration >= 1000) {
        intervalMs = duration;
        if (interval[1]) {
          enabled = true;
        }
      }
    }
  }
  return { enabled, intervalMs };
}

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
