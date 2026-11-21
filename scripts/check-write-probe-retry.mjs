import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { executorFullAccess } from "../src/desktop/codex.ts";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { electronCheck } from "./electron-check.mjs";

const phases = [["--seed"], ["--restore"], ["--recover-turn"]];
const { scratch, artifacts } = electronCheck(import.meta.url, "write-probe-retry", 240_000, phases);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const log = join(scratch, "probe.jsonl");
const node = process.env.TASKBOARD_CHECK_NODE;
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const seed = process.argv.includes("--seed");
const recoverTurn = process.argv.includes("--recover-turn");
const turnRejection = "Fixture server declined the queued turn";
const records = () => existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  : [];
const cli = (command, id, input) => {
  const args = [cliPath, "--project", project, "--json", command, ...(id ? [id] : []), ...(input ? ["--stdin"] : [])];
  return JSON.parse(execFileSync(node, args, {
    encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })).data;
};
async function until(read, description, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await wait(50);
  }
  const sequence = records().map(event => ({
    method: event.method, card: event.cwd && event.cwd.split(/[\\/]/).at(-1), number: event.number,
  }));
  throw new Error("Timed out: " + description + "\n" + JSON.stringify(sequence));
}

const stub = `
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const [log, ...flags] = process.argv.slice(2);
const read = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").map(JSON.parse) : [];
const record = (event) => fs.appendFileSync(log, JSON.stringify({ ...event, pid: process.pid, temp: process.env.TEMP, at: Date.now() }) + "\\n");
const send = (message) => console.log(JSON.stringify(message));
let threadId;
let cwd;
require("node:readline").createInterface({ input: process.stdin })
  .on("close", () => process.exit(0))
  .on("line", async (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    if (method === "command/exec") {
      cwd = params.cwd;
      const scenario = fs.readFileSync(path.join(cwd, "scenario"), "utf8");
      const number = read().filter(item => item.method === method && item.cwd === cwd).length + 1;
      const [exe, flag, script, directory, ...roots] = params.command;
      const targets = roots.map(root => path.join(root, directory));
      record({ method, cwd, number, targets, timeoutMs: params.timeoutMs, profile: params.permissionProfile,
        permissions: flags.find(flag => flag.startsWith("permissions.")), sandbox: flags.find(flag => flag.startsWith("windows.sandbox=")) });
      if (scenario === "twice" || number === 1 && scenario !== "denied") {
        for (const target of targets) {
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "probe"), "0");
        }
        result = { exitCode: 124, stdout: "", stderr: "" };
      } else {
        const fault = scenario === "denied" ? \`
          const filesystem = require("node:fs");
          const write = filesystem.writeFileSync;
          filesystem.writeFileSync = (file, value, options) => {
            if (value === "1") throw Object.assign(new Error("denied"), { code: "EACCES" });
            return write(file, value, options);
          };
        \` : "";
        const check = spawnSync(exe, [flag, fault + script, directory, ...roots], {
          cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...params.env },
        });
        result = { exitCode: check.status, stdout: check.stdout, stderr: check.stderr };
      }
    }
    if (method === "thread/start" || method === "thread/resume") {
      cwd = params.cwd;
      const hash = createHash("sha256").update(cwd).digest("hex");
      threadId = params.threadId ?? "81234567-1234-5678-1234-" + hash.slice(0, 12);
      const scenario = fs.readFileSync(path.join(cwd, "scenario"), "utf8");
      const missing = method === "thread/resume" && scenario === "missing-chat";
      record({ method, cwd, profile: params.permissions, missing });
      if (missing) {
        send({ id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
        return;
      }
      result = { thread: { id: threadId }, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, activePermissionProfile: { id: params.permissions } };
    }
    if (method === "thread/turns/list") {
      const accepted = read().find(item => item.method === "turn/start" && item.cwd === cwd);
      const visible = Boolean(accepted && fs.existsSync(path.join(cwd, "show-history")));
      const missing = fs.readFileSync(path.join(cwd, "scenario"), "utf8") === "missing-history";
      record({ method, cwd, threadId: params.threadId, visible, missing });
      if (missing) {
        send({ id, error: { code: -32600, message: "no rollout found for thread id " + params.threadId } });
        return;
      }
      result = { data: visible ? [{
        id: "turn", status: "completed", itemsView: "full",
        items: [{ type: "userMessage", clientId: accepted.clientId }],
      }] : [] };
    }
    if (method === "config/read") {
      result = { config: { mcp_servers: { ai_taskboard: { url: "http://127.0.0.1/mcp" } } } };
    }
    if (method === "mcpServerStatus/list") {
      const flag = flags.find(value => value.includes("ai_taskboard") && value.includes("http"));
      const url = flag.match(/http[^"]+/)[0];
      const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      const { tools } = (await response.json()).result;
      result = { data: [{ name: "ai_taskboard", tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] };
    }
    if (method === "turn/start") {
      const scenario = fs.readFileSync(path.join(cwd, "scenario"), "utf8");
      record({ method, cwd, threadId, clientId: params.clientUserMessageId, rejected: scenario === "rejected" });
      if (scenario === "rejected") {
        const error = { code: -32602, message: ${JSON.stringify(turnRejection)} };
        process.stdout.write(JSON.stringify({ id, error }) + "\\n", () => process.exit(0));
        return;
      }
      if (["lost", "restart", "missing-chat", "missing-history", "revoked"].includes(scenario)) {
        process.exit(0);
      }
      result = { turn: { id: "turn", status: "inProgress" } };
    }
    send({ id, result });
    if (method === "turn/start") {
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn", status: "interrupted" } } });
    }
  });
`;

const casesPath = join(scratch, "cases.json");
const stubPath = join(scratch, "provider.cjs");
if (seed) {
  mkdirSync(project);
  mkdirSync(profile);
  cli("init", null, { git: false });
  cli("settings", null, { reviewMode: "human", autoMode: false, taskLimits: { executor: 1, reviewer: 1 } });
  const cases = Object.fromEntries([
    ["success", "Write check · waiting for automatic retry"],
    ["twice", "Write check · repeated timeout"],
    ["cancel", "Write check · cancelled retry"],
    ["denied", "Write check · confirmed denial"],
    ["lost", "Write check · lost turn response"],
    ["restart", "Write check · restart during turn recovery"],
    ["rejected", "Write check · explicit turn rejection"],
    ["missing-chat", "Write check · chat missing at resume"],
    ["missing-history", "Write check · chat missing at history lookup"],
    ["revoked", "Write check · full access revoked"],
  ].map(([scenario, title]) => {
    const cwd = join(scratch, scenario);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "scenario"), scenario);
    const { id } = cli("create", null, plannedDraft({ title, criteria: ["Run fixture"], workingDirectory: cwd }));
    cli("approve", id);
    return [scenario, { id, cwd: realpathSync(cwd), title }];
  }));
  writeFileSync(casesPath, JSON.stringify(cases));
  writeFileSync(stubPath, stub);
}

app.setPath("userData", profile);
app.setPath("appData", scratch);
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", ({ message, level }) => {
    if (level === "error") console.error(message);
  });
});
globalThis.probeCheckClient = { path: node, args: [stubPath, log], windowsSandbox: "mxc" };
const url = new URL("../src/desktop/main.ts", import.meta.url);
const instrumented = readFileSync(url, "utf8")
  .replace("codexStatus, configuredCodex,", "codexStatus,")
  .replace("providerLimitSource, readCodexLimits,", "providerLimitSource,")
  .replaceAll("import.meta.url", JSON.stringify(url.href))
  .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href))
  .concat(`\nconst configuredCodex = async () => globalThis.probeCheckClient;
const readCodexLimits = async () => ({ provider: "Codex", state: "unknown", windows: [] });
globalThis.probeCheck = { createWindow, reserveAgent, scheduleAgentWork };`);
const entry = join(scratch, "main.mjs");
writeFileSync(entry, require("esbuild").transformSync(instrumented, { loader: "ts", format: "esm" }).code);
process.argv.push("--project", project);
require(entry);

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
if (recoverTurn) writeFileSync(join(cases.restart.cwd, "show-history"), "");
const missingChatReason = /original Codex chat is missing|исходный чат Codex отсутствует/i;
const revokedAccessReason = /full access was revoked|полный доступ отозван/i;
const blockedRecoveryCases = [
  { fixture: cases["missing-chat"], reason: missingChatReason, resumes: 1, history: 0 },
  { fixture: cases["missing-history"], reason: missingChatReason, resumes: 1, history: 1 },
  { fixture: cases.revoked, reason: revokedAccessReason, resumes: 0, history: 0 },
];
const frame = window => window.webContents.executeJavaScript("window.taskboard?.bootstrap()");
const evaluate = (window, method, ...args) =>
  window.webContents.executeJavaScript("window.taskboard." + method + "(..." + JSON.stringify(args) + ")");
const probeRecords = ({ cwd }) => records().filter(event => event.cwd === cwd && event.method === "command/exec");
const turnRecords = ({ cwd }) => records().filter(event => event.cwd === cwd && event.method === "turn/start");
const historyRecords = ({ cwd }) => records().filter(event => event.cwd === cwd && event.method === "thread/turns/list");
const openCard = (window, testCase) => until(() => window.webContents.executeJavaScript(`(() => {
  const card = [...document.querySelectorAll(".task-card")]
    .find(card => card.textContent.includes(${JSON.stringify(testCase.title)}));
  if (!card) return false;
  card.click();
  return true;
})()`), "open card " + testCase.id);
const waiting = (window, testCase) =>
  until(async () => (await frame(window))?.waitingTasks?.includes(testCase.id), "queued " + testCase.id);
const block = (window, testCase) =>
  until(async () => {
    const card = (await frame(window))?.board?.tasks.find(task => task.id === testCase.id);
    return card?.status === "blocked" && card;
  }, "blocked " + testCase.id);
const running = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
};
function released(probe) {
  return !running(probe.pid) && !existsSync(probe.temp) && !probe.targets.some(existsSync);
}

async function checkTurnRejection(window, testCase) {
  const card = await block(window, testCase);
  assert.equal(card.blocked.reason, turnRejection);
  assert.match(card.blocked.condition, /Retry launch|Повторить запуск/);
  assert.equal(probeRecords(testCase).length, 2);
  const turns = turnRecords(testCase);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].rejected, true);
  assert.equal(historyRecords(testCase).length, 0);
}

async function checkBlockedRecovery(window, { fixture, reason, resumes, history }) {
  const card = await block(window, fixture);
  assert.match(card.blocked.reason, reason);
  assert.match(card.blocked.condition, /check the outcome|проверьте исход/i);
  assert.equal(card.blocked.unconfirmedTurn, true);
  assert.equal(card.blocked.retryExecutor, undefined);
  await until(async () => {
    const state = await frame(window);
    const entry = runtimeEntries(project).find(item => item.task === fixture.id);
    return !entry && !state.waitingTasks?.includes(fixture.id) && !state.runningTasks?.includes(fixture.id);
  }, "idle after blocking " + fixture.id);
  const resumed = records().filter(event => event.cwd === fixture.cwd && event.method === "thread/resume");
  assert.equal(resumed.length, resumes);
  assert.equal(historyRecords(fixture).length, history);
  assert.equal(probeRecords(fixture).length, 2);
  assert.equal(turnRecords(fixture).length, 1);
  return card;
}

async function checkTurnRecovery(window, testCase, visible) {
  await until(() => historyRecords(testCase).some(event => event.visible === visible), "turn history for " + testCase.id);
  if (visible) {
    await until(async () => {
      const state = await frame(window);
      return !state.waitingTasks?.includes(testCase.id) && !state.runningTasks?.includes(testCase.id);
    }, "queue acknowledgement after matching history for " + testCase.id);
  } else {
    await waiting(window, testCase);
  }
  assert.equal(probeRecords(testCase).length, 2);
  const turns = turnRecords(testCase);
  assert.equal(turns.length, 1);
  assert.ok(turns[0].clientId);
  assert.ok(historyRecords(testCase).every(event => event.threadId === turns[0].threadId));
  const card = (await frame(window)).board.tasks.find(task => task.id === testCase.id);
  assert.equal(card.status, "in_progress");
}

void app.whenReady().then(async () => {
  const qa = globalThis.probeCheck;
  const window = await until(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && (await frame(win))?.board && win;
  }, "board");
  window.setContentSize(1280, 800);
  window.webContents.setZoomFactor(1);
  if (seed) {
    const launch = await evaluate(window, "launchTask", cases.success.id);
    assert.equal(launch.ok, true, JSON.stringify(launch));
    await waiting(window, cases.success);
    const [probe] = probeRecords(cases.success);
    assert.equal(probe.timeoutMs, 15_000);
    assert.equal(released(probe), true);
    assert.equal(turnRecords(cases.success).length, 0);
    await openCard(window, cases.success);
    const viewport = await until(async () => {
      const metrics = await window.webContents.executeJavaScript(`({
        width: innerWidth,
        height: innerHeight,
        queue: document.querySelector("#task-stop-waiting")?.textContent
      })`);
      return metrics.queue && metrics;
    }, "visibly queued card");
    assert.equal(Math.abs(viewport.width - 1280) <= 16, true, JSON.stringify(viewport));
    assert.equal(Math.abs(viewport.height - 800) <= 16, true, JSON.stringify(viewport));
    const capture = await window.webContents.capturePage();
    assert.equal(capture.isEmpty(), false);
    writeFileSync(join(artifacts, "write-probe-retry.png"), capture.toPNG());
    writeFileSync(join(scratch, "viewport.json"), JSON.stringify({ ...viewport, pixels: capture.getSize(), zoom: window.webContents.getZoomFactor() }));
    assert.equal(probeRecords(cases.success).length, 1);
  } else if (!recoverTurn) {
    await until(() => turnRecords(cases.success)[0], "one normal turn after restart");
    const [first, second] = probeRecords(cases.success);
    assert.equal(second.at - first.at >= 5000, true);
    assert.equal(second.cwd, first.cwd);
    assert.equal(second.profile, first.profile);
    assert.equal(second.sandbox, first.sandbox);
    const normalizedPermissions = probe => probe.permissions.replace(JSON.stringify(probe.temp), "<TEMP>");
    assert.equal(normalizedPermissions(second), normalizedPermissions(first));
    const win2 = qa.createWindow([project], project).window;
    await until(async () => (await frame(win2))?.board, "second window");
    const twice = cases.twice;
    const replies = await Promise.all([evaluate(window, "launchTask", twice.id), evaluate(win2, "launchTask", twice.id)]);
    assert.ok(replies.some(reply => reply.ok), JSON.stringify(replies));
    await waiting(window, twice);
    await waiting(win2, twice);
    const lease = await until(() => qa.reserveAgent(project, "executor", "fixture-occupied"), "free slot after probe");
    try {
      await wait(5600);
      assert.equal(probeRecords(twice).length, 1);
      await waiting(win2, twice);
    } finally {
      lease();
      qa.scheduleAgentWork();
    }
    const blocked = await block(window, twice);
    assert.match(blocked.blocked.reason, /both attempts|обеих попытках/);
    assert.match(blocked.blocked.condition, /Retry launch|Повторить запуск/);
    const cancelled = cases.cancel;
    assert.equal((await evaluate(window, "launchTask", cancelled.id)).ok, true);
    await waiting(win2, cancelled);
    assert.equal((await evaluate(win2, "chatStop", cancelled.id)).ok, true);
    assert.equal((await evaluate(window, "launchTask", cases.denied.id)).ok, true);
    const denied = await block(window, cases.denied);
    assert.ok(denied.blocked.reason.includes(JSON.stringify(cases.denied.cwd)));
    assert.match(denied.blocked.reason, /overwrite \(EACCES\)/);
    await wait(5600);
    assert.equal(probeRecords(twice).length, 2);
    assert.equal(probeRecords(cancelled).length, 1);
    assert.equal(probeRecords(cases.denied).length, 1);
    assert.equal(turnRecords(cases.success).length, 1);
    for (const testCase of [twice, cancelled, cases.denied]) {
      assert.equal(turnRecords(testCase).length, 0);
    }
    writeFileSync(join(twice.cwd, "scenario"), "recover");
    await openCard(window, twice);
    await until(() => window.webContents.executeJavaScript(`/Retry launch|Повторить запуск/.test(document.querySelector("#task-launch")?.textContent)`),
      "manual Retry launch button");
    await window.webContents.executeJavaScript('document.querySelector("#task-launch").click()');
    await until(() => turnRecords(twice)[0], "one normal turn after manual Retry launch");
    assert.equal(probeRecords(twice).length, 3);
    assert.equal(turnRecords(twice).length, 1);
    const rejected = await evaluate(window, "launchTask", cases.rejected.id);
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    await checkTurnRejection(window, cases.rejected);
    const lost = await evaluate(window, "launchTask", cases.lost.id);
    assert.equal(lost.ok, true, JSON.stringify(lost));
    await checkTurnRecovery(window, cases.lost, false);
    writeFileSync(join(cases.lost.cwd, "show-history"), "");
    await checkTurnRecovery(window, cases.lost, true);
    for (const testCase of blockedRecoveryCases) {
      const { fixture } = testCase;
      const revoked = fixture === cases.revoked;
      if (revoked) {
        const card = cli("show", fixture.id);
        assert.equal(executorFullAccess(profile, project, card, true), true);
      }
      const started = await evaluate(window, "launchTask", fixture.id);
      assert.equal(started.ok, true, JSON.stringify(started));
      if (revoked) {
        await until(() => turnRecords(fixture)[0], "dispatch under full access");
        const card = cli("show", fixture.id);
        assert.equal(executorFullAccess(profile, project, card, false), false);
        assert.deepEqual(probeRecords(fixture).map(event => event.profile),
          [":danger-full-access", ":danger-full-access"]);
      }
      await checkBlockedRecovery(window, testCase);
    }
    const restart = await evaluate(window, "launchTask", cases.restart.id);
    assert.equal(restart.ok, true, JSON.stringify(restart));
    await checkTurnRecovery(window, cases.restart, false);
    await until(() => historyRecords(cases.restart).every(event => !running(event.pid) && !existsSync(event.temp)),
      "provider closed after unconfirmed turn");
  } else {
    await checkTurnRecovery(window, cases.restart, true);
    for (const testCase of blockedRecoveryCases) {
      const { fixture } = testCase;
      const card = await checkBlockedRecovery(window, testCase);
      // A subsequent grant must not restore the direct launch action for an unconfirmed turn.
      assert.equal(executorFullAccess(profile, project, card, true), true);
      await openCard(window, fixture);
      await until(() => window.webContents.executeJavaScript(`(() => {
        const sheet = document.querySelector(".task-sheet");
        return sheet?.textContent.includes(${JSON.stringify(card.blocked.reason)});
      })()`), "visible blocked reason for " + fixture.id);
      assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector("#task-launch"))'), false);
      const retry = await evaluate(window, "launchTask", fixture.id, { resumeWithFullAccess: true });
      assert.equal(retry.ok, false);
      assert.equal(retry.error.code, "INVALID_TRANSITION");
      await checkBlockedRecovery(window, testCase);
    }
    const rejected = cases.rejected;
    await checkTurnRejection(window, rejected);
    await openCard(window, rejected);
    await until(() => window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector("#task-launch");
      return button?.getClientRects().length && /Retry launch|Повторить запуск/.test(button.textContent);
    })()`), "visible manual retry after explicit rejection");
    writeFileSync(join(rejected.cwd, "scenario"), "recover");
    await window.webContents.executeJavaScript('document.querySelector("#task-launch").click()');
    await until(() => turnRecords(rejected)[1], "one accepted turn after manual retry");
    assert.deepEqual(turnRecords(rejected).map(turn => turn.rejected), [true, false]);
    assert.equal(probeRecords(rejected).length, 3);
    assert.equal(historyRecords(rejected).length, 0);
    await until(() => records().filter(event => event.method === "command/exec").every(released), "all provider processes and temporary paths released");
    await until(() => records().filter(event => event.method === "thread/turns/list")
      .every(event => !running(event.pid) && !existsSync(event.temp)), "all history providers released");
    await until(() => records().filter(event => event.method === "thread/resume")
      .every(event => !running(event.pid) && !existsSync(event.temp)), "all resume providers released");
    const gitDirectory = fileURLToPath(new URL("..", import.meta.url));
    const git = (...args) => execFileSync("git", args, { cwd: gitDirectory, windowsHide: true });
    const base = git("rev-parse", "HEAD").toString("utf8").trim();
    const paths = [
      "src/cli/main.ts", "src/cli/model.ts", "src/cli/tasks.ts", "src/desktop/agent-limits.ts",
      "src/desktop/board-runtime.ts", "src/desktop/codex-rpc.ts", "src/desktop/codex-run.ts", "src/desktop/codex.ts",
      "src/desktop/locales/en.json", "src/desktop/locales/ru.json", "src/desktop/main.ts", "src/desktop/renderer.js",
      "scripts/check-write-probe-retry.mjs",
    ];
    assert.equal(git("status", "--porcelain").toString("utf8"), "", "QA ran in a clean checkout");
    const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
    const hashes = paths.map(path => {
      const checkout = sha256(readFileSync(new URL("../" + path, import.meta.url)));
      const blob = git("rev-parse", "HEAD:" + path).toString("utf8").trim();
      const stored = sha256(git("cat-file", "blob", blob));
      return "| `" + path + "` | `" + blob + "` | `" + stored + "` | `" + checkout + "` |";
    });
    const viewport = JSON.parse(readFileSync(join(scratch, "viewport.json"), "utf8"));
    writeFileSync(join(artifacts, "write-probe-retry-check.md"), [
      "# Проверка повтора записи в Windows Electron",
      "",
      "Команда из рабочей копии с установленными зависимостями",
      "",
      "\`\`\`powershell",
      "node scripts/check-write-probe-retry.mjs --artifacts .tasks/qa",
      "\`\`\`",
      "",
      "Windows " + process.getSystemVersion() + " · Electron " + process.versions.electron + " · Chromium " + process.versions.chrome +
        " · Node Electron " + process.versions.node + " · Node запуска " + execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
      "",
      "- Первый процесс App Server возвращает код 124 для запроса с лимитом 15 000 мс. В карточке видна очередь. Снимок " +
        viewport.width + "×" + viewport.height + " CSS-пикселей, масштаб " + viewport.zoom + ", PNG " + viewport.pixels.width + "×" + viewport.pixels.height + ".",
      "- После перезапуска в том же каталоге и с тем же профилем и правилами записи прошли вторая проверка и единственный `turn/start`.",
      "- Два окна видят одну очередь. Пока слот занят, второй запрос не отправляется. После освобождения слота повторный код 124 блокирует карточку, третьего запроса нет.",
      "- Остановка из второго окна отменяет отложенный запуск. Подтверждённый отказ `overwrite (EACCES)` сохраняет каталог и операцию.",
      "- После устранения причины кнопка «Повторить запуск» выполнила новую проверку и запустила один ход.",
      "- После обрыва ответа на принятый `turn/start` пустая история оставила карточку в очереди. После появления сообщения с тем же идентификатором доска восстановила завершённый ход и сняла ожидание. Всего 2 проверки записи и 1 отправка хода.",
      "- После выхода Electron при неподтверждённом ходе новое приложение нашло принятый ход в истории и сняло ожидание. Всего 2 проверки записи и 1 отправка хода.",
      "- При явном ответе JSON-RPC с отказом и последующем закрытии App Server карточка показала причину отказа. После перезапуска сохранились блокировка и кнопка «Повторить запуск». До ручного запуска зарегистрированы две проверки записи, один отклонённый `turn/start` и ноль запросов истории. После исправления причины кнопка выполнила одну новую проверку и один ход.",
      "- После потери ответа App Server подтвердил отсутствие исходного чата в отдельных сценариях `thread/resume` и `thread/turns/list`. Карточки заблокированы с причиной об отсутствующем чате.",
      "- Две проверки записи и отправка хода выполнены с полным доступом. После потери ответа полный доступ отозван через хранилище профиля. Карточка заблокирована с причиной об отзыве доступа. Провайдер для сверки не запущен.",
      "- Во всех трёх сценариях блокировки остаются две проверки записи и один `turn/start`. После перезапуска причины сохранены, очередь и слот освобождены. Новый полный доступ не возвращает прямую кнопку запуска, а её IPC-вызов отклоняется.",
      "- Все процессы проверок и сверки истории завершились. Выделенные временные каталоги исполнителя и файлы проверок удалены.",
      "",
      "Заглушка воспроизводит результат RPC 124 сразу. Тест не ждёт истечения реальных 15 секунд и не измеряет поведение реального App Server. При успехе и отказе выполняется штатный скрипт записи.",
      "Linux, macOS и установочные пакеты в этом прогоне не проверялись.",
      "",
      "Проверенный Git HEAD — `" + base + "`. Рабочая копия после прогона чистая.",
      "",
      "Git blob ID получен через `git rev-parse HEAD:<путь>`. SHA-256 Git blob вычислен по бинарному результату `git cat-file blob <ID>`. SHA-256 checkout вычислен по байтам рабочего файла.",
      "",
      "| Путь | Git blob ID | SHA-256 Git blob | SHA-256 checkout |",
      "| --- | --- | --- | --- |",
      ...hashes, "",
    ].join("\n"));
  }
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
