import { join } from "node:path";
import { directory, exists, readJson, withLock, writeJson } from "../cli/storage.ts";
import type { TaskUsageRole, TokenUsageReport } from "../cli/token-usage.ts";
import { uncachedTokens } from "./codex-token-usage.ts";

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
          const upgradesLegacy = !previous.excludesCache && charge.tokens !== null;
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
  const reason = spent >= limit ? "exhausted" : charges.some(charge => charge.tokens === null) ? "unknown" : undefined;
  return { limit, spent, remaining: Math.max(0, limit - spent), resetsAt: reset.getTime(), reason };
}
