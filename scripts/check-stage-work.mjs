import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "stage-work", 90_000);
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
    writeFileSync(join(artifacts, name), image.toPNG());
    const png = image.getSize();
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
  try {
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
      var stageEvent = (second, phase, key, state, threadId, sessionId, result) => event(second, "expert-stage", {
        actor: phase === "work" ? "agent" : "reviewer",
        expertStageRun: { phase, key, state, threadId, sessionId, result },
      });
      var activity = (second, id, text, threadId = "executor", stageSessionId = "run-1") => ({
        at: at(second), id, text, threadId, stageSessionId,
        type: "agentMessage", status: "completed", title: "", phase: "commentary",
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
    await capture("stage-empty.png", 680);

    await evaluate(`
      var outside = activity(1, "outside", "ПОДГОТОВКА СЕАНСА");
      var early = activity(3, "early", "Открыт журнал исполнения.");
      var command = { ...activity(4, "command", "Проверка дерева завершена."),
        phase: undefined, type: "commandExecution", title: "git status --short" };
      var foreign = activity(4, "foreign", "ЧУЖОЙ ПОТОК", "foreign");
      var later = activity(5, "later", "События сопоставлены с первой попыткой.");
      var unscoped = activity(5, "unscoped", "СОБЫТИЕ БЕЗ СВЯЗИ", null, null);
      var overlap = activity(7, "overlap", "НЕОДНОЗНАЧНОЕ СОБЫТИЕ");
      var sameRole = activity(13, "same-role", "Запись другого этапа той же роли.");
      var retry = activity(23, "retry", "Данные подтверждены после повторного запуска.", "executor", "run-2");
      var wrongSession = activity(23, "wrong-session", "СОБЫТИЕ СТАРОЙ ПОПЫТКИ");
      fixture.history.push(stageEvent(2, "work", "analysis", "running", "executor", "run-1"));
      fixture.expertStageStatus.work[0].state = "running";
      openFixture();
    `);
    await evaluate("update('run', [outside, early, command, foreign]); void 0");
    await verify(`stageAt(0).open && stageText(0).includes("Открыт журнал исполнения.") &&
      !stageText(0).includes("События сопоставлены")`, "Первое событие исполнения появляется в раскрытом этапе.");
    await click(".expert-stage[open] .chat-run-item > summary");
    await evaluate("update('run', [outside, early, command, foreign, later, unscoped]); void 0");
    await verify(`ordered(stageText(0), ["Открыт журнал исполнения.", "git status --short",
      "Проверка дерева завершена.", "События сопоставлены с первой попыткой."]) &&
      !/ЧУЖОЙ ПОТОК|ПОДГОТОВКА СЕАНСА|СОБЫТИЕ БЕЗ СВЯЗИ/.test(stageText(0)) &&
      stageAt(0).querySelector(".chat-run-item").open`,
      "Позднее событие обновляет открытый этап. Порядок, раскрытая команда и её вывод сохраняются.");
    await capture("stage-live.png", 680);

    await evaluate(`
      fixture.history.push(
        stageEvent(6, "work", "overlap", "running", "executor", "run-1"),
        stageEvent(8, "work", "overlap", "done", "executor", "run-1", "Итог параллельного этапа."),
        stageEvent(9, "work", "analysis", "blocked", "executor", "run-1", "Первая попытка отложена."),
        stageEvent(12, "work", "implementation", "running", "executor", "run-1"),
        stageEvent(14, "work", "implementation", "done", "executor", "run-1", "Итог другого этапа."),
        stageEvent(15, "work", "fallback", "running", "executor", "run-1"),
        stageEvent(16, "work", "fallback", "done", "executor", "run-1", "Доступен только записанный результат."),
        event(17, "run-log", { runThreadId: "executor", run: [outside, early, command, later, unscoped, overlap, sameRole] }),
        event(18, "run-log", { runThreadId: "foreign", run: [foreign] }),
        stageEvent(22, "work", "analysis", "running", "executor", "run-2")
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
    await evaluate(`for (let index = 1; index < 4; index++) stageAt(index).open = true; void 0`);
    await verify(`stageText(1).includes("Запись другого этапа той же роли.") &&
      !stageText(1).includes("Открыт журнал исполнения.") &&
      stageText(2).includes("Доступен только записанный результат.") &&
      !stageAt(2).querySelector(".chat-run:not([hidden])") && !stageText(3).includes("НЕОДНОЗНАЧНОЕ")`,
      "Второй этап той же роли получает свои записи. Неоднозначное событие исключено. Итог без подробностей виден.");

    await evaluate(`
      fixture.history.push(
        stageEvent(24, "work", "analysis", "done", "executor", "run-2", "Этап исполнения завершён."),
        event(25, "run-log", { runThreadId: "executor", run: [wrongSession, retry] }),
        event(29, "submit", { to: "review" }),
        stageEvent(32, "review", "analysis", "running", "reviewer", "review-1")
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
      reviewers[0].items.push(activity(33, "reviewed", "Проверен журнал этапа исполнения.", "reviewer", "review-1"));
      update("reviewer-chat");
      void 0;
    `);
    await verify(`stageText(4).includes("Проверен журнал этапа исполнения.") &&
      !stageText(0).includes("Проверен журнал этапа исполнения.") &&
      !stageText(4).includes("Открыт журнал исполнения.") && visible(byId("task-chat-dialogue"))`,
      "Живое ревью обновляет этап при открытом диалоге справа. Совпадающий ключ фазы исполнения не получает запись.");
    await evaluate(`
      fixture.history.push(stageEvent(35, "review", "analysis", "done", "reviewer", "review-1", "Ревью этапа завершено."));
      fixture.expertStageStatus.review[0].state = "done";
      reviewers[0].durationMs = 5500;
      reopenFixture();
    `);
    await verify(`stageAt(4).open && ordered(stageText(4), ["Проверен журнал этапа исполнения.", "Ревью этапа завершено."])`,
      "После повторного открытия карточки сохранённый журнал ревью восстановлен вместе с итогом.");
    await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click(); void 0`);
    await verify(`visible(byId("task-chat-work")) && byId("task-chat-work").textContent.includes("ПОДГОТОВКА СЕАНСА") &&
      !/ЧУЖОЙ ПОТОК|Проверен журнал этапа исполнения/.test(byId("task-chat-work").textContent)`,
      "Правая вкладка показывает подготовку открытого сеанса исполнителя. Записи ревью и другого сеанса исключены.");
    await evaluate(`
      var rightSnapshot = byId("task-chat-work").textContent;
      stageAt(0).querySelector("summary").click();
      stageAt(0).querySelector("summary").click();
      void 0;
    `);
    await verify(`byId("task-chat-work").textContent === rightSnapshot`, "Раскрытие этапа не меняет правый журнал.");
    window.setContentSize(388, 1550);
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
      body.scrollWidth === body.clientWidth`,
      "В узкой панели Enter раскрывает этап. Сохранённые события и итог видны без горизонтальной прокрутки.");
    await evaluate(`stageAt(0).scrollIntoView({ block: "start" }); void 0`);
    await capture("stage-restored-narrow.png", 360);
    assert.deepEqual(errors, []);

    const head = git("rev-parse", "HEAD").toString().trim();
    const sources = [
      "src/cli/expert-team.ts", "src/cli/model.ts", "src/cli/tasks.ts", "src/desktop/chat.js",
      "src/desktop/codex-chat.ts", "src/desktop/codex-run.ts", "src/desktop/expert-tools.ts",
      "src/desktop/locales/en.json", "src/desktop/locales/ru.json", "src/desktop/renderer.js",
      "src/desktop/run-activity.ts", "src/desktop/styles.css",
    ];
    const hashes = sources.map(path => {
      const current = git("hash-object", "--path=" + path, path).toString().trim();
      const committed = git("rev-parse", head + ":" + path).toString().trim();
      const bytes = current === committed ? git("cat-file", "blob", committed) :
        Buffer.from(readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n"));
      const representation = current === committed ? "Git blob" : "рабочая копия UTF-8 LF";
      return path + " — " + createHash("sha256").update(bytes).digest("hex") + " (" + representation + ")";
    });
    const fence = String.fromCharCode(96).repeat(3);
    const report = [
      "# Проверка журнала этапов в Windows Electron", "",
      "Результат — " + checks.length + " проверок пройдены. Ошибок в консоли renderer нет.", "",
      "Windows " + process.getSystemVersion() + ", Electron " + process.versions.electron +
        ", Chromium " + process.versions.chrome + ", Node " + process.versions.node + " (Electron).", "",
      fence + "powershell", "node scripts/check-stage-work.mjs --artifacts .tasks/qa", fence, "",
      "Production renderer запущен с тестовыми данными IPC в изолированном окне. Повторное открытие " +
        "проверено через showTask. Реальный провайдер и запись его журнала здесь не вызываются.", "",
      "## Результаты", "", ...checks.map(check => "- " + check), "",
      "## Снимки", "", ...captures.map(capture => "- " + capture), "",
      "## Проверенные исходники", "", "HEAD рабочей копии " + head + ". SHA-256:", "",
      ...hashes.map(hash => "- " + hash), "",
    ].join("\n");
    writeFileSync(join(artifacts, "stage-work-check.md"), report);
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
