// Exercise the production renderer, IPC and history with deterministic provider events.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const restart = process.argv.includes("--restart");
const { scratch, artifacts } = electronCheck(import.meta.url, "manager-viewed-images", 100_000, [[], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, nativeImage } = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
const board = join(scratch, "board");
const otherBoard = join(scratch, "other-board");
const first = "docs/images/board.png";
const second = "docs/images/board-small.png";
const missing = "docs/images/removed.png";
const unconfirmed = "docs/images/unconfirmed.png";
const dialogue = ".board-chat-log:not(.board-work)";
const work = ".board-work";
const report = join(artifacts, "manager-image-check.txt");
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let selectedBoard = board;
let finish;
let window;

app.setPath("userData", join(scratch, restart ? "restart-profile" : "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("lang", "ru");

function cli(project, args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project,
    "--json", ...args, "--stdin",
  ], { encoding: "utf8", windowsHide: true, input: JSON.stringify(input),
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } }));
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function waitFor(description, predicate) {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "Timed out: " + description);
    await delay(50);
  }
}

const evaluate = code => window.webContents.executeJavaScript(code, true);
const preview = path => evaluate(`window.taskboard.runImagePreview(undefined, ${JSON.stringify(path)})`);
const tile = (feed, lane, index) => feed + ' [data-item="item:' + lane + '-view-' + index + '"] [data-path]';
const shown = "Boolean(document.querySelector('.image-preview[open] img')?.naturalWidth)";
const position = "document.querySelector('.image-preview[open] header output')?.value";

async function reveal(selector, loaded = true) {
  const query = JSON.stringify(selector);
  await waitFor(selector, () => evaluate(`(() => {
    const tile = document.querySelector(${query});
    if (!tile) return false;
    for (let parent = tile.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches('details')) parent.open = true;
    }
    tile.scrollIntoView({ block: 'center', behavior: 'instant' });
    return ${loaded ? "Boolean(tile.querySelector('img')?.naturalWidth)" : "tile.textContent.includes('Изображение недоступно')"};
  })()`));
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  for (const type of ["mouseDown", "mouseUp"]) {
    window.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
  }
}

function key(keyCode) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
}

async function capture(name) {
  await evaluate("document.fonts.ready");
  await delay(200);
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 900 });
  writeFileSync(join(artifacts, name), image.toPNG());
}

async function openBoard(project) {
  selectedBoard = project;
  await evaluate("window.taskboard.menuAction('open-project')");
  await waitFor("board is loaded", () => evaluate(`window.taskboard.bootstrap().then(frame =>
    frame.board?.project === ${JSON.stringify(project)} && !frame.loading)`));
}

async function startTurn(goal) {
  const prompt = goal ? "Проверь снимки для отчёта" : "Посмотри снимки доски";
  await evaluate(`window.imageCheckPending = window.taskboard.boardRequest(
    ${JSON.stringify(prompt)}, [], ${JSON.stringify(board)}, ${goal}, false); void 0`);
  await waitFor("provider has published actions", () => Boolean(finish));
}

async function finishTurn() {
  finish.resolve();
  finish = undefined;
  const reply = await evaluate("window.imageCheckPending");
  assert.equal(reply.ok, true, JSON.stringify(reply));
}

async function showWork() {
  await waitFor("work tab", () => evaluate("!document.querySelector('.board-chat-views').hidden"));
  await evaluate("document.querySelector('.board-work-toggle').click()");
}

async function checkSeries(feed, lane, screenshot) {
  const firstTile = tile(feed, lane, 1);
  await reveal(firstTile);
  if (screenshot && lane === "dialogue") await capture(screenshot);
  if (lane === "dialogue") {
    await click(firstTile);
  } else {
    await evaluate(`document.querySelector(${JSON.stringify(firstTile)}).focus()`);
    key("Enter");
  }
  await waitFor("first image in the common viewer", () => evaluate(shown));
  assert.equal(await evaluate(position), "1 / 3");
  if (screenshot && lane === "work") await capture(screenshot);
  const firstSrc = await evaluate("document.querySelector('.image-preview[open] img').src");
  key("Right");
  await waitFor("second distinct image in event order", () => evaluate(`(${position}) === '2 / 3' &&
    document.querySelector('.image-preview[open] img')?.naturalWidth &&
    document.querySelector('.image-preview[open] img').src !== ${JSON.stringify(firstSrc)}`));
  key("Escape");
  await waitFor("viewer closed", () => evaluate("!document.querySelector('.image-preview[open]')"));
  assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(firstTile)})`), true);
  await reveal(tile(feed, lane, 2));
}

async function check() {
  if (!restart) {
    const smallImage = nativeImage.createFromPath(join(root, first)).resize({ width: 320 }).toPNG();
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    for (const project of [board, otherBoard]) {
      mkdirSync(join(project, "docs/images"), { recursive: true });
      cli(project, ["init"], { git: false });
      cli(project, ["settings"], { autoMode: false });
      copyFileSync(join(root, first), join(project, first));
      copyFileSync(join(root, first), join(project, unconfirmed));
      writeFileSync(join(project, second), smallImage);
      writeFileSync(join(project, missing), smallImage);
    }
  } else {
    unlinkSync(join(board, missing));
  }
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedBoard] });
  globalThis.managerViewedImageProvider = async (_profile, _project, _prompt, _images, _action, _tools, _instructions, _signal, session) => {
    const lane = session.goal ? "work" : "dialogue";
    const at = new Date().toISOString();
    const add = (id, item) => ({ id: lane + "-" + id, title: "", text: "", at,
      providerTurnId: lane, status: "completed", ...item });
    session.save(randomUUID());
    session.onControl({ steer: async () => {}, interrupt: async () => {} }, "fixture");
    if (session.goal) {
      session.onGoalSet();
      session.onGoal({ objective: session.goal, status: "active" });
    }
    finish = Promise.withResolvers();
    session.onActivity([
      add("command", { type: "commandExecution", title: "git status", text: "Файлы готовы к просмотру." }),
      ...[first, join(board, second), missing].map((path, index) => add("view-" + (index + 1), {
        type: "imageView", title: "view_image", text: JSON.stringify({ path, at }),
      })),
      add("pending", { type: "imageView", title: "view_image", status: "inProgress", text: JSON.stringify({ path: unconfirmed }) }),
      add("answer", { type: "agentMessage", phase: "final_answer", text: "Снимки просмотрены." }),
    ]);
    await finish.promise;
    session.onTurnEnded();
    if (session.goal) session.onGoal({ objective: session.goal, status: "complete" });
    return { text: "Снимки просмотрены.", model: "fixture", goalStatus: session.goal ? "complete" : undefined };
  };
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("release.run(() => replyToBoard(", "release.run(() => globalThis.managerViewedImageProvider(")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code);
  require(entry);
  await waitFor("Electron window", () => BrowserWindow.getAllWindows().length === 1);
  window = BrowserWindow.getAllWindows()[0];
  window.setContentSize(1280, 900);
  window.webContents.setBackgroundThrottling(false);
  window.show();
  window.focus();
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  await waitFor("preload", () => evaluate("Boolean(window.taskboard)"));
  await evaluate("window.taskboard.setLanguage('ru')");
  await openBoard(board);
  await evaluate("document.querySelector('#board-composer .board-draft-field').click()");
  await evaluate("document.querySelector('.board-chat-pin').click()");
  await evaluate(`(async () => {
    for (let index = 0; index < 12; index++) {
      document.querySelector('.board-chat-resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  })()`);
  if (!restart) {
    assert.equal(await preview(first), null, "file exists before any viewed event");
    await startTurn(false);
  }
  await checkSeries(dialogue, "dialogue", restart ? "manager-image-dialogue.png" : undefined);
  assert.equal(await preview(unconfirmed), null, "unfinished viewing is not a grant");
  assert.equal(await preview(join(board, first)), null, "unrecorded spelling is not a grant");
  assert.equal(await preview(first), "data:image/png;base64," + readFileSync(join(board, first), "base64"));
  if (!restart) {
    await finishTurn();
    await startTurn(true);
  }
  await showWork();
  await checkSeries(work, "work", restart ? undefined : "manager-image-work.png");
  if (restart) {
    await reveal(tile(work, "work", 3), false);
    assert.equal(await preview(missing), null);
    await evaluate(`document.querySelector('${work} [data-item="item:work-command"] summary').click()`);
    assert.equal(await evaluate(`document.querySelector('${work} [data-item="item:work-command"] .chat-run-output').checkVisibility()`), true);
    results.push("PASS removed file shows unavailable state; other images and actions remain accessible after restart");
  } else {
    await finishTurn();
  }
  await evaluate("document.querySelector('.board-dialogue-toggle').click()");
  await reveal(tile(dialogue, "dialogue", 1));
  await openBoard(otherBoard);
  assert.equal(await preview(first), null, "completed event in the previous board does not grant read");
  results.push("PASS unconfirmed path, unfinished action and event from another board are denied by IPC");
  results.push(restart
    ? "PASS fresh process and profile restore dialogue and work thumbnails in event order"
    : "PASS dialogue click, work Enter, and arrow navigation in live feeds before provider completion");
  console.log(results.join("\n"));
}

void check().then(() => {
  if (!restart) {
    const paths = [
      "scripts/check-manager-viewed-images.mjs", "scripts/electron-check.mjs",
      "src/desktop/chat.js", "src/desktop/main.ts", "src/desktop/manager-history.ts",
      "src/desktop/run-images.ts", "src/desktop/codex-chat.ts", "src/desktop/image-preview.js",
      "src/desktop/renderer.js", "src/desktop/preload.cjs", first,
    ];
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    writeFileSync(report, [
      `${process.platform} Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}; 1280x900; sandbox/contextIsolation enabled`,
      "Command: node scripts/check-manager-viewed-images.mjs --artifacts .tasks/qa",
      "Real renderer, history and IPC; deterministic provider substitute. Linux and macOS runtime not exercised.",
      "Tested working snapshot at Git base " + base,
      "SHA-256 of working source bytes:",
      ...paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path),
      "",
    ].join("\n"));
  }
  appendFileSync(report, results.join("\n") + "\n");
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
