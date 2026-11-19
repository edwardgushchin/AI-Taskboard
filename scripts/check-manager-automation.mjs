// Production Electron, manager delivery and history; deterministic provider boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { registerRuntime } from "../src/desktop/board-runtime.ts";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-automation", 120_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const report = [];
const pass = text => {
  report.push("PASS " + text);
  console.log("PASS " + text);
};
const exactAnswer = "Вопросов, требующих ответа, нет.";
const firstAnswer = "Создал демонстрационную задачу. Изменения очереди обработаны.";
let releaseRuntime;
let current;
let calls = 0;
const steers = [];
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
process.env.GIT_CEILING_DIRECTORIES = scratch;
process.argv.push("--project", project);

function data(args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE,
    ["--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json", ...args,
      ...(input ? ["--stdin"] : [])],
    { cwd: scratch, windowsHide: true, encoding: "utf8", input: input && JSON.stringify(input) }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function waitFor(probe, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}
const evaluate = (window, code) => window.webContents.executeJavaScript(code);
const history = window => evaluate(window, "window.taskboard.boardHistory(" + JSON.stringify(project) + ")");
const finalItems = response => response.data.turns.flatMap(turn => turn.items)
  .filter(item => item.type === "agentMessage" && item.phase === "final_answer");
async function ready(window) {
  window.setContentSize(1280, 800);
  await waitFor(async () => !window.webContents.isLoading() && await evaluate(window,
    "Boolean(document.querySelector('#board-draft textarea[name=request]')) && document.querySelector('#lanes')?.innerText.includes('Демонстрационная задача')"), "loaded board and composer");
  await evaluate(window, "document.querySelector('#board-draft textarea[name=request]').click()");
  await waitFor(() => evaluate(window, "document.querySelector('#board-draft').hasAttribute('data-open')"), "open dialogue");
}
async function request(window, prompt) {
  const previous = calls;
  await evaluate(window, "window.fixtureReply = window.taskboard.boardRequest(" +
    [prompt, [], project, false, false].map(value => JSON.stringify(value)).join(",") + "); void 0");
  await waitFor(() => calls > previous && current?.ready, "provider callback").catch(async error => {
    const outcome = await evaluate(window, "Promise.race([window.fixtureReply, Promise.resolve('pending')])");
    throw new Error(error.message + ": " + JSON.stringify(outcome));
  });
  await delay(500);
}
async function finish(window) {
  current.gate.resolve();
  const result = await evaluate(window, "window.fixtureReply");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.error, undefined, JSON.stringify(result));
  await waitFor(() => evaluate(window, "window.taskboard.bootstrap().then(f => !f.managerBusy)"), "finished manager");
  return result;
}
async function markRead(window) {
  const frame = await evaluate(window, "window.taskboard.bootstrap()");
  await evaluate(window, "window.taskboard.readManagerMessages(" + JSON.stringify(project) + "," + JSON.stringify(frame.managerUnread) + ")");
  await delay(150);
}
async function reopen(window) {
  const restored = globalThis.openAutomationWindow(project);
  await ready(restored);
  window.hide();
  return restored;
}
async function silent(window, expectedFinals, baseline) {
  assert.equal(steers.length, baseline, "queue update entered control.steer");
  assert.equal(finalItems(await history(window)).length, expectedFinals);
  const frame = await evaluate(window, "window.taskboard.bootstrap()");
  assert.deepEqual(frame.managerUnread, []);
  assert.equal(await evaluate(window, "document.querySelectorAll('.project-tab-unread, .board-chat-unread').length"), 0);
}

void (async () => {
  try {
    mkdirSync(project);
    data(["init"], { git: false });
    data(["settings"], { autoMode: true, reviewMode: "reviewer-human" });
    data(["auto-queue"], { revision: 0, paused: true });
    const draft = data(["create"], plannedDraft({ title: "Демонстрационная задача" }));
    data(["approve", draft.id]);
    data(["start", draft.id]);
    releaseRuntime = registerRuntime(project, { task: draft.id, kind: "slot", role: "executor" });
    assert.ok(releaseRuntime);
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
    const thread = randomUUID();
    globalThis.automationProvider = async (_profile, cwd, prompt, _images, action, _tools, _instructions, _signal, session) => {
      assert.equal(cwd, project);
      calls++;
      if (!session.id) session.save(thread);
      if (session.messageId) session.onMessage(session.messageId);
      const state = { ready: false, gate: Promise.withResolvers(), received: [], waiting: false };
      current = state;
      session.onControl({
        interrupt() {},
        async steer(text, _files, id) {
          steers.push(text);
          if (id) {
            state.received.push(text);
            session.onMessage(id);
          }
        },
      }, "Deterministic QA provider");
      session.onActivity([{ id: randomUUID(), type: "agentMessage", phase: "commentary", title: "",
        text: "Проверяю состояние очереди.", status: "inProgress" }]);
      if (prompt === "Дождись вопроса исполнителя") {
        await delay(400);
        await action("manager_inbox", {});
        state.waiting = true;
        const waiting = action("task_wait", { ids: [draft.id] });
        state.ready = true;
        const response = await waiting;
        assert.equal(response.ok, true, JSON.stringify(response));
        state.inbox = response.data.inbox;
        state.waiting = false;
      } else {
        state.ready = true;
      }
      await state.gate.promise;
      let text = firstAnswer;
      if (state.received.length) {
        text = exactAnswer;
      } else if (prompt === "Дождись вопроса исполнителя") {
        text = "Вопросы исполнителя получены через входящие.";
      }
      session.onActivity([{ id: randomUUID(), type: "agentMessage", phase: "final_answer", title: "",
        text, status: "completed" }]);
      session.onTurnEnded();
      return { text, model: "Deterministic QA provider" };
    };
    const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8")
      .replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask")
      .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
    const entry = join(scratch, "main-under-test.mjs");
    writeFileSync(entry, transformSync("const replyToBoard = (...args) => globalThis.automationProvider(...args);\n" + source +
      "\nglobalThis.openAutomationWindow = project => createWindow([project]).window;",
      { loader: "ts", format: "esm" }).code);
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    require(entry);
    let window = await waitFor(() => BrowserWindow.getAllWindows()[0], "main window");
    await ready(window);
    await request(window, "Создай демонстрационную задачу");
    const baseline = steers.length;
    data(["progress", draft.id], { summary: "Обычный прогресс", nextStep: "Продолжить проверку" });
    await delay(1200);
    await silent(window, 0, baseline);
    pass("Routine progress during an active answer: no steer, final reply or unread indicator.");
    await finish(window);
    await markRead(window);
    data(["message", draft.id], { kind: "update", text: "Служебное обновление после ответа" });
    await delay(1000);
    await silent(window, 1, baseline);
    pass("Immediately after the answer: no extra reply, turn or unread indicator.");
    await evaluate(window, "document.querySelector('#board-draft').closeChat()");
    await ready(window);
    window = await reopen(window);
    await waitFor(() => evaluate(window, "document.querySelector('.board-chat-log')?.innerText.includes(" + JSON.stringify(firstAnswer) + ")"), "restored answer");
    await silent(window, 1, baseline);
    window.show();
    window.focus();
    window.webContents.focus();
    await delay(100);
    await evaluate(window, "document.querySelector('.board-chat-resize').focus({preventScroll:true})");
    for (let step = 0; step < 13; step++) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Up" });
    }
    await evaluate(window, "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
    assert.equal(await evaluate(window, "(() => { const log = document.querySelector('.board-chat-log'); return log.scrollHeight <= log.clientHeight + 1; })()"), true,
      "the captured dialogue contains both complete messages without clipping");
    const png = await window.webContents.capturePage();
    assert.deepEqual(png.getSize(), { width: 1280, height: 800 });
    writeFileSync(join(artifacts, "manager-automation-dialog.png"), png.toPNG());
    pass("Closed/reopened dialogue and a fresh window restored the single real answer; 1280x800 PNG captured.");
    await request(window, "Проверь, есть ли вопросы");
    const duringUser = steers.length;
    data(["message", draft.id], { kind: "update", text: "Одновременный служебный прогресс" });
    const id = randomUUID();
    const queued = await evaluate(window, "window.taskboard.boardQueue(" +
      [project, "add", id, "Сообщи, есть ли вопросы", false, []].map(value => JSON.stringify(value)).join(",") + ")");
    assert.equal(queued.ok, true, JSON.stringify(queued));
    const sent = await evaluate(window, "window.taskboard.boardRequest(" +
      ["Сообщи, есть ли вопросы", [], project, false, true, id].map(value => JSON.stringify(value)).join(",") + ")");
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.deepEqual(current.received, ["Сообщи, есть ли вопросы"]);
    await delay(1000);
    assert.equal(steers.length, duringUser + 1);
    const answered = await finish(window);
    assert.equal(answered.data.answer, exactAnswer);
    assert.ok(finalItems(await history(window)).some(item => item.text === exactAnswer));
    window = await reopen(window);
    await waitFor(() => evaluate(window, "document.querySelector('.board-chat-log')?.innerText.includes(" + JSON.stringify(exactAnswer) + ")"), "genuine identical text");
    pass("Concurrent real user message was steered once and answered; identical former-noise text survives restored history.");
    await request(window, "Дождись вопроса исполнителя");
    await waitFor(() => current.waiting, "task_wait");
    const first = data(["message", draft.id], { kind: "question", text: "Выбрать выпуск A или B?" });
    const second = data(["message", draft.id], { kind: "question", text: "Когда выпускать результат?" });
    await waitFor(() => !current.waiting, "question delivered through task_wait");
    const rest = await evaluate(window, "window.taskboard.bootstrap()");
    assert.equal(rest.board.settings.reviewMode, "reviewer-human");
    // The first wait may settle before the second filesystem notification.
    const pending = data(["manager-inbox"]);
    const questionSequences = new Set([...current.inbox, ...pending].filter(item => item.kind === "question").map(item => item.sequence));
    assert.ok(questionSequences.has(first.sequence) && questionSequences.has(second.sequence));
    await finish(window);
    pass("task_wait received a substantial question through the normal inbox; both consecutive questions remain available.");
    await evaluate(window, "document.querySelector('#board-draft').closeChat()");
    await markRead(window);
    await delay(300);
    const nodeVersion = execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
    report.unshift(`Windows ${process.arch}; Node ${nodeVersion}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}.`,
      "Production main, preload, renderer, CLI, watcher and local history; deterministic provider callback, no network model calls.",
      "Chromium sandbox and context isolation remain enabled. Windows runtime verified; Linux/macOS use the same platform-neutral delivery code but were not run.",
      "Command: node scripts/check-manager-automation.mjs --artifacts .tasks/qa/T-0226",
      "Tested sources (SHA-256, UTF-8 with CRLF normalized to LF, matching Git blobs):");
    const paths = ["src/desktop/automation-delivery.ts", "src/desktop/board-actions.ts", "src/desktop/main.ts", "scripts/check-manager-automation.mjs"];
    report.splice(5, 0, ...paths.map(path => path + " " + createHash("sha256")
      .update(readFileSync(new URL("../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n")).digest("hex")));
    writeFileSync(join(artifacts, "manager-automation-dialog-check.txt"), report.join("\n") + "\n");
    releaseRuntime();
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed()) {
        report.push(await evaluate(window, "document.querySelector('#board-draft')?.innerText"));
        report.push(JSON.stringify(await history(window)));
        writeFileSync(join(artifacts, "manager-automation-dialog-failure.png"), (await window.webContents.capturePage()).toPNG());
      }
    } catch (diagnosticError) {
      report.push("Diagnostic capture failed: " + diagnosticError.message);
    }
    writeFileSync(join(artifacts, "manager-automation-dialog-failure.txt"), report.join("\n") + "\n" + error.stack + "\n");
    releaseRuntime?.();
    app.exit(1);
  }
})();
