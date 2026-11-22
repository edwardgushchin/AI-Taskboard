// Exercise the board watcher, manager tools and CLI with an isolated Electron profile.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { registerRuntime } from "../src/desktop/board-runtime.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";

const baselinePhase = ["baseline"];
const retryPhases = [["ack-retry"], ["later-approval"]];
const phases = process.argv.includes("--retry-only") ? retryPhases :
  process.argv.includes("--baseline-only") ? [baselinePhase] : [baselinePhase, ...retryPhases];
const { scratch } = electronCheck(import.meta.url, "review-approval-wake", 240_000, phases);
const phase = process.argv.at(-1);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const counts = new Map();
const scenarios = new Map();
const reviewerSlots = [];
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
  cli(project, ["settings"], { autoMode, reviewMode, taskLimits: { reviewer: 1 } });
  // This fixture records reviewer decisions itself at the time required by each scenario.
  const release = registerRuntime(project, { task: "fixture:reviewer", kind: "slot", role: "reviewer" });
  assert.ok(release, "reserve the fixture reviewer slot");
  reviewerSlots.push(release);
  const result = submitCard(project, "Supplied result", useGit, reviewMode);
  const queued = cli(project, ["create"], plannedDraft({ title: "Unrelated ready task" }));
  confirmFixtureDraft(project, queued.id);
  cli(project, ["approve", queued.id]);
  if (autoMode) cli(project, ["auto-queue"], { revision: 0, paused: true });
  const state = { name, project, queued, useGit, autoMode, ...result };
  scenarios.set(project, state);
  counts.set(project, { background: 0, dialogue: 0, review: 0, accept: 0 });
  return state;
}

function submitCard(project, title, useGit, reviewMode) {
  const card = cli(project, ["create"], plannedDraft({ title }));
  confirmFixtureDraft(project, card.id);
  cli(project, ["approve", card.id]);
  const started = cli(project, ["start", card.id]);
  if (useGit) writeFileSync(join(started.worktree, "result.txt"), "Proof of integration\n");
  const preview = cli(project, ["preview", card.id, "--compact"]);
  cli(project, ["submit", card.id, "--compact"], {
    token: preview.token, summary: "Fixture result", checks: ["Read the result"],
    ...(useGit ? { message: "fix: supply reviewed result" } : { noChanges: true }),
  });
  const review = cli(project, ["review", card.id, "--compact"]);
  return {
    card,
    show: () => cli(project, ["show", card.id]),
    approve: () => cli(project, ["review-approve", card.id], {
      revision: review.revision, targetHead: review.targetHead,
      reviewMode, reviewModeVersion: review.reviewModeVersion,
      summary: "Fixture reviewed", evidence: ["Verified result"],
    }),
  };
}

async function ready(window, state) {
  const project = JSON.stringify(state.project);
  await waitFor("open board " + state.name, () => !window.webContents.isLoading() &&
    window.webContents.executeJavaScript(`window.taskboard?.bootstrap().then(f => f.board?.project === ${project} && !f.loading)`));
}

async function acceptApproval(id, action) {
  const reviewed = await action("task_review", { id });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const { revision, targetHead } = reviewed.data;
  return action("task_accept", { id, revision, targetHead });
}

function countAcceptance(result, count) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, "done");
  count.accept++;
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

async function runDialogue(window, state, prompt) {
  await window.webContents.executeJavaScript(
    `void (window.fixtureTurn = window.taskboard.boardRequest(${JSON.stringify(prompt)}, [], ${JSON.stringify(state.project)}, false, false))`,
  );
  await waitFor("occupied dialogue " + state.name, () => counts.get(state.project).dialogue === 1);
}

function approvalFailure(code) {
  return { ok: false, error: { code, message: "Injected fixture acceptance failure." } };
}

async function run() {
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  process.env.NODE_COMPILE_CACHE = join(scratch, "compile-cache");
  app.setPath("userData", join(scratch, "profile-" + phase));
  app.setPath("appData", join(scratch, "app-data-" + phase));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  const modules = join(scratch, "node_modules");
  if (!existsSync(modules)) {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), modules, "junction");
  }
  const noChanges = phase === "baseline" ? prepare("idle-no-changes") : undefined;
  const acknowledged = phase === "ack-retry" ? prepare("retry-after-ack") : undefined;
  const blockedBatch = phase === "later-approval" ? prepare("later-approval-after-conflicts") : undefined;
  const failed = blockedBatch ? [blockedBatch, ...Array.from({ length: 3 }, (_, index) =>
    submitCard(blockedBatch.project, "Conflicting result " + (index + 2), false, "reviewer"))] : [];
  const fifth = blockedBatch && submitCard(blockedBatch.project, "Result with available integration", false, "reviewer");
  const failedIds = failed.map(({ card }) => card.id);
  const batches = [];
  const ackGate = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let transientFailures = 0;
  let conflicts = 0;
  let acknowledgedThrough;
  if (blockedBatch) {
    for (const submission of [...failed, fifth]) {
      submission.approve();
    }
  }
  const initial = noChanges ?? acknowledged ?? blockedBatch;
  assert.ok(initial, "Unknown fixture phase " + phase);
  console.log(JSON.stringify({ phase, prepared: initial.name }));
  process.argv.push("--project", initial.project);
  globalThis.fixtureReview = async (_profile, project) => {
    counts.get(project).review++;
    providerError = new Error("An already approved submission should not start a reviewer.");
    throw providerError;
  };
  globalThis.fixtureManager = async (_profile, project, prompt, _images, action, _tools, _instructions, _signal, session) => {
    const state = scenarios.get(project);
    assert.ok(state);
    const count = counts.get(project);
    try {
      if (prompt === "Hold the dialogue open" || prompt === "Handle approval in dialogue") {
        count.dialogue++;
        session.save(randomUUID());
        session.onControl({ interrupt() {}, async steer() {} }, "QA");
        if (state === acknowledged) {
          await ackGate.promise;
          const id = state.card.id;
          const inbox = await action("manager_inbox", { replay: true });
          assert.equal(inbox.ok, true, JSON.stringify(inbox));
          const notice = inbox.data.find(entry => entry.id === id && entry.kind === "review-approve");
          assert.ok(notice, "the active manager received the approval");
          const accepted = await acceptApproval(id, (name, args) => {
            if (name !== "task_accept") return action(name, args);
            transientFailures++;
            return approvalFailure("BOARD_BUSY");
          });
          assert.equal(accepted.error?.code, "BOARD_BUSY");
          const ack = await action("manager_ack", { id, through: notice.sequence });
          assert.equal(ack.ok, true, JSON.stringify(ack));
          const afterAck = await action("manager_inbox", { replay: true });
          assert.equal(afterAck.ok, true, JSON.stringify(afterAck));
          assert.ok(!afterAck.data.some(entry => entry.id === id && entry.kind === "review-approve"));
          assert.equal(state.show().status, "review");
          acknowledgedThrough = notice.sequence;
        } else {
          await gate.promise;
        }
      } else {
        count.background++;
        assert.match(prompt, /recorded reviewer approvals/);
        assert.equal(session.goal, undefined);
        assert.deepEqual(session.mcpTools.map(tool => tool.name).sort(), ["task_accept", "task_review"]);
        const ids = JSON.parse(prompt.slice(prompt.lastIndexOf("\nCards: ") + "\nCards: ".length));
        if (state === blockedBatch) {
          batches.push(ids);
          for (const id of ids) {
            const accepted = await acceptApproval(id, (name, args) => {
              if (name !== "task_accept" || !failedIds.includes(id)) return action(name, args);
              conflicts++;
              return approvalFailure("MERGE_CONFLICT");
            });
            if (failedIds.includes(id)) {
              assert.equal(accepted.error?.code, "MERGE_CONFLICT");
            } else {
              assert.equal(id, fifth.card.id);
              countAcceptance(accepted, count);
            }
          }
        } else {
          assert.deepEqual(ids, [state.card.id]);
          countAcceptance(await acceptApproval(state.card.id, action), count);
        }
      }
      session.onTurnEnded();
      return { text: "Fixture complete", model: "Deterministic QA provider" };
    } catch (error) {
      providerError = error;
      throw error;
    }
  };

  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex", "readTaskRunHistory, replyToTask")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-" + phase + ".mjs");
  writeFileSync(entry, transformSync(
    "const replyToBoard = globalThis.fixtureManager;\nconst reviewWithCodex = globalThis.fixtureReview;\n" +
    source + "\nglobalThis.openFixture = project => createWindow([project]).window;\n",
    { loader: "ts", format: "esm" },
  ).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);

  const first = await waitFor("first window", () => BrowserWindow.getAllWindows()[0]);
  await ready(first, initial);
  console.log(JSON.stringify({ phase, open: initial.name }));
  if (noChanges) {
    await checkBaseline(first, noChanges, gate);
  } else if (acknowledged) {
    await runDialogue(first, acknowledged, "Handle approval in dialogue");
    acknowledged.approve();
    await waitFor("approval visible during dialogue", () => first.webContents.executeJavaScript(
      "window.taskboard.bootstrap().then(f => f.board.tasks.some(t => t.reviewApproved))",
    ));
    assert.equal(counts.get(acknowledged.project).background, 0);
    ackGate.resolve();
    await waitForAcceptance(acknowledged);
    assert.equal(transientFailures, 1);
    assert.equal(acknowledged.show().managerReadThrough, acknowledgedThrough);
    assert.equal(counts.get(acknowledged.project).background, 1);
    done(acknowledged, "done");
    console.log(JSON.stringify({ scenario: acknowledged.name, transientFailures, acknowledgedThrough }));
  } else {
    await waitFor("fifth approval accepted", () => counts.get(blockedBatch.project).accept === 1 && fifth.show().status === "done");
    assert.deepEqual(batches, [failedIds, [fifth.card.id]]);
    assert.equal(conflicts, 4);
    for (const submission of failed) {
      const card = submission.show();
      assert.equal(card.status, "review");
      assert.equal(card.history.filter(event => event.action === "accept").length, 0);
    }
    done({ ...blockedBatch, show: fifth.show }, "done");
    console.log(JSON.stringify({ scenario: blockedBatch.name, conflicts, batches }));
  }
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, git: git(scratch, "--version") }));
}

async function checkBaseline(first, noChanges, gate) {
  const second = globalThis.openFixture(noChanges.project);
  await ready(second, noChanges);
  noChanges.approve();
  await waitForAcceptance(noChanges);
  const reopened = globalThis.openFixture(noChanges.project);
  await ready(reopened, noChanges);
  assert.equal(counts.get(noChanges.project).background, 1);
  done(noChanges, "done");

  const repo = prepare("idle-git", { useGit: true });
  await ready(globalThis.openFixture(repo.project), repo);
  repo.approve();
  await waitForAcceptance(repo);
  assert.equal(counts.get(repo.project).background, 1);
  done(repo, "done");

  const busy = prepare("busy-dialogue");
  const dialogue = globalThis.openFixture(busy.project);
  await ready(dialogue, busy);
  await runDialogue(dialogue, busy, "Hold the dialogue open");
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

  const automatic = prepare("automatic", { autoMode: true });
  automatic.approve();
  await ready(globalThis.openFixture(automatic.project), automatic);
  await waitForAcceptance(automatic);
  assert.equal(counts.get(automatic.project).background, 0);
  done(automatic, "done");

  const hybrid = prepare("hybrid", { reviewMode: "reviewer-human" });
  hybrid.approve();
  await ready(globalThis.openFixture(hybrid.project), hybrid);
  await delay(1500);
  if (providerError) throw providerError;
  assert.equal(counts.get(hybrid.project).background, 0);
  done(hybrid, "review");
}

run().finally(() => {
  for (const release of reviewerSlots) {
    release();
  }
}).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
