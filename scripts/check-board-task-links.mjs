import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "board-task-links", 180_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { saveManagerHistory } = require("../src/desktop/manager-history.ts");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
process.on("unhandledRejection", error => console.error(error));

for (const name of ["userData", "appData"]) {
  const path = join(scratch, name);
  mkdirSync(path);
  app.setPath(name, path);
}
// Disable provider discovery in the isolated profile, including background account checks.
writeFileSync(join(app.getPath("userData"), "codex.json"), JSON.stringify({ executable: join(scratch, "disabled-codex.exe") }));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("lang", "ru");
app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));

const source = join(scratch, "Source");
const target = join(scratch, "Target");
const duplicate = join(scratch, "Duplicate");
const boardName = "План/Факт";
const task = "T-0001";
const sourceTitle = "Карточка исходной доски";
const targetTitle = "Карточка другой доски";
const mixed = "Сверьте #T-0001, путь План/Факт/T-0002. Затем (#" + boardName + "/" + task + ").";
const missing = "Проверка #Отсутствующая доска/T-0001.";
const reply = [mixed, missing].join("\n\n");
const results = [];

function cli(project, args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src", "cli", "main.ts"),
    "--project", project, "--json", ...args, "--stdin",
  ], { input: JSON.stringify(input), encoding: "utf8", windowsHide: true }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

function setupBoard(project, name, title) {
  mkdirSync(project);
  cli(project, ["init"], { git: true });
  cli(project, ["settings"], { name, autoMode: false });
  assert.equal(cli(project, ["create"], plannedDraft({ title })).id, task);
  confirmFixtureDraft(project, task);
}

async function until(predicate, message) {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Не дождались: " + message);
    await wait(40);
  }
}

const evaluate = (window, code) => window.webContents.executeJavaScript(code);
function evaluateWith(window, callback, ...args) {
  return evaluate(window, "(" + callback.toString() + ")(..." + JSON.stringify(args) + ")");
}
const frame = window => evaluate(window, "window.taskboard.bootstrap()");
const open = (window, path) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  return evaluate(window, "window.taskboard.open()");
};
const select = (window, path) => evaluate(window, "window.taskboard.selectTab(" + JSON.stringify(path) + ")");
const closeTab = (window, path) => evaluate(window, "window.taskboard.closeTab(" + JSON.stringify(path) + ")");
const composer = "document.querySelector('#board-composer').firstElementChild";
const log = ".board-chat-log:not(.board-work)";
const links = log + " a.chat-task-reference";
const localLink = links + ":not([data-task-board])";
const boardLink = name => links + "[data-task-board=" + JSON.stringify(name) + "]";
const activeSlot = value => value.tabs.findIndex(tab => tab.path === value.project);

function item(text) {
  return {
    id: randomUUID(), type: "agentMessage", status: "completed", phase: "final_answer",
    title: "", text, at: new Date().toISOString(),
  };
}

function persist(project, question, answer) {
  saveManagerHistory(project, Date.now(), randomUUID(), {
    lane: "chat",
    message: { text: question, clientId: randomUUID(), at: answer.at, files: [] },
    items: [answer],
  });
}

async function openChat(window) {
  await until(() => evaluate(window, "Boolean(" + composer + ")"), "компоновщик диалога");
  await evaluate(window, composer + ".querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))");
  await evaluate(window, "if (!" + composer + ".hasAttribute('data-pinned')) " + composer + ".querySelector('.board-chat-pin').click()");
}

async function activate(window, selector, keyboard = false) {
  window.focus();
  if (keyboard) {
    const focused = await evaluateWith(window, value => {
      document.querySelector(value).focus();
      return document.activeElement.matches(value);
    }, selector);
    assert.equal(focused, true);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    return;
  }
  const point = await evaluateWith(window, value => {
    const link = document.querySelector(value);
    link.scrollIntoView({ block: "nearest" });
    const rect = link.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
}

async function expectCard(window, project, title, before, count, id = task) {
  await until(() => evaluateWith(window, (expectedId, expectedTitle) => {
    const sheet = document.querySelector("#sheet");
    return sheet.open && taskInSheet?.id === expectedId && taskInSheet.title === expectedTitle &&
      sheet.querySelector("#sheet-title").textContent.includes(expectedTitle);
  }, id, title), title);
  const after = await frame(window);
  assert.equal(after.project, project);
  assert.equal(activeSlot(after), activeSlot(before));
  assert.equal(after.tabs.length, before.tabs.length);
  assert.equal(BrowserWindow.getAllWindows().length, count);
}

async function expectRefusal(window, name, reason) {
  const before = await frame(window);
  const selector = boardLink(name);
  await activate(window, selector, true);
  await until(() => evaluateWith(window, expected => {
    const notice = document.querySelector("#notice");
    return !notice.hidden && notice.querySelector("#notice-message").textContent.includes(expected);
  }, reason), reason);
  assert.equal((await frame(window)).project, before.project);
  assert.equal(await evaluate(window, "document.querySelector('#sheet').open"), false);
  assert.equal(await evaluate(window, "document.querySelector(" + JSON.stringify(selector) + ").textContent"), name + "/" + task);
  await evaluate(window, "document.querySelector('#notice-close').click()");
  results.push(reason + " Перехода нет, ссылка читаема.");
}

async function capture(window, name) {
  await evaluate(window, "document.fonts.ready");
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name), image.toPNG());
}

async function run() {
  setupBoard(source, "Исходная доска", sourceTitle);
  setupBoard(target, boardName, targetTitle);
  setupBoard(duplicate, "Другое название", "Одноимённая доска");

  // Use the production main module and renderer with an isolated profile.
  const main = new URL("../src/desktop/main.ts", import.meta.url);
  const sourceText = readFileSync(main, "utf8").replaceAll("import.meta.url", JSON.stringify(main.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, main).href));
  const entry = join(scratch, "main-under-test.mjs");
  const compiled = transformSync(sourceText, { loader: "ts", format: "esm" }).code;
  writeFileSync(entry, compiled + "\nglobalThis.testSubscriptions = subscriptions;\n");
  require(entry);
  await until(() => BrowserWindow.getAllWindows().length === 1, "первое окно");
  const window = BrowserWindow.getAllWindows()[0];
  await until(() => evaluate(window, "Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "первый renderer");
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
  window.setContentSize(1280, 800);
  window.setMinimumSize(0, 0);

  // Supply a deterministic provider response, keeping rendering, history and navigation real.
  ipcMain.removeHandler("board:queue");
  ipcMain.handle("board:queue", (_event, _project, action) => {
    if (action === "list") return { ok: true, data: [] };
    assert.equal(action, "add");
    return { ok: true, data: randomUUID() };
  });
  ipcMain.removeHandler("board:request");
  ipcMain.handle("board:request", (_event, question, _files, project) => {
    assert.equal(project, source);
    assert.equal(typeof question, "string");
    const answer = item(reply);
    persist(project, question, answer);
    return { ok: true, data: { answer: reply, items: [answer] } };
  });

  await open(window, source);
  await open(window, target);
  await select(window, source);
  assert.equal((await frame(window)).board.tasks[0].draftDiscussion, undefined);
  await openChat(window);
  await evaluate(window, `(() => {
    const editor = ${composer};
    const input = editor.querySelector(".draft-input textarea");
    input.value = "Сверь две карточки";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    editor.requestSubmit();
  })()`);
  try {
    await until(() => evaluate(window, "document.querySelectorAll(" + JSON.stringify(links) + ").length === 3"), "ссылки в новом ответе");
  } catch (error) {
    const dialogue = await evaluate(window, "document.querySelector(" + JSON.stringify(log) + ")?.innerHTML");
    console.error(dialogue);
    throw error;
  }
  assert.equal(await evaluate(window, "document.querySelector(" + JSON.stringify(localLink) + ").closest('p').textContent"), mixed.replaceAll("#", ""));
  await capture(window, "dialogue.png");
  await expectRefusal(window, "Отсутствующая доска", "недоступна");
  await open(window, duplicate);
  await select(window, source);
  await openChat(window);
  cli(duplicate, ["settings"], { name: boardName });
  await expectRefusal(window, boardName, "Несколько досок");
  cli(duplicate, ["settings"], { name: "Другое название" });
  await closeTab(window, duplicate);
  const sameWindow = await frame(window);
  await activate(window, boardLink(boardName));
  await expectCard(window, target, targetTitle, sameWindow, 1);
  assert.equal((await frame(window)).tabs[1].path, source);
  await capture(window, "foreign-card.png");
  results.push("Новый ответ: кириллица, косая черта в имени и соседняя пунктуация сохранены. Мышь открыла карточку другой доски в позиции исходной вкладки. Другая вкладка сохранила исходную доску.");

  await select(window, source);
  await closeTab(window, target);
  await evaluate(window, "window.taskboard.menuAction('new-window')");
  await until(() => BrowserWindow.getAllWindows().length === 2, "второе окно");
  const other = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
  other.setContentSize(1280, 800);
  await until(() => evaluate(other, "Boolean(window.taskboard)"), "второй renderer");
  await open(other, source);
  await open(other, target);
  await select(other, source);
  await openChat(other);
  await until(() => evaluate(other, "document.querySelectorAll(" + JSON.stringify(links) + ").length === 3"), "ответ из сохранённой истории");
  assert.equal(await evaluate(other, "document.querySelector(" + JSON.stringify(localLink) + ").closest('p').textContent"), mixed.replaceAll("#", ""));
  const historyFrame = await frame(other);
  await activate(other, localLink, true);
  await expectCard(other, source, sourceTitle, historyFrame, 2);
  await capture(other, "local-card.png");
  await evaluate(other, "document.querySelector('#close-sheet').click()");
  await expectRefusal(other, "Отсутствующая доска", "недоступна");
  results.push("Сохранённый ответ прочитан в новом окне. Enter на короткой ссылке открыл исходную карточку с тем же ID.");

  await closeTab(other, source);
  await openChat(window);
  const otherWindow = await frame(window);
  await activate(window, boardLink(boardName), true);
  await expectCard(window, target, targetTitle, otherWindow, 2);
  assert.equal((await frame(other)).project, target);
  assert.equal(globalThis.testSubscriptions.get(target).tabs.size, 2);
  assert.equal(globalThis.testSubscriptions.has(source), false);
  results.push("Цель открыта в другом окне. Enter открыл карточку в исходном окне и исходной позиции вкладки. Целевая доска осталась открыта в другом окне.");

  await open(window, source);
  await closeTab(window, target);
  await closeTab(other, target);
  assert.equal(globalThis.testSubscriptions.has(target), false);
  assert.ok((await frame(window)).recentBoards.some(board => board.path === target));
  await openChat(window);
  const recent = await frame(window);
  await activate(window, boardLink(boardName));
  await expectCard(window, target, targetTitle, recent, 2);
  assert.equal(globalThis.testSubscriptions.get(target).tabs.size, 1);
  assert.equal(globalThis.testSubscriptions.has(source), false);
  await open(window, source);
  await closeTab(window, target);
  assert.deepEqual([...globalThis.testSubscriptions.keys()], [source]);
  await openChat(window);
  await activate(window, boardLink(boardName), true);
  await expectCard(window, target, targetTitle, recent, 2);
  assert.deepEqual([...globalThis.testSubscriptions.keys()], [target]);
  results.push("Цель закрыта во всех окнах и находится среди недавних. Мышь открыла нужную карточку в исходном окне и в исходной позиции вкладки.");
  results.push("Повтор перехода через недавние оставил одну подписку на открытую доску. Подписка на закрытую доску освобождена.");

  await open(other, duplicate);
  cli(duplicate, ["settings"], { name: boardName });
  await open(window, source);
  await openChat(window);
  await expectRefusal(window, boardName, "Несколько досок");
  await closeTab(other, duplicate);
  cli(duplicate, ["settings"], { name: "Другое название" });
  const corrected = await frame(window);
  await activate(window, boardLink(boardName), true);
  await expectCard(window, target, targetTitle, corrected, 2);
  results.push("После устранения совпадения имён та же ссылка открыла нужную карточку.");

  const quotedName = "Полевые работы #1\\свод";
  cli(target, ["settings"], { name: quotedName });
  persist(source, "Открой доску с новым названием", item("Ссылка " + "`" + "#" + quotedName + "/" + task + "`" + "."));
  await open(other, source);
  await openChat(other);
  const quotedLink = boardLink(quotedName);
  await until(() => evaluateWith(other, selector => Boolean(document.querySelector(selector)), quotedLink), "ссылка с решёткой и обратной косой чертой");
  assert.equal(await evaluateWith(other, selector => document.querySelector(selector).textContent, quotedLink), quotedName + "/" + task);
  const renamed = await frame(other);
  await activate(other, quotedLink, true);
  await expectCard(other, target, targetTitle, renamed, 2);
  results.push("Сохранённая ссылка в строчном коде сохраняет пробел, решётку и обратную косую черту. Enter открыл ту же карточку после переименования доски.");

  cli(target, ["settings"], { name: boardName });
  await open(other, source);
  await openChat(other);
  await expectRefusal(other, quotedName, "недоступна");
  const restored = await frame(other);
  await activate(other, boardLink(boardName), true);
  await expectCard(other, target, targetTitle, restored, 2);
  results.push("После восстановления исходного названия работает первоначальная ссылка на «План/Факт».");

  const prefixedName = "T-0001 Свод";
  const secondTitle = "Вторая карточка другой доски";
  cli(target, ["settings"], { name: prefixedName });
  const secondTask = cli(target, ["create"], plannedDraft({ title: secondTitle })).id;
  assert.equal(secondTask, "T-0002");
  confirmFixtureDraft(target, secondTask);
  const prefixedReference = "#" + prefixedName + "/" + secondTask;
  persist(source, "Открой вторую карточку", item("Открой " + prefixedReference + "."));
  await open(other, source);
  await openChat(other);
  const prefixedLink = boardLink(prefixedName);
  await until(
    () => evaluateWith(other, selector => Boolean(document.querySelector(selector)), prefixedLink),
    "полная ссылка на доску с номером в начале имени",
  );
  const titled = await frame(other);
  await activate(other, prefixedLink, true);
  await expectCard(other, target, secondTitle, titled, 2, secondTask);
  await capture(other, "prefixed-card.png");
  results.push("Ссылка на «T-0001 Свод» с Enter открыла T-0002. Короткая T-0001 рядом с обычным путём в сохранённом ответе открыла исходную карточку.");

  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const version = execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  const changed = execFileSync("git", ["diff", "--name-only", base], { cwd: root, encoding: "utf8", windowsHide: true })
    .trim().split(/\r?\n/).filter(path => path && !path.startsWith("tests/") && !path.startsWith("scripts/"));
  const hashes = [...changed, "scripts/check-board-task-links.mjs"].map(path =>
    createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
  writeFileSync(join(artifacts, "report.txt"), [
    "Проверка ссылок на карточки T-0353",
    "Команда: node scripts/check-board-task-links.mjs --artifacts .tasks/qa/T-0353",
    "Windows " + release() + " " + process.arch + ", запуск из исходников, Node " + version +
      ", Electron " + process.versions.electron + ", Chromium " + process.versions.chrome + ".",
    "Изолированный тестовый профиль. Renderer с sandbox и contextIsolation. Ответ менеджера задан фикстурой, обнаружение провайдера отключено. Linux, macOS и установка пакета вне этой проверки.",
    "", ...results.map(result => "Пройдено. " + result),
    "", "База Git: " + base + ". SHA-256 байтов файлов в проверенной рабочей копии:",
    ...hashes, "",
  ].join("\n"), "utf8");
  console.log("PASS: " + results.length + " сценариев Windows Electron");
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  app.exit(process.exitCode ?? 0);
});
