// Exercise the board watcher, manager tools and CLI with an isolated Electron profile.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";

const { scratch } = electronCheck(import.meta.url, "review-approval-wake", 180_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const counts = new Map();
const scenarios = new Map();
let providerError;

function cli(project, args, input, errorCode) {
  const child = spawnSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input ? ["--stdin"] : []),
  ], { cwd: scratch, encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true });
  assert.ifError(child.error);
  assert.ok(child.stdout, child.stderr);
  const result = JSON.parse(child.stdout);
  if (errorCode) {
    assert.equal(result.error?.code, errorCode, JSON.stringify(result));
  } else {
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  return result.data;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function waitFor(label, probe, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (providerError) throw providerError;
    const value = await probe();
    if (value) return value;
    await delay(75);
  }
  throw new Error("Timed out waiting for " + label);
}

function prepare(name, { useGit = false, autoMode = false, reviewMode = "reviewer" } = {}) {
  const project = join(scratch, name);
  mkdirSync(project);
  if (useGit) {
    git(project, "init", "--initial-branch=main");
    git(project, "config", "--local", "user.name", "Taskboard fixture");
    git(project, "config", "--local", "user.email", "fixture@example.invalid");
    git(project, "commit", "--allow-empty", "-m", "Initialize fixture");
  }
  cli(project, ["init"], { git: useGit });
  cli(project, ["settings"], { autoMode, reviewMode });
  const card = cli(project, ["create"], plannedDraft({ title: "Supplied result" }));
  cli(project, ["approve", card.id]);
  const started = cli(project, ["start", card.id]);
  if (useGit) writeFileSync(join(started.worktree, "result.txt"), "Proof of integration\n");
  const preview = cli(project, ["preview", card.id, "--compact"]);
  cli(project, ["submit", card.id, "--compact"], {
    token: preview.token, summary: "Fixture result", checks: ["Read the result"],
    ...(useGit ? { message: "fix: supply reviewed result" } : { noChanges: true }),
  });
  const queued = cli(project, ["create"], plannedDraft({ title: "Unrelated ready task" }));
  cli(project, ["approve", queued.id]);
  if (autoMode) cli(project, ["auto-queue"], { revision: 0, paused: true });
  const review = cli(project, ["review", card.id, "--compact"]);
  const state = {
    name, project, card, queued, review, useGit, autoMode, reviewMode,
    show: () => cli(project, ["show", card.id]),
    approve: () => cli(project, ["review-approve", card.id], {
      revision: review.revision, targetHead: review.targetHead,
      reviewMode, reviewModeVersion: review.reviewModeVersion,
      summary: "Fixture reviewed", evidence: ["Verified result"],
    }),
  };
  scenarios.set(project, state);
  counts.set(project, { background: 0, dialogue: 0, review: 0, accept: 0 });
  return state;
}

async function ready(window, state) {
  const project = JSON.stringify(state.project);
  await waitFor("open board " + state.name, () => !window.webContents.isLoading() &&
    window.webContents.executeJavaScript(`window.taskboard?.bootstrap().then(f => f.board?.project === ${project} && !f.loading)`));
}

async function integrate(state, action) {
  const id = state.card.id;
  const reviewed = await action("task_review", { id });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const { revision, targetHead } = reviewed.data;
  const accepted = await action("task_accept", { id, revision, targetHead });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.data.status, "done");
  counts.get(state.project).accept++;
}

async function waitForAcceptance(state) {
  await waitFor(state.name + " acceptance", () =>
    (state.autoMode || counts.get(state.project).accept === 1) && state.show().status === "done");
}

function done(state, expected) {
  const card = state.show();
  assert.equal(card.status, expected);
  const transitions = card.history.filter(event => event.action === "accept" && event.to === "done").length;
  assert.equal(transitions, expected === "done" ? 1 : 0);
  assert.equal(cli(state.project, ["show", state.queued.id]).status, "ready");
  assert.equal(Boolean(cli(state.project, ["settings"]).autoMode), state.autoMode);
  if (state.useGit && expected === "done") {
    assert.equal(readFileSync(join(state.project, "result.txt"), "utf8").trim(), "Proof of integration");
  }
  console.log(JSON.stringify({ scenario: state.name, ...counts.get(state.project), transitions }));
}

async function run() {
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  app.setPath("userData", join(scratch, "profile"));
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  const noChanges = prepare("idle-no-changes");
  const repo = prepare("idle-git", { useGit: true });
  const busy = prepare("busy-dialogue");
  const automatic = prepare("automatic", { autoMode: true });
  const hybrid = prepare("hybrid", { reviewMode: "reviewer-human" });
  const gate = Promise.withResolvers();
  process.argv.push("--project", noChanges.project);
  globalThis.fixtureReview = async (_profile, project) => {
    counts.get(project).review++;
    providerError = new Error("An already approved submission should not start a reviewer.");
    throw providerError;
  };
  globalThis.fixtureManager = async (_profile, project, prompt, _images, action, _tools, _instructions, _signal, session) => {
    const state = scenarios.get(project);
    assert.ok(state);
    const count = counts.get(project);
    if (prompt === "Hold the dialogue open") {
      count.dialogue++;
      session.save(randomUUID());
      session.onControl({ interrupt() {}, async steer() {} }, "QA");
      await gate.promise;
    } else {
      count.background++;
      assert.match(prompt, /recorded reviewer approvals/);
      assert.equal(session.goal, undefined);
      assert.deepEqual(session.mcpTools.map(tool => tool.name).sort(), ["task_accept", "task_review"]);
      try {
        await integrate(state, action);
      } catch (error) {
        providerError = error;
        throw error;
      }
    }
    session.onTurnEnded();
    return { text: "Fixture complete", model: "Deterministic QA provider" };
  };

  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex", "readTaskRunHistory, replyToTask")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(
    "const replyToBoard = globalThis.fixtureManager;\nconst reviewWithCodex = globalThis.fixtureReview;\n" +
    source + "\nglobalThis.openFixture = project => createWindow([project]).window;\n",
    { loader: "ts", format: "esm" },
  ).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);

  const first = await waitFor("first window", () => BrowserWindow.getAllWindows()[0]);
  await ready(first, noChanges);
  const second = globalThis.openFixture(noChanges.project);
  await ready(second, noChanges);
  noChanges.approve();
  await waitForAcceptance(noChanges);
  const reopened = globalThis.openFixture(noChanges.project);
  await ready(reopened, noChanges);
  assert.equal(counts.get(noChanges.project).background, 1);
  done(noChanges, "done");

  await ready(globalThis.openFixture(repo.project), repo);
  repo.approve();
  await waitForAcceptance(repo);
  assert.equal(counts.get(repo.project).background, 1);
  done(repo, "done");

  const dialogue = globalThis.openFixture(busy.project);
  await ready(dialogue, busy);
  await dialogue.webContents.executeJavaScript(
    `void (window.fixtureTurn = window.taskboard.boardRequest("Hold the dialogue open", [], ${JSON.stringify(busy.project)}, false, false))`,
  );
  await waitFor("occupied dialogue", () => counts.get(busy.project).dialogue === 1);
  busy.approve();
  await waitFor("approval visible during dialogue", () => dialogue.webContents.executeJavaScript(
    "window.taskboard.bootstrap().then(f => f.board.tasks.some(t => t.reviewApproved))",
  ));
  assert.equal(busy.show().status, "review");
  assert.equal(counts.get(busy.project).background, 0);
  gate.resolve();
  await waitForAcceptance(busy);
  assert.equal(counts.get(busy.project).background, 1);
  done(busy, "done");

  automatic.approve();
  await ready(globalThis.openFixture(automatic.project), automatic);
  await waitForAcceptance(automatic);
  assert.equal(counts.get(automatic.project).background, 0);
  done(automatic, "done");

  hybrid.approve();
  await ready(globalThis.openFixture(hybrid.project), hybrid);
  await delay(1500);
  if (providerError) throw providerError;
  assert.equal(counts.get(hybrid.project).background, 0);
  done(hybrid, "review");
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, git: git(scratch, "--version") }));
}

run().then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
