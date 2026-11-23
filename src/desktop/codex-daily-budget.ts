import { dirname, join } from "node:path";
import { directory, exists, readJson, withLock, writeJson } from "../cli/storage.ts";
import type { TaskUsageRole, TokenUsageReport } from "../cli/token-usage.ts";
import { uncachedTokens, type ConfirmedTurnUsage } from "./codex-token-usage.ts";

export type CodexBudgetRole = TaskUsageRole | "manager" | "background" | "draft";
type Charge = {
  reportId: string;
  sequence: number;
  role: CodexBudgetRole;
  task?: string;
  completedAt: number;
  tokens: number | null;
  excludesCache?: true;
};

function dayPath(project: string, at: number) {
  const date = new Date(at);
  const key = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join("-");
  return join(project, ".tasks", "codex-daily-usage", key + ".json");
}

function readCharges(path: string): Record<string, Charge> {
  return exists(path) ? readJson(path) as Record<string, Charge> : {};
}

export function recordCodexDailyUsage(project: string, role: CodexBudgetRole, report: TokenUsageReport, task?: string) {
  const entries = new Map<string, Map<string, Charge>>();
  for (const record of report.records) {
    if (record.completedAt === undefined || record.dailyTokens === undefined) continue;
    const path = dayPath(project, record.completedAt);
    const charges = entries.get(path) ?? new Map<string, Charge>();
    entries.set(path, charges);
    const key = JSON.stringify([record.threadId, record.turnId]);
    const previous = charges.get(key);
    // Older queued reports produced a gross total. Only a complete legacy
    // breakdown can establish that no cache delta was lost.
    const amount = record.dailyTokensExcludeCache ? record.dailyTokens :
      !record.incomplete && record.dailyTokens !== null && record.dailyTokens === record.totalTokens
        ? uncachedTokens(record) : null;
    const tokens = previous?.tokens === null || amount === null
      ? null
      : (previous?.tokens ?? 0) + amount;
    charges.set(key, {
      reportId: report.id, sequence: report.sequence, role, task, completedAt: record.completedAt,
      tokens, excludesCache: true,
    });
  }
  if (!entries.size) return false;
  const folder = join(project, ".tasks", "codex-daily-usage");
  directory(folder, true);
  return withLock(folder, () => {
    let changed = false;
    for (const [path, updates] of entries) {
      const charges = readCharges(path);
      let dirty = false;
      for (const [key, charge] of updates) {
        const previous = charges[key];
        if (previous) {
          const sameReport = previous.reportId === charge.reportId;
          const upgradesLegacy = sameReport && !previous.excludesCache && charge.tokens !== null;
          if (sameReport && previous.sequence > charge.sequence) continue;
          if (sameReport && previous.sequence === charge.sequence && !upgradesLegacy) continue;
          if (previous.tokens !== null && !upgradesLegacy && (!sameReport || !previous.excludesCache)) continue;
        }
        charges[key] = charge;
        dirty = true;
      }
      if (dirty) {
        writeJson(path, charges);
        changed = true;
      }
    }
    return changed;
  }, 0);
}

export function codexDailyBudget(project: string, limit: number, now = Date.now()) {
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0);
  const charges = Object.values(readCharges(dayPath(project, now)));
  const spent = charges.reduce((sum, charge) => sum + (charge.tokens ?? 0), 0);
  const reason = spent >= limit ? "exhausted" : undefined;
  return { limit, spent, remaining: Math.max(0, limit - spent), resetsAt: reset.getTime(), reason };
}

type LiveJournal = {
  resets: number[];
  turns: Record<string, Pick<ConfirmedTurnUsage, "tokens" | "counters"> & {
    periods: Record<string, number>;
    completedAt?: number;
  }>;
  periods: Record<string, number>;
};

export class BoardCodexUsage {
  private readonly project: string;
  private readonly path: string;
  private readonly journal: LiveJournal;
  private legacy?: { path: string; period: number; spent: number; charges: Record<string, Charge> };
  private legacyDirty = false;
  private timer?: NodeJS.Timeout;
  private dirty = false;

  constructor(project: string) {
    this.project = project;
    this.path = join(project, ".tasks", "codex-daily-usage", "live.json");
    this.journal = exists(this.path) ? readJson(this.path) as LiveJournal : {
      resets: [], turns: {}, periods: {},
    };
  }

  private period(at: number) {
    const midnight = new Date(at).setHours(0, 0, 0, 0);
    const reset = this.journal.resets.findLast(value => value <= at);
    return Math.max(midnight, reset ?? 0);
  }

  private legacyDay(at: number) {
    const path = dayPath(this.project, at);
    const period = this.period(at);
    if (this.legacy?.path !== path || this.legacy.period !== period || this.legacyDirty) {
      try {
        const charges = this.legacy?.path === path && !this.legacyDirty ? this.legacy.charges : readCharges(path);
        const spent = Object.values(charges).reduce((sum, charge) =>
          charge.completedAt >= period ? sum + (charge.tokens ?? 0) : sum, 0);
        this.legacy = { path, period, spent, charges };
        this.legacyDirty = false;
      } catch (error) {
        if (this.legacy?.path !== path) throw error;
      }
    }
    return this.legacy;
  }

  get(projectLimit: number, now = Date.now()) {
    const spent = this.legacyDay(now).spent + (this.journal.periods[this.period(now)] ?? 0);
    return {
      limit: projectLimit,
      spent,
      remaining: Math.max(0, projectLimit - spent),
      resetsAt: new Date(now).setHours(24, 0, 0, 0),
      reason: spent >= projectLimit ? "exhausted" as const : undefined,
    };
  }

  recover(threadId: string, turnId: string) {
    const previous = this.journal.turns[JSON.stringify([threadId, turnId])];
    if (previous?.counters) return { tokens: previous.tokens, counters: previous.counters };
  }

  observe({ threadId, turnId, tokens, observedAt, counters }: ConfirmedTurnUsage) {
    const key = JSON.stringify([threadId, turnId]);
    const turn = this.journal.turns[key] ?? {
      tokens: this.legacyDay(observedAt).charges[key]?.tokens ?? 0, periods: {},
    };
    if (tokens <= turn.tokens) return false;
    const period = this.period(turn.completedAt ?? observedAt);
    const increment = tokens - turn.tokens;
    turn.tokens = tokens;
    if (turn.completedAt === undefined && counters) turn.counters = counters;
    turn.periods[period] = (turn.periods[period] ?? 0) + increment;
    this.journal.turns[key] = turn;
    this.journal.periods[period] = (this.journal.periods[period] ?? 0) + increment;
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), 2_000);
    return true;
  }

  reconcile(report: TokenUsageReport): TokenUsageReport {
    const records = report.records.filter(record => {
      const key = JSON.stringify([record.threadId, record.turnId]);
      const turn = this.journal.turns[key];
      if (!turn) return true;
      if (record.completedAt !== undefined) {
        if (turn.completedAt !== record.completedAt) {
          turn.completedAt = record.completedAt;
          this.dirty = true;
          // A terminal time can establish that a delayed increment happened
          // before a boundary we previously crossed using receipt time.
          const period = this.period(record.completedAt);
          for (const [source, amount] of Object.entries(turn.periods)) {
            if (Number(source) <= period) continue;
            delete turn.periods[source];
            turn.periods[period] = (turn.periods[period] ?? 0) + amount;
            this.journal.periods[source] -= amount;
            this.journal.periods[period] = (this.journal.periods[period] ?? 0) + amount;
          }
        }
        if (record.dailyTokensExcludeCache && record.dailyTokens != null) {
          this.observe({ ...record, tokens: record.dailyTokens, observedAt: record.completedAt });
        }
        if (turn.counters) {
          delete turn.counters;
          this.dirty = true;
        }
      }
      return false;
    });
    this.flush();
    return { ...report, records };
  }

  invalidateLegacy() {
    this.legacyDirty = true;
  }

  reset(now = Date.now()) {
    this.journal.resets.push(now);
    this.dirty = true;
    if (!this.flush()) {
      this.journal.resets.pop();
      throw new Error("Could not save the board budget reset.");
    }
    this.legacy = undefined;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return true;
    try {
      directory(dirname(this.path), true);
      writeJson(this.path, this.journal);
      this.dirty = false;
      return true;
    } catch (error) {
      console.warn("Could not save confirmed board Codex usage.", error);
      this.timer = setTimeout(() => this.flush(), 5_000);
      this.timer.unref();
      return false;
    }
  }
}
