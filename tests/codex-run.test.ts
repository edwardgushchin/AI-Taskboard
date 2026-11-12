import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startCodexRun } from "../src/desktop/codex-run.ts";
import { createTask } from "../src/cli/tasks.ts";
import type { RunActivity } from "../src/cli/model.ts";

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
    'require("node:readline").createInterface({ input: process.stdin }).on("line", line => {',
    '  const { id, method, params } = JSON.parse(line);',
    '  if (id === undefined) return;',
    '  requests.push({ method, params });',
    '  fs.writeFileSync(capture, JSON.stringify({ cwd: process.cwd(), flags, requests }));',
    '  let result = {};',
    '  if (method === "command/exec") {',
    '    result = outcome === "denied" ? { exitCode: 1, stderr: "EACCES: permission denied" } : { exitCode: 0 };',
    '  } else if (method === "project/list") {',
    '    result = { data: [{ id: "board-project", roots: [{ path: require("node:path").dirname(capture) }] }], nextCursor: null };',
    '  } else if (method === "thread/start") {',
    '    result = { thread: { id: thread, projectId: outcome === "wrong-project" ? null : params.projectId },',
    '      activePermissionProfile: { id: outcome === "readonly" ? ":read-only" : params.permissions } };',
    '  } else if (method === "turn/start") {',
    '    result = { turn: { id: "turn-1", status: "inProgress" } };',
    '  }',
    '  send({ id, result });',
    '  if (method === "turn/start") {',
    '    if (outcome === "closed") { process.stdin.destroy(); return; }',
    '    const itemEvent = (method, params) => send({ method: "item/" + method, params: { threadId: thread, ...params } });',
    '    itemEvent("started", { item: { id: "note", type: "agentMessage", text: "" } });',
    '    itemEvent("agentMessage/delta", { itemId: "note", delta: "Checking" });',
    '    itemEvent("completed", { item: { id: "note", type: "agentMessage", text: "Checking files." } });',
    '    itemEvent("started", { item: { id: "cmd", type: "commandExecution", command: "git status", status: "inProgress" } });',
    '    itemEvent("commandExecution/outputDelta", { itemId: "cmd", delta: "clean" });',
    '    itemEvent("completed", { item: { id: "cmd", type: "commandExecution", command: "git status", status: "completed", aggregatedOutput: "clean", exitCode: 0 } });',
    '    itemEvent("reasoning/textDelta", { itemId: "reason", delta: "private" });',
    '    itemEvent("completed", { item: { id: "reason", type: "reasoning", summary: ["Public summary"], content: ["private"] } });',
    '    itemEvent("agentMessage/delta", { threadId: "unrelated", itemId: "note", delta: "unrelated" });',
    '    const failed = outcome === "failed";',
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
  const client = (outcome: string) => ({ path: process.execPath, args: [stub, capture, outcome], version: "test" });
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
  assert.deepEqual(launched.requests.map((req: { method: string }) => req.method),
    ["initialize", "command/exec", "project/list", "thread/start", "turn/start"]);
  const [, probe, , started, turn] = launched.requests;
  assert.equal(probe.params.cwd, worktree);
  assert.equal(probe.params.permissionProfile, started.params.permissions);
  assert.ok(probe.params.command.includes(join(folder, ".git", "objects")));
  assert.ok(probe.params.command.includes(join(folder, ".git", "worktrees", "T-0001")));
  assert.equal(started.params.model, "test-model");
  assert.equal(started.params.projectId, "board-project");
  assert.equal(started.params.cwd, worktree);
  assert.equal(turn.params.effort, "high");
  assert.match(turn.params.input[0].text, /T-0001.*Проверка/s);
  await assert.rejects(launch("denied"), /Codex cannot write.*EACCES/s);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "command/exec");
  await assert.rejects(launch("readonly"), /did not apply the write permissions/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  await assert.rejects(launch("wrong-project"), /did not attach the task chat/);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).requests.at(-1).method, "thread/start");
  assert.equal(await (await launch("failed")).completion, "Provider disconnected");
  assert.match((await (await launch("closed")).completion) ?? "", /Codex process closed/);
});
