// Real main process, private profile and empty boards: never touches a user's queue.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "auto-mode", 120_000);
void (async () => {
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
process.env.GIT_CEILING_DIRECTORIES = scratch;
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("lang", "ru");
symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
const boards = [join(scratch, "first"), join(scratch, "second")];
const cli = (project, args, input) => {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project,
    "--json", ...args, ...(input ? ["--stdin"] : []),
  ], { cwd: scratch, encoding: "utf8", windowsHide: true, input: input && JSON.stringify(input),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const wait = async (predicate) => {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error("UI wait timed out");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
let chosen;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
let window;
try {
  for (const board of boards) {
    mkdirSync(board);
    cli(board, ["init"], { git: false });
  }
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm" }).code);
  require(entry);
  await wait(() => BrowserWindow.getAllWindows().length === 1);
  window = BrowserWindow.getAllWindows()[0];
  const evaluate = code => window.webContents.executeJavaScript(code);
  await wait(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"));
  const open = async board => {
    chosen = board;
    await evaluate("window.taskboard.menuAction('open-project')");
    await wait(() => evaluate("window.taskboard.bootstrap().then(f => !f.loading && Boolean(f.board))"));
  };
  const enabled = () => evaluate("document.querySelector('#status-auto-mode').getAttribute('aria-pressed')");
  await open(boards[0]);
  assert.equal(await enabled(), "false");
  // Native mouse/keyboard input goes through the existing renderer listener and IPC.
  const click = async () => {
    const point = await evaluate(`(() => { const r = document.querySelector('#status-auto-mode').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
    for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point });
  };
  await click();
  await wait(async () => await enabled() === "true");
  assert.equal(cli(boards[0], ["list"]).settings.autoMode, true);
  await open(boards[1]);
  assert.equal(await enabled(), "false");
  assert.equal(cli(boards[1], ["list"]).settings.autoMode === true, false);
  await wait(() => evaluate("!document.querySelector('#status-auto-mode').disabled"));
  window.focus();
  window.webContents.focus();
  await evaluate("document.querySelector('#status-auto-mode').focus()");
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: " " });
  await wait(async () => await enabled() === "true");
  await wait(() => evaluate("!document.querySelector('#status-auto-mode').disabled"));
  await evaluate("document.querySelector('#status-auto-mode').focus()");
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Return" });
  await wait(async () => await enabled() === "false");
  assert.equal(cli(boards[0], ["list"]).settings.autoMode, true);
  assert.equal(cli(boards[1], ["list"]).settings.autoMode === true, false);
  await evaluate("location.reload()");
  await wait(() => evaluate("Boolean(window.taskboard && !document.querySelector('#status-auto-mode').hidden)"));
  assert.equal(await enabled(), "false");
  await evaluate("window.taskboard.selectTab(" + JSON.stringify(boards[0]) + ")");
  await wait(async () => await enabled() === "true");
  const results = [];
  // Git presentations are renderer fixtures; settings and activation above use real empty boards.
  for (const theme of ["light", "dark"]) for (const width of [1200, 800]) for (const zoom of [1, 1.25, 1.5]) {
    window.setSize(width, 700);
    window.webContents.setZoomFactor(zoom);
    await evaluate("window.taskboard.setTheme(" + JSON.stringify(theme) + ")");
    for (const git of ["publish", "tracking", "branch", "hidden"]) for (const on of [false, true]) {
      await evaluate(`(() => {
        const auto = document.querySelector('#status-auto-mode');
        auto.setAttribute('aria-pressed', '${on}');
        auto.querySelector('span').textContent = ${JSON.stringify(on ? "Авторежим: вкл." : "Авторежим: выкл.")};
        document.querySelector('#status-branch').hidden = ${git === "hidden"};
        document.querySelector('#status-branch span').textContent = 'main';
        document.querySelector('#status-publish').hidden = ${git !== "publish"};
        document.querySelector('#status-tracking').hidden = ${git !== "tracking"};
        document.querySelector('#status-tracking span').textContent = '0↓ 1↑';
      })()`);
      await evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
      const result = await evaluate(`(() => {
        const b = document.querySelector('#status-auto-mode'), i = b.querySelector('i');
        const r = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
        const before = [...b.parentElement.children].filter(x => !x.hidden && x !== b).at(-1);
        return { content: getComputedStyle(i, '::before').content, font: getComputedStyle(i).fontFamily,
          width: ir.width, height: ir.height, left: r.left, right: r.right, viewport: innerWidth,
          previousRight: before?.getBoundingClientRect().right, parent: b.parentElement.className,
          hit: b.contains(document.elementFromPoint(ir.x+8, ir.y+8)), label: b.textContent.trim() };
      })()`);
      assert.equal(result.content, '"\ueb2c"');
      assert.match(result.font, /codicon/);
      assert.equal(result.parent, "status-repository");
      assert.ok(result.width >= 16 && result.height >= 16 && result.hit);
      assert.ok(result.left >= 0 && result.right <= result.viewport);
      if (result.previousRight) assert.ok(Math.abs(result.left - result.previousRight) <= 1);
      assert.ok(result.label.length > 0);
      results.push({ theme, width, zoom, git, on, ...result });
      if (width === 800 && git === "publish") writeFileSync(join(artifacts, `auto-${theme}-${zoom}-${on}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  writeFileSync(join(artifacts, "auto-mode.json"), JSON.stringify({ versions: process.versions, scenarios: results.length,
    activation: "mouse, Space, Enter; board isolation; renderer reload and fresh CLI reads passed", results }, null, 2));
  console.log(`PASS: ${results.length} visual scenarios; mouse/Space/Enter, board isolation and reload; empty isolated boards only`);
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }
})();

