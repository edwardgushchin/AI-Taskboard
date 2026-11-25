import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultCodexDailyResetTime } from "../cli/model.ts";
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

type TurnCharge = Pick<ConfirmedTurnUsage, "tokens" | "counters"> & {
  counterTokens?: number;
  completedAt?: number;
  latestAt?: number;
  recoveryPending?: boolean;
};
type RecoveryCharge = { threadId: string; turnId: string; completedAt?: number; role?: CodexBudgetRole; task?: string };
type PendingTurn = TurnCharge & { increments: { at: number; tokens: number }[] };
type OldJournal = {
  resets: number[];
  turns: Record<string, TurnCharge & { periods: Record<string, number> }>;
};

function dailyWindow(at: number, resetTime: string) {
  const [hour, minute] = resetTime.split(":").map(Number);
  const today = new Date(at);
  const boundary = today.setHours(hour, minute, 0, 0);
  const other = new Date(at);
  other.setDate(other.getDate() + (at < boundary ? -1 : 1));
  const neighbor = other.setHours(hour, minute, 0, 0);
  return at < boundary ? { startsAt: neighbor, resetsAt: boundary } : { startsAt: boundary, resetsAt: neighbor };
}

export class BoardCodexUsage {
  private readonly project: string;
  private readonly folder: string;
  private readonly path: string;
  private readonly pending = new Map<string, PendingTurn>();
  private balance?: { startsAt: number; resetsAt: number; spent: number; resetTime: string };
  private initialized = false;
  private timer?: NodeJS.Timeout;

  constructor(project: string) {
    this.project = project;
    this.folder = join(project, ".tasks", "codex-daily-usage");
    this.path = join(this.folder, "usage.sqlite");
  }

  private database<T>(action: (db: DatabaseSync) => T): T {
    if (!this.initialized) directory(this.folder, true);
    const db = new DatabaseSync(this.path);
    try {
      if (!this.initialized) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS turns (
            id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, counters TEXT, completed INTEGER
          );
          CREATE TABLE IF NOT EXISTS increments (turn TEXT NOT NULL, at INTEGER NOT NULL, tokens INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS increments_by_time ON increments(at);
          CREATE INDEX IF NOT EXISTS increments_by_turn ON increments(turn, at);
          CREATE TABLE IF NOT EXISTS resets (at INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS migration (version INTEGER PRIMARY KEY);
        `);
        const old = join(this.folder, "live.json");
        if (exists(old) && !db.prepare("SELECT 1 FROM migration WHERE version = 1").get()) {
          this.transaction(db, () => {
            if (db.prepare("SELECT 1 FROM migration WHERE version = 1").get()) return;
            const journal = readJson(old) as OldJournal;
            const insert = db.prepare("INSERT INTO increments VALUES (?, ?, ?)");
            const save = db.prepare("INSERT OR IGNORE INTO turns (id, tokens, counters, completed) VALUES (?, ?, ?, ?)");
            for (const [key, turn] of Object.entries(journal.turns)) {
              save.run(key, turn.tokens, turn.counters ? JSON.stringify(turn.counters) : null, turn.completedAt ?? null);
              for (const [at, amount] of Object.entries(turn.periods)) insert.run(key, Number(at), amount);
            }
            const reset = db.prepare("INSERT OR IGNORE INTO resets VALUES (?)");
            for (const at of journal.resets) reset.run(at);
            db.exec("INSERT INTO migration VALUES (1)");
          });
        }
        if (!db.prepare("SELECT 1 FROM migration WHERE version = 2").get()) {
          this.transaction(db, () => {
            if (db.prepare("SELECT 1 FROM migration WHERE version = 2").get()) return;
            db.exec(`
              ALTER TABLE turns ADD COLUMN recovery_pending INTEGER NOT NULL DEFAULT 1;
              CREATE INDEX turns_pending_recovery ON turns(completed) WHERE recovery_pending = 1;
              INSERT INTO migration VALUES (2);
            `);
          });
        }
        if (!db.prepare("SELECT 1 FROM migration WHERE version = 3").get()) {
          this.transaction(db, () => {
            if (db.prepare("SELECT 1 FROM migration WHERE version = 3").get()) return;
            db.exec(`
              ALTER TABLE turns ADD COLUMN counter_tokens INTEGER;
              INSERT INTO migration VALUES (3);
            `);
          });
        }
        this.initialized = true;
      }
      return action(db);
    } finally {
      db.close();
    }
  }

  private transaction(db: DatabaseSync, action: () => void) {
    db.exec("BEGIN IMMEDIATE");
    try {
      action();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private storeTurn(db: DatabaseSync, key: string, turn: TurnCharge) {
    db.prepare(`INSERT INTO turns (id, tokens, counters, completed, recovery_pending, counter_tokens) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET tokens = excluded.tokens, counters = excluded.counters,
        completed = excluded.completed, recovery_pending = excluded.recovery_pending,
        counter_tokens = excluded.counter_tokens`)
      .run(key, turn.tokens, turn.counters ? JSON.stringify(turn.counters) : null, turn.completedAt ?? null,
        turn.recoveryPending === false ? 0 : 1, turn.counterTokens ?? null);
  }

  private readTurn(key: string): TurnCharge | undefined {
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (!this.initialized && !exists(this.path) && !exists(join(this.folder, "live.json"))) return;
    return this.database(db => {
      const row = db.prepare(`SELECT tokens, counters, completed, recovery_pending, counter_tokens,
        (SELECT MAX(at) FROM increments WHERE turn = turns.id) AS latest
        FROM turns WHERE id = ?`).get(key);
      if (row) return {
        tokens: row.tokens as number,
        counters: typeof row.counters === "string" ? JSON.parse(row.counters) as ConfirmedTurnUsage["counters"] : undefined,
        counterTokens: typeof row.counter_tokens === "number" ? row.counter_tokens : undefined,
        completedAt: typeof row.completed === "number" ? row.completed : undefined,
        latestAt: typeof row.latest === "number" ? row.latest : undefined,
        recoveryPending: row.recovery_pending === 1,
      };
    });
  }

  get(limit: number, now = Date.now(), resetTime = defaultCodexDailyResetTime) {
    let balance = this.balance;
    if (!balance || balance.resetTime !== resetTime || now < balance.startsAt || now >= balance.resetsAt) {
      const { startsAt, resetsAt } = dailyWindow(now, resetTime);
      const saved = this.database(db => {
        const start = Math.max(startsAt, (db.prepare("SELECT MAX(at) AS at FROM resets WHERE at <= ?")
          .get(now)?.at as number | null) ?? 0);
        const spent = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS spent FROM increments WHERE at >= ? AND at < ?")
          .get(start, resetsAt)?.spent as number;
        return { start, spent };
      });
      const paths = new Set([dayPath(this.project, saved.start), dayPath(this.project, resetsAt - 1)]);
      let spent = saved.spent;
      for (const path of paths) {
        for (const charge of Object.values(readCharges(path))) {
          if (charge.completedAt >= saved.start && charge.completedAt < resetsAt) spent += charge.tokens ?? 0;
        }
      }
      for (const turn of this.pending.values()) {
        for (const charge of turn.increments) {
          if (charge.at >= saved.start && charge.at < resetsAt) spent += charge.tokens;
        }
      }
      this.balance = balance = { startsAt: saved.start, resetsAt, spent, resetTime };
    }
    const { spent, resetsAt } = balance;
    return { limit, spent, remaining: Math.max(0, limit - spent), resetsAt,
      reason: spent >= limit ? "exhausted" as const : undefined };
  }

  recover(threadId: string, turnId: string) {
    const previous = this.readTurn(JSON.stringify([threadId, turnId]));
    if (previous?.counters) {
      return { tokens: previous.counterTokens ?? previous.tokens, counters: previous.counters };
    }
  }

  unresolved(now: number) {
    const previous = new Date(now);
    previous.setDate(previous.getDate() - 1);
    const since = previous.setHours(0, 0, 0, 0);
    const candidates = new Map<string, RecoveryCharge>();
    const paths = [dayPath(this.project, now), dayPath(this.project, previous.getTime())];
    for (const path of paths) {
      for (const [key, charge] of Object.entries(readCharges(path))) {
        if (charge.tokens !== null || this.readTurn(key)?.recoveryPending === false) continue;
        const [threadId, turnId] = JSON.parse(key) as [string, string];
        candidates.set(key, { ...charge, threadId, turnId });
      }
    }
    if (this.initialized || exists(this.path) || exists(join(this.folder, "live.json"))) {
      this.database(db => {
        const rows = db.prepare(`
          SELECT id, completed, completed AS recent FROM turns
          WHERE recovery_pending = 1 AND completed >= ?
          UNION ALL
          SELECT id, completed,
            (SELECT MAX(at) FROM increments WHERE turn = turns.id) AS recent FROM turns
          WHERE recovery_pending = 1 AND completed IS NULL AND recent >= ?
          ORDER BY recent, id
        `);
        for (const row of rows.iterate(since, since)) {
          const key = row.id as string;
          if (candidates.has(key)) continue;
          const [threadId, turnId] = JSON.parse(key) as [string, string];
          const completedAt = typeof row.completed === "number" ? row.completed : undefined;
          candidates.set(key, { threadId, turnId, completedAt });
        }
      });
    }
    return [...candidates.values()];
  }

  private refineTime(key: string, tokens: number, at: number) {
    if (tokens <= 0 || !this.flush()) return false;
    let changed = false;
    this.database(db => {
      const earlier = db.prepare("SELECT COALESCE(SUM(tokens), 0) AS spent FROM increments WHERE turn = ? AND at <= ?")
        .get(key, at)?.spent as number;
      let remaining = tokens - earlier;
      if (remaining <= 0) return;
      this.transaction(db, () => {
        const later = db.prepare("SELECT rowid, tokens FROM increments WHERE turn = ? AND at > ? ORDER BY at, rowid")
          .iterate(key, at);
        const reduce = db.prepare("UPDATE increments SET tokens = tokens - ? WHERE rowid = ?");
        const move = db.prepare("UPDATE increments SET at = ? WHERE rowid = ?");
        const insert = db.prepare("INSERT INTO increments VALUES (?, ?, ?)");
        for (const row of later) {
          const amount = row.tokens as number;
          const id = row.rowid as number;
          if (amount <= remaining) {
            move.run(at, id);
          } else {
            reduce.run(remaining, id);
            insert.run(key, at, remaining);
          }
          changed = true;
          remaining -= amount;
          if (remaining <= 0) break;
        }
      });
    });
    if (changed) this.balance = undefined;
    return changed;
  }

  observe({ threadId, turnId, tokens, observedAt, counters, historical }: ConfirmedTurnUsage) {
    const key = JSON.stringify([threadId, turnId]);
    const known = this.readTurn(key);
    const previousDay = new Date(observedAt);
    previousDay.setDate(previousDay.getDate() - 1);
    const previous = known?.tokens ?? (
      readCharges(dayPath(this.project, observedAt))[key]?.tokens ??
      readCharges(dayPath(this.project, previousDay.getTime()))[key]?.tokens ?? 0);
    const refined = historical && known?.latestAt !== undefined && known.latestAt > observedAt
      ? this.refineTime(key, Math.min(tokens, previous), observedAt)
      : false;
    const previousCounters = known?.counters;
    const updatesCounters = counters &&
      (counters.totalTokens ?? -1) >= (previousCounters?.totalTokens ?? 0) &&
      (counters.cachedInputTokens ?? -1) >= (previousCounters?.cachedInputTokens ?? 0) &&
      (counters.totalTokens !== previousCounters?.totalTokens ||
        counters.cachedInputTokens !== previousCounters?.cachedInputTokens ||
        tokens !== (known?.counterTokens ?? known?.tokens));
    if (tokens < previous || tokens === previous && !updatesCounters) return refined;
    const turn = this.pending.get(key) ?? { ...known, tokens: previous, increments: [] };
    const at = Math.min(turn.completedAt ?? observedAt, observedAt);
    const increment = tokens - previous;
    turn.tokens = tokens;
    if (updatesCounters) {
      turn.counters = counters;
      turn.counterTokens = tokens;
    }
    // The first confirmed baseline dates the turn even if it establishes no spend.
    if (increment > 0 || !known) {
      turn.increments.push({ at, tokens: increment });
      turn.latestAt = Math.max(turn.latestAt ?? at, at);
    }
    this.pending.set(key, turn);
    if (this.balance && at >= this.balance.startsAt && at < this.balance.resetsAt) this.balance.spent += increment;
    this.timer ??= setTimeout(() => this.flush(), 2_000).unref();
    return increment > 0 || refined;
  }

  reconcile(report: TokenUsageReport): TokenUsageReport {
    const completed = new Map<string, { at?: number; tokens: number; recoveryPending: boolean; terminal?: true }>();
    const records = report.records.filter(record => {
      const key = JSON.stringify([record.threadId, record.turnId]);
      if (!this.readTurn(key)) return true;
      if (record.completedAt !== undefined || record.dailyTerminal) {
        const group = completed.get(key) ?? { at: record.completedAt, tokens: 0, recoveryPending: false };
        if (record.dailyTokensExcludeCache && record.dailyTokens != null) {
          group.tokens += record.dailyTokens;
        } else {
          group.recoveryPending = true;
        }
        group.recoveryPending ||= record.dailyRecoveryPending === true;
        group.terminal ??= record.dailyTerminal;
        completed.set(key, group);
      }
      return false;
    });
    for (const [key, final] of completed) {
      const old = this.readTurn(key)!;
      const turn = this.pending.get(key) ?? { ...old, increments: [] };
      const wasClosed = turn.recoveryPending === false;
      // A complete checkpoint confirms the recorded amount even at zero.
      const knownSpend = turn.tokens > 0 || (turn.counters !== undefined && uncachedTokens(turn.counters) !== null);
      const recoveryPending = final.recoveryPending && !wasClosed && !(final.terminal && knownSpend);
      const at = final.recoveryPending && wasClosed && !final.terminal
        ? turn.completedAt
        : final.at ?? turn.completedAt;
      const increases = at !== undefined && final.tokens > turn.tokens;
      if (turn.completedAt === at && !increases && turn.recoveryPending === recoveryPending) continue;
      turn.completedAt = at;
      turn.recoveryPending = recoveryPending;
      if (!recoveryPending && !wasClosed && !final.terminal) {
        // Older reports do not opt in to retaining a checkpoint after completion.
        turn.counters = undefined;
        turn.counterTokens = undefined;
      } else if (turn.counters) {
        // An older row stored the paired amount in tokens. Preserve it before applying the report.
        turn.counterTokens ??= turn.tokens;
      }
      if (increases) {
        turn.increments.push({ at, tokens: final.tokens - turn.tokens });
        turn.tokens = final.tokens;
      }
      this.pending.set(key, turn);
      this.balance = undefined;
    }
    this.flush();
    return { ...report, records };
  }

  invalidateLegacy() {
    this.balance = undefined;
  }

  reset(now = Date.now()) {
    if (!this.flush()) throw new Error("Could not save confirmed board Codex usage.");
    this.database(db => db.prepare("INSERT OR IGNORE INTO resets VALUES (?)").run(now));
    this.balance = undefined;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return true;
    try {
      this.database(db => this.transaction(db, () => {
        const insert = db.prepare("INSERT INTO increments VALUES (?, ?, ?)");
        const reassign = db.prepare("UPDATE increments SET at = ? WHERE turn = ? AND at > ?");
        for (const [key, turn] of this.pending) {
          this.storeTurn(db, key, turn);
          for (const charge of turn.increments) insert.run(key, charge.at, charge.tokens);
          if (turn.completedAt !== undefined) reassign.run(turn.completedAt, key, turn.completedAt);
        }
      }));
      this.pending.clear();
      return true;
    } catch (error) {
      console.warn("Could not save confirmed board Codex usage.", error);
      this.timer = setTimeout(() => this.flush(), 5_000);
      this.timer.unref();
      return false;
    }
  }
}
