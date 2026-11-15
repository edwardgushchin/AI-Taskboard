// Windows font verification in the real app, with an isolated profile and in-memory messages.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "chat-font", 60_000);
assert.equal(process.platform, "win32", "Run this check on Windows to verify Segoe UI");
const { app, nativeTheme } = await import("electron");
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.setPath("appData", scratch);
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
let window;
const loaded = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("App window did not load")), 20_000);
  app.once("browser-window-created", (_event, created) => {
    window = created;
    created.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
  });
});

// Let Electron finish evaluating the entry module before waiting for app readiness.
async function run() {
  try {
    await import("../src/desktop/main.ts");
    await loaded;
    window.webContents.setBackgroundThrottling(false);
    const evaluate = code => window.webContents.executeJavaScript(code);
    assert.match(window.webContents.getURL(), /\/src\/desktop\/index\.html$/);
    await evaluate(`api.bootstrap().then(update)`);
    const sample = 'Agent reply: Latin text.\n\nОтвет агента: Съешь ещё этих мягких французских булок. Ёжик и ёлка.\n\n**Жирный текст Bold** и *курсив Italic*.\n\n- Проверка списка\n- [Ссылка](https://example.com) и `code код`\n\n```text\nconst ответ = "Привет";\n```';
    await evaluate(`
      frame = { ...frame, project: 'font-fixture', russian: true, runActivity: {} };
      const sample = ${JSON.stringify(sample)};
      const activity = [
        { id: 'progress', type: 'agentMessage', phase: 'commentary', text: sample, status: 'completed' },
        { id: 'final', type: 'agentMessage', phase: 'final_answer', text: sample, status: 'completed' }
      ];
      taskInSheet = { id: 'T-0043', createdAt: '2026-11-12T15:00:00Z', status: 'in_progress', questions: [], attachments: [], history: [
        { at: '2026-11-12T15:00:00Z', action: 'chat', actor: 'user', text: 'Проверь шрифт ответов агента.', chat: { model: 'test', effort: 'high' } },
        { at: '2026-11-12T15:01:00Z', action: 'chat', actor: 'agent', text: sample, chat: { model: 'test', effort: 'high', commentary: [sample] } },
        { at: '2026-11-12T15:02:00Z', action: 'run-log', actor: 'agent', run: activity, durationMs: 12000 }
      ] };
      sheetKind = 'task';
      byId('sheet-title').textContent = 'T-0043 · Шрифт ответов агента';
      body.replaceChildren(taskChat(taskInSheet));
      sheet.showModal();
      const list = body.querySelector('.chat-log');
    `);
    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("DOM.enable");
    await debuggerApi.sendCommand("CSS.enable");
    const report = { platform: process.platform, electron: process.versions.electron, checks: [] };
    const probe = async (name, selector, expectedFamily = "Segoe UI", expectedSize = "15px") => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' });
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const style = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('Missing font probe');
        const style = getComputedStyle(node);
        return { family: style.fontFamily, size: style.fontSize, text: node.textContent };
      })()`);
      assert.equal(style.size, expectedSize, name + " size");
      const { root: documentNode } = await debuggerApi.sendCommand("DOM.getDocument");
      const { nodeId } = await debuggerApi.sendCommand("DOM.querySelector", { nodeId: documentNode.nodeId, selector });
      const { fonts } = await debuggerApi.sendCommand("CSS.getPlatformFontsForNode", { nodeId });
      assert.ok(fonts.length > 0 && fonts.every(font => font.familyName === expectedFamily && font.glyphCount > 0 && !font.isCustomFont), name + ": actual system font " + JSON.stringify(fonts));
      report.checks.push({ name, ...style, fonts });
    };
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await evaluate(`applyTheme(${JSON.stringify(theme)}); document.querySelector('.chat-log').scrollTop = 0`);
      await probe(theme + " Latin", '.chat-entry[data-actor="agent"] .chat-text > p:first-child');
      await probe(theme + " Cyrillic Ёё", '.chat-entry[data-actor="agent"] .chat-text > p:nth-child(2)');
      await probe(theme + " bold", '.chat-entry[data-actor="agent"] .chat-text strong');
      await probe(theme + " italic", '.chat-entry[data-actor="agent"] .chat-text em');
      await probe(theme + " saved run final", '.chat-run-final .chat-text > p:nth-child(2)');
      await probe(theme + " code", '.chat-entry[data-actor="agent"] .chat-text pre code', "Consolas", "12px");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.chat-entry[data-actor="user"] .chat-text')).fontSize`), "14px");
      await evaluate(`document.querySelector('.chat-log').scrollTop = 0`);
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      writeFileSync(join(artifacts, "chat-font-" + theme + ".png"), (await window.webContents.capturePage()).toPNG());
    }
    await evaluate(`document.querySelectorAll('.chat-work').forEach(node => node.open = true)`);
    await probe("saved commentary", '.chat-work .chat-text > p:nth-child(2)');
    await evaluate(`updateChat({ project: 'font-fixture', id: 'T-0043', type: 'run', items: activity })`);
    await probe("live run", '.chat-run-live .chat-text > p:nth-child(2)');
    await evaluate(`
      const draft = chatDrafts.get('font-fixture' + String.fromCharCode(0) + 'T-0043');
      draft.pending = 'replying'; draft.commentary = [sample]; renderChatTurn(list, draft);
    `);
    await probe("live discussion", '.chat-turn .chat-text > p:nth-child(2)');
    await evaluate(`body.replaceChildren(taskChat(taskInSheet))`);
    await probe("reopened reply", '.chat-entry[data-actor="agent"] .chat-text > p:nth-child(2)');
    assert.equal(await evaluate(`document.querySelector('.chat-log').scrollWidth <= document.querySelector('.chat-log').clientWidth + 1`), true);
    debuggerApi.detach();
    writeFileSync(join(artifacts, "fonts.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.checks.length} Windows platform-font checks passed`);
    if (keepArtifacts) console.log("Artifacts: " + artifacts);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
void run();
