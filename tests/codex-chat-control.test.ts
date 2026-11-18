import localization from "../src/desktop/localization.cjs";
import { trackActiveRun, trackProvider, claimDiscussion } from "../src/desktop/active-runs.ts";
import { providerActions } from "../src/desktop/provider-tools.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { withBoardMcp } from "../src/desktop/board-mcp.ts";
import { executorExpertTools, expertCommands } from "../src/desktop/expert-tools.ts";
import { goalTaskWaitSeconds } from "../src/desktop/board-actions.ts";
import { responseLanguageInstructions, boardAgentInstructions, boardCodexArgs, managerCodexArgs, boardWorklog, worklogReminder, worklogTool } from "../src/desktop/board-agent-hooks.ts";
import { codexRpc, turnControl } from "../src/desktop/codex-rpc.ts";
import type { AgentControl, RpcMessage } from "../src/desktop/codex-rpc.ts";
import type { BoardGoal, BoardGoalAction } from "../src/desktop/codex-chat.ts";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { codexThreadPattern, taskIdPattern } from "../src/cli/model.ts";
import { runActivity, runLog } from "../src/desktop/run-activity.ts";
import { russianWriting } from "../src/desktop/russian-writing.ts";
import { managerCliContext } from "../src/desktop/manager-cli.ts";
import { managerAccess } from "../src/desktop/codex.ts";
import { projectIdentity } from "../src/desktop/project-tabs.ts";
import { githubReadTool } from "../src/desktop/github-read.ts";

const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");

test("manager access defaults to auto and preserves old full-access choices per board", t => {
  const directory = mkdtempSync(join(tmpdir(), "ai-taskboard-manager-access-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, "first");
  const second = join(directory, "second");
  mkdirSync(first);
  mkdirSync(second);
  assert.equal(managerAccess(directory, first), "auto");
  writeFileSync(join(directory, "manager-full-access.json"), JSON.stringify([projectIdentity(first)]));
  assert.equal(managerAccess(directory, first), "full");
  assert.equal(managerAccess(directory, second), "auto");
  assert.equal(managerAccess(directory, second, "ask"), "ask");
  assert.equal(managerAccess(directory, second), "ask");
  assert.equal(managerAccess(directory, first), "full");
  assert.equal(managerAccess(directory, first, "auto"), "auto");
  assert.equal(managerAccess(directory, first), "auto");
  assert.equal(managerAccess(directory, second), "ask");
});

test("an executor access request gets an independent manager decision scoped to its card", async () => {
  const task = { id: "T-0118", revision: 13, title: "Verify Electron", status: "in_progress", criteria: ["Run the UI check"] };
  const evidence = { operation: "CreateWindowStationW", mxcError: 5, hostError: 0 };
  const grants: unknown[] = [];
  let answer = "";
  let calls = 0;
  const request = runInNewContext(stripTypeScriptTypes(source) + "\nreply = managerReply; requestExecutorAccess", {
    AbortSignal, cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    callCli: async (_project: string, argv: string[]) => {
      assert.equal(argv[1], task.id);
      return { ok: true, data: task };
    },
    executorFullAccess: () => false,
    setTaskExecutorAccess: async (_profile: string, _project: string, args: unknown) => {
      grants.push(args);
      return { ok: true };
    },
    managerReply: async (_profile: string, _project: string, input: string, _images: string[], _action: unknown, options: any) => {
      calls++;
      assert.equal(JSON.parse(input).task.id, task.id);
      assert.match(JSON.parse(input).executorRequest, /install_dir_access\.cc/);
      assert.deepEqual(JSON.parse(input).sandboxEvidence, evidence);
      assert.equal(options.tools.length, 0);
      assert.equal(options.finalAnswerSchema.properties.approved.type, "boolean");
      assert.match(options.instructions, /read-only shell does not limit that decision/);
      return { text: answer };
    },
  });
  const args = { reason: "Required UI check fails with Electron install_dir_access.cc:52." };
  const run = (input: unknown = args, signal = new AbortController().signal) => request("profile", "project", task.id, input, undefined, signal, evidence);
  assert.equal((await run({ ...args, id: "T-9999" })).error.code, "INVALID_INPUT");
  assert.equal(calls, 0);
  answer = JSON.stringify({ approved: false, reason: "Use the scripted check." });
  assert.equal((await run()).data.approved, false);
  assert.equal(grants.length, 0);
  answer = "No structured decision";
  assert.equal((await run()).error.code, "ACCESS_DECISION_FAILED");
  answer = JSON.stringify({ approved: true, reason: "The required local check needs host access." });
  assert.equal((await run(args, AbortSignal.abort())).error.code, "ACCESS_DECISION_FAILED");
  assert.equal(grants.length, 0);
  const approved = await run();
  assert.equal(approved.data.approved, true);
  assert.equal(approved.data.appliesOn, "current-execution");
  assert.deepEqual(approved.data.sandboxEvidence, evidence);
  assert.deepEqual(JSON.parse(JSON.stringify(grants)), [{ id: task.id, revision: task.revision, fullAccess: true }]);
});

test("task run history restores paginated activity in the empty run slots", async () => {
  const row = (id: string, at: number, type = "commandExecution") => ({
    startedAtMs: at, item: { id, type, command: "git status" },
  });
  const pages = [
    { data: [row("before", 20), row("command", 120), row("user", 150, "userMessage")], nextCursor: "page-2" },
    { data: [{ ...row("tool", 180, "mcpToolCall"), startedAtMs: null, completedAtMs: 180 }, row("already-saved", 230), row("last", 330)], nextCursor: null },
  ];
  const cursors: unknown[] = [];
  const read = runInNewContext(stripTypeScriptTypes(source) + "\nwithServer = mockServer; readTaskRunHistory", {
    runActivity, runLog,
    mockServer: async (_profile: string, _project: string, callback: Function) => callback({
      refreshTimeout() {},
      async request(method: string, input: { threadId: string; cursor: string | null }) {
        assert.equal(method, "thread/items/list");
        assert.equal(input.threadId, "executor");
        cursors.push(input.cursor);
        return pages.shift();
      },
    }),
  });
  const log = (end: number, run?: object[]) => ({
    action: "run-log", at: new Date(end).toISOString(), durationMs: 100, run,
  });
  const restored = await read("profile", "project", "executor", [log(200), log(300, [{}]), log(400)]);
  assert.deepEqual(cursors, [null, "page-2"]);
  assert.equal(restored[0].find((item: { id: string }) => item.id === "command").at, new Date(120).toISOString());
  assert.equal(restored[0].find((item: { id: string }) => item.id === "tool").at, new Date(180).toISOString());
  assert.deepEqual(JSON.parse(JSON.stringify(Object.entries(restored).map(([key, value]) =>
    [key, (value as { id: string }[]).map(item => item.id)]))), [["0", ["command", "tool"]], ["2", ["last"]]]);
});

test("board activity extracts actual coordination messages from successful calls and saved results", () => {
  const boardActivity = runInNewContext(stripTypeScriptTypes(source) + "\nboardActivity", { runActivity, taskIdPattern });
  const question = { id: "T-0005", sequence: 21, at: "2026-11-12T13:00:10Z", kind: "question", text: "Можно повторить проверку без GPU?" };
  const make = (tool: string, data: unknown, options = {}) => ({
    id: tool, tool, type: "mcpToolCall", server: "ai_taskboard", status: "completed",
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] }, ...options,
  });
  const activity = (item: ReturnType<typeof make>) => boardActivity(new Map(), "item/completed", { item });
  for (const tool of ["task_unblock", "task_cancel", "task_comment", "task_update"]) {
    const reason = "Пользователь поручил ещё одну попытку…";
    const item = make(tool, { id: "T-0115", title: "Проверка", status: "ready", revision: 4 }, { arguments: { reason } });
    for (const result of [activity(item), activity(JSON.parse(JSON.stringify(item)))]) {
      assert.equal(result.messages, undefined);
      assert.equal(result.taskChanges[0].reason, undefined);
      assert.ok(result.text.includes(reason)); // Audit data stays inside tool details.
    }
  }
  const inbox = activity(make("manager_inbox", [question]));
  assert.equal(inbox.messages[0].actor, "agent");
  assert.equal(inbox.messages[0].text, question.text);
  assert.equal(inbox.messagesOnly, true);
  const wait = activity(make("task_wait", { inbox: [question, { ...question, sequence: 22, kind: "submit" }] }));
  assert.equal(wait.messages.length, 1);
  assert.equal(wait.messagesOnly, false);
  const approval = { ...question, sequence: 22, kind: "review-approve", actor: "reviewer", text: "Сдача согласована." };
  const delivered = activity(make("task_wait", { inbox: [approval] }));
  assert.equal(delivered.messages[0].actor, "reviewer");
  assert.equal(delivered.messages[0].text, approval.text);
  const returned = { ...approval, kind: "request-changes", text: "Проверь частичную запись." };
  assert.equal(activity(make("manager_inbox", [returned])).messages[0].kind, "request-changes");
  assert.equal(activity(make("task_wait", { inbox: [returned] })).messages[0].text, returned.text);
  const sent = make("task_message", { id: question.id, sequence: 23, at: question.at, notified: false },
    { arguments: { id: question.id, text: "Да, сначала CPU." } });
  assert.equal(activity(sent).messages[0].actor, "manager");
  assert.equal(activity(sent).messages[0].sequence, 23);
  assert.equal(activity(sent).messages[0].text, "Да, сначала CPU.");
  for (const item of [sent, JSON.parse(JSON.stringify(sent))]) {
    assert.equal(activity(item).messages[0].at, question.at);
  }
  assert.equal(inbox.messages[0].at, question.at);
  const legacy = make("task_message", { id: question.id, sequence: 24 }, sent);
  legacy.result = make("task_message", { id: question.id, sequence: 24 }).result;
  assert.equal(activity(legacy).messages[0].at, undefined);
  assert.equal(activity({ ...sent, status: "failed" }).messages, undefined);
  assert.equal(activity(make("manager_ack", { id: question.id, through: question.sequence })).messagesOnly, true);
});

test("board history recovers a steering message and its attachment in the middle of a turn", async () => {
  const content = [{ type: "text", text: JSON.stringify({ latestUserMessage: {
    text: "Уточнение", attachments: [{ name: "preview.png", imageIndex: 1 }],
  } }) }, { type: "image", url: "data:image/png;base64,eA==" }];
  const row = (id: string, type: string, payload: object) => ({ turnId: "one-turn", ...(type === "agentMessage" ? { startedAtMs: 123 } : {}), item: { id, type, ...payload } });
  const pages = [
    { data: [row("answer", "agentMessage", { text: "Принял уточнение", phase: "final_answer" }),
      row("steer", "userMessage", { clientId: "queue-id", content }),
      row("wake", "userMessage", { content: [{ type: "text",
        text: "AI Taskboard: new executor messages or outcomes are available. Read manager_inbox." }] })], nextCursor: "more" },
    { data: [row("command", "commandExecution", { command: "git status" }),
      row("start", "userMessage", { content: [{ type: "text", text: "Начинай" }] })], nextCursor: null },
  ];
  const requests: string[] = [];
  const read = runInNewContext(stripTypeScriptTypes(source) + "\nwithServer = mockServer; readBoardHistory", {
    runActivity,
    mockServer: async (_profile: string, _project: string, callback: Function) => callback({
      async request(method: string, params: Record<string, unknown>) {
        requests.push(method);
        if (method === "thread/read") {
          assert.equal(params.includeTurns, false);
          return { thread: {} };
        }
        if (method === "thread/goal/get") return { goal: null };
        assert.equal(method, "thread/items/list");
        assert.equal(params.sortDirection, "desc");
        assert.equal(params.limit, 60);
        assert.equal(params.cursor, pages.length === 2 ? null : "more");
        return pages.shift();
      },
    }),
  });
  const newest = await read("profile", "project", "manager");
  assert.equal(newest.nextCursor, "more");
  assert.equal(newest.turns[0].items[0].at, new Date(123).toISOString());
  assert.equal(pages.length, 1);
  const earlier = await read("profile", "project", "manager", newest.nextCursor);
  assert.equal(earlier.nextCursor, null);
  assert.deepEqual(requests, ["thread/read", "thread/goal/get", "thread/items/list", "thread/items/list"]);
  assert.deepEqual(JSON.parse(JSON.stringify([...earlier.turns, ...newest.turns].map((turn: any) => ({
    messages: turn.messages, items: turn.items.map((item: { id: string }) => item.id),
  })))), [
    { messages: [{ text: "Начинай", files: [] }], items: ["command"] },
    { messages: [{ text: "Уточнение", files: [{ name: "preview.png", url: content[1].url }], clientId: "queue-id" }], items: ["answer"] },
  ]);
});

test("discussion steering and interruption share the streaming connection, including during a tool call", async t => {
  const directory = mkdtempSync(join(tmpdir(), "ai-taskboard-chat-test-"));
  mkdirSync(join(directory, ".tasks"), { recursive: true });
  writeFileSync(join(directory, ".tasks", "board.json"), JSON.stringify({ settings: { boardType: "manual" } }));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const script = join(directory, "provider.cjs");
  writeFileSync(script, `
    const send = value => console.log(JSON.stringify(value));
    const assert = require('node:assert/strict');
    const url = process.argv.find(value => value.startsWith('mcp_servers={ai_taskboard=')).match(/http[^"]+/)[0];
    const invoke = async (method, params) => {
      const response = await fetch(url, { method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.AI_TASKBOARD_MCP_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return response.json();
    };
    require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined || !method) return;
      let result = {};
      if (method === 'model/list') result = { data: [{ model: 'test', defaultReasoningEffort: 'low', supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === 'thread/start') {
        assert.equal(params.sandbox, 'read-only');
        result = { thread: { id: 'thread' } };
      }
      if (method === 'turn/start') {
        const { result: { tools } } = await invoke('tools/list');
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['expert_context', 'expert_list', 'expert_skill', 'github_read', 'worklog_record']);
        const github = await invoke('tools/call', { name: 'github_read', arguments: { view: 'run-failed-log', runId: 43816168554 } });
        assert.equal(JSON.parse(github.result.content[0].text).data.log, 'Dependency resolution failed');
        const write = await invoke('tools/call', { name: 'github_set_milestone_due', arguments: {} });
        assert.equal(write.error.code, -32601);
        result = { turn: { id: 'turn', status: 'inProgress' } };
      }
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
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.pipe(process.stderr);
      return child;
    },
    executorExpertTools, expertCommands, trackActiveRun, trackProvider, claimDiscussion, codexRpc, turnControl, CodexTokenUsage, withBoardMcp, manualContext: () => "", readBoardSettings: () => ({}), locateBoard: (path: string) => path, responseLanguageInstructions, boardAgentInstructions, boardCodexArgs, managerCodexArgs, providerActions, boardWorklog, worklogTool, worklogReminder,
    githubReadTool, readBoardGitHub: async (project: string, args: unknown) => {
      assert.equal(project, directory);
      assert.deepEqual(args, { view: "run-failed-log", runId: 43816168554 });
      return { ok: true, data: { log: "Dependency resolution failed" } };
    },
    process, setTimeout, clearTimeout,
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
  mkdirSync(join(directory, ".tasks"), { recursive: true });
  writeFileSync(join(directory, ".tasks", "board.json"), JSON.stringify({ settings: { boardType: "manual" } }));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const script = join(directory, "provider.cjs");
  const captured = join(directory, "requests.json");
  const threadId = "00000000-0000-0000-0000-000000000001";
  writeFileSync(script, `
    const fs = require("node:fs");
    fs.writeFileSync("server-flags", JSON.stringify(process.argv.slice(3)));
    const requests = [];
    let retries = 0;
    let goal = { objective: "Read this", status: "active" };
    const approvalReplies = new Map();
    const threadId = ${JSON.stringify(threadId)};
    const send = value => console.log(JSON.stringify(value));
    require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
      const { id, method, params, result, error } = JSON.parse(line);
      if (approvalReplies.has(id) && !method) {
        approvalReplies.get(id)(error ?? result);
        approvalReplies.delete(id);
        return;
      }
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
      } else if (method === "thread/resume" || method === "thread/start") {
        send({ id, result: { thread: { id: threadId, name: "Project manager" }, model: params.model,
          activePermissionProfile: { id: process.argv[2] === "wrong-access" ? ":read-only" : params.permissions },
          approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer } });
      } else if (method === "thread/goal/set") {
        goal = { objective: params.objective ?? goal.objective, status: params.status ?? goal.status };
        send({ id, result: { goal } });
        send({ method: "thread/goal/updated", params: { threadId, goal } });
        if (process.argv[2] === "native-resume" && params.status === "active") {
          send({ method: "turn/started", params: { threadId, turn: { id: "native", status: "inProgress" } } });
          send({ method: "item/completed", params: { threadId, elapsed: 240_000, item: { id: "native", type: "agentMessage", phase: "final_answer", text: "Resumed the goal" } } });
          send({ method: "thread/goal/updated", params: { threadId, goal: { ...goal, status: "complete" } } });
          send({ method: "turn/completed", params: { threadId, turn: { id: "native", status: "completed" } } });
        }
      } else if (method === "thread/goal/get") {
        send({ id, result: { goal: process.argv[2] === "native-resume" ? { ...goal, status: "paused" } : goal } });
      } else if (method === "thread/goal/clear") {
        send({ id, result: { cleared: true } });
        send({ method: "thread/goal/cleared", params: { threadId } });
      } else if (method === "turn/start") {
        const config = process.argv.find(value => value.startsWith("mcp_servers.ai_taskboard="));
        const native = process.argv[2] === "cli-ready";
        const url = config.match(/http[^"]+/)[0];
        for (const name of ["task_start", "project_git", "task_review_queue", "project_path"]) {
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
        if (tools.map(tool => tool.name).join(",") !== (native ? "task_start,task_review_queue,project_path,worklog_record" :
          "task_start,project_git,task_review_queue,project_path,worklog_record")) throw new Error("Unexpected board tools");
        for (const [name, args] of [["task_start", { id: "T-0001", revision: 2 }], ["project_git", { view: "status" }],
          ["task_review_queue", {}], ["project_path", { path: ".", list: true }]]) {
          if (native && name === "project_git") continue;
          const result = await invoke("tools/call", { name, arguments: args });
          if (result.isError) throw new Error("Board tool failed");
        }
        send({ id, result: { turn: { id: "reply", status: "inProgress" } } });
        send({ method: "turn/started", params: { threadId, turn: { id: "reply", status: "inProgress" } } });
        if (process.argv[2] === "manual-access") {
          const approve = (kind, extra) => new Promise(resolve => {
            approvalReplies.set(kind, resolve);
            send({ id: kind, method: "item/" + kind + "/requestApproval", params: { threadId, turnId: "reply", ...extra } });
          });
          const command = await approve("commandExecution", { command: "Get-ChildItem", cwd: process.cwd(), availableDecisions: ["accept", "decline"] });
          if (command?.decision !== "accept") throw Error("One-time command approval was not applied");
          const permission = await approve("permissions", { permissions: { network: { enabled: true } } });
          if (permission?.scope !== "turn" || Object.keys(permission.permissions).length) throw Error("Denied permissions were granted");
        }
        const usage = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10 };
        send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "reply", tokenUsage: { total: usage, last: usage } } });
        send({ method: "item/completed", params: { threadId, elapsed: 120_000, item: { id: "first", type: "agentMessage", phase: "final_answer", text: "First turn" } } });
        if (params.input[0].text === "Silent") {
          send({ method: "item/started", params: { threadId: "another-thread", elapsed: 120_000 } });
          send({ method: "item/started", params: { threadId: "another-thread", elapsed: 480_001 } });
          return;
        }
        send({ method: "turn/completed", params: { threadId, turn: { id: "reply", status: "completed" } } });
        send({ method: "turn/started", params: { threadId, turn: { id: "continuation", status: "inProgress" } } });
        if (params.input[0].text === "Read this") {
          const entry = { title: "Менеджер продолжил цель", timeline: [{ time: null, items: ["Проверил доску."] }] };
          for (const field of ["context", "changes", "decisions", "checks", "next_steps"]) entry[field] = ["Доска проверена."];
          const args = { language: "ru", entries: [entry] };
          const result = await invoke("tools/call", { name: "worklog_record", arguments: args });
          if (result.isError) throw new Error(result.content[0].text);
          fs.writeFileSync("worklog-path", JSON.parse(result.content[0].text).data.path);
        }
        const total = Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, value * 2]));
        send({ method: "thread/tokenUsage/updated", params: { threadId, turnId: "continuation", tokenUsage: { total, last: usage } } });
        if (["Stop", "Manage"].includes(params.input[0].text)) {
          send({ method: "item/completed", params: { threadId, item: { id: "stop", type: "agentMessage", phase: "commentary", text: "Stop here" } } });
          return;
        }
        send({ method: "turn/completed", params: { threadId, turn: { id: "reply", status: "completed" } } });
        send({ method: "item/completed", params: { threadId, elapsed: 120_000, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Done" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: "continuation", status: "completed" } } });
        send({ method: "thread/goal/updated", params: { threadId, goal: { ...goal, status: "complete" } } });
      } else if (method === "turn/steer") {
        if (params.expectedTurnId !== "continuation") throw new Error("Wrong continuation");
        send({ id, result: { turnId: "continuation" } });
        send({ method: "item/completed", params: { threadId, turnId: "continuation", item: {
          id: "received", type: "userMessage", clientId: params.clientUserMessageId, content: params.input,
        } } });
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
    spawn, turnControl, CodexTokenUsage, codexThreadPattern, Error, process, withBoardMcp, goalTaskWaitSeconds,
    managerCliContext, probeManagerCli: async () => providerMode === "cli-ready"
      ? { gitOptions: ["--no-optional-locks", "-c", "core.fsmonitor=false"] } : {},
    manualContext: () => "", readBoardSettings: () => ({}), locateBoard: (path: string) => path, responseLanguageInstructions, boardAgentInstructions, boardCodexArgs, managerCodexArgs, providerActions, boardWorklog, worklogTool, worklogReminder,
    trackActiveRun, trackProvider, claimDiscussion, codexRpc: (child: Parameters<typeof codexRpc>[0], notify: Parameters<typeof codexRpc>[1], onRequest: Parameters<typeof codexRpc>[2]) =>
      codexRpc(child, (message: RpcMessage) => {
        elapsed += (message.params as { elapsed?: number })?.elapsed ?? 0;
        if (watchdog && elapsed >= watchdog.expires) watchdog.fail();
        return notify(message);
      }, onRequest),
    setTimeout: (callback: () => void, ms: number) => {
      if (ms !== 180_000 && ms !== 600_000) return setTimeout(callback, ms);
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
    configuredCodex: async () => ({ path: process.execPath, args: [script, providerMode], windowsSandbox: "elevated" }),
    runActivity,
  });
  const controller = new AbortController();
  const image = "data:image/png;base64,eA==";
  let accepted = 0;
  let control: AgentControl;
  const stop = Promise.withResolvers<() => Promise<void>>();
  const receipt = Promise.withResolvers<string>();
  const reports: import("../src/cli/token-usage.ts").TokenUsageReport[] = [];
  const session = {
    id: threadId, title: "Project manager", save: () => assert.fail("Thread ID must be preserved"),
    settings: { model: "manager-model", effort: "high" },
    goal: "Read this",
    mcpTools: ["task_start", "project_git", "task_review_queue", "project_path"].map(name => ({ name, description: name, inputSchema: { type: "object" } })),
    onGoalSet: () => accepted++, onActivity() {}, onControl: (value: AgentControl) => { control = value; },
    onWaiting: (value: boolean) => waiting.push(value),
    onTokenUsage: async (report: import("../src/cli/token-usage.ts").TokenUsageReport) => { reports.push(report); },
  };
  const launched: unknown[] = [];
  const result = await runtime("profile", directory, "Read this", [image], (name: string, args: unknown) => {
    launched.push({ name, args });
    return { ok: true, data: { id: "T-0001" } };
  }, [], "", controller.signal, session);
  assert.equal(result.text, "First turn\n\nDone");
  assert.deepEqual(Array.from(reports.at(-1)!.records, ({ turnId, totalTokens }) => [turnId, totalTokens]),
    [["reply", 120], ["continuation", 120]]);
  assert.equal(result.goalStatus, "complete");
  assert.equal(elapsed, 240_000);
  assert.deepEqual(launched, [
    { name: "task_start", args: { id: "T-0001", revision: 2 } },
    { name: "project_git", args: { view: "status" } },
    { name: "task_review_queue", args: {} },
    { name: "project_path", args: { path: ".", list: true } },
  ]);
  assert.deepEqual(waiting, [true, false]);
  assert.deepEqual(waits, [1000, 2000, 4000, 5000]);
  const requests = JSON.parse(readFileSync(captured, "utf8"));
  const flags = () => JSON.parse(readFileSync(join(directory, "server-flags"), "utf8")) as string[];
  assert.match(flags().find(flag => flag.startsWith("mcp_servers.ai_taskboard="))!, /tool_timeout_sec=320,/);
  assert.ok(flags().includes('web_search="live"'));
  assert.ok(!flags().includes("plugins"));
  assert.ok(!flags().some(flag => flag.startsWith("mcp_servers=")));
  assert.ok(flags().includes('permissions.ai-taskboard-manager={filesystem={":root"="read"},network={enabled=true}}'));
  assert.ok(flags().includes('default_permissions="ai-taskboard-manager"'));
  assert.ok(flags().includes("network_proxy"));
  assert.equal(flags().includes("prefer_mxc"), process.platform === "win32");
  assert.deepEqual(flags().filter(flag => flag.startsWith("windows.sandbox=")),
    process.platform === "win32" ? ['windows.sandbox="elevated"'] : []);
  assert.deepEqual(requests.map(({ method }: { method: string }) => method), [
    "initialize", "model/list", ...Array(5).fill("thread/resume"), "thread/goal/set", "turn/start", "thread/unsubscribe",
  ]);
  assert.ok(requests.slice(2).every(({ params }: { params: { threadId: string } }) => params.threadId === threadId));
  assert.equal(requests[6].params.model, "manager-model");
  assert.equal(requests[6].params.permissions, "ai-taskboard-manager");
  assert.equal(requests[6].params.sandbox, undefined);
  assert.match(requests[6].params.developerInstructions, /documentation impact in task planning and goal work/);
  assert.match(requests[6].params.developerInstructions, /These rules apply.*worklog_record/s);
  assert.match(requests[6].params.developerInstructions, /Apply built-in rules silently/);
  assert.match(requests[6].params.developerInstructions, /Internally verify recorded:true and staged:false/);
  assert.doesNotMatch(requests[6].params.developerInstructions, /Ponytail|humanizer-ru|Codex Worklog/);
  assert.match(requests[6].params.developerInstructions, /Format substantial progress updates in Markdown/);
  assert.ok(requests[6].params.developerInstructions.includes(russianWriting));
  const diaryPath = readFileSync(join(directory, "worklog-path"), "utf8");
  assert.match(readFileSync(diaryPath, "utf8"), /Менеджер продолжил цель/);
  assert.deepEqual(requests[6].params.config, { model_reasoning_effort: "high" });
  assert.equal(requests.at(-2).params.effort, "high");
  assert.deepEqual(requests.at(-2).params.additionalContext.ai_taskboard_worklog, { value: worklogReminder, kind: "application" });
  assert.equal(requests.at(-2).params.sandboxPolicy, undefined);
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
  assert.equal(elapsed, 960_001);

  let liveSteer: { at?: string; text: string; files: { url: string }[] } | undefined;
  const stopping = runtime("profile", directory, "Stop", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session,
    onMessage: receipt.resolve,
    onActivity: (items: { text?: string; userMessage?: typeof liveSteer }[]) => {
      if (items.some(item => item.text === "Stop here")) stop.resolve(() => control.interrupt());
      liveSteer = items.find(item => item.userMessage)?.userMessage;
    },
  });
  const stopReply = await stop.promise;
  await control!.steer("Уточнение", [image], "queue-message");
  assert.equal(await receipt.promise, "queue-message");
  assert.ok(Number.isFinite(Date.parse(liveSteer?.at ?? "")));
  assert.equal(liveSteer?.text, "Уточнение");
  assert.equal(liveSteer?.files[0].url, image);
  await stopReply();
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
  const writingRules = readFileSync(new URL("../src/desktop/agent-instructions/task-writing.md", import.meta.url), "utf8").trim();
  assert.ok(resumedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.developerInstructions.includes(writingRules));
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
  assert.ok(flags().includes("network_proxy"));
  assert.deepEqual([...new Set(statuses)], ["active", "complete"]);
  const continuedRequests = JSON.parse(readFileSync(captured, "utf8"));
  assert.ok(continuedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.developerInstructions.includes(writingRules));
  assert.match(flags().find(flag => flag.startsWith("mcp_servers.ai_taskboard="))!, /tool_timeout_sec=320,/);
  assert.deepEqual(continuedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.config,
    { model_reasoning_effort: "high" });
  assert.equal(continuedRequests.find(({ method }: { method: string }) => method === "thread/resume").params.permissions,
    "ai-taskboard-manager");
  assert.ok(flags().includes('web_search="live"'));
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

  let savedThread: string | undefined;
  providerMode = "cli-ready";
  localization.select("ja");
  t.after(() => localization.select("en"));
  await runtime("profile", directory, "Start", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, id: undefined, goal: undefined, save: (id: string) => { savedThread = id; },
  });
  const newRequests: { method: string; params: Record<string, unknown> }[] = JSON.parse(readFileSync(captured, "utf8"));
  const start = newRequests.find(({ method }) => method === "thread/start");
  assert.match(start?.params.developerInstructions as string, /Default response language: 日本語 \(ja\)/);
  assert.equal(savedThread, threadId);
  assert.ok(flags().includes("network_proxy"));
  assert.equal(start?.params.cwd, directory);
  assert.ok((start?.params.developerInstructions as string).includes(writingRules));
  assert.match(start?.params.developerInstructions as string, /git --no-pager --literal-pathspecs/);
  assert.equal(start?.params.permissions, "ai-taskboard-manager");
  assert.equal(start?.params.approvalPolicy, "on-request");
  assert.equal(start?.params.approvalsReviewer, "auto_review");
  assert.match(start?.params.developerInstructions as string, /Board settings, Project manager, Access mode/);
  assert.equal(Object.hasOwn(start!.params, "projectId"), false);
  assert.equal(newRequests.some(({ method }) => method.startsWith("project/")), false);
  localization.select("pl");
  const nativeResume = await runtime("profile", directory, "Reply in Spanish: Continue", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, id: savedThread, goal: undefined,
  });
  assert.equal(nativeResume.text, "First turn\n\nDone");
  const nativeRequests: typeof newRequests = JSON.parse(readFileSync(captured, "utf8"));
  const languageRules = nativeRequests.find(({method}) => method === "thread/resume")?.params.developerInstructions as string;
  assert.match(languageRules, /Default response language: Polski \(pl\)/);
  assert.match(languageRules, /explicit language requested by the user/);
  assert.equal((nativeRequests.find(({method}) => method === "turn/start")?.params.input as any[])[0].text, "Reply in Spanish: Continue");
  assert.match(nativeRequests.find(({ method }) => method === "thread/resume")?.params.developerInstructions as string,
    /git --no-pager --literal-pathspecs/);
  assert.equal(nativeRequests.find(({ method }) => method === "thread/resume")?.params.approvalsReviewer, "auto_review");

  providerMode = "manual-access";
  const prompts: string[] = [];
  await runtime("profile", directory, "Check access", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, goal: undefined, access: "ask",
    confirmApproval: async (details: string) => { prompts.push(details); return prompts.length === 1; },
  });
  const manualRequests: typeof newRequests = JSON.parse(readFileSync(captured, "utf8"));
  const manual = manualRequests.find(({ method }) => method === "thread/resume")?.params;
  assert.equal(manual?.approvalPolicy, "on-request");
  assert.equal(manual?.approvalsReviewer, "user");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Get-ChildItem/);
  assert.match(prompts[1], /"enabled": true/);

  providerMode = "cli-ready";
  for (const id of [undefined, savedThread]) {
    await runtime("profile", directory, "Check SSH", [], () => ({ ok: true }), [], "", controller.signal, {
      ...session, id, goal: undefined, access: "full", save: (id: string) => assert.equal(id, threadId),
    });
    const fullRequests: typeof newRequests = JSON.parse(readFileSync(captured, "utf8"));
    const full = fullRequests.find(({ method }) => method === (id ? "thread/resume" : "thread/start"))!;
    assert.ok(flags().includes('default_permissions=":danger-full-access"'));
    assert.ok(!flags().some(flag => flag.startsWith("windows.sandbox=")));
    assert.equal(full.params.permissions, ":danger-full-access");
    assert.equal(full.params.approvalPolicy, "never");
    assert.match(full.params.developerInstructions as string, /Keep SSH host key checking enabled/);
    assert.ok(fullRequests.filter(({ method }) => method === "command/exec")
      .every(({ params }) => params.permissionProfile === ":danger-full-access"));
  }
  providerMode = "wrong-access";
  await assert.rejects(runtime("profile", directory, "Check SSH", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, id: undefined, goal: undefined, access: "full",
  }), /did not apply the selected manager access mode/);

  providerMode = "";
  await runtime("profile", directory, "Review in manager context", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, goal: undefined, readOnly: true, access: "full",
  });
  const sharedReview: typeof newRequests = JSON.parse(readFileSync(captured, "utf8"));
  const sharedThread = sharedReview.find(({ method }) => method === "thread/resume");
  assert.equal(sharedThread?.params.threadId, threadId);
  assert.equal(sharedThread?.params.sandbox, "read-only");
  assert.equal(sharedReview.some(({ method }) => method === "thread/start"), false);
  assert.deepEqual(sharedReview.find(({ method }) => method === "turn/start")?.params.sandboxPolicy,
    { type: "readOnly", networkAccess: false });
  await runtime("profile", directory, "Review submissions", [], () => ({ ok: true }), [], "", controller.signal, {
    ...session, goal: undefined, separateTurn: true, access: "full", save: (id: string) => assert.equal(id, threadId),
  });
  const reviewRequests: typeof newRequests = JSON.parse(readFileSync(captured, "utf8"));
  assert.match(flags().find(flag => flag.startsWith("mcp_servers.ai_taskboard="))!, /tool_timeout_sec=140,/);
  assert.ok(flags().includes('web_search="live"'));
  assert.ok(!flags().includes("plugins"));
  assert.ok(!flags().includes("network_proxy"));
  const reviewThread = reviewRequests.find(({ method }) => method === "thread/start");
  assert.equal(reviewThread?.params.ephemeral, true);
  assert.equal(reviewThread?.params.historyMode, undefined);
  assert.equal(reviewRequests.some(({ method }) => method === "thread/resume" || method.startsWith("thread/goal/")), false);
  assert.equal(reviewThread?.params.permissions, undefined);
  assert.equal(reviewThread?.params.sandbox, "read-only");
  assert.deepEqual(reviewRequests.find(({ method }) => method === "turn/start")?.params.sandboxPolicy,
    { type: "readOnly", networkAccess: false });
});
