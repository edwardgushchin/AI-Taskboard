import { createRequire } from "node:module";
import { join } from "node:path";
import { taskIdPattern, type BoardSettings } from "../cli/model.ts";
import type { taskActivity } from "../cli/task-activity.ts";
import { exists, readJson, writeJson } from "../cli/storage.ts";
import { launchableTasks, type QueueTask } from "./auto-queue.ts";

type MarkdownBlock = {
  type: string;
  map: [startLine: number, endLine: number] | null;
};

const createMarkdown = createRequire(import.meta.url)("markdown-it") as
  (options: { html: boolean }) => { parse(text: string, env: object): MarkdownBlock[] };
const markdown = createMarkdown({ html: false });

export type GoalRule =
  | { kind: "status" | "blocked" | "submitted"; scope: string }
  | { kind: "idle"; scope: string; durationMs: number }
  | { kind: "reserve"; scope: "board"; threshold: "fixed" | "multiplier"; value: number };

export type GoalReason =
  | { kind: "interval" | "instructions" }
  | { kind: "reserve"; ready: number; target: number; freeExecutorSlots: number }
  | { kind: "status" | "blocked" | "submitted" | "idle"; scope: string };

export type IterativeGoalState = {
  goalId: string;
  waitFor?: string;
  questions: string[];
  step?: string;
  retryAt?: number;
  enabled?: boolean;
  intervalMs?: number;
  nextAt?: number;
  rules?: GoalRule[];
  observingSince?: number;
  handled?: Record<string, { at: number; task: string; sequence: number }>;
  freeExecutorSlots?: number;
  executorReleaseId?: string;
  reserveEpoch?: number;
  lastRun?: GoalReason[];
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

export function acknowledgeInterval(state: IterativeGoalState, resumedAt: number, due: number | undefined, now: number) {
  if (due === undefined) return state.nextAt;
  if (!state.intervalMs || intervalDeadline(state, resumedAt) !== due || due > now) {
    throw new Error("The interval is no longer due.");
  }
  return advanceInterval(due, state.intervalMs, now);
}

// Normalize through a single schema before comparing the tool call to the owner's text.
export function normalizeGoalRules(input: unknown): GoalRule[] | undefined {
  if (!Array.isArray(input) || input.length > 32) return;
  const rules: GoalRule[] = [];
  const keys = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { kind, scope, durationMs, threshold, value } = item;
    if (typeof scope !== "string" || (scope !== "board" && !taskIdPattern.test(scope))) return;
    const length = Object.keys(item).length;
    if (kind === "idle" && length === 3 && Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 86400000) {
      rules.push({ kind, scope, durationMs });
    } else if (kind === "reserve" && scope === "board" && length === 4 &&
        (threshold === "fixed" || threshold === "multiplier") && Number.isSafeInteger(value) && value > 0 && value <= 999999) {
      rules.push({ kind, scope, threshold, value });
    } else if (length === 2 && (kind === "status" || kind === "blocked" || kind === "submitted")) {
      rules.push({ kind, scope });
    } else {
      return;
    }
    const key = kind + ":" + scope;
    if (keys.has(key)) return;
    keys.add(key);
  }
  return rules;
}

function durationMs(value: string, unit: string) {
  const name = unit.toLowerCase();
  return Number(value) * (name.startsWith("сек") ? 1000 : name.startsWith("мин") ? 60000 : 3600000);
}

function hideHtmlQuotes(text: string) {
  const tokens = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)|<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/gim;
  let fence: string | undefined;
  let rawText: string | undefined;
  let depth = 0;
  let start = 0;
  let end = 0;
  let visible = "";
  for (const token of text.matchAll(tokens)) {
    const [, marker, suffix, slash, tag] = token;
    const name = tag?.toLowerCase();
    if (rawText) {
      if (name === rawText && slash) {
        rawText = undefined;
      }
      continue;
    }
    if (fence) {
      if (marker?.startsWith(fence) && !suffix.trim()) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (depth > 0 && !slash && name && /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(name)) {
      rawText = name;
    }
    if (name !== "blockquote") {
      continue;
    }
    if (!slash) {
      if (depth === 0) {
        start = token.index;
      }
      depth++;
      continue;
    }
    if (depth === 0) {
      continue;
    }
    depth--;
    if (depth === 0) {
      const next = token.index + token[0].length;
      visible += text.slice(end, start) + text.slice(start, next).replace(/[^\r\n]/g, " ");
      end = next;
    }
  }
  if (depth > 0) {
    return visible + text.slice(end, start);
  }
  return visible + text.slice(end);
}

export function ownerIterationDirective(objective: string) {
  // The Markdown parser includes lazy continuation lines in the quote's source range.
  const excludedLines = new Set<number>();
  for (const block of markdown.parse(objective, {})) {
    if (block.map && ["blockquote_open", "fence", "code_block"].includes(block.type)) {
      const [start, end] = block.map;
      for (let line = start; line < end; line++) {
        excludedLines.add(line);
      }
    }
  }
  // Ignore quoted passages, including quotations that span several lines.
  const unquoted = hideHtmlQuotes(objective).replace(/«[^»]*(?:»|$)|“[^”]*(?:”|$)|"[^"]*(?:"|$)|<!--[\s\S]*?(?:-->|$)/g,
    passage => passage.replace(/[^\r\n]/g, " "));
  let enabled: boolean | undefined;
  let intervalMs: number | undefined;
  let rules: GoalRule[] | undefined;
  for (const [index, line] of unquoted.split(/\r\n?|\n/).entries()) {
    if (excludedLines.has(index) || /^(?: {4}|\t)/.test(line)) {
      continue;
    }
    const command = line.trim();
    const mode = /^(включи|выключи|отключи) итеративный режим[.!]?$/iu.exec(command);
    const interval = /^(?:(включи) итеративный режим и )?(?:настрой (?:проверку [^"'«»“”`<>]+? каждые|интервал(?: на)?)|измени интервал(?: на)?) ([1-9]\d{0,5}) (секунд[уы]?|минут[уы]?|час(?:а|ов)?)[.!]?$/iu.exec(command);
    const reserve = /^(?:(включи) итеративный режим и )?(?:настрой|измени) правило: если число карточек, доступных к запуску, меньше (?:общего лимита исполнителей, умноженного на ([1-9]\d{0,5})|([1-9]\d{0,5}))(?=[.!]?$|, \S)[^\r\n]*$/iu.exec(command);
    const cardEvent = /^(?:настрой|измени) правило: (смена статуса|блокировка|сдача или завершение) (T-\d{4,}|доски)[.!]?$/iu.exec(command);
    const idle = /^(?:настрой|измени) правило: нет рабочих изменений (T-\d{4,}|доски) ([1-9]\d{0,5}) (секунд[уы]?|минут[уы]?|час(?:а|ов)?)[.!]?$/iu.exec(command);
    if (/^удали событийные правила[.!]?$/iu.test(command)) {
      rules = [];
    }
    if (reserve) {
      (rules ??= []).push({ kind: "reserve", scope: "board", threshold: reserve[2] ? "multiplier" : "fixed",
        value: Number(reserve[2] ?? reserve[3]) });
      if (reserve[1]) enabled = true;
    }
    if (cardEvent) {
      const kind = cardEvent[1].toLowerCase() === "смена статуса" ? "status" :
        cardEvent[1].toLowerCase() === "блокировка" ? "blocked" : "submitted";
      const scope = cardEvent[2].toUpperCase();
      (rules ??= []).push({ kind, scope: scope === "ДОСКИ" ? "board" : scope });
    }
    if (idle) {
      const scope = idle[1].toUpperCase();
      const duration = durationMs(idle[2], idle[3]);
      if (duration <= 86400000) {
        (rules ??= []).push({ kind: "idle", scope: scope === "ДОСКИ" ? "board" : scope, durationMs: duration });
      }
    }
    if (mode) {
      enabled = mode[1].toLowerCase() === "включи";
    }
    if (interval) {
      const duration = durationMs(interval[2], interval[3]);
      if (duration <= 86400000 && duration >= 1000) {
        intervalMs = duration;
        if (interval[1]) {
          enabled = true;
        }
      }
    }
  }
  const normalized = normalizeGoalRules(rules);
  return { enabled, intervalMs, ...(normalized ? { rules: normalized } : {}) };
}

export type IterationDirective = Partial<ReturnType<typeof ownerIterationDirective>>;

export function iterationDirectiveAfterEdit(previous: IterationDirective, request: string, objective: string): IterationDirective {
  const requested = ownerIterationDirective(request);
  const current = ownerIterationDirective(objective);
  const rules = requested.rules ?? previous.rules;
  return {
    enabled: current.enabled === (requested.enabled ?? previous.enabled) ? current.enabled : undefined,
    intervalMs: current.intervalMs === (requested.intervalMs ?? previous.intervalMs) ? current.intervalMs : undefined,
    rules: rules && JSON.stringify(current.rules) === JSON.stringify(rules) ? rules : undefined,
  };
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
  limit: number, now: number, controls?: BoardSettings["autoQueue"], target = 2 * (limit || 1)) {
  const ready = launchableTasks(planned.filter(task => !task.schedule), now, controls, tasks)
    .filter(task => !occupied.has(task.id));
  if (controls?.paused || ready.length >= target) return { ready: ready.length, target };
  const available = new Set(ready.map(task => task.id));
  const blocked = tasks.filter(task => !task.schedule && task.status === "ready" && !available.has(task.id) && !occupied.has(task.id))
    .map(task => ({
      id: task.id,
      held: controls?.held.includes(task.id) ?? false,
      dependencies: [...task.unfinishedDependencies ?? []].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { ready: ready.length, target, waitFor: JSON.stringify([target, [...available].sort(), blocked]) };
}

export function goalReserveTarget(rule: Extract<GoalRule, { kind: "reserve" }>, limit: number) {
  return rule.threshold === "multiplier" ? rule.value * limit : rule.value;
}

export function goalEventConditions(state: IterativeGoalState, tasks: {
  id: string; activity?: ReturnType<typeof taskActivity>;
}[], since: number, now: number) {
  const handled = { ...state.handled };
  const reasons: GoalReason[] = [];
  const floor = Math.max(since, state.observingSince ?? 0);
  for (const rule of state.rules ?? []) {
    if (rule.kind === "reserve") continue;
    const { kind, scope } = rule;
    const key = kind + ":" + scope;
    let marker = { at: floor, task: "", sequence: 0 };
    let found = scope === "board";
    for (const task of tasks) {
      if (scope !== "board" && scope !== task.id) continue;
      found = true;
      const event = task.activity?.[kind === "idle" ? "work" : kind];
      if (!event) continue;
      const time = Date.parse(event.at);
      if (time > floor && (time > marker.at || (time === marker.at &&
          (task.id > marker.task || (task.id === marker.task && event.sequence > marker.sequence))))) {
        marker = { at: time, task: task.id, sequence: event.sequence };
      }
    }
    const previous = handled[key];
    if (!found || (previous && (marker.at < previous.at || (marker.at === previous.at &&
        (marker.task < previous.task || (marker.task === previous.task && marker.sequence <= previous.sequence)))))) {
      continue;
    }
    if (kind === "idle" ? now - marker.at >= rule.durationMs : marker.at > floor) {
      handled[key] = marker;
      reasons.push({ kind, scope });
    }
  }
  return { handled, reasons };
}
