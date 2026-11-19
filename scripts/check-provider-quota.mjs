import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "provider-quota", 240_000,
  [["--pause"], ["--resume"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const snapshot = join(scratch, "snapshot.json");
const pausing = process.argv.includes("--pause");
const providerCalls = [];
const results = [];

process.on("unhandledRejection", error => console.error("Startup rejection", error));
app.setPath("userData", profile);
app.setPath("appData", scratch);
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
app.on("web-contents-created", (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
});
process.argv.push("--project", project);
process.env.GIT_CEILING_DIRECTORIES = scratch;

function cli(args, input) {
  const reply = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project, "--json",
    ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: scratch, encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input) }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

async function until(label, probe) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out: " + label + " · " + JSON.stringify(providerCalls));
}

function pass(message) {
  results.push(message);
  console.log("PASS " + message);
}

const show = id => cli(["show", id, "--compact"]);
const threadFor = id => "10000000-0000-0000-0000-" + id.slice(2).padStart(12, "0");
const reviewerThread = "20000000-0000-0000-0000-000000000001";
let state = pausing ? "available" : "error";
const resetsAt = Date.now() + 3600_000;
const limits = async () => ({
  provider: "Codex",
  state: state === "error" ? "error" : "ready",
  windows: state === "error" ? [] : [{ name: "Codex", remaining: state === "exhausted" ? 0 : 60, resetsAt }],
  observedAt: Date.now(),
});

async function capture(window, name) {
  const debuggerClient = window.webContents.debugger;
  debuggerClient.attach("1.3");
  try {
    await debuggerClient.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await delay(150);
    const { data } = await debuggerClient.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true });
    const png = Buffer.from(data, "base64");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 800]);
    writeFileSync(join(artifacts, name), png);
  } finally {
    debuggerClient.detach();
  }
}

async function run() {
  const ids = pausing ? (() => {
    mkdirSync(project);
    mkdirSync(profile);
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
    const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true, stdio: "ignore" });
    git("init", "-b", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "-m", "Fixture");
    cli(["init"]);
    cli(["settings"], { autoMode: false, reviewMode: "reviewer-human", taskLimits: { executor: 4, reviewer: 1 } });
    return Object.fromEntries(Object.entries({
      executor: "Исполнитель · сохранённая работа",
      reviewer: "Ревьюер · сохранённая сдача",
      ready: "Готовая карточка",
      blocked: "Заблокирована по другой причине",
      manual: "Ручное продолжение",
      stopped: "Явно остановленная задача",
    }).map(([key, title]) => {
      const { id } = cli(["create"], plannedDraft({ title }));
      cli(["approve", id]);
      return [key, id];
    }));
  })() : JSON.parse(readFileSync(snapshot, "utf8")).ids;

  if (pausing) {
    cli(["start", ids.reviewer]);
    const { token } = cli(["preview", ids.reviewer]);
    cli(["submit", ids.reviewer], { token, noChanges: true, summary: "Fixture result", checks: ["Fixture checked"] });
    cli(["block", ids.blocked], { allowUnstarted: true, reason: "Fixture block", condition: "Human decision" });
  }
  globalThis.quotaFixture = {
    limits,
    async execute(_client, _board, cwd, task, _activity, _usage, signal, beforeTurn) {
      const thread = task.codexThreadId ?? threadFor(task.id);
      const queued = await beforeTurn(thread);
      queued?.accepted("fixture-turn");
      providerCalls.push({ role: "executor", id: task.id, cwd, savedThread: task.codexThreadId });
      const done = Promise.withResolvers();
      const interrupt = () => done.resolve({ interrupted: true, reason: "Fixture interrupted" });
      signal.addEventListener("abort", interrupt, { once: true });
      return { threadId: thread, completion: done.promise, interrupt };
    },
    async review(_profile, _board, _settings, _context, _tools, _call, signal, _usage, id, onActivity,
      _team, _target, _sequence, binding) {
      providerCalls.push({ role: "reviewer", id, savedThread: binding.id });
      if (!binding.id) binding.save(reviewerThread);
      onActivity([{ id: "fixture-review", type: "agentMessage", status: "completed", title: "", text: "Fixture review context" }]);
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };

  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href))
    .replace("readCodexLimits(app.getPath(\"userData\"))", "globalThis.quotaFixture.limits()")
    .replace("missingCodexThread, startCodexRun", "missingCodexThread, startCodexRun as unusedStartCodexRun")
    .replace("codexStatus, configuredCodex,", "codexStatus, configuredCodex as unusedConfiguredCodex,")
    .replace("replyToBoard, replyToTask", "replyToBoard as unusedReplyToBoard, replyToTask")
    .replace(", reviewWithCodex,", ", reviewWithCodex as unusedReviewWithCodex,")
    .replace("      contextIsolation: true, sandbox: true", "      offscreen: true, contextIsolation: true, sandbox: true");
  const entry = join(scratch, "quota-main.mjs");
  const substitutions = `
    const { execute: startCodexRun, review: reviewWithCodex } = globalThis.quotaFixture;
    const configuredCodex = async () => ({});
    const replyToBoard = async () => ({ text: "Fixture manager response" });
  `;
  const exposed = `
    globalThis.quotaApp = { createWindow,
      refresh: () => { readProviderLimits.invalidate(); return refreshQuota(); } };
  `;
  writeFileSync(entry, transformSync(substitutions + source + exposed, { loader: "ts", format: "esm" }).code);
  require(entry);

  const loaded = async window => window && !window.webContents.isLoading() &&
    window.webContents.executeJavaScript("typeof frame !== 'undefined' && Boolean(frame.board)");
  const diagnostics = async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      console.error("Window", window.webContents.getURL(), await window.webContents.executeJavaScript(
        "JSON.stringify({ board: typeof frame !== 'undefined' && frame.board?.project, text: document.body.innerText.slice(0, 1200) })"));
    }
  };
  const first = await until("first window", async () => {
    const [window] = BrowserWindow.getAllWindows();
    return await loaded(window) && window;
  }).catch(async error => {
    await diagnostics();
    throw error;
  });
  const second = quotaApp.createWindow([project]).window;
  await until("second window", () => loaded(second));

  const render = (window, js) => window.webContents.executeJavaScript(js);
  const frame = window => render(window, "taskboard.bootstrap()");
  const launch = (window, id) => render(window, `taskboard.launchTask(${JSON.stringify(id)})`);
  const quotaText = window => render(window, "document.querySelector('#status-provider-quota').innerText");
  const percentage = window => render(window, "document.querySelector('#status-limits span').innerText");
  const waitForPause = () => until("quota status in both windows", async () =>
    (await quotaText(first)).includes("Ожидание квоты") && (await quotaText(second)).includes("Ожидание квоты"));

  if (pausing) {
    for (const id of [ids.executor, ids.manual, ids.stopped]) {
      assert.equal((await launch(first, id)).ok, true);
    }
    await until("executors and reviewer started", () => providerCalls.length === 4);
    const work = providerCalls.find(call => call.id === ids.executor).cwd;
    assert.equal(work, show(ids.executor).git.worktree);
    writeFileSync(join(work, "quota-fixture.txt"), "Preserved work");
    const saved = { ids, work, executor: show(ids.executor), manual: show(ids.manual), reviewer: show(ids.reviewer) };
    state = "error";
    await quotaApp.refresh();
    assert.equal((await frame(first)).quotaWait, undefined);
    assert.equal((await frame(first)).runningTasks.includes(ids.executor), true);
    pass("A provider read failure leaves the running executor and review slot unchanged.");

    const { codexRpc } = require("../src/desktop/codex-rpc.ts");
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    const rpc = codexRpc(child, () => {});
    try {
      const notifyError = async codexErrorInfo => {
        child.stdout.write(JSON.stringify({
          method: "error", params: { error: { message: "Quota exhausted", codexErrorInfo } },
        }) + "\n");
        await rpc.receive();
      };
      await notifyError("other");
      assert.equal((await frame(first)).quotaWait, undefined);
      await notifyError("usageLimitExceeded");
      await waitForPause();
      assert.deepEqual((await frame(first)).quotaWait, {});
    } finally {
      rpc.close();
      child.stdin.destroy();
    }
    state = "exhausted";
    await quotaApp.refresh();
    await waitForPause();
    await until("executor and reviewer stopped", async () => {
      const view = await frame(first);
      return !view.runningTasks.length && !Object.keys(view.reviewingTasks).length && view.waitingTasks.includes(ids.executor);
    });
    const stopped = await render(second, `taskboard.chatStop(${JSON.stringify(ids.stopped)})`);
    assert.equal(stopped.ok, true);
    await until("zero quota in the limits control", async () =>
      (await percentage(first)).endsWith(" 0%") && (await percentage(second)).endsWith(" 0%"));
    assert.equal((await launch(first, ids.ready)).error.code, "PROVIDER_QUOTA");
    assert.equal((await launch(second, ids.ready)).error.code, "PROVIDER_QUOTA");
    for (const window of [first, second]) {
      const view = await frame(window);
      assert.equal(view.board.settings.autoMode, false);
      assert.deepEqual(new Set(view.quotaTasks), new Set([ids.executor, ids.reviewer, ids.ready, ids.manual]));
      assert.equal((await quotaText(window)).includes("сброс"), true);
    }
    cli(["settings"], { autoMode: true });
    await until("saved auto-mode shown", async () => (await frame(first)).board.settings.autoMode);
    await delay(1600);
    assert.equal(providerCalls.length, 4);
    assert.equal(show(ids.executor).status, "in_progress");
    assert.equal(show(ids.reviewer).status, "review");
    assert.equal(show(ids.ready).status, "ready");
    assert.equal(show(ids.blocked).status, "blocked");
    pass("Only the structured quota error paused dispatch before the next snapshot. Both windows show 0%, the reset time and the waiting cards. Both manual starts were denied and the scheduler did not retry.");
    await capture(first, "quota-paused.png");
    writeFileSync(snapshot, JSON.stringify({ ...saved, results }));
  } else {
    const saved = JSON.parse(readFileSync(snapshot, "utf8"));
    await quotaApp.refresh();
    await waitForPause();
    assert.equal((await frame(first)).board.settings.autoMode, true);
    assert.equal(providerCalls.length, 0);
    cli(["settings"], { autoMode: false });
    await until("auto-mode off", async () => !(await frame(first)).board.settings.autoMode);

    state = "available";
    await quotaApp.refresh();
    await until("quota notice cleared", async () => !(await frame(first)).quotaWait && !(await frame(second)).quotaWait);
    await until("confirmed quota in both limits controls", async () =>
      (await percentage(first)).endsWith(" 60%") && (await percentage(second)).endsWith(" 60%"));
    await until("hybrid reviewer resumes with auto-mode off", () => providerCalls.some(call => call.role === "reviewer"));
    assert.equal(providerCalls.find(call => call.role === "reviewer").savedThread, reviewerThread);
    assert.equal(providerCalls.filter(call => call.role === "executor").length, 0);
    assert.equal(show(ids.executor).codexThreadId, saved.executor.codexThreadId);
    assert.equal(show(ids.reviewer).result.summary, saved.reviewer.result.summary);
    assert.equal((await launch(second, ids.manual)).ok, true);
    assert.equal(providerCalls.find(call => call.id === ids.manual).savedThread, saved.manual.codexThreadId);
    pass("Pause survives Electron restart and a provider failure. With auto-mode off, hybrid review resumes and an executor can be resumed manually in its saved thread.");

    cli(["settings"], { autoMode: true });
    await until("executor and eligible queue launched", () => providerCalls.filter(call => call.role === "executor").length === 3);
    const resumed = providerCalls.find(call => call.id === ids.executor);
    assert.equal(resumed.savedThread, saved.executor.codexThreadId);
    assert.equal(resumed.cwd, saved.work);
    assert.equal(readFileSync(join(saved.work, "quota-fixture.txt"), "utf8"), "Preserved work");
    assert.equal(show(ids.blocked).status, "blocked");
    await delay(1600);
    assert.equal(providerCalls.length, 4);
    assert.equal(providerCalls.some(call => call.id === ids.stopped), false);
    assert.equal(show(ids.stopped).status, "in_progress");
    pass("Auto-mode resumes the original executor in the saved worktree and thread, starts the eligible card once, and leaves explicit stops and unrelated blocks alone.");
    await capture(first, "quota-resumed.png");

    const files = [
      "src/cli/acceptance.ts", "src/desktop/main.ts", "src/desktop/board-runtime.ts", "src/desktop/codex-chat.ts",
      "src/desktop/codex-rpc.ts", "src/desktop/reviewer-chat.ts", "src/desktop/provider-limits.ts", "src/desktop/renderer.js",
      "src/desktop/index.html", "src/desktop/locales/en.json", "src/desktop/locales/ru.json",
      "scripts/check-provider-quota.mjs", "tests/provider-limits.test.ts",
    ];
    const hashes = files.map(file => {
      const text = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
      return createHash("sha256").update(text).digest("hex") + "  " + file;
    });
    const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const report = [
      "Test checkout HEAD: " + testedRevision,
      `Windows Electron ${process.versions.electron}, Node ${process.versions.node}, viewport 1280×800`,
      "Command: node scripts/check-provider-quota.mjs --artifacts .tasks/qa",
      "Windows: two Electron windows and a full process restart; PNGs captured by the Chromium compositor.",
      "Linux and macOS: no GUI or packaging run. Paths use node:path and no OS-specific task lifecycle was added.",
      "Real main process, renderer, task CLI and runtime. Controlled provider snapshots and turns.",
      ...saved.results, ...results,
      "SHA-256 of tested UTF-8 sources with LF line endings:", ...hashes, "",
    ];
    writeFileSync(join(artifacts, "quota-check.txt"), report.join("\n"));
  }
  assert.equal(existsSync(join(profile, "codex-quota-wait.json")), pausing);
  app.exit(0);
}

void run().catch(error => {
  console.error(error);
  app.exit(1);
});
