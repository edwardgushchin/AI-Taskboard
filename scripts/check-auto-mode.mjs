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
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
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
  const checkIcon = async on => assert.equal(await evaluate("document.querySelector('#status-auto-mode i').className"),
    `icon codicon codicon-${on ? "sync" : "play"}`);
  await open(boards[0]);
  assert.equal(await enabled(), "false");
  await checkIcon(false);
  // Native mouse/keyboard input goes through the existing renderer listener and IPC.
  const click = async () => {
    const point = await evaluate(`(() => { const r = document.querySelector('#status-auto-mode').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
    for (const type of ["mouseDown", "mouseUp"]) window.webContents.sendInputEvent({ type, button: "left", clickCount: 1, ...point });
  };
  await click();
  await wait(async () => await enabled() === "true");
  await checkIcon(true);
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
  await checkIcon(true);
  await wait(() => evaluate("!document.querySelector('#status-auto-mode').disabled"));
  await evaluate("document.querySelector('#status-auto-mode').focus()");
  for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Return" });
  await wait(async () => await enabled() === "false");
  await checkIcon(false);
  assert.equal(cli(boards[0], ["list"]).settings.autoMode, true);
  assert.equal(cli(boards[1], ["list"]).settings.autoMode === true, false);
  await evaluate("location.reload()");
  await wait(() => evaluate("Boolean(window.taskboard && !document.querySelector('#status-auto-mode').hidden)"));
  assert.equal(await enabled(), "false");
  await evaluate("window.taskboard.selectTab(" + JSON.stringify(boards[0]) + ")");
  await wait(async () => await enabled() === "true");
  await checkIcon(true);
  const results = [];
  window.webContents.debugger.attach("1.3");
  const paint = () => evaluate("document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
  const move = async selector => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
    point.x = Math.round(point.x * window.webContents.getZoomFactor());
    point.y = Math.round(point.y * window.webContents.getZoomFactor());
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    await paint();
  };
  const gitStyle = () => evaluate(`(() => { const g = document.querySelector('.status-repository'), s = getComputedStyle(g); return [s.backgroundColor, s.borderTopColor]; })()`);
  await evaluate("document.querySelector('#status-branch').hidden = false");
  for (const [button, panel] of [["#status-branch", "#git-branches"], ["#status-limits", "#provider-limits"]]) {
    await move(button);
    assert.equal(await evaluate(`document.querySelector('${button}').matches(':hover')`), true);
    window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 100 });
    await evaluate(`document.querySelector('${button}').focus()`);
    for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Return" });
    await wait(() => evaluate(`document.querySelector('${panel}').matches(':popover-open')`));
    await evaluate(`document.querySelector('${panel}').hidePopover()`);
  }
  // Git presentations are renderer fixtures; settings and activation above use real empty boards.
  for (const motion of ["no-preference", "reduce"]) {
  await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: motion }],
  });
  for (const theme of ["light", "dark"]) for (const width of [1200, 800]) for (const zoom of [1, 1.25, 1.5]) {
    console.log(`Checking auto mode: ${motion}/${theme}/${width}/${zoom}`);
    window.setSize(width, 700);
    window.webContents.setZoomFactor(zoom);
    await evaluate("window.taskboard.setTheme(" + JSON.stringify(theme) + ")");
    for (const git of ["publish", "tracking", "branch", "hidden"]) for (const on of [false, true]) {
      await evaluate(`window.taskboard.command('settings', undefined, { autoMode: ${on} })`);
      await wait(async () => await enabled() === String(on));
      await checkIcon(on);
      await evaluate(`(() => {
        for (const button of document.querySelectorAll('.status-repository button')) button.disabled = false;
        document.querySelector('#status-branch').hidden = ${git === "hidden"};
        document.querySelector('#status-branch span').textContent = 'main';
        document.querySelector('#status-publish').hidden = ${git !== "publish"};
        document.querySelector('#status-tracking').hidden = ${git !== "tracking"};
        document.querySelector('#status-tracking span').textContent = '0↓ 1↑';
      })()`);
      await evaluate("document.activeElement.blur()");
      window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 100 });
      await paint();
      const baseline = await gitStyle();
      await move('#status-auto-mode');
      assert.equal(await evaluate("document.querySelector('#status-auto-mode').matches(':hover')"), true);
      assert.deepEqual(await gitStyle(), baseline, "Auto hover leaves Git background and border unchanged");
      const result = await evaluate(`(() => {
        const b = document.querySelector('#status-auto-mode'), i = b.querySelector('i');
        const r = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
        const before = document.querySelector('.status-repository');
        const limits = document.querySelector('#status-limits').getBoundingClientRect();
        const style = getComputedStyle(i);
        return { content: getComputedStyle(i, '::before').content, font: getComputedStyle(i).fontFamily,
          width: ir.width, height: ir.height, left: r.left, right: r.right, viewport: innerWidth,
          nextLeft: limits.left, barHeight: b.parentElement.getBoundingClientRect().height,
          previousRight: before.getBoundingClientRect().right, parent: b.parentElement.className,
          animation: style.animationName, duration: style.animationDuration, transform: style.transform,
          gitHover: before.matches(':hover'),
          hit: b.contains(document.elementFromPoint(ir.x+8, ir.y+8)), label: b.textContent.trim() };
      })()`);
      assert.equal(result.content, on ? '"\uea77"' : '"\ueb2c"');
      assert.match(result.font, /codicon/);
      assert.equal(result.parent, "status-bar");
      assert.equal(result.gitHover, false);
      assert.ok(result.width >= 16 && result.height >= 16 && result.hit);
      assert.ok(result.left >= 0 && result.right <= result.viewport);
      assert.equal(result.barHeight, 36);
      assert.ok(Math.abs(result.nextLeft - result.right - 4) <= 1, "4px separation before Limits");
      if (git !== "hidden") {
        assert.ok(Math.abs((result.left - result.previousRight) - (result.nextLeft - result.right)) <= 1,
          "Git, Auto and Limits have equal gaps");
      }
      else assert.equal(result.left, 8, "no extra leading gap without Git");
      assert.equal(result.animation, on && motion === "no-preference" ? "agent-spin" : "none");
      if (on && motion === "no-preference") {
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.notEqual(await evaluate("getComputedStyle(document.querySelector('#status-auto-mode i')).transform"), result.transform, "sync really rotates");
      }
      assert.ok(result.label.length > 0);
      results.push({ motion, theme, width, zoom, git, on, ...result });
      if (motion === "no-preference" && theme === "dark" && zoom === 1) {
        const textVariants = await evaluate(`(() => {
          const auto = document.querySelector('#status-auto-mode');
          const git = document.querySelector('.status-repository');
          const counters = document.querySelector('#status-tracking span');
          const limits = document.querySelector('#status-limits');
          const quota = limits.querySelector('span');
          const originals = [counters.textContent, quota.textContent, limits.classList.contains('quota-low')];
          const variants = [];
          for (const counts of ['0↓ 138↑', '12345↓ 67890↑']) {
            for (const percent of [7, 36, 100]) {
              counters.textContent = counts;
              quota.textContent = 'Лимиты ' + percent + '%';
              limits.classList.toggle('quota-low', percent <= 10);
              const a = auto.getBoundingClientRect();
              variants.push({ counts, percent, before: a.left - git.getBoundingClientRect().right,
                after: limits.getBoundingClientRect().left - a.right, left: a.left });
            }
          }
          counters.textContent = originals[0];
          quota.textContent = originals[1];
          limits.classList.toggle('quota-low', originals[2]);
          return variants;
        })()`);
        for (const variant of textVariants) {
          assert.ok(Math.abs(variant.after - 4) <= 1);
          if (git === "hidden") assert.equal(variant.left, 8);
          else assert.ok(Math.abs(variant.before - variant.after) <= 1);
        }
        results.at(-1).textVariants = textVariants;
        if ((git === "tracking" && on === (width === 1200)) || (git === "hidden" && width === 800 && !on)) {
          await evaluate(`(() => {
            document.querySelector('#status-tracking span').textContent = '0↓ 138↑';
            document.querySelector('#status-limits span').textContent = 'Лимиты 36%';
            document.querySelector('#status-limits').classList.remove('quota-low');
          })()`);
          window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 100 });
          await paint();
          const height = await evaluate("innerHeight");
          const image = await window.webContents.capturePage({ x: 0, y: height - 36, width, height: 36 });
          writeFileSync(join(artifacts, `status-${width}-${git}.png`), image.toPNG());
          await evaluate("window.renderProviderLimits()");
        }
      }
      if (motion === "no-preference" && width === 800 && git === "publish") writeFileSync(join(artifacts, `auto-${theme}-${zoom}-${on}.png`), (await window.webContents.capturePage()).toPNG());
      if (git !== "hidden") {
        await move('#status-branch');
        assert.notDeepEqual(await gitStyle(), baseline, "Git still has its own hover feedback");
        assert.equal(await evaluate("document.querySelector('#status-auto-mode').matches(':hover')"), false);
      }
      await evaluate("document.querySelector('#status-auto-mode').focus()");
      if (git !== "hidden") {
        window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 100 });
        await paint();
        assert.deepEqual(await gitStyle(), baseline, "Auto keyboard focus leaves Git unchanged");
      }
    }
  }
  }
  writeFileSync(join(artifacts, "auto-mode.json"), JSON.stringify({ versions: process.versions, scenarios: results.length,
    activation: "mouse, Space, Enter; board isolation; renderer reload and fresh CLI reads passed", results }, null, 2));
  console.log(`PASS: ${results.length} visual scenarios; mouse/Space/Enter, board isolation and reload; empty isolated boards only`);
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }
})();

