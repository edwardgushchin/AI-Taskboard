import { plannedDraft } from "./fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { recordTokenUsage, taskMetrics, totalTokenUsage } from "../src/cli/token-usage.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";
import { createTask } from "../src/cli/tasks.ts";
import { initializeBoard, validateCard } from "../src/cli/storage.ts";
import { projectUsage } from "../src/cli/project-usage.ts";
import { managerUsage } from "../src/cli/manager-usage.ts";

const counts = (input: number, output: number, cached = 0, reasoning = 0) => ({
  totalTokens: input + output, inputTokens: input, outputTokens: output,
  cachedInputTokens: cached, cacheWriteInputTokens: 0, reasoningOutputTokens: reasoning,
});
const usage = (collector: CodexTokenUsage, threadId: string, turnId: string, total: object, last: object) =>
  collector.observe({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total, last } } });

test("task metrics sum time spent in each status across returns and through the current observation", () => {
  const createdAt = "2026-01-01T12:00:00.000Z";
  const task = { ...createTask("T-0001", { title: "Cycle phases" }), createdAt, status: "done" as const };
  task.history = [
    { at: createdAt, action: "create", actor: "manager" },
    { at: "2026-01-01T12:00:01.000Z", action: "approve", actor: "manager", from: "draft", to: "ready" },
    { at: "2026-01-01T12:00:03.000Z", action: "start", actor: "agent", from: "ready", to: "in_progress" },
    { at: "2026-01-01T12:00:04.000Z", action: "coordination", actor: "agent", durationMs: 2000 },
    { at: "2026-01-01T12:00:07.000Z", action: "submit", actor: "agent", from: "in_progress", to: "review" },
    { at: "2026-01-01T12:00:08.000Z", action: "run-log", actor: "agent", durationMs: 3_500 },
    { at: "2026-01-01T12:00:10.000Z", action: "request-changes", actor: "reviewer", from: "review", to: "in_progress" },
    { at: "2026-01-01T12:00:13.000Z", action: "block", actor: "agent", from: "in_progress", to: "blocked" },
    { at: "2026-01-01T12:00:18.000Z", action: "resume", actor: "agent", from: "blocked", to: "in_progress" },
    { at: "2026-01-01T12:00:20.000Z", action: "submit", actor: "agent", from: "in_progress", to: "review" },
    { at: "2026-01-01T12:00:21.000Z", action: "run-log", actor: "agent" },
    { at: "2026-01-01T12:00:22.000Z", action: "accept", actor: "reviewer", from: "review", to: "done" },
    { at: "2026-01-01T12:00:30.000Z", action: "update", actor: "user" },
  ];
  const metrics = taskMetrics(task);
  assert.equal(metrics.cycleMs, 22_000);
  assert.equal(metrics.reviewerReturns, 1);
  assert.deepEqual(metrics.timeByStatusMs, { draft: 1_000, ready: 2_000, in_progress: 9_000, review: 5_000, blocked: 5_000 });
  assert.equal(metrics.observedAt, undefined);
  assert.deepEqual(metrics.executorRuns, { recorded: 2, timed: 1, durationMs: 3_500 });
  const reviewing = { ...task, status: "review" as const, history: task.history.slice(0, -2) };
  const observedAt = "2026-01-01T12:00:25.000Z";
  const pending = taskMetrics(reviewing, Date.parse(observedAt));
  assert.equal(pending.cycleMs, null);
  assert.equal(pending.observedAt, observedAt);
  assert.deepEqual(pending.executorRuns, metrics.executorRuns);
  const legacy = { ...reviewing, history: reviewing.history.filter(event => event.action !== "run-log" || event.durationMs === undefined) };
  assert.deepEqual(taskMetrics(legacy).executorRuns, { recorded: 1, timed: 0, durationMs: null });
  assert.deepEqual(pending.timeByStatusMs, { draft: 1_000, ready: 2_000, in_progress: 9_000, review: 8_000, blocked: 5_000 });
  assert.equal(taskMetrics(reviewing, Date.parse(createdAt)).timeByStatusMs, null);
  assert.equal(taskMetrics({ ...reviewing, status: "cancelled", history: [...reviewing.history,
    { at: observedAt, action: "cancel", actor: "manager", from: "review", to: "cancelled" }] }).timeByStatusMs, null);
  const mixedReturns = taskMetrics({ ...task, history: [...task.history,
    { at: "2026-01-01T12:00:21.000Z", action: "request-changes", actor: "manager" }] });
  assert.equal(mixedReturns.returns, 2);
  assert.equal(mixedReturns.reviewerReturns, 1);
  assert.equal(taskMetrics({ ...task, history: task.history.filter(event => event.action !== "start") }).timeByStatusMs, null);
});

test("review timings follow the submission across revisions and resubmissions", () => {
  const task = createTask("T-0001", { title: "Review history" });
  const submitted = "2026-01-01T12:00:00.000Z";
  task.history.push(
    { at: submitted, action: "submit", actor: "agent", from: "in_progress", to: "review" },
    { at: "2026-01-01T12:00:04.000Z", action: "update", actor: "user" },
    { at: "2026-01-01T12:00:10.000Z", action: "request-changes", actor: "reviewer", from: "review", to: "in_progress" },
    { at: "2026-01-01T12:01:00.000Z", action: "submit", actor: "agent", from: "in_progress", to: "review" },
  );
  const records = [{ ...counts(100, 20), threadId: "review", turnId: "turn", model: "model-a", incomplete: false }];
  const report: TokenUsageReport = { id: "retry", role: "reviewer", sequence: 1, records,
    reviewTiming: { submissionSequence: 2, startedAtMs: Date.parse(submitted) + 5_000, durationMs: 3_000 } };
  const saved = recordTokenUsage(recordTokenUsage(task, report), { ...report, id: "first", reviewTiming: {
    submissionSequence: 2, startedAtMs: Date.parse(submitted) + 1_000, durationMs: 2_000,
  } });
  assert.deepEqual(taskMetrics(saved).reviews, [{
    submissionSequence: 2, submittedAt: submitted, submissionToReviewerMs: 1_000,
    reviewerAttempts: [
      { durationMs: 2_000, tokens: 120, tokensIncomplete: false },
      { durationMs: 3_000, tokens: 120, tokensIncomplete: false },
    ],
    submissionToApprovalMs: null, approvalToAcceptanceMs: null,
    decision: "request-changes", decisionActor: "reviewer", submissionToDecisionMs: 10_000,
  }, {
    submissionSequence: 5, submittedAt: "2026-01-01T12:01:00.000Z", submissionToReviewerMs: null,
    submissionToApprovalMs: null, approvalToAcceptanceMs: null,
    reviewerAttempts: [], decision: null, decisionActor: null, submissionToDecisionMs: null,
  }]);
  assert.throws(() => recordTokenUsage(task, { ...report, reviewTiming: { ...report.reviewTiming, submissionSequence: 3 } }), /recorded submission/);
});

test("review metrics track approval and acceptance even after an earlier review note", () => {
  const task = createTask("T-0001", { title: "Integration delay" });
  task.history.push(
    { at: "2026-01-01T12:00:00.000Z", action: "submit", actor: "agent", from: "in_progress", to: "review" },
    { at: "2026-01-01T12:00:02.000Z", action: "review-note", actor: "reviewer" },
    { at: "2026-01-01T12:00:05.000Z", action: "review-approve", actor: "reviewer" },
  );
  const [pending] = taskMetrics(task).reviews;
  assert.equal(pending.submissionToDecisionMs, 2_000);
  assert.equal(pending.submissionToApprovalMs, 5_000);
  assert.equal(pending.approvalToAcceptanceMs, null);
  task.history.push(
    { at: "2026-01-01T12:00:06.000Z", action: "review-approve", actor: "reviewer" },
    { at: "2026-01-01T12:00:12.000Z", action: "accept", actor: "manager", from: "review", to: "done" },
  );
  const [accepted] = taskMetrics(task).reviews;
  assert.equal(accepted.decision, "review-note");
  assert.equal(accepted.submissionToApprovalMs, 6_000);
  assert.equal(accepted.approvalToAcceptanceMs, 6_000);
});

test("a slow usage write keeps only the latest pending snapshot", async () => {
  const collector = new CodexTokenUsage();
  collector.track("root", "model", true);
  const release = Promise.withResolvers<void>();
  const writes: TokenUsageReport[] = [];
  const write = async (report: TokenUsageReport) => {
    writes.push(report);
    if (writes.length === 1) await release.promise;
  };
  collector.save(collector.begin("root", "turn"), write);
  await Promise.resolve();
  collector.save(usage(collector, "root", "turn", counts(10, 1), counts(10, 1)), write);
  collector.save(usage(collector, "root", "turn", counts(20, 2), counts(10, 1)), write);
  const final = collector.finish()!;
  const flushed = collector.save(final, write);
  assert.equal(writes.length, 1);
  release.resolve();
  await flushed;
  assert.equal(writes.length, 2);
  assert.equal(writes[1], final);
  assert.equal(writes[1].records[0].totalTokens, 22);
});

test("usage checkpoints coalesce notifications and flush the final snapshot immediately", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const collector = new CodexTokenUsage();
  collector.track("root", "model", true);
  const writes: TokenUsageReport[] = [];
  const write = async (report: TokenUsageReport) => { writes.push(report); };
  await collector.save(collector.begin("root", "turn"), write);

  collector.queue(usage(collector, "root", "turn", counts(10, 1), counts(10, 1)), write);
  t.mock.timers.tick(4_000);
  collector.queue(usage(collector, "root", "turn", counts(20, 2), counts(10, 1)), write);
  assert.equal(writes.length, 1);
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].records[0].totalTokens, 22);

  collector.queue(usage(collector, "root", "turn", counts(30, 3), counts(10, 1)), write);
  await collector.save(collector.finish(true), write);
  assert.equal(writes.length, 3);
  assert.equal(writes[2].records[0].totalTokens, 33);
  assert.equal(writes[2].records[0].incomplete, true);
  t.mock.timers.tick(5_000);
  await Promise.resolve();
  assert.equal(writes.length, 3);
});

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
  const temp = realpathSync(tmpdir());
  const root = mkdtempSync(join(temp, "ai-taskboard-usage-"));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: temp };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], input?: unknown, error?: string) => {
    const reply = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", root, "--json",
      ...args, ...(input === undefined ? [] : ["--stdin"])], { env, input: JSON.stringify(input), encoding: "utf8", windowsHide: true });
    const result = JSON.parse(reply.stdout);
    assert.equal(result.ok, !error, reply.stdout + reply.stderr);
    if (error) assert.equal(result.error.code, error);
    return result.data;
  };
  assert.equal(cli(["init"]).project, root);
  assert.deepEqual(cli(["manager-usage"]), { reports: 0, total: null, incomplete: true, byModel: [] });
  assert.equal(cli(["project-usage"]).total, null);
  const first = cli(["create"], plannedDraft({ title: "First task" }));
  const second = cli(["create"], plannedDraft({ title: "Other task" }));
  const record = { ...counts(100, 20, 50, 10), threadId: "root", turnId: "turn", model: "model-a", incomplete: false };
  const report: TokenUsageReport = { id: "run-1", sequence: 1, records: [record] };
  const manager = { ...report, id: "00000000-0000-0000-0000-000000000001" };
  const saveManager = (value: unknown) => cli(["manager-usage"], value);
  const boardLock = new DatabaseSync(join(root, ".tasks", ".lock.sqlite"));
  try {
    boardLock.exec("BEGIN IMMEDIATE");
    assert.deepEqual(saveManager(manager), { id: manager.id, sequence: 1 });
    saveManager({ ...manager, sequence: 2, records: [{ ...record, ...counts(200, 30, 80, 15) }] });
    assert.equal(saveManager(manager).sequence, 2);
    saveManager({ ...manager, id: "00000000-0000-0000-0000-000000000002",
      records: [{ ...record, threadId: "child", turnId: "retry", incomplete: true }] });
    assert.deepEqual(cli(["manager-usage"]), { reports: 2, total: 350, incomplete: true,
      byModel: [{ ...counts(300, 50, 130, 25), model: "model-a", incomplete: true }] });
  } finally {
    boardLock.close();
  }
  cli(["manager-usage"], { ...manager, id: "../invalid" }, "INVALID_INPUT");
  const save = (value: unknown) => cli(["token-usage", first.id], value);
  assert.equal(save(report).revision, first.revision);
  const cardPath = join(root, ".tasks", "tasks", first.id + ".json");
  const oldTime = new Date(1_000_000);
  utimesSync(cardPath, oldTime, oldTime);
  const modifiedAt = statSync(cardPath).mtimeMs;
  const receipt = cli(["token-usage", first.id, "--compact"], report);
  assert.equal(receipt.id, first.id);
  assert.equal(receipt.history, undefined);
  assert.equal(receipt.tokenUsage, undefined);
  assert.equal(statSync(cardPath).mtimeMs, modifiedAt);
  save({ ...report, sequence: 0, records: [{ ...record, ...counts(1, 1) }] });
  save({ ...report, sequence: 2, records: [{ ...record, ...counts(200, 30, 80, 15) }] });
  save({ ...report, id: "retry", role: "reviewer", records: [{ ...record, turnId: "retry" }] });
  const current = cli(["show", first.id]);
  assert.deepEqual(current.tokenUsage.byModel, [{ ...counts(300, 50, 130, 25), model: "model-a", incomplete: false }]);
  assert.equal(current.history.length, first.history.length);
  assert.equal(current.updatedAt, first.updatedAt);
  assert.equal(cli(["show", second.id]).tokenUsage, undefined);
  const { observedAt, ...openMetrics } = cli(["metrics", first.id]);
  const draftAge = Date.parse(observedAt) - Date.parse(first.createdAt);
  assert.ok(draftAge >= 0);
  assert.deepEqual(openMetrics, {
    id: first.id, status: "draft", createdAt: first.createdAt, completedAt: null, acceptedBy: null,
    cycleMs: null, timeByStatusMs: { draft: draftAge }, submissions: 0, returns: 0, reviewerReturns: 0, reviews: [],
    tokens: { total: 350, incomplete: false, byRole: {
      reviewer: [{ ...counts(100, 20, 50, 10), model: "model-a", incomplete: false }],
      unattributed: [{ ...counts(200, 30, 80, 15), model: "model-a", incomplete: false }],
    } },
  });
  assert.equal(cli(["metrics", second.id]).tokens.total, null);
  const boardMetrics = cli(["metrics"]);
  assert.equal(new Set(boardMetrics.map((item: { observedAt: string }) => item.observedAt)).size, 1);
  cli(["token-usage", first.id], { ...report, role: "manager" }, "INVALID_INPUT");
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
  assert.equal(cli(["metrics", first.id]).tokens.total, 350);
  const project = cli(["project-usage"]);
  assert.equal(project.total, 700);
  assert.equal(project.missingTasks, 1);
  assert.equal(project.incomplete, true);
  assert.equal(project.byModel[0].cachedInputTokens, 260);
  assert.equal(project.byModel[0].reasoningOutputTokens, 50);
  assert.equal(project.byRole.manager[0].totalTokens, 350);
  assert.equal(project.byRole.reviewer[0].totalTokens, 120);
  assert.equal(project.byRole.unattributed[0].totalTokens, 230);
  const zero = { ...record, ...counts(0, 0), model: null };
  cli(["token-usage", second.id], { id: "zero", sequence: 1, role: "discussion", records: [zero] });
  cli(["token-usage", second.id], { id: "future", sequence: 1, role: "executor",
    records: [{ ...zero, model: "future-model", ...counts(10, 2) }] });
  const refreshed = cli(["project-usage"]);
  assert.equal(refreshed.total, 712);
  assert.equal(refreshed.missingTasks, 0);
  assert.equal(refreshed.byModel.find((m: { model: string | null }) => m.model === null).totalTokens, 0);
  assert.equal(refreshed.byRole.executor[0].model, "future-model");
});


test("project totals distinguish zero from missing and partial records on closed tasks", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ai-taskboard-project-usage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  initializeBoard(location, store => {
    assert.equal(projectUsage(store).total, null);
    const zero = { ...counts(0, 0), threadId: "zero", turnId: "zero", model: null, incomplete: false };
    store.create(recordTokenUsage({ ...createTask("T-0001", { title: "Completed zero" }), status: "done" },
      { id: "zero", sequence: 1, role: "executor", records: [zero] }));
    managerUsage(location.directory, { id: "00000000-0000-0000-0000-000000000001", sequence: 1, records: [zero] });
    const complete = projectUsage(store);
    assert.equal(complete.total, 0);
    assert.equal(complete.incomplete, false);
    assert.equal(complete.byRole.executor[0].model, null);
    store.create(recordTokenUsage({ ...createTask("T-0002", { title: "Cancelled partial" }), status: "cancelled" },
      { id: "partial", sequence: 1, records: [{ ...zero, model: "future-model", totalTokens: null, inputTokens: 5,
        outputTokens: null, reasoningOutputTokens: null, incomplete: true }] }));
    store.create(createTask("T-0003", { title: "Legacy without reports" }));
    const partial = projectUsage(store);
    assert.equal(partial.total, 0);
    assert.equal(partial.incomplete, true);
    assert.equal(partial.missingTasks, 1);
    assert.equal(partial.tasks, 3);
    assert.equal(partial.byRole.unattributed[0].totalTokens, null);
    assert.equal(partial.byRole.unattributed[0].inputTokens, 5);
    assert.equal(partial.byModel.find(model => model.model === "future-model")?.totalTokens, null);
  });
});
