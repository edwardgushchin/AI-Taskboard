import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const base = "0cfbaa0d97a2a2b22f2c3d87f81f16849bb8eb2e";
const { scratch, artifacts } = electronCheck(import.meta.url, "draft-handoff", 180_000,
  [["--baseline"], ["--fixed"], ["--restart"]]);
const baseline = process.argv.includes("--baseline");
const restart = process.argv.includes("--restart");
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const checkout = fileURLToPath(new URL("../", import.meta.url));
const root = baseline ? join(scratch, "baseline") : checkout;
const profile = join(scratch, baseline ? "baseline-profile" : "fixed-profile");
const project = join(scratch, baseline ? "baseline-board" : "fixed-board");
const reportPath = join(scratch, "passes.txt");
const statePath = join(scratch, "restart.json");
const node = process.env.TASKBOARD_CHECK_NODE;
const execution = { provider: "codex", model: "gpt-6.1-sol", effort: "medium" };
const question = "Какой формат отчёта нужен для этой карточки?";
const answer = "Для отчёта нужен CSV.";
const ready = "Формат отчёта согласован. Черновик готов к утверждению.";
const partial = "Нужен каталог, куда сохранять CSV.";
const owner = "Какой срок утверждает владелец?";
const manualManager = "Ответьте на сохранённый вопрос черновика.";
const manualDraft = "Учтите сохранённый ответ менеджера.";
const holdManager = "Занять сеанс менеджера";
const prefix = "AI Taskboard queue: answer these draft questions through team_message. ";
const pathToCli = join(root, "src", "cli", "main.ts");

function cli(args, input) {
  const output = execFileSync(node, [
    "--disable-warning=ExperimentalWarning", pathToCli, "--project", project, "--json", ...args,
    ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: scratch, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true });
  const reply = JSON.parse(output);
  assert.ok(reply.ok, output);
  return reply.data;
}

function check(message) {
  console.log("PASS " + message);
  writeFileSync(reportPath, message + "\n", { flag: "a" });
}

async function until(predicate, label) {
  const deadline = Date.now() + 25_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error("Timed out: " + label);
    await delay(160);
  }
}

const show = id => cli(["show", id]);
const history = id => show(id).history;
const create = title => cli(["create"], plannedDraft({ title, execution }));
const agentReplies = id => history(id).filter(event => event.chat && event.actor === "agent");
const userReplies = id => history(id).filter(event => event.chat && event.actor === "user");
const managerReplies = id => history(id).filter(event => event.expertMessage?.from === "manager");
const rootQuestion = id => history(id).findIndex(event =>
  event.messageKind === "question" && event.expertMessage?.to === "manager") + 1;

function sendQuestion(id, to, message) {
  cli(["expert-message", id], { actor: "agent", to, kind: "question", text: message });
}

const heldDrafts = new Map();
const draftCalls = [];
const managerCalls = [];
let managerGate;
let holdAfterSending;

globalThis.handoffManager = async (_profile, cwd, prompt, _images, run, _tools, _instructions, _signal, session) => {
  assert.equal(cwd, project);
  assert.equal(Boolean(session.goal || session.resumeGoal || session.iterativeGoal), false);
  managerCalls.push(prompt);
  if (!session.id) session.save(randomUUID());
  if (prompt === holdManager) {
    await managerGate.promise;
    return { text: "Сеанс свободен." };
  }
  assert.ok(prompt.startsWith(prefix) || prompt === manualManager, prompt);
  const inbox = await run("manager_inbox", {});
  assert.ok(inbox.ok, JSON.stringify(inbox));
  const messages = inbox.data.filter(message => message.kind === "question" && message.expertMessage?.to === "manager");
  assert.ok(messages.length);
  for (const { id, sequence } of messages) {
    const reply = await run("team_message", { id, to: id, replyTo: sequence, kind: "update", text: answer });
    assert.ok(reply.ok, JSON.stringify(reply));
    if (holdAfterSending) await holdAfterSending.promise;
  }
  return { text: "Ответ сохранён." };
};

globalThis.handoffDraft = async (prompt, onControl, mode, tools, run) => {
  const context = JSON.parse(prompt);
  const { id, title, status } = context.task;
  assert.equal(status, "draft");
  draftCalls.push({ id, mode });
  const interrupt = Promise.withResolvers();
  onControl({ interrupt: async () => interrupt.resolve({ interrupted: true }), steer: async () => {} });
  const result = output => ({ text: JSON.stringify(output) });
  if (mode === "initial") {
    const managerQuestion = title.includes("Менеджер");
    const ownerQuestion = title.includes("Владелец");
    if (managerQuestion || ownerQuestion) {
      const to = managerQuestion ? "manager" : "owner";
      const text = managerQuestion ? question : owner;
      if (baseline) {
        sendQuestion(id, to, text);
      } else {
        assert.ok(tools.some(tool => tool.name === "team_message"));
        const saved = await run("team_message", { to, kind: "question", text });
        assert.ok(saved.ok, JSON.stringify(saved));
      }
    }
    const gate = heldDrafts.get(title);
    if (gate) await Promise.race([gate.promise, interrupt.promise]);
    if (ownerQuestion) return result({ questions: owner });
    return result({ questions: managerQuestion ? "Ожидается уточнение формата отчёта." : "" });
  }
  if (mode === "handoff") {
    assert.deepEqual(context.managerReplies.map(reply => [reply.text, reply.replyTo]), [[answer, rootQuestion(id)]]);
  } else {
    assert.equal(context.latestUserMessage?.text, manualDraft);
    assert.ok(context.history.some(event => event.text === answer));
  }
  return result(title.includes("пробел") ?
    { text: partial, awaitingAnswer: true } : { text: ready, awaitingAnswer: false });
};

function mountApp() {
  const importSource = url => readFileSync(url, "utf8").replaceAll("\r\n", "\n")
    .replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
  const compile = source => require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code;
  const mainUrl = pathToFileURL(join(root, "src", "desktop", "main.ts"));
  const chatUrl = new URL("./codex-chat.ts", mainUrl);
  const draftBoundary = "reply(profile, project, prompt, images, runAction, { ...options, worklog, mcp: { config, env } })";
  const chatSource = importSource(chatUrl);
  assert.equal(chatSource.split(draftBoundary).length, 2);
  const taskMcp = "[worklogTool, githubReadTool, ...specialistTools]";
  const dispatchStart = "return withBoardMcp(" + taskMcp + ", async (name, args) => {";
  const dispatchEnd = "}, async (config, env) => {\n    const result = await " + draftBoundary;
  assert.equal(chatSource.split(dispatchStart).length, 2);
  assert.equal(chatSource.split(dispatchEnd).length, 2);
  const chatFixture = chatSource.replace(dispatchStart, "const dispatchTaskTool = async (name, args) => {")
    .replace(dispatchEnd, "};\n  return withBoardMcp(" + taskMcp + ", dispatchTaskTool, async (config, env) => {\n" +
      "    const result = await globalThis.handoffDraft(prompt, onControl, mode, specialistTools, dispatchTaskTool)");
  const chatEntry = join(scratch, "handoff-codex-chat.mjs");
  writeFileSync(chatEntry, compile(chatFixture));
  const managerBinding = "readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal";
  const mainSource = importSource(mainUrl);
  assert.equal(mainSource.split(managerBinding).length, 2);
  const mainEntry = join(scratch, "handoff-main.mjs");
  writeFileSync(mainEntry, compile([
    "const replyToBoard = (...args) => globalThis.handoffManager(...args);",
    mainSource.replace(chatUrl.href, pathToFileURL(chatEntry).href)
      .replace(managerBinding, "readTaskRunHistory, replyToTask, reviewWithCodex, updateBoardGoal"),
    "globalThis.handoffWindow = project => createWindow([project]).window;",
    "globalThis.handoffRescan = () => scheduleAgentWork();",
  ].join("\n")));
  require(mainEntry);
}

async function run() {
  if (baseline) {
    execFileSync("git", ["clone", "--shared", "--quiet", "--no-checkout", checkout, root], { windowsHide: true });
    execFileSync("git", ["-C", root, "-c", "core.longpaths=true", "checkout", "--quiet", "--detach", base], { windowsHide: true });
    const modules = dirname(dirname(require.resolve("electron/package.json")));
    symlinkSync(modules, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(modules, join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  if (!restart) {
    mkdirSync(project);
    mkdirSync(profile);
    cli(["init"], { git: false });
    cli(["settings"], { autoMode: false, executor: execution, manager: execution, reviewMode: "human" });
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru", theme: "dark" }));
  }
  app.setPath("userData", profile);
  app.setPath("appData", scratch);
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  mountApp();
  await until(() => BrowserWindow.getAllWindows().length, "Electron window");
  const window = BrowserWindow.getAllWindows()[0];
  window.setContentSize(1280, 900);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const boardLoaded = "window.taskboard?.bootstrap().then(f => !f.loading && f.board?.project === " + JSON.stringify(project) + ")";
  if (!restart) {
    await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
    await evaluate("window.taskboard.menuAction('open-project')");
  }
  await until(() => evaluate(boardLoaded), "board loaded");

  const manager = text => evaluate("window.taskboard.boardRequest(" + JSON.stringify(text) + ")");
  const open = id => evaluate("showTask(" + JSON.stringify(id) + ")");
  const close = () => evaluate("document.querySelector('#close-sheet')?.click()");
  const capture = async name => {
    await evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
    const image = await window.webContents.capturePage();
    assert.deepEqual(image.getSize(), { width: 1280, height: 900 });
    writeFileSync(join(artifacts, name), image.toPNG());
  };
  const revealMail = async text => {
    await until(() => evaluate("document.querySelector('.task-team-mail')?.textContent.includes(" +
      JSON.stringify(text) + ")"), "team mail");
    await evaluate("document.querySelector('.task-team-mail').closest('details').open = true");
    await evaluate("document.querySelector('.task-team-mail').scrollIntoView({block:'center'})");
  };
  const waitReady = async (id, expected = ready) => {
    await until(() => agentReplies(id).some(event => event.text === expected), "draft result " + id);
    const card = show(id);
    assert.equal(card.status, "draft");
    assert.equal(card.awaitingAnswer, expected === partial);
    assert.equal(managerReplies(id).length, 1);
    assert.equal(managerReplies(id)[0].expertMessage.replyTo, rootQuestion(id));
    assert.equal(userReplies(id).length, 0);
  };

  if (baseline) {
    const card = create("Менеджер: исходный сценарий");
    await until(() => rootQuestion(card.id) && agentReplies(card.id).length === 1, "original question");
    await delay(1300);
    assert.equal(managerCalls.length, 0);
    assert.equal(managerReplies(card.id).length, 0);
    check("Исходная версия: вопрос остался в почте, пока пользователь не написал менеджеру.");
    assert.ok((await manager(manualManager)).ok);
    await delay(1300);
    assert.equal(managerReplies(card.id).length, 1);
    assert.equal(managerReplies(card.id)[0].expertMessage.replyTo, rootQuestion(card.id));
    assert.equal(agentReplies(card.id).length, 1);
    check("Исходная версия: сохранённый ответ не продолжил разбор.");
    const request = { ...execution, text: manualDraft, files: [] };
    const sent = await evaluate("window.taskboard.chatSend(" + JSON.stringify(card.id) + "," + JSON.stringify(request) + ")");
    assert.ok(sent.result.ok, JSON.stringify(sent));
    assert.equal(agentReplies(card.id).at(-1).text, ready);
    assert.equal(userReplies(card.id).length, 1);
    check("Исходная версия: второе ручное сообщение в карточке привело к готовности.");
    return;
  }
  if (restart) {
    const { completedId, waitingId } = JSON.parse(readFileSync(statePath, "utf8"));
    await waitReady(waitingId);
    assert.equal(draftCalls.filter(call => call.id === waitingId && call.mode === "handoff").length, 1);
    assert.equal(draftCalls.filter(call => call.id === completedId).length, 0);
    assert.equal(managerCalls.length, 0);
    assert.equal(managerReplies(completedId).length, 1);
    check("Перезапуск продолжил сохранённый ответ и не повторил завершённый обмен.");
    const hashes = [
      "src/cli/archive.ts", "src/cli/expert-team.ts", "src/cli/main.ts", "src/cli/model.ts",
      "src/cli/task-messages.ts", "src/cli/tasks.ts", "src/desktop/board-actions.ts", "src/desktop/codex-chat.ts",
      "src/desktop/main.ts", "scripts/check-draft-handoff.mjs", "scripts/electron-check.mjs",
      "tests/fixtures/planned-draft.ts",
    ].map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
    writeFileSync(join(artifacts, "draft-handoff-check.txt"), [
      "T-0316. Результаты Windows Electron, детерминированный провайдер.",
      "Команда: node scripts/check-draft-handoff.mjs --artifacts .tasks/qa/T-0316",
      "База исходного прогона и рабочего дерева: " + base,
      "История T-0315: записи 7, 11–14.",
      "ОС: " + process.platform + ". Electron " + process.versions.electron + ". Chromium " + process.versions.chrome + ".",
      "Node для CLI: " + execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim() + ".",
      "",
      readFileSync(reportPath, "utf8").trimEnd(),
      "",
      "SHA-256 необработанных байтов использованных файлов в рабочей копии:",
      ...hashes,
      "",
    ].join("\n"));
    return;
  }

  managerGate = Promise.withResolvers();
  const busyManager = manager(holdManager);
  await until(() => managerCalls.length === 1, "busy manager");
  const title = "Менеджер: очередь при выключенном авторежиме";
  const draftGate = Promise.withResolvers();
  heldDrafts.set(title, draftGate);
  const card = create(title);
  const queue = create("Обычная очередь");
  await until(() => rootQuestion(card.id), "saved question");
  await until(() => agentReplies(queue.id).length === 1, "ordinary draft queue");
  cli(["approve", queue.id], { revision: show(queue.id).revision, actor: "user" });
  await delay(900);
  assert.deepEqual(managerCalls, [holdManager]);
  assert.equal(managerReplies(card.id).length, 0);
  await open(card.id);
  await revealMail(question);
  await capture("draft-handoff-question.png");
  await close();
  const second = globalThis.handoffWindow(project);
  await until(() => second.webContents.executeJavaScript(boardLoaded), "second board window");
  managerGate.resolve();
  assert.ok((await busyManager).ok);
  await until(() => managerReplies(card.id).length === 1, "answer saved during draft");
  assert.equal(draftCalls.filter(call => call.id === card.id).length, 1);
  draftGate.resolve();
  await waitReady(card.id);
  for (let count = 0; count < 3; count++) globalThis.handoffRescan();
  await delay(1300);
  assert.equal(draftCalls.filter(call => call.id === card.id && call.mode === "handoff").length, 1);
  assert.equal(managerCalls.filter(prompt => prompt.startsWith(prefix)).length, 1);
  assert.equal(show(queue.id).status, "ready");
  assert.equal(history(queue.id).some(event => event.action === "start"), false);
  check("Авторежим выключен: вопрос дождался менеджера, ответ дождался текущего разбора. Карточка была закрыта. Обычный разбор прошёл, утверждённая работа осталась в очереди, ход цели не стартовал.");
  check("Два окна и повторные проходы планировщика сохранили один ответ и один ход продолжения.");
  await open(card.id);
  await until(() => evaluate("document.querySelector('.task-dialogue:not([hidden])')?.textContent.includes(" +
    JSON.stringify(ready) + ")"), "visible ready");
  await revealMail(answer);
  await capture("draft-handoff-ready.png");
  await close();
  second.close();

  cli(["auto-queue"], { revision: cli(["auto-queue"]).revision, paused: true });
  cli(["settings"], { autoMode: true });
  const auto = create("Менеджер: авторежим включён");
  await waitReady(auto.id);
  const incomplete = create("Менеджер: остался пробел");
  await waitReady(incomplete.id, partial);
  const ownerCard = create("Владелец: решение о сроке");
  await until(() => agentReplies(ownerCard.id).length === 1, "owner question");
  assert.equal(show(ownerCard.id).awaitingAnswer, true);
  assert.ok(history(ownerCard.id).some(event => event.expertMessage?.to === "owner"));
  assert.equal(managerReplies(ownerCard.id).length, 0);
  assert.equal(draftCalls.filter(call => call.id === ownerCard.id).length, 1);
  assert.equal(cli(["approve", auto.id], { revision: show(auto.id).revision, actor: "user" }).status, "ready");
  check("Авторежим включён: черновик разобран без сообщений в чатах. Неполный ответ оставил конкретный пробел. Вопрос владельцу ждёт владельца. Готовый черновик утверждён отдельным действием.");

  cli(["settings"], { autoMode: false });
  const waitingTitle = "Менеджер: сохранённый ответ перед перезапуском";
  heldDrafts.set(waitingTitle, Promise.withResolvers());
  holdAfterSending = Promise.withResolvers();
  const waiting = create(waitingTitle);
  await until(() => managerReplies(waiting.id).length === 1, "persisted reply before restart");
  assert.equal(draftCalls.filter(call => call.id === waiting.id).length, 1);
  writeFileSync(statePath, JSON.stringify({ completedId: card.id, waitingId: waiting.id }));
}

process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
