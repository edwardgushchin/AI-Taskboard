import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "stage-work", 90_000, [["--record"], ["--replay"]]);
const replay = process.argv.includes("--replay");
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const read = name => readFileSync(join(root, "src/desktop", name), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true });
const checks = [];
const captures = [];
const errors = [];
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
void app.whenReady().then(runCheck);

function archiveFixture() {
  const source = new URL("../src/desktop/stage-run-history.ts", import.meta.url).href;
  const script = `
    import { mkdirSync } from "node:fs";
    import { join } from "node:path";
    import { readStageRunHistory, stageRunJournal } from ${JSON.stringify(source)};

    const [project, mode] = process.argv.slice(1);
    const fixtureId = "T-0081";
    if (mode === "record") {
      mkdirSync(join(project, ".tasks"));
      for (const [phase, firstSession, worker] of [
        ["work", 1, "worker"], ["review", 3, "review-worker"],
      ]) {
        for (const attempt of [0, 1]) {
          const session = firstSession + attempt;
          const sessionId = "00000000-0000-4000-8000-00000000000" + session;
          const journal = stageRunJournal(project, fixtureId, phase, sessionId);
          for (let index = 0; index < 132; index++) {
            const id = phase + "-" + (attempt + 1) + "-" + String(index + 1).padStart(3, "0");
            const second = 61 + (session - 1) * 140 + index;
            const at = new Date(Date.UTC(2026, 10, 20, 9, 0, second)).toISOString();
            const command = index % 2 === 1;
            journal.record({
              id, at, type: command ? "commandExecution" : "agentMessage", status: "completed",
              title: command ? "git status --short" : "", text: "Проверка " + id + " завершена.",
              threadId: worker, stageChild: true, stageSessionId: sessionId,
            });
          }
          journal.close();
        }
      }
    }
    console.log(JSON.stringify(readStageRunHistory(project, fixtureId)));
  `;
  const args = ["--input-type=module", "-e", script, scratch, replay ? "replay" : "record"];
  return JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, args, { encoding: "utf8", windowsHide: true }));
}

async function runCheck() {
  const window = new BrowserWindow({
    width: 1375, height: 900, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true },
  });
  const page = window.webContents;
  page.on("console-message", event => {
    if (event.level === "error") errors.push(event.message);
  });
  const evaluate = code => page.executeJavaScript(code + "\n//# sourceURL=check-stage-work-evaluate.js");
  async function verify(code, label) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate(code)) {
        checks.push(label);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(label);
  }
  async function capture(name, width) {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const size = await evaluate("({ width: innerWidth, height: innerHeight, panel: body.clientWidth, dpr: devicePixelRatio })");
    assert.ok(Math.abs(size.panel - width) <= 25, JSON.stringify(size));
    assert.equal(page.getZoomFactor(), 1);
    const image = await page.capturePage();
    assert.equal(image.isEmpty(), false);
    const bytes = image.toPNG();
    assert.ok(bytes.length <= 4 * 1024 ** 2);
    writeFileSync(join(artifacts, name), bytes);
    const png = image.getSize();
    assert.ok(png.width * png.height <= 16_000_000);
    captures.push("\`" + name + "\` — панель " + size.panel + " CSS px, область просмотра " + size.width + " × " +
      size.height + " CSS px, PNG " + png.width + " × " + png.height + ", масштаб 1, DPR " + size.dpr + ".");
  }
  async function click(selector) {
    const point = await evaluate("pointer(" + JSON.stringify(selector) + ")");
    const mouse = { button: "left", clickCount: 1, ...point };
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
  }
  async function enter() {
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  async function checkArchive() {
    const archive = archiveFixture();
    const expected = Object.values(archive).map(items => items.map(item =>
      (item.type === "agentMessage" ? "message:" : "item:") + item.id));
    assert.deepEqual(expected.map(ids => ids.length), [264, 264]);
    await evaluate(`
      var archive = ${JSON.stringify(archive)};
      var archiveIDs = () => [0, 4].map(index => Array.from(
        stageAt(index).querySelectorAll('[data-item^="item:"], [data-item^="message:"]'), node => node.dataset.item));
      var logAt = index => stageAt(index).querySelector(".expert-stage-log");
      var archiveMatches = () => JSON.stringify(archiveIDs()) === ${JSON.stringify(JSON.stringify(expected))};
      window.taskboard.stageRunHistory = async () => ({ ok: true, data: structuredClone(archive) });
      var mainCommand = {
        ...activity(1, "comparable-command", "Проверка рабочего дерева завершена."),
        phase: undefined, type: "commandExecution", title: "git status --short",
      };
      fixture.history = [event(2, "run-log", { runThreadId: "executor", run: [mainCommand] })];
      fixture.expertStageStatus.work[0].state = "done";
      fixture.expertStageStatus.review[0].state = "done";
      for (const [phase, leader, worker] of [
        ["work", "executor", "worker"], ["review", "reviewer", "review-worker"],
      ]) {
        const sessions = Array.from(new Set(archive[phase].map(item => item.stageSessionId)));
        for (const [index, sessionId] of sessions.entries()) {
          const number = Number(sessionId.at(-1));
          const start = 60 + (number - 1) * 140;
          const result = phase === "work" ? "Этап исполнения завершён." : "Этап ревью завершён.";
          fixture.history.push(
            stageEvent(start, phase, "analysis", "running", leader, sessionId, undefined, worker),
            stageEvent(start + 135, phase, "analysis", index ? "done" : "blocked", leader, sessionId,
              index ? result : "Начата повторная попытка.")
          );
        }
      }
      fixture.status = "review";
      fixture.revision += 1;
      reviewers = [];
      frame.runActivity = {};
      reopenFixture();
    `);
    await verify("archiveMatches()", replay
      ? "Новый процесс Electron отобразил по 264 идентификатора исполнения и ревью в исходном порядке."
      : "Из архива прочитаны и по порядку показаны 264 события исполнения и 264 события ревью из двух попыток каждой фазы.");
    const ids = await evaluate("archiveIDs()");
    const manifest = join(scratch, "stage-event-ids.json");
    if (replay) {
      assert.deepEqual(ids, JSON.parse(readFileSync(manifest, "utf8")));
      checks.push("Число, порядок и точные идентификаторы в DOM совпали до и после перезапуска Electron.");
      return;
    }
    writeFileSync(manifest, JSON.stringify(ids));
    await evaluate("reopenFixture()");
    await verify("archiveMatches()", "Повторное открытие карточки сохраняет число и порядок идентификаторов.");
    const backgrounds = new Map();
    for (const [palette, width] of [["dark", 1375], ["dark", 388], ["light", 1375], ["light", 388]]) {
      const wide = width > 1000;
      const stage = wide ? 0 : 4;
      window.setContentSize(width, wide ? 900 : 1670);
      await evaluate(`
        document.documentElement.dataset.palette = ${JSON.stringify(palette)};
        document.querySelector('[aria-controls="task-chat-work"]').click();
        for (let index = 0; index < 5; index++) stageAt(index).open = index === ${stage};
        var logUnderTest = logAt(${stage});
        var mainLog = byId("task-chat-work");
        var stageAction = Array.from(logUnderTest.querySelectorAll(".chat-run-item")).at(-1);
        var mainAction = mainLog.querySelector(".chat-run-item");
        mainAction.closest(".chat-work").open = true;
        stageAction.open = false;
        mainAction.open = false;
        logUnderTest.scrollTop = 0;
        logUnderTest.scrollIntoView({ block: "center" });
        logUnderTest.focus({ preventScroll: true });
        void 0;
      `);
      const label = palette + ", " + width + " px";
      const layout = await evaluate(`({
        background: getComputedStyle(logUnderTest).backgroundColor,
        mainBackground: getComputedStyle(mainLog).backgroundColor,
        border: getComputedStyle(logUnderTest).borderColor,
        mainBorder: getComputedStyle(mainLog).borderColor,
        color: getComputedStyle(stageAction).color,
        mainColor: getComputedStyle(mainAction).color,
        focused: document.activeElement === logUnderTest,
        closed: !stageAction.open && !mainAction.open,
        logHeight: logUnderTest.clientHeight,
        scrollHeight: logUnderTest.scrollHeight,
        logWidth: logUnderTest.clientWidth,
        scrollWidth: logUnderTest.scrollWidth,
        bodyWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
      })`);
      assert.equal(layout.background, layout.mainBackground, label + " — фон");
      assert.equal(layout.border, layout.mainBorder, label + " — рамка");
      assert.equal(layout.color, layout.mainColor, label + " — цвет действия");
      assert.ok(layout.closed && layout.focused, label + " — раскрытие и фокус: " + JSON.stringify(layout));
      assert.ok(layout.scrollHeight > layout.logHeight * 2, label + " — высота ленты");
      assert.equal(layout.scrollWidth, layout.logWidth, label + " — ширина ленты");
      assert.equal(layout.bodyScrollWidth, layout.bodyWidth, label + " — ширина панели");
      checks.push(label + " — фон, рамка и цвет действия совпадают. Журнал этапа прокручивается отдельно, без горизонтальной прокрутки.");
      backgrounds.set(palette, await evaluate("getComputedStyle(logUnderTest).backgroundColor"));
      const end = { key: "End", code: "End", windowsVirtualKeyCode: 35 };
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...end });
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...end });
      await verify(`logUnderTest.scrollTop > 0 &&
        logUnderTest.scrollHeight - logUnderTest.scrollTop - logUnderTest.clientHeight <= 2`,
        label + " — End прокручивает журнал до результата второй попытки.");
      await evaluate(`stageAction.open = true; mainAction.open = true;
        logUnderTest.scrollTop = logUnderTest.scrollHeight;
        logUnderTest.scrollIntoView({ block: "center" });
        void 0`);
      await verify(`
        stageAction.open && mainAction.open &&
        stageAction.getBoundingClientRect().bottom <= logUnderTest.getBoundingClientRect().bottom &&
        stageAction.getBoundingClientRect().top >= logUnderTest.getBoundingClientRect().top &&
        logUnderTest.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom &&
        stageAt(${stage}).querySelector("h5").getBoundingClientRect().top >= body.getBoundingClientRect().top &&
        stageAction.textContent.includes("Проверка " + (${wide} ? "work" : "review") + "-2-132 завершена.")
      `, label + " — раскрытый вывод последней команды полностью виден.");
      if (wide && palette === "dark") await capture("stage-work-dark.png", 680);
      if (!wide && palette === "light") await capture("stage-work-light-narrow.png", 360);
    }
    assert.notEqual(backgrounds.get("dark"), backgrounds.get("light"));
  }
  async function initialize() {
    const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const font = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
    await page.insertCSS(read("themes.css") + read("styles.css") +
      read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + font));
    page.setZoomFactor(1);
    page.debugger.attach();
    await evaluate(`
      var project = "Stage work fixture";
      var reviewers = [];
      var at = second => new Date(Date.UTC(2026, 10, 20, 9, 0, second)).toISOString();
      var event = (second, action, fields = {}) => ({ at: at(second), action, actor: "agent", ...fields });
      var stageEvent = (second, phase, key, state, threadId, sessionId, result, agentId) => event(second, "expert-stage", {
        actor: phase === "work" ? "agent" : "reviewer",
        expertStageRun: { phase, key, state, threadId, sessionId, result, agentId },
      });
      var activity = (second, id, text, threadId = "executor", stageSessionId = "run-1") => ({
        at: at(second), id, text, threadId, stageSessionId,
        type: "agentMessage", status: "completed", title: "", phase: "commentary",
      });
      var childActivity = (second, id, text, child = "worker", session = "run-1") => ({
        ...activity(second, id, text, child, session), stageChild: true,
      });
      var coordination = (second, id, title, leader, session, child) => ({
        ...activity(second, id, JSON.stringify({ tool: "sendInput", receiverThreadIds: [child] }), leader, session),
        phase: undefined, type: "collabAgentToolCall", title,
      });
      var stageConfig = (key, title, dependsOn = []) => ({
        key, title, dependsOn, expertId: "frontend-developer",
        description: "STATIC_DESCRIPTION", inputs: ["STATIC_INPUT"],
        outputs: ["STATIC_OUTPUT"], criteria: ["STATIC_CRITERION"],
      });
      var workStages = [
        stageConfig("analysis", "Изучить источники"),
        stageConfig("implementation", "Сопоставить события", ["analysis"]),
        stageConfig("fallback", "Сверить итог", ["implementation"]),
        stageConfig("overlap", "Параллельная работа"),
      ];
      var fixture = {
        id: "T-0081", title: "Журнал этапов команды", revision: 1, status: "in_progress",
        codexThreadId: "executor", tags: [], description: "", criteria: [], subtasks: [], questions: [],
        attachments: [], history: [],
        expertTeam: {
          work: { lead: "frontend-developer", stages: workStages },
          review: { lead: "frontend-developer", stages: [stageConfig("analysis", "Проверить сдачу")] },
        },
        expertStageStatus: {
          work: workStages.map((step, index) => ({ key: step.key, state: index ? "waiting" : "ready" })),
          review: [{ key: "analysis", state: "ready" }],
        },
      };
      window.taskboard = {
        subscribe() {}, onChatUpdate() {}, onTheme() {},
        bootstrap: () => new Promise(() => {}),
        chatModels: async () => ({ ok: true, data: [] }),
        reviewerChat: async () => ({ ok: true, data: structuredClone(reviewers) }),
        command: async action => ({
          ok: true,
          data: action === "show" ? structuredClone(fixture) : [{ id: "frontend-developer", name: "Фронтенд-разработчик" }],
        }),
      };
      ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
      ${read("image-preview.js")}
      ${read("keyboard-focus.js")}
      ${read("source-files.cjs")}
      ${read("markdown.js")}
      ${read("chat.js")}
      ${read("review-diff.js")}
      ${localizationFixture()}
      ${read("renderer.js")}
      frame = {
        project, runningTasks: [fixture.id], runActivity: {},
        board: {
          project, tasks: [fixture], archived: [], tags: [],
          settings: { boardType: "agent", integrationMode: "merge", reviewMode: "reviewer" },
        },
      };
      var stageAt = index => body.querySelectorAll(".expert-stage")[index];
      var stageText = index => stageAt(index).querySelector(".expert-stage-work").innerText;
      var visible = element => Boolean(element?.checkVisibility());
      var ordered = (text, parts) => parts.every((part, index) => {
        const position = text.indexOf(part);
        return position >= 0 && (index === 0 || position > text.indexOf(parts[index - 1]));
      });
      var pointer = selector => {
        const element = document.querySelector(selector);
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      };
      var update = (type, items) => updateChat({ project, id: fixture.id, type, items, runThreadId: "executor" });
      var openFixture = () => showTask(fixture.id);
      var reopenFixture = async () => {
        sheet.close();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await openFixture();
      };
      openFixture();
    `);
  }

  async function checkExistingBehavior() {
    await click(".expert-stage-row");
    await verify(`stageAt(0).open && visible(stageAt(0).querySelector("h5")) &&
      stageText(0).includes("Ход работы") && stageText(0).includes("пока нет записей")`,
      "Щелчок раскрывает пустой журнал под строкой этапа.");
    await evaluate('stageAt(0).querySelector("summary").focus(); void 0');
    await enter();
    await verify("!stageAt(0).open", "Enter закрывает этап.");
    await enter();
    await verify(`stageAt(0).open && !stageAt(0).textContent.includes("STATIC_") &&
      taskInSheet.expertTeam.work.stages[0].criteria.includes("STATIC_CRITERION") &&
      taskInSheet.expertTeam.work.stages[0].outputs.includes("STATIC_OUTPUT") &&
      taskInSheet.expertTeam.work.stages[1].dependsOn.includes("analysis") &&
      taskInSheet.expertTeam.work.stages[0].inputs.includes("STATIC_INPUT")`,
      "Enter раскрывает этап. Поля плана остались в данных карточки, карточка их под строкой не показывает.");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

    await evaluate(`
      var outside = activity(1, "outside", "ПОДГОТОВКА СЕАНСА");
      var early = childActivity(3, "early", "Открыт журнал исполнения.");
      var command = { ...childActivity(4, "command", "Проверка дерева завершена."),
        phase: undefined, type: "commandExecution", title: "git status --short" };
      var foreign = activity(4, "foreign", "ЧУЖОЙ ПОТОК", "foreign");
      var foreignChild = childActivity(5, "foreign-child", "ЧУЖОЙ СПЕЦИАЛИСТ", "unassigned-worker");
      var later = childActivity(5, "later", "События сопоставлены с первой попыткой.");
      var workHandoff = coordination(6, "work-handoff", "Передача исполнителю", "executor", "run-1", "worker");
      var wrongHandoff = coordination(6, "wrong-handoff", "ЧУЖАЯ ПЕРЕДАЧА", "executor", "run-1", "unassigned-worker");
      var unscoped = activity(5, "unscoped", "СОБЫТИЕ БЕЗ СВЯЗИ", null, null);
      var overlap = childActivity(7, "overlap", "НЕОДНОЗНАЧНОЕ СОБЫТИЕ");
      var sameRole = childActivity(13, "same-role", "Запись другого этапа той же роли.");
      var retry = childActivity(23, "retry", "Данные подтверждены после повторного запуска.");
      var wrongSession = childActivity(23, "wrong-session", "СОБЫТИЕ СТАРОЙ ПОПЫТКИ", "worker", "stale-run");
      fixture.history.push(stageEvent(2, "work", "analysis", "running", "executor", "run-1"));
      fixture.expertStageStatus.work[0].state = "running";
      openFixture();
    `);
    await evaluate("update('run', [outside, early, command, foreign]); void 0");
    await verify(`stageAt(0).open && !stageText(0).includes("Открыт журнал исполнения.")`,
      "До подтверждения дочернего потока его действия не видны в журнале этапа.");
    await evaluate(`
      fixture.history.push(stageEvent(4, "work", "analysis", "running", "executor", "run-1", undefined, "worker"));
      openFixture();
    `);
    await verify(`stageAt(0).open && stageText(0).includes("Открыт журнал исполнения.") &&
      !stageText(0).includes("События сопоставлены") &&
      stageAt(0).querySelectorAll(".expert-stage-log > .chat-event").length === 1`,
      "Подтверждение дочернего потока не создаёт новую попытку. Его первое действие появляется до завершения этапа.");
    await click(".expert-stage[open] .chat-run-item > summary");
    await evaluate("update('run', [outside, early, command, foreign, later, foreignChild, unscoped, workHandoff, wrongHandoff]); void 0");
    await verify(`ordered(stageText(0), ["Открыт журнал исполнения.", "git status --short",
      "Проверка дерева завершена.", "События сопоставлены с первой попыткой.", "Передача исполнителю"]) &&
      !/ЧУЖОЙ|ЧУЖАЯ|ПОДГОТОВКА СЕАНСА|СОБЫТИЕ БЕЗ СВЯЗИ/.test(stageText(0)) &&
      stageAt(0).querySelector(".chat-run-item").open`,
      "Позднее пояснение специалиста и координация ведущего видны до завершения этапа. Порядок и раскрытие команды сохраняются.");

    await evaluate(`
      var lateCommand = {
        ...childActivity(8, "late-command", ""), phase: undefined,
        type: "commandExecution", title: "git rev-parse HEAD", status: "inProgress",
      };
      update("run", [outside, early, command, later, workHandoff, lateCommand]);
      var sawStartedCommand = Boolean(stageAt(0).querySelector('[data-item="item:late-command"]'));
      fixture.history.push(
        stageEvent(6, "work", "overlap", "running", "executor", "run-1", undefined, "worker"),
        stageEvent(8, "work", "overlap", "done", "executor", "run-1", "Итог параллельного этапа."),
        stageEvent(9, "work", "analysis", "blocked", "executor", "run-1", "Первая попытка отложена."),
        stageEvent(12, "work", "implementation", "running", "executor", "run-1", undefined, "worker"),
        stageEvent(14, "work", "implementation", "done", "executor", "run-1", "Итог другого этапа."),
        stageEvent(15, "work", "fallback", "running", "executor", "run-1"),
        stageEvent(16, "work", "fallback", "done", "executor", "run-1", "Доступен только записанный результат."),
        event(17, "run-log", {
          runThreadId: "executor", run: [outside, early, command, later, unscoped, workHandoff, overlap, sameRole],
        }),
        event(18, "run-log", { runThreadId: "foreign", run: [foreign] }),
        stageEvent(21, "work", "analysis", "running", "executor", "run-1"),
        stageEvent(22, "work", "analysis", "running", "executor", "run-1", undefined, "worker")
      );
      fixture.expertStageStatus.work.forEach((state, index) => state.state = index ? "done" : "running");
      openFixture();
    `);
    await evaluate("update('run', [early, later, wrongSession, retry]); void 0");
    await verify(`ordered(stageText(0), ["Открыт журнал исполнения.", "Первая попытка отложена.",
      "Данные подтверждены после повторного запуска."]) &&
      stageAt(0).querySelectorAll('[data-item="message:early"]').length === 1 &&
      stageAt(0).querySelectorAll('[data-item="message:later"]').length === 1 &&
      !/НЕОДНОЗНАЧНОЕ|СТАРОЙ ПОПЫТКИ|Запись другого этапа/.test(stageText(0))`,
      "Сохранённые и текущие события не дублируются. Повторная попытка того же потока обособлена.");
    await evaluate(`
      var lateCompletion = { ...lateCommand, text: "Проверка первой попытки завершилась позднее.", status: "completed" };
      update("run", [early, later, wrongSession, retry, lateCompletion]);
      void 0;
    `);
    await verify(`
      sawStartedCommand &&
      stageAt(0).querySelectorAll('[data-item="item:late-command"]').length === 1 &&
      ordered(stageAt(0).textContent, ["Проверка первой попытки завершилась позднее.",
        "Первая попытка отложена.", "Данные подтверждены после повторного запуска."])`,
      "Поздний вывод известной команды остался в первой попытке по времени начала. Обе попытки используют тот же поток и сеанс.");
    await evaluate(`for (let index = 1; index < 4; index++) stageAt(index).open = true; void 0`);
    await verify(`stageText(1).includes("Запись другого этапа той же роли.") &&
      !stageText(1).includes("Открыт журнал исполнения.") &&
      stageText(2).includes("Доступен только записанный результат.") &&
      !stageAt(2).querySelector(".chat-run:not([hidden])") && !stageText(3).includes("НЕОДНОЗНАЧНОЕ")`,
      "Второй этап той же роли получает свои записи. Неоднозначное событие исключено. Итог без подробностей виден.");

    await evaluate(`
      fixture.history.push(
        stageEvent(24, "work", "analysis", "done", "executor", "run-1", "Этап исполнения завершён."),
        event(25, "run-log", { runThreadId: "executor", run: [wrongSession, retry, lateCompletion] }),
        event(29, "submit", { to: "review" }),
        stageEvent(31, "review", "analysis", "running", "reviewer", "review-1"),
        stageEvent(32, "review", "analysis", "running", "reviewer", "review-1", undefined, "review-worker")
      );
      fixture.expertStageStatus.work[0].state = "done";
      fixture.expertStageStatus.review[0].state = "running";
      fixture.status = "review";
      reviewers = [{ id: "review-attempt", at: at(30), items: [] }];
      update("run", []);
      openFixture();
    `);
    await evaluate(`
      stageAt(4).open = true;
      document.querySelector('[aria-controls="task-chat-dialogue"]').click();
      var reviewLead = activity(30, "review-lead", "Ведущий открыл материалы ревью.", "reviewer", "review-1");
      var reviewHandoff = coordination(33, "review-handoff", "Передача ревьюеру", "reviewer", "review-1", "review-worker");
      var reviewCommand = {
        ...childActivity(34, "review-command", "Дифф проверен.", "review-worker", "review-1"),
        phase: undefined, type: "commandExecution", title: "git diff --check",
      };
      var reviewed = childActivity(35, "reviewed", "Проверен журнал этапа исполнения.", "review-worker", "review-1");
      var foreignReview = childActivity(35, "foreign-review", "ЧУЖОЙ РЕВЬЮЕР", "unassigned-worker", "review-1");
      reviewers[0].items.push(reviewLead, reviewHandoff, reviewCommand, reviewed, foreignReview);
      update("reviewer-chat");
      void 0;
    `);
    await verify(`ordered(stageAt(4).textContent, ["Передача ревьюеру", "git diff --check", "Проверен журнал этапа исполнения."]) &&
      stageText(4).includes("Проверен журнал этапа исполнения.") &&
      !stageText(0).includes("Проверен журнал этапа исполнения.") &&
      !/ЧУЖОЙ РЕВЬЮЕР|Открыт журнал исполнения/.test(stageText(4)) && visible(byId("task-chat-dialogue")) &&
      stageAt(4).querySelectorAll(".expert-stage-log > .chat-event").length === 1`,
      "В открытом этапе ревью видны координация, команда и пояснение дочернего потока до завершения. Диалог остаётся открытым.");
    await evaluate(`
      fixture.history.push(stageEvent(36, "review", "analysis", "done", "reviewer", "review-1", "Ревью этапа завершено."));
      fixture.expertStageStatus.review[0].state = "done";
      reviewers[0].durationMs = 5500;
      reopenFixture();
    `);
    await verify(`stageAt(4).open && ordered(stageAt(4).textContent, ["Передача ревьюеру", "git diff --check",
      "Проверен журнал этапа исполнения.", "Ревью этапа завершено."])`,
      "После повторного открытия карточки восстановлены координация, действия специалиста и итог ревью.");
    await evaluate('byId("task-review-history").open = true; void 0');
    await verify(`visible(byId("task-review-history").querySelector(".task-review-attempt")) &&
      byId("task-review-history").textContent.includes("Ведущий открыл материалы ревью.") &&
      !/ЧУЖОЙ РЕВЬЮЕР|Проверен журнал этапа исполнения|git diff --check/.test(byId("task-review-history").textContent)`,
      "Полный журнал ревью показывает ведущего. Команда и пояснение дочернего потока остаются в журнале этапа.");
    await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click(); void 0`);
    await verify(`visible(byId("task-chat-work")) && byId("task-chat-work").textContent.includes("ПОДГОТОВКА СЕАНСА") &&
      !/ЧУЖОЙ ПОТОК|Проверен журнал этапа исполнения|Открыт журнал исполнения|git status --short|Данные подтверждены/.test(byId("task-chat-work").textContent)`,
      "Правая вкладка показывает открытый сеанс ведущего. Записи ревью, дочернего потока и другого сеанса исключены.");
    await evaluate(`
      var rightSnapshot = byId("task-chat-work").textContent;
      stageAt(0).querySelector("summary").click();
      stageAt(0).querySelector("summary").click();
      void 0;
    `);
    await verify(`byId("task-chat-work").textContent === rightSnapshot`, "Раскрытие этапа не меняет правый журнал.");
    window.setContentSize(388, 1670);
    await evaluate(`
      for (let index = 1; index < 5; index++) stageAt(index).open = false;
      stageAt(0).querySelector("summary").focus();
      void 0;
    `);
    await enter();
    await verify("!stageAt(0).open", "В узкой панели Enter закрывает этап.");
    await enter();
    await verify(`stageAt(0).open && visible(stageAt(0).querySelector("h5")) &&
      ordered(stageText(0), ["Открыт журнал исполнения.", "Первая попытка отложена.",
        "Данные подтверждены после повторного запуска.", "Этап исполнения завершён."]) &&
      stageAt(0).querySelectorAll('[data-item="item:late-command"]').length === 1 &&
      ordered(stageAt(0).textContent, ["Проверка первой попытки завершилась позднее.", "Первая попытка отложена."]) &&
      body.scrollWidth === body.clientWidth`,
      "В узкой панели Enter раскрывает этап без горизонтальной прокрутки. Поздний вывод восстановлен в первой попытке, итог во второй.");
  }

  try {
    await initialize();
    if (!replay) await checkExistingBehavior();
    await checkArchive();
    assert.deepEqual(errors, []);
    if (!replay) {
      writeFileSync(join(scratch, "first-checks.json"), JSON.stringify({ checks, captures }));
      return;
    }

    const first = JSON.parse(readFileSync(join(scratch, "first-checks.json"), "utf8"));
    checks.unshift(...first.checks);
    captures.unshift(...first.captures);

    const head = git("rev-parse", "HEAD").toString().trim();
    const sources = [
      "src/cli/expert-team.ts", "src/cli/model.ts", "src/cli/tasks.ts", "src/desktop/chat.js",
      "src/desktop/codex-chat.ts", "src/desktop/codex-run.ts", "src/desktop/expert-tools.ts",
      "src/desktop/locales/en.json", "src/desktop/locales/ru.json", "src/desktop/renderer.js",
      "src/desktop/reviewer-chat.ts", "src/desktop/run-activity.ts", "src/desktop/styles.css",
      "src/desktop/stage-run-history.ts", "src/desktop/themes.css", "src/desktop/index.html",
      "src/desktop/preload.cjs", "src/desktop/main.ts", "scripts/check-stage-work.mjs", "scripts/electron-check.mjs",
    ];
    const hashes = sources.map(path => {
      const bytes = readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
      return path + " — " + createHash("sha256").update(bytes).digest("hex");
    });
    const fence = String.fromCharCode(96).repeat(3);
    const report = [
      "# Проверка журнала этапов в Windows Electron", "",
      "Проверок пройдено — " + checks.length + ". Ошибок в консоли renderer нет.", "",
      "Windows " + process.getSystemVersion() + ", Electron " + process.versions.electron +
        ", Chromium " + process.versions.chrome + ", Node " + process.versions.node + " (Electron).", "",
      fence + "powershell", "node scripts/check-stage-work.mjs --artifacts .tasks/qa/retry", fence, "",
      "Рабочий интерфейс запущен в изолированных окнах двух отдельных процессов Electron. " +
        "Граница IPC заменена тестовым адаптером. Первый процесс создаёт архив через штатное хранилище, " +
        "второй читает те же файлы из временной доски. Сохранённые идентификаторы сверены с DOM при обоих запусках. " +
        "Провайдер заменён тестовыми записями. Чтение пяти страниц и поздний вывод покрывает тест в tests/experts.test.ts.", "",
      "## Результаты", "", ...checks.map(check => "- " + check), "",
      "## Снимки", "", ...captures.map(capture => "- " + capture), "",
      "## Проверенные исходники", "", "HEAD рабочей копии " + head + ". SHA-256 байтов UTF-8 с LF.", "",
      ...hashes.map(hash => "- " + hash), "",
    ].join("\n");
    writeFileSync(join(artifacts, "stage-journal-check.md"), report);
    console.log("Stage work checks:", checks.length);
  } catch (error) {
    console.error(error);
    if (errors.length) console.error(errors);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
