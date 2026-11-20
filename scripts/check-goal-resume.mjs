// Exercise the real Electron windows and manager IPC with a deterministic provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { registerRuntime, runtimeEntries } from "../src/desktop/board-runtime.ts";
import { goalMessages, saveManagerHistory, sendGoalMessage } from "../src/desktop/manager-history.ts";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "goal-resume", 90_000, [[], ["--restart"]]);
const { app, BrowserWindow, ipcMain } = await import("electron");
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const cliEntry = join(root, "src", "cli", "main.ts");
const binding = join(project, ".tasks", "manager-dialog.json");
const restart = process.argv.includes("--restart");
const seed = restart ? JSON.parse(readFileSync(binding)) : { id: randomUUID(), goalId: randomUUID() };
const thread = seed.id;
const objective = "Проверить продолжение сохранённой цели";
const queuedDraft = "Decline a competing draft goal";
const earlierActivity = "Сохранённая запись хода цели";
const instruction = "Проверь сохранённую очередь указаний";
const taskTitle = "Отдельная задача в работе";
const reports = [];
const requests = [];
let chat;
let resumeFailure;
let delayedReply;
let delayedReplyReached = false;

function pass(result) {
  reports.push(result);
  console.log("PASS " + result);
}

function cli(args, input) {
  const reply = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE,
    ["--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json", ...args],
    { input: input && JSON.stringify(input), windowsHide: true }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

function writeGoal(text, goalId = randomUUID()) {
  writeFileSync(binding, JSON.stringify({
    provider: "codex", id: thread, history: "local", goalId,
    goal: { objective: text, status: "active" },
  }));
}

async function until(probe, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for " + label);
}

const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
const api = (window, method, ...args) =>
  evaluate(window, "window.taskboard." + method + "(" + args.map(value => JSON.stringify(value)).join(",") + ")");
async function startCall(window, name, method, ...args) {
  const expression = "window.taskboard." + method + "(" + args.map(value => JSON.stringify(value)).join(",") + ")";
  await evaluate(window, "window[" + JSON.stringify(name) + "] = " + expression + "; undefined");
  return () => evaluate(window, "window[" + JSON.stringify(name) + "]");
}
const button = ".board-goal-actions > button:nth-child(3)";
const resumeEnabled = window => evaluate(window,
  "!!document.querySelector(" + JSON.stringify(button + ":enabled:not([hidden])") + ")");
const pending = window => evaluate(window, "!!document.querySelector('.board-goal-body > div[role=status]:not([hidden])')");
const history = (window, view = "chat") => api(window, "boardHistory", project, null, view);
const resumes = () => requests.filter(request => request.resume).length;
const clickResume = window => evaluate(window, "document.querySelector(" + JSON.stringify(button) + ").click()");

async function openGoal(window) {
  window.setContentSize(1280, 900);
  await until(async () => !window.webContents.isLoading() &&
    await evaluate(window, "!!document.querySelector('#board-draft textarea[name=request]')"), "board composer");
  await evaluate(window, "document.querySelector('#board-draft textarea[name=request]').dispatchEvent(" +
    "new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
  await until(async () =>
    await evaluate(window, "!!document.querySelector('.board-goal:not([hidden])')"), "visible goal");
  await evaluate(window, "document.querySelector('.board-goal').open = true");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
}

async function capture(window, name) {
  window.focus();
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 900 });
  const png = image.toPNG();
  assert.ok(png.length < 4 * 1024 * 1024);
  writeFileSync(join(artifacts, name), png);
}

function prepare() {
  if (!restart) {
    mkdirSync(project);
    cli(["init"]);
    cli(["settings", "--stdin"], { autoMode: false, reviewMode: "reviewer", taskLimits: { executor: 1, reviewer: 1 } });
    const { id } = cli(["create", "--stdin"], plannedDraft({ title: taskTitle }));
    cli(["approve", id]);
    cli(["start", id]);
    writeGoal(objective, seed.goalId);
    saveManagerHistory(project, Date.now() - 500, randomUUID(), {
      lane: "work",
      goalId: seed.goalId,
      items: [{ id: randomUUID(), type: "agentMessage", title: "", text: earlierActivity, status: "completed", phase: "final_answer" }],
    });
    sendGoalMessage(project, seed.goalId, instruction);
    mkdirSync(join(scratch, "profile"));
    writeFileSync(join(scratch, "profile", "appearance.json"), JSON.stringify({ language: "ru" }));
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  }
  app.setPath("userData", join(scratch, "profile"));
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  // Delay delivery of one settled IPC result after the main process has released the goal writer.
  const handle = ipcMain.handle;
  ipcMain.handle = function (channel, listener) {
    if (channel === "board:request") {
      const original = listener;
      listener = async (...args) => {
        const result = await original(...args);
        if (delayedReply && args[1] === queuedDraft && args[4] === true) {
          delayedReplyReached = true;
          await delayedReply.promise;
        }
        return result;
      };
    }
    return handle.call(this, channel, listener);
  };
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal",
      "readTaskRunHistory, replyToTask, reviewWithCodex")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const fixture = [
    "const replyToBoard = (...args) => globalThis.goalFixture(...args);",
    "const updateBoardGoal = (...args) => globalThis.goalControl(...args);",
    source,
    "globalThis.openGoalWindow = project => createWindow([project]).window;",
    'globalThis.publishFixtureGoal = project => broadcastBoardChat(project, "orchestrator-goal", { goal: readBoardThread(boardThreadPath(project)).goal });',
    'globalThis.publishFixtureQueue = project => broadcastBoardChat(project, "orchestrator-queue");',
  ].join("\n");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(fixture, { loader: "ts", format: "esm" }).code);
  require(entry);
}

globalThis.goalFixture = async (_profile, cwd, prompt, _images, _action, _tools, _instructions, _signal, session) => {
  assert.equal(cwd, project);
  const entries = runtimeEntries(project);
  const goal = session.goal || session.resumeGoal;
  if (goal) assert.equal(session.id, thread);
  else if (!session.id) session.save(randomUUID());
  const context = goal ? "manager:context" : "manager:dialogue";
  assert.equal(entries.filter(entry => entry.task === context).length, 1);
  requests.push({ prompt, resume: session.resumeGoal, slots: entries.filter(entry => entry.role === "reviewer").length });
  if (goal && !session.resumeGoal) {
    throw new Error("Fixture rejected the competing draft before changing the goal");
  }
  if (session.resumeGoal) {
    if (resumeFailure === "refused") throw new Error("Fixture provider refused continuation");
    if (resumeFailure === "interrupted") return { interrupted: true };
    session.onGoal({ objective: JSON.parse(readFileSync(binding)).goal.objective, status: "active" });
    return { text: "Goal resumed", model: "Fixture provider" };
  }
  if (prompt === "Hold the manager answer") await chat.promise;
  return { text: "Saved manager answer: " + prompt, model: "Fixture provider" };
};

globalThis.goalControl = async (_profile, cwd, id, action) => {
  assert.equal(cwd, project);
  assert.equal(id, thread);
  assert.equal(action.kind, "clear");
  return null;
};

async function holdChat(window) {
  chat = Promise.withResolvers();
  const count = requests.length;
  const reply = await startCall(window, "chatReply", "boardRequest", "Hold the manager answer");
  await until(() => requests.length > count && requests.at(-1)?.prompt === "Hold the manager answer", "chat writer");
  return { reply };
}

async function run() {
  prepare();
  const wide = await until(() => BrowserWindow.getAllWindows()[0], "first window");
  await openGoal(wide);
  if (!restart) {
    assert.equal((await history(wide)).data.goalId, seed.goalId);
    return;
  }
  const before = await history(wide, "work");
  assert.deepEqual(before.data.goal, { objective, status: "active" });
  assert.equal(before.data.goalId, seed.goalId);
  assert.match(JSON.stringify(before.data.turns.flatMap(turn => turn.items)), new RegExp(earlierActivity));
  assert.equal(await evaluate(wide, "document.querySelector('.board-goal').dataset.status"), "idle");
  assert.equal(await evaluate(wide, "document.querySelector('.board-goal-status').textContent"), "Цель ждёт продолжения");
  assert.equal(await resumeEnabled(wide), true);
  await evaluate(wide, "document.querySelector('.board-work-toggle').click()");
  await until(() => evaluate(wide, "document.querySelector('.board-work').innerText.includes(" + JSON.stringify(earlierActivity) + ")"),
    "restored activity in the goal tab");
  await capture(wide, "goal-after-reopen.png");

  delayedReply = Promise.withResolvers();
  const queued = await api(wide, "boardQueue", project, "add", randomUUID(), queuedDraft, true, []);
  assert.equal(queued.ok, true);
  globalThis.publishFixtureQueue(project);
  try {
    await until(() => delayedReplyReached, "settled goal request blocked at IPC delivery");
    assert.equal(runtimeEntries(project).some(entry => entry.task === "manager:context"), false);
    assert.equal(await evaluate(wide, "document.querySelector('.board-goal').dataset.status"), "idle");
    assert.equal(await pending(wide), false);
    assert.equal(await resumeEnabled(wide), true, "A settled draft request still blocks Resume in the reopened renderer");
    await clickResume(wide);
    await until(async () => resumes() === 1 && !(await history(wide)).data.goalResuming, "saved goal resumed before delayed reply");
    const after = await history(wide, "work");
    assert.equal(after.data.goalId, seed.goalId);
    assert.deepEqual(after.data.goal, before.data.goal);
    assert.equal(after.data.turns.flatMap(turn => turn.items).filter(item => item.text === earlierActivity).length, 1);
    assert.equal(after.data.turns.flatMap(turn => turn.items).filter(item => item.text === "Goal resumed").length, 1);
    const inbox = goalMessages(project, seed.goalId);
    assert.equal(inbox.filter(message => message.text === instruction && message.status === "pending").length, 1);
    pass("After a real Electron restart, one click resumes the saved goal while an earlier draft IPC reply is still in flight and its writer is already free. Objective, goal ID, original history and pending instruction survive.");
  } finally {
    delayedReply.resolve();
  }
  await api(wide, "boardQueue", project, "remove", queued.data);

  const other = globalThis.openGoalWindow(project);
  await openGoal(other);

  const slot = registerRuntime(project, { kind: "slot", role: "reviewer", task: "maintenance:fixture" });
  const maintenance = registerRuntime(project, {
    kind: "task", task: "manager:background",
    state: { id: randomUUID(), startedAt: Date.now(), lane: "maintenance", phase: "running" },
  });
  const task = cli(["list"]).tasks.find(task => task.title === taskTitle);
  assert.equal(task.status, "in_progress");
  const executor = registerRuntime(project, { kind: "slot", role: "executor", task: task.id });
  assert.ok(slot && maintenance && executor);
  try {
    await until(async () => await evaluate(wide,
      "window.taskboard.bootstrap().then(frame => frame.managerWork?.lane === 'maintenance')"), "maintenance status");
    await evaluate(wide, "document.querySelector('.board-work-toggle').click()");
    await until(() => evaluate(wide, "!!document.querySelector('.board-work-toggle.working')"), "rendered maintenance activity");
    assert.equal(await resumeEnabled(wide), true);
    await clickResume(wide);
    await until(async () => resumes() === 2 && !(await history(wide)).data.goalResuming, "resume during maintenance");
    assert.equal(resumes(), 2);
    assert.equal(requests.at(-1).slots, 1);
    assert.equal(cli(["settings"]).autoMode, false);
    pass("The goal resumes with automatic mode off while maintenance holds the sole reviewer slot and a card in progress occupies the sole executor slot.");
  } finally {
    executor();
    maintenance();
    slot();
  }

  writeGoal(objective);
  globalThis.publishFixtureGoal(project);
  await evaluate(wide, "document.querySelector('.board-dialogue-toggle').click()");
  const first = await holdChat(wide);
  assert.equal(await resumeEnabled(wide), true);
  assert.equal(await resumeEnabled(other), true);
  await clickResume(wide);
  await until(async () => resumes() === 3 && !(await history(other)).data.goalResuming, "resume beside dialogue");
  assert.equal((await api(other, "boardRequest", "Competing request")).error.code, "BOARD_REQUEST_IN_PROGRESS");
  assert.equal(resumes(), 3);
  assert.equal((await history(other)).data.turns.some(turn => turn.items.some(item => item.text.includes("Saved manager answer: Hold"))), false);
  chat.resolve();
  assert.equal((await first.reply()).ok, true);
  assert.match(JSON.stringify((await history(other)).data.turns), /Saved manager answer: Hold the manager answer/);
  pass("The goal resumes in its own saved context while the ordinary answer is held; a second dialogue writer is rejected and the ordinary answer is saved after release.");

  for (const kind of ["replace", "clear"]) {
    writeGoal(objective);
    const held = await holdChat(wide);
    if (kind === "replace") {
      writeGoal("Replacement goal");
      assert.equal((await api(other, "boardGoal", "resume", objective)).ok, false);
    } else {
      assert.equal((await api(other, "boardGoal", "clear")).ok, true);
      assert.equal(JSON.parse(readFileSync(binding)).goal, null);
    }
    chat.resolve();
    assert.equal((await held.reply()).ok, true);
    assert.equal(resumes(), 3);
  }
  pass("A replaced objective cannot be resumed by an obsolete request; clearing the goal proceeds while the dialogue is held.");

  writeGoal(objective);
  globalThis.publishFixtureGoal(project);
  await until(() => resumeEnabled(wide), "available action after resetting the fixture goal");
  const writer = registerRuntime(project, { kind: "task", task: "manager:context" });
  assert.ok(writer);
  try {
    await clickResume(wide);
    const duplicate = await api(other, "boardGoal", "resume", objective);
    assert.equal(duplicate.ok, true);
    await until(async () => await pending(wide) && await pending(other), "waiting reason in both windows");
    for (const window of [wide, other]) {
      assert.equal(await resumeEnabled(window), false);
      assert.match(await evaluate(window, "document.querySelector('.board-goal-body > div[role=status]').textContent"), /освобождения контекста цели/);
    }
    assert.equal(resumes(), 3);
  } finally {
    writer();
  }
  await until(async () => resumes() === 4 && await resumeEnabled(wide) && await resumeEnabled(other), "one resume after writer release");
  pass("A held goal-context writer yields a specific waiting reason in both windows. Two requests result in one provider launch after release.");

  const cancelWriter = registerRuntime(project, { kind: "task", task: "manager:context" });
  assert.ok(cancelWriter);
  try {
    const cancelled = await startCall(wide, "cancelledResume", "boardGoal", "resume", objective);
    await until(() => pending(other), "request waiting in the other window");
    writeGoal("Replacement while resume waits");
    globalThis.publishFixtureGoal(project);
    cancelWriter();
    await cancelled();
    await until(async () => await resumeEnabled(wide) && await resumeEnabled(other), "superseded request released");
    assert.equal(resumes(), 4);
  } finally {
    cancelWriter();
  }
  pass("Replacing the goal while its writer is held prevents the old request from launching when the writer is released.");

  for (const [failure, message] of [
    ["refused", "Fixture provider refused continuation"],
    ["interrupted", "Ответ остановлен."],
  ]) {
    const before = resumes();
    writeGoal(objective);
    globalThis.publishFixtureGoal(project);
    await until(() => resumeEnabled(wide), "available action before " + failure);
    resumeFailure = failure;
    await clickResume(wide);
    for (const window of [wide, other]) {
      await until(() => evaluate(window,
        "document.querySelector('.board-goal-error').textContent.includes(" + JSON.stringify(message) + ")"), failure + " reason");
      assert.equal(await resumeEnabled(window), true);
    }
    assert.equal(resumes(), before + 1);
    resumeFailure = undefined;
    await clickResume(other);
    await until(async () => resumes() === before + 2 && await resumeEnabled(wide) && await resumeEnabled(other), "retry from other window");
    for (const window of [wide, other]) {
      assert.equal(await evaluate(window, "document.querySelector('.board-goal-error').textContent"), "");
    }
    pass("Provider " + failure + ": both windows show the reason and restore Resume; one retry from the second window succeeds and clears the error.");
  }

  const paths = ["src/desktop/main.ts", "src/desktop/chat.js", "src/desktop/renderer.js", "src/desktop/locales/ru.json",
    "src/desktop/locales/en.json", "scripts/check-goal-resume.mjs", "scripts/electron-check.mjs"];
  const hashes = paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(artifacts, "goal-resume-after-reopen.txt"), [
    "Command: node scripts/check-goal-resume.mjs --artifacts .tasks/qa",
    "Git HEAD at test time: " + revision,
    "Tested worktree bytes (SHA-256, before Electron fixture provider substitution):",
    ...hashes,
    "Runtime: " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node " + process.versions.node].join(", "),
    "Windows GUI with two sandboxed 1280x900 renderer viewports and two consecutive Electron processes sharing an isolated fixture board/profile.",
    "Maintenance and executor slots use runtime fixtures, the provider is deterministic. Linux and macOS GUI were not exercised.",
    "Regression baseline fd16cd7a13d5b51cbd497b1cca94ad607c823a7b, Windows Electron exit 1: assertion 'A settled draft request still blocks Resume in the reopened renderer' (false !== true).",
    "The fixture delays only delivering the settled draft IPC result back to the renderer; the main process has released the goal writer before checking Resume.",
    ...reports,
  ].join("\n") + "\n");
}

void run().then(() => {
  app.exit(0);
}, error => {
  console.error(error);
  app.exit(1);
});
