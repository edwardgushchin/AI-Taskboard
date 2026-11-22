import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const phases = [["--seed"], ["--review-crash"], ["--restore"], ["--reconcile"]];
const { scratch, artifacts } = electronCheck(import.meta.url, "codex-routing-retry", 160_000, phases);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const node = process.env.TASKBOARD_CHECK_NODE;
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const log = join(scratch, "provider.jsonl");
const casesPath = join(scratch, "cases.json");
const providerPath = join(scratch, "provider.cjs");
const seed = process.argv.includes("--seed");
const reviewCrash = process.argv.includes("--review-crash");
const restore = process.argv.includes("--restore");
const timeout = "workspace routing discovery timed out";
const evidencePath = join(scratch, "evidence.json");
const reviewCrashPath = join(scratch, "review-crash.json");

function cli(command, id, input) {
  const args = [cliPath, "--project", project, "--json", command];
  if (id) args.push(id);
  if (input) args.push("--stdin");
  const raw = execFileSync(node, args, {
    encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true, timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const result = JSON.parse(raw);
  assert.equal(result.ok, true, raw);
  return result.data;
}

function provider() {
  const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
  const { createHash } = require("node:crypto");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { createInterface } = require("node:readline");
  const [log, timeout, casesPath, cliPath, project, ...flags] = process.argv.slice(2);
  const cases = JSON.parse(readFileSync(casesPath, "utf8"));
  let threadId;
  let cwd;
  const send = message => console.log(JSON.stringify(message));
  const records = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  const record = (method, fields = {}) => {
    appendFileSync(log, JSON.stringify({
      method, cwd, threadId, pid: process.pid, temp: process.env.TEMP, at: Date.now(), ...fields,
    }) + "\n");
  };
  const cli = (command, card, input) => {
    const args = [cliPath, "--project", project, "--json", command, card];
    if (input) args.push("--stdin");
    const result = spawnSync(process.execPath, args, {
      input: input && JSON.stringify(input), encoding: "utf8", windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const reply = JSON.parse(result.stdout);
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    return reply.data;
  };
  async function reply(line) {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    if (method === "command/exec") {
      cwd = params.cwd;
      const [exe, ...args] = params.command;
      const check = spawnSync(exe, args, {
        cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, ...params.env },
      });
      record(method);
      result = { exitCode: check.status, stdout: check.stdout, stderr: check.stderr };
    } else if (method === "thread/start" || method === "thread/resume") {
      cwd = params.cwd;
      const hash = createHash("sha256").update(cwd).digest("hex");
      threadId = params.threadId ?? "81234567-1234-5678-1234-" + hash.slice(0, 12);
      record(method);
      result = {
        thread: { id: threadId }, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, activePermissionProfile: { id: params.permissions },
      };
    } else if (method === "config/read") {
      result = { config: { mcp_servers: { ai_taskboard: { url: "http://127.0.0.1/mcp" } } } };
    } else if (method === "model/list") {
      result = {
        data: [{
          id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true,
          defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        }],
        nextCursor: null,
      };
    } else if (method === "mcpServerStatus/list") {
      const flag = flags.find(value => value.includes("ai_taskboard") && value.includes("http"));
      const url = flag.match(/http[^"]+/)[0];
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const { tools } = (await response.json()).result;
      result = { data: [{ name: "ai_taskboard", tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] };
    } else if (method === "thread/turns/list") {
      const history = existsSync(join(cwd, "show-history"));
      const starts = records().filter(event => event.cwd === cwd && event.method === "turn/start");
      record(method, { history });
      result = { data: starts.filter(event => event.number === 1 || history).reverse().map(event => ({
        id: event.turnId, status: event.number === 1 ? "failed" : "interrupted", completedAt: event.at,
        ...(event.number === 1 ? { error: { message: timeout } } : {}),
        itemsView: "full", items: [{ type: "userMessage", clientId: event.clientId }],
      })) };
    } else if (method === "turn/start") {
      const testCase = Object.values(cases).find(item => item.cwd === cwd);
      const number = 1 + records().filter(event => event.method === method && event.cwd === cwd).length;
      const turnId = "turn-" + number;
      if (cwd === project) {
        const prompt = params.input[0].text;
        const marker = prompt.match(/"submissionSequence":\s*(\d+)/)?.[1];
        record(method, { number, turnId, submissionSequence: marker });
        send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
        let turn = { id: turnId, status: "completed" };
        if (number <= 2) {
          turn = { id: turnId, status: "failed", error: { message: timeout } };
        } else {
          const text = JSON.stringify({
            summary: "Fixture review passed.", findings: [],
            evidence: ["Verified the original submission."], needsHuman: false, verifyRisk: false,
          });
          send({
            method: "item/completed", params: { threadId, turnId,
              item: { id: "review-answer", type: "agentMessage", phase: "final_answer", text },
            },
          });
        }
        send({ method: "turn/completed", params: { threadId, turn } });
        return;
      }
      record(method, { number, turnId, clientId: params.clientUserMessageId });
      if (testCase.scenario === "unknown" && number === 2) {
        send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
        setTimeout(() => process.exit(0), 250);
        return;
      }
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      let turn = { id: turnId, status: "interrupted" };
      if (testCase.scenario === "other") {
        turn = { id: turnId, status: "failed", error: { message: "Fixture: a different provider error" } };
      } else if (number === 1 || testCase.scenario === "limit" && number === 2) {
        if (testCase.scenario === "success") {
          const task = cli("show", testCase.id);
          const stage = { actor: "agent", phase: "work", key: "prepare", revision: task.revision };
          cli("expert-stage", task.id, { ...stage, state: "running", threadId });
          cli("expert-stage", task.id, {
            ...stage, state: "done", result: "Preparation completed before retry.",
            outputs: { preparation: "Fixture is ready." },
          });
          cli("expert-stage", task.id, { ...stage, key: "verify", state: "running", threadId });
        }
        writeFileSync(join(cwd, "saved-change.txt"), "Saved during the first turn.\n");
        turn = { id: turnId, status: "failed", error: { message: timeout } };
      } else if (testCase.scenario === "success") {
        const task = cli("show", testCase.id);
        cli("expert-stage", testCase.id, {
          actor: "agent", phase: "work", key: "verify", state: "running", revision: task.revision, threadId,
        });
        cli("expert-stage", testCase.id, {
          actor: "agent", phase: "work", key: "verify", state: "done", revision: task.revision,
          result: "Verification completed after resume.", outputs: { evidence: "Saved change remained." },
          fallback: "Fixture does not emulate a native specialist process.",
        });
        const preview = cli("preview", testCase.id);
        cli("submit", testCase.id, {
          token: preview.token, message: "test: save work verified by the fixture",
          summary: "Verified in the same assigned directory.",
          checks: ["Saved change still exists."],
        });
        turn = { id: turnId, status: "completed" };
      }
      send({ method: "turn/completed", params: { threadId, turn } });
      return;
    }
    send({ id, result });
  }
  createInterface({ input: process.stdin }).on("line", line => {
    void reply(line).catch(error => {
      record("fixture-error", { error: error.message });
      process.exitCode = 1;
      process.stdin.destroy();
    });
  });
}

if (seed) {
  mkdirSync(project);
  mkdirSync(profile);
  writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Taskboard");
  git("config", "user.email", "taskboard@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial commit");
  cli("init");
  cli("settings", null, { reviewMode: "human", autoMode: false, taskLimits: { executor: 1, reviewer: 1 } });
  const cases = {};
  for (const [scenario, title] of [
    ["success", "Проверить отчёт в той же рабочей папке"],
    ["limit", "Ограничить повторяющийся тайм-аут"],
    ["stop", "Остановить ожидающий повтор"],
    ["cancel", "Отменить карточку во время ожидания"],
    ["unknown", "Сверить исход хода после разрыва"],
    ["other", "Сохранить причину другой ошибки"],
  ]) {
    const draft = plannedDraft({
      title, description: "Воспроизвести завершение хода Codex во время проверки.",
      criteria: ["Повтор продолжает работу с сохранёнными правками."],
    });
    if (scenario === "success") {
      draft.expertTeam.work = {
        ...draft.expertTeam.work,
        stages: [
          {
            key: "prepare", expertId: "qa-engineer", title: "Подготовка проверки",
            criteria: ["Рабочая папка подготовлена"], outputs: ["preparation"],
          },
          {
            key: "verify", expertId: "desktop-qa", title: "Проверка результата",
            criteria: ["Правки остались в рабочей папке"], outputs: ["evidence"], dependsOn: ["prepare"],
          },
        ],
      };
    }
    const { id } = cli("create", null, draft);
    confirmFixtureDraft(project, id);
    cli("approve", id);
    cases[scenario] = { id, cwd: join(realpathSync(project), ".worktrees", id), title, scenario };
  }
  writeFileSync(casesPath, JSON.stringify(cases));
  writeFileSync(providerPath, "(" + provider.toString() + ")();\n");
}

app.setPath("appData", scratch);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
globalThis.routingCheckClient = {
  path: node, args: [providerPath, log, timeout, casesPath, cliPath, project], windowsSandbox: "mxc",
};
function instrument(name, transform) {
  const source = new URL("../src/desktop/" + name + ".ts", import.meta.url);
  const code = transform(readFileSync(source, "utf8"))
    .replaceAll("import.meta.url", JSON.stringify(source.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, source).href));
  const output = join(scratch, name + ".mjs");
  writeFileSync(output, require("esbuild").transformSync(code, { loader: "ts", format: "esm" }).code);
  return output;
}
function interceptReviewCleanup(code) {
  const cleanup = /(result\.error\.code === "CODEX_ROUTING_TIMEOUT"\) \{[\s\S]*?)(rmSync\(checkpointToRemove, \{ force: true \}\))/g;
  assert.equal([...code.matchAll(cleanup)].length, 1, "instrument exactly one routing timeout checkpoint removal");
  return code.replace(cleanup, '$1globalThis.routingCheckCrash(checkpointToRemove)');
}
globalThis.routingCheckCrash = path => {
  const testCase = cases.success;
  assert.equal(reviewCrash, true);
  assert.equal(path, reviewCheckpoint(testCase.id));
  assert.equal(reviewTurns().length, 2, "stop after the second reviewer turn");
  const checkpoint = readFileSync(path);
  assert.equal(JSON.parse(checkpoint).turn?.turnId, "turn-2");
  const retry = runtimeEntries(project).find(entry => entry.task === "review-retry:" + testCase.id)?.reviewRetry;
  writeFileSync(reviewCrashPath, JSON.stringify({
    pid: process.pid, checkpoint: createHash("sha256").update(checkpoint).digest("hex"),
    exhausted: retry?.exhausted === true, reason: retry?.reason, notBefore: retry?.notBefore,
  }));
  app.exit(0);
};
const chat = instrument("codex-chat", code =>
  code.replace("configuredCodex, executorFullAccess", "executorFullAccess")
    .concat("\nconst configuredCodex = async () => globalThis.routingCheckClient;"));
const entry = instrument("main", code => (reviewCrash ? interceptReviewCleanup(code) : code)
  .replace("codexStatus, configuredCodex,", "codexStatus,")
  .replace("providerLimitSource, readCodexLimits,", "providerLimitSource,")
  .replace("const notify = (error: string) => {", 'const notify = (error: string) => {\n    console.error("Fixture reviewer error:", error);')
  .replaceAll('"./codex-chat.ts"', JSON.stringify(pathToFileURL(chat).href))
  .concat(`\nconst configuredCodex = async () => globalThis.routingCheckClient;
const readCodexLimits = async () => ({ provider: "Codex", state: "unknown", windows: [] });
globalThis.routingCheck = { createWindow, reserveAgent };`));
process.argv.push("--project", project);
require(entry);

const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const records = () => existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  : [];
const turns = testCase => records().filter(event => event.cwd === testCase.cwd && event.method === "turn/start");
const histories = testCase => records().filter(event => event.cwd === testCase.cwd && event.method === "thread/turns/list");
const reviewTurns = () => records().filter(event => event.cwd === project && event.method === "turn/start");
const reviewCheckpoint = id => join(project, ".tasks", "reviewer-quota-" + id + ".json");
const frame = window => window.webContents.executeJavaScript("window.taskboard?.bootstrap()");
const invoke = (window, method, ...args) =>
  window.webContents.executeJavaScript("window.taskboard." + method + "(..." + JSON.stringify(args) + ")");
const card = async (window, testCase) => (await frame(window))?.board?.tasks.find(task => task.id === testCase.id);

async function bounded(action, description, duration = 10_000) {
  const timeout = AbortSignal.timeout(duration);
  let abort;
  const expires = new Promise((_, reject) => {
    abort = () => reject(new Error("Timed out: " + description));
    timeout.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([action(), expires]);
  } finally {
    timeout.removeEventListener("abort", abort);
  }
}

async function until(read, description, duration = 30_000) {
  const end = Date.now() + duration;
  while (Date.now() < end) {
    const result = await bounded(read, description, Math.max(100, end - Date.now()));
    if (result) return result;
    await wait(60);
  }
  const sequence = records().map(event => [event.method, basename(event.cwd ?? ""), event.number ?? event.error]);
  throw new Error("Timed out: " + description + "\n" + JSON.stringify(sequence));
}

const waiting = (window, testCase) => until(async () =>
  (await frame(window))?.waitingTasks?.includes(testCase.id), "queued " + testCase.id);
const blocked = (window, testCase) => until(async () => {
  const current = await card(window, testCase);
  return current?.status === "blocked" && current;
}, "blocked " + testCase.id);

async function launch(window, testCase) {
  const reply = await bounded(() => invoke(window, "launchTask", testCase.id), "launch " + testCase.id, 35_000);
  assert.equal(reply.ok, true, JSON.stringify(reply));
}

async function show(window, testCase) {
  await bounded(() => window.webContents.executeJavaScript(`showTask(${JSON.stringify(testCase.id)})`), "show " + testCase.id);
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

async function released() {
  await until(() => records().every(event => !running(event.pid)), "fixture App Server processes released");
  await until(() => !runtimeEntries(project).some(event => ["provider", "slot"].includes(event.kind)), "slots released");
  const directories = records().filter(event => event.method === "command/exec").map(event => event.temp);
  assert.ok(directories.length > 0);
  assert.ok(directories.every(path => path && !existsSync(path)), "executor TEMP paths released");
}

async function captureWaiting(window) {
  await show(window, cases.success);
  const viewport = await until(() => window.webContents.executeJavaScript(`(() => {
    const stop = document.querySelector("#task-stop-waiting");
    const label = document.querySelector("#task-agent-run");
    if (!stop?.checkVisibility() || !label?.checkVisibility()) return null;
    return { width: innerWidth, height: innerHeight, stop: stop.innerText, label: label.innerText };
  })()`), "visible wait and stop action");
  assert.match(viewport.label, /Ожидание повтора Codex|Waiting to retry Codex/);
  assert.equal(Math.abs(viewport.width - 1280) <= 16, true, JSON.stringify(viewport));
  assert.equal(Math.abs(viewport.height - 900) <= 16, true, JSON.stringify(viewport));
  await window.webContents.capturePage();
  await wait(200);
  const image = await window.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  writeFileSync(join(artifacts, "codex-timeout-retry.png"), image.toPNG());
  return { ...viewport, pixels: image.getSize(), zoom: window.webContents.getZoomFactor() };
}

async function checkSeed(window) {
  await launch(window, cases.success);
  await waiting(window, cases.success);
  assert.equal((await card(window, cases.success)).status, "in_progress");
  const viewport = await captureWaiting(window);
  assert.equal(turns(cases.success).length, 1);
  await released();
  writeFileSync(evidencePath, JSON.stringify({ viewport, seedPid: process.pid, snapshot: sourceSnapshot() }));
}

async function checkBeforeReviewCrash(window) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.notEqual(process.pid, evidence.seedPid);
  await until(async () => (await card(window, cases.success))?.status === "review", "submission after restart");
  const [first, second] = turns(cases.success);
  assert.equal(turns(cases.success).length, 2);
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.cwd, first.cwd);
  assert.ok(second.at - first.at >= 5_000);
  assert.equal(readFileSync(join(second.cwd, "saved-change.txt"), "utf8"), "Saved during the first turn.\n");
  const submitted = cli("show", cases.success.id);
  assert.equal(submitted.history.filter(item => item.action === "submit").length, 1);
  const work = submitted.history.filter(item => item.expertStageRun?.phase === "work");
  assert.equal(work.filter(item => item.expertStageRun.key === "prepare" && item.expertStageRun.state === "done").length, 1);
  assert.equal(work.filter(item => item.expertStageRun.key === "verify" && item.expertStageRun.state === "done").length, 1);
  evidence.delay = second.at - first.at;
  await released();
  console.log("PASS: executor retry restored with its Git worktree, stages and single submission");
  await checkReviewWaiting(window, evidence);
  await until(() => false, "intentional Electron exit before reviewer checkpoint cleanup");
}

async function checkRestore(window) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  await checkReviewAfterCrash(window, evidence.review);
  cli("settings", null, { reviewMode: "human" });
  console.log("PASS: independent review retried and approved the original submission");
  const { window: secondWindow } = globalThis.routingCheck.createWindow([project], project);
  secondWindow.webContents.setBackgroundThrottling(false);
  await until(async () => (await frame(secondWindow))?.board, "second window");
  await launch(window, cases.limit);
  await waiting(window, cases.limit);
  await waiting(secondWindow, cases.limit);
  const reserve = () => globalThis.routingCheck.reserveAgent(project, "executor", "fixture-occupied");
  const release = await until(reserve, "reserve competing executor slot");
  try {
    await wait(5_600);
    assert.equal(turns(cases.limit).length, 1);
    await waiting(secondWindow, cases.limit);
  } finally {
    release();
  }
  assert.equal((await blocked(window, cases.limit)).blocked.reason, timeout);
  assert.equal(turns(cases.limit).length, 2);
  await released();
  console.log("PASS: two windows, occupied slot and executor retry limit");
  await launch(window, cases.stop);
  await waiting(secondWindow, cases.stop);
  await show(secondWindow, cases.stop);
  await clickVisible(secondWindow, "#task-stop-waiting");
  await until(async () => !(await frame(secondWindow)).waitingTasks.includes(cases.stop.id), "owner stopped the pending retry");
  await launch(window, cases.cancel);
  await waiting(secondWindow, cases.cancel);
  const current = cli("show", cases.cancel.id);
  cli("cancel", current.id, { actor: "user", revision: current.revision, reason: "Fixture owner cancelled." });
  console.log("PASS: owner stopped and cancelled pending retries");
  await launch(window, cases.other);
  assert.equal((await blocked(window, cases.other)).blocked.reason, "Fixture: a different provider error");
  await released();
  await launch(window, cases.unknown);
  await waiting(secondWindow, cases.unknown);
  const hold = await until(reserve, "reserve slot while auto mode changes");
  try {
    const queue = cli("auto-queue");
    cli("auto-queue", null, { revision: queue.revision, paused: true });
    cli("settings", null, { autoMode: true });
    await until(async () => (await frame(window))?.board.settings.autoMode, "auto mode enabled");
    assert.equal(turns(cases.unknown).length, 1);
  } finally {
    hold();
  }
  await until(() => histories(cases.unknown).some(event => !event.history), "unconfirmed history queried");
  await waiting(secondWindow, cases.unknown);
  assert.equal(turns(cases.unknown).length, 2);
  assert.ok(turns(cases.unknown)[1].clientId);
  assert.equal(turns(cases.stop).length, 1);
  assert.equal(turns(cases.cancel).length, 1);
  assert.equal(turns(cases.other).length, 1);
  assert.equal(turns(cases.limit).length, 2);
  assert.equal((await card(window, cases.stop)).status, "in_progress");
  assert.equal((await card(window, cases.cancel)).status, "cancelled");
  await released();
  secondWindow.destroy();
  console.log("PASS: no new turn while preceding result is unconfirmed");
  writeFileSync(evidencePath, JSON.stringify({ ...evidence, restoredPid: process.pid }));
}

async function checkReconcile(window) {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.notEqual(process.pid, evidence.restoredPid);
  await waiting(window, cases.unknown);
  const queries = histories(cases.unknown).length;
  await until(() => histories(cases.unknown).length > queries, "new process queries unresolved retry");
  assert.equal(turns(cases.unknown).length, 2);
  writeFileSync(join(cases.unknown.cwd, "show-history"), "");
  await until(() => histories(cases.unknown).some(event => event.history), "previously accepted turn found");
  await until(async () => {
    const state = await frame(window);
    return !state.waitingTasks.includes(cases.unknown.id) && !state.runningTasks.includes(cases.unknown.id);
  }, "reconciled turn removed from queue");
  assert.equal(turns(cases.unknown).length, 2);
  assert.equal((await card(window, cases.unknown)).status, "in_progress");
  assert.equal(turns(cases.limit).length, 2);
  assert.equal(turns(cases.success).length, 2);
  assert.equal(turns(cases.stop).length, 1);
  assert.equal(turns(cases.cancel).length, 1);
  assert.equal(turns(cases.other).length, 1);
  await released();
  await show(window, cases.limit);
  await clickVisible(window, "#task-launch");
  await until(() => turns(cases.limit).length === 3, "manual continuation after the executor retry limit");
  await released();
  console.log("PASS: confirmed history reconciled after restart, executor can continue after the retry limit");
  writeReport(evidence);
}

function readReview(id) {
  return cli("review", id, { compact: true, includeReviewerSettings: true });
}

async function checkReviewWaiting(window, evidence) {
  const testCase = cases.success;
  const initial = readReview(testCase.id);
  assert.equal(initial.stale, false, JSON.stringify(initial));
  assert.ok(initial.submissionSequence > 0, JSON.stringify(initial));
  evidence.review = { submitted: initial.submitted, submissionSequence: initial.submissionSequence };
  writeFileSync(evidencePath, JSON.stringify(evidence));
  cli("settings", null, {
    autoMode: false, reviewMode: "reviewer-human", reviewer: { model: "fixture", effort: "low" },
  });
  await until(async () => {
    const state = await frame(window);
    return state?.board?.settings?.reviewMode === "reviewer-human";
  }, "independent review mode visible");
  const current = await card(window, testCase);
  assert.equal(current.expertReviewPlanned, true, JSON.stringify(current));
  await until(async () => {
    const retry = (await frame(window))?.routingRetries?.[testCase.id];
    return reviewTurns().length === 1 && retry?.reason === timeout && !retry.exhausted;
  }, "independent review queued after the first timeout");
}

async function checkReviewAfterCrash(window, initial) {
  const testCase = cases.success;
  const crash = JSON.parse(readFileSync(reviewCrashPath, "utf8"));
  assert.notEqual(process.pid, crash.pid, "a new Electron process opened the board");
  assert.equal(crash.exhausted, true, "the exhausted flag must be on disk before checkpoint cleanup");
  assert.equal(crash.reason, timeout);
  const persistedRetry = () => runtimeEntries(project).find(entry => entry.task === "review-retry:" + testCase.id)?.reviewRetry;
  assert.equal(persistedRetry()?.exhausted, true, "the restarted process sees the exhausted flag");
  const unchangedCheckpoint = () => createHash("sha256").update(readFileSync(reviewCheckpoint(testCase.id))).digest("hex");
  assert.equal(unchangedCheckpoint(), crash.checkpoint, "the earlier checkpoint survived the interrupted cleanup");
  await released();
  assert.equal(reviewTurns().length, 2);
  assert.ok(reviewTurns()[1].at - reviewTurns()[0].at >= 5_000);
  assert.equal((await card(window, testCase)).status, "review");
  const exhausted = readReview(testCase.id);
  assert.equal(exhausted.submissionSequence, initial.submissionSequence);
  assert.equal(exhausted.submitted, initial.submitted);
  await show(window, testCase);
  await until(() => window.webContents.executeJavaScript(`(() => {
    const status = document.querySelector("#task-agent-run");
    const button = status?.querySelector("button");
    return button?.checkVisibility() && /Повторить ревью|Retry review/.test(button.innerText) &&
      status.innerText.includes(${JSON.stringify(timeout)});
  })()`), "visible reason and manual review retry action after restart");
  await wait(5_600);
  assert.ok(Date.now() >= crash.notBefore, "pass the saved deadline");
  assert.equal(reviewTurns().length, 2, "restart must not start a third review after the deadline");
  assert.equal(unchangedCheckpoint(), crash.checkpoint, "manual retry starts with the old checkpoint still on disk");
  await clickVisible(window, "#task-agent-run button");
  const approved = await until(async () => {
    const current = await card(window, testCase);
    return current?.reviewApproved && current;
  }, "review approved after manual retry");
  assert.equal(approved.status, "review");
  assert.equal(reviewTurns().length, 3);
  const final = readReview(testCase.id);
  assert.equal(final.submitted, initial.submitted);
  assert.equal(final.submissionSequence, initial.submissionSequence);
  assert.ok(reviewTurns().every(event => Number(event.submissionSequence) === initial.submissionSequence));
  assert.equal(cli("show", testCase.id).history.filter(item => item.action === "submit").length, 1);
  await released();
}

async function clickVisible(window, selector) {
  await until(() => window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button?.checkVisibility() || button.disabled) return false;
    button.click();
    return true;
  })()`), "visible action " + selector);
}

function sourceSnapshot() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const base = git("rev-parse", "HEAD");
  const paths = new Set([
    "scripts/check-codex-routing-retry.mjs", "scripts/electron-check.mjs",
    "src/cli/main.ts", "src/desktop/agent-limits.ts", "src/desktop/board-actions.ts",
    "src/desktop/board-runtime.ts", "src/desktop/codex-chat.ts", "src/desktop/codex-queued-turn.ts",
    "src/desktop/codex-routing-timeout.ts", "src/desktop/codex-run.ts", "src/desktop/locales/en.json",
    "src/desktop/locales/ru.json", "src/desktop/main.ts", "src/desktop/preload.cjs", "src/desktop/renderer.js",
    ...git("diff", "--name-only", "HEAD").split(/\r?\n/),
    ...git("ls-files", "--others", "--exclude-standard").split(/\r?\n/),
  ]);
  const hashes = [...paths].filter(path => path && existsSync(join(root, path))).sort().map(path => {
    const digest = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    return digest + "  " + path;
  });
  return { base, hashes };
}

function writeReport({ viewport, delay, snapshot }) {
  assert.deepEqual(sourceSnapshot(), snapshot, "Product sources stayed unchanged throughout the run");
  writeFileSync(join(artifacts, "codex-timeout-retry-check.txt"), [
    "Восстановление хода Codex после тайм-аута — Windows Electron",
    "",
    "Команда: node scripts/check-codex-routing-retry.mjs --artifacts .tasks/qa",
    "Windows " + process.getSystemVersion() + ", Electron " + process.versions.electron +
      ", Chromium " + process.versions.chrome + ", Node Electron " + process.versions.node,
    "",
    "Ожидание: " + viewport.label.trim() + ". Доступно действие: " + viewport.stop.trim() + ".",
    "Снимок " + viewport.width + "×" + viewport.height + " CSS, " + viewport.pixels.width + "×" +
      viewport.pixels.height + " PNG, масштаб " + viewport.zoom + ".",
    "После перезапуска с выключенным авторежимом прошёл один повтор через " + delay +
      " мс. Чат, рабочая папка и сохранённая правка совпали. Этап проверки завершился, сдача записана один раз.",
    "Два окна показали одну очередь. Занятый слот удержал повтор. Второй тайм-аут заблокировал карточку с исходной причиной. Следующий ход начался только после ручного запуска.",
    "Остановка из второго окна и отмена через CLI прекратили ожидание. Другая ошибка была записана как причина блокировки без повтора.",
    "Со включённым авторежимом при неизвестном исходе повторного хода приложение ждало историю. После ещё одного перезапуска и появления хода в истории очередь снялась, нового запроса turn/start не было.",
    "После циклов запуска, выхода и сверки все PID тестовых провайдеров завершились, слоты и временные каталоги исполнителей освобождены.",
    "Независимое ревью повторило исходную сдачу после задержки. На втором тайм-ауте стенд прервал Electron перед удалением контрольной точки. Исчерпание попыток уже было записано на диск.",
    "После перезапуска та же контрольная точка осталась на диске. Карточка осталась на проверке, в ней видны причина и действие «Повторить ревью». После срока повтора было ровно два запуска ревью. Нажатие кнопки запустило одно ревью той же сдачи и сохранило одобрение. Событие submit осталось единственным.",
    "Тестовый App Server передаёт ошибку завершения по JSON-RPC. Живая модель, Linux, macOS и установщики не проверялись.",
    "",
    "Git HEAD перед проверкой — " + snapshot.base + ". SHA-256 по байтам файлов рабочей копии:",
    ...snapshot.hashes, "",
  ].join("\n"));
}

void app.whenReady().then(async () => {
  const window = await until(async () => {
    const [current] = BrowserWindow.getAllWindows();
    return current && (await frame(current))?.board && current;
  }, "board");
  window.setContentSize(1280, 900);
  window.webContents.setZoomFactor(1);
  window.webContents.setBackgroundThrottling(false);
  if (seed) await checkSeed(window);
  else if (reviewCrash) await checkBeforeReviewCrash(window);
  else if (restore) await checkRestore(window);
  else await checkReconcile(window);
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
