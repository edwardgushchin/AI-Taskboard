import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startCodexRun } from "../src/desktop/codex-run.ts";
import { createTask } from "../src/cli/tasks.ts";
import type { RunActivity } from "../src/cli/model.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";

test("the Codex launch probes access, applies settings, and monitors the turn", async t => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ai-taskboard-codex-run-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const worktree = join(folder, ".tasks", "worktrees", "T-0001");
  mkdirSync(join(folder, ".tasks", "worktrees"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "--no-gpg-sign", "-m", "Initial");
  const base = git("rev-parse", "HEAD");
  git("worktree", "add", "-b", "ai-taskboard/T-0001", worktree);
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
    '  fs.writeFileSync(capture, JSON.stringify({ cwd: process.cwd(), flags, requests }));',
    '  let result = {};',
    '  if (method === "command/exec") {',
    '    result = outcome === "denied" ? { exitCode: 1, stderr: "EACCES: permission denied" } : { exitCode: 0 };',
    '  } else if (method === "project/list") {',
    '    result = { data: [{ id: "board-project", roots: [{ path: require("node:path").dirname(capture) }] }], nextCursor: null };',
    '  } else if (method === "thread/start" || method === "thread/resume") {',
    '    if (outcome === "busy") { send({ id, error: { message: "thread " + thread + " already has an active writer" } }); return; }',
    '    result = { model: "resolved-model", thread: { id: params.threadId ?? thread, projectId: outcome === "wrong-project" ? null : params.projectId },',
    '      approvalPolicy: params.approvalPolicy, approvalsReviewer: outcome === "manual-review" ? "user" : params.approvalsReviewer,',
    '      activePermissionProfile: { id: outcome === "readonly" ? ":read-only" : params.permissions } };',
    '  } else if (method === "turn/start") {',
    '    result = { turn: { id: "turn-1", status: "inProgress" } };',
    '  }',
    '  if (method === "turn/steer") {',
    '    send({ method: "item/agentMessage/delta", params: { threadId: thread, itemId: "live", delta: params.input[0].text } });',
    '    if (params.input[0].text === "reject") { send({ id, error: { message: "No active turn" } }); return; }',
    '    setTimeout(() => send({ id, result: { turnId: params.expectedTurnId } }), params.input[0].text === "first" ? 20 : 0); return;',
    '  }',
    '  send({ id, result });',
    '  if (method === "turn/interrupt") send({ method: "turn/completed", params: { threadId: thread, turn: { id: params.turnId, status: "interrupted" } } });',

    '  if (method === "turn/start") {',
    '    if (outcome === "check-wait") {',
    '      const url = flags.find(flag => flag.startsWith("mcp_servers=")).match(/http[^\"]+/)[0];',
    '      const headers = { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN };',
    '      const cwd = requests.find(request => request.method === "thread/start" || request.method === "thread/resume").params.cwd;',
    '      setTimeout(() => fs.writeFileSync(require("node:path").join(cwd, "check-finished.marker"), ""), 30);',
    '      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",',
    '        params: { name: "check_wait", arguments: { path: "check-finished.marker", timeoutSeconds: 3 } } }) });',
    '      fs.writeFileSync(capture + ".check", (await response.json()).result.content[0].text);',
    '    }',
    '    if (outcome === "control") return;',
    '    if (outcome === "closed") { process.stdin.destroy(); return; }',
    '    if (outcome.startsWith("usage")) {',
    '      send({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-1" } } });',
    '      const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10 };',
    '      send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "turn-1", tokenUsage: { total: counts, last: counts } } });',
    '      if (outcome === "usage-closed") { process.stdin.destroy(); return; }',
    '    }',
    '    const itemEvent = (method, params) => send({ method: "item/" + method, params: { threadId: thread, ...params } });',
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
    '      id: "turn-1", status: failed ? "failed" : "completed", error: failed ? { message: "Provider disconnected" } : null,',
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
  const launch = (outcome: string) => startCodexRun(client(outcome), folder, worktree, task, item => activity.push(item));
  const run = await launch("ok");
  assert.equal(run.threadId, thread);
  assert.equal(await run.completion, undefined);
  assert.deepEqual(activity.map(item => [item.id, item.status, item.text]), [
    ["note", "inProgress", ""], ["note", "inProgress", "Checking"], ["note", "completed", "Checking files."],
    ["cmd", "inProgress", ""], ["cmd", "inProgress", "clean"], ["cmd", "completed", "clean\nExit code: 0"],
    ["reason", "completed", "Public summary"],
  ]);
  const launched = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(launched.cwd, folder);
  assert.equal(launched.flags[0], "app-server");
  assert.ok(launched.flags.some((flag: string) => flag.startsWith("mcp_servers=") && flag.includes("check_wait") && flag.includes("tool_timeout_sec=320")));
  assert.equal(launched.flags.includes('windows.sandbox="mxc"'), process.platform === "win32");
  const worklogData = join(codexHome, "plugins", "data", "codex-worklog-codex-worklog");
  const permissionsFlag = launched.flags.find((flag: string) => flag.startsWith("permissions."));
  assert.ok(permissionsFlag.includes(JSON.stringify(join(worklogData, "sessions-v2")) + ' = "write"'));
  assert.ok(!permissionsFlag.includes(JSON.stringify(worklogData) + ' = "write"'));
  assert.deepEqual(launched.requests.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "project/list", "thread/start", "turn/start"]);
  const [, probe, , started, turn] = launched.requests;
  assert.equal(probe.params.cwd, worktree);
  assert.equal(probe.params.permissionProfile, started.params.permissions);
  assert.ok(probe.params.command.includes(join(folder, ".git", "objects")));
  assert.ok(probe.params.command.includes(join(folder, ".git", "worktrees", "T-0001")));
  assert.equal(started.params.model, "test-model");
  assert.equal(started.params.approvalPolicy, "on-request");
  assert.equal(started.params.approvalsReviewer, "auto_review");
  assert.equal(started.params.projectId, "board-project");
  assert.equal(started.params.cwd, worktree);
  assert.equal(turn.params.effort, "high");
  assert.match(turn.params.input[0].text, /call check_wait with that marker/);
  assert.match(turn.params.input[0].text, /T-0001.*Проверка/s);
  assert.match(turn.params.input[0].text, /обязательный шаг, заблокируй задачу/);
  await assert.rejects(launch("denied"), /Codex cannot write.*EACCES/s);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "command/exec");
  await assert.rejects(launch("readonly"), /did not apply the write permissions/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  await assert.rejects(launch("wrong-project"), /did not attach the task chat/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  await assert.rejects(launch("manual-review"), /did not enable automatic approval review/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  for (const [status, rationale] of [["denied", "This destination is outside the project scope."], ["approved", "Read public documentation."]]) {
    activity.length = 0;
    assert.equal(await (await launch("review-" + status)).completion, undefined);
    assert.deepEqual(activity.filter(item => item.type === "autoApprovalReview"), [
      { id: "approval:access-1", type: "autoApprovalReview", title: "docs.example.com:443", text: "", status: "inProgress" },
      { id: "approval:access-1", type: "autoApprovalReview", title: "docs.example.com:443", text: rationale, status },
    ]);
    assert.ok(activity.some(item => item.id === "cmd" && item.status === "completed"));
  }
  assert.equal(await (await launch("failed")).completion, "Provider disconnected");
  assert.match((await (await launch("closed")).completion) ?? "", /Codex process closed/);
  const controlled = await launch("control");
  await Promise.all([controlled.steer("first", ["extra.png"]), controlled.steer("second", [])]);
  await assert.rejects(controlled.steer("reject", []), /No active turn/);
  assert.ok(activity.some(item => item.id === "live" && item.text.includes("first")));
  await controlled.interrupt();
  assert.match((await controlled.completion) ?? "", /interrupted/);
  const controls = JSON.parse(readFileSync(capture, "utf8")).requests.filter((entry: { method: string }) => entry.method.startsWith("turn/"));
  assert.deepEqual(controls.map((entry: { method: string }) => entry.method), ["turn/start", "turn/steer", "turn/steer", "turn/steer", "turn/interrupt"]);
  assert.equal(controls[1].params.expectedTurnId, "turn-1");
  assert.deepEqual(controls[1].params.input[1], { type: "localImage", path: "extra.png" });
  assert.deepEqual(controls.at(-1).params, { threadId: thread, turnId: "turn-1" });
  const resumed = await startCodexRun(client("ok"), folder, worktree, { ...task, codexThreadId: thread });
  assert.equal(resumed.threadId, thread);
  assert.equal(await resumed.completion, undefined);
  const resumedCalls = JSON.parse(readFileSync(capture, "utf8")).requests;
  assert.deepEqual(resumedCalls.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "thread/resume", "turn/start"]);
  assert.equal(resumedCalls[2].params.threadId, thread);
  assert.equal(resumedCalls[2].params.cwd, worktree);
  assert.equal(resumedCalls[2].params.approvalPolicy, "on-request");
  assert.equal(resumedCalls[2].params.approvalsReviewer, "auto_review");
  const checked = await launch("check-wait");
  assert.equal(await checked.completion, undefined);
  assert.deepEqual(JSON.parse(readFileSync(capture + ".check", "utf8")), {
    ok: true, data: { path: "check-finished.marker", timedOut: false },
  });
  await assert.rejects(startCodexRun(client("busy"), folder, worktree, { ...task, codexThreadId: thread }),
    (error: Error & { code?: string }) => error.code === "CODEX_THREAD_BUSY" && /active writer/.test(error.message));
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/resume");
  for (const outcome of ["usage", "usage-failed", "usage-closed"]) {
    const reports: TokenUsageReport[] = [];
    const measured = await startCodexRun(client(outcome), folder, worktree, task, undefined, async report => { reports.push(report); });
    const failure = await measured.completion;
    assert.equal(Boolean(failure), outcome !== "usage");
    assert.ok(reports.length >= 2);
    const record = reports.at(-1)!.records[0];
    assert.equal(record.model, "resolved-model");
    assert.equal(record.totalTokens, 120);
    assert.equal(record.inputTokens, 100);
    assert.equal(record.cachedInputTokens, 50);
    assert.equal(record.incomplete, outcome !== "usage");
  }
  const storageFailure = await startCodexRun(client("usage"), folder, worktree, task, undefined, async report => {
    if (report.records.some(record => record.totalTokens !== null)) throw new Error("Usage storage denied");
  });
  assert.match((await storageFailure.completion) ?? "", /Usage storage denied/);
  const controller = new AbortController();
  const waiting = await startCodexRun(client("control"), folder, worktree, task, undefined, undefined, controller.signal);
  controller.abort();
  assert.match((await waiting.completion) ?? "", /aborted/i);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "turn/interrupt");
  await assert.rejects(startCodexRun(client("ok"), folder, worktree, task, undefined, undefined, controller.signal), /aborted/i);
});
