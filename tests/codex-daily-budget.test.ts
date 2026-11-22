import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyTokenCounts } from "../src/cli/token-usage.ts";
import { codexDailyBudget, recordCodexDailyUsage } from "../src/desktop/codex-daily-budget.ts";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { codexLimitSnapshot, confirmedQuota } from "../src/desktop/provider-limits.ts";
import { TokenUsageQueue } from "../src/desktop/token-usage-queue.ts";

function report(turnId: string, completedAt: number, dailyTokens: number | null, sequence = 1) {
  return {
    id: turnId,
    sequence,
    records: [{
      ...emptyTokenCounts(), threadId: "thread", turnId, model: "model",
      incomplete: true, completedAt, dailyTokens,
    }],
  };
}

test("board budgets count each completed turn once and ignore account quota changes", t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const alpha = join(directory, "Alpha");
  const beta = join(directory, "Beta");
  for (const board of [alpha, beta]) mkdirSync(join(board, ".tasks"), { recursive: true });
  const today = new Date(2026, 10, 23, 23, 59, 59).getTime();
  const reset = new Date(2026, 10, 24).getTime();
  const executor = report("executor", today, 80);
  const reviewer = report("reviewer", today, 15);
  recordCodexDailyUsage(alpha, "executor", executor, "T-0001");
  recordCodexDailyUsage(beta, "reviewer", reviewer, "T-0001");
  assert.equal(recordCodexDailyUsage(alpha, "executor", executor, "T-0001"), false);
  assert.equal(recordCodexDailyUsage(alpha, "executor", { ...executor, id: "replay" }, "T-0001"), false);
  recordCodexDailyUsage(alpha, "draft", report("draft", today, null), "T-0002");
  assert.equal(codexDailyBudget(alpha, 100, today).reason, "unknown");
  recordCodexDailyUsage(alpha, "draft", report("draft", today, 10, 2), "T-0002");
  assert.equal(recordCodexDailyUsage(alpha, "draft", report("draft", today, null), "T-0002"), false);
  assert.equal(codexDailyBudget(alpha, 100, today).reason, undefined);
  recordCodexDailyUsage(alpha, "manager", report("manager", today, 30));
  recordCodexDailyUsage(beta, "background", report("background", today, 5));
  assert.deepEqual(codexDailyBudget(alpha, 100, today), {
    limit: 100, spent: 120, remaining: 0, reason: "exhausted", resetsAt: reset,
  });
  assert.equal(codexDailyBudget(beta, 100, today).remaining, 80);
  for (const usedPercent of [34, 46, 100, 0]) {
    const account = codexLimitSnapshot({ rateLimits: {
      limitId: "codex",
      primary: { usedPercent, windowDurationMins: 10080, resetsAt: reset / 1000 },
    } }, today);
    assert.deepEqual(confirmedQuota(account, today), usedPercent === 100 ? { resetsAt: reset } : "available");
    assert.equal(codexDailyBudget(alpha, 100, today).spent, 120);
    assert.equal(codexDailyBudget(beta, 100, today).spent, 20);
  }
  assert.equal(codexDailyBudget(alpha, 100, reset).reason, undefined);
  recordCodexDailyUsage(alpha, "discussion", report("late", today, null), "T-0002");
  recordCodexDailyUsage(alpha, "discussion", report("late", today, 7, 2), "T-0002");
  assert.equal(codexDailyBudget(alpha, 100, reset).remaining, 100);
  assert.equal(codexDailyBudget(alpha, 100, today).spent, 127);
});

test("a late usage notification keeps the completion date from Codex", () => {
  const collector = new CodexTokenUsage();
  collector.track("root", "model", true);
  collector.begin("root", "turn");
  const ended = new Date(2026, 10, 23, 23, 59, 59).getTime();
  const pending = collector.observe({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "turn", status: "completed", completedAt: ended / 1000 } },
  });
  assert.equal(pending?.records[0].dailyTokens, null);
  assert.equal(pending?.records[0].completedAt, ended);
  const counts = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 8, reasoningOutputTokens: 5, totalTokens: 30 };
  const updated = collector.observe({
    method: "thread/tokenUsage/updated",
    params: { threadId: "root", turnId: "turn", tokenUsage: { total: counts, last: counts } },
  });
  assert.equal(updated?.records[0].dailyTokens, 30);
  assert.equal(updated?.records[0].completedAt, ended);
});

test("restart replays a budget report after a temporary storage failure", t => {
  const directory = mkdtempSync(join(tmpdir(), "codex-budget-replay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, "board");
  const profile = join(directory, "profile");
  const ledger = join(project, ".tasks", "codex-daily-usage");
  mkdirSync(join(project, ".tasks"), { recursive: true });
  writeFileSync(ledger, "temporarily unavailable");
  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const queue = new TokenUsageQueue(profile, []);
  queue.enqueueBudget(project, "manager", report("turn", now, 100));
  assert.equal(queue.hasPendingBudget(project, midnight, now), true);
  rmSync(ledger);
  const restored = new TokenUsageQueue(profile, []);
  restored.restore();
  assert.equal(restored.hasPendingBudget(project, midnight, now), false);
  assert.equal(codexDailyBudget(project, 200, now).remaining, 100);
  restored.restore();
  assert.equal(codexDailyBudget(project, 200, now).spent, 100);
});
