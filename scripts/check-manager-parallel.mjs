// Real Electron windows and production IPC/storage; deterministic provider boundary.
import { confirmFixtureDraft } from "../tests/fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { goalMessages, saveManagerHistory } from "../src/desktop/manager-history.ts";
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
const busyQuestion = "Когда будет готов отчёт?";
const pausedQuestion = "Какой результат уже готов?";
const attachmentQuestion = "Проверь приложенный снимок";
const attachment = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6uYUV8AAAAASUVORK5CYII=";
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

async function selectChatView(window, work) {
  await evaluate(window, `document.querySelector(${JSON.stringify(work ? ".board-work-toggle" : ".board-dialogue-toggle")}).click();`);
  await until(() => evaluate(window, "document.querySelector('.board-work').hidden === " + String(!work)), "selected chat view");
  const prompt = await evaluate(window, `({
    placeholder: document.querySelector('#board-draft .draft-placeholder').textContent,
    name: document.querySelector('#board-draft textarea[name=request]').getAttribute('aria-label')
  })`);
  assert.deepEqual(prompt, { placeholder: "Напишите менеджеру проекта…", name: "Сообщение менеджеру проекта" });
}

async function sendForm(window, text, work = false, keyboard = false) {
  await selectChatView(window, work);
  await evaluate(window, `{
    const input = document.querySelector('#board-draft textarea[name=request]');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', {bubbles:true}));
    ${keyboard
      ? "input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));"
      : "input.form.querySelector('.draft-send').click();"}
  }`);
  await until(() => evaluate(window, `document.querySelector('#board-draft textarea[name=request]').value === '' &&
    document.querySelector('.board-dialogue-toggle').getAttribute('aria-pressed') === 'true'`), "saved draft in Dialogue");
}

async function capture(window, name, retain = false) {
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  if (retain) {
    await window.webContents.capturePage();
    await delay(250);
  }
  assert.deepEqual(await evaluate(window, "[innerWidth, innerHeight, devicePixelRatio]"), [1280, 800, 1]);
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  const png = image.toPNG();
  assert.ok(png.length < 4 * 1024 * 1024);
  writeFileSync(join(retain ? artifacts : scratch, name), png);
}

async function checkManagerBubble(window, phase) {
  const original = await evaluate(window, "document.documentElement.dataset.theme");
  const samples = [];
  try {
    for (const theme of ["dark", "light"]) {
      assert.equal((await api(window, "setTheme", theme)).ok, true);
      await until(() => evaluate(window, "document.documentElement.dataset.theme === " + JSON.stringify(theme)), "theme " + theme);
      await until(() => evaluate(window, "[...document.querySelectorAll('.board-manager-message')].some(node => node.textContent.includes(" + JSON.stringify(dialogueAnswer) + "))"), "manager bubble");
      const sample = await evaluate(window, `(() => {
        const bubble = [...document.querySelectorAll('.board-manager-message')].find(node => node.textContent.includes(${JSON.stringify(dialogueAnswer)}));
        bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
        const panel = bubble.closest('.board-chat');
        const time = bubble.querySelector('.chat-time');
        const bounds = bubble.getBoundingClientRect();
        const clock = time.getBoundingClientRect();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const rgb = color => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const panelColor = getComputedStyle(panel).backgroundColor;
        const bubbleColor = getComputedStyle(bubble).backgroundColor;
        return { panelColor, bubbleColor, panelRGB: rgb(panelColor), bubbleRGB: rgb(bubbleColor),
          time: time.textContent, timeInside: time.parentElement === bubble && clock.left >= bounds.left &&
            clock.right <= bounds.right + 1 && clock.top >= bounds.top && clock.bottom <= bounds.bottom + 1 };
      })()`);
      samples.push({ phase, theme, ...sample });
      await capture(window, "manager-bubble-" + phase + "-" + theme + ".png");
    }
  } finally {
    assert.equal((await api(window, "setTheme", original)).ok, true);
  }
  console.log("BUBBLE " + JSON.stringify(samples));
  for (const sample of samples) {
    assert.ok(Math.max(...sample.panelRGB.map((channel, index) => Math.abs(channel - sample.bubbleRGB[index]))) >= 8,
      "Manager bubble must differ visibly from its panel: " + JSON.stringify(sample));
    assert.equal(sample.timeInside, true);
    assert.match(sample.time, /^\d{2}:\d{2}$/);
  }
  reports.push("Manager bubble " + phase + ": " + JSON.stringify(samples));
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
    confirmFixtureDraft(project, effectTask);
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

globalThis.parallelProvider = async (_profile, cwd, prompt, images, action, _tools, _instructions, signal, session) => {
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
    return { text: "Диалог снова свободен.", model: "Fixture provider" };
  }
  if (prompt === busyQuestion || prompt === pausedQuestion) {
    return { text: "Проверка отчёта уже завершена.", model: "Fixture provider" };
  }
  if (prompt === attachmentQuestion) {
    assert.deepEqual(images, ["data:image/png;base64," + attachment]);
    if (requests.filter(request => request.prompt === attachmentQuestion).length === 1) {
      throw new Error("Fixture declined the first attempt");
    }
    return { text: "Снимок получен.", model: "Fixture provider" };
  }
  if (prompt === "Передай цели первое указание" || prompt === "Передай цели второе указание") {
    const text = prompt.includes("первое") ? "Запиши первый результат" : "Запиши второй результат";
    assert.equal((await action("goal_send", { text })).ok, true);
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

    await evaluate(wide, `{
      const form = document.querySelector('#board-draft');
      form.querySelector('.draft-add').click();
      form.querySelector('.draft-menu-item:last-child').click();
    }`);
    await until(() => evaluate(wide, `(() => {
      const form = document.querySelector('#board-draft');
      return form.querySelector('.draft-placeholder').textContent === 'Опишите цель…' &&
        form.querySelector('textarea[name=request]').getAttribute('aria-label') === 'Опишите цель…';
    })()`), "objective prompt and accessible name");
    await evaluate(wide, `{
      const form = document.querySelector('#board-draft');
      const input = form.querySelector('textarea[name=request]');
      input.value = ${JSON.stringify(objective)};
      input.dispatchEvent(new Event('input', {bubbles:true}));
      form.querySelector('.draft-send').click();
    }`);
    await until(() => goalRun, "goal provider");
    await until(() => evaluate(other, "!document.querySelector('.board-chat-views').hidden"), "tabs in second window");
    pass("The separate goal action switches the composer to objective mode and starts exactly one goal turn.");
    assert.equal((await api(other, "boardRequest", "Duplicate goal", [], project, true)).error.code, "BOARD_REQUEST_IN_PROGRESS");
    await sendForm(wide, dialogueQuestion, true);
    await until(() => evaluate(wide, "document.querySelector('#board-chat').textContent.includes(" + JSON.stringify(dialogueAnswer) + ")"), "ordinary answer");
    const dialogueText = await evaluate(wide, "document.querySelector('#board-chat').textContent");
    assert.equal(dialogueText.includes("Ответ менеджера:"), false);
    assert.equal(dialogueText.split(dialogueQuestion).length - 1, 1);
    assert.equal((await history(other)).data.goalRunning, true);
    assert.equal(requests.filter(request => request.isGoal).length, 1);
    assert.notEqual(requests.find(request => request.isGoal).id, requests.find(request => !request.isGoal).id);
    await capture(wide, "manager-dialogue-route.png", true);
    assert.deepEqual(signals, []);
    assert.equal(goalRun.signal.aborted, false);
    await selectChatView(wide, true);
    await until(() => evaluate(wide, "document.querySelector('.board-work').innerText.includes('Цель выполняется.')"), "active goal history");
    assert.equal(await evaluate(wide, `document.querySelector('.board-work').innerText.includes(${JSON.stringify(dialogueQuestion)})`), false);
    await capture(wide, "goal-history-route.png", true);
    pass("Clicking Send from Goal Activity opens Dialogue with one question and answer. The same goal remains active and receives no interrupt, inbox entry, history item or signal. Both tabs label the composer for the manager.");
    await selectChatView(wide, false);
    await checkManagerBubble(wide, "live");

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
    await sendForm(wide, "Передай цели первое указание", true);
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
    pass("Explicit delegation from both tabs uses the manager's goal_send and goal_inbox. Repeated active-turn signals carry only a request to read goal_inbox. First instruction: one actual comment.");
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
    await until(async () => !(await history(wide, "work")).data.goalRunning, "original goal turn stopped");
    await until(() => evaluate(other, "document.querySelector('.board-goal-status').textContent.includes('паузе')"), "paused status");
    await capture(other, "manager-goal-paused.png");
    const pausedGoalId = (await history(wide, "work")).data.goalId;
    assert.ok(pausedGoalId);
    const pausedInbox = goalMessages(project, pausedGoalId);
    chatHold = Promise.withResolvers();
    await sendForm(wide, "Удержать ответ");
    await until(() => requests.some(request => request.prompt === "Удержать ответ"), "busy dialogue");
    await sendForm(wide, busyQuestion, false, true);
    await sendForm(wide, pausedQuestion, true, true);
    const queue = (await api(wide, "boardQueue", project, "list")).data;
    for (const question of [busyQuestion, pausedQuestion]) {
      assert.equal(queue.filter(entry => entry.draft === question).length, 1);
      assert.equal(requests.filter(request => request.prompt === question).length, 0);
    }
    chatHold.resolve();
    await until(async () => !(await api(wide, "boardQueue", project, "list")).data.length, "both queued messages delivered");
    const chatHistory = JSON.stringify((await history(wide)).data.turns);
    const workHistory = JSON.stringify((await history(wide, "work")).data.turns);
    for (const question of [busyQuestion, pausedQuestion]) {
      assert.equal(chatHistory.split(question).length - 1, 1);
      assert.equal(workHistory.includes(question), false);
      assert.equal(requests.filter(request => request.prompt === question).length, 1);
    }
    assert.equal((await history(wide, "work")).data.goal.status, "paused");
    assert.equal(requests.filter(request => request.isGoal).length, 1);
    assert.deepEqual(goalMessages(project, pausedGoalId), pausedInbox);
    pass("Enter from both tabs saves exactly one entry each while Dialogue is busy. Both messages are delivered once; the paused goal stays paused and its journal excludes them.");

    await selectChatView(wide, false);
    await evaluate(wide, `{
      const input = document.querySelector('#board-draft textarea[name=request]');
      const clipboardData = new DataTransfer();
      const bytes = Uint8Array.from(atob(${JSON.stringify(attachment)}), character => character.charCodeAt(0));
      clipboardData.items.add(new File([bytes], 'route.png', { type: 'image/png' }));
      input.value = ${JSON.stringify(attachmentQuestion)};
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles:true, cancelable:true }));
    }`);
    await selectChatView(wide, true);
    assert.equal(await evaluate(wide, "document.querySelector('#board-draft textarea[name=request]').value"), attachmentQuestion);
    assert.match(await evaluate(wide, "document.querySelector('#board-draft .draft-attachments').innerHTML"), /route\.png/);
    await sendForm(wide, attachmentQuestion, true);
    const failed = await until(async () => (await api(wide, "boardQueue", project, "list")).data.find(job => job.failed), "saved failed queue entry");
    assert.equal(failed.draft, attachmentQuestion);
    assert.equal(failed.files[0].name, "route.png");
    await until(() => evaluate(wide, `Array.from(document.querySelectorAll('.board-queued-status button'))
      .some(button => button.textContent === 'Повторить')`), "Retry control");
    await evaluate(wide, `Array.from(document.querySelectorAll('.board-queued-status button'))
      .find(button => button.textContent === 'Повторить').click()`);
    await until(async () => !(await api(wide, "boardQueue", project, "list")).data.length, "attachment message retried");
    const delivered = JSON.stringify((await history(wide)).data.turns);
    assert.equal(delivered.split(attachmentQuestion).length - 1, 1);
    assert.ok(delivered.includes("route.png") && delivered.includes("Снимок получен."));
    assert.equal(requests.filter(request => request.prompt === attachmentQuestion).length, 2);
    assert.deepEqual(goalMessages(project, pausedGoalId), pausedInbox);
    pass("The draft and pasted image survive switching tabs. A provider failure keeps the image and text in the failed dialogue job. Retry delivers both with one saved message and leaves the paused inbox unchanged.");
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
  await checkManagerBubble(wide, "restored");
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

  const paths = [
    "src/desktop/main.ts", "src/desktop/preload.cjs", "src/desktop/renderer.js", "src/desktop/styles.css",
    "src/desktop/chat.js", "src/desktop/manager-history.ts", "src/desktop/goal-actions.ts",
    "src/desktop/active-runs.ts", "src/desktop/locales/ru.json",
    "scripts/check-manager-parallel.mjs", "scripts/electron-check.mjs", "package-lock.json",
  ];
  const hashes = paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  writeFileSync(join(artifacts, "manager-message-routing.md"), [
    "# Проверка отправки сообщений менеджеру",
    "",
    "Windows Electron прошёл два запуска с одним временным профилем. Проверены два окна 1280×800 CSS-пикселей с масштабом 100% и изоляцией Chromium.",
    "",
    "- [Диалог после отправки](manager-dialogue-route.png) показывает вопрос, ответ, подсказку менеджера и активную цель.",
    "- [Ход цели после отправки](goal-history-route.png) показывает журнал той же цели и подсказку менеджера.",
    "",
    "Кнопка переносит обычный вопрос из «Хода цели» в «Диалог». Цель продолжает тот же ход без сигнала и без новой записи в очереди или журнале.",
    "Enter в обеих вкладках сохраняет по одному сообщению, пока диалог занят. После доставки и полного перезапуска текст сохранён ровно один раз, а цель остаётся на паузе.",
    "Черновик с PNG переживает смену вкладки. При отказе провайдера текст и PNG остаются в очереди, а «Повторить» отправляет их с одной записью в истории.",
    "Отдельно проверены постановка цели из поля и доставка явно порученных указаний через `goal_send`.",
    "",
    "| Платформа | Результат |",
    "| --- | --- |",
    "| Windows | Пройдено в Electron. |",
    "| Linux | Не запускалась. |",
    "| macOS | Не запускалась. |",
    "",
    "Стенд использует реальные события поля, мост IPC, очередь, журналы и действия цели. Ответы и сбой провайдера воспроизводятся локально. Реальный Codex, упаковка и обновление не проверялись.",
    "",
    "## Воспроизведение",
    "",
    "```powershell",
    "node scripts/check-manager-parallel.mjs --artifacts .tasks/qa",
    "```",
    "",
    "## Технические детали",
    "",
    "Среда — " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node в Electron " + process.versions.node,
      "Node запуска " + execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--version"], { encoding: "utf8" }).trim()].join(", "),
    "",
    "HEAD — `" + execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() + "`. SHA-256 исходных байтов worktree до тестовой подмены провайдера.",
    "",
    "```text", ...hashes, "```",
    "",
    "### Наблюдения стенда",
    "",
    ...reports.map(report => "- " + report),
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
