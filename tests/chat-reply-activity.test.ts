import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTask } from "../src/cli/tasks.ts";
import { projectLabels } from "../src/desktop/project-tabs.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "activeAgents", "stopChat", "beginOperation", "projectOperations", "closingProjects", "frame", "send", "notifyRunChange", "sendChat", "saveTaskTokenUsage", "windowStates", "chatRuns", "replyingTasks",
  "launchingTasks", "runningTasks", "runActivityByTask", "imageExtensions", "imageTypes", "recentBoards", "russian", "theme",
  "managerQuestion", "executorLimit", "deferredExecutors",
]);
// Exercise the main-process lifecycle without starting Electron or a real provider.
const activitySource = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map(node => node.getText(parsed)).join("\n");

function fixture(options: { writeFailure?: boolean; attachmentFailure?: boolean; saveReplyFailure?: boolean; controlled?: boolean; steerFailure?: boolean; stopFailure?: boolean } = {}) {
  const task = createTask("T-0001", { title: "Discussion" });
  task.status = "review";
  task.history.push({ at: new Date().toISOString(), actor: "user", action: "comment", text: "Discuss", chat: { model: "test", effort: "low", files: [] } });
  const response = Promise.withResolvers<{ text: string } | { interrupted: true }>();
  const delivered: string[] = [];
  const writes: { actor?: string; replyTo?: number }[] = [];
  const started = Promise.withResolvers<void>();
  const slots = createAgentSlots();
  const runtime = runInNewContext(stripTypeScriptTypes(activitySource) +
    "\n({ sendChat, stopChat, activeAgents, frame, windowStates, runningTasks, launchingTasks, deferredExecutors, notifyRunChange })", {
    basename, extname, join, performance, projectLabels, AbortController, subscriptions: new Map(),
    reserveAgent: slots.acquire,
    boardRequests: new Map(), boardWorkRequests: new Map(), boardUnread: () => [], projectIdentity: (path: string) => path,
    app: { getPath: () => "profile" }, managerFullAccess: () => false,
    lang: (english: string) => english,
    tmpdir: () => "scratch",
    mkdtemp: async () => "scratch/chat",
    rm: async () => {},
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
        writes.push(input);
        if (options.controlled) task.history.push({ at: new Date().toISOString(), actor: input.actor === "agent" ? "agent" : "user",
          action: "chat", text: input.text, chat: { model: "test", effort: "low" } });
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
        send: (channel: string, frame: { runningTasks: string[] }) => {
          assert.equal(channel, "board:changed");
          updates.push(Array.from(frame.runningTasks));
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
  const active = (index = 0): string[] => Array.from(runtime.frame(windows[index].state).runningTasks);
  return { task, runtime, windows, run, active, response, delivered, writes, slots, started: started.promise };
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

test("chat replies publish the existing task activity in every window of their board", async () => {
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
  assert.deepEqual(f.active(), ["T-0001"]);
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
  const blocked = await f.run();
  assert.equal(blocked.result.error.code, "EXECUTOR_LIMIT");
  assert.equal(blocked.saved, false);
  assert.equal(f.writes.length, 0);
  let interrupted = false;
  f.runtime.runningTasks.add("project-a\0T-0001");
  f.runtime.activeAgents.set("project-a\0T-0001", { directories: new Set(), control: {
    steer: async (prompt: string) => f.delivered.push(JSON.parse(prompt).latestUserMessage.text),
    interrupt: async () => { interrupted = true; },
  } });
  assert.equal((await f.run()).result.ok, true);
  assert.deepEqual(f.delivered, ["Discuss"]);
  assert.deepEqual(f.active(), ["T-0001"]);
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
