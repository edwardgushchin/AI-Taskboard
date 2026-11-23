import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "project-rules", 90_000, [["settings"], ["restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "project");
const agents = join(project, "AGENTS.md");
const report = join(artifacts, "report.txt");
const restart = process.argv.at(-1) === "restart";
const preamble = "# Правила проекта\n\nОбщее пояснение для списка.";
const first = [
  "- Сверяйте [справку](docs/guide.md).",
  "  - Сохраняйте вложенное пояснение.",
  "",
  "  ```sh",
  "  npm test",
  "  ```",
].join("\n");
const second = "- Проверяйте ссылки перед сдачей.";
const third = "- Указывайте версию в отчёте.";
const original = [preamble, "", first, second, third, ""].join("\n").replaceAll("\n", "\r\n");
const temporary = "Временное правило для проверки";
const rule = (text, enabled = true) => ({ text, enabled });
const importedOrder = [rule(preamble), rule(first), rule(second), rule(third)];
const publishedOrder = [rule(preamble), rule(third), rule(first), rule(second, false)];
const form = "#sheet-body form:has(> fieldset > [role=list])";
const rows = form + " .board-queued-row";

mkdirSync(join(scratch, "profile"), { recursive: true });
mkdirSync(join(scratch, "app-data"), { recursive: true });
mkdirSync(join(scratch, "codex"), { recursive: true });
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
process.env.CODEX_HOME = join(scratch, "codex");
process.env.GIT_CEILING_DIRECTORIES = scratch;
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
if (restart) process.argv.push("--project", project);

function log(line) {
  appendFileSync(report, line + "\n");
  console.log(line);
}

async function waitFor(probe, label) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const result = await probe();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}

const evaluate = (window, js) => window.webContents.executeJavaScript(js);
const click = (window, selector) =>
  evaluate(window, "document.querySelector(" + JSON.stringify(selector) + ").click()");
const rules = window => evaluate(window, `Array.from(document.querySelectorAll(${JSON.stringify(rows)}), row => ({
  text: row.querySelector("textarea").value.trimEnd(),
  enabled: row.querySelector("input[type=checkbox]").checked,
}))`);

function assertPublishedRules(text, expected) {
  const published = text.replaceAll("\r\n", "\n");
  assert.equal(published.split(preamble).length, 2);
  let position = published.indexOf(preamble) + preamble.length;
  for (const item of expected.slice(1)) {
    const next = published.indexOf(item.text);
    if (!item.enabled) {
      assert.equal(next, -1);
      continue;
    }
    assert.ok(next >= position, "Published rule is missing or out of order: " + item.text);
    position = next + item.text.length;
  }
}

async function openSettings(window) {
  await waitFor(() => !window.webContents.isLoading() && evaluate(window,
    "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)"), "board");
  await click(window, "#app-settings");
  await click(window, "#board-settings-menu-item");
  await waitFor(() => evaluate(window,
    `document.querySelector(${JSON.stringify(form + " fieldset")})?.disabled === false`), "project rules form");
}

async function save(window, expected) {
  await click(window, form + " > button");
  return waitFor(async () => {
    const status = await evaluate(window, `(() => {
      const form = document.querySelector(${JSON.stringify(form)});
      if (!form?.querySelector(":scope > button").disabled) return form?.querySelector("[role=status]").textContent;
    })()`);
    return expected.test(status ?? "") && status;
  }, "rule save status " + expected);
}

async function capture(window, name) {
  await evaluate(window, `document.fonts.ready.then(() =>
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
  const screenshot = await window.webContents.capturePage();
  assert.deepEqual(screenshot.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name), screenshot.toPNG());
}

async function preventRulesWrite(check) {
  if (process.platform !== "win32") {
    const sidecar = join(project, ".tasks", "project-rules.json");
    renameSync(sidecar, sidecar + ".backup");
    mkdirSync(sidecar);
    try {
      await check(/regular file|INVALID_STORAGE_PATH/i);
    } finally {
      rmdirSync(sidecar);
      renameSync(sidecar + ".backup", sidecar);
    }
    return;
  }
  const command = `
    $ErrorActionPreference = 'Stop'
    $handle = [IO.File]::Open($env:TASKBOARD_RULES_FIXTURE, 'Open', 'Read', 'ReadWrite')
    try {
      [Console]::WriteLine('locked')
      [void][Console]::ReadLine()
    } finally {
      $handle.Dispose()
    }
  `;
  const child = spawn("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    env: { ...process.env, TASKBOARD_RULES_FIXTURE: agents },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  try {
    const acquired = once(child.stdout, "data").then(([chunk]) => chunk.toString().trim() === "locked");
    assert.equal(await Promise.race([acquired, exited.then(() => false)]), true);
    await check(/EPERM|EACCES|EBUSY|permission denied|resource busy/i);
  } finally {
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  }
}

async function drag(window, from, to) {
  window.focus();
  window.webContents.focus();
  const [source, target] = await evaluate(window, `(() => {
    const rows = document.querySelectorAll(${JSON.stringify(rows)});
    const from = rows[${from}].querySelector(".board-queue-handle").getBoundingClientRect();
    const to = rows[${to}].getBoundingClientRect();
    return [{ x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + to.height / 4 }];
  })()`);
  assert.equal(await evaluate(window, `Boolean(document.elementFromPoint(${source.x}, ${source.y})?.closest(".board-queue-handle[draggable=true]"))`), true);
  const debug = window.webContents.debugger;
  debug.attach("1.3");
  const intercepted = Promise.withResolvers();
  const receive = (_event, method, params) => {
    if (method === "Input.dragIntercepted") intercepted.resolve(params.data);
  };
  debug.on("message", receive);
  try {
    const send = (method, params) => debug.sendCommand("Input." + method, params);
    await send("setInterceptDrags", { enabled: true });
    await send("dispatchMouseEvent", { type: "mousePressed", ...source, button: "left", buttons: 1, clickCount: 1 });
    await send("dispatchMouseEvent", { type: "mouseMoved", x: source.x + 12, y: source.y, button: "left", buttons: 1 });
    await send("dispatchMouseEvent", { type: "mouseMoved", ...target, button: "left", buttons: 1 });
    const data = await waitFor(() => Promise.race([intercepted.promise, delay(50)]), "native drag");
    await send("dispatchDragEvent", { type: "dragEnter", ...target, data });
    await send("dispatchDragEvent", { type: "dragOver", ...target, data });
    assert.equal(await evaluate(window, `document.querySelectorAll(${JSON.stringify(rows)})[${to}].dataset.queueDrop`), "before");
    await send("dispatchDragEvent", { type: "drop", ...target, data });
  } finally {
    debug.removeListener("message", receive);
    debug.detach();
  }
}

function startApp() {
  process.on("unhandledRejection", error => console.error(error));
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source +
    "\nglobalThis.openTestWindow = project => createWindow([project]).window;", { loader: "ts", format: "esm" }).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
}

async function run() {
  if (!restart) {
    mkdirSync(project);
    writeFileSync(agents, original);
    writeFileSync(report, "");
    log("Команда: node scripts/check-project-rules.mjs --artifacts .tasks/qa/T-0341");
    const node = execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
    log(`Node ${node}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform}/${process.arch}.`);
    const root = fileURLToPath(new URL("..", import.meta.url));
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    log("Git HEAD до сдачи: " + base + ". SHA-256 байтов рабочих файлов:");
    for (const path of [
      "src/cli/board-agents.ts", "src/cli/storage.ts", "src/desktop/main.ts", "src/desktop/preload.cjs",
      "src/desktop/renderer.js", "src/desktop/styles.css", "src/desktop/locales/en.json", "src/desktop/locales/ru.json",
      "scripts/check-project-rules.mjs", "scripts/electron-check.mjs",
    ]) {
      log(createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path);
    }
  }

  startApp();
  const window = await waitFor(() => BrowserWindow.getAllWindows()[0], "main window");
  window.setContentSize(1280, 800);
  if (restart) {
    await openSettings(window);
    assert.deepEqual(await rules(window), publishedOrder);
    assertPublishedRules(readFileSync(agents, "utf8"), publishedOrder);
    log("Второй процесс Electron восстановил порядок и выключенное правило.");
    return;
  }

  await waitFor(() => evaluate(window, "document.querySelector('#welcome')?.hidden === false"), "welcome");
  await click(window, "#welcome-create");
  await click(window, "[data-board-type=agent]");
  await openSettings(window);
  assert.deepEqual(await rules(window), importedOrder);
  const initialized = readFileSync(agents, "utf8");
  assert.equal(initialized.split(original).length, 2);
  assert.match(initialized, /AI Taskboard workflow/);
  await capture(window, "imported.png");
  log("Создание агентной доски показало общий заголовок с пояснением и три самостоятельных пункта. Исходный CRLF, ссылка, вложенный список и блок кода сохранились в AGENTS.md.");

  await click(window, form + " fieldset > button");
  await evaluate(window, `Array.from(document.querySelectorAll(${JSON.stringify(rows + " textarea")})).at(-1).value = ${JSON.stringify(temporary)}`);
  const success = /Правила сохранены|Rules saved/;
  await save(window, success);
  assert.ok(readFileSync(agents, "utf8").includes(temporary));
  const mirror = globalThis.openTestWindow(project);
  await openSettings(mirror);
  assert.equal((await rules(mirror)).at(-1).text, temporary);

  const secondCheckbox = rows + ":nth-child(3) input[type=checkbox]";
  await click(window, secondCheckbox);
  await save(window, success);
  assertPublishedRules(readFileSync(agents, "utf8"), [
    rule(preamble), rule(first), rule(second, false), rule(third), rule(temporary),
  ]);
  await save(mirror, /изменился|has changed/i);
  assert.ok((await evaluate(mirror, `document.querySelector(${JSON.stringify(form + " textarea[readonly]")}).value`)).includes("[ ] " + second));
  assert.deepEqual(await rules(mirror), [...importedOrder, rule(temporary)]);
  assert.ok(!readFileSync(agents, "utf8").includes(second));
  await click(window, secondCheckbox);
  await save(window, success);
  assert.deepEqual(await rules(window), [...importedOrder, rule(temporary)]);
  assertPublishedRules(readFileSync(agents, "utf8"), [...importedOrder, rule(temporary)]);
  await click(window, secondCheckbox);
  await click(window, rows + ":last-child button:last-child");
  assert.equal((await rules(window)).length, 4);
  log("Добавление и удаление проверены в форме. Выключение и включение пункта сохранили заголовок, пояснение и вложенный Markdown. Второе окно показало конфликт и сохранило черновик.");

  await drag(window, 3, 1);
  assert.deepEqual(await rules(window), publishedOrder);
  const grip = rows + ":nth-child(4) .board-queue-handle";
  await evaluate(window, `document.querySelector(${JSON.stringify(grip)}).focus()`);
  const debug = window.webContents.debugger;
  debug.attach("1.3");
  try {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
      await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
      const expected = key === "ArrowUp"
        ? [rule(preamble), rule(third), rule(second, false), rule(first)]
        : publishedOrder;
      assert.deepEqual(await rules(window), expected);
    }
  } finally {
    debug.detach();
  }
  const beforeFailure = readFileSync(agents, "utf8");
  const beforeFailedSave = await evaluate(window, "window.taskboard.bootstrap().then(frame => window.taskboard.projectRules(frame.project))");
  await preventRulesWrite(async expected => {
    await save(window, expected);
    assert.equal(readFileSync(agents, "utf8"), beforeFailure);
    const afterFailedSave = await evaluate(window, "window.taskboard.bootstrap().then(frame => window.taskboard.projectRules(frame.project))");
    if (process.platform === "win32") assert.deepEqual(afterFailedSave, beforeFailedSave);
    assert.deepEqual(await rules(window), publishedOrder);
  });
  await save(window, success);
  const final = readFileSync(agents, "utf8");
  assert.match(final, /AI Taskboard workflow/);
  assertPublishedRules(final, [...publishedOrder, rule(temporary, false)]);
  await capture(window, "reordered.png");
  await click(window, "#close-sheet");
  await openSettings(window);
  assert.deepEqual(await rules(window), publishedOrder);
  log("Ручка и стрелки переставили включённое и выключенное правила. Ошибка записи сохранила файл и черновик. Повторная запись и открытие восстановили список в новом порядке.");
}

void run().then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
});
