import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "card-review-mode", 240_000,
  [["auto-on"], ["auto-off"], ["restart"]]);
const phase = process.argv.at(-1);
const autoMode = phase === "auto-on";
const project = join(scratch, phase === "restart" ? "auto-off" : phase);
const reportFile = join(artifacts, "card-review-mode-check.txt");
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function runCommand(command, args, input) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", input, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function reply(args, input) {
  const result = runCommand(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input ? ["--stdin"] : []),
  ], input && JSON.stringify(input));
  return JSON.parse(result.stdout);
}

function cli(args, input) {
  const result = reply(args, input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function git(...args) {
  const result = runCommand("git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const show = id => cli(["show", id]);
const review = id => cli(["review", id, "--compact"]);
const action = "task_set_review_mode";
const evidence = ["The submitted file contains the result."];
const log = text => { console.log(text); appendFileSync(reportFile, text + "\n"); };

async function waitFor(probe, label) {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(250);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  if (autoMode) writeFileSync(reportFile, "Command: node scripts/check-card-review-mode.mjs --artifacts .tasks/qa\n");
  log(`${phase}: Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}`);
  if (phase !== "restart") {
    mkdirSync(project);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Taskboard fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "Initial state");
    cli(["init"]);
    cli(["settings"], { reviewMode: "reviewer", autoMode });
  }
  const create = title => cli(["create"], plannedDraft({ title, criteria: evidence })).id;
  const hybrid = phase === "restart" ? "T-0001" : create("Personal acceptance");
  const normal = phase === "restart" ? "T-0002" : create("Inherited review");
  if (phase !== "restart") {
    for (const id of [hybrid, normal]) {
      const ready = cli(["approve", id]);
      const started = cli(["start", id], { revision: ready.revision });
      writeFileSync(join(started.worktree, id + ".txt"), id + "\n");
    }
  }
  function submit(id) {
    const { token } = cli(["preview", id, "--compact"]);
    cli(["submit", id], { token, message: "fix: add " + id, summary: "Saved", checks: evidence });
  }

  const release = Promise.withResolvers();
  const resumeNormal = Promise.withResolvers();
  let held, raced;
  let pausedAcceptance, retryRejection, retryCount = 0;
  const observed = [];
  const receipts = [];
  const replies = new Map();
  globalThis.fixtureCli = async (call, board, args, input) => {
    if (autoMode && !held && args[0] === "accept" && args[1] === hybrid && input?.autoMode) {
      held = input;
      await release.promise;
      return raced = await call(board, args, input);
    }
    if (autoMode && args[0] === "accept" && args[1] === normal && input?.autoMode) {
      retryCount++;
      if (retryCount === 1) {
        pausedAcceptance = input;
        await resumeNormal.promise;
        return retryRejection = await call(board, args, input);
      }
      assert.deepEqual(input, pausedAcceptance);
    }
    const result = await call(board, args, input);
    if (args[1] === hybrid && ["review", "review-approve", "accept"].includes(args[0])) {
      observed.push([args[0], result.ok ? result.data.revision : result.error.code]);
    }
    return result;
  };
  globalThis.fixtureReview = async () => ({ summary: "Fixture reviewer approved.", needsHuman: false, findings: [], evidence });
  globalThis.fixtureManager = async (_profile, _project, prompt, _images, call, _tools, _instructions, _signal, session) => {
    let text = prompt;
    if (session.separateTurn) {
      assert.ok(!session.mcpTools.some(tool => tool.name === action));
      // During the toggle test only the automatic queue may accept the inherited card.
      if (!autoMode && prompt.includes(normal)) {
        const id = normal;
        const snapshot = await call("task_review", { id });
        assert.ok(snapshot.ok, JSON.stringify(snapshot));
        const { revision, targetHead } = snapshot.data;
        const accepted = await call("task_accept", { id, revision, targetHead });
        assert.ok(accepted.ok, JSON.stringify(accepted));
      }
      text = "Processed reviewer approval.";
    } else {
      assert.ok(session.mcpTools.some(tool => tool.name === action));
      const input = replies.get(prompt);
      const receipt = await call(action, input);
      receipts.push(receipt);
      text = JSON.stringify(receipt);
    }
    return { text };
  };
  globalThis.fixtureDiscussion = async (_profile, _project, _settings, prompt, _images, _update, call) => {
    const authorization = JSON.parse(prompt).latestUserMessage.text;
    const before = show(hybrid).revision;
    const receipt = await call(action, { ...replies.get(authorization), authorization });
    if (!receipt.ok) assert.equal(show(hybrid).revision, before);
    receipts.push(receipt);
    return { text: JSON.stringify(receipt) };
  };

  app.setPath("userData", join(scratch, "profile-" + phase));
  app.setPath("appData", join(scratch, "app-data-" + phase));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  process.argv.push("--project", project);
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("replyToBoard, replyToTask, reviewWithCodex,", "")
    .replace("import { callCli, cliChild, cliFailure }", "import { callCli as realCallCli, cliChild, cliFailure }")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test-" + phase + ".mjs");
  // The test launches the production main and renderer with provider responses supplied locally.
  const nativeElectronPath = require.resolve("electron/package.json");
  const modulesPath = join(scratch, "node_modules");
  if (autoMode) symlinkSync(dirname(dirname(nativeElectronPath)), modulesPath, "junction");
  writeFileSync(entry, transformSync(`const { fixtureManager: replyToBoard, fixtureDiscussion: replyToTask, fixtureReview: reviewWithCodex } = globalThis;
const callCli = (...args) => globalThis.fixtureCli(realCallCli, ...args);
` + source + "\n globalThis.fixtureWindow = createWindow;", { loader: "ts", format: "esm" }).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  const bootstrap = window => window.webContents.executeJavaScript("window.taskboard.bootstrap()");
  const window = await waitFor(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading() && (await bootstrap(win)).board && win;
  }, "the fixture board");
  if (phase === "restart") {
    const { board } = await bootstrap(window);
    assert.equal(board.tasks.find(card => card.id === hybrid)?.reviewModeOverride.mode, "reviewer-human");
    assert.equal(board.tasks.find(card => card.id === normal)?.reviewModeOverride, undefined);
    log("PASS: a new Electron process loaded the persisted assignment and inheritance.");
    return;
  }

  const evaluate = (win, method, args) => win.webContents.executeJavaScript(
    `window.taskboard[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const manager = async (prompt, input) => {
    replies.set(prompt, input);
    const result = await evaluate(window, "boardRequest", [prompt, [], project, false, false]);
    assert.ok(result.ok && !result.data.error, JSON.stringify(result));
    return receipts.at(-1);
  };
  const discussion = async (text, input) => {
    replies.set(text, input);
    const result = await evaluate(window, "chatSend", [hybrid, { text, files: [], model: "fixture", effort: "low" }]);
    assert.ok(result.saved && result.result.ok, JSON.stringify(result));
    return receipts.at(-1);
  };
  assert.equal((await discussion("Use reviewer-human for " + normal, { mode: "reviewer-human" })).error.code, "USER_DIRECTION_REQUIRED");
  const rejected = [
    [hybrid + " currently uses reviewer mode.", "reviewer-human"],
    ["Set " + hybrid + " to reviewer-human or manager", "reviewer-human"],
    ["Set " + hybrid + " to reviewer-human", "manager"],
    ["Set " + hybrid + " to reviewer-human", null],
  ];
  for (const [prompt, mode] of rejected) {
    const before = show(hybrid).revision;
    assert.equal((await manager(prompt, { id: hybrid, mode, revision: before, authorization: prompt })).error.code, "USER_DIRECTION_REQUIRED");
    assert.equal(show(hybrid).revision, before);
    assert.equal((await discussion(prompt, { mode })).error.code, "USER_DIRECTION_REQUIRED");
  }
  assert.equal((await discussion("Установи режим «Ревью + человек» для этой карточки", { mode: "reviewer-human" })).data.inherited, false);
  assert.equal((await discussion("Верни наследование режима доски", { mode: null })).data.inherited, true);
  const ambiguous = "Use reviewer-human for " + hybrid + " or " + normal;
  assert.equal((await manager(ambiguous, { id: hybrid, mode: "reviewer-human", revision: show(hybrid).revision, authorization: ambiguous })).error.code,
    "USER_DIRECTION_REQUIRED");
  submit(hybrid);
  const approved = await waitFor(() => {
    const snapshot = review(hybrid);
    return snapshot.reviewerApproval && snapshot;
  }, "the original approval");
  if (autoMode) await waitFor(() => held, "the automatic acceptance request").catch(async error => {
    const { board, runningTasks, reviewingTasks } = await bootstrap(window);
    console.error(JSON.stringify({ error: error.message, autoMode: board.settings.autoMode, runningTasks, reviewingTasks,
      card: board.tasks.find(task => task.id === hybrid), observed }));
    throw error;
  });
  const history = show(hybrid).history;
  const authorization = "Назначь " + hybrid + " режим «Ревью + человек»";
  assert.equal((await manager(authorization, { id: hybrid, mode: "reviewer-human", revision: approved.revision, authorization })).data.reviewMode,
    "reviewer-human");
  if (autoMode) {
    release.resolve();
    await waitFor(() => raced, "the stale automatic accept to return");
  } else {
    raced = reply(["accept", hybrid], { actor: "manager", reviewMode: "reviewer",
      reviewModeVersion: approved.reviewModeVersion, revision: approved.revision, targetHead: approved.targetHead });
  }
  assert.equal(raced.error.code, "REVIEW_MODE_CHANGED");
  assert.deepEqual(show(hybrid).history.slice(0, history.length), history);
  log("PASS: both chats rejected mentions, ambiguity, a different mode and an unrequested reset without changing the revision. Assignment, inheritance and stale acceptance (" + raced.error.code + ") verified.");

  const second = globalThis.fixtureWindow([project]).window;
  await waitFor(async () => !second.webContents.isLoading() && (await bootstrap(second)).board, "the second board window");
  submit(normal);
  if (autoMode) {
    await waitFor(() => pausedAcceptance, "the inherited card's first acceptance request");
    cli(["settings"], { autoMode: false });
    resumeNormal.resolve();
    const rejection = await waitFor(() => retryRejection, "the temporary acceptance rejection");
    assert.equal(rejection.error.code, "AUTO_MODE_DISABLED");
    assert.equal(show(normal).status, "review");
    assert.equal(show(normal).revision, pausedAcceptance.revision);
    cli(["settings"], { autoMode: true });
  }
  await waitFor(() => show(normal).status === "done", "the inherited card to integrate");
  if (autoMode) {
    assert.equal(retryCount, 2);
    log("PASS: AUTO_MODE_DISABLED released the attempt. Re-enabling auto mode integrated the same approved revision exactly once.");
  }
  const waiting = await waitFor(() => {
    const snapshot = review(hybrid);
    return snapshot.awaitingHumanAcceptance && snapshot;
  }, "approval for personal acceptance");
  const marker = `/Awaiting human acceptance|Ожидает приёмки человеком/i.test(document.body.innerText)`;
  for (const win of [window, second]) {
    await waitFor(() => win.webContents.executeJavaScript(marker), "the visible personal acceptance marker");
  }
  if (autoMode) {
    second.focus();
    await second.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    await delay(350);
    writeFileSync(join(artifacts, "card-review-mode.png"), (await second.webContents.capturePage()).toPNG());
  }
  assert.equal(reply(["accept", hybrid], { actor: "user", revision: waiting.revision, targetHead: waiting.targetHead,
    reviewModeVersion: waiting.reviewModeVersion }).error.code, "HUMAN_ACCEPTANCE_REQUIRED");
  let decision = 0;
  dialog.showMessageBox = async () => ({ response: decision });
  const accept = () => evaluate(window, "command", ["accept", hybrid, {
    revision: waiting.revision, targetHead: waiting.targetHead, reviewModeVersion: waiting.reviewModeVersion, message: "fix: integrate personal card",
  }]);
  assert.equal((await accept()).error.code, "ACCEPTANCE_CANCELLED");
  assert.equal(show(hybrid).status, "review");
  decision = 1;
  assert.equal((await accept()).data.status, "done");
  assert.equal((await accept()).data.status, "done");
  for (const id of [hybrid, normal]) assert.equal(show(id).history.filter(event => event.action === "accept").length, 1);
  assert.equal(git("rev-list", "--count", "--first-parent", "HEAD"), "3");
  cli(["settings"], { reviewMode: "human" });
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer-human");
  log("PASS: both windows agreed, inherited card integrated automatically, personal card waited for the desktop dialog, exactly two integrations.");
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
