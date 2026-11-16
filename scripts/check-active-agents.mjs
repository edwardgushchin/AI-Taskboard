// Real main process, private profile and empty boards: never touches a user's queue.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "active-agents", 120_000);
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
    cli(board, ["settings"], { name: "Shared board" });
    writeFileSync(join(board, ".tasks", "manager-unread.json"), JSON.stringify(["qa-unread"]));
  }
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = ('import { trackActiveRun } from "./active-runs.ts";\n' + readFileSync(sourceUrl, "utf8")).replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source + "\nglobalThis.agentCheck = { trackActiveRun, createWindow };", { loader: "ts", format: "esm" }).code);
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
  await open(boards[0]);
  await open(boards[1]);
  const second = globalThis.agentCheck.createWindow([boards[0]]).window;
  const read = win => win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('#status-agents');
    const tip = document.querySelector('#status-agents-tooltip');
    return { count: Number(el.querySelector('span').textContent), text: tip.textContent,
      visible: getComputedStyle(tip).display !== 'none', label: el.getAttribute('aria-label') };
  })()`);
  await wait(() => second.webContents.executeJavaScript("window.taskboard?.bootstrap().then(f => Boolean(f.board))"));
  const expect = async count => {
    await wait(async () => (await read(window)).count === count && (await read(second)).count === count);
  };
  await expect(0);
  // Same production registry used by executor, manager, discussion and reviewer turns.
  const geometry = () => evaluate(`[...document.querySelectorAll('.project-tab')].map(el => {
    const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })`);
  const before = await geometry();
  await evaluate("globalThis.savedTab = document.querySelector('.project-tab-button'); savedTab.focus()");
  const finish = [globalThis.agentCheck.trackActiveRun(boards[0], "manager"), globalThis.agentCheck.trackActiveRun(boards[0], "reviewer"),
    globalThis.agentCheck.trackActiveRun(boards[1], "executor"), globalThis.agentCheck.trackActiveRun(boards[1], "manager")];
  await expect(4);
  const snapshot = await window.webContents.executeJavaScript('window.taskboard.bootstrap()');
  assert.equal(snapshot.activeAgents.total, 4);
  assert.deepEqual(snapshot.activeAgents.boards.map(board => board.count), [2, 2]);
  assert.equal(new Set(snapshot.activeAgents.boards.map(board => board.detail)).size, 2);
  assert.deepEqual(await geometry(), before, 'activity preserves all tab bounds');
  assert.equal(await evaluate("savedTab === document.querySelector('.project-tab-button') && document.activeElement === savedTab"), true);
  const tabState = () => evaluate(`[...document.querySelectorAll('.project-tab')].map(el => {
    const b = el.querySelector('[role=tab]'), stripe = getComputedStyle(el, '::after');
    return { active: el.classList.contains('has-active-agents'), selected: b.getAttribute('aria-selected'),
      unread: !!el.querySelector('.project-tab-unread'), title: b.title, description: b.getAttribute('aria-description'),
      animation: stripe.animationName, color: stripe.backgroundColor, width: stripe.width, opacity: Number(stripe.opacity),
      image: stripe.backgroundImage, position: stripe.backgroundPositionY, duration: stripe.animationDuration,
      accent: getComputedStyle(el).getPropertyValue('--accent').trim(),
      pointer: stripe.pointerEvents, selection: getComputedStyle(el).borderInlineStartColor };
  })`);
  const matrix = [];
  window.webContents.debugger.attach('1.3');
  for (const theme of ['light', 'dark']) {
    await evaluate(`window.taskboard.setTheme(${JSON.stringify(theme)})`);
    for (const motion of ['no-preference', 'reduce']) {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
      await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
      await new Promise(resolve => setTimeout(resolve, 250));
      const tabs = await tabState();
      assert.equal(tabs.length, 2);
      for (const tab of tabs) {
        assert.equal(tab.active, true); assert.equal(tab.unread, true);
        assert.equal(tab.animation, motion === 'reduce' ? 'none' : 'project-agent-glint');
        assert.equal(tab.width, '1px'); assert.equal(tab.pointer, 'none');
        assert.notEqual(tab.color, 'rgba(0, 0, 0, 0)');
        assert.equal(await evaluate(`(() => { const el = document.createElement('span'); el.style.backgroundColor = ${JSON.stringify(motion === 'reduce' ? tab.accent : 'color-mix(in srgb, ' + tab.accent + ' 25%, transparent)')}; document.body.append(el); const color = getComputedStyle(el).backgroundColor; el.remove(); return color; })()`), tab.color);
        assert.equal(tab.opacity, 1, 'the whole stripe does not pulse');
        if (motion === 'reduce') assert.equal(tab.image, 'none');
        else { assert.ok(tab.image.includes('linear-gradient')); assert.equal(tab.duration, '3.6s'); }
        assert.ok(tab.title.includes(tab.description));
      }
      assert.match(tabs[0].description, /Менеджер 1.*Ревьюер 1/);
      assert.match(tabs[1].description, /Менеджер 1.*Исполнитель 1/);
      assert.deepEqual(tabs.map(t => t.selected), ['false', 'true']);
      if (motion === 'no-preference') {
        // Record actual Chromium frames with native canvas/MediaRecorder, no extra encoder.
        const clip = { x: 0, y: 0, width: 100, height: 560 };
        await evaluate(`(() => {
          const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 560;
          const stream = canvas.captureStream(10), chunks = [];
          const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
          globalThis.activityRecording = { canvas, recorder, stream, chunks };
          recorder.ondataavailable = event => chunks.push(event.data);
          recorder.start();
        })()`);
        const samples = [];
        for (let frame = 0; frame < 40; frame++) {
          const capture = (await window.webContents.capturePage(clip)).toDataURL();
          await evaluate(`(async () => {
            const image = new Image(); image.src = ${JSON.stringify(capture)}; await image.decode();
            activityRecording.canvas.getContext('2d').drawImage(image, 0, 0);
          })()`);
          samples.push((await tabState())[0]);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const base64 = await evaluate(`new Promise(resolve => {
          const { recorder, stream, chunks } = activityRecording;
          recorder.onstop = async () => {
            const buffer = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
            stream.getTracks().forEach(track => track.stop());
            delete globalThis.activityRecording;
            resolve(btoa(String.fromCharCode(...new Uint8Array(buffer))));
          };
          recorder.stop();
        })`);
        writeFileSync(join(artifacts, 'glint-' + theme + '.webm'), Buffer.from(base64, 'base64'));
        assert.ok(new Set(samples.map(tab => tab.position)).size > 30, 'glint travels along the stripe');
        assert.ok(samples.every(tab => tab.opacity === 1 && tab.color === tabs[0].color), 'base line remains constant');
        // Decode in an isolated blank window: the app deliberately disallows media via CSP.
        const decoder = new BrowserWindow({ show: false });
        let playback;
        try {
          await decoder.loadURL('about:blank');
          playback = await decoder.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const video = document.createElement('video');
          video.onloadeddata = () => { resolve({ width: video.videoWidth, height: video.videoHeight }); video.removeAttribute('src'); video.load(); };
          video.onerror = () => reject(new Error('Recorded clip could not be decoded'));
          video.src = 'data:video/webm;base64,' + ${JSON.stringify(base64)};
        })`);
        } finally { decoder.destroy(); }
        assert.deepEqual(playback, { width: 100, height: 560 });
        matrix.push({ theme, motion, positionSamples: samples.map(tab => tab.position), playback });
      } else {
        await new Promise(resolve => setTimeout(resolve, 300));
        const staticTab = (await tabState())[0];
        assert.equal(staticTab.opacity, 1);
        assert.equal(staticTab.image, 'none');
        assert.equal(staticTab.position, tabs[0].position, 'reduced motion remains static');
      }
      matrix.push({ theme, motion, tabs });
      // Still images show the glint halfway along the line; video above uses real time.
      await evaluate("document.getAnimations().filter(a => a.animationName === 'project-agent-glint').forEach(a => { a.pause(); a.currentTime = 1800; })");
      writeFileSync(join(artifacts, `tabs-${theme}-${motion}.png`), (await window.webContents.capturePage()).toPNG());
      await evaluate("document.getAnimations().filter(a => a.animationName === 'project-agent-glint').forEach(a => a.play())");
    }
  }
  window.webContents.debugger.detach();
  await evaluate(`window.taskboard.selectTab(${JSON.stringify(boards[0])})`);
  const readResult = await evaluate(`window.taskboard.readManagerMessages(${JSON.stringify(boards[0])}, ['qa-unread'])`);
  assert.equal(readResult.ok, true, JSON.stringify(readResult));
  await wait(async () => !(await tabState())[0].unread);
  assert.equal((await tabState())[0].active, true, 'reading messages leaves activity visible');
  writeFileSync(join(artifacts, 'tabs-read-active.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`window.taskboard.selectTab(${JSON.stringify(boards[1])})`);
  // Exercise keyboard navigation and reorder with active indicators present.
  await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))");
  await wait(() => evaluate("window.taskboard.bootstrap().then(f => f.project === " + JSON.stringify(boards[0]) + ")"));
  await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))");
  await wait(() => evaluate("window.taskboard.bootstrap().then(f => f.tabs[1].path === " + JSON.stringify(boards[0]) + ")"));
  // Actual drag handlers; an activity change during dragging must retain its DOM.
  await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.project-tab')];
    const source = tabs[1].querySelector('.project-tab-button'), target = tabs[0];
    const dataTransfer = new DataTransfer(), clientY = target.getBoundingClientRect().top + 1;
    const options = { bubbles: true, cancelable: true, dataTransfer, clientY };
    source.dispatchEvent(new DragEvent('dragstart', options));
    target.dispatchEvent(new DragEvent('dragover', options));
    globalThis.finishDrag = () => { target.dispatchEvent(new DragEvent('drop', options)); source.dispatchEvent(new DragEvent('dragend', options)); };
  })()`);
  const extra = globalThis.agentCheck.trackActiveRun(boards[1], 'reviewer');
  await expect(5);
  assert.equal(await evaluate("!!document.querySelector('.drop-before')"), true);
  await evaluate('finishDrag()'); extra(); await expect(4);
  await wait(() => evaluate("window.taskboard.bootstrap().then(f => f.tabs[0].path === " + JSON.stringify(boards[0]) + ")"));
  await evaluate("window.taskboard.selectTab(" + JSON.stringify(boards[1]) + ")");
  window.focus();
  window.webContents.focus();
  await evaluate("document.querySelector('#status-agents').focus()");
  assert.equal((await read(window)).visible, true);
  assert.equal((await read(window)).label, (await read(window)).text);
  writeFileSync(join(artifacts, 'focus.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#status-agents').blur()");
  const point = await evaluate("(() => { const r = document.querySelector('#status-agents').getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()");
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await wait(async () => (await read(window)).visible);
  writeFileSync(join(artifacts, 'hover.png'), (await window.webContents.capturePage()).toPNG());
  // Finish on first board while second is selected; both windows update without switching.
  finish[0](); await expect(3);
  assert.equal((await tabState())[0].active, true);
  finish[1](); await expect(2);
  assert.deepEqual((await tabState()).map(tab => tab.active), [false, true]);
  finish[2](); await expect(1);
  finish[3](); await expect(0);
  finish[3](); await expect(0);
  assert.equal((await tabState()).every(tab => !tab.active), true);
  await evaluate("document.querySelector('.project-tab-close').click()");
  await wait(() => evaluate("window.taskboard.bootstrap().then(f => f.tabs.length === 1)"));
  writeFileSync(join(artifacts, 'active-agents.json'), JSON.stringify({ versions: process.versions,
    scenarios: ['two boards, four concurrent registry sessions', 'same board in two windows, no duplication',
      'background completion updates both windows', 'hover and keyboard focus', 'zero and idempotent cleanup', 'roles and selected/unread combinations', 'light/dark with motion and reduced motion', 'stable bounds and focused DOM', 'keyboard select/reorder, drag during activity change, close'],
    snapshot: snapshot.activeAgents, matrix, result: 'passed', limitation: 'Registry sessions are controlled fixtures; no paid provider runs.' }, null, 2));
  console.log('PASS: global registry, two boards, two windows, background finish, hover/focus, zero');
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); }
})();
