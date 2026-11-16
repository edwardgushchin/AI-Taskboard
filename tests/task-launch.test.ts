import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { changeTask, createTask } from "../src/cli/tasks.ts";
import { taskIdPattern } from "../src/cli/model.ts";
import type { RunActivity, Task } from "../src/cli/model.ts";
import { missingCodexThread } from "../src/desktop/codex-run.ts";
import { createAgentSlots, parseAgentLimits } from "../src/desktop/agent-limits.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["launchTask", "recordRunFailure", "publishRunActivity", "notifyRunChange", "saveTaskTokenUsage",
  "beginOperation", "confirmProjectClose", "projectOperations", "closingProjects", "launchingTasks", "runningTasks", "runActivityByTask",
  "activeAgents", "chatRuns", "windowStates", "executorBusy", "reserveAgent", "scheduleAgentWork", "scheduleRecurringTasks",
  "deferredExecutors", "schedulingAgentWork", "executorLimit"]);
const lifecycle = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map(node => node.getText(parsed)).join("\n");
const failure = (code: string, message: string) => ({ ok: false, error: { code, message } });
const previousThread = "01234567-1234-5678-1234-123456789012";
const nextThread = "01234567-1234-5678-1234-123456789013";

function fixture(outcome: "busy" | "missing" | "failed" | "started" | "disconnect" | "closing" | "closing-on-retry" | "board-busy",
  activity?: RunActivity) {
  const task: Task = { ...createTask("T-0001", { title: "Reviewed task" }), status: "review",
    codexThreadId: outcome === "board-busy" ? undefined : previousThread,
    git: { target: "refs/heads/main", base: "a".repeat(40), branch: "refs/heads/ai-taskboard/T-0001", worktree: "worktree" } };
  const calls: { args: string[]; input: any }[] = [];
  const launched: any[] = [];
  const access = { full: false };
  const subscriptions = new Map();
  const savedSettings = new Map<string, { agentLimits: { executor: number } }>();
  const previousTurn = { status: "completed", completedAt: 1 as number | null, reads: 0 };
  type Completion = { reason: string; disconnected?: boolean; interrupted?: boolean } | undefined;
  const completion = Promise.withResolvers<Completion>();
  const retryCompletion = Promise.withResolvers<Completion>();
  const finalCompletion = Promise.withResolvers<Completion>();
  const completions = [completion, retryCompletion, finalCompletion];
  const slots = createAgentSlots();
  const runtime = runInNewContext(stripTypeScriptTypes(lifecycle) + "\n({launchTask, scheduleAgentWork, scheduleRecurringTasks, confirmProjectClose, projectOperations, runningTasks, activeAgents, deferredExecutors})", {
    AbortController, performance, setTimeout, clearTimeout, setImmediate, subscriptions, agentSlots: slots,
    locateBoard: (project: string) => project,
    readBoardSettings: (project: string) => savedSettings.get(project) ?? subscriptions.get(project)?.board.settings ?? {},
    scheduleAutoReview: () => {}, scheduleAutoBoard: () => {}, projectIdentity: (project: string) => project,
    broadcastBoardChat: () => {},
    lang: (english: string) => english, cliFailure: failure, missingCodexThread,
    app: { getPath: () => "profile" }, dialog: { showMessageBox: async () => ({ response: 1 }) },
    executorFullAccess: () => access.full, process: { platform: process.platform },
    configuredCodex: async () => ({}), runLog: (items: Map<string, unknown>) => [...items.values()], rm: async () => {},
    readLastTaskTurn: async (_profile: string, _project: string, threadId: string) => {
      assert.equal(threadId, previousThread);
      previousTurn.reads++;
      return previousTurn;
    },
    callCli: async (_project: string, args: string[], input: any) => {
      calls.push({ args, input });
      if (args[0] === "request-changes") {
        if (input.revision !== task.revision) return failure("REVISION_CONFLICT", "The task changed.");
        task.status = "in_progress";
        task.history.push({ actor: "user", action: "request-changes", at: new Date().toISOString(), text: input.reason });
        task.revision++;
      }
      if (args[0] === "resume") {
        if (input.revision !== task.revision) return failure("REVISION_CONFLICT", "The task changed.");
        task.status = "in_progress";
        task.blocked = undefined;
        task.revision++;
      }
      if (args[0] === "start") {
        if (input.revision !== task.revision) return failure("REVISION_CONFLICT", "The task changed.");
        if (input.scheduled) { task.status = "in_progress"; task.revision++; }
        const execution = task.execution ?? { provider: "codex", model: "executor-model", effort: "low" };
        return { ok: true, data: { task: { ...structuredClone(task), execution }, worktree: task.git!.worktree } };
      }
      if (args[0] === "block") {
        if (task.status !== "in_progress") return failure("INVALID_TRANSITION", "The task is no longer in progress.");
        task.status = "blocked"; task.blocked = input; task.revision++;
      }
      if (args[0] === "update") {
        if (outcome === "board-busy") return failure("BOARD_BUSY", "Another command is working on this board.");
        Object.assign(task, changeTask(task, "update", input));
      }
      if (args[0] === "progress") Object.assign(task, changeTask(task, "progress", input));
      return { ok: true, data: structuredClone(task) };
    },
    startCodexRun: async (_client: unknown, _project: string, _cwd: string, snapshot: { codexThreadId?: string; fullAccess?: boolean },
      onActivity: (item: RunActivity) => void, _usage: unknown, signal: AbortSignal, beforeTurn?: (threadId: string) => Promise<void>) => {
      launched.push(snapshot);
      const launchNumber = launched.length;
      if (outcome === "busy") throw Object.assign(new Error("thread " + previousThread + " already has an active writer"), { code: "CODEX_THREAD_BUSY" });
      if (outcome === "failed") throw new Error("Provider disconnected");
      if (outcome === "closing" || (outcome === "closing-on-retry" && launched.length === 2)) await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      const threadId = outcome === "missing" ? nextThread : snapshot.codexThreadId ?? nextThread;
      await beforeTurn?.(threadId);
      if (activity && (!snapshot.fullAccess || activity.type !== "autoApprovalReview")) onActivity(activity);
      return { threadId,
        completion: completions[launchNumber - 1]!.promise,
        steer: async () => {}, interrupt: async () => {} };
    },
  });
  return { runtime, task, calls, launched, previousTurn, completion, retryCompletion, finalCompletion, subscriptions, slots, savedSettings, access };
}

test("launch uses saved limits when the watch still has the previous value", async () => {
  for (const limit of [3, 1, 0]) {
    const f = fixture("started");
    f.task.status = "in_progress";
    f.subscriptions.set("project", { board: { tasks: [f.task], settings: { agentLimits: { executor: 2 } } }, listeners: [], tabs: new Set() });
    const releases = [f.slots.acquire("project", "executor")!, f.slots.acquire("project", "executor")!];
    f.savedSettings.set("project", { agentLimits: { executor: limit } });
    const result = await f.runtime.launchTask("project", f.task.id);
    assert.equal(result.ok, limit !== 1, JSON.stringify(result));
    assert.equal(f.launched.length, limit === 1 ? 0 : 1);
    f.task.status = "review";
    f.completion.resolve({ interrupted: true, reason: "Test completed." });
    await new Promise(resolve => setImmediate(resolve));
    for (const release of releases) release();
  }
});

test("the scheduler launches a due approved card once, waits for an executor slot and returns it to ready", async () => {
  const f = fixture("started", { id: "result", type: "agentMessage", phase: "final_answer", status: "completed", title: "", text: "Готово" });
  const dueAt = new Date(2000, 0, 1, 9).toISOString();
  f.task.status = "ready";
  f.task.schedule = { time: "09:00", nextAt: dueAt };
  const snapshot = structuredClone(f.task);
  const agentLimits = { executor: 1 };
  const tasks = [
    { ...snapshot, id: "T-0002", status: "draft" }, { ...snapshot, id: "T-0003", status: "blocked" },
    { ...snapshot, id: "T-0004", unfinishedDependencies: ["T-0002"] },
    { ...snapshot, id: "T-0005", schedule: { time: "09:00", nextAt: new Date(2100, 0, 1, 9).toISOString() } }, snapshot,
  ];
  f.subscriptions.set("project", { board: { tasks, settings: { agentLimits } }, listeners: [], tabs: new Set([1, 2]) });
  const release = f.slots.acquire("project", "executor", agentLimits)!;
  f.runtime.scheduleRecurringTasks();
  assert.equal(f.calls.length, 0);
  f.subscriptions.set("other", { board: { tasks }, listeners: [], tabs: new Set([1]) });
  f.runtime.scheduleRecurringTasks();
  f.runtime.scheduleRecurringTasks();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(call => call.args[0] === "start").map(call => [call.args[1], call.input.scheduled]), [[f.task.id, true]]);
  assert.ok(f.runtime.runningTasks.has("other\0" + f.task.id));
  assert.equal(f.task.status, "in_progress");
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.task.status, "ready");
  assert.equal(f.task.summary, "Готово");
  assert.ok(Date.parse(f.task.schedule.nextAt) > Date.now());
  assert.equal(f.slots.available("other", "executor"), 3);
  release();
});

test("each board has separate pools with per-role inheritance and unlimited overrides", () => {
  const slots = createAgentSlots();
  assert.deepEqual(slots.limits, { executor: 3, manager: 1, reviewer: 1 });
  assert.equal(parseAgentLimits({ executor: 1.5, manager: 1, reviewer: 1 }), undefined);
  assert.equal(parseAgentLimits({ executor: 3, manager: -1, reviewer: 1 }), undefined);
  const manager = slots.acquire("one", "manager");
  const reviewer = slots.acquire("one", "reviewer");
  assert.ok(manager && reviewer);
  assert.equal(slots.acquire("one", "manager"), undefined);
  assert.equal(slots.acquire("one", "reviewer"), undefined);
  assert.equal(slots.available("two", "manager"), 1);
  assert.equal(slots.available("two", "reviewer"), 1);
  assert.equal(slots.available("one", "executor", { manager: 0 }), 3);
  const extra = slots.acquire("one", "manager", { manager: 0 });
  assert.ok(extra);
  slots.configure({ executor: 2, manager: 1, reviewer: 2 });
  assert.equal(slots.available("one", "executor", { manager: 0 }), 2);
  assert.equal(slots.available("one", "reviewer", { reviewer: 1 }), 0);
  manager();
  manager();
  assert.equal(slots.available("one", "manager"), 0);
  extra();
  reviewer();
  assert.equal(slots.available("one", "manager"), 1);
  assert.equal(slots.available("one", "reviewer"), 2);
});

test("a full board preserves review feedback and another board can still launch", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const settings = { agentLimits: { executor: 1 } };
  f.subscriptions.set("full", { board: { tasks: [f.task], settings }, listeners: [] });
  const release = f.slots.acquire("full", "executor", settings.agentLimits)!;
  assert.equal((await f.runtime.launchTask("full", f.task.id)).error.code, "EXECUTOR_LIMIT");
  assert.equal((await f.runtime.launchTask("other", f.task.id)).ok, true);
  f.task.status = "review";
  const returned = await f.runtime.launchTask("full", f.task.id, { input: { revision: f.task.revision, reason: "Fix the result." } });
  assert.equal(returned.ok, true);
  assert.equal(f.runtime.deferredExecutors.get("full\0" + f.task.id).revision, f.task.revision);
  assert.equal(f.task.history.at(-1)?.text, "Fix the result.");
  assert.equal(f.launched.length, 1);
  release();
  f.completion.resolve({ interrupted: true, reason: "Turn ended." });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.runtime.deferredExecutors.size, 0);
  f.task.status = "review";
  f.retryCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.slots.available("full", "executor", settings.agentLimits), 1);
});

test("deferred executors wait for two occupied slots, follow limit changes and discard invalid requests", async () => {
  for (const action of ["release", "board-increase", "app-increase", "unlimited", "decrease", "cancel", "delete", "revision", "watch-lag"]) {
    const f = fixture("started");
    f.slots.configure({ executor: 2, manager: 1, reviewer: 1 });
    const settings: { agentLimits?: { executor: number } } = action === "app-increase" ? {} : { agentLimits: { executor: 2 } };
    const board = { tasks: [f.task], settings };
    f.subscriptions.set("project", { board, listeners: [] });
    const first = f.slots.acquire("project", "executor", settings.agentLimits)!;
    const second = f.slots.acquire("project", "executor", settings.agentLimits)!;
    await f.runtime.launchTask("project", f.task.id, { input: { revision: f.task.revision, reason: "Fix" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.runtime.deferredExecutors.size, 1, action);
    assert.equal(f.launched.length, 0, action);
    if (action === "release") first();
    if (action === "board-increase") settings.agentLimits!.executor = 3;
    if (action === "app-increase") f.slots.configure({ executor: 3, manager: 1, reviewer: 1 });
    if (action === "unlimited") settings.agentLimits!.executor = 0;
    if (action === "cancel") f.task.status = "cancelled";
    if (action === "delete") board.tasks = [];
    if (action === "revision") f.task.revision++;
    if (action === "watch-lag") board.tasks = [{ ...f.task, status: "review", revision: f.task.revision - 1 }];
    if (action === "decrease") { settings.agentLimits!.executor = 1; first(); }
    f.runtime.scheduleAgentWork();
    await new Promise(resolve => setImmediate(resolve));
    const waits = ["decrease", "watch-lag"].includes(action);
    const invalid = ["cancel", "delete", "revision"].includes(action);
    assert.equal(f.runtime.deferredExecutors.size, waits ? 1 : 0, action);
    assert.equal(f.launched.length, waits || invalid ? 0 : 1, action);
    if (waits) { board.tasks = [f.task]; first(); second(); f.runtime.scheduleAgentWork(); }
    await new Promise(resolve => setImmediate(resolve));
    if (waits) assert.equal(f.launched.length, 1, action);
    f.task.status = "review";
    f.completion.resolve(undefined);
    first(); second();
    await new Promise(resolve => setImmediate(resolve));
  }
});

test("an approved snapshot skips the redundant card read while the CLI checks the launch revision", async () => {
  const f = fixture("started");
  f.task.status = "ready";
  const snapshot = structuredClone(f.task);
  f.subscriptions.set("project", { board: { tasks: [snapshot] }, listeners: [] });
  f.task.revision++;
  const stale = await f.runtime.launchTask("project", f.task.id, undefined, false, snapshot.revision);
  assert.equal(stale.error.code, "REVISION_CONFLICT");
  assert.deepEqual(f.calls.map(call => call.args[0]), ["start"]);
  assert.equal(f.launched.length, 0);
  f.calls.length = 0;
  snapshot.revision = f.task.revision;
  assert.equal((await f.runtime.launchTask("project", f.task.id, undefined, false, snapshot.revision)).ok, true);
  assert.deepEqual(f.calls.map(call => call.args[0]), ["start"]);
  f.task.status = "review";
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
});

test("ordinary executor checkpoints keep the task running in the same chat until submission", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const launched = await f.runtime.launchTask("project", f.task.id);
  assert.equal(launched.ok, true, JSON.stringify(launched.error));
  Object.assign(f.task, changeTask(f.task, "progress", { summary: "Implemented the queue.", nextStep: "Add review." }));
  assert.equal(f.task.status, "in_progress");
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.launched[1].nextStep, "Add review.");
  Object.assign(f.task, changeTask(f.task, "progress", { summary: "Added review.", nextStep: "Verify and submit." }));
  f.retryCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 3);
  assert.ok(f.launched.every(task => task.codexThreadId === previousThread && task.git.worktree === "worktree"));
  f.task.status = "review";
  f.finalCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 3);
  assert.equal(f.task.status, "review");
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("the board follows up once when the executor exits without a changed checkpoint", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const launched = await f.runtime.launchTask("project", f.task.id);
  assert.equal(launched.ok, true, JSON.stringify(launched.error));
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  f.retryCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.task.status, "blocked");
  assert.match(f.task.blocked!.reason, /without submitting or changing the saved progress/);
});

test("a completed turn respects a blocker, an explicit stop and an access denial", async () => {
  for (const kind of ["blocker", "stop", "denied"]) {
    const f = fixture("started", kind === "denied" ? {
      id: "approval", type: "autoApprovalReview", status: "denied", title: "Access", text: "Denied",
    } : undefined);
    f.task.status = "in_progress";
    assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
    if (kind === "blocker") Object.assign(f.task, changeTask(f.task, "block", { reason: "Missing input", condition: "Supply input" }));
    if (kind === "stop") await f.runtime.activeAgents.get("project\0" + f.task.id).control.interrupt();
    f.completion.resolve(undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launched.length, 1);
    assert.equal(f.task.status, "blocked");
    assert.match(f.task.blocked!.reason, kind === "blocker" ? /Missing input/ : kind === "stop" ? /The user stopped/ : /Access denied/);
  }
});

test("a manager grant continues a sandboxed executor with full access without blocking the card", async () => {
  const f = fixture("started", { id: "approval", type: "autoApprovalReview", status: "denied", title: "Sandbox access", text: "Denied" });
  f.task.status = "in_progress";
  assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
  assert.equal(f.launched[0].fullAccess, false);
  f.access.full = true;
  f.completion.resolve({ interrupted: true, reason: "The board interrupted the old turn." });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.launched[1].fullAccess, true);
  assert.equal(f.launched[1].codexThreadId, previousThread);
  assert.equal(f.launched[1].git.worktree, "worktree");
  assert.equal(f.task.status, "in_progress");
  assert.ok(f.calls.every(call => !call.input?.entries?.some((entry: RunActivity) => entry.id === "codex-interrupted")));
  f.task.status = "review";
  f.retryCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.calls.some(call => call.args[0] === "block"));
  assert.equal(f.task.status, "review");
});

test("automatic continuation waits for a slot if the board limit falls during work", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const settings = { agentLimits: { executor: 2 } };
  f.subscriptions.set("project", { board: { tasks: [f.task], settings }, listeners: [] });
  const release = f.slots.acquire("project", "executor", settings.agentLimits)!;
  assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
  settings.agentLimits.executor = 1;
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 1);
  assert.equal(f.runtime.deferredExecutors.size, 1);
  release();
  f.runtime.scheduleAgentWork();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  f.retryCompletion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.task.status, "blocked");
});

test("an executor reconnects once to the same chat after the App Server closes", async () => {
  const disconnected = { reason: "The Codex process closed.", disconnected: true };
  const f = fixture("disconnect");
  f.task.status = "in_progress";
  assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
  f.completion.resolve(disconnected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.ok(f.launched.every(task => task.codexThreadId === previousThread && task.git.worktree === "worktree"));
  assert.equal(f.task.status, "in_progress");
  f.retryCompletion.resolve(disconnected);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(f.task.status, "blocked");
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("a busy board leaves the task resumable when it cannot link a new executor chat", async () => {
  const f = fixture("board-busy");
  f.task.status = "in_progress";
  const result = await f.runtime.launchTask("project", f.task.id);
  assert.equal(result.error.code, "BOARD_BUSY");
  assert.equal(f.task.status, "in_progress");
  assert.equal(f.task.codexThreadId, undefined);
  assert.equal(f.runtime.activeAgents.size, 0);
  assert.equal(f.runtime.projectOperations.size, 0);
  assert.ok(!f.calls.some(call => call.args[0] === "block"));
});

test("the board leaves submitted or explicitly stopped work alone after a disconnect", async () => {
  for (const stop of [false, true]) {
    const f = fixture("disconnect");
    f.task.status = "in_progress";
    assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
    if (stop) await f.runtime.activeAgents.get("project\0" + f.task.id).control.interrupt();
    else f.task.status = "review";
    f.completion.resolve({ reason: "The Codex process closed.", disconnected: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launched.length, 1);
    assert.equal(f.task.status, stop ? "blocked" : "review");
    assert.equal(f.runtime.projectOperations.size, 0);
  }
});

test("Codex interruptions stay resumable unless stopped on the board or access was denied", async () => {
  for (const outcome of ["interrupted", "stopped", "denied"]) {
    const f = fixture("started", outcome === "denied" ? {
      id: "access-denied", type: "autoApprovalReview", status: "denied", title: "Access", text: "Denied",
    } : undefined);
    f.task.status = "in_progress";
    assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
    if (outcome === "stopped") await f.runtime.activeAgents.get("project\0" + f.task.id).control.interrupt();
    f.completion.resolve({ reason: "Provider cancelled the turn.", interrupted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launched.length, 1);
    assert.equal(f.task.codexThreadId, previousThread);
    assert.equal(f.task.status, outcome === "interrupted" ? "in_progress" : "blocked");
    if (outcome === "interrupted") {
      const journal = f.calls.find(call => call.args[0] === "run-log");
      assert.ok(journal?.input.entries.some((item: RunActivity) =>
        item.status === "interrupted" && item.text.includes("Provider cancelled the turn.")));
      assert.ok(!f.calls.some(call => call.args[0] === "block"));
    } else {
      assert.match(f.task.blocked!.reason, outcome === "stopped" ? /The user stopped/ : /Access denied by Auto-review/);
    }
    assert.equal(f.runtime.projectOperations.size, 0);
  }
});

test("closing a project leaves its tasks resumable during launch and execution", async () => {
  for (const outcome of ["closing", "started"] as const) {
    const f = fixture(outcome);
    f.task.status = "in_progress";
    const launch = f.runtime.launchTask("project", f.task.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.launched.length, 1);
    const closing = f.runtime.confirmProjectClose({ window: {} }, [{ project: "project" }]);
    await new Promise(resolve => setImmediate(resolve));
    f.completion.resolve({ reason: "The project was closed." });
    assert.equal(await closing, true);
    assert.equal((await launch).ok, outcome === "started");
    assert.equal(f.task.status, "in_progress");
    assert.equal(f.task.git?.worktree, "worktree");
    assert.ok(!f.calls.some(call => call.args[0] === "block"));
    const journal = f.calls.find(call => call.args[0] === "run-log");
    assert.ok(journal?.input.entries.some((item: { text: string }) => item.text === "The project was closed."));
    assert.equal(f.runtime.runningTasks.size, 0);
    assert.equal(f.runtime.projectOperations.size, 0);
  }
});

test("closing a project during reconnection does not turn the aborted retry into a blocker", async () => {
  const f = fixture("closing-on-retry");
  f.task.status = "in_progress";
  assert.equal((await f.runtime.launchTask("project", f.task.id)).ok, true);
  f.completion.resolve({ reason: "The Codex process closed.", disconnected: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launched.length, 2);
  assert.equal(await f.runtime.confirmProjectClose({ window: {} }, [{ project: "project" }]), true);
  assert.equal(f.task.status, "in_progress");
  assert.equal(f.task.codexThreadId, previousThread);
  assert.ok(!f.calls.some(call => call.args[0] === "block"));
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("saved review feedback returns the current blocked task when the follow-up launch fails", async () => {
  for (const outcome of ["busy", "failed"] as const) {
    const f = fixture(outcome);
    const result = await f.runtime.launchTask("project", f.task.id, { input: { revision: f.task.revision, reason: "Keep board images loaded" } });
    assert.equal(result.ok, true);
    assert.equal(result.data.status, "blocked");
    assert.equal(result.data.revision, f.task.revision);
    assert.equal(f.task.history.at(-1)?.text, "Keep board images loaded");
    assert.equal(f.calls.filter(call => call.args[0] === "request-changes").length, 1);
    assert.equal(f.runtime.projectOperations.size, 0);
    if (outcome === "busy") assert.match(f.task.blocked!.condition!, /existing chat|new chat/);
  }
});

test("stale feedback fails before changing the task or starting a provider", async () => {
  const f = fixture("busy");
  const result = await f.runtime.launchTask("project", f.task.id, { input: { revision: -1, reason: "Feedback" } });
  assert.equal(result.error.code, "REVISION_CONFLICT");
  assert.equal(f.task.status, "review");
  assert.equal(f.launched.length, 0);
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("explicit continuation uses a new chat and the same worktree, and records the previous chat ID", async () => {
  const f = fixture("started");
  f.task.status = "blocked";
  f.task.blocked = { reason: "already has an active writer", condition: "Continue in a new chat." };
  const result = await f.runtime.launchTask("project", f.task.id, undefined, "user");
  assert.equal(result.ok, true);
  assert.equal(f.launched[0].codexThreadId, undefined);
  assert.equal(f.launched[0].git.worktree, "worktree");
  assert.equal(f.launched[0].execution.model, "executor-model");
  assert.equal(f.launched[0].execution.effort, "low");
  assert.equal(f.task.codexThreadId, nextThread);
  assert.ok(f.task.history.at(-1)?.text?.includes(previousThread));
  f.task.status = "review";
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.runningTasks.size, 0);
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("new-chat launch rechecks task state after the confirmation dialog", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const result = await f.runtime.launchTask("project", f.task.id, undefined, "user");
  assert.equal(result.error.code, "INVALID_INPUT");
  assert.equal(f.launched.length, 0);
  assert.equal(f.task.codexThreadId, previousThread);
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("the manager can replace a busy chat after its last turn ends", async () => {
  const f = fixture("started");
  f.task.status = "blocked";
  f.task.blocked = { reason: "already has an active writer", condition: "Continue in a new chat." };
  const revision = f.task.revision;
  const continueTask = (expectedRevision: number) =>
    f.runtime.launchTask("project", f.task.id, undefined, "manager", expectedRevision);
  assert.equal((await continueTask(revision + 1)).error.code, "REVISION_CONFLICT");
  assert.equal(f.previousTurn.reads, 0);
  f.previousTurn.status = "interrupted";
  f.previousTurn.completedAt = null;
  assert.equal((await continueTask(revision)).error.code, "CODEX_TURN_UNFINISHED");
  assert.equal(f.task.status, "blocked");
  assert.equal(f.task.revision, revision);
  assert.equal(f.task.codexThreadId, previousThread);
  assert.equal(f.launched.length, 0);
  f.previousTurn.status = "completed";
  f.previousTurn.completedAt = 2;
  assert.equal((await continueTask(revision)).ok, true);
  assert.equal(f.launched[0].codexThreadId, undefined);
  assert.equal(f.launched[0].git.worktree, "worktree");
  assert.equal(f.task.codexThreadId, nextThread);
  assert.match(f.task.history.at(-1)?.text ?? "", new RegExp("`" + previousThread + "`"));
  assert.doesNotMatch(f.task.history.at(-1)?.text ?? "", /codex:\/\//);
  f.task.status = "review";
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("retrying a missing executor chat records the previous chat ID and keeps the worktree", async () => {
  const f = fixture("missing");
  f.task.status = "blocked";
  f.task.blocked = { reason: "no rollout found for thread id " + previousThread, condition: "Resume the task." };
  const revision = f.task.revision;
  assert.equal((await f.runtime.launchTask("project", f.task.id, undefined, false, revision - 1)).error.code, "REVISION_CONFLICT");
  assert.equal(f.task.status, "blocked");
  assert.equal(f.launched.length, 0);
  const result = await f.runtime.launchTask("project", f.task.id, undefined, false, revision);
  assert.equal(result.ok, true);
  assert.equal(result.data.status, "in_progress");
  assert.equal(f.launched[0].codexThreadId, previousThread);
  assert.equal(f.launched[0].git.worktree, "worktree");
  assert.equal(f.task.codexThreadId, nextThread);
  assert.match(f.task.history.at(-1)?.text ?? "", new RegExp("`" + previousThread + "`"));
  assert.doesNotMatch(f.task.history.at(-1)?.text ?? "", /codex:\/\//);
  f.task.status = "review";
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("new-chat continuation requires an explicit confirmation and a matching blocked task", async () => {
  const handlerNode = parsed.statements.find(node => ts.isExpressionStatement(node) &&
    node.getText(parsed).startsWith('ipcMain.handle("board:launchTask",'))!;
  let handler: (...args: unknown[]) => Promise<any>;
  let response = 0;
  let launches = 0;
  const task = { status: "blocked", codexThreadId: previousThread, blocked: { reason: "already has an active writer" } };
  runInNewContext(stripTypeScriptTypes(handlerNode.getText(parsed)), {
    ipcMain: { handle: (_name: string, callback: typeof handler) => { handler = callback; } },
    stateOf: () => ({ project: "project", window: {} }), taskIdPattern, cliFailure: failure,
    lang: (english: string) => english, callCli: async () => ({ ok: true, data: task }),
    dialog: { showMessageBox: async (_window: unknown, options: { defaultId: number; cancelId: number }) => {
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); return { response };
    } },
    launchTask: async (_project: string, _id: string, _request: unknown, newThread: string) => {
      assert.equal(newThread, "user"); launches++; return { ok: true };
    },
  });
  assert.equal((await handler!({}, "T-0001", { newThread: true })).ok, true);
  assert.equal(launches, 0);
  response = 1;
  assert.equal((await handler!({}, "T-0001", { newThread: true })).ok, true);
  assert.equal(launches, 1);
  task.status = "review";
  assert.equal((await handler!({}, "T-0001", { newThread: true })).error.code, "INVALID_INPUT");
  assert.equal(launches, 1);
});
