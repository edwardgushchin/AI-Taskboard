// Run with Node.js. The two phases use separate Electron processes and one disposable board.
import { confirmFixtureDraft } from "../tests/fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "task-work", 90_000, [[], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, nativeTheme } = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const restart = process.argv.includes("--restart");
const taskId = "T-0001";
const oldThread = "00000000-0000-4000-8000-000000000001";
const thread = "00000000-0000-4000-8000-000000000002";
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
const checksPath = join(scratch, "checks.json");
const checks = restart ? JSON.parse(readFileSync(checksPath, "utf8")) : [];
const record = label => {
  checks.push(label);
  console.log("PASS " + label);
};

function cli(args, input) {
  const inputPath = join(scratch, "input.json");
  if (input !== undefined) writeFileSync(inputPath, JSON.stringify(input));
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src", "cli", "main.ts"),
    "--project", project, "--json", ...args,
    ...(input === undefined ? [] : ["--input-file", inputPath]),
  ], { cwd: scratch, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout).data;
}

function activity(id, type, title, text, seconds) {
  return { id, type, title, text, status: "completed", at: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString() };
}

const command = activity("command", "commandExecution", "git status --short", "M  src/desktop/chat.js", 1);
const tool = activity("tool", "mcpToolCall", "docs / lookup", "Documentation found", 2);
const note = activity("note", "agentMessage", "", "Проверка завершена, результат сохранён.", 3);
const finalReply = { ...activity("answer", "agentMessage", "", "Журнал проверен.", 4), phase: "final_answer" };
const foreign = activity("previous", "commandExecution", "PREVIOUS SESSION", "PREVIOUS SESSION OUTPUT", 1);
const discussionCommand = activity("standalone-command", "commandExecution", "STANDALONE COMMAND", "STANDALONE OUTPUT", 5);
const discussionAnswer = {
  ...activity("standalone-answer", "agentMessage", "", "Ответ отдельного чата.", 6),
  phase: "final_answer",
};
const discussion = [tool, discussionCommand, discussionAnswer];
const mixed = [
  command,
  activity("mail", "mcpToolCall", "ai_taskboard / team_message", "TEAM TOOL PRIVATE", 1),
  activity("stage", "mcpToolCall", "ai_taskboard / expert_stage", "EXPERT STAGE PRIVATE", 1),
  activity("child", "subAgentActivity", "", "CHILD PRIVATE", 2),
  activity("spawn", "collabAgentToolCall", "spawnAgent", "SPAWN PRIVATE", 2),
  tool, note, finalReply,
];
const questionText = "OWNER QUESTION: Confirm the fixture scope?";
const addressText = "MANAGER TO STAGE: scope confirmed";
const current = () => cli(["show", taskId]);

if (!restart) {
  mkdirSync(project);
  cli(["init"], { git: false });
  cli(["settings"], { autoMode: false, reviewMode: "reviewer" });
  const stage = (key, dependsOn = []) => ({
    key, expertId: "qa-engineer", title: key, criteria: ["Check the fixture."],
    inputs: ["Scope"], outputs: ["Evidence"], dependsOn,
  });
  const lead = { lead: "qa-engineer", reason: "Check the fixture.", stages: [] };
  const draft = cli(["create"], {
    title: "Проверка журнала Codex", description: "Журнал сменённого сеанса и адресные сообщения команды.",
    criteria: ["Показать события текущего сеанса."], workingDirectory: project,
    expertTeam: { work: { ...lead, stages: [stage("analysis"), stage("verify", ["analysis"])] }, review: lead },
  });
  confirmFixtureDraft(project, taskId);
  const ready = cli(["approve", taskId], { revision: draft.revision });
  cli(["start", taskId], { revision: ready.revision });
  cli(["update", taskId], { actor: "agent", codexThreadId: oldThread });
  cli(["run-log", taskId], { entries: [foreign], durationMs: 1_000 });
  cli(["update", taskId], { actor: "user", codexThreadId: thread, previousCodexThreadId: oldThread });
  cli(["run-log", taskId], { entries: [foreign], durationMs: 1_000, runThreadId: oldThread });
  const revision = current().revision;
  const reportStage = (key, state, details = {}) => cli(["expert-stage", taskId], {
    revision, actor: "agent", phase: "work", key, state, ...details,
  });
  reportStage("analysis", "running");
  const question = cli(["expert-message", taskId], {
    actor: "agent", stage: "work:analysis", to: "owner", kind: "question", text: questionText,
  });
  const letter = cli(["expert-message", taskId], {
    actor: "manager", to: "work:analysis", kind: "decision", text: addressText,
  });
  const inbox = actor => cli(["expert-inbox", taskId], { actor }).messages;
  assert.ok(inbox("agent").some(message => message.sequence === letter.sequence && message.to === "work:analysis"));
  assert.equal(inbox("reviewer").length, 0);
  assert.deepEqual(inbox("user").map(message => [message.sequence, message.text]), [[question.sequence, questionText]]);
  record("Адресное письмо нашёл исполнитель в ветке этапа, ревьюер письмо не получил. Вопрос этапа получен в ящике владельца.");
  reportStage("analysis", "done", { result: "Scope checked", outputs: { Evidence: "Scope confirmed" } });
  assert.deepEqual(reportStage("verify", "running").dependencies[0].run.outputs, { Evidence: "Scope confirmed" });
  assert.equal(current().expertTeam.work.stages.length, 2);
  record("Зависимый этап получил Evidence от завершённого этапа, план доступен через show.");
}

app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
nativeTheme.themeSource = "light";
function createWindow() {
  return new BrowserWindow({
    width: 1280, height: 900, useContentSize: true, frame: false, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
}
app.whenReady().then(async () => {
  const window = createWindow();
  try {
    const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    const page = join(scratch, "task-work.html");
    writeFileSync(page, html);
    await window.loadFile(page);
    const font = read("vendor/codicons/codicon.css").replace("./codicon.ttf",
      "data:font/ttf;base64," + readFileSync(join(root, "src", "desktop", "vendor", "codicons", "codicon.ttf")).toString("base64"));
    await window.webContents.insertCSS([read("themes.css"), font, read("styles.css")].join("\n"));
    const evaluate = code => window.webContents.executeJavaScript(code);
    const settle = () => evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    await evaluate(`
      window.taskboard = {
        subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
        chatModels: async () => ({ ok: true, data: [] }), taskLimits: async () => ({ ok: true, data: {} }),
        command: async (action, id) => action === "show" && id === card.id ? { ok: true, data: card } : { ok: true, data: [] },
        reviewerChat: async () => { throw new Error("The card must not read the reviewer journal"); },
      };
      ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
      ${["image-preview.js", "keyboard-focus.js", "source-files.cjs", "markdown.js", "chat.js", "review-diff.js"].map(read).join("\n")}
      ${localizationFixture()}
      const workDisconnects = new WeakMap();
      window.ResizeObserver = class extends ResizeObserver {
        observe(target, options) {
          super.observe(target, options);
          if (target.matches(".task-work")) {
            this.workList = target;
            workDisconnects.set(target, false);
          }
        }
        disconnect() {
          super.disconnect();
          if (this.workList) {
            workDisconnects.set(this.workList, true);
            this.workList = undefined;
          }
        }
      };
      ${read("renderer.js")}
      window.card = ${JSON.stringify(current())};
      frame = {
        project: ${JSON.stringify(project)},
        board: { settings: { boardType: "agent", reviewMode: "reviewer" }, tasks: [card], archived: [] },
      };
      chatDrafts.set(frame.project + "\\0" + card.id, { view: "team", text: "", files: [] });
      void 0;
    `);
    await evaluate("showTask(card.id)");
    await settle();
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("#task-side .board-chat-views button")].map(button => button.textContent)`),
      ["Диалог", "Ход работы"]);
    assert.equal(await evaluate('document.querySelector("#task-chat-work").hidden'), false);
    assert.equal(await evaluate('chatDrafts.get(frame.project + "\\0" + card.id).view'), "work");
    const press = async (view, key) => {
      const selector = `#task-side button[aria-controls="task-chat-${view}"]`;
      window.focus();
      assert.equal(await evaluate(`document.querySelector('${selector}').focus(); document.activeElement.matches('${selector}')`), true);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: key });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      await settle();
      assert.equal(await evaluate(`document.querySelector("#task-chat-${view}").hidden`), false);
    };
    const publish = (type, items, runThreadId = thread, savedRun) => evaluate(`
      updateChat({ project: frame.project, id: card.id, type: ${JSON.stringify(type)},
        items: ${JSON.stringify(items)}, runThreadId: ${JSON.stringify(runThreadId)}, savedRun: ${JSON.stringify(savedRun)} });
      void 0;
    `);
    const rendered = () => evaluate(`[...document.querySelectorAll("#task-chat-work [data-item]")].map(node => node.dataset.item)`);
    const fold = "#task-chat-work .chat-work";
    const foldOpen = () => evaluate(`document.querySelector(${JSON.stringify(fold)}).open`);
    const pressFold = async key => {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: key });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      await settle();
    };
    const clickFold = async () => {
      const position = await evaluate(`(() => {
        const summary = document.querySelector(${JSON.stringify(fold + " > summary")});
        const bounds = summary.getBoundingClientRect();
        return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...position });
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...position });
      await settle();
    };
    const capture = async name => {
      const screenshot = await window.webContents.capturePage();
      assert.deepEqual(screenshot.getSize(), { width: 1280, height: 900 });
      const png = screenshot.toPNG();
      writeFileSync(join(artifacts, name), png);
      return png;
    };
    const dialogText = () => evaluate('document.querySelector("#task-chat-dialogue").textContent');
    if (!restart) {
      await press("dialogue", "Enter");
      await press("work", "Space");
      assert.equal(await evaluate('document.querySelector("#task-chat-work > li.muted").hidden'), false);
      assert.deepEqual(await rendered(), []);
      record("1280 × 900, две вкладки, после старой вкладки открыт пустой «Ход работы». Enter и Space переключают панели.");
      await publish("run", [foreign], oldThread);
      assert.deepEqual(await rendered(), []);
      await publish("run", mixed);
      await publish("discussion", discussion, oldThread);
      await press("dialogue", "Enter");
      assert.ok((await dialogText()).includes(discussionAnswer.text));
      assert.ok((await dialogText()).includes(discussionCommand.title));
      await press("work", "Space");
      record("Живой ответ отдельного чата и его команда видны в «Диалоге».");
    }
    const providerItems = async () => (await rendered())
      .filter(key => /^(item|message|final):/.test(key))
      .map(key => key.split(":")[1]);
    const expected = ["command", "tool", "note", "answer"];
    const verifyWork = async () => {
      assert.deepEqual(await providerItems(), expected);
      const content = await evaluate('document.querySelector("#task-chat-work").textContent');
      for (const forbidden of ["PRIVATE", "PREVIOUS SESSION", "STANDALONE", discussionAnswer.text, questionText, addressText]) {
        assert.ok(!content.includes(forbidden), forbidden);
      }
      assert.ok(content.includes(command.text) && content.includes(tool.text));
    };
    await verifyWork();
    if (!restart) {
      record("Живой IPC сохраняет команду, инструмент, ответ инструмента и сообщения по порядку. Повторный инструмент и события другого сеанса скрыты.");
      cli(["run-log", taskId], { entries: mixed, durationMs: 4_000, runThreadId: thread });
      const sequence = current().history.length;
      await publish("run", [], thread, { sequence, threadId: thread, items: mixed, durationMs: 4_000 });
      await verifyWork();
      assert.equal(await foldOpen(), true);
      await clickFold();
      assert.equal(await foldOpen(), false);
      await publish("run", mixed, thread);
      assert.equal(await foldOpen(), false);
      cli(["chat", taskId], {
        actor: "user", text: "Проверь отдельный ответ.", revision: current().revision, model: "fixture", effort: "low",
      });
      const userCard = current();
      const replyTo = userCard.history.findLastIndex(event => event.chat);
      cli(["chat", taskId], {
        actor: "agent", revision: userCard.revision, replyTo, text: discussionAnswer.text, at: discussionAnswer.at,
        model: "fixture", effort: "low", run: discussion, durationMs: 2_000,
      });
      const card = current();
      assert.equal(card.history.at(-1).runThreadId, undefined);
      assert.deepEqual(card.history.at(-1).run.map(item => item.id), discussion.map(item => item.id));
      await publish("discussion", undefined, oldThread);
      await evaluate(`window.card = ${JSON.stringify(card)}; showTask(card.id)`);
      await settle();
      await verifyWork();
      assert.equal(await foldOpen(), false);
      assert.equal(await evaluate('document.activeElement.matches("#task-chat-work .chat-work > summary")'), true);
      await pressFold("Space");
      assert.equal(await foldOpen(), true);
      record("После получения квитанции мышь сворачивает запуск. Повтор живого события и обновление карточки сохраняют свёртку, фокус и порядок без дублей. Space раскрывает запуск.");
      writeFileSync(checksPath, JSON.stringify(checks));
    } else {
      await press("dialogue", "Enter");
      assert.ok((await dialogText()).includes(discussionAnswer.text));
      await press("work", "Space");
      await verifyWork();
      assert.equal(await foldOpen(), true);
      assert.deepEqual(await evaluate(`[
        document.querySelector("#task-chat-work [data-item='message:note']").checkVisibility({ contentVisibilityAuto: true }),
        document.querySelector("#task-chat-work .chat-run-group > summary").checkVisibility({ contentVisibilityAuto: true }),
        document.querySelector("#task-chat-work [data-item='item:command']").open,
        document.querySelector("#task-chat-work [data-item='item:tool']").open,
      ]`), [true, true, false, false]);
      const expanded = await capture("task-work-expanded.png");
      await clickFold();
      assert.equal(await foldOpen(), false);
      const collapsed = await capture("task-work-collapsed.png");
      await pressFold("Enter");
      assert.equal(await foldOpen(), true);
      assert.equal(await evaluate(`(() => {
        const command = document.querySelector("#task-chat-work [data-item='item:command']");
        const group = command.closest(".chat-run-group");
        group.querySelector("summary").click();
        command.querySelector("summary").click();
        return command.open && command.innerText.includes("M  src/desktop/chat.js");
      })()`), true);
      record("Первый показ сохранённого запуска раскрыт. Сообщение и сводка видимы, команда и инструмент свёрнуты. Мышь сворачивает запуск, Enter раскрывает.");
      record("После перезапуска сохранённый ответ отдельного чата остался в «Диалоге». Его журнал без ID сеанса отсутствует в «Ходе работы».");
      assert.equal(await evaluate('document.querySelectorAll(".expert-stage").length'), 2);
      assert.equal(await evaluate(`
        const mail = document.querySelector(".task-team-mail");
        mail.closest("details").open = true;
        mail.textContent.includes(${JSON.stringify(questionText)});
      `), true);
      record("После перезапуска отдельного процесса Electron журнал прочитан из карточки. Порядок, уникальность, фильтрация и план подтверждены.");
      record("Вопрос владельцу доступен в раскрываемой переписке команды слева от журнала.");
      const restored = activity("restored", "agentMessage", "", "Запись из восстановленного журнала.", 0);
      const restoredCommand = activity("restored-command", "commandExecution", "git status", "Earlier result", 0);
      const later = Array.from({ length: 12 }, (_, index) => {
        const item = activity("later-" + index, "agentMessage", "", "Поздний запуск " + (index + 1), index + 10);
        const action = activity("later-command-" + index, "commandExecution", "git status", "Later result", index + 10);
        return { actor: "agent", action: "run-log", at: item.at, runThreadId: thread, durationMs: 1000, run: [action, item] };
      });
      await evaluate(`
        const index = card.history.findIndex(event => event.run?.some(item => item.id === "command"));
        card.history.splice(index, 0, {
          actor: "agent", action: "run-log", at: ${JSON.stringify(restored.at)},
          runThreadId: ${JSON.stringify(thread)}, durationMs: 1_000,
        });
        card.history.push(...${JSON.stringify(later)});
        api.taskRunHistory = async () => ({
          ok: true, data: { [index]: ${JSON.stringify([tool, restoredCommand, restored])} },
        });
        showTask(card.id);
      `);
      await settle();
      await evaluate(`
        var workLog = () => document.querySelector("#task-chat-work");
        var anchor = () => workLog().querySelector("[data-item='message:note']");
        var anchorOffset = () => anchor().getBoundingClientRect().top - workLog().getBoundingClientRect().top;
        workLog().scrollTop += anchorOffset() - 25;
      `);
      await settle();
      const offset = await evaluate("anchorOffset()");
      const height = await evaluate("workLog().clientHeight");
      assert.ok(offset >= 0 && offset < height / 2, offset);
      await evaluate('document.querySelector(".task-work-controls button").click(); void 0');
      await settle();
      const fullOrder = ["restored-command", "restored", ...expected, ...later.flatMap(event => event.run.map(item => item.id))];
      assert.deepEqual(await providerItems(), fullOrder);
      assert.equal(await foldOpen(), true);
      assert.equal(await evaluate("workLog().clientHeight"), height);
      assert.ok(Math.abs(await evaluate("anchorOffset()") - offset) <= 1);
      await evaluate("showTask(card.id)");
      await settle();
      assert.deepEqual(await providerItems(), fullOrder);
      assert.ok(Math.abs(await evaluate("anchorOffset()") - offset) <= 1);
      record("Подгрузка раннего запуска раскрывает его, сохраняет хронологию, якорь и высоту панели, убирает дубль инструмента. Обновление карточки оставляет подгруженный запуск и положение якоря.");
      for (let cycle = 0; cycle < 2; cycle++) {
        await evaluate("window.previousWorkList = workLog(); sheet.close(); void 0");
        await settle();
        assert.equal(await evaluate("!previousWorkList.isConnected && workDisconnects.get(previousWorkList)"), true);
        await evaluate("delete window.previousWorkList; showTask(card.id)");
        await settle();
        assert.equal(await evaluate("workLog().isConnected && workDisconnects.get(workLog()) === false"), true);
        assert.equal(await foldOpen(), true);
      }
      record("Два цикла закрытия и повторного открытия карточки отсоединяют наблюдатель старого журнала и создают новый.");
      const gitBase = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(gitBase.status, 0, gitBase.stderr);
      const sha256 = data => createHash("sha256").update(data).digest("hex");
      const paths = [
        "src/desktop/chat.js", "src/desktop/renderer.js", "src/desktop/main.ts", "src/desktop/codex-chat.ts",
        "src/desktop/locales/en.json", "src/desktop/locales/ru.json", "src/desktop/styles.css", "src/cli/tasks.ts",
        "src/cli/model.ts", "src/cli/expert-team.ts", "scripts/check-task-work.mjs", "scripts/electron-check.mjs",
      ];
      writeFileSync(join(artifacts, "task-work-expanded-check.txt"), [
        "T-0337. Пройдена проверка Windows Electron и CLI",
        "Команда: node scripts/check-task-work.mjs --artifacts .tasks/qa/T-0337",
        `Среда: ${process.platform} ${process.arch}; Node ${process.versions.node}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}.`,
        "Linux и macOS не запускались. Упаковка вне изменений.",
        "Два процесса Electron, штатный рендерер с синтетическими уведомлениями провайдера и реальная CLI на временной доске.",
        ...checks.map((check, index) => `${index + 1}. ${check}`),
        `База рабочей копии: ${gitBase.stdout.trim()}`,
        "SHA-256 исходников UTF-8, CRLF приведены к LF как при хранении в Git:",
        ...paths.map(path => `${sha256(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n"))}  ${path}`),
        `${sha256(expanded)}  task-work-expanded.png (PNG, исходные байты)`,
        `${sha256(collapsed)}  task-work-collapsed.png (PNG, исходные байты)`,
        "",
      ].join("\n"));
    }
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window.destroy();
    app.exit(1);
  }
});
