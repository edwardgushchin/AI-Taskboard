// Real Electron, board storage, IPC and scheduler with deterministic provider boundaries.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { registerRuntime, runtimeEntries } from "../src/desktop/board-runtime.ts";
import { sendGoalMessage } from "../src/desktop/manager-history.ts";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "iterative-goal", 120_000, [[], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const binding = join(project, ".tasks", "manager-dialog.json");
const launches = join(scratch, "launches.jsonl");
const failures = join(scratch, "start-failures.jsonl");
const observations = join(scratch, "observations.md");
const profile = join(scratch, "profile");
const restarted = process.argv.includes("--restart");
const idsFile = join(scratch, "ids.json");
const objective = "Пополнить очередь экспериментальной доски";
const checkpoint = "Следующий шаг — дождаться завершения зависимости.";
const goalQuestion = "Вопрос от карточки цели";
const ordinaryQuestion = "Вопрос от карточки вне цели";
const ownerInstruction = "Указание владельца активной цели";
const label = "Авторежим";
const hint = "Нужна активная цель";
const trigger = "#status-auto-mode";
const panel = "#auto-mode-panel";
const auto = "#auto-mode-switch";
const iterativeHint = "#iterative-goal-hint";
let ids;
let window;
let releaseExecutor;

function cliReply(args, input) {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project, "--json",
    ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: scratch, input: input && JSON.stringify(input), encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  assert.ok(result.stdout, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(result.status, reply.ok ? 0 : 1, result.stderr);
  return reply;
}

function cli(args, input) {
  const reply = cliReply(args, input);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

function createReady(title, fields = {}) {
  const draft = cli(["create"], plannedDraft({ title, tags: ["QA"], ...fields }));
  cli(["approve", draft.id]);
  return draft.id;
}

function writeGoal(status) {
  writeFileSync(binding, JSON.stringify({
    provider: "codex",
    id: ids.thread,
    goalId: ids.goal,
    history: "local",
    goal: { objective, status },
  }));
}

function log(message) {
  console.log("PASS " + message);
  appendFileSync(observations, "- " + message + "\n");
}

function count() {
  return existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n").length : 0;
}

function failureRecords() {
  if (!existsSync(failures)) return [];
  return readFileSync(failures, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function refuseOnce(reason) {
  if (failureRecords().some(entry => entry.reason === reason)) return false;
  appendFileSync(failures, JSON.stringify({ reason, at: Date.now() }) + "\n");
  return true;
}

async function until(test, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for " + description);
}

async function settled(expected, description) {
  await until(() => count() === expected && !runtimeEntries(project).some(entry => entry.task === "manager:context"), description);
}

async function unchanged(expected, description) {
  // The board's periodic autoqueue pass runs every second.
  await delay(2300);
  assert.equal(count(), expected, description);
}

async function retried(expected, reason) {
  await until(() => failureRecords().some(entry => entry.reason === reason), reason);
  const failure = failureRecords().find(entry => entry.reason === reason);
  assert.equal(count(), expected - 1, "Failure must not start a turn.");
  await settled(expected, "retry after " + reason);
  const last = readFileSync(launches, "utf8").trim().split("\n").at(-1);
  assert.ok(JSON.parse(last).at - failure.at >= 4900, "Retry began before the provider cooldown.");
  assert.equal(failureRecords().filter(entry => entry.reason === reason).length, 1);
}

const evaluate = expression => window.webContents.executeJavaScript(expression);
const read = (selector, expression) => evaluate("document.querySelector(" + JSON.stringify(selector) + ")" + expression);

async function click(selector) {
  window.focus();
  window.webContents.focus();
  const point = await until(() => evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const bounds = target.getBoundingClientRect();
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height / 2);
    return target.contains(document.elementFromPoint(x, y)) && { x, y };
  })()`), "click target " + selector);
  for (const type of ["mouseDown", "mouseUp"]) {
    window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point });
  }
}

async function key(selector, keyCode) {
  window.focus();
  window.webContents.focus();
  await read(selector, ".focus()");
  const events = keyCode === "Escape" ? ["keyDown", "keyUp"] : ["keyDown", "char", "keyUp"];
  for (const type of events) window.webContents.sendInputEvent({ type, keyCode });
}

const panelOpen = () => read(panel, ".matches(':popover-open')");
const hintText = () => read(iterativeHint, ".textContent.trim()");

async function capture(name) {
  await until(() => read(panel, ".matches(':popover-open') && getComputedStyle(document.querySelector('#auto-mode-panel')).opacity === '1'"),
    "popover paint");
  await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  const bytes = image.toPNG();
  assert.ok(bytes.length < 4 * 1024 * 1024);
  writeFileSync(join(artifacts, name), bytes);
}

function prepare() {
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  if (!restarted) {
    mkdirSync(project);
    cli(["init"], { git: false });
    cli(["settings"], { autoMode: false, reviewMode: "reviewer", taskLimits: { executor: 2, reviewer: 2 } });
    cli(["tag", "ensure"], { name: "QA", color: "#5B8DEF" });
    const goal = randomUUID();
    const dependency = createReady("Незавершённая зависимость", { managerGoalId: goal, actor: "manager" });
    cli(["start", dependency]);
    const ordinary = createReady("Карточка вне цели ожидает запуска");
    cli(["start", ordinary], { actor: "user", queueExecutor: true });
    const ready = ["Первая", "Вторая", "Третья", "Четвёртая"].map(name => createReady(name + " готовая карточка"));
    const waiting = createReady("Карточка с зависимостью", { dependencies: [dependency] });
    const held = createReady("Готовая карточка на удержании");
    cli(["auto-queue"], { revision: 0, hold: [held] });
    ids = { thread: randomUUID(), goal, dependency, ordinary, ready, waiting };
    writeFileSync(idsFile, JSON.stringify(ids));
    mkdirSync(profile);
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  } else {
    ids = JSON.parse(readFileSync(idsFile, "utf8"));
  }
  app.setPath("userData", profile);
  app.setPath("appData", join(scratch, "app-data"));
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  app.requestSingleInstanceLock = () => true;
  app.disableHardwareAcceleration();
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  app.on("web-contents-created", (_event, contents) => {
    contents.setBackgroundThrottling(false);
    contents.on("console-message", details => {
      if (details.level === "error") console.error(details.message);
    });
    contents.on("preload-error", (_event, path, error) => console.error(path, error));
  });

  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const original = readFileSync(sourceUrl, "utf8");
  const source = original
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal", "readTaskRunHistory, replyToTask, reviewWithCodex")
    .replace("async function launchTask(", "async function originalLaunchTask(")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  assert.match(source, /async function originalLaunchTask\(/);
  assert.doesNotMatch(source, /readTaskRunHistory, replyToBoard,/);
  const fixture = [
    "const replyToBoard = (...args) => globalThis.fixtureManager(...args);",
    "const updateBoardGoal = (...args) => globalThis.fixtureControl(...args);",
    'const launchTask = async () => cliFailure("EXECUTOR_LIMIT", "Execution held by QA fixture.");',
    source,
    'globalThis.fixtureGoal = project => broadcastBoardChat(project, "orchestrator-goal", {goal: readBoardThread(boardThreadPath(project)).goal});',
  ].join("\n");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(fixture, { loader: "ts", format: "esm" }).code);
  require(entry);
}

globalThis.fixtureControl = async (_profile, cwd, thread, action) => {
  assert.equal(cwd, project);
  assert.equal(thread, ids.thread);
  if (action.kind === "clear") return null;
  assert.equal(action.kind, "pause");
  return { objective, status: "paused" };
};

let ordinaryResumes = 0;
let ordinaryQuestions = 0;
globalThis.fixtureManager = async (_profile, cwd, prompt, _images, action, _tools, instructions, _signal, session) => {
  assert.equal(cwd, project);
  if (!session.iterativeGoal) {
    if (prompt.includes(ordinaryQuestion)) ordinaryQuestions++;
    if (session.resumeGoal) {
      assert.equal(session.id, ids.thread);
      ordinaryResumes++;
    }
    return { text: "Ответ проверочного провайдера", model: "QA fixture" };
  }
  assert.equal(session.id, ids.thread);
  assert.equal(session.iterativeGoal, true);
  assert.match(instructions, new RegExp(objective));
  assert.ok(!prompt.includes(ordinaryQuestion));
  const context = JSON.parse(prompt.slice(prompt.indexOf("{")));
  assert.equal(context.target, 4);
  assert.equal(context.ready, 3);
  assert.equal(context.workingOrQueued, 2);
  if (count() === 0 && refuseOnce("prepare")) throw new Error("Fixture: failed to prepare provider before sending");
  assert.equal(typeof session.onTurnStarting, "function");
  assert.equal(typeof session.onTurnRejected, "function");
  if (count() === 2) assert.match(prompt, new RegExp(goalQuestion));
  session.onTurnStarting();
  if (count() === 2 && refuseOnce("rejected")) {
    session.onTurnRejected();
    throw new Error("Fixture: provider explicitly rejected starting the turn");
  }
  if (count() === 3) {
    const inbox = await action("goal_inbox", {});
    assert.equal(inbox.ok, true, JSON.stringify(inbox));
    assert.ok(inbox.data.some(message => message.text === ownerInstruction));
  }
  assert.equal(runtimeEntries(project).filter(entry => entry.task === "manager:context").length, 1);
  appendFileSync(launches, JSON.stringify({ prompt, at: Date.now() }) + "\n");
  session.onGoal({ objective, status: "active" });
  if (count() === 1) {
    ids.refill = createReady("Карточка, подготовленная коротким ходом");
    writeFileSync(idsFile, JSON.stringify(ids));
  }
  const report = await action("goal_report", { text: checkpoint });
  assert.equal(report.ok, true, JSON.stringify(report));
  return { text: checkpoint, model: "QA fixture", goalStatus: "active" };
};

function writeReport() {
  const paths = [
    "scripts/check-iterative-goal.mjs", "scripts/electron-check.mjs", "src/cli/main.ts",
    "src/cli/manager-goal.ts", "src/desktop/auto-queue.ts", "src/desktop/codex-chat.ts",
    "src/desktop/index.html", "src/desktop/iterative-goal.ts", "src/desktop/locales/ru.json",
    "src/desktop/main.ts", "src/desktop/preload.cjs", "src/desktop/renderer.js", "src/desktop/styles.css",
  ];
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const hashes = bytes => paths.map(path => {
    const digest = createHash("sha256").update(bytes(path)).digest("hex");
    return `- \`${digest}\` \`${path}\``;
  });
  writeFileSync(join(artifacts, "iterative-goal-check.md"), [
    "# Проверка итеративной цели",
    "",
    "Два процесса используют одну изолированную доску и профиль. Проверены реальный интерфейс Electron, IPC, команды CLI, хранилище и планировщик. Ответы модели детерминированы. Исполнительский запуск удерживается на границе диспетчера, чтобы проверять запас карточек без вызова внешнего провайдера.",
    "",
    "Профиль: " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node " + process.versions.node].join(", ") +
      ". Viewport 1280×800, масштаб 100%, Chromium sandbox включён. Linux и macOS не запускались.",
    "",
    readFileSync(observations, "utf8").trimEnd(),
    "",
    "Команда",
    "",
    "```powershell",
    "node scripts/check-iterative-goal.mjs --artifacts .tasks/qa",
    "```",
    "",
    "HEAD проверенной копии: " + revision + ". SHA-256 байтов checkout перед инструментированием:",
    "",
    ...hashes(path => readFileSync(join(root, path))),
    "",
    "SHA-256 исходных Git blobs (байты git cat-file blob HEAD:<path>):",
    "",
    ...hashes(path => execFileSync("git", ["cat-file", "blob", "HEAD:" + path], { cwd: root })),
    "",
  ].join("\n"), "utf8");
}

async function run() {
  prepare();
  releaseExecutor = registerRuntime(project, { kind: "slot", role: "executor", task: ids.dependency });
  assert.ok(releaseExecutor);
  await app.whenReady();
  window = await until(() => BrowserWindow.getAllWindows()[0], "startup window");
  window.setContentSize(1280, 800);
  window.focus();
  window.webContents.focus();
  try {
    await until(async () => !window.webContents.isLoading() && await evaluate("Boolean(window.taskboard)"), "renderer bridge");
    await evaluate("window.taskboard.menuAction('open-project')");
    await until(async () => !window.webContents.isLoading() && await evaluate(
      "Boolean(window.taskboard && document.querySelector('#status-auto-mode:not([hidden])'))"), "autorun button");
  } catch (error) {
    console.error(await evaluate(`window.taskboard.bootstrap().then(frame => ({
      board: Boolean(frame.board), error: frame.error, loading: frame.loading,
      button: document.querySelector('#status-auto-mode')?.outerHTML
    }))`));
    throw error;
  }
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(window.webContents.getZoomFactor(), 1);
  assert.equal(await evaluate("devicePixelRatio"), 1);

  if (restarted) {
    // Allow a pending retry to fire if a successful launch was not persisted.
    await delay(6200);
    assert.equal(count(), 4, "Restart must not retry handled triggers.");
    assert.deepEqual(failureRecords().map(entry => entry.reason), ["prepare", "rejected"]);
    log("Реальный перезапуск при сохранённых условии, вопросе и указании: +0 запусков, всего 4.");
    await click("#board-draft textarea[name=request]");
    await until(async () => await read(".board-goal-status", "?.textContent") === "Цель ждёт работы",
      "visible waiting status");
    await read(".board-goal", ".open = true");
    const pause = ".board-goal-actions > button:nth-child(2)";
    await until(() => read(pause, ".checkVisibility() && !document.querySelector(" + JSON.stringify(pause) + ").disabled"),
      "pause action between turns");
    await read(pause, ".click()");
    await until(() => JSON.parse(readFileSync(binding, "utf8")).goal.status === "paused", "manual pause saved");
    await click(trigger);
    await until(async () => (await hintText()).includes("ручной паузе"), "manual pause visible");
    assert.equal(cliReply(["settings"], { iterativeGoal: ids.goal }).error.code, "ACTIVE_GOAL_REQUIRED");
    cli(["message", ids.dependency], { text: "Вопрос на паузе", kind: "question" });
    await unchanged(4, "paused goal");
    log("При ручной паузе новый вопрос дал +0 итеративных запусков. Повтор сохранения отклонён.");
    writeGoal("complete");
    globalThis.fixtureGoal(project);
    await until(async () => await hintText() === hint, "completion restores the hint");
    assert.equal(cliReply(["settings"], { iterativeGoal: ids.goal }).error.code, "ACTIVE_GOAL_REQUIRED");
    await unchanged(4, "completed goal");
    writeGoal("paused");
    globalThis.fixtureGoal(project);
    await until(async () => (await hintText()).includes("ручной паузе"), "restored paused goal");
    assert.equal((await evaluate('window.taskboard.boardGoal("clear")')).ok, true);
    assert.equal(JSON.parse(readFileSync(binding, "utf8")).goal, null);
    await until(async () => await hintText() === hint, "clearing a paused goal restores the hint");
    await unchanged(4, "cleared goal");
    log("Завершение и снятие возвращают подсказку в блоке цели, +0 итеративных запусков.");
    cli(["settings"], { iterativeGoal: false, autoMode: false });
    writeGoal("active");
    globalThis.fixtureGoal(project);
    const resumed = await evaluate(`window.taskboard.boardGoal("resume", ${JSON.stringify(objective)})`);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(ordinaryResumes, 1);
    assert.equal(cli(["auto-queue"]).held.length, 1);
    const history = await evaluate(`window.taskboard.boardHistory(${JSON.stringify(project)}, null, "work")`);
    assert.match(JSON.stringify(history), new RegExp(checkpoint));
    log("После выключения выполняется обычное ручное продолжение в том же чате. Журнал и удержание карточки сохранились.");
    writeReport();
    return;
  }

  await click(trigger);
  await until(panelOpen, "popover opened using mouse");
  assert.equal(await read(trigger, ".innerText.trim()"), label);
  assert.equal(await read(auto, ".checked"), false);
  assert.equal(await evaluate("document.querySelectorAll('#auto-mode-panel input').length"), 1);
  assert.equal(await hintText(), hint);
  const buttonBounds = await read(trigger, ".getBoundingClientRect().toJSON()");
  const panelBounds = await read(panel, ".getBoundingClientRect().toJSON()");
  assert.ok(buttonBounds.top - panelBounds.bottom >= 0 && buttonBounds.top - panelBounds.bottom <= 12);
  assert.ok(panelBounds.left <= buttonBounds.left && panelBounds.right >= buttonBounds.left);
  await key(auto, "Escape");
  await until(async () => !await panelOpen(), "Escape closes the panel");
  await key(trigger, "Return");
  await until(panelOpen, "keyboard opens the panel");
  assert.equal(await read(auto, ".checked"), false);
  log("Мышь и Enter открывают панель с одним тумблером. Escape закрывает панель.");

  await click(auto);
  await until(() => read(auto, ".checked"), "ordinary autorun enabled");
  assert.equal(cli(["settings"]).autoMode, true);
  assert.equal(await read(trigger, ".innerText.trim()"), label);
  writeGoal("active");
  cli(["settings"], { iterativeGoal: ids.goal });
  globalThis.fixtureGoal(project);
  await until(async () => (await read("#iterative-goal-rule", ".textContent")).includes("Пополнение очереди"), "legacy queue rule visible");
  await capture("iterative-goal-active.png");
  await unchanged(0, "sufficient stock");
  log("Для сохранённой настройки без интервала действует пополнение очереди. Два слота, четыре готовые карточки и две в работе, одна ожидает запуска: 0 итераций.");
  cli(["cancel", ids.ready[1]], { reason: "Создать нехватку готовых карточек." });
  await retried(1, "prepare");
  log("Дефицит: ошибка подготовки провайдера до отправки, 0 ходов. Через пять секунд состоялся один повтор с запуском.");
  const pending = cli(["list", "--compact"]).tasks;
  assert.equal(pending.find(task => task.id === ids.refill).status, "ready");
  const history = await evaluate(`window.taskboard.boardHistory(${JSON.stringify(project)}, null, "work")`);
  assert.match(JSON.stringify(history), new RegExp(checkpoint));
  await unchanged(1, "after replenishment");
  log("Нехватка при наличии зависимой и удерживаемой карточек: +1 короткий ход, добавлена одна готовая карточка, следующий шаг сохранён, контекст освобождён.");
  cli(["cancel", ids.refill], { reason: "Проверить сохранение условия ожидания." });
  await settled(2, "no further work to prepare");
  cli(["progress", ids.dependency], { summary: "Обычный прогресс", nextStep: "Продолжить" });
  await unchanged(2, "repeated events and unchanged dependency");
  log("Следующая нехватка: +1 ход, затем обычный прогресс незавершённой зависимости и повторные события дали +0 запусков.");
  cli(["message", ids.dependency], { kind: "question", text: goalQuestion });
  await retried(3, "rejected");
  log("Вопрос по карточке цели: провайдер явно отклонил отправку хода, 0 запусков. Через пять секунд состоялся один повтор с запуском.");
  await unchanged(3, "question remains unread");
  log("Вопрос от карточки цели: +1 ход. Вопрос оставлен непрочитанным, следующие проходы дали +0.");
  cli(["message", ids.ordinary], { kind: "question", text: ordinaryQuestion });
  await until(() => ordinaryQuestions === 1, "question outside the goal reaches the ordinary manager");
  await unchanged(3, "ordinary question didn't trigger the iterative goal");
  log("Вопрос от карточки вне цели: +1 вызов обычного менеджера, +0 итеративных ходов.");
  sendGoalMessage(project, ids.goal, ownerInstruction);
  await settled(4, "owner instruction");
  await unchanged(4, "owner instruction remains pending");
  log("Указание владельца: +1 ход, текст доступен через goal_inbox, повторное событие дало +0.");
}

void run().finally(() => releaseExecutor?.()).then(
  () => app.exit(0),
  error => {
    console.error(error);
    app.exit(1);
  },
);
