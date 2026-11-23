import { randomUUID } from "node:crypto";
import { emptyTokenCounts, tokenFields, usageKey } from "../cli/token-usage.ts";
import type { TokenCounts, TokenUsageRecord, TokenUsageReport } from "../cli/token-usage.ts";

type ThreadUsage = {
  model: string | null;
  turnId?: string;
  previous?: TokenCounts;
  incomplete: boolean;
  finished: boolean;
  completedAt?: number;
  totalUncertain?: boolean;
  cacheUncertain?: boolean;
  cacheGap?: { entry: TokenUsageRecord; before: number | null | undefined };
};

type TurnUsageStatus = { id: string; status?: string; completedAt?: number | null };

export function uncachedTokens({ totalTokens, cachedInputTokens }: TokenCounts): number | null {
  if (totalTokens === null || cachedInputTokens === null || cachedInputTokens > totalTokens) return null;
  return totalTokens - cachedInputTokens;
}

function usageDelta(current: number | null, before: number | null | undefined, last: number | null): number | null {
  if (current === null) return null;
  const baseline = before === undefined ? last : before === null ? null : current - before;
  return baseline !== null && baseline >= 0 && baseline <= current ? baseline : null;
}

function counts(value: unknown): TokenCounts {
  const data = value as Partial<TokenCounts> | undefined;
  const result = emptyTokenCounts();
  for (const key of tokenFields) {
    const count = data?.[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  if (result.inputTokens !== null && [result.cachedInputTokens, result.cacheWriteInputTokens].some(value => value !== null && value > result.inputTokens!) ||
      result.outputTokens !== null && result.reasoningOutputTokens !== null && result.reasoningOutputTokens > result.outputTokens) return emptyTokenCounts();
  return result;
}

// One collector per App Server invocation. Thread totals survive turns; records
// contain only this invocation's deltas, never a resumed thread's old consumption.
export class CodexTokenUsage {
  private id = randomUUID();
  private sequence = 0;
  private threads = new Map<string, ThreadUsage>();
  private records = new Map<string, TokenUsageRecord>();
  private root?: string;
  private pending?: TokenUsageReport;
  private saving?: Promise<void>;
  private checkpoint?: NodeJS.Timeout;

  queue(report: TokenUsageReport | undefined, write?: (report: TokenUsageReport) => Promise<void>): void {
    if (!report || !write) return;
    this.pending = report;
    this.checkpoint ??= setTimeout(() => { void this.save(undefined, write); }, 5_000);
  }

  save(report: TokenUsageReport | undefined, write?: (report: TokenUsageReport) => Promise<void>): Promise<void> | undefined {
    if (!write) return;
    clearTimeout(this.checkpoint);
    this.checkpoint = undefined;
    if (report) this.pending = report;
    if (!this.saving && this.pending) {
      this.saving = Promise.resolve().then(async () => {
        while (this.pending) {
          const snapshot = this.pending;
          this.pending = undefined;
          try {
            await write(snapshot);
          } catch {
            console.warn("Could not save Codex token usage.");
          }
        }
        this.saving = undefined;
      });
    }
    return this.saving;
  }

  track(threadId: string, model: string | null, root = false): boolean {
    if (root) this.root = threadId;
    const existing = this.threads.get(threadId);
    if (existing) {
      if (!model || existing.model === model) return false;
      if (existing.model === null) {
        for (const [key, entry] of this.records) {
          if (entry.threadId !== threadId || entry.model !== null) continue;
          this.records.delete(key);
          entry.model = model;
          entry.incomplete = existing.incomplete || tokenFields.some(field => entry[field] === null);
          this.records.set(usageKey(entry), entry);
        }
      }
      existing.model = model;
    } else {
      const thread = { model, incomplete: false, finished: false };
      this.threads.set(threadId, thread);
      const rootTurn = this.root && this.threads.get(this.root)?.turnId;
      if (!root && rootTurn) this.entry(threadId, { ...thread, turnId: "unreported:" + rootTurn });
    }
    return true;
  }

  begin(threadId: string, turnId: string): TokenUsageReport | undefined {
    const thread = this.threads.get(threadId);
    if (!thread || !turnId || thread.turnId === turnId) return;
    for (const [key, entry] of this.records) {
      if (entry.threadId === threadId && entry.turnId.startsWith("unreported:")) this.records.delete(key);
    }
    thread.turnId = turnId;
    thread.incomplete = false;
    thread.finished = false;
    thread.completedAt = undefined;
    thread.totalUncertain = false;
    thread.cacheUncertain = false;
    thread.cacheGap = undefined;
    this.entry(threadId, thread);
    return this.snapshot();
  }

  recover(threadId: string, turn: TurnUsageStatus): TokenUsageReport | undefined {
    this.begin(threadId, turn.id);
    const thread = this.threads.get(threadId);
    if (!thread || thread.turnId !== turn.id) return;
    // History confirms completion, but does not reconstruct the usage stream.
    thread.totalUncertain = true;
    thread.incomplete = true;
    return this.completeTurn(threadId, turn) ?? this.snapshot();
  }

  completeTurn(threadId: string, turn: TurnUsageStatus, observedAt?: number): TokenUsageReport | undefined {
    const thread = this.threads.get(threadId);
    if (!thread || thread.turnId !== turn.id || turn.status === "inProgress") return;
    thread.finished = true;
    const ended = turn.completedAt;
    thread.completedAt ??= typeof ended === "number" && ended > 0 && ended < 8.64e12
      ? Math.trunc(ended * 1000) : observedAt;
    if (thread.completedAt !== undefined) this.completeRecords(threadId, thread, thread.completedAt);
    return this.snapshot();
  }

  private entry(threadId: string, thread: ThreadUsage): TokenUsageRecord {
    const value = { ...emptyTokenCounts(), threadId, turnId: thread.turnId!, model: thread.model, incomplete: true };
    const key = usageKey(value);
    if (!this.records.has(key)) this.records.set(key, value);
    return this.records.get(key)!;
  }

  private completeRecords(threadId: string, thread: ThreadUsage, at: number): void {
    for (const entry of this.records.values()) {
      if (entry.threadId !== threadId || entry.turnId !== thread.turnId) continue;
      entry.completedAt ??= at;
      entry.dailyTokens = thread.totalUncertain || thread.cacheUncertain || thread.cacheGap
        ? null : uncachedTokens(entry);
      entry.dailyTokensExcludeCache = true;
    }
  }

  observe(message: { method?: string; params?: unknown }): TokenUsageReport | undefined {
    const data = message.params as {
      threadId?: string; turnId?: string; turn?: TurnUsageStatus; toModel?: string;
      thread?: { id: string; parentThreadId?: string; model?: string };
      threadSettings?: { model?: string };
      item?: { type?: string; kind?: string; tool?: string; agentThreadId?: string; model?: string; receiverThreadIds?: string[] };
      tokenUsage?: { total?: unknown; last?: unknown };
    } | undefined;
    if (!data) return;
    if (message.method === "thread/started" && data.thread?.parentThreadId && this.threads.has(data.thread.parentThreadId)) {
      if (this.track(data.thread.id, data.thread.model ?? null)) return this.snapshot();
    }
    const threadId = data.threadId;
    const thread = threadId ? this.threads.get(threadId) : undefined;
    if (!thread || !threadId) return;
    const item = data.item;
    let discovered = false;
    if (["item/started", "item/completed"].includes(message.method ?? "")) {
      if (item?.type === "subAgentActivity" && item.agentThreadId) discovered = this.track(item.agentThreadId, item.model ?? null);
      if (item?.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
        for (const id of item.receiverThreadIds ?? []) discovered = this.track(id, null) || discovered;
      }
    }
    if (discovered) return this.snapshot();
    if (message.method === "turn/started" && data.turn?.id) return this.begin(threadId, data.turn.id);
    if (message.method === "model/rerouted" && data.turnId && data.turnId !== thread.turnId) return;
    const model = message.method === "model/rerouted" ? data.toModel :
      message.method === "thread/settings/updated" ? data.threadSettings?.model : undefined;
    if (model) {
      // A route selected before any usage does not leave a fictitious unknown charge.
      for (const [key, entry] of this.records) {
        if (entry.threadId === threadId && entry.turnId === thread.turnId && tokenFields.every(field => entry[field] === null)) this.records.delete(key);
      }
      thread.model = model;
      if (thread.turnId) this.entry(threadId, thread);
      return this.snapshot();
    }
    if ((message.method === "error" || message.method === "turn/completed" &&
        data.turn?.id === thread.turnId && ["failed", "interrupted"].includes(data.turn?.status ?? "")) && thread.turnId) {
      thread.incomplete = true;
      this.entry(threadId, thread).incomplete = true;
      if (message.method === "error") return this.snapshot();
    }
    if (message.method === "turn/completed" && data.turn?.id) return this.completeTurn(threadId, data.turn, Date.now());
    if (message.method !== "thread/tokenUsage/updated" || !data.turnId) return;
    // Child turns can start before their discovery event reaches the parent.
    if (!thread.turnId && threadId !== this.root) this.begin(threadId, data.turnId);
    if (data.turnId !== thread.turnId) return;
    const total = counts(data.tokenUsage?.total);
    const last = counts(data.tokenUsage?.last);
    const entry = this.entry(threadId, thread);
    const gap = thread.cacheGap;
    const previous = thread.previous;
    // A retransmitted snapshot can fill in the last missing cache delta.
    // A later sample with additional spend cannot establish a missing baseline.
    const repairsCache = gap?.entry === entry && previous && total.totalTokens !== null &&
      previous.totalTokens === total.totalTokens &&
      usageDelta(total.cachedInputTokens, gap.before, last.cachedInputTokens) !== null &&
      tokenFields.every(key => key === "cachedInputTokens" || previous[key] === null || total[key] === previous[key]);
    if (!repairsCache && previous && tokenFields.every(key => total[key] === previous[key])) return;
    if (gap && !repairsCache) thread.cacheUncertain = true;
    thread.cacheGap = undefined;
    for (const key of tokenFields) {
      if (repairsCache && key !== "cachedInputTokens") continue;
      const current = total[key];
      const before = repairsCache ? gap.before : thread.previous?.[key];
      const delta = usageDelta(current, before, last[key]);
      if (delta === null || !Number.isSafeInteger((entry[key] ?? 0) + delta)) {
        thread.incomplete = true;
        if (key === "totalTokens") thread.totalUncertain = true;
        if (key === "cachedInputTokens") thread.cacheGap = { entry, before };
      } else {
        entry[key] = (entry[key] ?? 0) + delta;
      }
    }
    thread.previous = total;
    if (thread.completedAt !== undefined) {
      this.completeRecords(threadId, thread, thread.completedAt);
    }
    entry.incomplete = thread.incomplete || thread.model === null || tokenFields.some(key => entry[key] === null);
    return this.snapshot();
  }

  finish(incomplete = false): TokenUsageReport | undefined {
    const root = this.root ? this.threads.get(this.root) : undefined;
    if (!root?.turnId) return;
    for (const [threadId, thread] of this.threads) {
      if (!thread.turnId) {
        thread.turnId = "unreported:" + root.turnId;
      }
      const entry = this.entry(threadId, thread);
      entry.incomplete ||= incomplete && !thread.finished;
      if (!thread.finished && threadId !== this.root && root.completedAt !== undefined) {
        // A child with no terminal notification leaves the parent run's spend uncertain.
        thread.totalUncertain = true;
        this.completeRecords(threadId, thread, root.completedAt);
      }
    }
    return this.snapshot();
  }

  private snapshot(): TokenUsageReport | undefined {
    if (!this.records.size) return;
    return { id: this.id, sequence: ++this.sequence, records: [...this.records.values()].map(entry => ({ ...entry })) };
  }
}
