import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts, keepArtifacts } = electronCheck(
  import.meta.url, "codex-usage-recovery", 90_000, [["--seed"], ["--recover"]],
);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const node = process.env.TASKBOARD_CHECK_NODE;
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const profile = join(scratch, "profile");
const providerPath = join(scratch, "fixture.cjs");
const historyPath = join(scratch, "history.json");
const fragmentPath = join(scratch, "history-fragment.jsonl");
const observationsPath = join(scratch, "observations.jsonl");
const seed = process.argv.includes("--seed");
const projectPath = join(scratch, "board");
const limits = { codexDailyTokens: 200_000, codexDailyResetTime: "09:00", reviewMode: "human", autoMode: false };
const turnId = "fixture-turn";
const threads = Object.fromEntries(
  ["interrupted", "failed", "history", "unknown", "active", "old"].map(
    (name, index) => [name, "12345678-0000-4000-8000-" + String(index + 1).padStart(12, "0")],
  ),
);

function cli(project, command, input) {
  const args = [cliPath, "--project", project, "--json", command];
  if (input !== undefined) args.push("--stdin");
  const result = JSON.parse(execFileSync(node, args, {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function init(project) {
  mkdirSync(project);
  const git = (...args) => execFileSync("git", ["-C", project, ...args], { windowsHide: true });
  git("init", "-b", "main");
  git("-c", "user.name=Taskboard", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
  cli(project, "init");
  cli(project, "settings", limits);
}

function provider() {
  const { appendFileSync, readFileSync } = require("node:fs");
  const { createInterface } = require("node:readline");
  const [historyPath, observationsPath, fragmentThread, fragmentPath] = process.argv.slice(2);
  let threadId;
  createInterface({ input: process.stdin }).on("line", line => {
    const { method, id, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    if (method === "thread/read") {
      threadId = params.threadId;
      const history = JSON.parse(readFileSync(historyPath, "utf8"));
      const active = history[threadId]?.some(turn => turn.status === "inProgress");
      result = { thread: {
        id: threadId,
        status: { type: active ? "active" : "idle" },
        path: threadId === fragmentThread ? fragmentPath : null,
      } };
    }
    if (method === "thread/turns/list") {
      const history = JSON.parse(readFileSync(historyPath, "utf8"));
      result = { data: history[params.threadId ?? threadId] ?? [], nextCursor: null };
    }
    appendFileSync(observationsPath, JSON.stringify({ method, threadId, pid: process.pid }) + "\n");
    console.log(JSON.stringify({ id, result }));
  });
}

function writeHistoryFragment(at, resolved = false) {
  const total = { total_tokens: 35, input_tokens: 30, output_tokens: 5 };
  const last = { total_tokens: 7, input_tokens: 2, output_tokens: 5 };
  if (resolved) {
    total.cached_input_tokens = 10;
    last.cached_input_tokens = 0;
  }
  const events = [
    { type: "session_meta", payload: { id: threads.history } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    {
      type: "event_msg",
      timestamp: new Date(at).toISOString(),
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: last },
      },
    },
  ];
  writeFileSync(fragmentPath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
}

const clockPath = join(scratch, "clock.json");
if (seed) {
  init(projectPath);
  init(join(scratch, "other-board"));
  mkdirSync(profile);
  writeFileSync(providerPath, "(" + provider.toString() + ")();\n");
  writeFileSync(historyPath, "{}");
  // Keep the fixture near 09:00 regardless of the wall clock.
  const beforeReset = new Date();
  beforeReset.setHours(8, 59, 59, 0);
  writeFileSync(clockPath, JSON.stringify(beforeReset.getTime()));
  writeHistoryFragment(beforeReset.getTime() - 500);
}

const project = realpathSync(projectPath);
const other = realpathSync(join(scratch, "other-board"));
const before = JSON.parse(readFileSync(clockPath, "utf8"));
const after = before + 2_000;
const old = new Date(before);
old.setDate(old.getDate() - 3);
const oldAt = old.getTime();
let clock = before;
app.setPath("appData", scratch);
app.setPath("userData", profile);
app.requestSingleInstanceLock = () => true;
globalThis.usageCheckClock = () => clock;
globalThis.usageCheckClient = {
  path: node, args: [providerPath, historyPath, observationsPath, threads.history, fragmentPath],
};

const source = new URL("../src/desktop/main.ts", import.meta.url);
const main = readFileSync(source, "utf8");
assert.ok(main.includes("codexStatus, configuredCodex,"));
assert.ok(main.includes("function recoverBoardUsage(watch: BoardWatch)"));
const instrumented = main
  .replace("codexStatus, configuredCodex,", "codexStatus,")
  .replace("          recoverBoardUsage(watch);", "          // Driven explicitly by the fixture clock.")
  .replace(
    /(function recoverBoardUsage\(watch: BoardWatch\) \{[\s\S]*?)Date\.now\(\)/,
    "$1globalThis.usageCheckClock()",
  )
  .replaceAll("import.meta.url", JSON.stringify(source.href))
  .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, source).href))
  .concat("\nconst configuredCodex = async () => globalThis.usageCheckClient;\n")
  .concat("globalThis.usageCheck = { createWindow, subscriptions, recoverBoardUsage, boardUsage, usageForBoard, usageWriter, saveDailyUsage };\n");
const entry = join(scratch, "usage-check-main.mjs");
writeFileSync(entry, require("esbuild").transformSync(instrumented, { loader: "ts", format: "esm" }).code);
process.argv.push("--project", project);
await import(pathToFileURL(entry).href);
const hooks = globalThis.usageCheck;

function records() {
  if (!existsSync(observationsPath)) return [];
  return readFileSync(observationsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function row(name) {
  const db = new DatabaseSync(join(project, ".tasks", "codex-daily-usage", "usage.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM turns WHERE id = ?").get(JSON.stringify([threads[name], turnId]));
  } finally {
    db.close();
  }
}

async function until(action, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = await action();
    if (result) return result;
    await wait(40);
  }
  throw new Error("Timed out: " + label);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function localDay(at) {
  return new Date(at).toISOString();
}

function frame(window) {
  return window.webContents.executeJavaScript("window.taskboard?.bootstrap()");
}

function assertBudget(board, at, spent) {
  const budget = hooks.usageForBoard(board).get(limits.codexDailyTokens, at, limits.codexDailyResetTime);
  assert.equal(budget.spent, spent, "spent at " + localDay(at));
  assert.equal(budget.remaining, limits.codexDailyTokens - spent);
}

const writer = hooks.usageWriter(project, async report => hooks.saveDailyUsage(project, "manager", report));
function collect(name, tokens, at) {
  const threadId = threads[name];
  const usage = new CodexTokenUsage(writer.observe, writer.recover);
  usage.track(threadId, "fixture", true);
  usage.begin(threadId, turnId);
  const total = {
    totalTokens: tokens + 10,
    inputTokens: tokens + 5,
    cachedInputTokens: 10,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  usageSample(usage, name, total, total, at);
  return usage;
}

function usageSample(usage, name, total, last, at) {
  usage.observe({
    method: "thread/tokenUsage/updated",
    params: { threadId: threads[name], turnId, tokenUsage: { total, last } },
  }, at);
}

function terminal(usage, name, status, at) {
  return usage.observe({
    method: "turn/completed",
    params: { threadId: threads[name], turn: { id: turnId, status, completedAt: at / 1000 } },
  }, at);
}

async function checkpoint(name, amount, at, status) {
  const usage = collect(name, amount, status ? at - 1000 : at);
  if (status) {
    const total = { totalTokens: amount + 16, inputTokens: amount + 10, outputTokens: 6 };
    const last = { totalTokens: 6, inputTokens: 5, outputTokens: 1 };
    usageSample(usage, name, total, last, at - 500);
    const report = terminal(usage, name, status, at);
    assert.equal(report.records[0].incomplete, true, name + " partial provider counters");
    await usage.save(report, writer);
    await usage.save(terminal(usage, name, status, at), writer);
    await writer(report);
  } else {
    await usage.save(usage.finish(true), writer);
  }
}

async function poll(watch, at) {
  clock = at;
  hooks.recoverBoardUsage(watch);
  hooks.recoverBoardUsage(watch);
  await until(() => !watch.usageRecovery?.running, "background reconciliation");
  hooks.usageForBoard(project).flush();
}

async function check() {
  const first = await until(async () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win && (await frame(win))?.board?.project === project) return win;
  }, "board window");
  assert.equal(first.webContents.getLastWebPreferences().sandbox, true);
  if (seed) {
    await checkpoint("interrupted", 94_059, before, "interrupted");
    await checkpoint("failed", 14, before, "failed");
    await checkpoint("history", 18, before);
    await checkpoint("unknown", 24_929, before);
    await checkpoint("active", 23, before);
    await checkpoint("old", 30, oldAt);
    assert.equal(hooks.usageForBoard(project).flush(), true);
    const immediate = Object.fromEntries(["interrupted", "failed"].map(name => [name, row(name).recovery_pending]));
    console.log("Live terminal state:", immediate);
    assert.deepEqual(immediate, { interrupted: 0, failed: 0 });
    assertBudget(project, before, 119_043);
    assertBudget(project, after, 0);
    assertBudget(project, oldAt, 30);
    return;
  }

  const second = hooks.createWindow([project], project);
  await second.ready;
  assert.equal((await frame(second.window)).board.project, project);
  const watch = hooks.subscriptions.get(project);
  assert.equal(watch.tabs.size, 2);
  const third = hooks.createWindow([other], other);
  await third.ready;
  assert.equal((await frame(third.window)).board.project, other);
  assertBudget(other, before, 0);
  assertBudget(project, before, 119_043);
  assertBudget(project, after, 0);

  const historicalTurn = (status, when) => ({
    id: turnId, status, ...(when === undefined ? {} : { completedAt: when / 1000 }), items: [],
  });
  const configure = (unknown, active) => writeFileSync(historyPath, JSON.stringify({
    [threads.history]: [historicalTurn("interrupted", before)],
    [threads.unknown]: unknown ? [historicalTurn("failed")] : [],
    [threads.active]: [historicalTurn(active ? "completed" : "inProgress", active ? after : undefined)],
  }));
  configure(false, false);
  for (const minute of [0, 1, 2, 3, 4]) await poll(watch, after + minute * 60_000);
  assert.equal(row("history").recovery_pending, 0);
  assert.equal(row("history").completed, before);
  assert.equal(row("history").tokens, 18);
  assert.equal(row("unknown").completed, null);
  assert.equal(row("active").completed, null);
  const reads = name => records().filter(event => event.method === "thread/read" && event.threadId === threads[name]).length;
  assert.equal(reads("unknown"), 1);
  assert.ok(reads("active") > 1);
  assert.equal(reads("old"), 0);
  assert.equal(row("unknown").tokens, 24_929);

  configure(true, true);
  for (const minute of [17, 18, 19, 20]) await poll(watch, after + minute * 60_000);
  assert.equal(row("unknown").recovery_pending, 0);
  assert.equal(row("unknown").completed, null);
  assert.equal(row("active").recovery_pending, 0);
  assert.equal(row("active").completed, after);

  writeHistoryFragment(before - 500, true);
  const restoreHistory = new CodexTokenUsage(writer.observe, writer.recover);
  const lateHistory = await restoreHistory.recoverRollout(
    fragmentPath, threads.history, historicalTurn("interrupted", before),
  );
  assert.ok(lateHistory);
  await restoreHistory.save(lateHistory, writer);
  await writer(lateHistory);
  assert.equal(row("history").recovery_pending, 0);
  assert.equal(row("history").completed, before);
  assert.equal(row("history").tokens, 25);
  assertBudget(project, before, 119_050);

  const rollout = join(scratch, "old-rollout.jsonl");
  const event = payload => ({ type: "event_msg", timestamp: localDay(oldAt), payload });
  const counters = { total_tokens: 52, input_tokens: 47, cached_input_tokens: 10, output_tokens: 5 };
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: threads.old } },
    event({ type: "task_started", turn_id: turnId }),
    event({ type: "token_count", info: { total_token_usage: counters, last_token_usage: counters } }),
    event({ type: "task_complete", turn_id: turnId }),
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const late = new CodexTokenUsage(writer.observe, writer.recover);
  const lateReport = await late.recoverRollout(rollout, threads.old, { id: turnId });
  assert.ok(lateReport);
  await late.save(lateReport, writer);
  assert.equal(hooks.usageForBoard(project).flush(), true);
  assert.equal(row("old").recovery_pending, 0);
  assertBudget(project, oldAt, 42);
  assertBudget(project, before, 119_050);
  assertBudget(project, after, 0);
  assertBudget(other, before, 0);

  const recoveryPids = [...new Set(records().map(event => event.pid))];
  assert.ok(recoveryPids.length > 0);
  await until(() => recoveryPids.every(pid => !alive(pid)), "App Server processes released");
  second.window.destroy();
  assert.equal(watch.tabs.size, 1);
  first.destroy();
  await until(() => !hooks.subscriptions.has(project) && !hooks.boardUsage.has(project), "watch and usage released");
  const reopened = hooks.createWindow([project], project);
  await reopened.ready;
  assertBudget(project, before, 119_050);
  const reopenedWatch = hooks.subscriptions.get(project);
  assert.notEqual(reopenedWatch, watch);
  const previousReads = records().length;
  await poll(reopenedWatch, after + 21 * 60_000);
  assert.equal(records().length, previousReads);
  reopened.window.destroy();
  await until(() => !hooks.subscriptions.has(project) && !hooks.boardUsage.has(project), "reopened watch and usage released");

  const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
  });
  const sources = new Set([
    "scripts/check-codex-usage-recovery.mjs", "scripts/electron-check.mjs", "src/desktop/main.ts",
    "src/desktop/codex-token-usage.ts", "src/desktop/codex-daily-budget.ts",
    ...changed.trimEnd().split("\n").filter(Boolean).map(line => line.slice(3).trim()).filter(path => existsSync(fileURLToPath(new URL("../" + path, import.meta.url)))),
  ]);
  const lines = [
    "# Windows Electron — сверка расходов Codex",
    "",
    "- Живые interrupted и failed закрыты после полного замера и следующего замера без счётчика чтения из кэша. Разбивка помечена неполной. Повтор события и отчёта не изменил 94 059 и 14.",
    "- После перезапуска исход восстановлен из истории при наличии датированного неполного token_count. Сверка закрылась с 18 токенами. Поздний полный замер и его повтор дали 25 токенов с прежней датой окончания.",
    "- Неизвестный исход сохранил 24 929 без времени завершения и опрошен один раз за первые пять циклов. Поздний статус закрыл его без подстановки времени.",
    "- Длительный активный ход опрашивался повторно. После поступления истории его сверка закрылась с датой из истории.",
    "- Старый ход не попал в фоновый поиск. Поздний отчёт довёл его начисление с 30 до 42, сохранив историческую дату.",
    "- До сброса учтено 119 043, после позднего уточнения 119 050. В новом периоде и на другой доске расход остался нулевым.",
    "- Два окна разделяли одного наблюдателя. После закрытия и повторного открытия наблюдатель и кэш удалены оба раза, процессы тестового App Server завершились.",
    "",
    "## Технические детали",
    "",
    "Команда: node scripts/check-codex-usage-recovery.mjs --artifacts .tasks/qa",
    "",
    "Windows " + process.getSystemVersion() + ", Electron " + process.versions.electron + ", Node " + process.versions.node + " (в Electron).",
    "",
    "База Git: " + execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    }).trim(),
    "",
    "SHA-256 исходных байтов рабочего дерева:",
    ...[...sources].sort().map(path => {
      const sha = createHash("sha256").update(readFileSync(new URL("../" + path, import.meta.url))).digest("hex");
      return "- " + sha + "  " + path;
    }),
  ];
  const report = lines.join("\n") + "\n";
  if (keepArtifacts) writeFileSync(join(artifacts, "reconciliation.md"), report);
  console.log(report);
}

void app.whenReady().then(check).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
