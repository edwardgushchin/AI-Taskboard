// Real Chromium regression checks for board refreshes, with a local fixture and no Codex calls.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const require = createRequire(import.meta.url);
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "localization",
  180_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
let window;
let checks = 0;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1380, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const iconFont = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
  const iconStyles = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + iconFont);
  await window.webContents.insertCSS(read("themes.css") + "\n" + iconStyles + "\n" + read("styles.css"));
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate(`document.fonts.load('16px codicon')`);
  const hover = async selector => {
    const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    return point;
  };
  const click = async selector => {
    const point = await hover(selector);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await evaluate(`settle()`);
  };
  const clickBoard = () => click("#lanes .lane-title");
  const clickManagerField = () => click(".draft-input textarea");
  const capture = async name => {
    // Hidden windows can paint a transition one compositor frame behind layout.
    await window.webContents.capturePage();
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  const check = async (code, message) => {
    assert.equal(await evaluate(code), true, message);
    checks++;
  };
  await check(`document.querySelector('#welcome').hidden`, "welcome is hidden before the first project snapshot");
  await check(`!/Загрузка проектов|Loading projects/.test(document.body.innerText)`, "initial HTML has no projects loading label");
  await evaluate(`
    window.previewCalls = 0;
    const savedQueue = new Map();
    window.taskboard = {
      subscribe(callback) { window.pushBoard = next => { callback(next); }; }, onChatUpdate(callback) { window.pushChat = callback; }, onTheme() {},
      boardHistory: async (_project, _cursor, view) => ({ ok: true, data: view === 'live'
        ? { work: [], chat: [] } : { turns: [], model: "gpt-board-test" } }),
      taskLimits: async () => ({ ok: true, data: { executor: 3, manager: 1, reviewer: 1 } }),
      boardQueue: async (project, action, id, draft, goal, files) => {
        const jobs = savedQueue.get(project) ?? new Map();
        savedQueue.set(project, jobs);
        if (action === 'list') return { ok: true, data: [...jobs.values()] };
        if (action === 'add') {
          id = 'message-' + (jobs.size + 1) + '-' + Math.random();
          jobs.set(id, { id, draft, goal, files });
        } else if (action === 'edit') jobs.get(id).draft = draft;
        else if (action === 'remove') jobs.delete(id);
        return { ok: true, data: id };
      },
      bootstrap: () => new Promise((_resolve, reject) => { window.rejectBootstrap = reject; }),
      attachmentPreview: async (_task, file) => {
        window.previewCalls++;
        if (file === 'missing.png') throw new Error('Unavailable preview');
        const preview = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#507e9b"/><text x="20" y="70" fill="white" font-size="24">Task preview</text></svg>');
        if (file === 'delayed.png') return new Promise(resolve => { window.releasePreview = () => resolve(preview); });
        return preview;
      }
    };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${localizationFixture()}
    ${read("renderer.js")}
    void 0;
  `);
  await evaluate(`
    const task = (id, title, extra = {}) => ({ id, title, status: 'ready', revision: 1, priority: 'normal',
      createdAt: '2026-11-01T12:00:00.000Z', updatedAt: extra.createdAt ?? '2026-11-01T12:00:00.000Z',
      tags: [], subtasks: [], attachments: [], history: [], questions: [], ...extra });
    const fixture = { project: 'board-fixture', russian: true, theme: 'dark', runningTasks: [],
      board: { settings: { archiveAfterDays: 90, integrationMode: 'merge' },
        tags: [{ name: 'UI', color: '#91B6F9' }], archived: [], tasks: [
        task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
        task('T-0002', 'Обновляемая карточка', { tags: ['UI'], createdAt: '2026-11-02T12:00:00.000Z' })
      ] } };
    const push = () => window.pushBoard(structuredClone(fixture));
    const lane = state => document.querySelector('.lane[data-state="' + state + '"]');
    const findCard = id => [...document.querySelectorAll('.task-card')].find(node => node.querySelector('.task-id').textContent === id);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const waitFor = predicate => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error('Timed out waiting for ' + predicate)) : setTimeout(poll, 16);
      poll();
    });
    window.pushBoard({ russian: true, restoring: true });
    void 0;
  `);

  await evaluate(`
    window.changeLanguage = locale => {
      window.taskboardLocalization.select(locale, ['fr-CA']);
      window.pushBoard({...structuredClone(fixture), localization: window.taskboardLocalization.state()});
    };
    api.codexStatus = async () => ({ok:true,data:{available:false}});
    api.themes = async () => [['system','System'],['light','Light'],['dark','Dark']];
    api.setLanguage = async locale => { changeLanguage(locale); return {ok:true,data:frame.localization}; };
    api.chatModels = async () => ({ok:true,data:[]});
    api.command = async (action, id) => action === 'show' ? {ok:true,data:{...fixture.board.tasks.find(task => task.id === id), criteria:[],questions:[],summary:'',nextStep:''}} : {ok:true,data:null};
    window.pushBoard({localization:window.taskboardLocalization.state()});
    if (byId('welcome-create').textContent.includes('=>')) throw Error('Unresolved welcome translation callback');
    changeLanguage('en');
    window.composer = byId('board-composer').firstChild;
    window.input = composer.querySelector('.draft-input textarea');
    input.value = 'User content Save Русский 日本語'; input.dispatchEvent(new Event('input',{bubbles:true}));
    api.boardRequest = () => new Promise(() => {});
    input.value = 'Active request'; composer.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));

    void 0;
  `);
  await evaluate(`waitFor(() => input.value === '')`);
  await evaluate(`input.value = 'Queued Save 日本語'; composer.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); void 0`);
  await evaluate(`waitFor(() => composer.querySelector('.board-queued-row'))`);
  await evaluate(`window.queuedIdentity = composer.querySelector('.board-queued-row'); input.value='User content Save Русский 日本語'; settings(); window.limit=byId('agent-limits').querySelector('input'); window.limitIdentity=limit; void 0`);
  await evaluate(`settle()`);
  await check(`byId('language-select').options.length === 11`, 'System and all ten native names are selectable');
  await evaluate(`limit.value = '7'; limit.focus(); void 0`);
  for (const locale of ['es','de','ja','fr','pt','ru','it','nl','pl','en']) {
    await evaluate(`changeLanguage('${locale}'); settle()`);
    await check(`document.documentElement.lang === '${locale}' && byId('language-select').value === '${locale}'`, 'effective language and preference ' + locale);
    await check(`byId('board-composer').firstChild === composer && input.value === 'User content Save Русский 日本語' && limit === limitIdentity && limit.value === '7' && frame.project === 'board-fixture' && composer.querySelector('.board-queued-row') === queuedIdentity && queuedIdentity.textContent.includes('Queued Save 日本語')`, 'switch keeps composer, inputs and project ' + locale);
    await check(`byId('sheet-title').textContent === t('ui.application_settings_b131bcd2') && byId('close-sheet').getAttribute('aria-label') === t('html.7d9eb7acb13e2462')`, 'open settings and accessibility labels update ' + locale);
  }
  await evaluate(`byId('language-select').focus(); void 0`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await check(`sheet.contains(document.activeElement)`, 'native Tab navigation stays in settings');
  await evaluate(`api.setLanguage('system'); settle()`);
  await check(`document.documentElement.lang === 'fr' && byId('language-select').value === 'system'`, 'return to System follows current OS preference');
  for (const theme of ['light','dark']) for (const locale of ['de','ja']) {
    window.setSize(720, 740);
    nativeTheme.themeSource = theme;
    await evaluate(`changeLanguage('${locale}'); frame.theme='${theme}'; applyTheme('${theme}'); settle()`);
    await check(`byId('language-select').getBoundingClientRect().right <= innerWidth && byId('sheet-title').getBoundingClientRect().right <= innerWidth && byId('sheet-body').scrollWidth <= byId('sheet-body').clientWidth + 1`, 'narrow settings ' + theme + ' ' + locale);
    await capture('settings-' + locale + '-' + theme + '.png');
  }
  await evaluate(`sheet.close(); changeLanguage('ja'); showTask('T-0001')`);
  await evaluate(`settle()`);
  await check(`sheet.open && byId('sheet-title').textContent.includes('Стабильное превью')`, 'user task title remains verbatim');
  await capture('task-ja-dark.png');
  await evaluate(`sheet.close(); changeLanguage('en'); void 0`);
  await check(`input.value === 'User content Save Русский 日本語'`, 'task open/close and repeated switches retain unsent text');
  const report = {checks, electron:process.versions.electron, chromium:process.versions.chrome, locales:10, themes:2, width:720};
  writeFileSync(join(artifacts,'result.json'),JSON.stringify(report,null,2));
  console.log('Localization Chromium checks passed: '+checks);
}).catch(async error => {
  console.error(error); process.exitCode = 1;
  if (window && keepArtifacts) writeFileSync(join(artifacts, "failure.png"), (await window.webContents.capturePage()).toPNG());
}).finally(() => { window?.destroy(); app.exit(process.exitCode ?? 0); });


