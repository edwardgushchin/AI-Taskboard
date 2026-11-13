import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTask } from "../src/cli/tasks.ts";
import { taskIdPattern } from "../src/cli/model.ts";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["launchTask", "recordRunFailure", "publishRunActivity", "notifyRunChange", "saveTaskTokenUsage",
  "beginOperation", "projectOperations", "closingProjects", "launchingTasks", "runningTasks", "runActivityByTask",
  "activeAgents", "chatRuns", "windowStates"]);
const lifecycle = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name && names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map(node => node.getText(parsed)).join("\n");
const failure = (code: string, message: string) => ({ ok: false, error: { code, message } });
const previousThread = "01234567-1234-5678-1234-123456789012";
const nextThread = "01234567-1234-5678-1234-123456789013";

function fixture(outcome: "busy" | "failed" | "started") {
  const task = { ...createTask("T-0001", { title: "Reviewed task" }), status: "review",
    codexThreadId: previousThread, blocked: undefined as { reason: string; condition?: string } | undefined,
    git: { target: "refs/heads/main", base: "a".repeat(40), branch: "refs/heads/ai-taskboard/T-0001", worktree: "worktree" } };
  const calls: { args: string[]; input: any }[] = [];
  const launched: any[] = [];
  const completion = Promise.withResolvers<string | undefined>();
  const runtime = runInNewContext(stripTypeScriptTypes(lifecycle) + "\n({launchTask, projectOperations, runningTasks})", {
    AbortController, performance, setTimeout, clearTimeout,
    lang: (english: string) => english, cliFailure: failure,
    app: { getPath: () => "profile" }, configuredCodex: async () => ({}), runLog: () => [], rm: async () => {},
    callCli: async (_project: string, args: string[], input: any) => {
      calls.push({ args, input });
      if (args[0] === "request-changes") {
        if (input.revision !== task.revision) return failure("REVISION_CONFLICT", "The task changed.");
        task.status = "in_progress";
        task.history.push({ actor: "user", action: "request-changes", at: new Date().toISOString(), text: input.reason });
        task.revision++;
      }
      if (args[0] === "resume") { task.status = "in_progress"; task.blocked = undefined; task.revision++; }
      if (args[0] === "start") return { ok: true, data: { task: structuredClone(task), worktree: task.git.worktree } };
      if (args[0] === "block") {
        if (task.status !== "in_progress") return failure("INVALID_TRANSITION", "The task is no longer in progress.");
        task.status = "blocked"; task.blocked = input; task.revision++;
      }
      if (args[0] === "update") { task.codexThreadId = input.codexThreadId; task.revision++; }
      return { ok: true, data: structuredClone(task) };
    },
    startCodexRun: async (_client: unknown, _project: string, _cwd: string, snapshot: unknown) => {
      launched.push(snapshot);
      if (outcome === "busy") throw Object.assign(new Error("thread " + previousThread + " already has an active writer"), { code: "CODEX_THREAD_BUSY" });
      if (outcome === "failed") throw new Error("Provider disconnected");
      return { threadId: nextThread, completion: completion.promise, steer: async () => {}, interrupt: async () => {} };
    },
  });
  return { runtime, task, calls, launched, completion };
}

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

test("explicit continuation uses a new chat and the same worktree, and preserves the old chat link", async () => {
  const f = fixture("started");
  f.task.status = "blocked";
  f.task.blocked = { reason: "already has an active writer" };
  const result = await f.runtime.launchTask("project", f.task.id, undefined, true);
  assert.equal(result.ok, true);
  assert.equal(f.launched[0].codexThreadId, undefined);
  assert.equal(f.launched[0].git.worktree, "worktree");
  assert.equal(f.task.codexThreadId, nextThread);
  assert.ok(f.calls.find(call => call.args[0] === "update")!.input.reason.includes(previousThread));
  f.task.status = "review";
  f.completion.resolve(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.runningTasks.size, 0);
  assert.equal(f.runtime.projectOperations.size, 0);
});

test("new-chat launch rechecks task state after the confirmation dialog", async () => {
  const f = fixture("started");
  f.task.status = "in_progress";
  const result = await f.runtime.launchTask("project", f.task.id, undefined, true);
  assert.equal(result.error.code, "INVALID_INPUT");
  assert.equal(f.launched.length, 0);
  assert.equal(f.task.codexThreadId, previousThread);
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
    launchTask: async (_project: string, _id: string, _request: unknown, newThread: boolean) => {
      assert.equal(newThread, true); launches++; return { ok: true };
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
