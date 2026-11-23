import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { locateBoard, onBoard } from "../src/cli/storage.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const phases = ["new", "return", "release", "auto-off", "restart"];
const selected = process.argv.find(arg => arg.startsWith("--scenario="))?.slice("--scenario=".length);
assert.ok(!selected || phases.includes(selected), "Unknown scenario");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "urgent-executor-queue", 120_000,
  (selected === "restart" ? ["auto-off", "restart"] : selected ? [selected] : phases).map(name => [name]));
const phase = process.argv.at(-1);
const project = join(scratch, phase === "restart" ? "auto-off" : phase);
const profile = join(project, "electron-profile");
const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const report = join(artifacts, "urgent-executor-queue-check.txt");
const node = process.env.TASKBOARD_CHECK_NODE;
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const cwdGit = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function cli(args, input) {
  const output = execFileSync(node, [
    "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)),
    "--project", project, "--json", ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: scratch, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true });
  const parsed = JSON.parse(output);
  assert.ok(parsed.ok, output);
  return parsed.data;
}

const show = id => cli(["show", id, "--compact"]);

function ready(title, fields = {}) {
  const card = cli(["create"], plannedDraft({ title, ...fields }));
  confirmFixtureDraft(project, card.id);
  return cli(["approve", card.id]);
}

function review(title) {
  const card = ready(title);
  cli(["start", card.id], { revision: card.revision });
  return submit(card.id);
}

function submit(id) {
  const preview = cli(["preview", id, "--compact"]);
  return cli(["submit", id, "--compact"], {
    token: preview.token, noChanges: true, summary: "Fixture is ready for review.", checks: ["Prepared the fixture."],
  });
}

function attachRelease(card, number, title) {
  onBoard(locateBoard(project), store => {
    const task = store.card(card.id);
    store.save({ ...task, milestone: { number, title, repository: "fixture/queue" } });
  });
}

function checked(message) {
  const line = "PASS " + phase + " — " + message;
  console.log(line);
  if (keepArtifacts) appendFileSync(report, line + "\n");
}

async function until(probe, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(80);
  }
  throw new Error("Timed out: " + label);
}

const launches = [];
const interruptions = [];
const expected = [];
const dueDate = "2025-01-01";
const stateFile = join(scratch, "restart.json");
let nextPending;
let completed;
let incumbent;

if (phase !== "restart") {
  mkdirSync(project);
  cwdGit(project, "init", "--initial-branch=main");
  cwdGit(project, "config", "user.name", "Queue fixture");
  cwdGit(project, "config", "user.email", "fixture@example.invalid");
  cwdGit(project, "commit", "--allow-empty", "-m", "Initial fixture");
  cli(["init"]);
  cli(["settings"], { reviewMode: "human", autoMode: false, taskLimits: { executor: 1, reviewer: 1 } });
  incumbent = ready("Running incumbent");
}

if (phase === (selected && selected !== "restart" ? selected : selected === "restart" ? "auto-off" : phases[0])) {
  const files = ["src/desktop/main.ts", "src/desktop/auto-queue.ts", "docs/reference/board.md",
    "docs/explanation/architecture.md", "scripts/check-urgent-executor-queue.mjs"];
  const hashes = files.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  const header = [
    "Command: node scripts/check-urgent-executor-queue.mjs --artifacts .tasks/qa" + (selected ? " --scenario=" + selected : ""),
    `${process.platform} ${process.arch} ${release()}; Electron ${process.versions.electron}; Host ${execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim()}`,
    "Source snapshot from Git HEAD " + cwdGit(root, "rev-parse", "HEAD") + " (SHA-256 of raw checkout bytes):",
    ...hashes,
    "Real Electron main process, preload IPC, CLI and board persistence. Executor and milestone responses are fixtures.",
  ].join("\n") + "\n";
  if (keepArtifacts) writeFileSync(report, header);
}

app.setPath("userData", profile);
app.setPath("appData", join(project, "app-data"));
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
process.argv.push("--project", project);
const modules = join(scratch, "node_modules");
if (!existsSync(modules)) {
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), modules,
    process.platform === "win32" ? "junction" : "dir");
}
const source = readFileSync(sourceUrl, "utf8")
  .replace("import { callCli,", "import { callCli as realCallCli,")
  .replace("codexStatus, configuredCodex,", "codexStatus,")
  .replace("missingCodexThread, startCodexRun,", "missingCodexThread,")
  .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
  .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
const entry = join(scratch, "urgent-queue-main.mjs");
writeFileSync(entry, transformSync(source + `
const configuredCodex = async () => ({});
const startCodexRun = globalThis.queueFixtureProvider;
const callCli = (...args) => globalThis.queueFixtureCli(realCallCli, ...args);
globalThis.queueFixtureOpen = project => createWindow([project]).window;
`, { loader: "ts", format: "esm" }).code);

globalThis.queueFixtureCli = (call, board, args, ...rest) => {
  if (args[0] === "milestones") {
    return { ok: true, data: { repository: "fixture/queue", milestones: [
      { number: 1, due_on: "2026-12-10T00:00:00Z" },
      { number: 2, due_on: "2026-12-01T00:00:00Z" },
    ] } };
  }
  return call(board, args, ...rest);
};

globalThis.queueFixtureProvider = async (_client, board, _cwd, task, _activity, _usage, signal, beforeTurn) => {
  assert.equal(board, project);
  const id = task.id;
  const threadId = task.codexThreadId ?? randomUUID();
  const pending = await beforeTurn(threadId, !task.codexThreadId);
  pending?.accepted(randomUUID());
  const running = Promise.withResolvers();
  const interrupt = () => {
    interruptions.push(id);
    running.resolve();
  };
  signal.addEventListener("abort", interrupt, { once: true });
  launches.push({
    id,
    finish() {
      submit(id);
      running.resolve();
    },
    feedback: task.feedback,
  });
  return {
    threadId, completion: running.promise.finally(() => signal.removeEventListener("abort", interrupt)), interrupt,
  };
};

async function bootstrapped(window) {
  await until(async () => {
    if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return false;
    return window.webContents.executeJavaScript(
      "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)");
  }, "board window to finish loading");
}

async function api(window, method, ...args) {
  const output = await window.webContents.executeJavaScript(
    `window.taskboard[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  assert.ok(output.ok, JSON.stringify(output));
  return output.data;
}

async function returnFromReview(window, task) {
  const returned = await api(window, "command", "request-changes", task.id, {
    revision: task.revision, reason: "Correct the fixture result.",
  });
  assert.equal(returned.status, "in_progress");
  assert.equal(show(task.id).revision, returned.revision);
}

function started() {
  return launches.map(run => run.id);
}

function enableAuto() {
  cli(["settings"], { autoMode: true });
}

async function run() {
  require(entry);
  const first = await until(() => BrowserWindow.getAllWindows()[0], "first Electron window");
  const second = globalThis.queueFixtureOpen(project);
  await Promise.all([bootstrapped(first), bootstrapped(second)]);

  if (phase === "restart") {
    const { pending, previous, untouched } = JSON.parse(readFileSync(stateFile, "utf8"));
    await until(() => launches.length, "one pending return to run after restart");
    assert.deepEqual(started(), [pending]);
    launches[0].finish();
    await delay(2200);
    assert.deepEqual(started(), [pending]);
    assert.equal(show(previous).reviewReturn, undefined);
    assert.equal(show(pending).reviewReturn, undefined);
    assert.equal(show(untouched).status, "ready");
    checked(`fresh Electron process with two windows ran ${pending} once; no restart of ${previous}; auto-off ready card ${untouched} remained ready`);
    return;
  }

  await api(first, "launchTask", incumbent.id);
  assert.deepEqual(started(), [incumbent.id]);
  checked(`manual start ${incumbent.id} used the free slot`);
  if (phase === "new") {
    const ordinary = ready("Earlier ready with a deadline", { dueDate });
    const ordinaryReturn = review("Earlier review return");
    await returnFromReview(second, ordinaryReturn);
    const manual = ready("Earlier saved manual start");
    const saved = await api(second, "launchTask", manual.id);
    assert.equal(saved.status, "in_progress");
    const urgent = ready("Urgent fresh start", { priority: "urgent" });
    cli(["auto-queue"], { revision: 0, order: [ordinary.id] });
    expected.push(urgent.id, ordinaryReturn.id, manual.id, ordinary.id);
    enableAuto();
  } else if (phase === "return" || phase === "auto-off") {
    const ordinary = ready("Earlier ready with a deadline", { dueDate });
    const ordinaryReturn = review("Earlier review return");
    await returnFromReview(second, ordinaryReturn);
    const promoted = review("Promote this return after enqueue");
    await returnFromReview(first, promoted);
    const queued = show(promoted.id);
    cli(["update", promoted.id], { revision: queued.revision, priority: "urgent" });
    assert.equal(show(promoted.id).reviewReturn, queued.reviewReturn);
    expected.push(promoted.id, ordinaryReturn.id);
    completed = ordinaryReturn.id;
    if (phase === "return") {
      expected.push(ordinary.id);
      enableAuto();
    } else {
      const future = review("Pending until application restart");
      nextPending = { pending: future, previous: completed, untouched: ordinary.id };
    }
  } else {
    const earlier = ready("Early release with a later deadline");
    const later = ready("Late release with the urgent card", { priority: "urgent", dueDate });
    attachRelease(earlier, 1, "1.0.0");
    attachRelease(later, 2, "2.0.0");
    const invalid = ready("Urgent with an unfinished dependency", { priority: "urgent", dependencies: [later.id] });
    cli(["auto-queue"], { revision: 0, order: [later.id, invalid.id] });
    expected.push(earlier.id);
    enableAuto();
  }

  await delay(1800);
  assert.deepEqual(started(), [incumbent.id]);
  assert.deepEqual(interruptions, []);
  launches[0].finish();

  for (const [index, id] of expected.entries()) {
    const run = await until(() => launches[index + 1], "next executor " + id);
    assert.equal(run.id, id, JSON.stringify(started()));
    if (index === 0 && (phase === "return" || phase === "auto-off")) {
      assert.equal(run.feedback, "Correct the fixture result.");
    }
    if (nextPending && index === expected.length - 1) {
      // Persist a return while the previous run still occupies the only slot.
      await returnFromReview(second, nextPending.pending);
      writeFileSync(stateFile, JSON.stringify({ ...nextPending, pending: nextPending.pending.id }));
      assert.deepEqual(started(), [incumbent.id, ...expected]);
      // Commit the active turn's result while it still holds its slot.
      submit(run.id);
      await delay(500);
      assert.equal(show(nextPending.pending.id).status, "in_progress");
      break;
    }
    run.finish();
  }

  await delay(1800);
  assert.deepEqual(started(), [incumbent.id, ...expected]);
  assert.deepEqual(interruptions, []);
  checked("single slot, no preemption or duplicate across two windows; order " + started().join(" → "));
  if (phase === "release") checked("earlier release ran before urgent later release and the urgent dependent card");
  if (nextPending) checked("auto-off restored queued returns and left an additional return pending for restart");
}

run().then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
