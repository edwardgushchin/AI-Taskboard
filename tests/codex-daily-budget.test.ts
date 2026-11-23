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
      incomplete: true, completedAt, dailyTokens, dailyTokensExcludeCache: true as const,
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
  assert.equal(updated?.records[0].dailyTokens, 22);
  assert.equal(updated?.records[0].completedAt, ended);
});

test("budget waits for a missing cache count and retains the gross statistics", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-breakdown-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const ended = new Date(2026, 10, 23, 23, 59, 59).getTime();
  const nextDay = ended + 1000;
  for (const [cached, output, charge] of [[700, 200, 500], [0, 200, 1200], [1000, 0, 0]]) {
    const turnId = "turn-" + cached;
    const last = {
      inputTokens: 1000, outputTokens: output, cachedInputTokens: cached,
      totalTokens: 1000 + output, reasoningOutputTokens: 0, cacheWriteInputTokens: 0,
    };
    // Each iteration uses a separate stream so its first sample supplies a baseline.
    const stream = new CodexTokenUsage();
    stream.track("thread", "model", true);
    stream.begin("thread", turnId);
    const observe = (cache: number | null, totalCache = cache) => {
      return stream.observe({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread", turnId,
          tokenUsage: {
            total: { ...last, cachedInputTokens: totalCache },
            last: { ...last, cachedInputTokens: cache },
          },
        },
      });
    };
    observe(null, cached === 700 ? cached : null);
    const pending = stream.completeTurn("thread", { id: turnId, completedAt: ended / 1000 })!;
    assert.equal(recordCodexDailyUsage(project, "manager", pending), true);
    assert.equal(codexDailyBudget(project, 1701, ended).reason, "unknown");
    const completed = observe(cached)!;
    for (const [key, value] of Object.entries(last)) {
      assert.equal(completed.records[0][key as keyof typeof last], value);
    }
    assert.equal(completed.records[0].dailyTokens, charge);
    assert.equal(recordCodexDailyUsage(project, "manager", completed), true);
    assert.equal(recordCodexDailyUsage(project, "manager", completed), false);
    assert.equal(recordCodexDailyUsage(project, "manager", { ...completed, id: "other-window" }), false);
    assert.equal(recordCodexDailyUsage(project, "manager", pending), false);
  }
  assert.equal(codexDailyBudget(project, 1700, ended).reason, "exhausted");
  assert.equal(codexDailyBudget(project, 1700, ended).spent, 1700);
  assert.equal(codexDailyBudget(project, 1700, nextDay).remaining, 1700);
});

test("a later cumulative snapshot reconciles cache gaps within the same model", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-cache-gap-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const completedAt = new Date(2026, 10, 23, 23, 59, 59).getTime();
  const collector = new CodexTokenUsage();
  collector.track("thread", "model", true);
  collector.begin("thread", "turn");
  const observe = (totalTokens: number, cachedInputTokens: number | null) => {
    const total = { totalTokens, inputTokens: totalTokens - 50, cachedInputTokens, outputTokens: 50 };
    return collector.observe({
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread", turnId: "turn", tokenUsage: { total, last: total } },
    });
  };
  observe(200, 100);
  observe(300, null);
  const pending = collector.completeTurn("thread", { id: "turn", completedAt: completedAt / 1000 })!;
  assert.equal(pending.records[0].dailyTokens, null);
  assert.equal(recordCodexDailyUsage(project, "executor", pending), true);
  assert.equal(codexDailyBudget(project, 300, completedAt).reason, "unknown");
  const stillPending = observe(350, null)!;
  assert.equal(stillPending.records[0].dailyTokens, null);
  assert.equal(recordCodexDailyUsage(project, "executor", stillPending), true);

  const resolved = observe(400, 200)!;
  const [record] = resolved.records;
  assert.equal(record.totalTokens, 400);
  assert.equal(record.inputTokens, 350);
  assert.equal(record.cachedInputTokens, 200);
  assert.equal(record.outputTokens, 50);
  assert.equal(record.dailyTokens, 200);
  assert.equal(record.completedAt, completedAt);
  assert.equal(recordCodexDailyUsage(project, "executor", resolved), true);
  assert.equal(recordCodexDailyUsage(project, "executor", resolved), false);
  assert.equal(recordCodexDailyUsage(project, "executor", pending), false);
  assert.equal(codexDailyBudget(project, 300, completedAt).spent, 200);
  assert.equal(codexDailyBudget(project, 300, completedAt).reason, undefined);
  assert.equal(codexDailyBudget(project, 300, completedAt + 1000).spent, 0);
});

test("restoring a legacy queue upgrades a matching gross charge exactly once", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-upgrade-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const ledger = join(project, ".tasks", "codex-daily-usage");
  const profile = join(project, "profile");
  const pending = join(profile, "pending-token-usage");
  mkdirSync(ledger, { recursive: true });
  mkdirSync(pending, { recursive: true });
  const completedAt = new Date(2026, 10, 23, 12).getTime();
  const legacyCharge = { reportId: "turn", sequence: 1, role: "manager", completedAt, tokens: 1200 };
  writeFileSync(join(ledger, "2026-11-23.json"), JSON.stringify({
    '["thread","turn"]': legacyCharge,
    '["thread","unreported"]': { ...legacyCharge, reportId: "unreported", tokens: 30 },
  }));
  const { dailyTokensExcludeCache, ...record } = report("turn", completedAt, 1200).records[0];
  const queue = new TokenUsageQueue(profile, []);
  const deliver = (breakdown: Partial<typeof record>, id = "turn") => {
    const entry = {
      project, budgetRole: "manager",
      report: { id, sequence: 1, records: [{ ...record, ...breakdown }] },
    };
    writeFileSync(join(pending, "report.json"), JSON.stringify(entry));
    queue.restore();
  };
  deliver({});
  assert.equal(codexDailyBudget(project, 2000, completedAt).spent, 1230);
  const breakdown = {
    incomplete: false, totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 700,
    outputTokens: 200, reasoningOutputTokens: 20, cacheWriteInputTokens: 0,
  };
  deliver(breakdown, "other-report");
  assert.equal(codexDailyBudget(project, 2000, completedAt).spent, 1230);
  deliver(breakdown);
  assert.equal(codexDailyBudget(project, 2000, completedAt).spent, 530);
  deliver({});
  deliver(breakdown);
  assert.equal(codexDailyBudget(project, 2000, completedAt).remaining, 1470);
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

test("recovered turns retain the confirmed day and partial usage does not close today's budget", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-recovered-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const midnight = new Date(2026, 10, 24).getTime();
  const ended = midnight - 1000;
  const original = new CodexTokenUsage();
  original.track("thread", "model", true);
  original.begin("thread", "turn");
  const counters = { totalTokens: 71 };
  original.observe({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread", turnId: "turn", tokenUsage: { total: counters, last: counters } },
  });
  const disconnected = original.finish(true)!;
  assert.equal(disconnected.records[0].totalTokens, 71);
  assert.equal(disconnected.records[0].dailyTokens, undefined);
  assert.equal(recordCodexDailyUsage(project, "executor", disconnected), false);

  const recovered = new CodexTokenUsage();
  recovered.track("thread", "model", true);
  recovered.recover("thread", { id: "turn", status: "completed", completedAt: ended / 1000 });
  const final = recovered.finish()!;
  assert.equal(final.records[0].completedAt, ended);
  assert.equal(final.records[0].dailyTokens, null);
  assert.equal(recordCodexDailyUsage(project, "executor", final), true);
  assert.equal(codexDailyBudget(project, 100, ended).reason, "unknown");
  assert.equal(codexDailyBudget(project, 100, midnight).reason, undefined);
  assert.equal(codexDailyBudget(project, 100, midnight).remaining, 100);
});

test("a recovered active turn remains unknown even if later notifications contain tokens", () => {
  const collector = new CodexTokenUsage();
  collector.track("thread", "model", true);
  collector.recover("thread", { id: "turn", status: "inProgress" });
  const counts = { totalTokens: 9 };
  collector.observe({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread", turnId: "turn", tokenUsage: { total: counts, last: counts } },
  });
  const ended = Date.now();
  const final = collector.completeTurn("thread", { id: "turn", status: "completed" }, ended)!;
  assert.equal(final.records[0].completedAt, ended);
  assert.equal(final.records[0].totalTokens, 9);
  assert.equal(final.records[0].dailyTokens, null);
});
