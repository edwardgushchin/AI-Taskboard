import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Production IPC, manager action, persistence and two-window schedule checks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "schedule", 90_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
for (const name of ["profile", "appData", "project"]) mkdirSync(join(scratch, name));
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "appData"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
const project = join(scratch, "project");
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
const cli = (args, input, expectedError) => {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"),
    "--project", project, "--json", ...args, ...(input === undefined ? [] : ["--stdin"])], {
    encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch },
  });
  const reply = JSON.parse(result.stdout);
  if (expectedError) { assert.equal(reply.error?.code, expectedError); return reply; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return reply.data;
};
const waitFor = async predicate => {
  const until = Date.now() + 20000;
  while (!await predicate()) {
    assert.ok(Date.now() < until, "Timed out waiting for schedule UI");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
void (async () => { try {
  cli(["init"]);
  cli(["settings"], { autoMode: false });
  const indexPath = join(project, ".tasks", "board.json");
  for (const schedule of [{ everyMinutes: 60 }, { time: "09:00" }]) {
    const task = cli(["create"], plannedDraft({ title: "Schedule persistence", criteria: ["Checked"], schedule, workingDirectory: project }));
    confirmFixtureDraft(project, task.id);
    cli(["approve", task.id]);
    const paused = cli(["update", task.id], { schedulePaused: true });
    paused.schedule.nextAt = "2000-01-01T00:00:00Z";
    writeFileSync(join(project, ".tasks/tasks", task.id + ".json"), JSON.stringify(paused));
  }
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = (readFileSync(sourceUrl, "utf8") + `
    globalThis.scheduleCheck = { scheduleRecurringTasks, boardActions, reserveAgent,
      planning: project => autoBoards.get(subscriptions.get(project))?.running,
      stubReview(id, plan, review) {
        const request = runBoardRequest, submit = reviewSubmission;
        runBoardRequest = (...args) => args[2].includes("use expert_plan") && args[2].includes(id) ? plan() : request(...args);
        reviewSubmission = (watch, taskId, limit) => taskId === id ? review() : submit(watch, taskId, limit);
      },
      stubLegacy(id, plan, start) {
      const request = runBoardRequest, launch = launchTask;
      runBoardRequest = (...args) => args[2].includes("use expert_plan") && args[2].includes(id) ? plan() : request(...args);
      launchTask = (...args) => args[1] === id ? start(args[4], args[6]) : launch(...args);
    } };
  `)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main.mjs");
  writeFileSync(entry, require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code);
  require(entry);
  await waitFor(() => BrowserWindow.getAllWindows().length);
  const first = BrowserWindow.getAllWindows()[0];
  const evaluate = (window, code) => window.webContents.executeJavaScript(code);
  const open = async window => {
    await waitFor(() => evaluate(window, "!!window.taskboard"));
    await evaluate(window, "window.taskboard.menuAction('open-project')");
    await waitFor(async () => (await evaluate(window, "window.taskboard.bootstrap()")).board?.project === project);
  };
  await open(first);
  await evaluate(first, "window.taskboard.menuAction('new-window')");
  await waitFor(() => BrowserWindow.getAllWindows().length === 2);
  const second = BrowserWindow.getAllWindows().find(window => window !== first);
  await open(second);
  const snapshot = window => evaluate(window, "window.taskboard.bootstrap()");
  for (const window of [first, second]) {
    assert.ok((await snapshot(window)).board.tasks.every(task => task.schedule.paused));
  }
  // Initial application load and later ticks must ignore persisted overdue pauses.
  for (let i = 0; i < 3; i++) globalThis.scheduleCheck.scheduleRecurringTasks(Date.now() + 86400000);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(cli(["list"]).tasks.every(task => task.status === "ready"));
  const initial = cli(["show", "T-0001"]);
  const act = globalThis.scheduleCheck.boardActions(project, [], [], new AbortController().signal,
    () => assert.fail("Unexpected executor"), () => undefined, () => false, () => () => {}, async () => false,
    new Set(), () => new AbortController().signal);
  const resumed = await act("task_update", { id: initial.id, revision: initial.revision, note: "Resume schedule", schedulePaused: false });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await waitFor(async () => !(await snapshot(first)).board.tasks[0].schedule.paused && !(await snapshot(second)).board.tasks[0].schedule.paused);
  assert.ok(Date.parse(cli(["show", initial.id]).schedule.nextAt) > Date.now());
  const current = cli(["show", initial.id]);
  const paused = await evaluate(second, `window.taskboard.command('update', 'T-0001', {revision:${current.revision},schedulePaused:true})`);
  assert.equal(paused.ok, true);
  await waitFor(async () => (await snapshot(first)).board.tasks[0].schedule.paused);
  cli(["start", initial.id], { revision: current.revision, scheduled: true }, "INVALID_TRANSITION");
  // Simulate a due, already approved card written before the rule was mandatory.
  const outdated = { ...cli(["show", initial.id]), expertTeam: undefined };
  outdated.schedule = { ...outdated.schedule, paused: false, nextAt: "2000-01-01T00:00:00Z" };
  const planning = Promise.withResolvers();
  let requests = 0;
  let starts = 0;
  globalThis.scheduleCheck.stubLegacy(initial.id, async () => {
    requests++;
    await planning.promise;
    return { ok: true, data: {} };
  }, async (revision, scheduled) => {
    assert.equal(scheduled, true);
    const latest = cli(["show", initial.id]);
    if (latest.status !== "ready" || latest.revision !== revision) return { ok: false, error: { code: "REVISION_CONFLICT" } };
    const data = cli(["start", initial.id], { revision, scheduled });
    starts++;
    return { ok: true, data };
  });
  writeFileSync(join(project, ".tasks/tasks", initial.id + ".json"), JSON.stringify(outdated));
  const legacyIndex = JSON.parse(readFileSync(indexPath, "utf8"));
  legacyIndex.settings.requireExpertPlans = false;
  writeFileSync(indexPath, JSON.stringify(legacyIndex));
  await waitFor(async () => (await snapshot(first)).board.tasks.some(task => task.id === initial.id && !task.expertWorkPlanned));
  cli(["start", initial.id], { revision: outdated.revision, scheduled: true }, "EXPERT_PLAN_REQUIRED");
  globalThis.scheduleCheck.scheduleRecurringTasks();
  await waitFor(() => requests === 1);
  globalThis.scheduleCheck.scheduleRecurringTasks();
  const waiting = cli(["show", initial.id]);
  assert.equal(waiting.status, "ready");
  assert.equal(waiting.schedule.nextAt, outdated.schedule.nextAt);
  assert.equal(starts, 0);
  const repaired = await act("expert_plan", { id: initial.id, revision: waiting.revision, phase: "work",
    lead: "qa-engineer", reason: "Resume the saved schedule.", stages: [] });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  planning.resolve();
  await waitFor(async () => (await snapshot(first)).board.tasks.some(task => task.id === initial.id && task.expertWorkPlanned));
  globalThis.scheduleCheck.scheduleRecurringTasks();
  await waitFor(() => starts === 1 && cli(["show", initial.id]).status === "in_progress");
  await waitFor(async () => [first, second].every(window => !window.isDestroyed()) &&
    (await snapshot(first)).board.tasks.find(task => task.id === initial.id)?.status === "in_progress" &&
    (await snapshot(second)).board.tasks.find(task => task.id === initial.id)?.status === "in_progress");
  globalThis.scheduleCheck.scheduleRecurringTasks();
  assert.equal(starts, 1);
  assert.equal(requests, 1);
  for (const autoMode of [false, true]) {
    cli(["settings"], { reviewMode: "reviewer-human", autoMode });
    const { id } = cli(["create"], plannedDraft({ title: "Legacy review", criteria: ["Checked"], workingDirectory: project }));
    confirmFixtureDraft(project, id);
    cli(["approve", id]);
    cli(["start", id]);
    const { token } = cli(["preview", id]);
    cli(["submit", id], { token, noChanges: true, summary: "Saved result", checks: ["Checked"] });
    const cardPath = join(project, ".tasks/tasks", id + ".json");
    const card = JSON.parse(readFileSync(cardPath, "utf8"));
    const plan = { id, revision: card.revision, phase: "review", lead: "qa-engineer", reason: "Review the saved result.", stages: [] };
    const release = globalThis.scheduleCheck.reserveAgent(project, "executor", id);
    assert.ok(release);
    let attempts = 0, reviews = 0, result;
    globalThis.scheduleCheck.stubReview(id, async () => {
      attempts++;
      result = await act("expert_plan", plan);
      return result;
    }, async () => { reviews++; });
    try {
      delete card.expertTeam.review;
      writeFileSync(cardPath, JSON.stringify(card));
      const busy = await act("expert_plan", plan);
      assert.equal(busy.error?.code, "EXPERT_PHASE_RUNNING");
      await waitFor(async () => (await snapshot(first)).board.tasks.some(task => task.id === id && !task.expertReviewPlanned));
      globalThis.scheduleCheck.scheduleRecurringTasks();
      await waitFor(() => !globalThis.scheduleCheck.planning(project));
      assert.equal(attempts, 0, "A busy submission must not consume its planning request");
      assert.equal(reviews, 0);
      assert.equal(cli(["show", id]).revision, card.revision);
    } finally {
      release();
    }
    await waitFor(() => result !== undefined && reviews === 1);
    assert.equal(result?.ok, true, JSON.stringify(result));
    assert.equal(attempts, 1);
    const saved = cli(["show", id]);
    assert.equal(saved.expertTeam.review.lead, plan.lead);
    assert.equal(saved.revision, card.revision + 1);
    assert.equal(saved.status, "review");
  }
  if (keepArtifacts) {
    await evaluate(first, "document.querySelector('[data-task-id=\"T-0001\"]')?.click()");
    writeFileSync(join(artifacts, "schedule-two-windows.png"), (await first.webContents.capturePage()).toPNG());
  }
  console.log("Production schedule: persisted pauses, two windows, and a due legacy card with auto mode off requesting a plan then starting once: passed");
  console.log("Production review queue: a legacy submission waits for its executor slot, then saves the review plan and dispatches a reviewer with auto mode on and off: passed");
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(process.exitCode ?? 0);
} })();
