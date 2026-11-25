import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
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
  confirmed?: { baseline: number; tokens: number; total: number; cached: number };
  recovered?: boolean;
};

export type TurnUsageStatus = { id: string; status?: string; completedAt?: number | null };

export function isTerminalUsageStatus(status: string | undefined) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

export type ConfirmedTurnUsage = {
  threadId: string;
  turnId: string;
  tokens: number;
  observedAt: number;
  counters?: TokenCounts;
  historical?: true;
};

export type UsageWriter = ((report: TokenUsageReport) => Promise<void>) & {
  observe?: (usage: ConfirmedTurnUsage) => void;
  recover?: (threadId: string, turnId: string) => { tokens: number; counters: TokenCounts } | undefined;
};

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

function rolloutCounts(value: Record<string, number> | undefined) {
  return counts({
    inputTokens: value?.input_tokens,
    cachedInputTokens: value?.cached_input_tokens,
    cacheWriteInputTokens: value?.cache_write_input_tokens,
    outputTokens: value?.output_tokens,
    reasoningOutputTokens: value?.reasoning_output_tokens,
    totalTokens: value?.total_tokens,
  });
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
  private readonly observeConfirmed?: UsageWriter["observe"];
  private readonly recoverConfirmed?: UsageWriter["recover"];

  constructor(observeConfirmed?: UsageWriter["observe"], recoverConfirmed?: UsageWriter["recover"]) {
    this.observeConfirmed = observeConfirmed;
    this.recoverConfirmed = recoverConfirmed;
  }

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
    const recovered = this.recoverConfirmed?.(threadId, turnId);
    const previous = recovered?.counters ?? thread.previous;
    const raw = previous && uncachedTokens(previous);
    thread.confirmed = raw != null ? {
      baseline: raw - (recovered?.tokens ?? 0), tokens: recovered?.tokens ?? 0,
      total: previous!.totalTokens!, cached: previous!.cachedInputTokens!,
    } : undefined;
    thread.recovered = Boolean(recovered);
    if (recovered) {
      thread.previous = recovered.counters;
      thread.totalUncertain = true;
      thread.incomplete = true;
    }
    this.entry(threadId, thread);
    return this.snapshot();
  }

  recover(threadId: string, turn: TurnUsageStatus): TokenUsageReport | undefined {
    const alreadyTracked = this.threads.get(threadId)?.turnId === turn.id;
    if (!alreadyTracked) this.begin(threadId, turn.id);
    const thread = this.threads.get(threadId);
    if (!thread || thread.turnId !== turn.id) return;
    // History confirms completion, but does not reconstruct the usage stream.
    if (!alreadyTracked && !thread.recovered) {
      thread.totalUncertain = true;
      thread.incomplete = true;
    }
    const report = this.completeTurn(threadId, turn) ?? this.snapshot();
    // History can confirm the end without another token event or a timestamp.
    if (!alreadyTracked && isTerminalUsageStatus(turn.status)) {
      const checkpoint = this.recoverConfirmed?.(threadId, turn.id);
      const record = report?.records.find(entry => entry.threadId === threadId && entry.turnId === turn.id);
      if (record && checkpoint) record.dailyTokens = checkpoint.tokens;
    }
    return report;
  }

  async recoverRollout(path: string | null | undefined, threadId: string, turn: TurnUsageStatus) {
    if (!path || !isAbsolute(path) || !this.observeConfirmed) return;
    const current = this.threads.get(threadId);
    if (turn.status === "completed" && current?.turnId === turn.id && current.completedAt !== undefined &&
        !current.totalUncertain && !current.cacheUncertain && !current.cacheGap && current.confirmed?.tokens) return;
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    const checkpoint = this.recoverConfirmed?.(threadId, turn.id);
    const baseline = checkpoint && uncachedTokens(checkpoint.counters);
    let previous: TokenCounts | undefined;
    let hasEarlierSample = false;
    let checkpointTokens: number | undefined;
    const recovered = new CodexTokenUsage(sample => {
      let tokens = sample.tokens;
      if (checkpoint && baseline != null && sample.counters) {
        const { totalTokens, cachedInputTokens } = sample.counters;
        const priorTotal = checkpoint.counters.totalTokens!;
        const priorCached = checkpoint.counters.cachedInputTokens!;
        if (totalTokens !== null && cachedInputTokens !== null) {
          if (totalTokens <= priorTotal && cachedInputTokens <= priorCached && totalTokens < priorTotal) {
            hasEarlierSample = true;
          }
          const increase = totalTokens - cachedInputTokens - baseline;
          if (totalTokens >= priorTotal && cachedInputTokens >= priorCached && increase >= 0) {
            const confirmed = checkpoint.tokens + increase;
            if (Number.isSafeInteger(confirmed)) {
              // A fragment's last count can overlap the saved checkpoint.
              // Keep an independently reconstructed prefix when available.
              if (previous || hasEarlierSample) {
                tokens = Math.max(tokens, confirmed);
              } else {
                tokens = checkpointTokens = confirmed;
              }
            }
          }
        }
      }
      this.observeConfirmed?.({ ...sample, tokens, historical: true });
    });
    recovered.track(threadId, current?.model ?? null, true);
    let verified = false;
    let active: string | undefined;
    let firstTurn: string | undefined;
    let found = false;
    let status = turn.status;
    let completedAt = turn.completedAt;
    let observedAt: number | undefined;
    try {
      for await (const line of lines) {
        const { type, timestamp, payload } = JSON.parse(line) as {
          type?: string; timestamp?: string;
          payload?: {
            id?: string; type?: string; turn_id?: string;
            info?: { total_token_usage?: Record<string, number>; last_token_usage?: Record<string, number> };
          };
        };
        if (!verified) {
          if (type !== "session_meta" || payload?.id !== threadId) return;
          verified = true;
          continue;
        }
        const event = type === "event_msg" ? payload?.type : undefined;
        const id = payload?.turn_id;
        if (id && (event === "task_started" || type === "turn_context")) {
          if (found && id !== turn.id) break;
          active = id;
          if (event === "task_started") firstTurn ??= id;
          if (id === turn.id && !found) {
            found = true;
            recovered.threads.get(threadId)!.previous = previous;
            recovered.begin(threadId, id);
            if (!previous && firstTurn !== id) {
              const usage = recovered.threads.get(threadId)!;
              usage.totalUncertain = true;
              usage.incomplete = true;
            }
          }
        }
        const terminalEvent = event === "task_complete" || event === "turn_aborted";
        if (id && terminalEvent && (id === active || id === turn.id && !found)) {
          active = undefined;
          const at = Date.parse(timestamp ?? "");
          if (id === turn.id) {
            if (!found) {
              found = true;
              recovered.begin(threadId, id);
            }
            if (Number.isFinite(at)) completedAt ??= at / 1000;
            if (!isTerminalUsageStatus(turn.status)) {
              status = event === "turn_aborted" ? "interrupted" : "completed";
            }
          }
        }
        if (event !== "token_count" || !active || !payload?.info) continue;
        const total = rolloutCounts(payload.info.total_token_usage);
        if (active !== turn.id) {
          if (uncachedTokens(total) !== null) previous = total;
          continue;
        }
        const at = Date.parse(timestamp ?? "");
        if (!Number.isFinite(at) || observedAt !== undefined && at < observedAt) continue;
        observedAt = at;
        recovered.observe({
          method: "thread/tokenUsage/updated",
          params: { threadId, turnId: active, tokenUsage: { total, last: rolloutCounts(payload.info.last_token_usage) } },
        }, at);
      }
    } catch {
      // The file can be missing, truncated, or still being appended. Keep the
      // confirmed samples already read and leave the rest for a later pass.
    } finally {
      lines.close();
      input.destroy();
    }
    if (found) {
      const report = recovered.completeTurn(threadId, { ...turn, status, completedAt }) ?? recovered.finish(true);
      for (const record of report?.records ?? []) {
        if (!record.dailyTerminal) {
          record.dailyRecoveryPending = true;
        } else if (observedAt === undefined && checkpoint) {
          record.dailyTokens = checkpoint.tokens;
        } else if (checkpointTokens !== undefined && record.dailyTokens != null) {
          record.dailyTokens = checkpointTokens;
        }
      }
      return report;
    }
  }

  completeTurn(threadId: string, turn: TurnUsageStatus, observedAt?: number): TokenUsageReport | undefined {
    const thread = this.threads.get(threadId);
    if (!thread || thread.turnId !== turn.id || !isTerminalUsageStatus(turn.status)) return;
    thread.finished = true;
    if (turn.status === "interrupted" || turn.status === "failed") {
      thread.incomplete = true;
      this.entry(threadId, thread).incomplete = true;
    }
    const ended = turn.completedAt;
    thread.completedAt ??= typeof ended === "number" && ended > 0 && ended < 8.64e12
      ? Math.trunc(ended * 1000) : observedAt;
    this.completeRecords(threadId, thread, thread.completedAt);
    return this.snapshot();
  }

  private entry(threadId: string, thread: ThreadUsage): TokenUsageRecord {
    const value = { ...emptyTokenCounts(), threadId, turnId: thread.turnId!, model: thread.model, incomplete: true };
    const key = usageKey(value);
    if (!this.records.has(key)) this.records.set(key, value);
    return this.records.get(key)!;
  }

  private completeRecords(threadId: string, thread: ThreadUsage, at?: number): void {
    for (const entry of this.records.values()) {
      if (entry.threadId !== threadId || entry.turnId !== thread.turnId) continue;
      entry.completedAt ??= at;
      entry.dailyTokens = thread.totalUncertain || thread.cacheUncertain || thread.cacheGap
        ? null : uncachedTokens(entry);
      entry.dailyTokensExcludeCache = true;
      entry.dailyTerminal = thread.finished ? true : undefined;
    }
  }

  private publishConfirmed(threadId: string, thread: ThreadUsage, total: TokenCounts,
    previous: TokenCounts | undefined, last: TokenCounts, repair: boolean, observedAt: number) {
    if (!this.observeConfirmed) return;
    const { totalTokens, cachedInputTokens } = total;
    if (totalTokens === null || cachedInputTokens === null || cachedInputTokens > totalTokens) return;
    const raw = totalTokens - cachedInputTokens;
    const seeded = !thread.confirmed;
    if (!thread.confirmed) {
      // The first complete sample can establish the beginning only when Codex
      // also reports the matching increment, or when it repairs that sample.
      const reported = repair ? this.entry(threadId, thread) : last;
      const trustworthy = !thread.totalUncertain && !thread.cacheUncertain && !thread.cacheGap &&
        (!previous || repair) && (reported.totalTokens ?? Infinity) <= totalTokens &&
        (reported.cachedInputTokens ?? Infinity) <= cachedInputTokens;
      const increment = trustworthy ? uncachedTokens(reported) ?? 0 : 0;
      thread.confirmed = { baseline: raw - increment, tokens: 0, total: totalTokens, cached: cachedInputTokens };
    }
    if (totalTokens < thread.confirmed.total || cachedInputTokens < thread.confirmed.cached) return;
    const tokens = raw - thread.confirmed.baseline;
    if (!Number.isSafeInteger(tokens) || tokens < thread.confirmed.tokens) return;
    if (!seeded && tokens === thread.confirmed.tokens && totalTokens === thread.confirmed.total) return;
    Object.assign(thread.confirmed, { tokens, total: totalTokens, cached: cachedInputTokens });
    this.observeConfirmed({ threadId, turnId: thread.turnId!, tokens, observedAt, counters: total });
  }

  observe(message: { method?: string; params?: unknown }, observedAt = Date.now()): TokenUsageReport | undefined {
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
    if (message.method === "turn/completed" && data.turn?.id) return this.completeTurn(threadId, data.turn, observedAt);
    if (message.method !== "thread/tokenUsage/updated" || !data.turnId) return;
    // Child turns can start before their discovery event reaches the parent.
    if (!thread.turnId && threadId !== this.root) this.begin(threadId, data.turnId);
    if (data.turnId !== thread.turnId) return;
    const total = counts(data.tokenUsage?.total);
    const last = counts(data.tokenUsage?.last);
    const entry = this.entry(threadId, thread);
    const gap = thread.cacheGap;
    const previous = thread.previous;
    const sameSample = previous && total.totalTokens !== null &&
      previous.totalTokens === total.totalTokens &&
      tokenFields.every(key => key === "cachedInputTokens" || previous[key] === null || total[key] === previous[key]);
    // A cumulative cache baseline remains valid across missing samples for the
    // same model. Without one, only a retransmission can repair the first sample.
    const continuesGap = gap?.entry === entry && (typeof gap.before === "number" || sameSample);
    const repairsCache = continuesGap && usageDelta(total.cachedInputTokens, gap.before, last.cachedInputTokens) !== null;
    if (!repairsCache && previous && tokenFields.every(key => total[key] === previous[key])) return;
    if (gap && !continuesGap) thread.cacheUncertain = true;
    thread.cacheGap = undefined;
    for (const key of tokenFields) {
      if (repairsCache && sameSample && key !== "cachedInputTokens") continue;
      const current = total[key];
      const before = continuesGap && key === "cachedInputTokens" ? gap.before : previous?.[key];
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
    if (thread.finished || thread.completedAt !== undefined) {
      this.completeRecords(threadId, thread, thread.completedAt);
    }
    entry.incomplete = thread.incomplete || thread.model === null || tokenFields.some(key => entry[key] === null);
    this.publishConfirmed(threadId, thread, total, previous, last, Boolean(repairsCache && sameSample), observedAt);
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
