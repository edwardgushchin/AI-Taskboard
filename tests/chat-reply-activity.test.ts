import localization from "../src/desktop/localization.cjs";
import { activeRunSummary } from "../src/desktop/active-runs.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { changeTask, createTask } from "../src/cli/tasks.ts";
import { TaskboardError } from "../src/cli/model.ts";
import { projectLabels } from "../src/desktop/project-tabs.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "activeAgents", "stopChat", "beginOperation", "projectOperations", "closingProjects", "frame", "send", "notifyRunChange", "sendChat", "saveTaskTokenUsage", "windowStates", "chatRuns", "replyingTasks",
  "launchingTasks", "runningTasks", "runActivityByTask", "imageExtensions", "imageTypes", "recentBoards", "russian", "theme",
  "managerQuestion", "executorLimit", "deferredExecutors",
  "returnTaskToDraft", "returningDrafts", "reviewOperations", "managerReviewOperations", "taskOperations", "steeringOperations",
]);
// Exercise the main-process lifecycle without starting Electron or a real provider.
const activitySource = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map(node => node.getText(parsed)).join("\n");

function fixture(options: { writeFailure?: boolean; attachmentFailure?: boolean; saveReplyFailure?: boolean; controlled?: boolean; steerFailure?: boolean; stopFailure?: boolean; beforeMessageWrite?: (text?: string) => Promise<void> } = {}) {
  const task = createTask("T-0001", { title: "Discussion" });
  task.status = "review";
  task.history.push({ at: new Date().toISOString(), actor: "user", action: "comment", text: "Discuss", chat: { model: "test", effort: "low", files: [] } });
  const response = Promise.withResolvers<{ text: string } | { interrupted: true }>();
  const delivered: string[] = [];
  const removed: string[] = [];
  const scheduled: boolean[] = [];
  const writes: { actor?: string; replyTo?: number }[] = [];
  const started = Promise.withResolvers<void>();
  const slots = createAgentSlots();
  const runtime = runInNewContext(stripTypeScriptTypes(activitySource) +
    "\n({ sendChat, stopChat, returnTaskToDraft, activeAgents, frame, windowStates, runningTasks, launchingTasks, deferredExecutors, notifyRunChange, chatRuns, replyingTasks })", {
    agentSlots: slots, registerRuntime: () => () => {}, activeRunSummary, basename, extname, join, performance, projectLabels, AbortController, AbortSignal, wait, subscriptions: new Map(),
    isManual: () => false, runtimeLocation: (project: string) => project, readBoardSettings: () => ({}),
    scheduleAgentWork: () => { scheduled.push(true); }, reserveAgent: slots.acquire,
    boardRequests: new Map(), boardWorkRequests: new Map(), boardUnread: () => [], projectIdentity: (path: string) => path,
    app: { getPath: () => "profile" }, managerAccess: () => "auto",
    t: (key: string, parameters = {}) => localization.text(key, parameters, "en"), localization,
    tmpdir: () => "scratch",
    mkdtemp: async () => "scratch/chat",
    rm: async (path: string) => { removed.push(path); },
    writeFile: async () => {},
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    taskChatActions: () => ({}),
    maxAttachmentBytes: 64 * 1024 * 1024,
    callCli: async (_project: string, args: string[], input: { actor?: string; text?: string; model?: string; effort?: string; replyTo?: number }) => {
      if (args[0] === "attachment") return { ok: false, error: { code: "ATTACHMENT_MISSING" } };
      if (args[0] === "chat" && (options.writeFailure || input?.actor === "agent" && options.saveReplyFailure)) {
        return { ok: false, error: { code: "STORAGE_ERROR" } };
      }
      if (args[0] === "chat") {
        await options.beforeMessageWrite?.(input.text);
        writes.push(input);
        if (options.controlled) {
          task.revision++;
          task.history.push({ at: new Date().toISOString(), actor: input.actor === "agent" ? "agent" : "user",
            action: "chat", text: input.text, chat: { model: "test", effort: "low" } });
        }
      }
      if (args[0] === "return-to-draft") {
        try { Object.assign(task, changeTask(task, args[0], input)); }
        catch (error) {
          if (!(error instanceof TaskboardError)) throw error;
          return { ok: false, error: { code: error.code, message: error.message } };
        }
      }
      return { ok: true, data: task };
    },
    replyToTask: async (...args: unknown[]) => {
      (args[10] as Function)({
        steer: async (prompt: string) => {
          if (options.steerFailure) throw new Error("Turn already ended");
          delivered.push(JSON.parse(prompt).latestUserMessage.text);
        },
        interrupt: async () => {
          if (options.stopFailure) throw new Error("Provider disconnected");
          response.resolve({ interrupted: true });
        },
      });
      started.resolve();
      return response.promise;
    },
  });
  const windows = ["project-a", "project-a", "project-b"].map((project, index) => {
    const updates: string[][] = [];
    const state = { project, board: { project, tasks: [task, { ...task, id: "T-0002" }] }, window: {
      isDestroyed: () => false, setTitle: () => {}, webContents: {
        id: index,
        send: (channel: string, frame: { replyingTasks: string[] }) => {
          assert.equal(channel, "board:changed");
          updates.push(Array.from(frame.replyingTasks));
        },
      },
    } };
    runtime.windowStates.set(index, { window: state.window, tabs: [state], active: state });
    return { state, updates };
  });
  if (options.attachmentFailure) {
    task.attachments.push({ file: "missing", name: "missing.png", bytes: 1, sha256: "0".repeat(64) });
    task.history.at(-1)!.chat!.files = ["missing"];
  }
  const request = { model: "test", effort: "low", text: "Discuss", files: [] };
  const run = (retry = false) => runtime.sendChat("project-a", task.id,
    { ...request, ...(retry ? { retryAt: task.history.length - 1 } : {}) }, () => {});
  const active = (index = 0): string[] => Array.from(runtime.frame(windows[index].state).replyingTasks);
  return { task, runtime, windows, run, active, request, response, delivered, writes, slots, removed, scheduled, started: started.promise };
}

test("confirmed queue snapshots agree across board windows and exclude interrupted or stale tasks", () => {
  const f = fixture();
  f.task.status = "in_progress";
  f.task.codexThreadId = "interrupted-thread";
  const waiting = (index: number) => Array.from(f.runtime.frame(f.windows[index].state).waitingTasks);
  assert.deepEqual(waiting(0), []);
  f.runtime.deferredExecutors.set("project-a\0T-0001", { project: "project-a", id: f.task.id, revision: f.task.revision });
  assert.deepEqual(waiting(0), [f.task.id]);
  assert.deepEqual(waiting(1), [f.task.id]);
  assert.deepEqual(waiting(2), []);
  f.runtime.runningTasks.add("project-a\0T-0001");
  assert.deepEqual(waiting(0), []);
  f.runtime.runningTasks.clear();
  f.task.revision++;
  assert.deepEqual(waiting(0), []);
  f.task.revision--;
  f.task.status = "blocked";
  assert.deepEqual(waiting(1), []);
  f.runtime.deferredExecutors.clear();
  assert.deepEqual(waiting(0), []);
});

test("chat replies publish discussion activity in every window of their board", async () => {
  const f = fixture();
  assert.deepEqual(f.active(), []);
  const pending = f.run();
  await f.started;
  assert.deepEqual(f.active(), ["T-0001"]);
  assert.deepEqual(f.active(1), ["T-0001"]);
  assert.deepEqual(f.active(2), []);
  assert.deepEqual(f.windows.map(window => window.updates), [[["T-0001"]], [["T-0001"]], []]);
  assert.equal((await f.run(true)).result.error.code, "CHAT_BUSY");
  assert.deepEqual(f.active(), ["T-0001"]);
  f.response.resolve({ text: "Reply" });
  assert.equal((await pending).result.ok, true);
  assert.deepEqual(f.active(), []);
  assert.deepEqual(f.windows[1].updates, [["T-0001"], []]);
});

test("a failed retry clears chat activity while a concurrent board run stays active", async () => {
  const f = fixture();
  const pending = f.run(true);
  await f.started;
  assert.deepEqual(f.active(), ["T-0001"]);
  f.runtime.runningTasks.add("project-a\0T-0001");
  f.response.reject(new Error("Provider disconnected"));
  const reply = await pending;
  assert.equal(reply.result.error.code, "CHAT_FAILED");
  assert.deepEqual(f.active(), []);
  assert.deepEqual(Array.from(f.runtime.frame(f.windows[0].state).runningTasks), ["T-0001"]);
  f.runtime.runningTasks.clear();
  assert.deepEqual(f.active(), []);
});

test("provider and reply-storage errors remove the activity indicator", async () => {
  for (const saveReplyFailure of [false, true]) {
    const f = fixture({ saveReplyFailure });
    const pending = f.run();
    await f.started;
    if (saveReplyFailure) f.response.resolve({ text: "Reply" });
    else f.response.reject(new Error("Provider disconnected"));
    assert.equal((await pending).result.ok, false);
    assert.deepEqual(f.active(), []);
    assert.equal(f.runtime.chatRuns.size, 0);
    assert.equal(f.runtime.activeAgents.size, 0);
    assert.deepEqual(f.removed, ["scratch/chat"]);
    assert.deepEqual(f.windows[0].updates, [["T-0001"], []]);
  }
});

test("message-write and attachment failures never leave chat activity behind", async () => {
  for (const options of [{ writeFailure: true }, { attachmentFailure: true }]) {
    const f = fixture(options);
    assert.equal((await f.run()).result.ok, false);
    assert.deepEqual(f.active(), []);
    assert.deepEqual(f.windows[0].updates.at(-1) ?? [], []);
  }
});

test("a second message reaches the in-flight reply before it completes and becomes its reply target", async () => {
  const f = fixture({ controlled: true });
  const pending = f.run();
  await f.started;
  assert.equal((await f.run()).result.ok, true);
  assert.deepEqual(f.delivered, ["Discuss"]);
  assert.equal(f.writes.filter(write => write.actor !== "agent").length, 2);
  assert.deepEqual(f.active(), ["T-0001"]);
  f.response.resolve({ text: "Reply with the new input" });
  assert.equal((await pending).result.ok, true);
  assert.equal(f.writes.at(-1)?.replyTo, 3);
  assert.deepEqual(f.active(), []);
});

test("stop interrupts the discussion without saving a completed reply", async () => {
  const f = fixture({ controlled: true });
  const pending = f.run();
  await f.started;
  assert.equal((await f.runtime.stopChat("project-a", "T-0001")).ok, true);
  assert.equal((await pending).result.ok, true);
  assert.equal(f.writes.filter(write => write.actor === "agent").length, 0);
  assert.deepEqual(f.active(), []);
  assert.equal((await f.runtime.stopChat("project-a", "T-0001")).error.code, "CHAT_NOT_RUNNING");
  assert.equal(f.runtime.chatRuns.size, 0);
  assert.equal(f.runtime.activeAgents.size, 0);
  assert.deepEqual(f.removed, ["scratch/chat"]);
});

test("return waits for an already dispatched chat write and preserves its newer revision", async () => {
  const writing = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const f = fixture({ controlled: true, async beforeMessageWrite(text) {
    if (text !== "Already dispatched") return;
    writing.resolve();
    await finishWrite.promise;
  } });
  const original = f.run();
  await f.started;
  const steering = f.runtime.sendChat("project-a", f.task.id, { ...f.request, text: "Already dispatched" }, () => {});
  await writing.promise;
  const returned = f.runtime.returnTaskToDraft("project-a", f.task.id, f.task.revision, "user");
  await Promise.race([original, returned.then(() => assert.fail("Return finished with a write in flight"))]);
  assert.equal(f.task.status, "review");
  finishWrite.resolve();
  assert.equal((await steering).saved, true);
  assert.equal((await returned).error.code, "REVISION_CONFLICT");
  assert.equal(f.task.history.at(-1)?.text, "Already dispatched");
  assert.equal((await f.runtime.returnTaskToDraft("project-a", f.task.id, f.task.revision, "user")).data.status, "draft");
  assert.deepEqual(f.delivered, []);
});

test("a delivery rejection keeps the saved user message and does not start another reply", async () => {
  const f = fixture({ controlled: true, steerFailure: true, stopFailure: true });
  const pending = f.run();
  await f.started;
  const reply = await f.run();
  assert.equal(reply.saved, true);
  assert.equal(reply.result.error.code, "CHAT_FAILED");
  assert.equal(f.task.history.at(-1)?.actor, "user");
  assert.deepEqual(f.delivered, []);
  assert.equal((await f.runtime.stopChat("project-a", "T-0001")).error.code, "CHAT_STOP_FAILED");
  assert.deepEqual(f.active(), ["T-0001"]);
  f.response.resolve({ text: "Original reply" });
  await pending;
});

test("messages and stop target a board execution in the same project and task", async () => {
  const f = fixture({ controlled: true });
  const occupied = Array.from({ length: 3 }, () => f.slots.acquire("project-a", "executor"));
  let interrupted = false;
  f.runtime.runningTasks.add("project-a\0T-0001");
  f.runtime.activeAgents.set("project-a\0T-0001", { directories: new Set(), control: {
    steer: async (prompt: string) => f.delivered.push(JSON.parse(prompt).latestUserMessage.text),
    interrupt: async () => { interrupted = true; },
  } });
  assert.equal((await f.run()).result.ok, true);
  assert.deepEqual(f.delivered, ["Discuss"]);
  assert.deepEqual(f.active(), []);
  assert.deepEqual(Array.from(f.runtime.frame(f.windows[0].state).runningTasks), ["T-0001"]);
  assert.equal((await f.runtime.stopChat("project-b", "T-0001")).error.code, "CHAT_NOT_RUNNING");
  assert.equal((await f.runtime.stopChat("project-a", "T-0001")).ok, true);
  assert.equal(interrupted, true);
  for (const release of occupied) release?.();
});

test("a task being launched never starts a competing chat provider", async () => {
  const f = fixture();
  f.runtime.launchingTasks.add("project-a\0T-0001");
  const reply = await f.run();
  assert.equal(reply.saved, false);
  assert.equal(reply.result.error.code, "CHAT_BUSY");
  assert.equal(f.writes.length, 0);
});

test("discussions bypass work and review task limits and run independently", async () => {
  const f = fixture();
  const occupied = [f.slots.acquire("project-a", "executor")!, f.slots.acquire("project-a", "reviewer")!];
  const first = f.run();
  await f.started;
  const second = f.runtime.sendChat("project-a", "T-0002", f.request, () => {});
  for (let i = 0; i < 100 && !f.runtime.activeAgents.has("project-a\0T-0002"); i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.active().sort(), ["T-0001", "T-0002"]);
  assert.deepEqual(Array.from(f.runtime.frame(f.windows[0].state).runningTasks), []);
  assert.equal(f.slots.available("project-a", "executor"), 0);
  occupied[0]();
  assert.equal(f.slots.available("project-a", "executor"), 1);
  const executor = f.slots.acquire("project-a", "executor");
  assert.ok(executor);
  f.response.resolve({ text: "Reply" });
  assert.equal((await first).result.ok, true);
  assert.equal((await second).result.ok, true);
  assert.equal(f.runtime.activeAgents.size, 0);
  assert.equal(f.runtime.chatRuns.size, 0);
  assert.equal(f.runtime.replyingTasks.size, 0);
  assert.equal(f.scheduled.length, 2);
  executor();
  for (const release of occupied.slice(1)) release();
});

test("discussion ignores status and unfinished dependencies and never starts execution", async () => {
  for (const status of ["draft", "ready", "in_progress", "blocked", "review", "done", "cancelled"] as const) {
    const f = fixture();
    f.task.status = status;
    f.task.dependencies = ["T-9999"];
    const pending = f.run();
    await f.started;
    assert.equal(f.slots.available("project-a", "executor"), 1);
    assert.deepEqual(Array.from(f.runtime.frame(f.windows[0].state).runningTasks), []);
    f.response.resolve({ text: "Reply" });
    assert.equal((await pending).result.ok, true);
    assert.equal(f.task.status, status);
    assert.equal(f.runtime.chatRuns.size, 0);
  }
});
