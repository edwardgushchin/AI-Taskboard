import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyTokenCounts } from "../src/cli/token-usage.ts";
import { BoardCodexUsage, codexDailyBudget, recordCodexDailyUsage } from "../src/desktop/codex-daily-budget.ts";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { codexLimitSnapshot, confirmedQuota } from "../src/desktop/provider-limits.ts";
import { TokenUsageQueue } from "../src/desktop/token-usage-queue.ts";

test("boards validate and preserve independent local reset settings", t => {
  const parent = mkdtempSync(join(tmpdir(), "codex-budget-settings-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const first = join(parent, "first");
  const second = join(parent, "second");
  mkdirSync(first);
  mkdirSync(second);
  const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  function cli(project: string, command: string, settings?: Record<string, unknown>) {
    const result = spawnSync(process.execPath, [
      entry, "--project", project, "--json", command, ...(settings ? ["--stdin"] : []),
    ], { encoding: "utf8", input: settings && JSON.stringify(settings) });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  }
  for (const project of [first, second]) {
    assert.equal(cli(project, "init", { git: false }).ok, true);
    assert.equal(cli(project, "settings").data.codexDailyResetTime, "09:00");
  }
  for (const invalid of ["9:00", "09:00x", " 09:00", "09:00\n", "24:00", "09:60", "0x09:00", "０９:００", 900]) {
    assert.equal(cli(first, "settings", { codexDailyResetTime: invalid }).error.code, "INVALID_INPUT");
  }
  assert.equal(cli(first, "settings", { codexDailyResetTime: "14:30" }).ok, true);
  assert.equal(cli(first, "settings").data.codexDailyResetTime, "14:30");
  assert.equal(cli(second, "settings").data.codexDailyResetTime, "09:00");
  assert.equal(cli(first, "settings", { codexDailyResetTime: "09:00" }).ok, true);
  assert.equal(cli(first, "settings").data.codexDailyResetTime, "09:00");
});

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

for (const status of ["interrupted", "failed"]) {
  test(`${status} closes live usage and accepts only a late difference outside the search window`, t => {
    const project = mkdtempSync(join(tmpdir(), "codex-budget-terminal-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    mkdirSync(join(project, ".tasks"));
    const reset = new Date(2026, 10, 24, 9).getTime();
    const ended = reset - 1000;
    const ledger = new BoardCodexUsage(project);
    const collector = new CodexTokenUsage(sample => ledger.observe(sample));
    collector.track("thread", "model", true);
    collector.begin("thread", "turn");
    const first = { ...emptyTokenCounts(), totalTokens: 100_000, cachedInputTokens: 5_941 };
    collector.observe({
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread", turnId: "turn", tokenUsage: { total: first, last: first } },
    }, ended - 1000);
    const notification = {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status, completedAt: ended / 1000 } },
    };
    const final = collector.observe(notification, ended)!;
    assert.equal(final.records[0].incomplete, true);
    assert.equal(final.records[0].dailyTokens, 94_059);
    ledger.reconcile(final);
    ledger.reconcile(collector.observe(notification, ended)!);
    const reopened = new BoardCodexUsage(project);
    assert.deepEqual(reopened.unresolved(reset), []);
    assert.equal(reopened.get(200_000, ended).spent, 94_059);

    const lateAt = new Date(2026, 10, 27, 10).getTime();
    const late = { ...first, totalTokens: 101_000, cachedInputTokens: 6_841 };
    const restored = new CodexTokenUsage(sample => reopened.observe(sample), (...key) => reopened.recover(...key));
    restored.track("thread", "model", true);
    reopened.reconcile(restored.recover("thread", notification.params.turn)!);
    const update = restored.observe({
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread", turnId: "turn", tokenUsage: { total: late, last: late } },
    }, lateAt)!;
    reopened.reconcile(update);
    reopened.reconcile(update);
    assert.equal(reopened.get(200_000, ended).spent, 94_159);
    assert.equal(reopened.get(200_000, reset).remaining, 200_000);
    assert.equal(reopened.get(200_000, lateAt).remaining, 200_000);
  });
}

test("history can close an unknown 24929-token charge without inventing a time", async t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-history-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const at = new Date(2026, 10, 24, 11).getTime();
  const ledger = new BoardCodexUsage(project);
  ledger.observe({ threadId: "thread", turnId: "turn", tokens: 24_929, observedAt: at,
    counters: { ...emptyTokenCounts(), totalTokens: 25_000, cachedInputTokens: 71 } });
  assert.equal(ledger.flush(), true);
  const reopened = new BoardCodexUsage(project);
  const use = new CodexTokenUsage(sample => reopened.observe(sample), (...key) => reopened.recover(...key));
  const [candidate] = reopened.unresolved(at);
  assert.equal(candidate.completedAt, undefined);
  use.track("thread", "model", true);
  const terminal = { id: "turn", status: "failed" };
  const path = join(project, "rollout.jsonl");
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "thread" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const final = (await use.recoverRollout(path, "thread", terminal))!;
  assert.equal(final.records[0].completedAt, undefined);
  assert.equal(final.records[0].incomplete, true);
  assert.equal(final.records[0].dailyTokens, 24_929);
  reopened.reconcile(final);
  reopened.reconcile(final);
  assert.deepEqual(new BoardCodexUsage(project).unresolved(at), []);
  assert.equal(reopened.get(100_000, at).spent, 24_929);
});

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
  assert.equal(codexDailyBudget(alpha, 100, today).reason, undefined);
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
    const pending = stream.completeTurn("thread", { id: turnId, status: "completed", completedAt: ended / 1000 })!;
    assert.equal(recordCodexDailyUsage(project, "manager", pending), true);
    assert.equal(codexDailyBudget(project, 1701, ended).reason, undefined);
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
  const pending = collector.completeTurn("thread", { id: "turn", status: "completed", completedAt: completedAt / 1000 })!;
  assert.equal(pending.records[0].dailyTokens, null);
  assert.equal(recordCodexDailyUsage(project, "executor", pending), true);
  assert.equal(codexDailyBudget(project, 300, completedAt).reason, undefined);
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
  assert.equal(codexDailyBudget(project, 100, ended).reason, undefined);
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

test("live accounting survives the default 09:00 boundary, a reset, and terminal replay", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-live-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const boundary = new Date(2026, 10, 24, 9).getTime();
  const before = boundary - 1000;
  const after = boundary + 1000;
  const ledger = new BoardCodexUsage(project);
  const sample = (turnId: string, tokens: number, observedAt: number) => ({
    threadId: "thread", turnId, tokens, observedAt,
  });
  ledger.observe(sample("executor", 80, before));
  ledger.observe(sample("review", 20, before));
  assert.equal(ledger.get(100, before).reason, "exhausted");
  assert.equal(ledger.get(100, before).resetsAt, boundary);
  assert.equal(ledger.get(100, boundary).spent, 0);
  ledger.observe(sample("executor", 95, after));
  assert.equal(ledger.get(100, after).spent, 15);
  ledger.reset(after + 1);
  assert.equal(ledger.get(100, after + 1).spent, 0);
  assert.equal(ledger.observe(sample("executor", 95, after + 2)), false);
  assert.equal(ledger.observe(sample("executor", 110, after + 2)), true);
  ledger.flush();
  const restored = new BoardCodexUsage(project);
  assert.equal(restored.reconcile(report("executor", after + 3, 110)).records.length, 0);
  assert.equal(restored.get(100, after + 3).spent, 15);
  assert.equal(restored.get(100, new Date(2026, 10, 25, 9).getTime()).spent, 0);
});

test("a confirmed completion before a boundary moves a delayed increment once", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-late-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const boundary = new Date(2026, 10, 24, 9).getTime();
  const first = boundary - 5000;
  const finished = first + 1000;
  const delivered = boundary + 1000;
  const ledger = new BoardCodexUsage(project);
  ledger.observe({ threadId: "thread", turnId: "midnight", tokens: 10, observedAt: first });
  ledger.observe({ threadId: "thread", turnId: "midnight", tokens: 30, observedAt: delivered });
  assert.equal(ledger.get(100, delivered).spent, 20);
  const final = report("midnight", finished, 30);
  assert.equal(ledger.reconcile(final).records.length, 0);
  assert.equal(ledger.reconcile(final).records.length, 0);
  assert.equal(ledger.get(100, delivered).spent, 0);
  assert.equal(ledger.get(100, finished).spent, 30);

  ledger.observe({ threadId: "thread", turnId: "manual", tokens: 5, observedAt: delivered });
  ledger.reset(delivered + 1000);
  ledger.observe({ threadId: "thread", turnId: "manual", tokens: 20, observedAt: delivered + 3000 });
  assert.equal(ledger.get(100, delivered + 3000).spent, 15);
  ledger.reconcile(report("manual", delivered + 500, 25));
  assert.equal(ledger.get(100, delivered + 3000).spent, 0);
  assert.equal(ledger.get(100, delivered + 500).spent, 25);
});

test("late model rows reconcile against the confirmed total of the same turn", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-models-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const at = new Date(2026, 10, 24, 13, 59).getTime();
  const ledger = new BoardCodexUsage(project);
  ledger.observe({ threadId: "thread", turnId: "routed", tokens: 60, observedAt: at });
  ledger.reset(at + 1000);
  const final = report("routed", at + 500, 50);
  final.records.push({ ...final.records[0], model: "second" });
  ledger.reconcile(final);
  assert.equal(ledger.get(200, at + 1500, "14:00").spent, 0);
  assert.equal(ledger.get(200, at + 500, "14:00").spent, 100);
  const restored = new BoardCodexUsage(project);
  restored.reconcile(final);
  assert.equal(restored.get(200, at + 500, "14:00").spent, 100);
  assert.equal(restored.get(200, at + 1500, "14:00").resetsAt, new Date(2026, 10, 24, 14).getTime());
  assert.equal(restored.get(200, at + 1500).resetsAt, new Date(2026, 10, 25, 9).getTime());
});

test("historical snapshots move only the verified portion behind a reset", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-refine-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const boundary = new Date(2026, 10, 24, 9).getTime();
  const ledger = new BoardCodexUsage(project);
  const sample = { threadId: "thread", turnId: "turn", tokens: 100, observedAt: boundary + 1000 };
  ledger.observe(sample);
  assert.equal(ledger.get(200, boundary + 1000).spent, 100);
  const recovered = { ...sample, tokens: 60, observedAt: boundary - 1000, historical: true as const };
  assert.equal(ledger.observe(recovered), true);
  assert.equal(ledger.observe(recovered), false);
  assert.equal(ledger.get(200, boundary - 1000).spent, 60);
  assert.equal(ledger.get(200, boundary + 1000).spent, 40);
  ledger.reconcile(report("turn", boundary + 2000, 100));
  assert.equal(new BoardCodexUsage(project).get(200, boundary + 2000).spent, 40);
});

test("recovery without counters persists a new baseline and charges later confirmed deltas", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-seed-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const ledger = new BoardCodexUsage(project);
  function collector(board: BoardCodexUsage) {
    const usage = new CodexTokenUsage(sample => board.observe(sample), (...key) => board.recover(...key));
    usage.track("thread", "model", true);
    usage.recover("thread", { id: "turn", status: "inProgress" });
    return usage;
  }
  function observe(usage: CodexTokenUsage, totalTokens: number, cachedInputTokens: number) {
    const totals = { totalTokens, cachedInputTokens };
    return usage.observe({ method: "thread/tokenUsage/updated",
      params: { threadId: "thread", turnId: "turn", tokenUsage: { total: totals, last: totals } },
    });
  }
  observe(collector(ledger), 100, 90);
  assert.equal(ledger.get(100).spent, 0);
  assert.equal(ledger.flush(), true);
  const restored = new BoardCodexUsage(project);
  const resumed = collector(restored);
  observe(resumed, 125, 100);
  assert.equal(restored.get(100).spent, 15);
  const result = resumed.completeTurn("thread", { id: "turn", status: "completed" }, Date.now())!;
  assert.equal(result.records[0].dailyTokens, null);
  restored.reconcile(result);
  assert.equal(restored.get(100).spent, 15);
  assert.equal(restored.recover("thread", "turn")?.tokens, 15);
});

test("a saved completed rollout with no terminal event recovers 110355 observed tokens", async t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-rollout-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const path = join(project, "rollout.jsonl");
  const at = new Date(2026, 10, 24, 11).getTime();
  const tokenCount = (i: number, total: number, cached: number) => {
    const counters = { total_tokens: total, cached_input_tokens: cached };
    return { type: "event_msg", timestamp: new Date(at + i * 1000).toISOString(), payload: {
      type: "token_count", info: { total_token_usage: counters, last_token_usage: counters },
    } };
  };
  const rollout = [
    { type: "session_meta", payload: { id: "thread" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    ...Array.from({ length: 11 }, (_, i) => tokenCount(i, 100 * (i + 1), 90 * (i + 1))),
    tokenCount(11, 1_051_795, 941_440),
  ];
  writeFileSync(path, rollout.map(item => JSON.stringify(item)).join("\n") + "\n");
  const ledger = new BoardCodexUsage(project);
  const usage = new CodexTokenUsage(sample => ledger.observe(sample));
  usage.track("thread", "model", true);
  const completion = { id: "turn", status: "completed", completedAt: (at + 12_000) / 1000 };
  assert.equal(usage.recover("thread", completion)?.records[0].dailyTokens, null);
  const report = await usage.recoverRollout(path, "thread", completion);
  assert.equal(report?.records[0].dailyTokens, 110_355);
  assert.equal(ledger.get(200_000, at + 12_000).spent, 110_355);
  assert.equal(ledger.reconcile(report!).records.length, 0);
  await usage.recoverRollout(path, "thread", completion);
  assert.equal(ledger.get(200_000, at + 12_000).spent, 110_355);
});

for (const legacy of [true, false]) {
  test(`late rollout data resolves a partial ${legacy ? "legacy" : "live"} turn without double billing`, async t => {
    const project = mkdtempSync(join(tmpdir(), "codex-budget-retry-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    mkdirSync(join(project, ".tasks"));
    const path = join(project, "rollout.jsonl");
    const at = new Date(2026, 10, 24, 11).getTime();
    const completedAt = at + 3000;
    const ledger = new BoardCodexUsage(project);
    if (legacy) {
      recordCodexDailyUsage(project, "executor", report("turn", completedAt, null));
    } else {
      ledger.observe({ threadId: "thread", turnId: "turn", tokens: 10, observedAt: at });
      ledger.reconcile(report("turn", completedAt, null));
    }

    const rollout: object[] = [
      { type: "session_meta", payload: { id: "thread" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    ];
    function sample(time: number, total: number, cached: number) {
      const counters = { total_tokens: total, cached_input_tokens: cached };
      rollout.push({ type: "event_msg", timestamp: new Date(time).toISOString(), payload: {
        type: "token_count", info: { total_token_usage: counters, last_token_usage: counters },
      } });
    }
    async function restore(board: BoardCodexUsage) {
      writeFileSync(path, rollout.map(event => JSON.stringify(event)).join("\n") + "\n");
      const usage = new CodexTokenUsage(snapshot => board.observe(snapshot));
      const [candidate] = board.unresolved(completedAt);
      assert.equal(candidate?.turnId, "turn");
      assert.equal(candidate.completedAt, completedAt);
      const result = await usage.recoverRollout(path, candidate.threadId, {
        id: candidate.turnId,
      });
      assert.ok(result);
      assert.equal(board.reconcile(result).records.length, 0);
      return result;
    }

    sample(at, 100, 90);
    const partial = await restore(ledger);
    assert.equal(partial.records[0].dailyTerminal, undefined);
    assert.equal(partial.records[0].completedAt, undefined);
    assert.equal(ledger.get(100, completedAt).spent, 10);
    const reopened = new BoardCodexUsage(project);
    sample(at + 2000, 125, 100);
    await restore(reopened);
    assert.equal(reopened.get(100, completedAt).spent, 25);
    assert.equal(reopened.unresolved(completedAt).length, 1);
    rollout.push({ type: "event_msg", timestamp: new Date(completedAt).toISOString(),
      payload: { type: "task_complete", turn_id: "turn" } });
    const final = await restore(reopened);
    assert.equal(final.records[0].dailyTerminal, true);
    reopened.reconcile(partial);
    reopened.reconcile(final);
    assert.equal(reopened.get(100, completedAt).spent, 25);
    assert.deepEqual(new BoardCodexUsage(project).unresolved(completedAt), []);
  });
}

test("rollout recovery preserves earlier timestamps and charges only an extension of the saved baseline", async t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-checkpoint-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const at = new Date(2026, 10, 24, 9).getTime();
  const path = join(project, "rollout.jsonl");
  const ledger = new BoardCodexUsage(project);
  ledger.observe({
    threadId: "thread", turnId: "turn", tokens: 70, observedAt: at,
    counters: { ...emptyTokenCounts(), totalTokens: 120, cachedInputTokens: 50 },
  });
  assert.equal(ledger.flush(), true);
  const reopened = new BoardCodexUsage(project);
  const usage = new CodexTokenUsage(sample => reopened.observe(sample), (...key) => reopened.recover(...key));
  const total = (offset: number, full: number, cached?: number) => ({
    type: "event_msg",
    timestamp: new Date(at + offset).toISOString(),
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: full, cached_input_tokens: cached },
        last_token_usage: { total_tokens: full, cached_input_tokens: cached },
      },
    },
  });
  const events = [
    { type: "session_meta", payload: { id: "thread" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "other" } },
    total(-3000, 10, 2),
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
    total(-2000, 100, 40),
    total(-1000, 120, 50),
    total(1000, 145),
    total(2000, 145, 60),
  ];
  writeFileSync(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const result = await usage.recoverRollout(path, "thread", { id: "turn", status: "inProgress" });
  assert.ok(result);
  assert.equal(reopened.get(100, at - 1).spent, 70);
  assert.equal(reopened.get(100, at + 2000).spent, 15);
  assert.equal(reopened.flush(), true);
});

for (const partialTokens of [null, 80]) {
  test(`a completed turn keeps its saved counters through a partial report of ${partialTokens}`, async t => {
    const project = mkdtempSync(join(tmpdir(), "codex-budget-partial-final-"));
    t.after(() => rmSync(project, { recursive: true, force: true }));
    mkdirSync(join(project, ".tasks"));
    const path = join(project, "rollout.jsonl");
    const at = new Date(2026, 10, 24, 11).getTime();
    const completedAt = at + 3000;
    const counters = { ...emptyTokenCounts(), totalTokens: 120, cachedInputTokens: 50 };
    const ledger = new BoardCodexUsage(project);
    ledger.observe({
      threadId: "thread",
      turnId: "turn",
      tokens: 70,
      observedAt: at,
      counters,
    });
    assert.equal(ledger.flush(), true);
    if (partialTokens !== null) {
      const db = new DatabaseSync(join(project, ".tasks", "codex-daily-usage", "usage.sqlite"));
      try {
        db.exec(`
          ALTER TABLE turns DROP COLUMN counter_tokens;
          DELETE FROM migration WHERE version = 3;
        `);
      } finally {
        db.close();
      }
    }
    const partial = report("turn", completedAt, partialTokens);
    const incomplete = {
      ...partial,
      records: partial.records.map(record => ({ ...record, dailyRecoveryPending: true as const })),
    };
    new BoardCodexUsage(project).reconcile(incomplete);

    function recoverFrom(board: BoardCodexUsage, terminal: boolean) {
      const history = [
        { type: "session_meta", payload: { id: "thread" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      ];
      const sample = {
        type: "event_msg",
        timestamp: new Date(at + 1000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: 145, cached_input_tokens: 60 },
            last_token_usage: { total_tokens: 25, cached_input_tokens: 10 },
          },
        },
      };
      const events: object[] = [...history, sample, sample];
      if (terminal) {
        events.push({
          type: "event_msg",
          timestamp: new Date(completedAt).toISOString(),
          payload: { type: "task_complete", turn_id: "turn" },
        });
      }
      writeFileSync(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
      const [candidate] = board.unresolved(completedAt);
      assert.equal(candidate?.completedAt, completedAt);
      const usage = new CodexTokenUsage(snapshot => board.observe(snapshot), (...key) => board.recover(...key));
      return usage.recoverRollout(path, candidate.threadId, {
        id: candidate.turnId,
      });
    }

    const reopened = new BoardCodexUsage(project);
    assert.deepEqual(reopened.recover("thread", "turn"), { tokens: 70, counters });
    assert.equal(reopened.get(85, completedAt).spent, partialTokens ?? 70);
    assert.equal(reopened.get(85, completedAt).reason, undefined);
    const late = await recoverFrom(reopened, false);
    assert.ok(late);
    assert.equal(reopened.get(85, completedAt).spent, 85);
    assert.equal(reopened.get(85, completedAt).reason, "exhausted");
    reopened.reconcile(late);
    const restarted = new BoardCodexUsage(project);
    assert.equal(restarted.recover("thread", "turn")?.tokens, 85);
    assert.equal(restarted.recover("thread", "turn")?.counters.totalTokens, 145);
    const final = await recoverFrom(restarted, true);
    assert.ok(final);
    restarted.reconcile(final);
    restarted.reconcile(incomplete);
    const saved = new BoardCodexUsage(project);
    assert.equal(saved.get(85, completedAt).spent, 85);
    assert.equal(saved.recover("thread", "turn")?.tokens, 85);
    assert.deepEqual(saved.unresolved(completedAt), []);
  });
}

test("a dated zero baseline keeps a recent unconfirmed turn available after restart", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-zero-base-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const ledger = new BoardCodexUsage(project);
  const at = new Date(2026, 10, 24, 11).getTime();
  const counters = { ...emptyTokenCounts(), totalTokens: 100, cachedInputTokens: 90 };
  ledger.observe({ threadId: "thread", turnId: "old", tokens: 0, observedAt: at - 3 * 86_400_000, counters });
  ledger.observe({ threadId: "thread", turnId: "recent", tokens: 0, observedAt: at, counters });
  assert.equal(ledger.flush(), true);

  const reopened = new BoardCodexUsage(project);
  assert.deepEqual(reopened.unresolved(at), [{ threadId: "thread", turnId: "recent", completedAt: undefined }]);
  assert.equal(reopened.get(100, at).spent, 0);
});

test("completion releases active state and an early flush durably saves the remaining live sample", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-release-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const ledger = new BoardCodexUsage(project);
  const at = new Date(2026, 10, 24, 11).getTime();
  function observe(turnId: string) {
    ledger.observe({ threadId: "thread", turnId, tokens: 5, observedAt: at,
      counters: { ...emptyTokenCounts(), totalTokens: 15, cachedInputTokens: 10 },
    });
    assert.ok(ledger.recover("thread", turnId));
  }
  for (let i = 0; i < 64; i++) {
    const id = "completed-" + i;
    observe(id);
    ledger.reconcile(report(id, at + 1, 5));
    assert.equal(ledger.recover("thread", id), undefined);
  }
  observe("still-active");
  assert.equal(ledger.flush(), true);
  const reopened = new BoardCodexUsage(project);
  assert.equal(reopened.get(1_000, at + 2).spent, 325);
  assert.equal(reopened.recover("thread", "still-active")?.tokens, 5);
  const db = new DatabaseSync(join(project, ".tasks", "codex-daily-usage", "usage.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS rows FROM turns WHERE counters IS NOT NULL").get()?.rows, 1);
  } finally {
    db.close();
  }
});

test("a missing final event preserves the observed 110355 tokens and a recovered baseline", t => {
  const project = mkdtempSync(join(tmpdir(), "codex-budget-observed-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const ledger = new BoardCodexUsage(project);
  const observer = new CodexTokenUsage(sample => { ledger.observe(sample); });
  const threadId = "thread";
  const turnId = "turn";
  observer.track(threadId, "model", true);
  observer.begin(threadId, turnId);
  function sample(collector: CodexTokenUsage, totalTokens: number, cachedInputTokens: number | null) {
    const totals = { totalTokens, cachedInputTokens };
    return collector.observe({
      method: "thread/tokenUsage/updated",
      params: { threadId, turnId, tokenUsage: { total: totals, last: totals } },
    });
  }
  sample(observer, 100, 90);
  sample(observer, 500, null);
  assert.equal(ledger.get(200_000).spent, 10);
  sample(observer, 1_051_795, 941_440);
  assert.equal(ledger.get(200_000).spent, 110_355);
  assert.equal(ledger.reconcile(observer.finish(true)!).records.length, 0);

  const restored = new BoardCodexUsage(project);
  const recovered = new CodexTokenUsage(value => { restored.observe(value); },
    (thread, turn) => restored.recover(thread, turn));
  recovered.track(threadId, "model", true);
  recovered.recover(threadId, { id: turnId, status: "inProgress" });
  sample(recovered, 1_051_795, 941_440);
  assert.equal(restored.get(200_000).spent, 110_355);
  sample(recovered, 1_052_795, 942_000);
  assert.equal(restored.get(200_000).spent, 110_795);
  restored.flush();
});
