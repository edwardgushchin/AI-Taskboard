// Real Chromium checks of the personal-board workflow; fixtures never reach board storage.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "manual-board", 90_000);
const { app, BrowserWindow } = await import("electron");
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
  const screenshot = async name => {
    await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 350))');
    await window.webContents.capturePage();
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
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
    applyTheme("dark");
    window.boardTypes = [];
    api.createBoard = async type => {
      boardTypes.push(type);
    };
    void 0;`);
  await evaluate(`byId('welcome-create').click(); void 0;`);
  await check(`sheet.open && sheetKind === 'board-type' && body.querySelectorAll('[data-board-type]').length === 2 && boardTypes.length === 0`, 'welcome opens an in-app choice without a host dialog');
  await check(`body.textContent.includes('Задачи выполняют агенты') && body.textContent.includes('Дела выполняете вы') && document.activeElement.dataset.boardType === 'agent'`, 'choice explanations and keyboard focus');
  await screenshot('board-type.png');
  await evaluate(`body.querySelector('[data-board-type=manual]').click(); new Promise(resolve => setTimeout(resolve, 0))`);
  await check(`boardTypes.join() === 'manual' && !sheet.open`, 'manual choice reaches the host');
  await evaluate(`createBoard(); body.querySelector('[data-board-type=agent]').click(); new Promise(resolve => setTimeout(resolve, 0))`);
  await check(`boardTypes.join() === 'manual,agent'`, 'agent choice reaches the host');
  await evaluate(`createBoard(); Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Отмена').click(); void 0;`);
  await check(`!sheet.open && boardTypes.length === 2`, 'choice cancellation does not create a board');
  await evaluate(`window.fixture = { id: 'T-0001', title: 'Купить продукты на неделю', status: 'manual:plans', priority: 'normal', revision: 1,
    description: 'Молоко и хлеб', tags: [], attachments: [], history: [], questions: [], criteria: [], subtasks: [] };
    frame = { project: 'weekly-fixture', russian: true, runningTasks: [], board: { tags: [], settings: { boardType: 'manual', autoMode: false,
      manualColumns: [{ id: 'manual:plans', name: 'На неделю', color: '#818CF8', terminal: false }, { id: 'manual:done', name: 'Успели', color: '#4ADE80', terminal: true }] }, tasks: [fixture], archived: [] } };
    window.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.calls = []; window.taskboard.command = async (action, id, input) => { calls.push({action,id,input}); return { ok: true, data: fixture }; };
    byId('workspace').hidden = false; byId('welcome').hidden = true; mountAppMenu(); render(); void 0;`);
  await check(`document.querySelectorAll('.lane').length === 2 && document.querySelector('.lane-title').textContent.includes('На неделю')`, 'custom columns');
  await check(`document.querySelectorAll('.lane-create').length === 2 && document.querySelector('[data-state="manual:plans"] .lane-cards').lastElementChild.classList.contains('lane-create') && document.querySelector('[data-state="manual:done"] .lane-cards').firstElementChild.classList.contains('lane-create')`, 'create button follows cards and exists in an empty column');
  await screenshot('create-in-columns.png');
  for (const status of ['manual:plans', 'manual:done']) {
    await evaluate(`document.querySelector('[data-state="${status}"] .lane-create').click(); void 0;`);
    await check(`sheetKind === 'manual-create' && !body.querySelector('form').checkValidity()`, 'task title required');
    await evaluate(`body.querySelector('[name=title]').value = 'Купить продукты'; body.querySelector('[name=description]').value = 'На неделю'; body.querySelector('form').requestSubmit(); settle()`);
    await check(`calls.some(c => c.action === 'create' && c.input.initialStatus === '${status}' && c.input.title === 'Купить продукты')`, 'creation preserves the chosen column');
  }
  await evaluate(`createManualTask('manual:plans'); window.createsBefore = calls.filter(c => c.action === 'create').length; sheet.close(); void 0;`);
  await check(`calls.filter(c => c.action === 'create').length === createsBefore`, 'cancelling task form creates nothing');
  await evaluate(`createManualTask('manual:plans'); frame.project = 'other-board'; projectGeneration++; body.querySelector('[name=title]').value = 'Old form'; body.querySelector('form').requestSubmit(); settle()`);
  await check(`calls.filter(c => c.action === 'create').length === createsBefore`, 'stale form cannot create on another board');
  await evaluate(`frame.project = 'weekly-fixture'; sheet.close(); void 0;`);
  await evaluate(`window.savedCommand = api.command; api.command = async () => ({ok:false,error:{code:'INVALID_INPUT',message:'Колонка удалена'}});
    createManualTask('manual:plans'); body.querySelector('[name=title]').value = 'Сохранить текст'; body.querySelector('form').requestSubmit(); settle()`);
  await check(`sheet.open && sheetKind === 'manual-create' && body.querySelector('[name=title]').value === 'Сохранить текст' && byId('sheet-notice').textContent.includes('Колонка удалена')`, 'failed creation retains the form and explains the error');
  await evaluate(`api.command = savedCommand; sheet.close(); void 0;`);
  await evaluate("showTask(fixture.id)");
  await check(`body.textContent.includes('Успели') && !body.textContent.includes('Запустить') && !body.textContent.includes('Сдать') && !body.textContent.includes('Отменить задачу')`, 'manual actions');
  await evaluate(`const picker = body.querySelector('.sheet-actions select'); picker.value = 'manual:done'; picker.dispatchEvent(new Event('change')); settle()`);
  await check(`calls.some(c => c.action === 'manual-move' && c.input.to === 'manual:done')`, 'user status choice');
  await evaluate(`manualBoardSettings(); void 0;`);
  await check(`body.querySelectorAll('input[type=color]').length === 2 && body.querySelectorAll('input[type=checkbox]').length === 2`, 'column controls');
  await evaluate(`Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Добавить колонку').click(); void 0;`);
  await check(`body.querySelectorAll('input[type=color]').length === 3`, 'add column');
  await evaluate(`const name = body.querySelector('input'); name.value = 'По дороге'; name.dispatchEvent(new Event('input'));
    const color = body.querySelector('input[type=color]'); color.value = '#123456'; color.dispatchEvent(new Event('input'));
    Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Ниже').click();
    Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Сохранить колонки').click(); settle()`);
  await check(`calls.some(c => c.action === 'manual-columns' && c.input.columns[1].id === 'manual:plans' && c.input.columns[1].name === 'По дороге' && c.input.columns[1].color === '#123456')`, 'rename color reorder preserve identity');
  await evaluate(`manualBoardSettings(); void 0;`);
  await evaluate(`Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Удалить').click(); void 0;`);
  await check(`byId('sheet-title').textContent.includes('Куда перенести дела?') && body.querySelector('select').required`, 'explicit transfer');
  await evaluate(`body.querySelector('select').value = 'manual:done'; body.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})); settle()`);
  await evaluate(`Array.from(body.querySelectorAll('button')).find(b => b.textContent === 'Сохранить колонки').click(); settle()`);
  await check(`calls.some(c => c.action === 'manual-columns' && c.input.moves['manual:plans'] === 'manual:done' && c.input.columns.length === 1)`, 'delete with chosen transfer');
  await evaluate(`manualBoardSettings(); settle()`);
  await screenshot('manual-columns.png');
  await evaluate(`showTask(fixture.id).then(settle)`);
  await screenshot('manual-card.png');
  await evaluate(`createBoard(); settle()`);
  await screenshot('board-type.png');
  await evaluate(`sheet.close(); settle()`);
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify({ checks, result: 'passed', electron: process.versions.electron }, null, 2));
  console.log(JSON.stringify({ checks, result: 'passed' }));
  window.destroy(); app.exit(0);
}).catch(error => { console.error(error); window?.destroy(); app.exit(1); });
