import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Exercise the real Electron IPC, board CLI, scheduler and App Server protocol on isolated cards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "discussion-return", 150_000);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const node = process.env.TASKBOARD_CHECK_NODE;
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const reason = "Включить решётку и номер задачи в одну гиперссылку с общим подчёркиванием.";
const log = join(scratch, "provider.jsonl");
const unblock = join(scratch, "finish-discussion");
const timeout = setTimeout(() => app.exit(1), 140_000);
const summary = [];
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", ({ message, level }) => { if (level === "error") console.error(message); });
  contents.on("preload-error", (_event, _path, error) => console.error(error));
});
process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
const cli = (command, id, input) => {
  const args = [cliPath, "--project", project, "--json", command, ...(id ? [id] : []), ...(input ? ["--stdin"] : [])];
  return JSON.parse(execFileSync(node, args, { encoding: "utf8", windowsHide: true,
    input: input && JSON.stringify(input), env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch,
      NODE_NO_WARNINGS: "1" } })).data;
};
async function waitFor(read, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw Error("Timed out: " + description);
}
const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];

try {
  mkdirSync(project);
  mkdirSync(profile);
  app.setPath("userData", profile);
  app.setPath("appData", scratch);
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { windowsHide: true });
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "--no-gpg-sign", "-m", "Fixture base");
  cli("init", null, { git: false });
  cli("settings", null, { reviewMode: "human", autoMode: false, taskLimits: { executor: 1, reviewer: 1 } });
  const cases = [false, true].map(occupied => {
    const cwd = join(project, occupied ? "occupied" : "free");
    mkdirSync(cwd);
    const { id } = cli("create", null, plannedDraft({ title: "Link includes #", criteria: ["One link includes the # and ID"], workingDirectory: cwd }));
    confirmFixtureDraft(project, id);
    cli("approve", id);
    cli("start", id);
    const { token } = cli("preview", id);
    cli("submit", id, { token, noChanges: true, summary: "Initial link", checks: ["Fixture"] });
    return { id, cwd, occupied };
  });
  const { id: unavailableId } = cli("create", null, plannedDraft({ title: "Link includes #, unavailable worktree", criteria: ["One link includes the # and ID"] }));
  confirmFixtureDraft(project, unavailableId);
  cli("approve", unavailableId);
  const { worktree } = cli("start", unavailableId);
  const { token } = cli("preview", unavailableId);
  cli("submit", unavailableId, { token, noChanges: true, summary: "Initial link", checks: ["Fixture"] });
  cases.push({ id: unavailableId, cwd: worktree, unavailable: true });

  const stub = join(scratch, "app-server.cjs");
  writeFileSync(stub, `
const fs = require("node:fs");
const readline = require("node:readline");
const [role, log, unblock, reason, ...flags] = process.argv.slice(2);
const send = value => console.log(JSON.stringify(value));
const record = value => fs.appendFileSync(log, JSON.stringify(value) + "\\n");
let threadId = "81234567-1234-5678-1234-123456789012", cwd, text;
const finish = status => send({ method: "turn/completed", params: { threadId, turn: { id: "turn", status } } });
readline.createInterface({ input: process.stdin }).on("close", () => process.exit(0)).on("line", async line => {
  const { id, method, params, result: tool } = JSON.parse(line);
  if (id === "return") {
    record({ tool });
    const timer = setInterval(() => {
      if (!fs.existsSync(unblock)) return;
      clearInterval(timer);
      send({ method: "item/completed", params: { threadId, turnId: "turn", item: { id: "reply", type: "agentMessage", phase: "final_answer", text: "Карточка возвращена." } } });
      finish("completed");
    }, 100);
    return;
  }
  if (id === undefined) return;
  if (role === "executor") record({ executorMethod: method });
  let result = {};
  if (method === "model/list") result = { data: [{ model: "test", defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null };
  if (method === "thread/start" || method === "thread/resume") {
    cwd = params.cwd;
    threadId = params.threadId ?? threadId;
    if (role === "discussion") record({ tools: params.dynamicTools.map(tool => tool.name) });
    result = { thread: { id: threadId }, approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer, activePermissionProfile: { id: params.permissions } };
  }
  if (method === "config/read") result = { config: { mcp_servers: { ai_taskboard: { url: "http://127.0.0.1/mcp" } } } };
  if (method === "command/exec") result = { exitCode: 0 };
  if (method === "mcpServerStatus/list") {
    const flag = flags.find(value => value.includes("ai_taskboard") && value.includes("http"));
    const url = flag?.match(/http[^"]+/)?.[0];
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const { tools } = (await response.json()).result;
    result = { data: [{ name: "ai_taskboard", tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] };
  }
  if (method === "turn/start") {
    text = params.input.map(entry => entry.text ?? "").join("\\n");
    result = { turn: { id: "turn", status: "inProgress" } };
  }
  send({ id, result });
  if (method !== "turn/start") return;
  if (role === "discussion") {
    record({ userMessage: text });
    send({ id: "return", method: "item/tool/call", params: { threadId, turnId: "turn", callId: "changes",
      tool: "task_request_changes", arguments: { reason } } });
  } else {
    record({ cwd, executorInput: text });
    // The test ends after delivery; stop the fixture without triggering the normal retry for unfinished work.
    setTimeout(() => finish("interrupted"), 1000);
  }
});
`);
  const client = role => ({ path: node, args: [stub, role, log, unblock, reason] });
  globalThis.discussionCheckClient = client;
  function instrument(file, name, edit) {
    const url = new URL("../src/desktop/" + file, import.meta.url);
    const entry = join(scratch, name);
    let source = edit(readFileSync(url, "utf8"));
    source = source.replaceAll("import.meta.url", JSON.stringify(url.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
    writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm" }).code);
    return pathToFileURL(entry).href;
  }
  const chat = instrument("codex-chat.ts", "chat.mjs", source => source
    .replace("import { configuredCodex,", "import {")
    .concat('\nconst configuredCodex = async () => globalThis.discussionCheckClient("discussion");'));
  const main = instrument("main.ts", "main.mjs", source => source
    .replace("codexStatus, configuredCodex,", "codexStatus,")
    .replace("import { callCli,", "import { callCli as realCallCli,")
    .replace('from "./codex-chat.ts"', "from " + JSON.stringify(chat))
    .concat(`\nconst configuredCodex = async () => globalThis.discussionCheckClient("executor");
const callCli = async (project, args, input) => {
  if (args[0] !== "start" || input?.discussionReturn === undefined) return realCallCli(project, args, input);
  globalThis.discussionCheckBeforeStart?.(args[1]);
  const result = await realCallCli(project, args, input);
  globalThis.discussionCheckStartResult(args[1], result);
  return result;
};
globalThis.discussionCheck = { createWindow, reserveAgent, scheduleAgentWork, subscriptions, activeAgents };`));
  process.argv.push("--project", project);
  require(fileURLToPath(main));
  void app.whenReady().then(() => run(cases)).catch(fail);
} catch (error) {
  fail(error);
}

async function run(cases) {
  const qa = globalThis.discussionCheck;
  const starts = [];
  globalThis.discussionCheckStartResult = (id, result) => starts.push({ id, code: result.ok ? "OK" : result.error.code });
  if (!BrowserWindow.getAllWindows().length) qa.createWindow([project]);
  const win = await waitFor(async () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.webContents.isLoadingMainFrame()) return false;
    const frame = await window.webContents.executeJavaScript("window.taskboard?.bootstrap()");
    if (!frame?.loading && !frame?.board) throw Error("Board did not open: " + JSON.stringify({ project: frame?.project, error: frame?.error, url: window.webContents.getURL() }));
    return frame?.board && !frame.loading && window;
  }, "board window");
  const userText = "Решётка должна быть частью гиперссылки.";
  for (const { id, cwd, occupied, unavailable } of cases) {
    const baseline = events().filter(event => event.executorInput).length;
    const lease = occupied ? await waitFor(() => qa.reserveAgent(project, "executor", "other-work"), "fixture executor slot") : undefined;
    rmSync(unblock, { force: true });
    const previousCalls = events().filter(event => event.tool).length;
    const operation = win.webContents.executeJavaScript("window.taskboard.chatSend(" +
      JSON.stringify(id) + "," + JSON.stringify({ text: userText, files: [], model: "test", effort: "low" }) + ")");
    const result = await Promise.race([
      waitFor(() => events().filter(event => event.tool)[previousCalls], "tool result for " + id),
      operation.then(reply => { throw Error("Chat ended before the tool result: " + JSON.stringify(reply)); }),
    ]);
    assert.equal(result.tool.success, true, JSON.stringify(result.tool));
    const receipt = JSON.parse(result.tool.contentItems[0].text).data;
    assert.equal(receipt.id, id);
    assert.equal(receipt.feedback, reason);
    assert.equal(receipt.executorState, "waiting_for_discussion");
    const queued = cli("show", id);
    assert.equal(queued.status, "in_progress");
    assert.equal(queued.discussionReturn, receipt.revision);
    assert.equal(events().filter(event => event.executorInput).length, baseline);
    if (unavailable) {
      const moved = join(scratch, "unavailable-worktree");
      renameSync(cwd, moved); // Leave the old path registered in Git.
      try {
        writeFileSync(unblock, "");
        assert.equal((await operation).result.ok, true);
        const blocked = await waitFor(async () => {
          const frame = await win.webContents.executeJavaScript("window.taskboard.bootstrap()");
          const card = frame.board?.tasks.find(task => task.id === id);
          if (card?.status !== "blocked") return false;
          assert.equal(frame.waitingTasks.includes(id), false);
          return card;
        }, "worktree failure visible in the card");
        assert.match(blocked.blocked.reason, /WORKTREE_MISSING/);
        assert.equal(blocked.discussionReturn, undefined);
        const task = cli("show", id);
        assert.equal(task.history.filter(event => event.action === "request-changes" && event.text === reason).length, 1);
        for (let i = 0; i < 3; i++) { qa.scheduleAgentWork(); await delay(500); }
        assert.deepEqual(starts.filter(start => start.id === id).map(start => start.code), ["WORKTREE_MISSING"]);
        assert.equal(events().filter(event => event.executorInput).length, baseline);
        summary.push("Unavailable registered Git worktree: tool confirmed the return; the card showed WORKTREE_MISSING, left the queue and retained the feedback; no retry or executor turn.");
      } finally {
        renameSync(moved, cwd);
      }
      continue;
    }
    writeFileSync(unblock, "");
    assert.equal((await operation).result.ok, true);
    if (occupied) {
      await waitFor(async () => (await win.webContents.executeJavaScript("window.taskboard.bootstrap()")).waitingTasks.includes(id), "queued card");
      assert.equal(events().filter(event => event.executorInput).length, baseline);
      globalThis.discussionCheckBeforeStart = taskId => {
        assert.equal(taskId, id);
        globalThis.discussionCheckBeforeStart = undefined;
        cli("comment", id, { text: "Advance the revision just before the first start" });
      };
      lease();
      qa.scheduleAgentWork();
    }
    const run = await waitFor(() => events().find(event => event.cwd === cwd && event.executorInput), "executor input");
    assert.ok(run.executorInput.includes(reason), run.executorInput);
    const task = cli("show", id);
    assert.equal(task.workingDirectory, cwd);
    assert.equal(task.discussionReturn, undefined);
    assert.equal(task.history.filter(event => event.action === "request-changes" && event.text === reason).length, 1);
    assert.equal(task.history.filter(event => event.action === "start").length, 2);
    await waitFor(() => !qa.activeAgents.has(project + "\0" + id), "executor settled");
    assert.equal(events().filter(event => event.cwd === cwd && event.executorInput).length, 1);
    assert.deepEqual(starts.filter(start => start.id === id).map(start => start.code), occupied ? ["REVISION_CONFLICT", "OK"] : ["OK"]);
    summary.push((occupied ? "Occupied" : "Free") + " slot: tool confirmed one return; one executor turn received exact feedback.");
    if (occupied) summary.push("The first start hit REVISION_CONFLICT; the saved return was retried with the current revision.");
  }
  writeFileSync(join(artifacts, "discussion-return.txt"), [
    `Node ${process.versions.node}, Electron ${process.versions.electron}, ${process.platform} ${process.arch}`,
    "node scripts/check-discussion-return.mjs --artifacts .tasks/qa", ...summary,
  ].join("\n") + "\n");
  console.log(summary.join("\n"));
  clearTimeout(timeout);
  for (const watch of qa.subscriptions.values()) watch.stop();
  app.exit(0);
}

function fail(error) {
  clearTimeout(timeout);
  console.error(error);
  if (existsSync(log)) {
    console.error(events().map(({ executorMethod, tool }) => executorMethod ?? (tool ? JSON.stringify(tool) : undefined)).filter(Boolean));
    console.error(cli("list").tasks.map(({ id, status, revision, discussionReturn, blocked }) => ({ id, status, revision, discussionReturn, blocked })));
  }
  app.exit(1);
}
