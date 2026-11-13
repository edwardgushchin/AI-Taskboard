import { number, object, text, TaskboardError } from "./model.ts";
import type { Task } from "./model.ts";

// Input includes cache reads/writes; output includes reasoning. These subsets
// must not be added to totalTokens a second time.
export const tokenFields = [
  "totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens",
] as const;
export type TokenCounts = Record<typeof tokenFields[number], number | null>;
export type ModelTokenUsage = TokenCounts & { model: string | null; incomplete: boolean };
export type TokenUsageRecord = ModelTokenUsage & { threadId: string; turnId: string };
export type TokenUsageReport = { id: string; sequence: number; records: TokenUsageRecord[] };
export type TaskTokenUsage = { reports: TokenUsageReport[]; byModel: ModelTokenUsage[] };

export function emptyTokenCounts(): TokenCounts {
  return Object.fromEntries(tokenFields.map(key => [key, null])) as TokenCounts;
}

export function parseTokenUsage(value: unknown): TokenUsageRecord {
  const entry = object(value);
  const result: TokenUsageRecord = {
    ...emptyTokenCounts(), threadId: text(entry.threadId, "threadId", true), turnId: text(entry.turnId, "turnId", true),
    model: entry.model === null ? null : text(entry.model, "model", true), incomplete: entry.incomplete === true,
  };
  if (typeof entry.incomplete !== "boolean") throw new TaskboardError("INVALID_INPUT", "incomplete must be a boolean.");
  for (const key of tokenFields) result[key] = entry[key] === null ? null : number(entry[key], key, 0);
  if (tokenFields.some(key => result[key] === null) && !result.incomplete ||
      result.inputTokens !== null && [result.cachedInputTokens, result.cacheWriteInputTokens].some(value => value !== null && value > result.inputTokens!) ||
      result.outputTokens !== null && result.reasoningOutputTokens !== null && result.reasoningOutputTokens > result.outputTokens) {
    throw new TaskboardError("INVALID_INPUT", "Invalid token usage breakdown.");
  }
  return result;
}

export function usageKey(entry: TokenUsageRecord): string {
  return JSON.stringify([entry.threadId, entry.turnId, entry.model]);
}

export function parseUsageReport(value: unknown): TokenUsageReport {
  const report = object(value);
  if (!Array.isArray(report.records) || !report.records.length) {
    throw new TaskboardError("INVALID_INPUT", "Supply token usage records.");
  }
  const records = report.records.map(parseTokenUsage);
  if (new Set(records.map(usageKey)).size !== records.length) {
    throw new TaskboardError("INVALID_INPUT", "Duplicate token usage record.");
  }
  return { id: text(report.id, "id", true), sequence: number(report.sequence, "sequence", 0), records };
}

export function totalTokenUsage(records: TokenUsageRecord[]): ModelTokenUsage[] {
  const models = new Map<string | null, ModelTokenUsage>();
  for (const entry of records) {
    let total = models.get(entry.model);
    if (!total) {
      total = { ...emptyTokenCounts(), model: entry.model, incomplete: false };
      models.set(entry.model, total);
    }
    total.incomplete ||= entry.incomplete;
    for (const key of tokenFields) {
      if (entry[key] === null) continue;
      total[key] = number((total[key] ?? 0) + entry[key], key, 0);
    }
  }
  return [...models.values()];
}

export function recordTokenUsage(task: Task, input: Record<string, unknown>): Task {
  const report = parseUsageReport(input);
  const reports = new Map((task.tokenUsage?.reports ?? []).map(entry => [entry.id, entry]));
  // Retrying a write or delivering an older snapshot cannot count it twice.
  const previous = reports.get(report.id);
  if (previous && previous.sequence >= report.sequence) return task;
  reports.set(report.id, report);
  const entries = [...reports.values()];
  // Telemetry does not change the content revision or invalidate a submission preview.
  return { ...task, tokenUsage: { reports: entries, byModel: totalTokenUsage(entries.flatMap(entry => entry.records)) } };
}
