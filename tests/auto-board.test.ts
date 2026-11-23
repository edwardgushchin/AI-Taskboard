import { isManual } from "../src/cli/manual-board.ts";
import localization from "../src/desktop/localization.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { launchableTasks, nextReadyTask } from "../src/desktop/auto-queue.ts";
import { matchesQueuedExecutor, type RuntimeEntry } from "../src/desktop/board-runtime.ts";
import { pendingReviewApprovals } from "../src/desktop/automation-delivery.ts";
import { reviewsAcceptanceRepair, taskReviewMode, taskReviewModeVersion, usesIndependentReviewer } from "../src/cli/model.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const code = parsed.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ["scheduleAutoBoard", "nextDeferredExecutor", "launchDeferredExecutor", "resumeDeferredBoardGoal"].includes(node.name?.text ?? "") ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) &&
    (d.name.text === "autoBoards" || d.name.text === "managerNoticeKey")))
  .map(node => node.getText(parsed)).join("\n");

function fixture(mode = "human") {
  const board: any = { project: "project", settings: { autoMode: true, reviewMode: mode, taskLimits: { executor: 1, reviewer: 1 } },
    tasks: [], managerInbox: [] };
  const watch: any = { board, tabs: new Set([{ window: { isDestroyed: () => false, webContents: {} } },
    { window: { isDestroyed: () => false, webContents: {} } }]), reviewerRuns: new Map() };
  const slots = createAgentSlots();
  const queued: RuntimeEntry[] = [];
  const managers = new Map<string, any>(), dialogues = new Map<string, any>();
  const busy = new Map<string, () => void>();
  const launches: string[] = [], accepted: string[] = [], reviews: string[] = [], notices: any[] = [], calls: string[][] = [], errors: string[] = [];
  let afterLaunch: (() => void) | undefined, beforeAccept: (() => void) | undefined, afterReviewRead: (() => void) | undefined, launchError: string | undefined;
  let noticeError: string | undefined;
  let milestonesError: string | undefined;
  let budgetWaiting = false;
  const fail = (code: string) => ({ ok: false, error: { code, message: code } });
  const runtime = runInNewContext(stripTypeScriptTypes(code) + "\n({scheduleAutoBoard, autoBoards})", {
    quotaWait: undefined,
    boardBudgetFailure: () => budgetWaiting ? fail("BOARD_CODEX_BUDGET") : undefined,
    applicationUpdates: { installing: false },
    subscriptions: new Map([["project", watch]]), closingProjects: new Set(), boardWorkRequests: managers, boardRequests: dialogues,
    backgroundManagerRequests: new Map(),
    isManual, launchableTasks, nextReadyTask, pendingReviewApprovals, taskReviewMode, taskReviewModeVersion, reviewsAcceptanceRepair, usesIndependentReviewer,
    currentActiveGoal: () => undefined,
    agentSlots: { ...slots, entries: () => queued },
    matchesQueuedExecutor, queuedRecoveryDelay: new Set(), projectIdentity: (path: string) => path,
    executorBusy: (_: string, id: string) => busy.has(id), t: (key: string) => localization.text(key, {}, "en"),
    broadcastBoardChat: (_: string, __: string, value: any) => errors.push(value.error),
    reserveAgent: (_: string, role: "reviewer", _task: string, _revision: number | undefined, review: { id: string; mode: string }) =>
      !board.settings.autoMode || taskReviewMode(board.tasks.find((task: any) => task.id === review.id), board.settings) !== review.mode
        ? undefined : slots.acquire("project", role, board.settings.taskLimits),
    publishReviewActivity: () => {},
    reviewSubmission: async (_: unknown, id: string) => {
      reviews.push(id);
      const task = board.tasks.find((task: any) => task.id === id);
      if (!task.needsHuman) task.approvalTarget = task.reviewApprovalTargetHead = "target";
    },
    runBoardRequest: async (...args: any[]) => {
      notices.push(args);
      if (noticeError) {
        const error = noticeError;
        noticeError = undefined;
        return fail(error);
      }
      return { ok: true, data: {} };
    },
    callCli: async (_: string, args: string[], input: any) => {
      calls.push(args);
      const task = board.tasks.find((task: any) => task.id === args[1]);
      if (args[0] === "list") {
        for (const task of board.tasks) task.unfinishedDependencies = (task.dependencies ?? []).filter((id: string) =>
          board.tasks.find((task: any) => task.id === id)?.status !== "done");
        return { ok: true, data: structuredClone(board) };
      }
      if (args[0] === "milestones") {
        if (milestonesError) return fail(milestonesError);
        return { ok: true, data: { repository: "owner/repo", milestones: [{ number: 1, due_on: "2026-11-20T00:00:00Z" }] } };
      }
      if (args[0] === "review") {
        afterReviewRead?.();
        return { ok: true, data: { revision: task.revision, targetHead: "target", stale: false,
        reviewMode: taskReviewMode(task, board.settings), reviewModeVersion: taskReviewModeVersion(task, board.settings),
        reviewerApproval: { targetHead: task.approvalTarget ?? "target" } } };
      }
      if (args[0] === "accept") {
        beforeAccept?.();
        if (!board.settings.autoMode || board.settings.reviewMode !== "reviewer") return fail("AUTO_MODE_DISABLED");
        assert.equal(input.actor, "manager"); assert.equal(input.autoMode, true);
        accepted.push(task.id); task.status = "done";
      }
      if (args[0] === "block") {
        task.status = "blocked";
        board.managerInbox.push({ id: task.id, sequence: 1, kind: "block", blocked: { reason: input.reason, condition: input.condition } });
      }
      return { ok: true, data: task };
    },
    launchTask: async (_: string, id: string, ...args: any[]) => {
      if (args[10] === undefined && args[11] === undefined) {
        assert.equal(args[7], Boolean(board.settings.autoMode));
      } else {
        assert.equal(args[7], false);
      }
      if (launchError) { const error = launchError; launchError = undefined; return fail(error); }
      const task = board.tasks.find((task: any) => task.id === id);
      const release = slots.acquire("project", task.mergeRepair ? "reviewer" : "executor", board.settings.taskLimits);
      assert.ok(release, "dispatch exceeded its role limit");
      busy.set(id, release); launches.push(id);
      task.status = "in_progress";
      const pending = queued.findIndex(entry => entry.task === id);
      if (pending >= 0) queued.splice(pending, 1);
      afterLaunch?.();
      return { ok: true, data: {} };
    },
  });
  const tick = async (now = Date.now()) => {
    runtime.scheduleAutoBoard(watch, now);
    runtime.scheduleAutoBoard(watch, now);
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!runtime.autoBoards.get(watch)?.running) return;
    }
    throw new Error("Dispatcher did not settle");
  };
  const add = (id: string, fields: any = {}) => board.tasks.push({
    id, status: "ready", priority: "normal", revision: 1, expertWorkPlanned: true, expertReviewPlanned: true, ...fields,
  });
  const finish = (id: string) => {
    busy.get(id)?.(); busy.delete(id);
    const task = board.tasks.find((task: any) => task.id === id);
    task.status = "review"; task.revision++; task.reviewApproved = mode === "reviewer";
  };
  return { board, watch, slots, queued, launches, accepted, reviews, notices, calls, errors, tick, add, finish, managers, dialogues,
    failNotice: (code: string) => { noticeError = code; },
    setMilestonesError: (code?: string) => { milestonesError = code; },
    expireMilestones: () => { runtime.autoBoards.get(watch).milestonesAt = 0; },
    waitForBudget: (value: boolean) => { budgetWaiting = value; },
    afterLaunch: (callback: () => void) => { afterLaunch = callback; }, beforeAccept: (callback: () => void) => { beforeAccept = callback; },
    afterReviewRead: (callback: () => void) => { afterReviewRead = callback; },
    failLaunch: (code: string) => { launchError = code; } };
}

test("a free executor slot goes to the eligible urgent card across ready and persisted starts", async () => {
  for (const urgentReturn of [false, true]) {
    const f = fixture();
    const occupied = f.slots.acquire("project", "executor", f.board.settings.taskLimits)!;
    f.add("T-0001", { status: "in_progress", reviewReturn: 1 });
    f.queued.push({ id: "queue:T-0001", owner: 0, kind: "queue", task: "T-0001", revision: 1, reviewReturn: true });
    f.add("T-0002", { dueDate: "2026-01-01", priority: urgentReturn ? "normal" : "urgent" });
    await f.tick();
    assert.deepEqual(f.launches, []);
    if (urgentReturn) {
      f.board.tasks[0].priority = "urgent";
      f.board.tasks[0].revision++;
    }
    occupied();
    await f.tick();
    assert.deepEqual(f.launches, [urgentReturn ? "T-0001" : "T-0002"]);
  }
});

test("auto mode off preserves a queued urgent return ahead of a due recurring launch", async () => {
  const f = fixture();
  f.board.settings.autoMode = false;
  f.add("T-0001", { status: "in_progress", priority: "urgent", reviewReturn: 1 });
  f.queued.push({ id: "queue:T-0001", owner: 0, kind: "queue", task: "T-0001", revision: 1, reviewReturn: true });
  f.add("T-0002", { schedule: { everyMinutes: 60, nextAt: "2026-01-01T00:00:00Z" } });
  f.add("T-0003", { priority: "urgent" });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001"]);
  f.finish("T-0001");
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001", "T-0002"]);
});

test("the daily budget defers dispatch until the next eligible scheduler pass", async () => {
  const first = fixture();
  const second = fixture();
  first.add("T-0001");
  second.add("T-0002");
  first.waitForBudget(true);
  await Promise.all([first.tick(), second.tick()]);
  assert.deepEqual(first.launches, []);
  assert.deepEqual(second.launches, ["T-0002"]);
  first.waitForBudget(false);
  await first.tick();
  await first.tick();
  assert.deepEqual(first.launches, ["T-0001"]);
});

test("a budget-deferred native goal wakes with auto mode off and respects an owner pause", () => {
  const settings = { autoMode: false, autoQueue: { paused: true } };
  const watch = {
    board: { project: "project", settings },
    tabs: new Set([{ window: { isDestroyed: () => false, webContents: {} } }]),
  };
  const goal = { status: "active", objective: "Plan a release" };
  const resumes = new Map<string, boolean>();
  const launched: string[] = [];
  let budgetWaiting = true;
  let deferred = true;
  const resume = runInNewContext(stripTypeScriptTypes(code) + "\nresumeDeferredBoardGoal", {
    applicationUpdates: { installing: false },
    quotaWait: undefined,
    closingProjects: new Set(),
    isManual: () => false,
    projectIdentity: (project: string) => project,
    boardWorkRequests: new Map(),
    boardGoalResumes: resumes,
    boardGoalClears: new Map(),
    boardThreadPath: () => "binding",
    readBoardThread: () => ({ budgetDeferred: deferred, goal }),
    boardBudgetFailure: () => budgetWaiting ? {} : undefined,
    resumeBoardGoal: (_sender: unknown, _board: unknown, objective: string, expectedDeferred: boolean) => {
      assert.equal(expectedDeferred, true);
      launched.push(objective);
      resumes.set("project", true);
    },
  });
  resume(watch);
  budgetWaiting = false;
  goal.status = "paused";
  resume(watch);
  assert.deepEqual(launched, []);
  goal.status = "active";
  resume(watch);
  resume(watch);
  resumes.clear();
  deferred = false;
  resume(watch);
  assert.deepEqual(launched, ["Plan a release"]);
});

test("acknowledged approval wakes one manager after dialogue release and retries a refused start", async () => {
  const f = fixture("reviewer");
  f.board.settings.autoMode = false;
  f.add("T-0001", { status: "review", reviewApproved: true });
  f.add("T-0002");
  f.board.managerInbox.push({ id: "T-0001", sequence: 7, kind: "review-approve" });
  f.dialogues.set("project", {});
  await f.tick(100);
  assert.equal(f.notices.length, 0);
  f.board.managerInbox = [];
  f.dialogues.clear();
  f.failNotice("BOARD_BUSY");
  await f.tick(200);
  await f.tick(300);
  assert.equal(f.notices.length, 1);
  await f.tick(30_200);
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1][4], false);
  assert.deepEqual(f.notices[1].at(-1).map(({ id }: { id: string }) => id), ["T-0001"]);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.errors, []);

  f.board.tasks[0].status = "done";
  await f.tick(60_200);
  assert.equal(f.notices.length, 2);
});

test("untried approvals get a turn even when four failed approvals become retryable", async () => {
  const f = fixture("reviewer");
  f.board.settings.autoMode = false;
  const first = ["T-0001", "T-0002", "T-0003", "T-0004"];
  for (const [index, id] of [...first, "T-0005"].entries()) {
    f.add(id, { status: "review", reviewApproved: true });
    f.board.managerInbox.push({ id, sequence: index + 1, kind: "review-approve" });
  }
  const batch = (index: number) => f.notices[index].at(-1).map(({ id }: { id: string }) => id);

  await f.tick(100);
  assert.deepEqual(batch(0), first);
  // The first batch remains in review, and its manager turn outlasts the retry delay.
  await f.tick(30_101);
  assert.deepEqual(batch(1), ["T-0005", ...first.slice(0, 3)]);
  f.board.tasks[4].status = "done";
  await f.tick(30_102);
  assert.deepEqual(batch(2), ["T-0004"]);
  assert.deepEqual(f.launches, []);
});

test("approved cards in human acceptance modes stay out of the background turn", async () => {
  for (const mode of ["human", "reviewer-human"]) {
    const f = fixture(mode);
    f.board.settings.autoMode = false;
    f.add("T-0001", { status: "review", reviewApproved: true });
    f.board.managerInbox.push({ id: "T-0001", sequence: 2, kind: "review-approve" });
    await f.tick();
    assert.equal(f.notices.length, 0, mode);
  }
});

test("automatic cycles share slots across windows and release dependencies only after acceptance in each mode", async () => {
  for (const mode of ["human", "reviewer"]) {
    const f = fixture(mode);
    f.add("T-0002", { dependencies: ["T-0001"] }); f.add("T-0001");
    await f.tick(); assert.deepEqual(f.launches, ["T-0001"]);
    f.finish("T-0001"); await f.tick();
    if (mode === "human") {
      assert.deepEqual(f.accepted, []); assert.deepEqual(f.launches, ["T-0001"]);
      f.board.tasks.find((task: any) => task.id === "T-0001").status = "done";
      await f.tick();
    } else assert.deepEqual(f.accepted, ["T-0001"]);
    assert.deepEqual(f.launches, ["T-0001", "T-0002"]);
  }
});

test("off and lowered limits apply before the next decision without interrupting an active executor", async () => {
  for (const disable of [false, true]) {
    const f = fixture(); f.board.settings.taskLimits.executor = 2;
    f.add("T-0001"); f.add("T-0002");
    f.afterLaunch(() => { if (disable) f.board.settings.autoMode = false; else f.board.settings.taskLimits.executor = 1; });
    await f.tick(); assert.deepEqual(f.launches, ["T-0001"]);
    assert.equal(f.board.tasks[0].status, "in_progress");
  }
});

test("automatic planning requests missing plans once and dispatches already planned work within the limit", async () => {
  const f = fixture("reviewer");
  f.add("T-0001", { priority: "high", expertWorkPlanned: false, expertReviewPlanned: false });
  f.add("T-0002", { expertWorkPlanned: true, expertReviewPlanned: true });
  f.add("T-0003", { status: "draft" });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0002"]);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0][2], /T-0001/);
  assert.doesNotMatch(f.notices[0][2], /T-0003/);
  await f.tick();
  assert.equal(f.notices.length, 1);
  Object.assign(f.board.tasks[0], { expertWorkPlanned: true, expertReviewPlanned: true, revision: 2 });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0002"]);
  f.finish("T-0002");
  await f.tick();
  assert.deepEqual(f.launches, ["T-0002", "T-0001"]);
});

test("automatic dispatch preserves the assigned work of an older expert stage", async () => {
  const f = fixture("reviewer");
  f.add("T-0001", { expertStage: { parentId: "T-0002" }, expertReviewPlanned: false });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001"]);
  assert.deepEqual(f.notices, []);
});

test("missing plans reach the manager for due schedules and reviews independently of automatic dispatch", async () => {
  for (const autoMode of [false, true]) {
    const f = fixture("reviewer-human");
    Object.assign(f.board.settings, { autoMode, reviewModeVersion: 2, requireExpertPlans: false });
    const overdue = { everyMinutes: 60, nextAt: "2000-01-01T00:00:00Z" };
    const repair = { phase: "checking", reviewModeVersion: 2 };
    f.add("T-0001", { schedule: overdue, expertWorkPlanned: false, expertReviewPlanned: false });
    f.add("T-0002", { status: "review", expertReviewPlanned: false });
    f.add("T-0003", { status: "review", expertReviewPlanned: false, acceptanceRepair: repair });
    f.add("T-0004", { schedule: { ...overdue, paused: true }, expertWorkPlanned: false });
    f.add("T-0005", { status: "review", expertReviewPlanned: false, acceptanceRepair: { ...repair, reviewModeVersion: 1 } });
    f.add("T-0006", { status: "review", expertReviewPlanned: false, acceptanceRepair: { ...repair, phase: "running" } });
    f.add("T-0007", { status: "review", expertReviewPlanned: false, acceptanceRepair: repair, reviewPending: true });
    f.add("T-0008", { status: "review", expertReviewPlanned: false, reviewApproved: true });
    await f.tick();
    await f.tick();
    assert.deepEqual(f.errors, []);
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.notices[0][2].match(/T-\d+/g), ["T-0001", "T-0002", "T-0003"]);
    assert.deepEqual(f.launches, []);
    assert.deepEqual(f.reviews, []);
    f.board.tasks[0].expertWorkPlanned = true;
    f.board.tasks[0].revision++;
    await f.tick();
    assert.deepEqual(f.launches, ["T-0001"]);
  }
});

test("a legacy approval that becomes stale cannot launch an unplanned reviewer", async () => {
  const f = fixture("reviewer");
  f.add("T-0001", { status: "review", expertReviewPlanned: false, reviewApproved: true, approvalTarget: "old-target" });
  await f.tick();
  assert.deepEqual(f.reviews, []);
  assert.deepEqual(f.accepted, []);
  f.board.tasks[0].reviewApproved = false;
  await f.tick();
  assert.match(f.notices[0][2], /T-0001/);
});

test("with automatic dispatch off, a legacy reviewer submission requests a plan but ready work waits", async () => {
  const f = fixture("human");
  f.board.settings.autoMode = false;
  f.add("T-0001", {
    status: "review", expertReviewPlanned: false, reviewModeOverride: { mode: "reviewer", version: 1 },
  });
  f.add("T-0002", { status: "review", expertReviewPlanned: false });
  f.add("T-0003", { expertWorkPlanned: false });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.launches, []);
  assert.equal(f.notices.length, 1);
  assert.deepEqual(f.notices[0][2].match(/T-\d+/g), ["T-0001"]);
});

test("an explicitly requested child gets a plan even with automatic dispatch off", async () => {
  const f = fixture();
  f.board.settings.autoMode = false;
  f.add("T-0001", { launchRequested: true, expertWorkPlanned: false });
  f.add("T-0002");
  await f.tick();
  assert.deepEqual(f.launches, []);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0][2], /T-0001/);
  assert.doesNotMatch(f.notices[0][2], /T-0002/);
  Object.assign(f.board.tasks[0], { expertWorkPlanned: true, revision: 2 });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001"]);
});

test("automatic dispatch resumes a paused merge repair when only reviewer capacity is available", async () => {
  const f = fixture();
  f.add("T-0001");
  await f.tick();
  f.add("T-0002");
  f.add("T-0003", { mergeRepair: true });
  const reviewer = f.slots.acquire("project", "reviewer", f.board.settings.taskLimits)!;
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001"]);
  reviewer();
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001", "T-0003"]);
  f.finish("T-0003");
  f.finish("T-0001");
});

test("launch errors notify the manager once and independent work keeps moving", async () => {
  const f = fixture(); f.add("T-0001"); f.add("T-0002"); f.failLaunch("CODEX_UNAVAILABLE");
  await f.tick(); await f.tick();
  assert.equal(f.board.tasks[0].status, "blocked"); assert.deepEqual(f.launches, ["T-0002"]);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].at(-1), true);
  assert.match(f.notices[0][2], /CODEX_UNAVAILABLE/);
});

test("an active goal shares automatic dispatch, integration and exception delivery", async () => {
  const f = fixture("reviewer");
  const events: any[] = [];
  f.managers.set("project", { goalRunning: true, automationEvent: (event: any) => events.push(event) });
  f.add("T-0001"); f.add("T-0002", { dependencies: ["T-0001"] });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001"]);
  f.finish("T-0001");
  await f.tick();
  assert.deepEqual(f.accepted, ["T-0001"]);
  assert.deepEqual(f.launches, ["T-0001", "T-0002"]);
  f.finish("T-0002");
  f.add("T-0003", { status: "ready", launchRequested: true });
  f.failLaunch("CODEX_UNAVAILABLE");
  await f.tick();
  assert.equal(events.length, 1);
  assert.match(events[0].error, /CODEX_UNAVAILABLE/);
  assert.equal(f.notices.length, 0, "the goal handles exceptions in its existing context");
});

test("manager queue edits take effect between automatic launches and preserve role limits", async () => {
  const f = fixture();
  f.board.settings.taskLimits.executor = 2;
  f.board.settings.autoQueue = { revision: 1, paused: false, order: ["T-0003", "T-0002"], held: ["T-0002"] };
  f.add("T-0001"); f.add("T-0002"); f.add("T-0003");
  f.afterLaunch(() => { f.board.settings.autoQueue = { revision: 2, paused: true, order: [], held: ["T-0002"] }; });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0003"]);
  assert.equal(f.board.tasks[2].status, "in_progress");
  f.afterLaunch(() => {});
  f.board.settings.autoQueue.paused = false;
  await f.tick();
  assert.deepEqual(f.launches, ["T-0003", "T-0001"]);
  f.finish("T-0003");
  f.board.settings.autoQueue.held = [];
  await f.tick();
  assert.deepEqual(f.launches, ["T-0003", "T-0001", "T-0002"]);
});

test("a stale dispatch revision retries the changed queue without blocking a task", async () => {
  const f = fixture();
  f.add("T-0001"); f.add("T-0002");
  f.failLaunch("AUTO_QUEUE_CHANGED");
  await f.tick();
  assert.deepEqual(f.launches, []);
  assert.equal(f.board.tasks[0].status, "ready");
  assert.deepEqual(f.notices, []);
  f.board.settings.autoQueue = { revision: 1, paused: false, order: ["T-0002"], held: [] };
  await f.tick();
  assert.deepEqual(f.launches, ["T-0002"]);
});

test("queue pause preserves reviewer-mode integration while preventing fresh dispatch", async () => {
  const f = fixture("reviewer");
  f.board.settings.autoQueue = { revision: 1, paused: true, order: [], held: [] };
  f.add("T-0001", { status: "review", reviewApproved: true });
  f.add("T-0002");
  await f.tick();
  assert.deepEqual(f.accepted, ["T-0001"]);
  assert.deepEqual(f.launches, []);
  f.board.settings.autoQueue.paused = false;
  await f.tick();
  assert.deepEqual(f.launches, ["T-0002"]);
});

test("a review-mode change during integration leaves the submission for the human", async () => {
  const f = fixture("reviewer"); f.add("T-0001", { status: "review", reviewApproved: true });
  f.beforeAccept(() => { f.board.settings.reviewMode = "human"; });
  await f.tick(); assert.deepEqual(f.accepted, []); assert.equal(f.board.tasks[0].status, "review");
});

test("milestones are fetched once for the board and the queue is recalculated after each launch", async () => {
  const f = fixture(); f.board.settings.taskLimits.executor = 2;
  const milestone = { repository: "owner/repo", number: 1, title: "Release" };
  f.add("T-0001", { milestone }); f.add("T-0002", { milestone }); f.add("T-0003", { milestone });
  f.afterLaunch(() => { f.board.tasks[2].dueDate = "2020-01-01"; });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001", "T-0003"]);
  assert.equal(f.calls.filter(args => args[0] === "milestones").length, 1);
});

test("a milestone lookup failure leaves the urgent card without a milestone eligible", async () => {
  for (const hasDeferred of [false, true]) {
    const f = fixture();
    f.setMilestonesError("GITHUB_UNAVAILABLE");
    if (hasDeferred) {
      f.add("T-0001", { status: "in_progress", reviewReturn: 1 });
      f.queued.push({ id: "queue:T-0001", owner: 0, kind: "queue", task: "T-0001", revision: 1, reviewReturn: true });
    }
    f.add("T-0002", { priority: "urgent", dueDate: "2026-01-02" });
    f.add("T-0003", {
      priority: "urgent",
      dueDate: "2026-01-01",
      milestone: { repository: "owner/repo", number: 1, title: "1.0.0" },
    });
    await f.tick();
    assert.deepEqual(f.errors, ["GITHUB_UNAVAILABLE"]);
    assert.deepEqual(f.launches, ["T-0002"]);

    f.finish("T-0002");
    await f.tick();
    assert.deepEqual(f.launches, hasDeferred ? ["T-0002", "T-0001"] : ["T-0002"]);
    assert.equal(f.calls.filter(([command]) => command === "milestones").length, 1);
    if (hasDeferred) f.finish("T-0001");

    f.setMilestonesError();
    f.expireMilestones();
    await f.tick();
    assert.equal(f.launches.at(-1), "T-0003");
    assert.equal(f.calls.filter(([command]) => command === "milestones").length, 2);
  }
});

test("a changed target is reviewed again, and missing evidence does not cause repeated unchanged reviews", async () => {
  for (const needsHuman of [false, true]) {
    const f = fixture("reviewer");
    f.add("T-0001", { status: "review", reviewApproved: true, approvalTarget: "old-target", needsHuman });
    await f.tick(); await f.tick(); await f.tick();
    assert.deepEqual(f.reviews, ["T-0001"]);
    assert.deepEqual(f.accepted, needsHuman ? [] : ["T-0001"]);
    assert.equal(f.board.tasks[0].status, needsHuman ? "review" : "done");
  }
});

test("switching off after reading stale approval prevents reviewer dispatch and allows it again on resume", async () => {
  const f = fixture("reviewer");
  f.add("T-0001", { status: "review", reviewApproved: true, approvalTarget: "old-target" });
  f.afterReviewRead(() => { f.board.settings.autoMode = false; });
  await f.tick();
  assert.deepEqual(f.reviews, []);
  assert.deepEqual(f.accepted, []);
  f.afterReviewRead(() => {});
  f.board.settings.autoMode = true;
  await f.tick();
  assert.deepEqual(f.reviews, ["T-0001"]);
  assert.deepEqual(f.accepted, ["T-0001"]);
});

test("manual boards never dispatch or review even with stale automatic settings", async () => {
  for (const autoMode of [true, false]) {
    const f = fixture("reviewer"); Object.assign(f.board.settings, { boardType: "manual", autoMode });
    f.add("T-0001", { launchRequested: true }); f.add("T-0002", { status: "review", reviewApproved: true });
    await f.tick(); assert.deepEqual(f.launches, []); assert.deepEqual(f.reviews, []); assert.deepEqual(f.accepted, []);
  }
});

for (const mode of ["human", "reviewer"]) test("explicit child queue without auto mode: " + mode, async () => {
  const f = fixture(mode); f.board.settings.autoMode = false;
  f.add("T-0001"); // unrelated ready work must remain untouched
  const parent = f.slots.acquire("project", "executor", f.board.settings.taskLimits)!;
  f.add("T-0002", { launchRequested: true, origin: { parent: "T-0099", key: "local:disk:event1", basis: "Local check" } });
  await f.tick(); assert.deepEqual(f.launches, []);
  parent(); await f.tick(); assert.deepEqual(f.launches, ["T-0002"]);
  await f.tick(); assert.deepEqual(f.launches, ["T-0002"]);
  f.finish("T-0002"); await f.tick();
  assert.equal(f.board.tasks[1].status, "review"); assert.deepEqual(f.accepted, []);
});
test("explicit request survives launch failure and waits for real dependencies", async () => {
  const f = fixture(); f.board.settings.autoMode = false;
  f.add("T-0001"); f.add("T-0002", { launchRequested: true, dependencies: ["T-0001"] });
  await f.tick(); assert.deepEqual(f.launches, []);
  f.board.tasks[0].status = "done"; f.failLaunch("CODEX_UNAVAILABLE");
  await f.tick(); assert.equal(f.board.tasks[1].status, "ready");
  assert.equal(f.board.tasks[1].launchRequested, true);
  await f.tick(); assert.deepEqual(f.launches, ["T-0002"]);
});
