import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { RunActivity } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";

export type ReviewerAttempt = {
  id: string;
  at: string;
  items: RunActivity[];
  durationMs?: number;
  finishedAt?: string;
  submissionSequence?: number;
  report?: { summary: string; findings: string[]; evidence: (string | null)[]; needsHuman: boolean };
  interrupted?: true;
  error?: string;
};

const active = new Map<string, { attempt: ReviewerAttempt; history?: ReviewerAttempt[] }>();

export function reviewerActivity(project: string, id: string) {
  const attempt = active.get(historyPath(project, id))?.attempt;
  const item = attempt?.items.findLast(entry => !entry.stageChild && entry.status === "inProgress");
  return attempt && { at: attempt.at, item: item && {
    type: item.type, status: item.status, title: item.title, text: item.type === "reasoning" ? item.text.slice(-1000) : "",
  } };
}

function historyPath(project: string, id: string) {
  return join(project, ".tasks", "reviewer-chat", id + ".json");
}

function savedAttempts(path: string): ReviewerAttempt[] {
  directory(dirname(dirname(path)));
  if (!exists(dirname(path))) return [];
  directory(dirname(path));
  if (!exists(path)) return [];
  const saved = readJson(path);
  if (!Array.isArray(saved)) throw new Error("Invalid reviewer chat history.");
  return saved;
}

export function readReviewerChat(project: string, id: string) {
  const path = historyPath(project, id);
  const current = active.get(path);
  if (!current) return savedAttempts(path);
  current.history ??= savedAttempts(path);
  return [...current.history, current.attempt];
}

export function readReviewerChatPage(project: string, id: string, before?: string) {
  const history = readReviewerChat(project, id);
  const end = before === undefined ? history.length : history.findIndex(attempt => attempt.id === before);
  if (end < 0) throw new Error("Reviewer history cursor is unavailable.");
  const start = Math.max(0, end - 10);
  return {
    attempts: history.slice(start, end),
    boundaries: history.map(({ id, at, submissionSequence }) => ({ id, at, submissionSequence })),
    ...(start > 0 ? { before: history[start].id } : {}),
  };
}

export async function withReviewerChat<T>(project: string, id: string, notify: () => void,
  run: (onActivity: (items: RunActivity[]) => void) => Promise<T>, interrupted?: () => boolean,
  submissionSequence?: number, report?: (result: T) => ReviewerAttempt["report"], startedAtMs = Date.now()): Promise<T> {
  const path = historyPath(project, id);
  const started = performance.now();
  const attempt: ReviewerAttempt = { id: randomUUID(), at: new Date(startedAtMs).toISOString(), items: [], submissionSequence };
  const current: { attempt: ReviewerAttempt; history?: ReviewerAttempt[] } = { attempt };
  active.set(path, current);
  let notifyTimer: NodeJS.Timeout | undefined;
  notify();
  try {
    const result = await run(items => {
      attempt.items = items;
      notifyTimer ??= setTimeout(() => {
        notifyTimer = undefined;
        notify();
      }, 100);
    });
    attempt.report = report?.(result);
    return result;
  } catch (error) {
    if (interrupted?.()) {
      attempt.interrupted = true;
    } else {
      attempt.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    }
    throw error;
  } finally {
    clearTimeout(notifyTimer);
    attempt.finishedAt = new Date().toISOString();
    attempt.durationMs = Math.round(performance.now() - started);
    try {
      directory(dirname(dirname(path)));
      directory(dirname(path), true);
      writeJson(path, [...(current.history ?? savedAttempts(path)), attempt]);
    } catch (error) {
      console.warn("Could not save the reviewer chat.", (error as Error).message);
    } finally {
      active.delete(path);
      notify();
    }
  }
}
