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
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "provider-quota", 240_000,
  [["--pause"], ["--resume"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const snapshot = join(scratch, "snapshot.json");
const pausing = process.argv.includes("--pause");
const providerCalls = [];
const results = [];
const beforeLink = Promise.withResolvers();
const repairCalls = [];
const returnSaved = Promise.withResolvers();
const releaseReturn = Promise.withResolvers();
const newChatStarting = new Map();
const { registerRuntime, runtimeEntries } = require("../src/desktop/board-runtime.ts");

process.on("unhandledRejection", error => console.error("Startup rejection", error));
app.setPath("userData", profile);
app.setPath("appData", scratch);
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
dialog.showMessageBox = async () => ({ response: 1 });
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
const { codexLimitSnapshot } = require("../src/desktop/provider-limits.ts");
const limits = async () => {
  if (state === "error") return { provider: "Codex", state: "error", windows: [] };
  const resetSeconds = resetsAt / 1000;
  const primary = { usedPercent: state === "exhausted" ? 100 : 40, resetsAt: resetSeconds };
  let secondary = null;
  if (state === "exhausted") secondary = { usedPercent: 100, resetsAt: Date.now() / 1000 - 1 };
  if (state === "partial") secondary = { usedPercent: "40", resetsAt: resetSeconds };
  return codexLimitSnapshot({ rateLimits: { primary, secondary } });
};

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
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-m", "Fixture");
    cli(["init"]);
    cli(["settings"], { autoMode: false, reviewMode: "reviewer-human", taskLimits: { executor: 7, reviewer: 2 } });
    return Object.fromEntries(Object.entries({
      executor: "Исполнитель · сохранённая работа",
      reviewer: "Ревьюер · сохранённая сдача",
      ready: "Готовая карточка",
      prelink: "Пауза до первого чата",
      returned: "Возврат до слота",
      returnedDuringPause: "Возврат при исчерпанной квоте",
      newChatAuto: "Новый чат · авторежим",
      newChatManual: "Новый чат · вручную",
      repair: "Ремонт приёмки",
      blocked: "Заблокирована по другой причине",
      manual: "Ручное продолжение",
      stopped: "Явно остановленная задача",
    }).map(([key, title]) => {
      const { id } = cli(["create"], plannedDraft({ title }));
      confirmFixtureDraft(project, id);
      cli(["approve", id]);
      return [key, id];
    }));
  })() : JSON.parse(readFileSync(snapshot, "utf8")).ids;

  if (pausing) {
    cli(["start", ids.reviewer]);
    const { token } = cli(["preview", ids.reviewer]);
    cli(["submit", ids.reviewer], { token, noChanges: true, summary: "Fixture result", checks: ["Fixture checked"] });
    const prepared = cli(["start", ids.repair]);
    writeFileSync(join(prepared.worktree, "repair-fixture.txt"), "Acceptance repair fixture");
    const repairPreview = cli(["preview", ids.repair]);
    cli(["submit", ids.repair], {
      token: repairPreview.token, message: "test: prepare repair scenario",
      summary: "Fixture repair result", checks: ["Fixture checked"],
    });
    const { locateBoard, onBoard } = require("../src/cli/storage.ts");
    onBoard(locateBoard(project), store => {
      const card = store.card(ids.repair);
      const targetHead = execFileSync("git", ["rev-parse", "main"], { cwd: project, encoding: "utf8" }).trim();
      store.save({ ...card, acceptanceRepair: { phase: "queued", targetHead, attempts: 0, message: "Fixture repair" } });
    });
    for (const id of [ids.returned, ids.returnedDuringPause]) {
      const { worktree } = cli(["start", id]);
      cli(["update", id], { codexThreadId: threadFor(id) });
      writeFileSync(join(worktree, "saved-work.txt"), "Preserve the review worktree");
      const { token } = cli(["preview", id]);
      cli(["submit", id], {
        token, message: "test: prepare returned work", summary: "Review result before quota", checks: ["Fixture checked"],
      });
      onBoard(locateBoard(project), store => {
        const card = store.card(id);
        store.save({ ...card, reviewModeOverride: { mode: "human", version: 1 } });
      });
    }
    for (const id of [ids.newChatAuto, ids.newChatManual]) {
      cli(["start", id]);
      const oldThread = "30000000-0000-0000-0000-" + id.slice(2).padStart(12, "0");
      cli(["update", id], { codexThreadId: oldThread });
      cli(["block", id], { reason: "thread " + oldThread + " already has an active writer", condition: "Choose a new chat." });
    }
    cli(["block", ids.blocked], { allowUnstarted: true, reason: "Fixture block", condition: "Human decision" });
  }
  for (const id of [ids.newChatAuto, ids.newChatManual]) {
    newChatStarting.set(id, Promise.withResolvers());
  }
  globalThis.quotaFixture = {
    limits,
    async afterCli(args, result) {
      if (pausing && args[1][0] === "request-changes" && args[1][1] === ids.returned && result.ok) {
        returnSaved.resolve(result.data);
        await releaseReturn.promise;
      }
    },
    async manager(_profile, _project, prompt, _images, _action, _tools, _instructions, signal) {
      if (!prompt.startsWith("Resolve the pending acceptance conflict")) return { text: "Fixture manager response" };
      repairCalls.push(prompt);
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    async execute(_client, _board, cwd, task, _activity, _usage, signal, beforeTurn) {
      if (pausing && newChatStarting.has(task.id)) {
        assert.equal(task.codexThreadId, undefined);
        newChatStarting.get(task.id).resolve(cwd);
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (pausing && task.id === ids.prelink) {
        beforeLink.resolve(cwd);
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
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
    .replace("import { callCli, cliChild, cliFailure }", "import { callCli as realCallCli, cliChild, cliFailure }")
    .replace("missingCodexThread, startCodexRun", "missingCodexThread, startCodexRun as unusedStartCodexRun")
    .replace("codexStatus, configuredCodex,", "codexStatus, configuredCodex as unusedConfiguredCodex,")
    .replace("replyToBoard, replyToTask", "replyToBoard as unusedReplyToBoard, replyToTask")
    .replace(", reviewWithCodex,", ", reviewWithCodex as unusedReviewWithCodex,")
    .replace("      contextIsolation: true, sandbox: true", "      offscreen: true, contextIsolation: true, sandbox: true");
  const entry = join(scratch, "quota-main.mjs");
  const substitutions = `
    const { execute: startCodexRun, review: reviewWithCodex } = globalThis.quotaFixture;
    const configuredCodex = async () => ({});
    const replyToBoard = globalThis.quotaFixture.manager;
    const callCli = async (...args) => {
      const result = await realCallCli(...args);
      await globalThis.quotaFixture.afterCli(args, result);
      return result;
    };
  `;
  const exposed = `
    globalThis.quotaApp = { createWindow, scheduleRecurringTasks,
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
  const launch = (window, id, options = {}) =>
    render(window, `taskboard.launchTask(${JSON.stringify(id)}, ${JSON.stringify(options)})`);
  const quotaText = window => render(window, "document.querySelector('#status-provider-quota').innerText");
  const percentage = window => render(window, "document.querySelector('#status-limits span').innerText");
  const openRepair = window => render(window, `showReview(frame.board.tasks.find(task => task.id === ${JSON.stringify(ids.repair)}))`);
  const repairLabel = window => render(window, "document.querySelector('#acceptance-repair-status')?.textContent");
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
    const saved = {
      ids, work, executor: show(ids.executor), manual: show(ids.manual), reviewer: show(ids.reviewer),
      returned: show(ids.returned), returnedDuringPause: show(ids.returnedDuringPause),
      newChatAuto: show(ids.newChatAuto), newChatManual: show(ids.newChatManual),
    };
    state = "error";
    await quotaApp.refresh();
    assert.equal((await frame(first)).quotaWait, undefined);
    assert.equal((await frame(first)).runningTasks.includes(ids.executor), true);
    pass("A provider read failure leaves the running executor and review slot unchanged.");

    quotaApp.scheduleRecurringTasks();
    await until("acceptance repair starts", () => repairCalls.length === 1);
    const firstLaunch = launch(second, ids.prelink);
    const firstWorktree = await Promise.race([
      beforeLink.promise,
      firstLaunch.then(result => { throw new Error("The provider returned before the pre-link pause: " + JSON.stringify(result)); }),
    ]);
    const prelink = show(ids.prelink);
    assert.equal(prelink.status, "in_progress");
    assert.equal(prelink.codexThreadId, undefined);
    assert.equal(prelink.git.worktree, firstWorktree);

    const newChatLaunches = [ids.newChatAuto, ids.newChatManual].map(id => launch(first, id, { newThread: true }));
    for (const id of [ids.newChatAuto, ids.newChatManual]) {
      const newCwd = await newChatStarting.get(id).promise;
      assert.equal(newCwd, show(id).git.worktree);
    }
    const returnLaunch = render(second, `taskboard.command("request-changes", ${JSON.stringify(ids.returned)}, {
      revision: ${saved.returned.revision}, reason: "Keep this reviewer feedback after quota"
    })`);
    const returnedCard = await returnSaved.promise;
    assert.equal(returnedCard.status, "in_progress");
    assert.equal(runtimeEntries(project).some(entry => entry.kind === "slot" && entry.task === ids.returned), false);

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
      releaseReturn.resolve();
      assert.equal((await returnLaunch).error.code, "PROVIDER_QUOTA");
      assert.equal((await firstLaunch).error.code, "PROVIDER_QUOTA");
      for (const result of await Promise.all(newChatLaunches)) {
        assert.equal(result.error.code, "PROVIDER_QUOTA");
      }
    } finally {
      rpc.close();
      child.stdin.destroy();
    }
    state = "exhausted";
    await quotaApp.refresh();
    await waitForPause();
    await until("executor and reviewer stopped", async () => {
      const view = await frame(first);
      return !view.runningTasks.length && !Object.keys(view.reviewingTasks).length &&
        view.waitingTasks.includes(ids.executor) && view.waitingTasks.includes(ids.prelink) &&
        view.waitingTasks.includes(ids.returned) && view.waitingTasks.includes(ids.newChatAuto) &&
        view.waitingTasks.includes(ids.newChatManual) &&
        view.board.tasks.find(task => task.id === ids.repair)?.acceptanceRepair?.phase === "queued";
    });
    const stopped = await render(second, `taskboard.chatStop(${JSON.stringify(ids.stopped)})`);
    assert.equal(stopped.ok, true);
    await until("zero quota in the limits control", async () =>
      (await percentage(first)).endsWith(" 0%") && (await percentage(second)).endsWith(" 0%"));
    const pausedReturn = await render(second, `taskboard.command("request-changes", ${JSON.stringify(ids.returnedDuringPause)}, {
      revision: ${saved.returnedDuringPause.revision}, reason: "Keep the feedback sent during the active pause"
    })`);
    assert.equal(pausedReturn.ok, true, JSON.stringify(pausedReturn));
    assert.equal(pausedReturn.data.status, "in_progress");
    assert.equal(show(ids.returnedDuringPause).status, "in_progress");
    const pausedQueue = runtimeEntries(project).find(entry => entry.kind === "queue" && entry.task === ids.returnedDuringPause);
    assert.equal(pausedQueue?.quotaPaused, true);
    assert.equal(pausedQueue?.revision, pausedReturn.data.revision);
    await until("return made during quota wait is visible in both windows", async () =>
      (await frame(first)).quotaTasks.includes(ids.returnedDuringPause) &&
      (await frame(second)).quotaTasks.includes(ids.returnedDuringPause));
    assert.equal(providerCalls.some(call => call.id === ids.returnedDuringPause), false);
    await capture(second, "quota-return-during-pause.png");
    assert.equal((await launch(first, ids.ready)).error.code, "PROVIDER_QUOTA");
    assert.equal((await launch(second, ids.ready)).error.code, "PROVIDER_QUOTA");
    for (const window of [first, second]) {
      const view = await frame(window);
      assert.equal(view.board.settings.autoMode, false);
      assert.deepEqual(new Set(view.quotaTasks), new Set([
        ids.executor, ids.reviewer, ids.ready, ids.manual, ids.prelink, ids.repair,
        ids.returned, ids.returnedDuringPause, ids.newChatAuto, ids.newChatManual,
      ]));
      assert.equal((await quotaText(window)).includes("сброс"), true);
    }
    for (const id of [ids.newChatAuto, ids.newChatManual]) {
      const entry = runtimeEntries(project).find(entry => entry.kind === "queue" && entry.task === id);
      assert.equal(entry.newThread, "user");
      assert.equal(entry.restart, undefined);
    }
    const returnedQueue = runtimeEntries(project).find(entry => entry.kind === "queue" && entry.task === ids.returned);
    assert.equal(returnedQueue.quotaPaused, true);
    assert.equal(returnedQueue.revision, returnedCard.revision);
    await openRepair(second);
    assert.match(await repairLabel(second), /Ожидание квоты.*сброс/);
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
    pass("Quota interrupted the first launch before its chat was linked, and the acceptance repair returned to its queue with the quota reset label.");
    pass("Quota during request-changes preserved feedback before a slot was acquired. Both explicit new-chat choices were saved before linking their IDs.");
    writeFileSync(snapshot, JSON.stringify({ ...saved, firstWorktree, results }));
  } else {
    const saved = JSON.parse(readFileSync(snapshot, "utf8"));
    await quotaApp.refresh();
    await waitForPause();
    assert.equal((await frame(first)).board.settings.autoMode, true);
    assert.equal(providerCalls.length, 0);
    for (const id of [ids.returned, ids.returnedDuringPause, ids.newChatAuto, ids.newChatManual]) {
      assert.equal(runtimeEntries(project).some(entry => entry.kind === "queue" && entry.task === id), true);
    }
    cli(["settings"], { autoMode: false, taskLimits: { executor: 1, reviewer: 2 } });
    await until("auto-mode off", async () => !(await frame(first)).board.settings.autoMode);
    const releaseExecutor = registerRuntime(project, { kind: "slot", role: "executor" });
    assert.ok(releaseExecutor);

    await openRepair(second);
    assert.match(await repairLabel(second), /Ожидание квоты.*сброс/);
    state = "partial";
    await quotaApp.refresh();
    assert.ok((await frame(first)).quotaWait);
    assert.equal(providerCalls.length, 0);
    assert.match(await repairLabel(second), /Ожидание квоты/);
    state = "available";
    await quotaApp.refresh();
    await until("quota notice cleared", async () => !(await frame(first)).quotaWait && !(await frame(second)).quotaWait);
    await until("repair sheet returns to its normal label", async () => {
      const label = await repairLabel(second);
      return label && !label.includes("Ожидание квоты");
    });
    await until("confirmed quota in both limits controls", async () =>
      (await percentage(first)).endsWith(" 60%") && (await percentage(second)).endsWith(" 60%"));
    await until("hybrid reviewer resumes with auto-mode off", () => providerCalls.some(call => call.role === "reviewer"));
    assert.equal(providerCalls.find(call => call.role === "reviewer").savedThread, reviewerThread);
    assert.equal(providerCalls.filter(call => call.role === "executor").length, 0);
    for (const window of [first, second]) {
      const view = await frame(window);
      assert.ok(view.waitingTasks.includes(ids.returned));
      assert.ok(view.waitingTasks.includes(ids.returnedDuringPause));
    }
    const executorIds = () => providerCalls.filter(call => call.role === "executor").map(call => call.id);
    releaseExecutor();
    await until("one review return launches after a slot becomes free", () => executorIds().length === 1);
    assert.ok([ids.returned, ids.returnedDuringPause].includes(executorIds()[0]));
    cli(["settings"], { taskLimits: { executor: 2, reviewer: 2 } });
    await until("the second review return launches with another free slot", () => executorIds().length === 2);
    assert.deepEqual(executorIds().sort(), [ids.returned, ids.returnedDuringPause].sort());
    assert.equal(show(ids.ready).status, "ready");
    cli(["settings"], { taskLimits: { executor: 8, reviewer: 2 } });
    pass("With auto-mode off after restart, both review returns waited for confirmed quota and a free executor slot, then each launched once. The ordinary ready card stayed ready.");
    assert.equal(show(ids.executor).codexThreadId, saved.executor.codexThreadId);
    assert.equal(show(ids.reviewer).result.summary, saved.reviewer.result.summary);
    assert.equal((await launch(second, ids.newChatManual)).ok, true);
    const manualNewChat = providerCalls.find(call => call.id === ids.newChatManual);
    assert.equal(manualNewChat.savedThread, undefined);
    assert.notEqual(show(ids.newChatManual).codexThreadId, saved.newChatManual.codexThreadId);
    assert.equal(manualNewChat.cwd, saved.newChatManual.git.worktree);
    assert.equal((await launch(second, ids.manual)).ok, true);
    assert.equal(providerCalls.find(call => call.id === ids.manual).savedThread, saved.manual.codexThreadId);
    pass("Pause survives Electron restart and a provider failure. With auto-mode off, hybrid review resumes and an executor can be resumed manually in its saved thread.");

    cli(["settings"], { autoMode: true });
    await until("executor and eligible queue launched", () => executorIds().length === 8);
    const resumed = providerCalls.find(call => call.id === ids.executor);
    assert.equal(resumed.savedThread, saved.executor.codexThreadId);
    assert.equal(resumed.cwd, saved.work);
    assert.equal(readFileSync(join(saved.work, "quota-fixture.txt"), "utf8"), "Preserved work");
    assert.equal(show(ids.blocked).status, "blocked");
    await delay(1600);
    assert.equal(providerCalls.length, 9);
    for (const [key, feedback] of [
      ["returned", "Keep this reviewer feedback after quota"],
      ["returnedDuringPause", "Keep the feedback sent during the active pause"],
    ]) {
      const runs = providerCalls.filter(call => call.id === ids[key]);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].savedThread, saved[key].codexThreadId);
      assert.equal(runs[0].cwd, saved[key].git.worktree);
      assert.equal(readFileSync(join(runs[0].cwd, "saved-work.txt"), "utf8"), "Preserve the review worktree");
      assert.equal(cli(["show", ids[key]]).history.findLast(event => event.action === "request-changes").text, feedback);
    }
    const autoNewChat = providerCalls.filter(call => call.id === ids.newChatAuto);
    assert.equal(autoNewChat.length, 1);
    assert.equal(autoNewChat[0].savedThread, undefined);
    assert.equal(autoNewChat[0].cwd, saved.newChatAuto.git.worktree);
    assert.notEqual(show(ids.newChatAuto).codexThreadId, saved.newChatAuto.codexThreadId);
    for (const id of [ids.newChatAuto, ids.newChatManual]) {
      const slot = runtimeEntries(project).find(entry => entry.kind === "slot" && entry.task === id);
      assert.equal(slot.newThread, undefined);
      const previous = id === ids.newChatAuto ? saved.newChatAuto : saved.newChatManual;
      assert.ok(cli(["show", id]).history.some(event => event.text?.includes(previous.codexThreadId)));
    }
    const firstStarts = providerCalls.filter(call => call.id === ids.prelink);
    assert.equal(firstStarts.length, 1);
    assert.equal(firstStarts[0].savedThread, undefined);
    assert.equal(firstStarts[0].cwd, saved.firstWorktree);
    assert.equal(show(ids.prelink).codexThreadId, threadFor(ids.prelink));
    assert.equal(providerCalls.some(call => call.id === ids.stopped), false);
    assert.equal(show(ids.stopped).status, "in_progress");
    pass("Auto-mode resumes the original executor in the saved worktree and thread, starts the eligible card once, and leaves explicit stops and unrelated blocks alone.");
    pass("The malformed mixed snapshot kept the pause. The corrected snapshot restored the repair label and started the previously unbound executor once in its saved worktree.");
    pass("After restart, returned work resumed once with its original chat, worktree and reviewer feedback. Manual and automatic new-chat continuations opened new IDs in their original worktrees.");
    await capture(first, "quota-resumed.png");

    const files = [
      "src/cli/acceptance.ts", "src/cli/main.ts", "src/cli/model.ts",
      "src/desktop/main.ts", "src/desktop/board-runtime.ts", "src/desktop/codex-chat.ts",
      "src/desktop/codex-rpc.ts", "src/desktop/reviewer-chat.ts", "src/desktop/provider-limits.ts", "src/desktop/renderer.js",
      "src/desktop/index.html", "src/desktop/provider-limits.js", "src/desktop/locales/en.json", "src/desktop/locales/ru.json",
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
