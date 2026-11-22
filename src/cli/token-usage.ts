import { member, number, object, text, TaskboardError } from "./model.ts";
import type { Task, TaskEvent, TaskState } from "./model.ts";

// Input includes cache reads/writes; output includes reasoning. These subsets
// must not be added to totalTokens a second time.
export const tokenFields = [
  "totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens",
] as const;
export type TokenCounts = Record<typeof tokenFields[number], number | null>;
export type ModelTokenUsage = TokenCounts & { model: string | null; incomplete: boolean };
export type TokenUsageRecord = ModelTokenUsage & {
  threadId: string;
  turnId: string;
  completedAt?: number;
  dailyTokens?: number | null;
};
const taskUsageRoles = ["executor", "discussion", "reviewer"] as const;
export type TaskUsageRole = typeof taskUsageRoles[number];
export type ReviewDecisionTiming = { lockWaitMs: number; verificationMs: number };
type ReviewTiming = { submissionSequence: number; startedAtMs: number; durationMs: number; decisionTiming?: ReviewDecisionTiming };
export type TokenUsageReport = { id: string; sequence: number; records: TokenUsageRecord[]; role?: TaskUsageRole; reviewTiming?: ReviewTiming };
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
  if (entry.completedAt !== undefined) result.completedAt = number(entry.completedAt, "completedAt", 0);
  if (entry.dailyTokens !== undefined) {
    result.dailyTokens = entry.dailyTokens === null ? null : number(entry.dailyTokens, "dailyTokens", 0);
  }
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
  const role = report.role === undefined ? undefined : member(report.role, taskUsageRoles, "role");
  let reviewTiming: ReviewTiming | undefined;
  if (report.reviewTiming !== undefined) {
    if (role !== "reviewer") throw new TaskboardError("INVALID_INPUT", "Review timing requires the reviewer role.");
    const timing = object(report.reviewTiming);
    reviewTiming = {
      submissionSequence: number(timing.submissionSequence, "submissionSequence"),
      startedAtMs: number(timing.startedAtMs, "startedAtMs", 0),
      durationMs: number(timing.durationMs, "durationMs", 0),
    };
    if (timing.decisionTiming !== undefined) {
      const decision = object(timing.decisionTiming);
      reviewTiming.decisionTiming = {
        lockWaitMs: number(decision.lockWaitMs, "lockWaitMs", 0),
        verificationMs: number(decision.verificationMs, "verificationMs", 0),
      };
    }
  }
  return { id: text(report.id, "id", true), sequence: number(report.sequence, "sequence", 0), records,
    ...(role ? { role } : {}), ...(reviewTiming ? { reviewTiming } : {}) };
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
  if (report.reviewTiming) {
    const submission = task.history[report.reviewTiming.submissionSequence - 1];
    if (submission?.action !== "submit" || submission.to !== "review") {
      throw new TaskboardError("INVALID_INPUT", "Review timing requires a recorded submission.");
    }
  }
  const reports = new Map((task.tokenUsage?.reports ?? []).map(entry => [entry.id, entry]));
  // Retrying a write or delivering an older snapshot cannot count it twice.
  const previous = reports.get(report.id);
  if (previous && previous.sequence >= report.sequence) return task;
  reports.set(report.id, report);
  const entries = [...reports.values()];
  // Telemetry does not change the content revision or invalidate a submission preview.
  return { ...task, tokenUsage: { reports: entries, byModel: totalTokenUsage(entries.flatMap(entry => entry.records)) } };
}

function reviewMetrics(task: Task) {
  const attempts = new Map<number, (ReviewTiming & { tokens: number | null; tokensIncomplete: boolean })[]>();
  for (const { reviewTiming, records } of task.tokenUsage?.reports ?? []) {
    if (!reviewTiming) continue;
    const totals = records.flatMap(entry => entry.totalTokens === null ? [] : [entry.totalTokens]);
    const entries = attempts.get(reviewTiming.submissionSequence) ?? [];
    entries.push({ ...reviewTiming, tokens: totals.length ? totals.reduce((sum, value) => sum + value, 0) : null,
      tokensIncomplete: records.some(entry => entry.incomplete || entry.totalTokens === null) });
    attempts.set(reviewTiming.submissionSequence, entries);
  }
  const rounds: { submissionSequence: number; submittedAt: string; submissionToReviewerMs: number | null;
    reviewerAttempts: { durationMs: number; tokens: number | null; tokensIncomplete: boolean; decisionTiming?: ReviewDecisionTiming }[];
    submissionToApprovalMs: number | null; approvalToAcceptanceMs: number | null;
    decision: string | null; decisionActor: string | null; submissionToDecisionMs: number | null }[] = [];
  let current: typeof rounds[number] | undefined;
  for (const [index, event] of task.history.entries()) {
    if (event.action === "submit" && event.to === "review") {
      const submissionSequence = index + 1;
      const runs = (attempts.get(submissionSequence) ?? []).sort((a, b) => a.startedAtMs - b.startedAtMs);
      const untilReviewer = runs.length ? runs[0].startedAtMs - Date.parse(event.at) : null;
      current = { submissionSequence, submittedAt: event.at,
        submissionToReviewerMs: untilReviewer !== null && untilReviewer >= 0 ? untilReviewer : null,
        reviewerAttempts: runs.map(({ durationMs, tokens, tokensIncomplete, decisionTiming }) =>
          ({ durationMs, tokens, tokensIncomplete, ...(decisionTiming ? { decisionTiming } : {}) })),
        submissionToApprovalMs: null, approvalToAcceptanceMs: null,
        decision: null, decisionActor: null, submissionToDecisionMs: null };
      rounds.push(current);
    } else if (current) {
      const leftReview = event.from === "review" && event.to && event.to !== "review";
      const elapsed = Date.parse(event.at) - Date.parse(current.submittedAt);
      if (event.action === "review-approve" && event.actor === "reviewer") {
        current.submissionToApprovalMs = elapsed >= 0 ? elapsed : null;
      }
      if (current.decision === null && (event.action === "review-note" || leftReview)) {
        current.decision = event.action;
        current.decisionActor = event.actor;
        current.submissionToDecisionMs = elapsed >= 0 ? elapsed : null;
      }
      if (leftReview) {
        const approval = current.submissionToApprovalMs;
        if (event.action === "accept" && event.to === "done" && approval !== null && elapsed >= approval) {
          current.approvalToAcceptanceMs = elapsed - approval;
        }
        current = undefined;
      }
    }
  }
  return rounds;
}

function timeByStatus(task: Task, accepted: TaskEvent | undefined, now: number) {
  const totals: Partial<Record<TaskState, number>> = {};
  let status: TaskState = "draft";
  let since = Date.parse(task.createdAt);
  for (const event of task.history) {
    if (!event.to || event.to === status) continue;
    const at = Date.parse(event.at);
    if (event.from !== status || !Number.isFinite(since) || !Number.isFinite(at) || at < since) return null;
    totals[status] = (totals[status] ?? 0) + at - since;
    if (event === accepted) return totals;
    status = event.to;
    since = at;
  }
  if (accepted || status !== task.status || status === "done" || status === "cancelled" ||
      !Number.isFinite(now) || !Number.isFinite(since) || now < since) return null;
  totals[status] = (totals[status] ?? 0) + now - since;
  return totals;
}

export function summarizeTokenUsage(models: ModelTokenUsage[]) {
  const counted = models.filter(model => model.totalTokens !== null);
  return {
    total: counted.length ? counted.reduce((sum, model) => sum + model.totalTokens!, 0) : null,
    incomplete: !models.length || models.some(model => model.incomplete || model.totalTokens === null),
  };
}

export function taskMetrics(task: Task, now = Date.now()) {
  const accepted = task.history.findLast(event => event.action === "accept" && event.to === "done");
  const firstReady = task.history.find(event => event.to === "ready");
  const readyToAcceptanceMs = accepted && firstReady ? Date.parse(accepted.at) - Date.parse(firstReady.at) : NaN;
  const submissions = task.history.filter(event => event.action === "submit" && event.to === "review").length;
  const timeByStatusMs = timeByStatus(task, accepted, now);
  const returns = task.history.filter(event => event.action === "request-changes");
  const starts = task.history.flatMap(({ at, startTiming }) => startTiming ? [{ at, ...startTiming }] : []);
  const runLogs = task.history.filter(event => event.action === "run-log");
  const durations = runLogs.flatMap(({ durationMs }) => durationMs === undefined ? [] : [durationMs]);
  const byRole: Record<string, ModelTokenUsage[]> = {};
  for (const role of [...taskUsageRoles, "unattributed"] as const) {
    const records = (task.tokenUsage?.reports ?? [])
      .filter(report => (report.role ?? "unattributed") === role)
      .flatMap(report => report.records);
    if (records.length) byRole[role] = totalTokenUsage(records);
  }
  return {
    id: task.id, status: task.status, createdAt: task.createdAt,
    completedAt: accepted?.at ?? null, acceptedBy: accepted?.actor ?? null,
    cycleMs: accepted ? Date.parse(accepted.at) - Date.parse(task.createdAt) : null,
    ...(accepted ? {
      readyToAcceptanceMs: Number.isFinite(readyToAcceptanceMs) && readyToAcceptanceMs >= 0 ? readyToAcceptanceMs : null,
      acceptedOnFirstSubmission: submissions ? submissions === 1 && !returns.length : null,
    } : {}),
    timeByStatusMs,
    ...(timeByStatusMs && !accepted ? { observedAt: new Date(now).toISOString() } : {}),
    submissions,
    returns: returns.length,
    reviewerReturns: returns.filter(event => event.actor === "reviewer").length,
    ...(starts.length ? { starts } : {}),
    ...(runLogs.length ? { executorRuns: {
      recorded: runLogs.length, timed: durations.length,
      durationMs: durations.length ? durations.reduce((total, duration) => total + duration, 0) : null,
    } } : {}),
    reviews: reviewMetrics(task),
    tokens: {
      ...summarizeTokenUsage(task.tokenUsage?.byModel ?? []),
      byRole,
    },
  };
}
