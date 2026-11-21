// Windows Electron with real renderer, IPC, storage and scheduler; the model is deterministic.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { sendGoalMessage } from "../src/desktop/manager-history.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "interval-goal", 180_000, [[], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const binding = join(project, ".tasks", "manager-dialog.json");
const iterationFile = join(project, ".tasks", "iterative-goal.json");
const profile = join(scratch, "profile");
const logFile = join(scratch, "observations.md");
const callsFile = join(scratch, "turns.jsonl");
const restarted = process.argv.includes("--restart");
const objective = "Включи итеративный режим и настрой проверку T-0123 каждые 25 минут";
const shortInterval = "Измени интервал на 10 секунд";
const disable = "Отключи итеративный режим";
const noChanges = "Карточка проверена. Изменений нет. Жду следующего срока.";
const trigger = "#status-auto-mode";
const panel = "#auto-mode-panel";
const toggle = "#auto-mode-switch";
const hint = "#iterative-goal-hint";
const rule = "#iterative-goal-rule";
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const iteration = () => readJson(iterationFile);
const goal = () => readJson(binding);
const records = () => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
let window;
let queuedCard;
let executorLaunches = 0;
let refusal = 0;
let longTurn = false;

function cli(args, input) {
  const command = ["--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"),
    "--project", project, "--json", ...args];
  if (input !== undefined) command.push("--stdin");
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, command, {
    cwd: scratch, input: input && JSON.stringify(input), encoding: "utf8", windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.ok(result.stdout, result.stderr);
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(result.status, 0, result.stderr);
  return reply.data;
}

function log(message) {
  console.log("PASS " + message);
  appendFileSync(logFile, "- " + message + "\n");
}

async function until(test, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for " + description);
}

const evaluate = (expression, target = window) => target.webContents.executeJavaScript(expression);
const read = (selector, expression, target) => evaluate("document.querySelector(" + JSON.stringify(selector) + ")" + expression, target);
const content = (selector, target) => read(selector, "?.textContent.trim()", target);
const api = (name, ...args) => evaluate("window.taskboard." + name + "(..." + JSON.stringify(args) + ")");

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

async function showPanel() {
  if (!await read(panel, ".matches(':popover-open')")) await click(trigger);
  await until(() => read(panel, ".matches(':popover-open') && getComputedStyle(document.querySelector('#auto-mode-panel')).opacity === '1'"),
    "popover paint");
  const controls = await evaluate(`[...document.querySelectorAll('#auto-mode-panel input')].map(element => ({
    id: element.id, role: element.getAttribute('role'), disabled: element.disabled,
  }))`);
  assert.deepEqual(controls, [{ id: "auto-mode-switch", role: "switch", disabled: false }]);
}

async function capture(name) {
  await showPanel();
  await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  const bytes = image.toPNG();
  assert.ok(bytes.length < 4 * 1024 * 1024);
  writeFileSync(join(artifacts, name), bytes);
}

function prepare(reopenAt) {
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  if (!restarted) {
    mkdirSync(project);
    cli(["init"], { git: false });
    cli(["settings"], { autoMode: false, reviewMode: "reviewer", taskLimits: { executor: 1, reviewer: 1 } });
    cli(["tag", "ensure"], { name: "QA", color: "#5B8DEF" });
    const draft = cli(["create"], plannedDraft({ title: "Проверить очередь без цели", tags: ["QA"] }));
    queuedCard = draft.id;
    confirmFixtureDraft(project, queuedCard);
    cli(["approve", queuedCard]);
    mkdirSync(profile);
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
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
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal", "readTaskRunHistory, replyToTask, reviewWithCodex")
    .replace("async function launchTask(", "async function originalLaunchTask(")
    .replace("const failed = (error: string) => {\n    broadcastBoardChat", "const failed = (error: string) => {\n    console.error(error);\n    broadcastBoardChat")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  assert.match(source, /async function originalLaunchTask\(/);
  assert.doesNotMatch(source, /readTaskRunHistory, replyToBoard,/);
  const fixture = [
    "const replyToBoard = (...args) => globalThis.fixtureManager(...args);",
    "const updateBoardGoal = (...args) => globalThis.fixtureControl(...args);",
    "const launchTask = (...args) => globalThis.fixtureExecutor(...args);",
    source,
  ].join("\n");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(fixture, { loader: "ts", format: "esm" }).code);
  if (reopenAt !== undefined) {
    // Keep the event loop stopped so Electron has not emitted ready when the
    // real main module registers its schemes, and the board remains closed.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(reopenAt - Date.now(), 0));
  }
  require(entry);
}

globalThis.fixtureExecutor = async (cwd, id, _revise, _newThread, revision, _continuation, _schedule,
  _resolveConflicts, _fullAccess, autoMode) => {
  assert.equal(cwd, project);
  assert.equal(id, queuedCard);
  assert.equal(autoMode, true);
  executorLaunches++;
  const started = cli(["start", id], { revision });
  return { ok: true, data: started };
};

globalThis.fixtureControl = async (_profile, cwd, thread, action) => {
  assert.equal(cwd, project);
  assert.equal(thread, goal().id);
  switch (action.kind) {
    case "pause": return { ...goal().goal, status: "paused" };
    case "resume": return { ...goal().goal, status: "active" };
    case "edit": return { ...goal().goal, objective: action.objective };
    case "clear": return null;
    default: throw new Error("Unexpected goal control " + action.kind);
  }
};

function expectFailure(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
}

function expectSuccess(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function testAuthority(action) {
  const configure = args => action("goal_configure_iteration", args);
  for (const bad of [10000.5, "10000", 0, 86400001]) {
    expectFailure(await configure({ intervalMs: bad }), "INVALID_INPUT");
  }
  expectFailure(await configure({ enabled: true, goalId: randomUUID() }), "INVALID_INPUT");
  expectFailure(await configure({ enabled: false }), "USER_DIRECTION_REQUIRED");
  expectFailure(await configure({ enabled: true, intervalMs: 10000 }), "USER_DIRECTION_REQUIRED");

  const snapshot = goal();
  try {
    writeFileSync(binding, JSON.stringify({ ...snapshot, goalId: randomUUID() }));
    const foreign = await configure({ enabled: true, intervalMs: 1500000 });
    assert.equal(foreign.ok, false, JSON.stringify(foreign));
    writeFileSync(binding, JSON.stringify({ ...snapshot, goal: { ...snapshot.goal, objective: "Другая цель" } }));
    expectFailure(await configure({ enabled: true, intervalMs: 1500000 }), "USER_DIRECTION_REQUIRED");
    writeFileSync(binding, JSON.stringify({
      ...snapshot,
      ownerObjective: "Проверяй T-0123",
      goal: { ...snapshot.goal, objective: "Проверяй T-0123" },
    }));
    expectFailure(await configure({ enabled: true, intervalMs: 1500000 }), "GOAL_CHANGED");
  } finally {
    writeFileSync(binding, JSON.stringify(snapshot));
  }
  expectSuccess(await configure({ enabled: true, intervalMs: 1500000 }));
}

globalThis.fixtureManager = async (_profile, cwd, prompt, _images, action, _tools, _instructions, _signal, session) => {
  assert.equal(cwd, project);
  const configure = args => action("goal_configure_iteration", args);
  if (session.goal) {
    assert.ok(session.mcpTools.some(tool => tool.name === "goal_configure_iteration"));
    session.save(randomUUID());
    session.onGoal({ objective: session.goal, status: "active" });
    session.onGoalSet();
    if (session.goal === objective) {
      await testAuthority(action);
      assert.equal(session.finishGoalTurn(), true);
    } else {
      for (const args of [{ enabled: true }, { enabled: false }, { intervalMs: 1500000 }]) {
        expectFailure(await configure(args), "USER_DIRECTION_REQUIRED");
      }
    }
    appendFileSync(callsFile, JSON.stringify({ reason: "manual", at: Date.now() }) + "\n");
    expectSuccess(await action("goal_report", { text: noChanges }));
    return { text: noChanges, model: "QA fixture", goalStatus: "active" };
  }
  assert.equal(session.iterativeGoal, true, "Unexpected manager turn");
  const previous = goal();
  assert.equal(session.id, previous.id);
  const context = JSON.parse(prompt.slice(prompt.indexOf("{")));
  if (refusal === 1 && context.intervalDueAt) {
    refusal = 2;
    session.onTurnStarting();
    session.onTurnRejected();
    throw new Error("Fixture: provider explicitly rejected starting the turn");
  }

  session.onTurnStarting();
  session.onGoal(previous.goal);
  assert.equal(runtimeEntries(project).filter(entry => entry.task === "manager:context").length, 1);
  appendFileSync(callsFile, JSON.stringify({
    reason: context.intervalDueAt ?? "owner",
    at: Date.now(),
    deadline: iteration().nextAt,
  }) + "\n");
  if (previous.goal.objective === shortInterval && iteration().intervalMs !== 10000) {
    expectFailure(await configure({ enabled: false, intervalMs: 10000 }), "USER_DIRECTION_REQUIRED");
    expectSuccess(await configure({ intervalMs: 10000 }));
  }
  if (previous.goal.objective === disable) {
    expectSuccess(await configure({ enabled: false }));
  }
  if (longTurn && context.intervalDueAt) {
    longTurn = false;
    await delay(11500);
  }
  expectSuccess(await action("goal_report", { text: noChanges }));
  return { text: noChanges, model: "QA fixture", goalStatus: "active" };
};

async function openBoard(target) {
  await until(async () => !target.webContents.isLoading() && await evaluate("Boolean(window.taskboard)", target), "renderer bridge");
  if (!await evaluate("Boolean(document.querySelector('#status-auto-mode:not([hidden])'))", target)) {
    await evaluate("window.taskboard.menuAction('open-project')", target);
  }
  await until(() => read(trigger, "?.checkVisibility()", target), "Auto mode button");
  assert.equal(target.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(target.webContents.getZoomFactor(), 1);
  assert.equal(await evaluate("devicePixelRatio", target), 1);
}

const contextFree = () => !runtimeEntries(project).some(entry => entry.task === "manager:context");
const countTimers = () => records().filter(record => !["manual", "owner"].includes(record.reason)).length;
const timeUntil = instant => delay(Math.max(instant - Date.now(), 0));

async function toggleAuto(enabled) {
  await showPanel();
  await click(toggle);
  await until(async () => await read(toggle, ".checked") === enabled && !await read(toggle, ".disabled"),
    "Auto mode " + enabled);
  assert.equal(cli(["settings"]).autoMode, enabled);
}

async function startGoal(text) {
  const calls = records().length;
  const result = expectSuccess(await api("boardRequest", text, [], project, true, false));
  assert.equal(result.error, undefined, JSON.stringify(result));
  await until(() => records().length === calls + 1 && contextFree(), "goal turn finished and context released");
}

function writeReport() {
  const tracked = execFileSync("git", ["ls-files", "--", "src/cli/", "src/desktop/"], {
    cwd: root, encoding: "utf8",
  }).trim().split(/\r?\n/).filter(path => !/[^\w .\/-]/.test(path));
  const paths = [
    ...tracked.filter(path => path.startsWith("src/cli/")),
    ...tracked.filter(path => path.startsWith("src/desktop/") && /\.(?:[cm]?[jt]s|css|html|json)$/.test(path)),
    "package.json", "package-lock.json", "scripts/electron-check.mjs", "scripts/check-interval-goal.mjs",
    "scripts/check-iterative-goal.mjs", "tests/fixtures/planned-draft.ts",
  ];
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const parents = execFileSync("git", ["show", "-s", "--format=%P", revision], { cwd: root, encoding: "utf8" }).trim();
  const hashes = paths.map(path => {
    const blob = revision + ":" + path;
    const storedId = execFileSync("git", ["rev-parse", blob], { cwd: root, encoding: "utf8" }).trim();
    const checkoutId = execFileSync("git", ["hash-object", "--path=" + path, "--", path], {
      cwd: root, encoding: "utf8",
    }).trim();
    assert.equal(checkoutId, storedId, "Checked source differs from Git after checkout filters: " + path);
    const bytes = execFileSync("git", ["cat-file", "blob", blob], { cwd: root });
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `- \`${digest}\` \`${path}\``;
  });
  writeFileSync(join(artifacts, "interval-goal-check.md"), [
    "# Проверка интервальной цели",
    "",
    "Windows Electron, реальный интерфейс, IPC, CLI и планировщик. Провайдер заменён фикстурой, граница запуска исполнителя фиксирует ID и вызывает штатный CLI start.",
    "",
    "Профиль: " + [process.platform, process.arch, "Electron " + process.versions.electron,
      "Chromium " + process.versions.chrome, "Node " + process.versions.node].join(", ") +
      ". Viewport 1280×800, масштаб 100%, Chromium sandbox включён.",
    "",
    readFileSync(logFile, "utf8").trimEnd(),
    "",
    "Зафиксировано ходов менеджера: " + records().length + ", из них по таймеру: " + countTimers() + ".",
    "",
    "```powershell",
    "node scripts/check-interval-goal.mjs --artifacts .tasks/qa",
    "```",
    "",
    "Коммит тестовой копии: " + revision + ". Git-дерево: " + tree + ".",
    "Родители тестового коммита: " + parents + ".",
    "SHA-256 сырых Git-блобов. Для каждого файла git hash-object с фильтрами пути подтвердил соответствие checkout блобу:",
    "",
    ...hashes,
    "",
  ].join("\n"), "utf8");
}

async function beforeRestart() {
  await showPanel();
  assert.equal(await content(hint), "Нужна активная цель");
  assert.equal(await read(toggle, ".checked"), false);
  await capture("interval-goal-no-goal.png");
  await toggleAuto(true);
  await until(() => executorLaunches === 1, "ordinary executor dispatch");
  assert.equal(cli(["show", queuedCard, "--compact"]).status, "in_progress");
  assert.equal(existsSync(binding), false);
  assert.equal(records().length, 0);
  await toggleAuto(false);
  assert.equal(executorLaunches, 1);
  log("Без цели единственный тумблер включил и выключил авторежим, доска передала в запуск одну готовую карточку. Ходов менеджера 0, привязки цели нет.");

  await startGoal("Проверяй T-0123 каждые 25 минут.");
  expectSuccess(await api("boardGoal", "clear"));
  await startGoal("«Включи итеративный режим»");
  expectSuccess(await api("boardGoal", "clear"));
  const htmlQuote = ["<blockquote>", "Включи итеративный режим", "", "Измени интервал на 25 минут", "</blockquote>"];
  await startGoal(htmlQuote.join("\n"));
  assert.equal(existsSync(iterationFile), false);
  expectSuccess(await api("boardGoal", "clear"));
  await startGoal("- > Пример\n  Включи итеративный режим");
  assert.equal(existsSync(iterationFile), false);
  expectSuccess(await api("boardGoal", "clear"));
  await startGoal(objective);
  assert.equal(iteration().enabled, true);
  assert.equal(iteration().intervalMs, 1500000);
  log("Инструмент отклонил все три действия при неявной формулировке, обычной цитате, многострочном HTML-блоке и продолжении Markdown-цитаты внутри списка. Отдельно отклонены недействительные числа, чужой ID и изменившийся текст. Точное поручение сохранило режим и 25 минут.");

  await showPanel();
  await until(async () => (await content(rule)).includes("25 минут") && (await content(hint)).includes("Авторежим выключен"), "saved rule with Auto mode off");
  await capture("interval-goal-auto-off.png");
  await toggleAuto(true);
  await until(async () => (await content(hint)).startsWith("Следующий запуск в"), "scheduled waiting");
  await capture("interval-goal-panel.png");
  const calls = records().length;
  await delay(2200);
  assert.equal(records().length, calls);
  assert.ok(contextFree());
  log("Панель показывает сохранённые 25 минут и срок. После короткого хода без изменений контекст свободен, между событиями вызовов нет.");

  expectSuccess(await api("boardGoal", "edit", shortInterval));
  sendGoalMessage(project, goal().goalId, "Посмотри обновлённый текст цели.");
  await until(() => iteration().intervalMs === 10000 && contextFree(), "updated interval via addressed turn");
  assert.equal(records().at(-1).reason, "owner");
  assert.equal(iteration().enabled, true);

  expectSuccess(await api("boardGoal", "pause"));
  await showPanel();
  await until(async () => (await content(hint)).includes("ручной паузе"), "manual pause");
  await capture("interval-goal-paused.png");
  const paused = countTimers();
  await timeUntil(iteration().nextAt + 300);
  assert.equal(countTimers(), paused);
  const resumedAt = Date.now();
  expectSuccess(await api("boardGoal", "resume", shortInterval));
  assert.ok(iteration().nextAt >= resumedAt + 10000);
  log("Ручная пауза переждала срок без запуска. Возобновление начинает полные 10 секунд.");

  await toggleAuto(false);
  await timeUntil(iteration().nextAt + 300);
  assert.equal(countTimers(), paused);
  const switchedAt = Date.now();
  refusal = 1;
  longTurn = true;
  await toggleAuto(true);
  const effective = cli(["settings"]).autoModeEnabledAt + 10000;
  assert.ok(effective >= switchedAt + 10000);
  await showPanel();
  await until(async () => (await content(hint)).startsWith("Следующий запуск в"), "full interval after enabling Auto mode");
  log("Выключенный авторежим переждал срок. Повторное включение устанавливает новый ближайший срок через 10 секунд.");

  await api("menuAction", "new-window");
  const second = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate !== window), "second window");
  await openBoard(second);
  await until(() => refusal === 2 && Number.isFinite(iteration().retryAt),
    "persisted provider refusal").catch(async error => {
    const frame = await api("bootstrap");
    console.error("Timer state at timeout", JSON.stringify({
      refusal, settings: frame.board.settings, goal: frame.goalIteration,
      launches: records(), contextFree: contextFree(),
    }));
    throw error;
  });
  await showPanel();
  await until(async () => (await content(hint)).includes("Не удалось запустить ход"), "temporary refusal in panel");
  assert.equal(countTimers(), paused);
  const retryAt = iteration().retryAt;
  await until(() => countTimers() === paused + 1, "timer retry");
  const retry = records().at(-1);
  assert.ok(retry.at >= retryAt);
  assert.equal(Date.parse(retry.reason), effective);
  assert.equal((retry.deadline - effective) % 10000, 0);
  await delay(10200);
  assert.equal(countTimers(), paused + 1);
  assert.equal(runtimeEntries(project).filter(entry => entry.task === "manager:context").length, 1);
  await until(() => countTimers() === paused + 2 && contextFree(), "one catch-up after long turn in two windows");
  log("Провайдер отклонил запуск, панель показала повтор, затем запустился один ход с исходной фазой. Долгий ход пересёк срок с двумя окнами, контекст остался единичным. По освобождении состоялся один догоняющий ход.");
  writeFileSync(join(scratch, "restart.json"), JSON.stringify({
    turns: records().length,
    deadline: iteration().nextAt,
  }));
}

async function afterRestart(saved) {
  await until(() => records().length > saved.turns && contextFree(), "catch-up and release after restart").catch(async error => {
    const frame = await api("bootstrap");
    const { goalIteration, quotaWait } = frame;
    console.error("Restart state at timeout", JSON.stringify({ saved, goalIteration, quotaWait, records: records(), contextFree: contextFree() }));
    throw error;
  });
  const restartedTurns = records().slice(saved.turns);
  const [catchUp, ...subsequent] = restartedTurns;
  assert.equal(Date.parse(catchUp.reason), saved.deadline);
  assert.equal((catchUp.deadline - saved.deadline) % 10000, 0);
  for (const [index, turn] of subsequent.entries()) {
    assert.ok(Date.parse(turn.reason) >= restartedTurns[index].deadline, "A missed launch was duplicated.");
  }
  log("Между процессами пропущены не менее двух сроков. После перезапуска доска сделала один догоняющий ход с сохранённой фазой.");
  const previous = goal();
  expectSuccess(await api("boardGoal", "edit", disable));
  sendGoalMessage(project, previous.goalId, "Выполни явное изменение из текста цели.");
  await until(() => iteration().enabled === false && contextFree(), "disabled iteration via tool");
  const calls = records().length;
  await timeUntil(iteration().nextAt + 600);
  assert.equal(records().length, calls);
  assert.equal(goal().goalId, previous.goalId);
  assert.equal(goal().id, previous.id);
  assert.equal(goal().goal.objective, disable);
  await showPanel();
  await until(async () => (await content(rule)).includes("Выключен") && (await content(hint)).includes("вручную"), "disabled goal state");
  const history = await api("boardHistory", project, null, "work");
  assert.match(JSON.stringify(history), new RegExp(noChanges));
  log("Явная команда отключила режим. Следующий срок прошёл без новых вызовов. Цель, чат и отчёты сохранились.");
  writeReport();
}

async function run() {
  const saved = restarted ? readJson(join(scratch, "restart.json")) : undefined;
  prepare(saved ? saved.deadline + 10100 : undefined);
  await app.whenReady();
  window = await until(() => BrowserWindow.getAllWindows()[0], "startup window");
  window.setContentSize(1280, 800);
  await openBoard(window);
  if (saved) await afterRestart(saved);
  else await beforeRestart();
}

void run().then(
  () => app.exit(0),
  error => {
    console.error(error);
    app.exit(1);
  },
);
