import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { electronCheck, localizationFixture } from "./electron-check.mjs";
const { scratch, artifacts } = electronCheck(import.meta.url, "statistics", 90000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
const read = file => readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
let window;
app.whenReady().then(async () => {
try {
  window = new BrowserWindow({ show: false, width: 900, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await window.webContents.insertCSS(read("themes.css") + read("styles.css") + read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url)).toString("base64")));
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate(`
    window.taskboard = { subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}), command: async () => window.response };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${localizationFixture()}
    ${["image-preview.js", "source-files.cjs", "markdown.js", "chat.js", "renderer.js"].map(read).join("\n")}
    frame = { project: 'fixture', russian: true, board: {} };
    const model = { model: 'future-model', totalTokens: 712, inputTokens: 610, outputTokens: 102, cachedInputTokens: 260, cacheWriteInputTokens: null, reasoningOutputTokens: 50, incomplete: true };
    window.response = { ok: true, data: { total: 712, incomplete: true, missingTasks: 1, tasks: 4, managerReports: 2, byModel: [model], byRole: { manager: [model], executor: [], reviewer: [], discussion: [], unattributed: [] } } };
    void 0;
  `);
  for (const russian of [true, false]) for (const theme of ['dark', 'light']) {
    await evaluate(`frame.russian = ${russian}; document.documentElement.dataset.theme = 'github-${theme}'; byId('app-content').hidden = false; byId('app-settings').focus(); openSettingsMenu(); void 0`);
    assert.equal(await evaluate(`byId('settings-menu-statistics').disabled`), false);
    await evaluate(`byId('settings-menu-app').focus(); byId('settings-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); byId('settings-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); void 0`);
    assert.equal(await evaluate(`document.activeElement.id`), 'settings-menu-statistics');
    await evaluate(`byId('settings-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); void 0`);
    assert.equal(await evaluate(`document.activeElement.id`), 'app-settings');
    await evaluate(`openSettingsMenu(); byId('settings-menu-statistics').click(); new Promise(r => setTimeout(r, 30))`);
    assert.match(await evaluate(`body.innerText`), /712/);
    assert.match(await evaluate(`body.innerText`), russian ? /Нет данных/ : /No data/);
    window.setSize(440, 720);
    await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    assert.equal(await evaluate(`sheet.getBoundingClientRect().right <= innerWidth && body.scrollWidth <= body.clientWidth`), true);
    writeFileSync(join(artifacts, `statistics-${russian ? 'ru' : 'en'}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate(`sheet.close(); new Promise(r => setTimeout(r, 20))`);
    assert.equal(await evaluate(`document.activeElement.id`), 'app-settings');
  }
  await evaluate(`frame.board = undefined; openSettingsMenu(); void 0`);
  assert.equal(await evaluate(`byId('settings-menu-statistics').disabled`), true);
  await evaluate(`byId('settings-menu').hidePopover(); frame.board = {}; window.taskboard.command = () => new Promise(r => window.release = r); projectStatistics(); void 0`);
  assert.match(await evaluate('body.innerText'), /Loading/);
  await evaluate(`release({ ok: false, error: { code: 'BOARD_BUSY', message: 'busy' } }); new Promise(r => setTimeout(r, 30))`);
  assert.match(await evaluate('body.innerText'), /Could not load/);
  await evaluate(`window.taskboard.command = async () => response; body.querySelector('button').click(); new Promise(r => setTimeout(r, 30))`);
  assert.match(await evaluate('body.innerText'), /712/);
  await evaluate(`response.data.total = 900; new Promise(r => setTimeout(r, 5200))`);
  assert.match(await evaluate('body.innerText'), /900/);
  await evaluate(`sheet.close(); window.taskboard.command = () => new Promise(r => window.release = r); projectStatistics(); void 0`);
  await evaluate(`projectGeneration++; frame.project = 'other'; sheet.close(); openSheet('other', 'Other'); body.textContent = 'Other project'; release(response); new Promise(r => setTimeout(r, 30))`);
  assert.equal(await evaluate('body.innerText'), 'Other project');
  await evaluate(`sheet.close(); window.taskboard.command = async () => ({ ok: true, data: { total: null, incomplete: true, tasks: 0, missingTasks: 0, managerReports: 0, byModel: [], byRole: {manager: []} } }); projectStatistics()`);
  assert.match(await evaluate('body.innerText'), /No token data/);
  await evaluate(`sheet.close(); window.taskboard.command = async () => ({ ok: true, data: { total: 0, incomplete: false, tasks: 1, missingTasks: 0, managerReports: 1, byModel: [{ ...model, model: null, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, incomplete: false }], byRole: {} } }); projectStatistics()`);
  assert.match(await evaluate('body.innerText'), /Recorded usage/);
  assert.match(await evaluate('body.innerText'), /Unknown model/);
  writeFileSync(join(artifacts, 'statistics-check.json'), JSON.stringify({ result: 'passed', versions: process.versions, checks: ['menu disabled without board', 'focus restoration', 'both themes and languages at 440px', 'loading', 'error and retry', 'live refresh', 'late response isolation', 'empty project', 'real zero'] }, null, 2));
  console.log('Statistics renderer checks passed');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { for (const item of BrowserWindow.getAllWindows()) item.destroy(); app.exit(process.exitCode ?? 0); }
});
