import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { withBoardMcp } from "../src/desktop/board-mcp.ts";
import { codexRpc, turnControl } from "../src/desktop/codex-rpc.ts";
import type { AgentControl, RpcMessage } from "../src/desktop/codex-rpc.ts";
import type { BoardGoal, BoardGoalAction } from "../src/desktop/codex-chat.ts";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { codexThreadPattern } from "../src/cli/model.ts";
import { runActivity } from "../src/desktop/run-activity.ts";

const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");

test("discussion steering and interruption share the streaming connection, including during a tool call", async t => {
  const directory = mkdtempSync(join(tmpdir(), "ai-taskboard-chat-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const script = join(directory, "provider.cjs");
  writeFileSync(script, `
    const send = value => console.log(JSON.stringify(value));
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined || !method) return;
      let result = {};
      if (method === 'model/list') result = { data: [{ model: 'test', defaultReasoningEffort: 'low', supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === 'thread/start') result = { thread: { id: 'thread' } };
      if (method === 'turn/start') result = { turn: { id: 'turn', status: 'inProgress' } };
      if (method === 'turn/steer') {
        if (params.expectedTurnId !== 'turn') throw new Error('Wrong turn');
        if (params.input[0].text === 'reject') { send({ id, error: { message: 'No active turn' } }); return; }
        send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'commentary', text: params.input[0].text } } });
      }
      send({ id, result });
      if (method === 'turn/start') for (const id of ['tool', 'retry']) send({ id, method: 'item/tool/call', params: { threadId: 'thread', callId: 'call', tool: 'task_update', arguments: {} } });
      if (method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
    });
  `);
  const runtime = runInNewContext(stripTypeScriptTypes(source) + "\nreplyToTask", {
    spawn, codexRpc, turnControl, CodexTokenUsage, setTimeout, clearTimeout,
    configuredCodex: async () => ({ path: process.execPath, args: [script] }),
    chatTools: [], cliFailure: () => ({ ok: false }), saveChatImages: async () => [],
  });
  const ready = Promise.withResolvers<AgentControl>();
  const toolStarted = Promise.withResolvers<void>();
  const releaseTool = Promise.withResolvers<{ ok: true }>();
  let toolCalls = 0;
  const commentary: string[] = [];
  const pending = runtime("profile", directory, { model: "test", effort: "low" }, "Initial", [],
    (text: string) => commentary.push(text), () => { toolCalls++; toolStarted.resolve(); return releaseTool.promise; },
    directory, 1000, undefined, (control: AgentControl) => ready.resolve(control));
  const control = await ready.promise;
  await toolStarted.promise;
  await control.steer("New details", []);
  assert.deepEqual(commentary, ["New details"]);
  assert.equal(toolCalls, 1);
  await assert.rejects(control.steer("reject", []), /No active turn/);
  await control.interrupt();
  assert.equal((await pending).interrupted, true);
  releaseTool.resolve({ ok: true });
});

test("board chat keeps a goal streaming across turns and times out only after inactivity", { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "ai-taskboard-chat-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const script = join(directory, "provider.cjs");
  const captured = join(directory, "requests.json");
  const threadId = "00000000-0000-0000-0000-000000000001";
  writeFileSync(script, `
    const fs = require("node:fs");
    const requests = [];
    let retries = 0;
    let goal = { objective: "Read this", status: "active" };
    const threadId = ${JSON.stringify(threadId)};
    const send = value => console.log(JSON.stringify(value));
    require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined) return;
      requests.push({ method, params });
      if (method === "thread/resume" && retries++ < 4) {
        send({ id, error: { message: "thread " + threadId + " already has an active writer" } });
        return;
      }
      if (method === "model/list") {
        send({ id, result: { data: [
          { model: "manager-model", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
          { model: "default-model", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
        ] } });
      } else if (method === "config/read") {
        send({ id, result: { config: { model: "default-model", model_reasoning_effort: "medium" } } });
      } else if (method === "thread/resume") {
        send({ id, result: { thread: { id: threadId, name: "Project manager" }, model: params.model } });
      } else if (method === "thread/goal/set") {
        goal = { objective: params.objective ?? goal.objective, status: params.status ?? goal.status };
        send({ id, result: { goal } });
        send({ method: "thread/goal/updated", params: { threadId, goal } });
        if (process.argv[2] === "native-resume" && params.status === "active") {
          send({ method: "turn/started", params: { threadId, turn: { id: "native", status: "inProgress" } } });
          send({ method: "item/completed", params: { threadId, item: { id: "native", type: "agentMessage", phase: "final_answer", text: "Resumed the goal" } } });
          send({ method: "thread/goal/updated", params: { threadId, goal: { ...goal, status: "complete" } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: "native", status: "completed" } } });
        }
      } else if (method === "thread/goal/get") {
        send({ id, result: { goal: process.argv[2] === "native-resume" ? { ...goal, status: "paused" } : goal } });
      } else if (method === "thread/goal/clear") {
        send({ id, result: { cleared: true } });
        send({ method: "thread/goal/cleared", params: { threadId } });
      } else if (method === "turn/start") {
        const config = process.argv.find(value => value.startsWith("mcp_servers="));
        const url = config.match(/http[^"]+/)[0];
        for (const name of ["task_start", "project_git", "project_disk"]) {
          if (!config.includes(name + '={approval_mode="approve"}')) throw new Error("Missing board tool policy for " + name);
        }
        const token = process.env.AI_TASKBOARD_MCP_TOKEN;
        const invoke = async (method, params) => {
          const response = await fetch(url, { method: "POST",
            headers: { authorization: "Bearer " + token, "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          return (await response.json()).result;
        };
        const { tools } = await invoke("tools/list");
        if (tools.map(tool => tool.name).join(",") !== "task_start,project_git,project_disk") throw new Error("Missing board tools");
        for (const [name, args] of [["task_start", { id: "T-0001", revision: 2 }], ["project_git", { view: "status" }], ["project_disk", {}]]) {
          const result = await invoke("tools/call", { name, arguments: args });
          if (result.isError) throw new Error("Board tool failed");
        }
        send({ id, result: { turn: { id: "reply", status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId, elapsed: 120_000, item: { id: "first", type: "agentMessage", phase: "final_answer", text: "First turn" } } });
        if (params.input[0].text === "Silent") {
          send({ method: "item/started", params: { threadId: "another-thread", elapsed: 120_000 } });
          send({ method: "item/started", params: { threadId: "another-thread", elapsed: 60_001 } });
          return;
        }
        send({ method: "turn/completed", params: { threadId, turn: { id: "reply", status: "completed" } } });
        send({ method: "turn/started", params: { threadId, turn: { id: "continuation", status: "inProgress" } } });
        if (["Stop", "Manage"].includes(params.input[0].text)) {
          send({ method: "item/completed", params: { threadId, item: { id: "stop", type: "agentMessage", phase: "commentary", text: "Stop here" } } });
          return;
        }
        send({ method: "turn/completed", params: { threadId, turn: { id: "reply", status: "completed" } } });
        send({ method: "item/completed", params: { threadId, elapsed: 120_000, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Done" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: "continuation", status: "completed" } } });
        send({ method: "thread/goal/updated", params: { threadId, goal: { ...goal, status: "complete" } } });
      } else if (method === "turn/interrupt") {
        if (params.turnId !== "continuation") throw new Error("Wrong turn");
        send({ id, result: {} });
        send({ method: "turn/completed", params: { threadId, turn: { id: "continuation", status: "interrupted" } } });
      } else {
        send({ id, result: {} });
      }
    }).on("close", () => fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(requests)));
  `);
  const waits: number[] = [];
  const waiting: boolean[] = [];
  let elapsed = 0;
  let watchdog: { expires: number; fail: () => void; refresh: () => void } | undefined;
  let providerMode = "";
  const { replyToBoard: runtime, updateBoardGoal } = runInNewContext(stripTypeScriptTypes(source) + "\n({ replyToBoard, updateBoardGoal })", {
    spawn, turnControl, CodexTokenUsage, codexThreadPattern, Error, process, withBoardMcp,
    codexRpc: (child: Parameters<typeof codexRpc>[0], notify: Parameters<typeof codexRpc>[1], onRequest: Parameters<typeof codexRpc>[2]) =>
      codexRpc(child, (message: RpcMessage) => {
        elapsed += (message.params as { elapsed?: number })?.elapsed ?? 0;
        if (watchdog && elapsed >= watchdog.expires) watchdog.fail();
        return notify(message);
      }, onRequest),
    setTimeout: (callback: () => void, ms: number) => {
      if (ms !== 180_000) return setTimeout(callback, ms);
      return watchdog = { expires: elapsed + ms, fail: callback, refresh() { this.expires = elapsed + ms; } };
    },
    clearTimeout: (timer: NodeJS.Timeout | typeof watchdog) => {
      if (timer && timer === watchdog) watchdog = undefined;
      else clearTimeout(timer as NodeJS.Timeout);
    },
    delay: async (ms: number, _: unknown, { signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      waits.push(ms);
    },
    configuredCodex: async () => ({ path: process.execPath, args: [script, providerMode] }),
    runActivity,
  });
  const controller = new AbortController();
  const image = "data:image/png;base64,eA==";
  let accepted = 0;
  let control: AgentControl;
  const stop = Promise.withResolvers<() => Promise<void>>();
  const session = {
    id: threadId, title: "Project manager", save: () => assert.fail("Thread ID must be preserved"),
    settings: { model: "manager-model", effort: "high" },
    goal: "Read this",
    mcpTools: ["task_start", "project_git", "project_disk"].map(name => ({ name, description: name, inputSchema: { type: "object" } })),
    onGoalSet: () => accepted++, onActivity() {}, onControl: (value: AgentControl) => { control = value; },
    onWaiting: (value: boolean) => waiting.push(value),
  };
  const launched: unknown[] = [];
  const result = await runtime("profile", directory, "Read this", [image], (name: string, args: unknown) => {
    launched.push({ name, args });
    return { ok: true, data: { id: "T-0001" } };
  }, [], "", controller.signal, session);
  assert.equal(result.text, "First turn\n\nDone");
  assert.equal(result.goalStatus, "complete");
  assert.equal(elapsed, 240_000);
  assert.deepEqual(launched, [
    { name: "task_start", args: { id: "T-0001", revision: 2 } },
    { name: "project_git", args: { view: "status" } },
    { name: "project_disk", args: {} },
  ]);
  assert.deepEqual(waiting, [true, false]);
  assert.deepEqual(waits, [1000, 2000, 4000, 5000]);
  const requests = JSON.parse(readFileSync(captured, "utf8"));
  assert.deepEqual(requests.map(({ method }: { method: string }) => method), [
    "initialize", "model/list", ...Array(5).fill("thread/resume"), "thread/goal/set", "turn/start", "thread/unsubscribe",
  ]);
  assert.ok(requests.slice(2).every(({ params }: { params: { threadId: string } }) => params.threadId === threadId));
  assert.equal(requests[6].params.model, "manager-model");
  assert.deepEqual(requests[6].params.config, { model_reasoning_effort: "high" });
  assert.equal(requests.at(-2).params.effort, "high");
  assert.deepEqual(requests.at(-3).params, { threadId, objective: "Read this", status: "active", origin: "user" });
  assert.deepEqual(requests.at(-2).params.input, [
    { type: "text", text: "Read this", text_elements: [] }, { type: "image", url: image },
  ]);

  const cancelled = new AbortController();
  await assert.rejects(runtime("profile", directory, "Do not send", [image], () => {}, [], "", cancelled.signal, {
    ...session, onWaiting: () => cancelled.abort(),
  }), { name: "AbortError" });
  // Cancellation may terminate the child before it writes the close record.
  assert.deepEqual(waits, [1000, 2000, 4000, 5000]);

  const run = (prompt: string) => runtime("profile", directory, prompt, [], () => ({ ok: true }), [], "", controller.signal, session);
  await assert.rejects(run("Silent"), /Codex did not respond in time/);
  assert.equal(accepted, 2);
  assert.equal(elapsed, 540_001);

  const stopping = runtime("profile", directory, "Stop", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session,
    onActivity: (items: { text?: string }[]) => {
      if (items.some(item => item.text === "Stop here")) stop.resolve(() => control.interrupt());
    },
  });
  await (await stop.promise)();
  assert.equal((await stopping).interrupted, true);
  const stopRequests = JSON.parse(readFileSync(captured, "utf8"));
  assert.deepEqual(stopRequests.slice(-3), [
    { method: "thread/goal/set", params: { threadId, status: "paused", origin: "user" } },
    { method: "turn/interrupt", params: { threadId, turnId: "continuation" } },
    { method: "thread/unsubscribe", params: { threadId } },
  ]);

  const resumed = await runtime("profile", directory, "Continue", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, goal: undefined, settings: null,
  });
  assert.equal(resumed.goalStatus, "complete");
  assert.equal(resumed.text, "First turn\n\nDone");
  const resumedRequests = JSON.parse(readFileSync(captured, "utf8"));
  assert.equal(resumed.model, "default-model");
  assert.equal(resumedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.model, "default-model");
  assert.equal(resumedRequests.at(-2).params.effort, "medium");
  assert.deepEqual(resumedRequests.slice(-3).map(({ method }: { method: string }) => method), [
    "thread/goal/get", "turn/start", "thread/unsubscribe",
  ]);

  providerMode = "native-resume";
  const statuses: string[] = [];
  const continued = await runtime("profile", directory, "", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, goal: undefined, resumeGoal: true,
    onGoal: (goal: { status: string }) => statuses.push(goal.status),
  });
  assert.equal(continued.text, "Resumed the goal");
  assert.equal(continued.goalStatus, "complete");
  assert.deepEqual([...new Set(statuses)], ["active", "complete"]);
  const continuedRequests = JSON.parse(readFileSync(captured, "utf8"));
  assert.deepEqual(continuedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.config,
    { model_reasoning_effort: "high" });
  assert.deepEqual(continuedRequests.slice(-3), [
    { method: "thread/goal/get", params: { threadId } },
    { method: "thread/goal/set", params: { threadId, status: "active", origin: "user" } },
    { method: "thread/unsubscribe", params: { threadId } },
  ]);
  await assert.rejects(runtime("profile", directory, "Unsupported effort", [], () => {}, [], "", controller.signal, {
    ...session, settings: { model: "manager-model", effort: "max" },
  }), /model or reasoning effort is unavailable/);

  providerMode = "";
  const goalControls = Promise.withResolvers<(action: BoardGoalAction) => Promise<BoardGoal | null>>();
  const working = Promise.withResolvers<void>();
  const managing = runtime("profile", directory, "Manage", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, onGoalControl: goalControls.resolve,
    onActivity: (items: { text?: string }[]) => {
      if (items.some(item => item.text === "Stop here")) working.resolve();
    },
  });
  const change = await goalControls.promise;
  await working.promise;
  assert.deepEqual(await change({ kind: "edit", objective: "New objective" }), { objective: "New objective", status: "active" });
  assert.deepEqual(await change({ kind: "pause" }), { objective: "New objective", status: "paused" });
  assert.equal((await managing).goalStatus, "paused");
  const idleEdit = await updateBoardGoal("profile", directory, threadId, { kind: "edit", objective: "Edited while idle" });
  assert.equal(idleEdit.objective, "Edited while idle");
  assert.equal(await updateBoardGoal("profile", directory, threadId, { kind: "clear" }), null);
});
