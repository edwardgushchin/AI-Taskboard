import { confirmFixtureDraft, plannedDraft } from "./fixtures/planned-draft.ts";
import { activeRunSummary } from "../src/desktop/active-runs.ts";
import assert from "node:assert/strict";
import { callCli } from "../src/desktop/cli.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startCodexRun, writeProbeTimeoutCode } from "../src/desktop/codex-run.ts";
import { executorFullAccess } from "../src/desktop/codex.ts";
import { CodexRpcRejection, codexRpc, stopCodexProcess, watchCodexQuotaExceeded } from "../src/desktop/codex-rpc.ts";
import { russianWriting } from "../src/desktop/russian-writing.ts";
import { createTask } from "../src/cli/tasks.ts";
import { readBoardProjectRules, writeBoardProjectRules } from "../src/cli/board-agents.ts";
import type { RunActivity } from "../src/cli/model.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";

test("executor full access is saved for the selected board and card only", t => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ai-taskboard-executor-access-")));
  t.after(() => rmSync(folder, { recursive: true }));
  const profile = join(folder, "settings");
  const project = join(folder, "board");
  mkdirSync(project);
  const task = { id: "T-0001", createdAt: "2026-11-16T10:00:00Z" };
  assert.equal(executorFullAccess(profile, project, task), false);
  assert.equal(executorFullAccess(profile, project, task, true), true);
  assert.equal(executorFullAccess(profile, project, task), true);
  assert.equal(executorFullAccess(profile, folder, task), false);
  assert.equal(executorFullAccess(profile, project, { ...task, id: "T-0002" }), false);
  assert.equal(executorFullAccess(profile, project, { ...task, createdAt: "2026-11-16T10:00:01Z" }), false);
  assert.equal(executorFullAccess(profile, project, task, false), false);
  assert.equal(executorFullAccess(profile, project, task), false);
});

test("closing the Codex connection does not wait for a descendant's output pipe", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: ["ignore", "inherit", "inherit"], windowsHide: true, detached: true,
    });
    console.log(JSON.stringify({ method: "helper/started", params: helper.pid }));
    helper.unref();
    process.stdin.resume();
  `], { stdio: "pipe", windowsHide: true });
  const closed = once(child, "close");
  const helper = Promise.withResolvers<number>();
  const rpc = codexRpc(child, message => { helper.resolve(message.params as number); });
  const deadline = new AbortController();
  let pid: number | undefined;
  try {
    pid = await Promise.race([
      helper.promise,
      delay(3_000, undefined, { signal: deadline.signal }).then(() => { throw new Error("Helper did not start"); }),
    ]);
    rpc.close();
    child.stdin.end();
    await Promise.race([
      closed,
      delay(3_000, undefined, { signal: deadline.signal }).then(() => { throw new Error("Codex output pipe stayed open"); }),
    ]);
    assert.doesNotThrow(() => process.kill(pid!, 0));
  } finally {
    deadline.abort();
    if (pid) {
      try { process.kill(pid); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    child.kill();
    await closed;
  }
});

test("Windows Codex shutdown terminates detached descendants", { skip: process.platform !== "win32", timeout: 45_000 }, async () => {
  for (let cycle = 0; cycle < 3; cycle++) {
    const child = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true, windowsHide: true, stdio: "ignore",
      });
      console.log(worker.pid);
      worker.unref();
      process.stdin.resume();
    `], { stdio: "pipe", windowsHide: true });
    const exited = once(child, "close");
    const stop = stopCodexProcess(child);
    const deadline = new AbortController();
    let worker: number | undefined;
    try {
      const event = await Promise.race([
        once(child.stdout, "data"),
        delay(5000, undefined, { signal: deadline.signal }).then(() => { throw Error("Fixture worker did not start."); }),
      ]);
      worker = Number(String(event[0]).trim());
      assert.ok(Number.isSafeInteger(worker) && worker > 0);
      process.kill(worker, 0);
      const stopped = stop();
      assert.equal(stop(), stopped);
      await stopped;
      await exited;
      assert.throws(() => process.kill(worker!, 0), { code: "ESRCH" });
    } finally {
      deadline.abort();
      if (worker) {
        try { process.kill(worker); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      child.kill();
      await exited;
    }
  }
});

test("Codex quota rejection keeps the server error when the quota listener aborts the connection", async () => {
  const child = spawn(process.execPath, ["-e", `
    require("node:readline").createInterface({ input: process.stdin }).once("line", line => {
      const { id } = JSON.parse(line);
      console.log(JSON.stringify({
        id,
        error: { message: "Quota exhausted", data: { codexErrorInfo: "usageLimitExceeded" } },
      }));
    });
  `], { stdio: "pipe", windowsHide: true });
  const closed = once(child, "close");
  const rpc = codexRpc(child, () => {});
  const interruption = new Error("Local quota interruption");
  watchCodexQuotaExceeded(() => rpc.fail(interruption));
  try {
    await assert.rejects(rpc.request("turn/start", {}), error => {
      assert.ok(error instanceof CodexRpcRejection);
      assert.equal(error.message, "Quota exhausted");
      return true;
    });
    await assert.rejects(rpc.request("turn/start", {}), interruption);
  } finally {
    watchCodexQuotaExceeded(() => {});
    rpc.close();
    child.kill();
    await closed;
  }
});

test("the Codex launch probes access, applies settings, and monitors the turn", async t => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ai-taskboard-codex-run-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const worktree = join(folder, ".worktrees", "T-0001");
  mkdirSync(join(folder, ".worktrees"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "main");
  assert.equal((await callCli(folder, ["init"])).ok, true);
  writeBoardProjectRules(folder, {
    text: "Executor OLD rule", revision: readBoardProjectRules(folder).revision,
  });
  git("add", "AGENTS.md");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", "Initial");
  const base = git("rev-parse", "HEAD");
  git("worktree", "add", "-b", "ai-taskboard/T-0001", worktree);
  if (process.platform !== "win32") {
    renameSync(join(folder, "AGENTS.md"), join(folder, "executor-rules.md"));
    symlinkSync("executor-rules.md", join(folder, "AGENTS.md"), "file");
  }
  writeBoardProjectRules(folder, {
    text: "Executor CURRENT rule", revision: readBoardProjectRules(folder).revision,
  });
  const stub = join(folder, "codex.cjs");
  const capture = join(folder, "captured.json");
  const thread = "01234567-1234-5678-1234-123456789012";
  writeFileSync(stub, [
    'const fs = require("node:fs");',
    'const [capture, outcome, ...flags] = process.argv.slice(2);',
    'const thread = ' + JSON.stringify(thread) + ';',
    'const requests = [];',
    'const send = value => console.log(JSON.stringify(value));',
    'require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {',
    '  const { id, method, params } = JSON.parse(line);',
    '  if (id === undefined) return;',
    '  requests.push({ method, params });',
    '  fs.writeFileSync(capture, JSON.stringify({ cwd: process.cwd(), flags, requests, temp: process.env.TEMP, tmp: process.env.TMP, tmpdir: require("node:os").tmpdir(), electronLog: process.env.ELECTRON_LOG_FILE }));',
    '  let result = {};',
    '  if (method === "command/exec") {',
    '    if (outcome === "spawn-error") {',
    '      send({ id, error: { message: "failed to spawn command (os error 2)" } });',
    '      return;',
    '    }',
    '    const [exe, flag, script, ...roots] = params.command;',
    '    const fault = outcome === "denied" ? `',
    '      const write = require("node:fs").writeFileSync;',
    '      require("node:fs").writeFileSync = (file, data, options) => {',
    '        if (data === "1") throw Object.assign(new Error("injected"), { code: "EACCES" });',
    '        return write(file, data, options);',
    '      };',
    '    ` : "";',
    '    if (outcome === "silent-exit") {',
    '      result = { exitCode: 7, stdout: "", stderr: "" };',
    '    } else if (outcome === "mxc-launch-error") {',
    '      result = { exitCode: 1, stdout: "", stderr: "MXC launcher: CreateProcessW failed with error code 2 (0x00000002).\\n" };',
    '    } else if (outcome === "timeout") {',
    '      const path = require("node:path");',
    '      const dir = path.join(roots[1], roots[0]);',
    '      fs.mkdirSync(dir);',
    '      fs.writeFileSync(path.join(dir, "probe"), "0");',
    '      result = { exitCode: 124, stdout: "", stderr: "" };',
    '    } else if (outcome === "missing-confirmation") {',
    '      result = { exitCode: 0, stdout: "", stderr: "" };',
    '    } else if (outcome === "denied") {',
    '      const child = require("node:child_process").spawnSync(exe, [flag, fault + script, ...roots], {',
    '        cwd: params.cwd, env: { ...process.env, ...params.env }, encoding: "utf8", windowsHide: true,',
    '      });',
    '      result = { exitCode: child.status, stdout: child.stdout, stderr: child.stderr };',
    '    } else {',
    '      result = { exitCode: 0, stdout: "taskboard-write-probe ok" };',
    '    }',
    '  } else if (method === "config/read") {',
    '    result = { config: { mcp_servers: { ai_taskboard: { url: "http://127.0.0.1/mcp" } } } };',
    '  } else if (method === "mcpServerStatus/list") {',
    '    const url = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^"]+/)[0];',
    '    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },',
    '      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });',
    '    const { tools } = (await response.json()).result;',
    '    result = { data: [{ name: "ai_taskboard", tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] };',
    '  } else if (method === "thread/start" || method === "thread/resume") {',
    '    if (outcome === "busy") { send({ id, error: { message: "thread " + thread + " already has an active writer" } }); return; }',
    '    if (outcome === "missing" && method === "thread/resume") { send({ id, error: { message: "no rollout found for thread id " + params.threadId } }); return; }',
    '    if (outcome === "archived" && method === "thread/resume" && !requests.some(request => request.method === "thread/unarchive")) {',
    '      send({ id, error: { message: "session " + params.threadId + " is archived. Run codex unarchive first." } });',
    '      return;',
    '    }',
    '    result = { model: "resolved-model", thread: { id: params.threadId ?? thread },',
    '      approvalPolicy: params.approvalPolicy, approvalsReviewer: outcome === "manual-review" ? "user" : params.approvalsReviewer,',
    '      activePermissionProfile: { id: outcome === "readonly" ? ":read-only" : params.permissions } };',
    '  } else if (method === "turn/start") {',
    '    const turnId = outcome === "resumed" || outcome === "legacy-worklog" ? outcome + "-turn" : "turn-1";',
    '    result = { turn: { id: turnId, status: "inProgress" } };',
    '  }',
    '  if (method === "turn/steer") {',
    '    send({ method: "item/agentMessage/delta", params: { threadId: thread, itemId: "live", delta: params.input[0].text } });',
    '    if (params.input[0].text === "reject") { send({ id, error: { message: "No active turn" } }); return; }',
    '    if (params.clientUserMessageId) {',
    '      const item = { id: "steered", type: "userMessage", clientId: params.clientUserMessageId, content: params.input };',
    '      send({ method: "item/completed", params: { threadId: thread, turnId: "other-turn", item: { ...item, clientId: "other" } } });',
    '      send({ method: "item/completed", params: { threadId: thread, turnId: params.expectedTurnId, item } });',
    '    }',
    '    setTimeout(() => send({ id, result: { turnId: params.expectedTurnId } }), params.input[0].text === "first" ? 20 : 0); return;',
    '  }',
    '  send({ id, result });',
    '  if (method === "turn/interrupt") send({ method: "turn/completed", params: { threadId: thread, turn: { id: params.turnId, status: "interrupted", error: { message: "Turn interrupted" } } } });',

    '  if (method === "turn/start") {',
    '    if (outcome === "authored-worklog" || outcome === "resumed") {',
    '      const url = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^"]+/)[0];',
    '      const headers = { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN };',
    '      const githubCalls = [',
    '        ["github_read", { view: "repository" }],',
    '        ["github_read", { view: "milestone", number: 1 }],',
    '        ["milestones_list", {}],',
    '        ["github_create_milestone", { repository: "owner/fixture", title: "Next", dueDate: "2026-11-27" }],',
    '        ["github_set_milestone_due", { repository: "owner/fixture", number: 1, dueDate: "2026-11-20" }],',
    '      ];',
    '      const prompt = params.input[0].text;',
    '      if (githubCalls.some(([name]) => !prompt.includes("mcp__ai_taskboard__" + name))) throw new Error("Missing live GitHub tools in executor prompt");',
    '      for (const [name, args] of githubCalls) {',
    '        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",',
    '          params: { name, arguments: args } }) });',
    '        const payload = JSON.parse((await response.json()).result.content[0].text);',
    '        if (payload.error?.code !== "GITHUB_REMOTE_REQUIRED") throw new Error("Unexpected GitHub reply for " + name);',
    '      }',
    '    }',
    '    if (outcome === "authored-worklog") {',
    '      const endpoint = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^"]+/)[0];',
    '      const invalid = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },',
    '        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "task_request_executor_access", arguments: { id: "T-9999" } } }) });',
    '      if (JSON.parse((await invalid.json()).result.content[0].text).error?.code !== "INVALID_INPUT") throw new Error("Access tool must reject a caller-supplied card");',
    '      send({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-1", status: "inProgress" } } });',
    '      const url = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^"]+/)[0];',
    '      const entry = { title: "Исполнитель записал результат", timeline: [{ time: null, items: ["Проверил файлы."] }] };',
    '      for (const field of ["context", "changes", "decisions", "checks", "next_steps"]) entry[field] = ["Проверка пройдена."];',
    '      const args = { language: "ru", entries: [entry] };',
    '      const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },',
    '        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "worklog_record", arguments: args } }) });',
    '      const reply = JSON.parse((await response.json()).result.content[0].text);',
    '      if (!reply.ok) throw new Error(JSON.stringify(reply));',
    '      fs.writeFileSync(capture + ".worklog", reply.data.path);',
    '    }',
    '    if (outcome === "check-wait") {',
    '      const url = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^\"]+/)[0];',
    '      const headers = { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN };',
    '      const cwd = requests.find(request => request.method === "thread/start" || request.method === "thread/resume").params.cwd;',
    '      setTimeout(() => fs.writeFileSync(require("node:path").join(cwd, "check-finished.marker"), ""), 30);',
    '      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",',
    '        params: { name: "check_wait", arguments: { path: "check-finished.marker", timeoutSeconds: 3 } } }) });',
    '      fs.writeFileSync(capture + ".check", (await response.json()).result.content[0].text);',
    '    }',
    '    if (outcome === "control") return;',
    '    if (outcome === "access-switch") {',
    '      const url = flags.find(flag => flag.startsWith("mcp_servers.ai_taskboard=")).match(/http[^"]+/)[0];',
    '      const headers = { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN };',
    '      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",',
    '        params: { name: "task_request_executor_access", arguments: { reason: "Repeat the mandatory local UI check." } } }) });',
    '      const { result } = await response.json();',
    '      const access = JSON.parse(result.content[0].text);',
    '      if (!access.data?.approved || access.data.appliesOn !== "current-execution") throw new Error("Unexpected access decision");',
    '      send({ method: "item/completed", params: { threadId: thread, turnId: "turn-1", item: { id: "approved-access",',
    '        type: "mcpToolCall", server: "ai_taskboard", tool: "task_request_executor_access", status: "completed", result } } });',
    '      return;',
    '    }',
    '    if (outcome === "closed") { console.error(JSON.stringify({ level: "WARN", message: "example diagnostic" })); process.stdin.destroy(); return; }',
    '    if (outcome.startsWith("usage")) {',
    '      send({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-1" } } });',
    '      const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10 };',
    '      send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "turn-1", tokenUsage: { total: counts, last: counts } } });',
    '      if (outcome === "usage-closed") { process.stdin.destroy(); return; }',
    '    }',
    '    const turnId = result.turn.id;',
    '    const itemEvent = (method, params) => send({ method: "item/" + method, params: { threadId: thread, ...params } });',
    '    if (outcome === "legacy-worklog") {',
    '      itemEvent("completed", { turnId, item: { id: "check", type: "commandExecution",',
    '        command: "git status", status: "completed", aggregatedOutput: "private output", exitCode: 0 } });',
    '      itemEvent("completed", { turnId, item: { id: "result", type: "agentMessage", phase: "final_answer",',
    '        text: "Проверил рабочую копию. Незакоммиченных изменений нет.\\n\\nWorklog недоступен — команда текущего хода не предоставлена." } });',
    '    }',
    '    if (["review-denied", "review-approved"].includes(outcome)) {',
    '      const review = { reviewId: "access-1", action: { type: "networkAccess", target: "docs.example.com:443" } };',
    '      itemEvent("autoApprovalReview/started", { ...review, review: { status: "inProgress" } });',
    '      itemEvent("autoApprovalReview/completed", { ...review, review: outcome === "review-denied"',
    '        ? { status: "denied", rationale: "This destination is outside the project scope." }',
    '        : { status: "approved", rationale: "Read public documentation." } });',
    '    }',
    '    itemEvent("started", { item: { id: "note", type: "agentMessage", text: "" } });',
    '    itemEvent("agentMessage/delta", { itemId: "note", delta: "Checking" });',
    '    itemEvent("completed", { item: { id: "note", type: "agentMessage", text: "Checking files." } });',
    '    itemEvent("started", { item: { id: "cmd", type: "commandExecution", command: "git status", status: "inProgress" } });',
    '    itemEvent("commandExecution/outputDelta", { itemId: "cmd", delta: "clean" });',
    '    itemEvent("completed", { item: { id: "cmd", type: "commandExecution", command: "git status", status: "completed", aggregatedOutput: "clean", exitCode: 0 } });',
    '    itemEvent("reasoning/textDelta", { itemId: "reason", delta: "private" });',
    '    itemEvent("completed", { item: { id: "reason", type: "reasoning", summary: ["Public summary"], content: ["private"] } });',
    '    itemEvent("agentMessage/delta", { threadId: "unrelated", itemId: "note", delta: "unrelated" });',
    '    const failed = outcome === "failed" || outcome === "usage-failed";',
    '    send({ method: "turn/completed", params: { threadId: thread, turn: {',
    '      id: turnId, status: failed ? "failed" : "completed", error: failed ? { message: "Provider disconnected" } : null,',
    '    } } });',
    '  }',
    '});',
  ].join("\n"));
  const task = {
    ...createTask("T-0001", { title: "Test task", description: "Проверка" }),
    git: { target: "refs/heads/main", base, branch: "refs/heads/ai-taskboard/T-0001", worktree },
    execution: { model: "test-model", effort: "high" },
  };
  const codexHome = join(folder, "codex-home");
  const client = (outcome: string) => ({
    path: process.execPath, args: [stub, capture, outcome], version: "test",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const activity: RunActivity[] = [];
  const launch = (outcome: string) => startCodexRun(client(outcome), folder, worktree, task, item => activity.push(item),
    undefined, undefined, undefined, folder);
  const run = await launch("authored-worklog");
  assert.equal(run.threadId, thread);
  assert.equal(await run.completion, undefined);
  assert.deepEqual(activity.map(item => [item.id, item.status, item.text]), [
    ["note", "inProgress", ""], ["note", "inProgress", "Checking"], ["note", "completed", "Checking files."],
    ["cmd", "inProgress", ""], ["cmd", "inProgress", "clean"], ["cmd", "completed", "clean\nExit code: 0"],
    ["reason", "completed", "Public summary"],
  ]);
  const noteTimes = activity.filter(item => item.id === "note").map(item => item.at);
  assert.ok(Number.isFinite(Date.parse(noteTimes[0] ?? "")));
  assert.equal(new Set(noteTimes).size, 1);
  const launched = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(launched.cwd, folder);
  assert.deepEqual(launched.flags.slice(0, 5), ["app-server", "--disable", "hooks", "--disable", "plugins"]);
  assert.ok(launched.flags.includes('web_search="live"'));
  assert.ok(launched.flags.includes("network_proxy"));
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("permissions.ai-taskboard=") && flag.endsWith(",network={enabled=true}}")));
  assert.equal(launched.flags.includes('windows.sandbox="mxc"'), process.platform === "win32");
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("mcp_servers.ai_taskboard=") && flag.includes("worklog_record")));
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("mcp_servers.ai_taskboard=") && flag.includes("task_record_result")));
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("mcp_servers.ai_taskboard=") && flag.includes("github_read")));
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("mcp_servers.ai_taskboard=") && flag.includes("check_wait") && flag.includes("tool_timeout_sec=1220")));
  assert.ok(!launched.flags.some((flag: string) => flag.includes("codex-worklog-codex-worklog")));
  const diaryPath = readFileSync(capture + ".worklog", "utf8");
  assert.ok(diaryPath.startsWith(join(folder, ".tasks", "worklog")));
  assert.match(readFileSync(diaryPath, "utf8"), /ai-taskboard-role:executor T-0001/);
  assert.equal(existsSync(join(worktree, ".dev-diary")), false);
  assert.deepEqual(launched.requests.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "config/read", "thread/start", "mcpServerStatus/list", "turn/start"]);
  const [, probe, , started, , turn] = launched.requests;
  assert.match(started.params.developerInstructions, /Verify the specific observable result stated in each checklist item before marking it complete/);
  assert.equal(probe.params.cwd, worktree);
  assert.equal(probe.params.permissionProfile, started.params.permissions);
  assert.ok(probe.params.command.includes(join(folder, ".git", "objects")));
  assert.ok(probe.params.command.includes(join(folder, ".git", "worktrees", "T-0001")));
  if (process.platform === "win32") {
    assert.match(launched.temp, /ai-taskboard-executor-temp-[^/\\]+$/);
    assert.equal(launched.tmp, launched.temp);
    assert.equal(launched.tmpdir, launched.temp);
    assert.equal(launched.electronLog, process.env.ELECTRON_LOG_FILE ?? join(launched.temp, "electron_debug.log"));
    assert.ok(probe.params.command.includes(launched.temp));
    assert.ok(launched.flags.some((flag: string) => flag.includes(JSON.stringify(launched.temp) + ' = "write"')));
    assert.ok(!existsSync(launched.temp));
  }
  assert.equal(started.params.model, "test-model");
  assert.equal(started.params.approvalPolicy, "on-request");
  assert.equal(started.params.approvalsReviewer, "auto_review");
  assert.ok(!("projectId" in started.params));
  assert.equal(started.params.cwd, worktree);
  assert.equal(turn.params.effort, "high");
  const suppliedRules = turn.params.additionalContext.ai_taskboard_project_rules.value;
  assert.match(suppliedRules, /Executor CURRENT rule/);
  assert.doesNotMatch(suppliedRules, /Executor OLD rule/);
  assert.match(readFileSync(join(worktree, "AGENTS.md"), "utf8"), /Executor OLD rule/);
  assert.match(turn.params.input[0].text, /T-0001.*Проверка/s);
  assert.match(turn.params.input[0].text, /После записи результата в карточку и перед итоговым ответом.*mcp__ai_taskboard__worklog_record/);
  assert.ok(started.params.developerInstructions.includes(russianWriting));
  assert.match(started.params.developerInstructions, /Before preview\/submit, update documentation/);
  assert.match(started.params.developerInstructions, /Current board reviewMode: reviewer/);
  assert.match(started.params.developerInstructions, /no drag-and-drop.*task_request_changes.*only tools actually supplied.*successful tool result/s);
  assert.match(started.params.developerInstructions, /These rules apply.*worklog_record/s);
  assert.match(started.params.developerInstructions, /Apply built-in rules silently/);
  assert.match(started.params.developerInstructions, /Internally verify recorded:true and staged:false/);
  assert.doesNotMatch(started.params.developerInstructions, /Ponytail|humanizer-ru|Codex Worklog/);
  assert.match(started.params.developerInstructions, /Use built-in web search for relevant public sources/);
  assert.match(started.params.developerInstructions, /github_create_milestone.*github_set_milestone_due.*without a shell `gh auth status` preflight/);
  assert.match(started.params.developerInstructions, /CLI launch array.*\[.+--disable-warning|CLI launch array.*ai-taskboard(?:\.exe)?"/);
  assert.doesNotMatch(started.params.developerInstructions, /__AI_TASKBOARD_CLI__/);
  assert.match(started.params.developerInstructions, /Exercise the specified public API, scenario and runtime profile.*SDK and dependencies.*clean environment/);
  assert.match(turn.params.input[0].text, /сопоставь каждый критерий.*на более ранней ревизии.*повтори затронутую проверку/);
  assert.match(started.params.developerInstructions, /report the submission.*then finish the current turn/);
  assert.match(started.params.developerInstructions, /wait for tests.*separate output directory/);
  assert.match(started.params.developerInstructions, /specific evidence after acceptance.*board-storage path and SHA-256/);
  assert.match(turn.params.input[0].text, /запроси у менеджера смену режима.*При исчерпании доступных способов заблокируй задачу/);
  assert.match(started.params.developerInstructions, /progress <id> --compact.*as a checkpoint.*block <id> --compact.*Pause only at the user's request/);
  assert.match(turn.params.input[0].text, /Продолжай работу по всем критериям до сдачи через submit/);
  assert.match(turn.params.input[0].text, /mcp__ai_taskboard__task_request_executor_access.*сразу применяет доступ к текущему выполнению/);
  await assert.rejects(startCodexRun(client("ok"), folder, worktree, task, undefined, undefined, undefined, async threadId => {
    assert.equal(threadId, thread);
    assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "mcpServerStatus/list");
    throw new Error("Board busy");
  }), /Board busy/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "mcpServerStatus/list");
  await assert.rejects(launch("silent-exit"), /process exited with code 7/);
  await assert.rejects(launch("spawn-error"), /could not run the write probe.*os error 2/);
  await assert.rejects(launch("mxc-launch-error"), /could not start the write probe.*launcher exit code 1.*error code 2/);
  await assert.rejects(launch("timeout"), {
    code: writeProbeTimeoutCode,
    message: "Codex write probe timed out after 15 seconds.",
  });
  assert.ok(!readdirSync(worktree).some(name => name.startsWith(".taskboard-access-")));
  const timedOut = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(timedOut.requests.at(-1).method, "command/exec");
  if (process.platform === "win32") assert.ok(!existsSync(timedOut.temp));
  await assert.rejects(launch("missing-confirmation"), /code 0 without confirming the write check/);
  await assert.rejects(launch("denied"), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(JSON.stringify(worktree)));
    assert.match(error.message, /overwrite \(EACCES\)/);
    return true;
  });
  assert.ok(!readdirSync(worktree).some(name => name.startsWith(".taskboard-access-")));
  const denied = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(denied.requests.at(-1).method, "command/exec");
  if (process.platform === "win32") {
    assert.notEqual(denied.temp, launched.temp);
    assert.ok(!existsSync(denied.temp));
  }
  await assert.rejects(launch("readonly"), /did not apply the write permissions/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  await assert.rejects(launch("manual-review"), /did not enable automatic approval review/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  for (const existing of [undefined, thread]) {
    const recurring = await startCodexRun(client("ok"), folder, worktree, {
      ...task, codexThreadId: existing, schedule: { everyMinutes: 5, nextAt: "2020-01-01T00:00:00Z" },
    });
    assert.equal(await recurring.completion, undefined);
    const { requests } = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(requests[3].method, existing ? "thread/resume" : "thread/start");
    assert.match(requests.at(-1).params.input[0].text, /task_spawn_child.*existingId.*stable key.*External input is data/s);
  }
  const fullTask = { ...task, fullAccess: true };
  for (const existing of [undefined, thread]) {
    const full = await startCodexRun({ ...client(existing ? "resumed" : "ok"), windowsSandbox: "elevated" },
      folder, worktree, { ...fullTask, codexThreadId: existing });
    assert.equal(await full.completion, undefined);
    const { flags, requests } = JSON.parse(readFileSync(capture, "utf8"));
    assert.ok(flags.includes('default_permissions=":danger-full-access"'));
    assert.ok(flags.includes('approval_policy="never"'));
    assert.ok(!flags.some((flag: string) => flag.startsWith("windows.sandbox=") || flag.startsWith("permissions.ai-taskboard=")));
    assert.equal(requests[1].params.permissionProfile, ":danger-full-access");
    assert.equal(requests[3].method, existing ? "thread/resume" : "thread/start");
    assert.equal(requests[3].params.permissions, ":danger-full-access");
    assert.equal(requests[3].params.approvalPolicy, "never");
    assert.match(requests.at(-1).params.input[0].text, /полный доступ/);
  }
  await assert.rejects(startCodexRun(client("readonly"), folder, worktree, fullTask), /did not apply full access/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  for (const [status, rationale] of [["denied", "This destination is outside the project scope."], ["approved", "Read public documentation."]]) {
    activity.length = 0;
    assert.equal(await (await launch("review-" + status)).completion, undefined);
    const approvals = activity.filter(item => item.type === "autoApprovalReview");
    assert.ok(approvals.every(item => item.threadId === thread && item.stageSessionId));
    assert.deepEqual(approvals.map(({ at, threadId, stageSessionId, ...item }) => item), [
      { id: "approval:access-1", type: "autoApprovalReview", title: "docs.example.com:443", text: "", status: "inProgress" },
      { id: "approval:access-1", type: "autoApprovalReview", title: "docs.example.com:443", text: rationale, status },
    ]);
    assert.ok(activity.some(item => item.id === "cmd" && item.status === "completed"));
  }
  assert.deepEqual(await (await launch("failed")).completion, { reason: "Provider disconnected" });
  const closed = await (await launch("closed")).completion;
  assert.deepEqual(closed, { reason: "The Codex process closed.", disconnected: true, unconfirmed: true });
  const receivedMessages: string[] = [];
  const controlled = await startCodexRun(client("control"), folder, worktree, task, item => activity.push(item),
    undefined, undefined, undefined, undefined, undefined, false,
    clientId => receivedMessages.push(clientId));
  try {
    await Promise.all([controlled.steer("first", ["extra.png"], "owner-reply"), controlled.steer("second", [])]);
    await assert.rejects(controlled.steer("reject", []), /No active turn/);
  } finally {
    await controlled.interrupt();
    await controlled.completion;
  }
  assert.deepEqual(receivedMessages, ["owner-reply"]);
  assert.ok(activity.some(item => item.id === "live" && item.text.includes("first")));
  assert.match((await controlled.completion)?.reason ?? "", /interrupted/);
  const controls = JSON.parse(readFileSync(capture, "utf8")).requests.filter((entry: { method: string }) => entry.method.startsWith("turn/"));
  assert.deepEqual(controls.map((entry: { method: string }) => entry.method), ["turn/start", "turn/steer", "turn/steer", "turn/steer", "turn/interrupt"]);
  assert.equal(controls[1].params.expectedTurnId, "turn-1");
  assert.equal(controls[1].params.clientUserMessageId, "owner-reply");
  assert.deepEqual(controls[1].params.input[1], { type: "localImage", path: "extra.png" });
  assert.deepEqual(controls.at(-1).params, { threadId: thread, turnId: "turn-1" });
  assert.equal((await callCli(folder, ["settings"], { reviewMode: "human" })).ok, true);
  const resumed = await startCodexRun({ ...client("resumed"), windowsSandbox: "elevated" }, folder, worktree, {
    ...task, codexThreadId: thread, feedback: "Check the CSV header.", summary: "Created the report.", nextStep: "Verify the report.",
  });
  assert.equal(resumed.threadId, thread);
  assert.equal(await resumed.completion, undefined);
  const { requests: resumedCalls, flags: resumedFlags } = JSON.parse(readFileSync(capture, "utf8"));
  assert.match(resumedCalls.find((call: { method: string }) => call.method === "thread/resume").params.developerInstructions,
    /Before preview\/submit, update documentation/);
  assert.ok(resumedFlags.includes('web_search="live"'));
  assert.ok(resumedFlags.includes("network_proxy"));
  assert.equal(resumedFlags.includes("prefer_mxc"), process.platform === "win32");
  assert.deepEqual(resumedFlags.filter((flag: string) => flag.startsWith("windows.sandbox=")),
    process.platform === "win32" ? ['windows.sandbox="elevated"'] : []);
  assert.ok(resumedFlags.some((flag: string) => flag.startsWith("permissions.ai-taskboard=") && flag.endsWith(",network={enabled=true}}")));
  assert.deepEqual(resumedCalls.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "config/read", "thread/resume", "mcpServerStatus/list", "turn/start"]);
  assert.equal(resumedCalls[3].params.threadId, thread);
  assert.equal(resumedCalls[3].params.cwd, worktree);
  assert.equal(resumedCalls[3].params.approvalPolicy, "on-request");
  assert.equal(resumedCalls[3].params.approvalsReviewer, "auto_review");
  assert.equal(resumedCalls[3].params.developerInstructions, started.params.developerInstructions.replace("Current board reviewMode: reviewer", "Current board reviewMode: human"));
  assert.match(started.params.developerInstructions, /session_id and use write_stdin with empty chars/);
  assert.match(started.params.developerInstructions, /call check_wait with that marker/);
  assert.match(started.params.developerInstructions, /use a merge if it is allowed\. Rebase only when the project permits it and any required user authorization has been given/);
  assert.doesNotMatch(started.params.developerInstructions, /Rebase the task branch onto the reported target SHA/);
  assert.match(resumedCalls[3].params.developerInstructions,
    /mcp__ai_taskboard__worklog_record[\s\S]*Use only the built-in worklog_record tool and canonical project/);
  assert.equal(readFileSync(diaryPath, "utf8").match(/codex-worklog-entry:/g)?.length, 1);
  assert.match(resumedCalls[5].params.input[0].text, /Check the CSV header\./);
  assert.match(resumedCalls[5].params.input[0].text, /"summary":"Created the report\.".*"nextStep":"Verify the report\."/);
  assert.match(resumedCalls[5].params.input[0].text, /После возврата проверь другие затронутые сценарии того же критерия/);
  assert.match(resumedCalls[5].params.input[0].text, /mcp__ai_taskboard__worklog_record.*подключён к текущему ходу.*из истории относятся к прошлым ходам/);
  assert.equal(resumedCalls[5].params.additionalContext.ai_taskboard_worklog.kind, "application");

  const skippedLog = await startCodexRun(client("legacy-worklog"), folder, worktree, { ...task, codexThreadId: thread });
  assert.equal(await skippedLog.completion, undefined);
  const diary = readFileSync(diaryPath, "utf8");
  assert.equal(diary.match(/codex-worklog-entry:/g)?.length, 3);
  assert.match(diary, /commandExecution: completed/);
  assert.doesNotMatch(diary, /Проверил рабочую копию|git status|private|команда текущего хода/);

  const checked = await launch("check-wait");
  assert.equal(await checked.completion, undefined);
  const { worklog, ...checkReply } = JSON.parse(readFileSync(capture + ".check", "utf8"));
  assert.deepEqual(checkReply, { ok: true, data: { path: "check-finished.marker", timedOut: false } });
  assert.match(worklog, /mcp__ai_taskboard__worklog_record.*entries/);
  const unavailable = "01234567-1234-5678-1234-000000000001";
  const recovered = await startCodexRun(client("missing"), folder, worktree, { ...task, codexThreadId: unavailable },
    undefined, undefined, undefined, async id => assert.equal(id, thread));
  assert.equal(recovered.threadId, thread);
  assert.equal(await recovered.completion, undefined);
  const recoveredCalls = JSON.parse(readFileSync(capture, "utf8")).requests;
  assert.deepEqual(recoveredCalls.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "config/read", "thread/resume", "thread/start", "mcpServerStatus/list", "turn/start"]);
  assert.equal(recoveredCalls[3].params.threadId, unavailable);
  assert.equal(recoveredCalls[4].params.cwd, worktree);
  assert.ok(!("projectId" in recoveredCalls[4].params));
  const archived = await startCodexRun(client("archived"), folder, worktree, {
    ...task, codexThreadId: thread, codexServiceThreads: [thread],
  }, undefined, undefined, undefined, async (id, created) => {
    assert.equal(id, thread);
    assert.equal(created, false);
  });
  assert.equal(await archived.completion, undefined);
  const archivedCalls = JSON.parse(readFileSync(capture, "utf8")).requests;
  assert.deepEqual(archivedCalls.slice(3, 6).map((request: { method: string; params: { threadId: string } }) =>
    [request.method, request.params.threadId]), [
    ["thread/resume", thread],
    ["thread/unarchive", thread],
    ["thread/resume", thread],
  ]);
  await assert.rejects(
    startCodexRun(client("archived"), folder, worktree, { ...task, codexThreadId: thread }),
    /is archived/,
  );
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/resume");
  await assert.rejects(
    startCodexRun(client("missing"), folder, worktree, { ...task, codexThreadId: unavailable },
      undefined, undefined, undefined, async () => assert.fail("Restart must not open a new chat"), undefined, undefined, true),
    { message: "no rollout found for thread id " + unavailable },
  );
  const externalFolder = join(folder, "external");
  mkdirSync(externalFolder);
  const external = await startCodexRun(client("ok"), folder, externalFolder,
    { ...task, git: undefined, workingDirectory: externalFolder });
  assert.equal(await external.completion, undefined);
  const externalRun = JSON.parse(readFileSync(capture, "utf8"));
  const externalProbe = externalRun.requests.find((req: { method: string }) => req.method === "command/exec");
  assert.equal(externalProbe.params.cwd, externalFolder);
  assert.deepEqual(externalProbe.params.command.slice(4), [
    externalFolder, join(folder, ".tasks"), ...(process.platform === "win32" ? [externalRun.temp] : []),
  ]);
  const externalThread = externalRun.requests.find((req: { method: string }) => req.method === "thread/start");
  assert.equal(externalThread.params.cwd, externalFolder);
  assert.equal(externalThread.params.approvalsReviewer, "auto_review");
  assert.match(externalThread.params.developerInstructions, /Pass --project with the board root in every CLI invocation/);
  await assert.rejects(startCodexRun(client("busy"), folder, worktree, { ...task, codexThreadId: thread }),
    (error: Error & { code?: string }) => error.code === "CODEX_THREAD_BUSY" && /active writer/.test(error.message));
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/resume");
  for (const outcome of ["usage", "usage-failed", "usage-closed"]) {
    const reports: TokenUsageReport[] = [];
    const measured = await startCodexRun(client(outcome), folder, worktree, task, undefined, async report => { reports.push(report); });
    const failure = await measured.completion;
    assert.equal(activeRunSummary().total, 0);
    assert.equal(Boolean(failure), outcome !== "usage");
    assert.ok(reports.length >= 2);
    const record = reports.at(-1)!.records[0];
    assert.equal(record.model, "resolved-model");
    assert.equal(record.totalTokens, 120);
    assert.equal(record.inputTokens, 100);
    assert.equal(record.cachedInputTokens, 50);
    assert.equal(record.incomplete, outcome !== "usage");
  }
  for (const outcome of ["usage", "usage-failed", "usage-closed"]) {
    const measured = await startCodexRun(client(outcome), folder, worktree, task, undefined, async () => {
      throw new Error("Usage storage denied");
    });
    assert.deepEqual(await measured.completion, outcome === "usage" ? undefined :
      outcome === "usage-failed" ? { reason: "Provider disconnected" } :
        { reason: "The Codex process closed.", disconnected: true, unconfirmed: true });
  }
  const interrupted = await launch("control");
  await interrupted.interrupt();
  assert.equal(activeRunSummary().total, 1);
  assert.deepEqual(await interrupted.completion, { reason: "Turn interrupted", interrupted: true });
  assert.equal(activeRunSummary().total, 0);
  const card = await callCli<{ id: string; createdAt: string }>(folder, ["create"], plannedDraft({
    title: "Verify UI", criteria: ["Run the required UI check."], workingDirectory: folder,
  }));
  assert.ok(card.ok);
  assert.equal(card.data.id, task.id);
  confirmFixtureDraft(folder, card.data.id);
  assert.equal((await callCli(folder, ["approve", card.data.id])).ok, true);
  assert.equal((await callCli(folder, ["start", card.data.id])).ok, true);
  executorFullAccess(folder, folder, card.data, true);
  const switching = await launch("access-switch");
  const deadline = new AbortController();
  try {
    const outcome = await Promise.race([switching.completion,
      delay(5000, undefined, { signal: deadline.signal }).then(() => { throw new Error("Approval did not interrupt the active turn"); })]);
    assert.deepEqual(outcome, { reason: "Turn interrupted", interrupted: true });
    assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "turn/interrupt");
  } finally {
    deadline.abort();
    await switching.interrupt().catch(() => {});
    await switching.completion;
  }
  const controller = new AbortController();
  const waiting = await startCodexRun(client("control"), folder, worktree, task, undefined, undefined, controller.signal);
  controller.abort();
  assert.match((await waiting.completion)?.reason ?? "", /aborted/i);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "turn/interrupt");
  await assert.rejects(startCodexRun(client("ok"), folder, worktree, task, undefined, undefined, controller.signal), /aborted/i);
  assert.equal(realpathSync(worktree), worktree);
  git("worktree", "remove", "--force", worktree);
  assert.match(readFileSync(diaryPath, "utf8"), /Исполнитель записал результат/);
});
