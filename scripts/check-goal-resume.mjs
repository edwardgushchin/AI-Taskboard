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
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "goal-resume", 90_000);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const cliEntry = join(root, "src", "cli", "main.ts");
const binding = join(project, ".tasks", "manager-dialog.json");
const thread = randomUUID();
const objective = "Verify manual goal continuation";
const reports = [];
const requests = [];
let chat;
let failResume = false;

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

function writeGoal(text) {
  writeFileSync(binding, JSON.stringify({
    provider: "codex", id: thread, history: "local", goalId: randomUUID(),
    goal: { objective: text, status: "paused" },
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
const history = window => api(window, "boardHistory", project, null, "chat");
const resumes = () => requests.filter(request => request.resume).length;

async function openGoal(window) {
  window.setContentSize(1280, 800);
  await until(async () => !window.webContents.isLoading() &&
    await evaluate(window, "!!document.querySelector('#board-draft textarea[name=request]')"), "board composer");
  await evaluate(window, "document.querySelector('#board-draft textarea[name=request]').dispatchEvent(" +
    "new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
  await until(async () =>
    await evaluate(window, "!!document.querySelector('.board-goal:not([hidden])')"), "visible goal");
  await evaluate(window, "document.querySelector('.board-goal').open = true");
}

async function capture(window, name) {
  window.focus();
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name), image.toPNG());
}

function prepare() {
  mkdirSync(project);
  cli(["init"]);
  cli(["settings", "--stdin"], { autoMode: false, reviewMode: "reviewer", taskLimits: { executor: 1, reviewer: 1 } });
  writeGoal(objective);
  app.setPath("userData", join(scratch, "profile"));
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
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
  if (session.resumeGoal) {
    if (failResume) throw new Error("Fixture provider refused continuation");
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
  const other = globalThis.openGoalWindow(project);
  await openGoal(other);

  const slot = registerRuntime(project, { kind: "slot", role: "reviewer", task: "maintenance:fixture" });
  const maintenance = registerRuntime(project, {
    kind: "task", task: "manager:background",
    state: { id: randomUUID(), startedAt: Date.now(), lane: "maintenance", phase: "running" },
  });
  assert.ok(slot && maintenance);
  try {
    await until(async () => await evaluate(wide,
      "window.taskboard.bootstrap().then(frame => frame.managerWork?.lane === 'maintenance')"), "maintenance status");
    await evaluate(wide, "document.querySelector('.board-work-toggle').click()");
    await until(() => evaluate(wide, "!!document.querySelector('.board-work-toggle.working')"), "rendered maintenance activity");
    assert.equal(await resumeEnabled(wide), true);
    await capture(wide, "goal-resume-available.png");
    await evaluate(wide, "document.querySelector(" + JSON.stringify(button) + ").click()");
    await until(async () => resumes() === 1 && !(await history(wide)).data.goalResuming, "resume during maintenance");
    assert.equal(resumes(), 1);
    assert.equal(requests.at(-1).slots, 1);
    assert.equal(cli(["settings"]).autoMode, false);
    pass("The available button resumes in the saved manager thread with automatic mode off and the sole reviewer slot held by maintenance.");
  } finally {
    maintenance();
    slot();
  }

  writeGoal(objective);
  globalThis.publishFixtureGoal(project);
  await evaluate(wide, "document.querySelector('.board-dialogue-toggle').click()");
  const first = await holdChat(wide);
  assert.equal(await resumeEnabled(wide), true);
  assert.equal(await resumeEnabled(other), true);
  await evaluate(wide, "document.querySelector(" + JSON.stringify(button) + ").click()");
  await until(async () => resumes() === 2 && !(await history(other)).data.goalResuming, "resume beside dialogue");
  await capture(wide, "goal-resume-during-dialogue.png");
  assert.equal((await api(other, "boardRequest", "Competing request")).error.code, "BOARD_REQUEST_IN_PROGRESS");
  assert.equal(resumes(), 2);
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
    assert.equal(resumes(), 2);
  }
  pass("A replaced objective cannot be resumed by an obsolete request; clearing the goal proceeds while the dialogue is held.");

  writeGoal(objective);
  globalThis.publishFixtureGoal(project);
  await until(() => resumeEnabled(wide), "available action after resetting the fixture goal");
  await evaluate(wide, "document.querySelector('.board-goal').open = true");
  failResume = true;
  await evaluate(wide, "document.querySelector(" + JSON.stringify(button) + ").click()");
  await until(() => evaluate(wide,
    "document.querySelector('.board-goal-error').textContent.includes('Fixture provider refused continuation')"), "provider error");
  assert.equal(await resumeEnabled(wide), true);
  failResume = false;
  assert.equal((await api(wide, "boardGoal", "resume", objective)).ok, true);
  assert.equal(resumes(), 4);
  pass("The provider refusal is visible and re-enables the action. A second attempt succeeds.");

  const paths = ["src/desktop/main.ts", "src/desktop/chat.js", "src/desktop/renderer.js", "scripts/check-goal-resume.mjs"];
  const hashes = paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeFileSync(join(artifacts, "goal-resume-check.txt"), [
    "Command: node scripts/check-goal-resume.mjs --artifacts .tasks/qa",
    "Git HEAD at test time: " + revision,
    "Tested worktree bytes (SHA-256, before Electron fixture provider substitution):",
    ...hashes,
    "Runtime: " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node " + process.versions.node].join(", "),
    "Two 1280x800 windows. The maintenance slot is represented by runtime entries and provider responses are deterministic.",
    ...reports,
  ].join("\n") + "\n");
}

void run().then(() => {
  app.exit(0);
}, error => {
  console.error(error);
  app.exit(1);
});
