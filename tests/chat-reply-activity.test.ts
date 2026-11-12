import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTask } from "../src/cli/tasks.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "frame", "send", "notifyRunChange", "sendChat", "saveTaskTokenUsage", "windowStates", "chatRuns", "replyingTasks",
  "runningTasks", "runActivityByTask", "imageExtensions", "imageTypes", "recentBoards", "russian", "theme",
]);
// Exercise the main-process lifecycle without starting Electron or a real provider.
const activitySource = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map(node => node.getText(parsed)).join("\n");

function fixture(options: { writeFailure?: boolean; attachmentFailure?: boolean; saveReplyFailure?: boolean } = {}) {
  const task = createTask("T-0001", { title: "Discussion" });
  task.status = "review";
  task.history.push({ at: new Date().toISOString(), actor: "user", action: "comment", text: "Discuss", chat: { model: "test", effort: "low", files: [] } });
  const response = Promise.withResolvers<{ text: string }>();
  const started = Promise.withResolvers<void>();
  const runtime = runInNewContext(stripTypeScriptTypes(activitySource) +
    "\n({ sendChat, frame, windowStates, runningTasks })", {
    basename, extname, join, performance,
    app: { getPath: () => "profile" },
    lang: (english: string) => english,
    tmpdir: () => "scratch",
    mkdtemp: async () => "scratch/chat",
    rm: async () => {},
    writeFile: async () => {},
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    taskChatActions: () => ({}),
    maxAttachmentBytes: 64 * 1024 * 1024,
    callCli: async (_project: string, args: string[], input: { actor?: string }) => {
      if (args[0] === "attachment") return { ok: false, error: { code: "ATTACHMENT_MISSING" } };
      if (args[0] === "chat" && (options.writeFailure || input?.actor === "agent" && options.saveReplyFailure)) {
        return { ok: false, error: { code: "STORAGE_ERROR" } };
      }
      return { ok: true, data: task };
    },
    replyToTask: async () => { started.resolve(); return response.promise; },
  });
  const windows = ["project-a", "project-a", "project-b"].map(project => {
    const updates: string[][] = [];
    const state = { project, board: { tasks: [task, { ...task, id: "T-0002" }] }, window: {
      isDestroyed: () => false, setTitle: () => {}, webContents: {
        send: (channel: string, frame: { runningTasks: string[] }) => {
          assert.equal(channel, "board:changed");
          updates.push(Array.from(frame.runningTasks));
        },
      },
    } };
    runtime.windowStates.set(runtime.windowStates.size, state);
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
  return { task, runtime, windows, run, active, response, started: started.promise };
}

test("chat replies publish the existing task activity in every window of their board", async () => {
  const f = fixture();
  assert.deepEqual(f.active(), []);
  const pending = f.run();
  await f.started;
  assert.deepEqual(f.active(), ["T-0001"]);
  assert.deepEqual(f.active(1), ["T-0001"]);
  assert.deepEqual(f.active(2), []);
  assert.deepEqual(f.windows.map(window => window.updates), [[["T-0001"]], [["T-0001"]], []]);
  assert.equal((await f.run()).result.error.code, "CHAT_BUSY");
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
