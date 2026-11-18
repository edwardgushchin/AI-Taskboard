// Real Chromium check of description rendering; fixtures never reach board storage.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "task-description", 90_000);
const { app, BrowserWindow, clipboard, nativeTheme } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
const read = name => readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
let window;
let checks = 0;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const fixturePath = join(scratch, "description.html");
  writeFileSync(fixturePath, html);
  await window.loadFile(fixturePath);
  const font = readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url)).toString("base64");
  await window.webContents.insertCSS(read("themes.css") + read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + font) + read("styles.css"));
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { console.error('Failed expression:', code); throw error; }
  };
  const check = async (code, label) => { assert.equal(await evaluate(code), true, label); checks++; };
  await evaluate(`window.taskboard = { subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
    openLink: async href => { window.lastLink = href; }, command: () => new Promise(resolve => { window.releaseTask = resolve; }) };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${localizationFixture()}
    ${read("renderer.js")}
    void 0;`);
  const description = '### Проблема\nДлинная **карточка** со [ссылкой](https://example.com/full?q=value) и `inline code`.\n\n' +
    'Абзац с полным значением `C:/Projects/a-long-path/report.md`. '.repeat(12) +
    '\n\n- Первый пункт\n- Второй пункт\n\n### Диагностика и связанные файлы\nСкрытая диагностика.\n\n#### Вложенный раздел\n' +
    '```text\n  full value\nsecond line\n```\n\n### Следующий раздел\nВидимый конец.\n';
  await evaluate(`window.fixture = { id: 'T-0073', title: 'Читаемость описания', status: 'ready', priority: 'normal', revision: 1,
    description: ${JSON.stringify(description)}, tags: [], attachments: [], history: [], questions: [], criteria: ['Обычный критерий'], subtasks: [] };
    frame = { project: 'description-fixture', russian: true, runningTasks: [], board: { settings: {}, tasks: [fixture], archived: [] } };
    window.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    byId('workspace').hidden = false; byId('welcome').hidden = true;
    byId('lanes').append(card(fixture)); void 0;`);
  await check(`(() => { const p = document.querySelector('.task-description'); return p.textContent.startsWith('Длинная карточка') && !/[#*\x60]/.test(p.textContent) && p.textContent.includes('Первый пункт') && p.textContent.includes('inline code') && !p.querySelector('*') && getComputedStyle(p).webkitLineClamp === '2' && p.clientHeight <= 37; })()`, "board Markdown and height without old template headings");
  await check(`cardDescription('<img src=x onerror=alert(1)> [link](javascript:alert(1)) ![alt](https://example.com/x.png)').childElementCount === 0`, "inert unsafe preview");
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await evaluate(`applyTheme('github-${theme}'); settle()`);
    await check(`getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() === '${theme === 'light' ? '#fff' : '#161b22'}'`, "actual theme palette");
    await window.webContents.capturePage();
    writeFileSync(join(artifacts, 'board-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    for (const width of [1280, 600]) {
      window.setSize(width, 900);
      await evaluate(`document.querySelector('.task-card').click(); settle()`);
      await check(`body.querySelector('.task-sheet-description .chat-text p').textContent.startsWith('Длинная карточка') &&
        ![...body.querySelectorAll('.task-sheet-description .chat-text h3')].some(heading => heading.textContent === 'Проблема') &&
        !body.querySelector('details').open`, "preview keeps the brief and collapses technical details");
      await check(`(() => { const p = body.querySelector('.chat-text p'); const s = getComputedStyle(p); return s.fontSize === '15px' && s.lineHeight === '24px' && parseFloat(s.marginBottom) > 0; })()`, "description typography");
      await check(`(() => { const d = body.querySelector('details'); return d.textContent.includes('Вложенный раздел') && !d.textContent.includes('Видимый конец') && d.nextElementSibling.textContent === 'Следующий раздел'; })()`, "section boundaries");
      await evaluate(`body.querySelector('summary').focus(); void 0;`);
      await evaluate(`body.querySelector('summary').scrollIntoView({block:'center'}); settle()`);
      writeFileSync(join(artifacts, 'collapsed-' + theme + '-' + width + '.png'), (await window.webContents.capturePage()).toPNG());
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      await evaluate(`settle()`);
      await check(`body.querySelector('details').open`, "native keyboard expansion");
      await evaluate(`window.previewHTML = body.querySelector('.task-sheet-description').innerHTML; releaseTask({ok:true,data:fixture}); settle()`);
      await check(`body.querySelector('.task-sheet-description').innerHTML === previewHTML && body.querySelector('details').open`, "full load preserves rendering and expansion");
      await check(`getComputedStyle(body.querySelectorAll('.sheet-section')[1].querySelector('p')).fontSize !== '15px'`, "criteria typography unchanged");
      await evaluate(`body.querySelector('.chat-text a').click(); settle()`);
      await check(`window.lastLink === 'https://example.com/full?q=value'`, "complete link target");
      await evaluate(`body.querySelector('.chat-code-copy').click(); settle()`);
      assert.equal((await clipboard.readText()).replaceAll('\r\n', '\n'), '  full value\nsecond line\n'); checks++;
      await check(`body.scrollWidth <= body.clientWidth + 1`, "no horizontal sheet overflow");
      await evaluate(`body.querySelector('summary').scrollIntoView({block:'center'}); settle()`);
      const point = await evaluate(`(() => { const r = body.querySelector('summary').getBoundingClientRect(); return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)}; })()`);
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      await evaluate(`settle()`);
      await check(`!body.querySelector('details').open`, "native mouse collapse");
      await evaluate(`body.querySelector('summary').click(); settle()`);
      await evaluate(`body.scrollTop = 0; settle()`);
      await window.webContents.capturePage();
      writeFileSync(join(artifacts, 'description-' + theme + '-' + width + '.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate(`byId('close-sheet').click(); settle()`);
    }
  }
  for (const text of ['Обычный текст\n\nДиагностика без заголовка', '```text\n### Диагностика и связанные файлы\n```', '> ### Диагностика и связанные файлы\n> Цитата']) {
    await evaluate(`body.replaceChildren(); taskDescription(${JSON.stringify(text)}, 'T-0073'); void 0`);
    await check(`!body.querySelector('details')`, "legacy, code and quoted headings stay visible");
  }
  for (const heading of ['#', '##', '###']) {
    await evaluate(`body.replaceChildren(); taskDescription(${JSON.stringify('### Диагностика и связанные файлы\nСкрыто\n\n' + heading + ' Конец\nВидно')}, 'T-0073'); void 0`);
    await check(`body.querySelector('details') === body.querySelector('.chat-text').firstElementChild && !body.querySelector('details').textContent.includes('Видно')`, "first section and equal/higher boundary");
  }
  await evaluate(`body.replaceChildren(); taskDescription(${JSON.stringify('Диагностика и связанные файлы\n---\nСкрыто\n\n## Конец\nВидно')}, 'T-0073'); void 0`);
  await check(`body.querySelector('details') && !body.querySelector('details').textContent.includes('Видно')`, "setext heading");
  await check(String.raw`(() => { const b = chatText('Intro\n\n### Technical details\nEvidence', {agent:true}); return b.querySelector('.chat-report-details') !== null; })()`, "existing report folding preserved");
  await evaluate(`byId('lanes').replaceChildren(card(fixture)); document.querySelector('.task-card').focus(); void 0`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await evaluate(`settle()`);
  await check(`sheet.open && body.querySelector('.task-sheet-description') !== null`, "keyboard opens card");
  const report = { checks, electron: process.versions.electron, node: process.versions.node, platform: process.platform, result: 'passed' };
  writeFileSync(join(artifacts, 'description-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}).catch(async error => {
  console.error(error); process.exitCode = 1;
  if (window) writeFileSync(join(artifacts, 'description-failure.png'), (await window.webContents.capturePage()).toPNG());
}).finally(() => { window?.destroy(); app.exit(process.exitCode ?? 0); });
