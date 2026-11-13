import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { recordTokenUsage, totalTokenUsage } from "../src/cli/token-usage.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";
import { createTask } from "../src/cli/tasks.ts";
import { validateCard } from "../src/cli/storage.ts";

const counts = (input: number, output: number, cached = 0, reasoning = 0) => ({
  totalTokens: input + output, inputTokens: input, outputTokens: output,
  cachedInputTokens: cached, cacheWriteInputTokens: 0, reasoningOutputTokens: reasoning,
});
const usage = (collector: CodexTokenUsage, threadId: string, turnId: string, total: object, last: object) =>
  collector.observe({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total, last } } });

test("thread deltas exclude resumed history and duplicates, sum models, children, and reroutes", () => {
  const collector = new CodexTokenUsage();
  collector.track("root", "model-a", true);
  assert.equal(usage(collector, "root", "old", counts(900, 90), counts(900, 90)), undefined);
  collector.begin("root", "turn-1");
  usage(collector, "root", "turn-1", counts(1000, 110, 50, 10), counts(100, 20, 50, 10));
  assert.equal(usage(collector, "root", "turn-1", counts(1000, 110, 50, 10), counts(100, 20, 50, 10)), undefined);
  usage(collector, "root", "turn-1", counts(1200, 150, 150, 30), counts(200, 40, 100, 20));
  collector.observe({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "root", model: "model-b" } } });
  collector.observe({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
  usage(collector, "child", "child-turn", counts(30, 10, 5, 2), counts(30, 10, 5, 2));
  collector.observe({ method: "thread/started", params: { thread: { id: "nested", parentThreadId: "child", model: "model-a" } } });
  usage(collector, "nested", "nested-turn", counts(10, 5), counts(10, 5));
  assert.equal(usage(collector, "unrelated", "turn-1", counts(999, 999), counts(999, 999)), undefined);
  collector.observe({ method: "model/rerouted", params: { threadId: "root", toModel: "model-b" } });
  usage(collector, "root", "turn-1", counts(1220, 160, 155, 35), counts(20, 10, 5, 5));
  const report = collector.finish()!;
  const byModel = totalTokenUsage(report.records);
  assert.deepEqual(byModel, [
    { ...counts(310, 65, 150, 30), model: "model-a", incomplete: false },
    { ...counts(50, 20, 10, 7), model: "model-b", incomplete: false },
  ]);
  assert.equal(byModel[0].totalTokens, 375); // Cache and reasoning subsets are not charged twice.
  const resumed = new CodexTokenUsage();
  resumed.track("root", "model-a", true);
  resumed.begin("root", "turn-2");
  usage(resumed, "root", "turn-2", counts(1250, 170, 155, 35), counts(30, 10));
  let task = recordTokenUsage(createTask("T-0001", { title: "Usage" }), report);
  task = recordTokenUsage(task, resumed.finish()!);
  assert.equal(task.tokenUsage!.byModel[0].totalTokens, 415);
});

test("missing usage, partial counters, failed retries and silent children remain incomplete", () => {
  const collector = new CodexTokenUsage();
  collector.track("root", "model-a", true);
  collector.begin("root", "turn-1");
  collector.observe({ method: "item/completed", params: { threadId: "root", item: {
    type: "subAgentActivity", kind: "started", agentThreadId: "silent", model: "model-b",
  } } });
  collector.observe({ method: "item/completed", params: { threadId: "root", item: {
    type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["unknown-model"],
  } } });
  const report = collector.finish()!;
  assert.ok(report.records.every(record => record.incomplete && record.totalTokens === null));
  assert.deepEqual(report.records.map(record => record.model), ["model-a", "model-b", null]);
  const partial = { ...counts(100, 20), cacheWriteInputTokens: undefined };
  usage(collector, "root", "turn-1", partial, partial);
  collector.observe({ method: "error", params: { threadId: "root", willRetry: true } });
  usage(collector, "root", "turn-1", counts(130, 25), counts(30, 5));
  let root = collector.finish()!.records.find(record => record.threadId === "root")!;
  assert.equal(root.totalTokens, 155);
  assert.equal(root.incomplete, true);
  usage(collector, "root", "turn-1", counts(1, 1), counts(1, 1)); // Counter reset is not negative consumption.
  root = collector.finish()!.records.find(record => record.threadId === "root")!;
  assert.equal(root.totalTokens, 155);
  assert.equal(root.incomplete, true);
});

test("turn changes retain the thread baseline and a route before usage leaves one model", () => {
  const collector = new CodexTokenUsage();
  collector.track("root", "requested", true);
  assert.equal(collector.observe({ method: "thread/settings/updated", params: { threadId: "root", threadSettings: { model: "requested" } } }), undefined);
  collector.begin("root", "turn-1");
  collector.observe({ method: "model/rerouted", params: { threadId: "root", toModel: "actual" } });
  usage(collector, "root", "turn-1", counts(100, 20), counts(100, 20));
  collector.begin("root", "turn-2");
  usage(collector, "root", "turn-2", counts(130, 25), counts(30, 5));
  assert.deepEqual(totalTokenUsage(collector.finish()!.records), [{ ...counts(130, 25), model: "actual", incomplete: false }]);
});

test("CLI persists idempotent reports per task, validates counters and preserves them through archive", t => {
  const root = mkdtempSync(join(tmpdir(), "ai-taskboard-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], input?: unknown, error?: string) => {
    const reply = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", root, "--json",
      ...args, ...(input === undefined ? [] : ["--stdin"])], { input: JSON.stringify(input), encoding: "utf8", windowsHide: true });
    const result = JSON.parse(reply.stdout);
    assert.equal(result.ok, !error, reply.stdout + reply.stderr);
    if (error) assert.equal(result.error.code, error);
    return result.data;
  };
  cli(["init"]);
  const first = cli(["create"], { title: "First task" });
  const second = cli(["create"], { title: "Other task" });
  const record = { ...counts(100, 20, 50, 10), threadId: "root", turnId: "turn", model: "model-a", incomplete: false };
  const report: TokenUsageReport = { id: "run-1", sequence: 1, records: [record] };
  const save = (value: unknown) => cli(["token-usage", first.id], value);
  assert.equal(save(report).revision, first.revision);
  save(report);
  save({ ...report, sequence: 0, records: [{ ...record, ...counts(1, 1) }] });
  save({ ...report, sequence: 2, records: [{ ...record, ...counts(200, 30, 80, 15) }] });
  save({ ...report, id: "retry", records: [{ ...record, turnId: "retry" }] });
  const current = cli(["show", first.id]);
  assert.deepEqual(current.tokenUsage.byModel, [{ ...counts(300, 50, 130, 25), model: "model-a", incomplete: false }]);
  assert.equal(current.history.length, first.history.length);
  assert.equal(current.updatedAt, first.updatedAt);
  assert.equal(cli(["show", second.id]).tokenUsage, undefined);
  for (const invalid of [{ inputTokens: -1 }, { cachedInputTokens: 101 }, { outputTokens: 1.5 }, { model: "" }, { incomplete: false, totalTokens: null }]) {
    cli(["token-usage", first.id], { ...report, sequence: 3, records: [{ ...record, ...invalid }] }, "INVALID_INPUT");
  }
  assert.deepEqual(cli(["show", first.id]).tokenUsage, current.tokenUsage);
  const corrupt = structuredClone(current);
  corrupt.tokenUsage.byModel[0].totalTokens++;
  assert.throws(() => validateCard(corrupt, first.id), /Invalid token usage/);
  cli(["cancel", first.id], { reason: "Archive check", actor: "user" });
  cli(["settings"], { archiveAfterDays: 0 });
  cli(["archive", "sweep"]);
  assert.deepEqual(cli(["show", first.id]).tokenUsage, current.tokenUsage);
});
