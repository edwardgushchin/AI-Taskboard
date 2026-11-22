import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { activeManagerGoal, managerGoalBinding } from "../src/cli/manager-goal.ts";
import { registerRuntime, runtimeEntries } from "../src/desktop/board-runtime.ts";
import { saveIterativeGoal } from "../src/desktop/iterative-goal.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "queue-acceptance", 300_000, [
  ["iterative", "open"], ["iterative", "restart"], ["ordinary", "open"], ["ordinary", "restart"],
]);
const [mode, phase] = process.argv.slice(-2);
const restarting = phase === "restart";
const project = join(scratch, mode);
const profile = join(scratch, mode + "-profile");
const ledger = join(project, "launches.txt");
const fixtureFile = join(project, "fixture.json");
const report = join(artifacts, "electron-queue.txt");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");

function cli(args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: project, encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input) }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function log(text) {
  console.log(text);
  appendFileSync(report, text + "\n");
}

function launches() {
  return readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
}

function submit(id) {
  const { token } = cli(["preview", id, "--compact"]);
  cli(["submit", id], { token, noChanges: true, summary: "Fixture result", checks: ["Checked"] });
}

async function waitFor(probe, label) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label);
}

function prepareBoard() {
  mkdirSync(project);
  writeFileSync(ledger, "");
  cli(["init"], { git: false });
  const make = title => {
    const draft = cli(["create"], plannedDraft({ title, criteria: ["Checked"] }));
    confirmFixtureDraft(project, draft.id);
    return cli(["approve", draft.id]);
  };
  const pair = name => {
    const title = name + " formatter";
    const { id: prerequisite } = make(title);
    cli(["start", prerequisite]);
    submit(prerequisite);
    const { id: dependent, revision } = make(name + " dependent");
    const queue = cli(["auto-queue"]);
    const held = cli(["auto-queue"], { revision: queue.revision, hold: [dependent] });
    cli(["auto-queue"], { revision: held.revision, replaceHold: { id: dependent, revision, dependency: prerequisite } });
    return { title, prerequisite, dependent };
  };
  const fixtures = { live: pair("Live"), restart: pair("Restart") };
  if (mode === "iterative") {
    const id = "10000000-0000-0000-0000-000000000001";
    writeFileSync(managerGoalBinding(project), JSON.stringify({ provider: "codex", id, goal: { status: "active", objective: "Queue fixture" } }));
    saveIterativeGoal(project, { goalId: id, questions: [], retryAt: Date.now() + 600_000 });
  }
  cli(["settings"], { autoMode: true, reviewMode: "human", taskLimits: { executor: 1, reviewer: 1 },
    iterativeGoal: activeManagerGoal(project) ?? false });
  writeFileSync(fixtureFile, JSON.stringify(fixtures));
}

function startDesktop(finish) {
  app.setPath("userData", profile);
  app.setPath("appData", scratch);
  app.requestSingleInstanceLock = () => true;
  app.disableHardwareAcceleration();
  if (!restarting) process.argv.push("--project", project);
  const dependencyPath = join(scratch, "node_modules");
  if (!existsSync(dependencyPath)) {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), dependencyPath, "junction");
  }
  globalThis.queueFixture = {
    async execute(_client, _project, _cwd, task, _activity, _usage, _signal, beforeTurn) {
      const threadId = "20000000-0000-0000-0000-" + task.id.slice(2).padStart(12, "0");
      await beforeTurn(threadId, true);
      appendFileSync(ledger, task.id + "\n");
      const completion = finish.promise.then(() => submit(task.id));
      return { threadId, completion, interrupt: async () => {} };
    },
    unexpectedTurn() {
      appendFileSync(ledger, "unexpected manager turn\n");
      throw new Error("The queue must not need a manager or goal turn");
    },
  };
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href))
    .replace("missingCodexThread, startCodexRun", "missingCodexThread, startCodexRun as unusedStartCodexRun")
    .replace("codexStatus, configuredCodex,", "codexStatus, configuredCodex as unusedConfiguredCodex,")
    .replace("replyToBoard, replyToTask", "replyToBoard as unusedReplyToBoard, replyToTask")
    .replace('readCodexLimits(app.getPath("userData"))', "Promise.resolve(undefined)");
  const entry = join(scratch, mode + "-" + phase + ".mjs");
  writeFileSync(entry, transformSync(source + `
    const configuredCodex = async () => ({});
    const startCodexRun = globalThis.queueFixture.execute;
    const replyToBoard = async () => globalThis.queueFixture.unexpectedTurn();
    globalThis.openQueueCheckWindow = () => createWindow([${JSON.stringify(project)}]).window;
  `, { loader: "ts", format: "esm" }).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
}

const evaluate = (window, code) => window.webContents.executeJavaScript(code);
const snapshot = window => evaluate(window, "window.taskboard?.bootstrap()");
const cardInWindow = async (window, id) => (await snapshot(window))?.board?.tasks.find(card => card.id === id);

async function acceptInWindow(window, pair) {
  await waitFor(() => evaluate(window, `(() => {
    const title = ${JSON.stringify(pair.title)};
    const card = [...document.querySelectorAll('.task-card[data-state=review]')]
      .find(node => node.querySelector('strong')?.textContent === title);
    if (!card) return false;
    card.click();
    return true;
  })()`), "the prerequisite card in the second window");
  await waitFor(() => evaluate(window, `(() => {
    const action = document.querySelector('#sheet[open] #sheet-body > .sheet-actions button.primary');
    if (!action || action.disabled) return false;
    action.click();
    return true;
  })()`), "the review action");
  await waitFor(() => evaluate(window, `(() => {
    const accept = document.querySelector('#sheet[open] #sheet-body > form.form button[type=submit]');
    if (!accept || accept.disabled) return false;
    accept.click();
    return true;
  })()`), "the acceptance button");
}

async function run() {
  if (!restarting) prepareBoard();
  const fixtures = JSON.parse(readFileSync(fixtureFile, "utf8"));
  const { live, restart } = fixtures;
  if (!restarting && mode === "iterative") writeFileSync(report, "");
  log(`${mode}/${phase}: PID ${process.pid}, Electron ${process.versions.electron}, Node ${process.versions.node}`);
  const occupy = pair => registerRuntime(project, { kind: "slot", role: "executor", task: pair.prerequisite });
  const release = restarting ? undefined : occupy(live);
  const finish = Promise.withResolvers();
  startDesktop(finish);
  const first = await waitFor(async () => {
    const window = BrowserWindow.getAllWindows().at(-1);
    return window && !window.webContents.isLoading() && (await snapshot(window))?.board && window;
  }, "a restored project window");
  const waitForExecutor = () => waitFor(
    () => !runtimeEntries(project).some(entry => entry.kind === "slot" && entry.role === "executor"),
    "executor completion",
  );
  async function finishExecution(pair) {
    finish.resolve();
    await waitFor(async () => (await cardInWindow(first, pair.dependent))?.status === "review", "executor submission");
    await waitForExecutor();
  }
  if (restarting) {
    await waitFor(() => launches().includes(restart.dependent), "automatic launch after reopening the saved profile");
    assert.equal((await cardInWindow(first, restart.prerequisite)).status, "done");
    await waitFor(async () => (await cardInWindow(first, restart.dependent))?.status === "in_progress", "working card after restart");
    await finishExecution(restart);
    assert.deepEqual(launches(), [live.dependent, restart.dependent]);
    log(`PASS ${mode}: the new process restored the project and started ${restart.dependent} once.`);
    return;
  }
  const second = globalThis.openQueueCheckWindow();
  assert.notEqual(first.id, second.id);
  await waitFor(async () => (await snapshot(second))?.board, "a second window on the same board");

  async function acceptWithOccupiedSlot(pair, expectedLaunches) {
    await acceptInWindow(second, pair);
    try {
      await waitFor(async () => {
        const prerequisite = await cardInWindow(first, pair.prerequisite);
        const dependent = await cardInWindow(first, pair.dependent);
        return prerequisite?.status === "done" && dependent?.status === "ready" && !dependent.unfinishedDependencies?.length;
      }, "acceptance and a ready dependent in the first window");
    } catch (error) {
      const cardStates = async window => (await snapshot(window)).board.tasks.map(({ id, status, unfinishedDependencies }) =>
        ({ id, status, unfinishedDependencies }));
      console.error({
        first: await cardStates(first), second: await cardStates(second), launches: launches(),
        acceptanceNotice: await evaluate(second, "document.querySelector('#sheet-notice').textContent"),
        boardNotice: await evaluate(second, "document.querySelector('#notice-message').textContent"),
        diskStatus: cli(["show", pair.prerequisite, "--compact"]).status,
      });
      throw error;
    }
    assert.equal((await cardInWindow(second, pair.prerequisite)).status, "done");
    assert.ok(runtimeEntries(project).some(entry => entry.kind === "slot" && entry.task === pair.prerequisite));
    assert.deepEqual(launches(), expectedLaunches);
    log(`PASS ${mode}: accepted ${pair.prerequisite} via window ${second.id}; window ${first.id} saw ${pair.dependent} ready with the executor slot occupied.`);
  }
  await acceptWithOccupiedSlot(live, []);
  release();
  await waitFor(() => launches().includes(live.dependent), "automatic launch after slot release");
  await finishExecution(live);
  assert.deepEqual(launches(), [live.dependent]);
  log(`PASS ${mode}: releasing the slot started ${live.dependent} once without a board action.`);
  occupy(restart);
  await acceptWithOccupiedSlot(restart, [live.dependent]);
  const saved = JSON.parse(readFileSync(join(profile, "project-tabs.json"), "utf8"));
  assert.ok(saved.some(window => window.projects.includes(project)));
  log(`PASS ${mode}: persisted the open project and exited while ${restart.dependent} was ready.`);
}

void run().then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
