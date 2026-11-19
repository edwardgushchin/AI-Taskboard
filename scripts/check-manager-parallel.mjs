// Real Electron windows and production IPC/storage; deterministic provider boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { saveManagerHistory } from "../src/desktop/manager-history.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-parallel", 120_000, [[], ["--reopen"]]);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const reopen = process.argv.includes("--reopen");
const binding = join(project, ".tasks", "manager-dialog.json");
const statePath = join(scratch, "continuation.json");
const objective = "Проверить параллельную работу цели и диалога";
const dialogueQuestion = "Как идёт работа?";
const dialogueAnswer = "Цель продолжает работу, сейчас выполняется следующий шаг";
const queuedAnswer = "Указание поставлено в очередь цели. Жду подтверждения выполнения.";
const reports = reopen ? JSON.parse(readFileSync(statePath)).reports : [];
const requests = [];
const signals = [];
let goalRun;
let chatHold;
let effectTask;

function pass(text) {
  reports.push(text);
  console.log("PASS " + text);
}

function cli(args, input) {
  const reply = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE,
    ["--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project, "--json",
      ...args, ...(input === undefined ? [] : ["--stdin"])],
    { input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

async function until(probe, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await delay(40);
  }
  throw new Error("Timed out: " + label);
}

const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
const api = (window, method, ...args) => evaluate(window,
  "window.taskboard." + method + "(" + args.map(value => JSON.stringify(value)).join(",") + ")");
const history = (window, view = "chat") => api(window, "boardHistory", project, null, view);
async function startCall(window, key, method, ...args) {
  await evaluate(window, "window[" + JSON.stringify(key) + "] = window.taskboard." + method + "(" +
    args.map(value => JSON.stringify(value)).join(",") + "); undefined");
  return () => evaluate(window, "window[" + JSON.stringify(key) + "]");
}

async function openChat(window) {
  window.setContentSize(1280, 800);
  await until(async () => !window.webContents.isLoading() &&
    await evaluate(window, "!!document.querySelector('#board-draft textarea[name=request]')"), "composer");
  await evaluate(window, "document.querySelector('#board-draft textarea[name=request]').dispatchEvent(" +
    "new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
  await until(() => evaluate(window, "document.querySelector('#board-draft').hasAttribute('data-open')"), "open chat");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
}

async function sendForm(window, text, work = false) {
  await until(() => evaluate(window, "document.querySelector('#board-draft').getAttribute('aria-busy') === 'false'"), "available composer");
  await evaluate(window, `document.querySelector(${JSON.stringify(work ? ".board-work-toggle" : ".board-dialogue-toggle")}).click();`);
  await until(() => evaluate(window, "document.querySelector('.board-work').hidden === " + String(!work)), "selected chat view");
  await evaluate(window, `
    document.querySelector('#board-draft textarea[name=request]').value = ${JSON.stringify(text)};
    document.querySelector('#board-draft textarea[name=request]').dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#board-draft').requestSubmit();`);
}

async function capture(window, name) {
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  const png = image.toPNG();
  assert.ok(png.length < 4 * 1024 * 1024);
  writeFileSync(join(artifacts, name), png);
}

function prepare() {
  if (!reopen) {
    mkdirSync(project);
    cli(["init"]);
    cli(["settings"], { autoMode: false, reviewMode: "reviewer" });
    const lead = { lead: "qa-engineer", reason: "Изолированная проверка", stages: [] };
    effectTask = cli(["create"], {
      title: "Счётчик эффектов",
      description: "Изолированная проверка",
      criteria: ["Два разных указания дают два комментария"],
      expertTeam: { work: lead, review: lead },
    }).id;
    // Prepare the counter before the desktop watcher can start draft analysis.
    cli(["approve", effectTask]);
    saveManagerHistory(project, Date.now() - 2000, randomUUID(), {
      message: { text: "UNCLASSIFIED-LEGACY", files: [] },
      items: [{ id: "legacy-answer", type: "agentMessage", title: "", text: "UNCLASSIFIED-LEGACY", status: "completed" }],
    });
    saveManagerHistory(project, Date.now() - 1000, randomUUID(), {
      lane: "chat", message: { text: "Покажи состояние доски", files: [] },
      items: [{ id: randomUUID(), type: "agentMessage", title: "", text: "Доска готова к работе.", status: "completed", phase: "final_answer" }],
    });
  }
  app.setPath("userData", join(scratch, "profile"));
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  if (!existsSync(join(scratch, "node_modules"))) {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  }
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal",
      "readTaskRunHistory, replyToTask, reviewWithCodex")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const fixture = [
    "const replyToBoard = (...args) => globalThis.parallelProvider(...args);",
    "const updateBoardGoal = (...args) => globalThis.parallelGoalControl(...args);",
    source,
    "globalThis.openParallelWindow = project => createWindow([project]).window;",
    'globalThis.repeatInboxSignal = () => boardWorkRequests.get(projectIdentity(' + JSON.stringify(project) + '))?.wakeGoal?.();',
  ].join("\n");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, require("esbuild").transformSync(fixture, { loader: "ts", format: "esm" }).code);
  require(entry);
}

globalThis.parallelProvider = async (_profile, cwd, prompt, _images, action, _tools, _instructions, signal, session) => {
  assert.equal(cwd, project);
  const isGoal = Boolean(session.goal || session.resumeGoal);
  const id = session.id ?? randomUUID();
  if (!session.id) {
    session.save(id);
  }
  const context = isGoal ? "manager:context" : "manager:dialogue";
  assert.equal(runtimeEntries(project).filter(entry => entry.task === context).length, 1);
  requests.push({ prompt, id, isGoal, resume: Boolean(session.resumeGoal) });
  session.onControl({ steer: async text => signals.push({ isGoal, text }), interrupt: async () => {} }, "Fixture provider");
  if (isGoal) {
    const done = Promise.withResolvers();
    goalRun = { action, session, done, signal };
    session.onGoal({ objective, status: "active" });
    session.onGoalSet();
    session.onGoalControl(async change => {
      const goal = change.kind === "clear" ? null : { objective: change.objective ?? objective,
        status: change.kind === "pause" ? "paused" : "active" };
      session.onGoal(goal);
      if (change.kind === "pause" || change.kind === "clear") {
        done.resolve();
      }
      return goal;
    });
    session.onActivity([{ id: randomUUID(), at: new Date().toISOString(), type: "agentMessage", title: "", phase: "commentary",
      text: "Цель выполняется. Проверяю результаты и ожидаю указания через очередь.", status: "completed" }]);
    await done.promise;
    return { text: "Ход цели сохранён.", model: "Fixture provider" };
  }
  if (prompt === "Удержать ответ") {
    await chatHold.promise;
  }
  if (prompt === "Передай цели второе указание") {
    assert.equal((await action("goal_send", { text: "Запиши второй результат" })).ok, true);
    return { text: queuedAnswer, model: "Fixture provider" };
  }
  return { text: dialogueAnswer, model: "Fixture provider" };
};

globalThis.parallelGoalControl = async (_profile, _cwd, _id, change) => {
  assert.equal(change.kind, "clear");
  return null;
};

function commentCount(task, text) {
  return cli(["show", task]).history.filter(event => event.text === text).length;
}

async function run() {
  prepare();
  const wide = await until(() => BrowserWindow.getAllWindows()[0], "first window");
  await openChat(wide);
  const other = globalThis.openParallelWindow(project);
  await openChat(other);
  if (!reopen) {
    await until(() => evaluate(wide, "document.querySelector('#board-chat').textContent.includes('Доска готова к работе.')"), "saved dialogue");
    assert.equal(await evaluate(wide, "document.querySelector('.board-chat-views').hidden"), true);
    assert.equal(await evaluate(wide, "document.querySelector('#board-chat').textContent.includes('UNCLASSIFIED-LEGACY')"), false);
    await capture(wide, "manager-dialog-without-goal.png");
    pass("No goal/log: dialogue and composer are visible; the tab switch and visible Dialogue caption are absent. Unclassified local history is hidden.");

    const goalReply = await startCall(wide, "goalReply", "boardRequest", objective, [], project, true);
    await until(() => goalRun, "goal provider");
    await until(() => evaluate(other, "!document.querySelector('.board-chat-views').hidden"), "tabs in second window");
    assert.equal((await api(other, "boardRequest", "Duplicate goal", [], project, true)).error.code, "BOARD_REQUEST_IN_PROGRESS");
    await sendForm(wide, dialogueQuestion);
    await until(() => evaluate(wide, "document.querySelector('#board-chat').textContent.includes(" + JSON.stringify(dialogueAnswer) + ")"), "ordinary answer");
    const dialogueText = await evaluate(wide, "document.querySelector('#board-chat').textContent");
    assert.equal(dialogueText.includes("Ответ менеджера:"), false);
    assert.equal(dialogueText.split(dialogueQuestion).length - 1, 1);
    assert.equal((await history(other)).data.goalRunning, true);
    assert.equal(requests.filter(request => request.isGoal).length, 1);
    assert.notEqual(requests.find(request => request.isGoal).id, requests.find(request => !request.isGoal).id);
    await capture(wide, "manager-parallel-dialog.png");
    pass("An ordinary question submitted through the form receives its answer while the original goal is still running, without pause/restart. Goal and dialogue have distinct provider thread IDs and one writer each.");

    const reference = await goalRun.action("goal_dialogue", {});
    assert.equal(reference.ok, true);
    assert.equal(reference.data.referenceOnly, true);
    const recent = reference.data.messages.filter(message => [dialogueQuestion, dialogueAnswer].includes(message.text));
    assert.deepEqual(recent.map(message => message.author), ["user", "manager"]);
    assert.deepEqual(recent.map(message => message.text), [dialogueQuestion, dialogueAnswer]);
    assert.ok(recent.every(message => message.id && Number.isFinite(Date.parse(message.at))));
    assert.deepEqual((await goalRun.action("goal_dialogue", {})).data, reference.data);
    assert.deepEqual((await goalRun.action("goal_inbox", {})).data, []);
    assert.equal(requests.filter(request => request.isGoal).length, 1);
    pass("goal_dialogue reads the same board's question and answer with stable IDs, author and time. Two reads and the ordinary message leave the inbox empty and the goal turn count at one.");

    const task = effectTask;
    await sendForm(wide, "Запиши первый результат", true);
    const first = await until(async () => (await goalRun.action("goal_inbox", {})).data[0], "first inbox instruction");
    const actionInput = { id: task, revision: cli(["show", task]).revision, text: "Измеримый эффект", goalMessageId: first.id, goalActionKey: "record-result" };
    const result = await goalRun.action("task_comment", actionInput);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await goalRun.action("goal_inbox", { id: first.id, status: "applied", reply: "Первый результат записан." })).ok, true);
    await sendForm(other, "Передай цели второе указание");
    const second = await until(async () => (await goalRun.action("goal_inbox", {})).data[0], "manager-transferred instruction");
    await until(() => evaluate(other, "document.querySelector('#board-chat').textContent.includes(" + JSON.stringify(queuedAnswer) + ")"), "queued confirmation");
    assert.notEqual(second.id, first.id);
    assert.equal(second.text, "Запиши второй результат");
    globalThis.repeatInboxSignal();
    globalThis.repeatInboxSignal();
    assert.ok(signals.filter(signal => signal.isGoal).length >= 3);
    assert.ok(signals.filter(signal => signal.isGoal).every(signal =>
      !signal.text.includes(first.text) && !signal.text.includes(second.text)));
    assert.equal(commentCount(task, "Измеримый эффект"), 1);
    pass("Both form submission from Goal Activity and goal_send from the manager use goal_inbox. Repeated active-turn signals carry only: AI Taskboard: new user directions are available. Read goal_inbox. First instruction: one actual comment.");
    await evaluate(wide, "document.querySelector('.board-work-toggle').click()");
    await until(() => evaluate(wide, "document.querySelector('.board-work').textContent.includes('Цель выполняется.')"), "goal log");
    await evaluate(wide, `(async () => {
      for (let index = 0; index < 10; index++) {
        document.querySelector('.board-chat-resize').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      for (const summary of document.querySelectorAll('.board-work details.chat-work:not([open]) > summary')) {
        summary.click();
      }
      document.querySelector('.board-work').scrollTop = 0;
    })()`);
    await capture(wide, "manager-goal-log.png");
    assert.equal((await api(wide, "boardGoal", "pause")).ok, true);
    assert.equal((await goalReply()).ok, true);
    await until(() => evaluate(other, "document.querySelector('.board-goal-status').textContent.includes('паузе')"), "paused status");
    await capture(other, "manager-goal-paused.png");
    const before = (await history(wide)).data;
    assert.ok((await history(wide, "work")).data.turns.some(turn => turn.items.some(item => item.text === "Цель на паузе")));
    writeFileSync(statePath, JSON.stringify({ reports, task, actionInput, result, first: first.id, second: second.id,
      reference: recent, chat: before.turns, work: (await history(wide, "work")).data.turns }));
    pass("Pause is visible in both windows. The next phase restarts the entire Electron process using the same saved board and profile, with one processed and one pending instruction.");
    const saved = JSON.parse(readFileSync(statePath));
    saved.reports = reports;
    writeFileSync(statePath, JSON.stringify(saved));
    return;
  }

  const saved = JSON.parse(readFileSync(statePath));
  const restored = (await history(wide)).data;
  assert.equal(restored.goal.status, "paused");
  assert.deepEqual(JSON.parse(JSON.stringify(restored.turns)), saved.chat);
  assert.deepEqual(JSON.parse(JSON.stringify((await history(other, "work")).data.turns)), saved.work);
  const resumedReply = await startCall(wide, "resumeReply", "boardGoal", "resume", objective);
  await until(() => goalRun, "resumed provider");
  assert.equal((await api(other, "boardGoal", "resume", objective)).ok, true);
  assert.equal(requests.filter(request => request.isGoal).length, 1);
  assert.deepEqual((await goalRun.action("goal_inbox", {})).data.map(message => message.id), [saved.second]);
  const reference = (await goalRun.action("goal_dialogue", {})).data.messages;
  assert.deepEqual(reference.filter(message => [dialogueQuestion, dialogueAnswer].includes(message.text)), saved.reference);
  globalThis.repeatInboxSignal();
  assert.deepEqual(await goalRun.action("task_comment", saved.actionInput), saved.result);
  assert.equal(commentCount(saved.task, "Измеримый эффект"), 1);
  const secondInput = { ...saved.actionInput, revision: cli(["show", saved.task]).revision, goalMessageId: saved.second };
  assert.equal((await goalRun.action("task_comment", secondInput)).ok, true);
  assert.equal((await goalRun.action("goal_inbox", { id: saved.second, status: "applied", reply: "Второй результат записан." })).ok, true);
  assert.deepEqual((await goalRun.action("goal_inbox", {})).data, []);
  assert.equal(commentCount(saved.task, "Измеримый эффект"), 2);
  pass("Fresh Electron process restores exact dialogue, goal log and paused state without gaps/duplicates. Controlled context loss/continuation retains ordinary history, excludes the processed ID, delivers the pending new ID, and repeats the signal. Old action ID returns its saved result (effects 1); new instruction ID produces one independent effect (total 2). Native-provider compaction was not exercised.");

  chatHold = Promise.withResolvers();
  const held = await startCall(wide, "heldReply", "boardRequest", "Удержать ответ");
  await until(() => requests.some(request => request.prompt === "Удержать ответ"), "dialogue writer");
  assert.equal((await api(other, "boardRequest", "Concurrent dialogue")).error.code, "BOARD_REQUEST_IN_PROGRESS");
  assert.equal((await api(other, "boardGoal", "pause")).ok, true);
  assert.equal((await resumedReply()).ok, true);
  chatHold.resolve();
  assert.equal((await held()).ok, true);
  pass("Second-window resume creates no second goal launch; concurrent dialogue creates no second dialogue writer. Pausing the goal while the ordinary answer is held does not interrupt that answer.");

  const completeReply = await startCall(wide, "completeReply", "boardGoal", "resume", objective);
  const previous = goalRun;
  await until(() => goalRun !== previous, "final goal continuation");
  goalRun.session.onGoal({ objective, status: "complete" });
  goalRun.done.resolve();
  assert.equal((await completeReply()).ok, true);
  await evaluate(wide, "document.querySelector('.board-work-toggle').click()");
  await until(() => evaluate(wide, "document.querySelector('.board-work').textContent.includes('выполнена')"), "completed log status");
  await capture(wide, "manager-goal-completed.png");
  assert.equal((await api(wide, "boardGoal", "clear")).ok, true);
  assert.ok((await history(wide, "work")).data.turns.some(turn => turn.items.some(item => item.text === "Цель выполнена")));
  for (const name of readdirSync(join(project, ".tasks", "manager-chat"))) {
    const path = join(project, ".tasks", "manager-chat", name);
    if (JSON.parse(readFileSync(path)).goalId) {
      rmSync(path);
    }
  }
  await until(() => evaluate(wide, "document.querySelector('.board-chat-views').hidden && document.querySelector('.board-work').hidden"), "return to dialogue when log removed");
  assert.equal(await evaluate(wide, "!document.querySelector('.board-chat-log:not(.board-work)').hidden"), true);
  pass("Goal Activity remains available with explicit paused/completed statuses. Removing the available goal log while it is open returns the UI to dialogue and hides both tab captions without reopening the app.");

  const paths = ["src/desktop/main.ts", "src/desktop/renderer.js", "src/desktop/chat.js", "src/desktop/manager-history.ts", "src/desktop/goal-actions.ts",
    "src/desktop/active-runs.ts", "src/desktop/locales/ru.json", "scripts/check-manager-parallel.mjs"];
  const hashes = paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  writeFileSync(join(artifacts, "manager-parallel-check.txt"), [
    "Command: node scripts/check-manager-parallel.mjs --artifacts .tasks/qa",
    "Tested commit: " + execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    "SHA-256 of tested worktree bytes before provider substitution:", ...hashes,
    "Runtime: " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node " + process.versions.node].join(", "),
    "Windows: PASS, two 1280x800 sandboxed renderer windows, full Electron process restart.",
    "Linux/macOS: not run; context paths use node:path, shared locking uses existing cross-platform SQLite runtime. No packaging changes.",
    "Provider: deterministic boundary; application IPC, locks, history, inbox and task_comment actions are production code. Context compaction is simulated by discarding provider context and restarting; no live Codex compaction claim.",
    ...reports,
  ].join("\n") + "\n");
}

void run().then(() => app.exit(0), error => {
  console.error(error);
  console.error("Provider requests:", requests);
  for (const window of BrowserWindow.getAllWindows()) {
    void evaluate(window, "document.querySelector('#board-draft')?.textContent").then(text => console.error(text));
  }
  setTimeout(() => app.exit(1), 100);
});
