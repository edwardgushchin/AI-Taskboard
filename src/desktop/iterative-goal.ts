import { createRequire } from "node:module";
import { join } from "node:path";
import type { BoardSettings } from "../cli/model.ts";
import { exists, readJson, writeJson } from "../cli/storage.ts";
import { launchableTasks, type QueueTask } from "./auto-queue.ts";

type MarkdownBlock = {
  type: string;
  map: [startLine: number, endLine: number] | null;
};

const createMarkdown = createRequire(import.meta.url)("markdown-it") as
  (options: { html: boolean }) => { parse(text: string, env: object): MarkdownBlock[] };
const markdown = createMarkdown({ html: false });

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
  for (const [index, line] of unquoted.split(/\r\n?|\n/).entries()) {
    if (excludedLines.has(index) || /^(?: {4}|\t)/.test(line)) {
      continue;
    }
    const command = line.trim();
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

export type IterationDirective = Partial<ReturnType<typeof ownerIterationDirective>>;

export function iterationDirectiveAfterEdit(previous: IterationDirective, request: string, objective: string): IterationDirective {
  const requested = ownerIterationDirective(request);
  const current = ownerIterationDirective(objective);
  return {
    enabled: current.enabled === (requested.enabled ?? previous.enabled) ? current.enabled : undefined,
    intervalMs: current.intervalMs === (requested.intervalMs ?? previous.intervalMs) ? current.intervalMs : undefined,
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
  limit: number, now: number, controls?: BoardSettings["autoQueue"]) {
  const ready = launchableTasks(planned, now, controls, tasks).filter(task => !occupied.has(task.id));
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
