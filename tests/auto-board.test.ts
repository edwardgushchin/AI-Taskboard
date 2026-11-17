import { isManual } from "../src/cli/manual-board.ts";
import localization from "../src/desktop/localization.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { nextReadyTask } from "../src/desktop/auto-queue.ts";
import { boardReviewMode } from "../src/cli/model.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const code = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "scheduleAutoBoard" ||
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "autoBoards"))
  .map(node => node.getText(parsed)).join("\n");

function fixture(mode = "human") {
  const board: any = { project: "project", settings: { autoMode: true, reviewMode: mode, agentLimits: { executor: 1, reviewer: 1 } },
    tasks: [], managerInbox: [] };
  const watch: any = { board, tabs: new Set([{ window: { isDestroyed: () => false, webContents: {} } },
    { window: { isDestroyed: () => false, webContents: {} } }]), reviewerRuns: new Map() };
  const slots = createAgentSlots();
  const busy = new Map<string, () => void>();
  const launches: string[] = [], accepted: string[] = [], reviews: string[] = [], notices: any[] = [], calls: string[][] = [], errors: string[] = [];
  let afterLaunch: (() => void) | undefined, beforeAccept: (() => void) | undefined, launchError: string | undefined;
  const fail = (code: string) => ({ ok: false, error: { code, message: code } });
  const runtime = runInNewContext(stripTypeScriptTypes(code) + "\n({scheduleAutoBoard, autoBoards})", {
    subscriptions: new Map([["project", watch]]), closingProjects: new Set(), boardWorkRequests: new Map(),
    isManual, nextReadyTask, boardReviewMode, agentSlots: slots, projectIdentity: (path: string) => path,
    executorBusy: (_: string, id: string) => busy.has(id), t: (key: string) => localization.text(key, {}, "en"),
    broadcastBoardChat: (_: string, __: string, value: any) => errors.push(value.error),
    reserveAgent: (_: string, role: "reviewer") => slots.acquire("project", role, board.settings.agentLimits),
    publishReviewActivity: () => {},
    reviewSubmission: async (_: unknown, id: string) => {
      reviews.push(id);
      const task = board.tasks.find((task: any) => task.id === id);
      if (!task.needsHuman) task.approvalTarget = "target";
    },
    runBoardRequest: async (...args: any[]) => { notices.push(args); return { ok: true, data: {} }; },
    callCli: async (_: string, args: string[], input: any) => {
      calls.push(args);
      const task = board.tasks.find((task: any) => task.id === args[1]);
      if (args[0] === "list") {
        for (const task of board.tasks) task.unfinishedDependencies = (task.dependencies ?? []).filter((id: string) =>
          board.tasks.find((task: any) => task.id === id)?.status !== "done");
        return { ok: true, data: structuredClone(board) };
      }
      if (args[0] === "milestones") return { ok: true, data: { repository: "owner/repo", milestones: [{ number: 1, due_on: "2026-11-20T00:00:00Z" }] } };
      if (args[0] === "review") return { ok: true, data: { revision: task.revision, targetHead: "target", stale: false, reviewerApproval: { targetHead: task.approvalTarget ?? "target" } } };
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
      assert.equal(args.at(-1), true);
      if (launchError) { const error = launchError; launchError = undefined; return fail(error); }
      const task = board.tasks.find((task: any) => task.id === id);
      const release = slots.acquire("project", task.mergeRepair ? "reviewer" : "executor", board.settings.agentLimits);
      assert.ok(release, "dispatch exceeded its role limit");
      busy.set(id, release); launches.push(id);
      task.status = "in_progress";
      afterLaunch?.();
      return { ok: true, data: {} };
    },
  });
  const tick = async () => {
    runtime.scheduleAutoBoard(watch); runtime.scheduleAutoBoard(watch);
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setImmediate(resolve));
      if (!runtime.autoBoards.get(watch)?.running) return;
    }
    throw new Error("Dispatcher did not settle");
  };
  const add = (id: string, fields: any = {}) => board.tasks.push({ id, status: "ready", priority: "normal", revision: 1, ...fields });
  const finish = (id: string) => {
    busy.get(id)?.(); busy.delete(id);
    const task = board.tasks.find((task: any) => task.id === id);
    task.status = "review"; task.revision++; task.reviewApproved = mode === "reviewer";
  };
  return { board, watch, slots, launches, accepted, reviews, notices, calls, errors, tick, add, finish,
    afterLaunch: (callback: () => void) => { afterLaunch = callback; }, beforeAccept: (callback: () => void) => { beforeAccept = callback; },
    failLaunch: (code: string) => { launchError = code; } };
}

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
    const f = fixture(); f.board.settings.agentLimits.executor = 2;
    f.add("T-0001"); f.add("T-0002");
    f.afterLaunch(() => { if (disable) f.board.settings.autoMode = false; else f.board.settings.agentLimits.executor = 1; });
    await f.tick(); assert.deepEqual(f.launches, ["T-0001"]);
    assert.equal(f.board.tasks[0].status, "in_progress");
  }
});

test("automatic dispatch resumes a paused merge repair when only reviewer capacity is available", async () => {
  const f = fixture();
  f.add("T-0001");
  await f.tick();
  f.add("T-0002");
  f.add("T-0003", { mergeRepair: true });
  const reviewer = f.slots.acquire("project", "reviewer", f.board.settings.agentLimits)!;
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

test("a review-mode change during integration leaves the submission for the human", async () => {
  const f = fixture("reviewer"); f.add("T-0001", { status: "review", reviewApproved: true });
  f.beforeAccept(() => { f.board.settings.reviewMode = "human"; });
  await f.tick(); assert.deepEqual(f.accepted, []); assert.equal(f.board.tasks[0].status, "review");
});

test("milestones are fetched once for the board and the queue is recalculated after each launch", async () => {
  const f = fixture(); f.board.settings.agentLimits.executor = 2;
  const milestone = { repository: "owner/repo", number: 1, title: "Release" };
  f.add("T-0001", { milestone }); f.add("T-0002", { milestone }); f.add("T-0003", { milestone });
  f.afterLaunch(() => { f.board.tasks[2].dueDate = "2020-01-01"; });
  await f.tick();
  assert.deepEqual(f.launches, ["T-0001", "T-0003"]);
  assert.equal(f.calls.filter(args => args[0] === "milestones").length, 1);
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

test("manual boards never dispatch or review even with stale automatic settings", async () => {
  const f = fixture("reviewer"); f.board.settings.boardType = "manual";
  f.add("T-0001"); f.add("T-0002", { status: "review", reviewApproved: true });
  await f.tick(); assert.deepEqual(f.launches, []); assert.deepEqual(f.reviews, []); assert.deepEqual(f.accepted, []);
});
