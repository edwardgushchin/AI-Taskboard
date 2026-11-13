// Real Chromium regression checks for board refreshes, with a local fixture and no Codex calls.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const require = createRequire(import.meta.url);
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "board", 90_000);
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
  await evaluate(`
    window.previewCalls = 0;
    window.taskboard = {
      subscribe(callback) { window.pushBoard = callback; }, onChatUpdate(callback) { window.pushChat = callback; }, onTheme() {},
      boardHistory: async () => ({ ok: true, data: { turns: [], model: "gpt-board-test" } }),
      boardSuggestions: async () => frame.project === "design-board" ? new Promise(resolve => { window.releaseSuggestions = () => resolve([
        "Создай задачу на локализацию AI Taskboard", "Какие изменения нужны карточкам AI Taskboard?",
      ]); }) : [],
      bootstrap: () => new Promise(() => {}),
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
    ${read("markdown.js")}
    ${read("chat.js")}
    ${read("renderer.js")}
    void 0;
  `);
  await evaluate(`
    const task = (id, title, extra = {}) => ({ id, title, status: 'ready', revision: 1, priority: 'normal',
      createdAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-01T12:00:00.000Z',
      tags: [], subtasks: [], attachments: [], history: [], questions: [], ...extra });
    const fixture = { project: 'board-fixture', russian: true, theme: 'dark', runningTasks: [],
      board: { settings: { archiveAfterDays: 90, integrationMode: 'merge' },
        tags: [{ name: 'UI', color: 'blue' }], archived: [], tasks: [
        task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
        task('T-0002', 'Обновляемая карточка', { tags: ['UI'], createdAt: '2026-11-02T12:00:00.000Z' })
      ] } };
    const push = () => window.pushBoard(structuredClone(fixture));
    const lane = state => document.querySelector('.lane[data-state="' + state + '"]');
    const findCard = id => [...document.querySelectorAll('.task-card')].find(node => node.querySelector('.task-id').textContent === id);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const waitFor = predicate => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error('Timed out waiting for ' + predicate)) : requestAnimationFrame(poll);
      poll();
    });
    window.pushBoard({ russian: true, restoring: true });
    void 0;
  `);
  await check(`byId('welcome').hidden && !byId('loading').hidden && byId('app-content').getAttribute('aria-busy') === 'true'`, "session restoration shows loading without flashing welcome");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "project-tabs-loading.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`push(); void 0`);
  await check(`byId('welcome').hidden && byId('loading').hidden && byId('app-content').getAttribute('aria-busy') === 'false'`, "a restored board replaces the loading state");
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`lane('ready').querySelector('.task-id').textContent === 'T-0002'`, "initial board shows the newest task first");
  await evaluate(`
    const originalCard = findCard('T-0001');
    const originalCover = originalCard.querySelector('img');
    const originalLane = lane('ready');
    const originalHeight = originalCard.getBoundingClientRect().height;
    const columnFilter = originalLane.querySelector('details');
    columnFilter.open = true;
    columnFilter.querySelector('select').focus();
    const originalFocus = document.activeElement;
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(document.querySelector('#lanes'), { childList: true, subtree: true });
    push();
    void 0;
  `);
  await check(`findCard('T-0001') === originalCard && originalCover === originalCard.querySelector('img')`, "identical refresh retains card and decoded preview nodes");
  await check(`lane('ready') === originalLane && columnFilter.open && document.activeElement === originalFocus`, "refresh retains the column, open filter and keyboard focus");
  await check(`!originalCover.hidden && originalCard.getBoundingClientRect().height === originalHeight`, "refresh never hides the decoded preview or collapses its space");
  await check(`mutations.length === 0`, "identical snapshots do not mutate column contents");
  await evaluate(`fixture.runActivity = { 'T-0002': [{ id: 'log', text: 'New output' }] }; push(); void 0`);
  await check(`mutations.length === 0`, "agent log updates do not rebuild board contents");
  await evaluate(`fixture.runningTasks = ['T-0002']; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.agent-spinner') !== null && findCard('T-0001') === originalCard`, "activity changes update the affected card only");
  await evaluate(`const spinner = findCard('T-0002').querySelector('.agent-spinner'); push(); void 0`);
  await check(`findCard('T-0002').querySelector('.agent-spinner') === spinner`, "repeated activity snapshots retain the running animation");
  await evaluate(`fixture.board.tasks[0].title = 'Новое название'; fixture.board.tasks[0].revision++; push(); void 0`);
  await check(`findCard('T-0001') === originalCard && originalCard.querySelector('strong').textContent === 'Новое название'`, "changed data reaches the existing card");
  await check(`originalCard.querySelector('img') === originalCover && !originalCover.hidden && originalCover.naturalWidth > 0`, "editing a covered card retains its decoded image");
  await evaluate(`fixture.board.tasks[0].status = 'review'; push(); void 0`);
  await check(`lane('review').contains(originalCard) && originalCard.querySelector('img') === originalCover`, "status changes move the existing card and preview");
  await check(`lane('review').querySelector('.count').textContent === '1' && lane('ready').querySelector('.count').textContent === '1'`, "lane counters follow status changes");
  await evaluate(`findCard('T-0002').focus(); const focusBeforeCreation = document.activeElement; void 0`);
  await evaluate(`fixture.board.tasks.push(task('T-0003', 'Новая карточка', { priority: 'high', createdAt: '2026-11-03T12:00:00.000Z' })); push(); void 0`);
  await check(`findCard('T-0003') !== undefined`, "new tasks appear after refresh");
  await check(`lane('ready').querySelector('.task-id').textContent === 'T-0003'`, "a newly created task appears above older tasks");
  await check(`document.activeElement === focusBeforeCreation && lane('ready').querySelectorAll('.task-card')[1] === focusBeforeCreation`, "inserting a newer task above the focused card preserves focus");
  await evaluate(`findCard('T-0003').focus(); const focusedCard = document.activeElement; fixture.board.tasks.reverse(); push(); void 0`);
  await check(`document.activeElement === focusedCard && lane('ready').querySelector('.task-card') === focusedCard`, "refresh preserves newest-first order and keyboard focus despite changed input order");
  await evaluate(`fixture.board.tasks.find(task => task.id === 'T-0002').updatedAt = '2026-11-10T12:00:00.000Z'; push(); void 0`);
  await check(`lane('ready').querySelector('.task-card') === focusedCard`, "editing an older task does not move it above newer tasks");
  await evaluate(`fixture.board.tasks.reverse(); lane('ready').querySelector('.lane-collapse').click(); push(); void 0`);
  await check(`lane('ready').querySelector('.lane-cards').hidden`, "refresh retains a collapsed column");
  await evaluate(`lane('ready').querySelector('.lane-collapse').click(); void 0`);
  await evaluate(`const select = lane('ready').querySelector('select'); select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true })); void 0`);
  await check(`!findCard('T-0002') && !!findCard('T-0003')`, "column filters use newly received tasks");
  await evaluate(`fixture.board.tasks[2].priority = 'normal'; push(); void 0`);
  await check(`lane('ready').querySelectorAll('.task-card').length === 0 && !!lane('ready').querySelector('.lane-filter-empty')`, "refresh applies active filters and shows the empty state");
  await evaluate(`lane('ready').querySelector('.lane-filter-options button').click(); void 0`);
  await check(`!!findCard('T-0002') && !!findCard('T-0003')`, "resetting the column filter restores current data");
  await evaluate(`fixture.board.tasks = fixture.board.tasks.filter(task => task.id !== 'T-0003'); push(); void 0`);
  await check(`!findCard('T-0003')`, "removed tasks disappear after refresh");
  await evaluate(`fixture.error = { message: 'Updates paused' }; push(); void 0`);
  await check(`document.querySelector('#notice').textContent === 'Updates paused' && findCard('T-0001') === originalCard`, "watch failures retain the last confirmed board");
  await evaluate(`delete fixture.error; fixture.runningTasks = []; push(); void 0`);
  await check(`document.querySelector('#notice').hidden && !findCard('T-0002').querySelector('.agent-spinner')`, "recovery clears the error and stale activity");
  await evaluate(`fixture.board.tags[0].customColor = '#ab1234'; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.tag').style.getPropertyValue('--tag-color') === '#ab1234'`, "tag color changes reach existing cards");
  await evaluate(`fixture.board.tasks[1].unfinishedDependencies = ['T-0001']; push(); void 0`);
  await check(`lane('blocked').contains(findCard('T-0002'))`, "unfinished dependencies move ready tasks to the blocked lane");
  await evaluate(`fixture.board.tasks[1].unfinishedDependencies = []; push(); void 0`);
  await check(`lane('ready').contains(findCard('T-0002'))`, "completed dependencies return tasks to the ready lane");
  await evaluate(`fixture.board.tasks[0].coverAttachment = 'missing.png'; fixture.board.tasks[0].attachments.push({ file: 'missing.png', name: 'missing.png' }); push(); void 0`);
  await evaluate(`settle()`);
  await check(`originalCard.querySelector('img').dataset.file === 'missing.png' && originalCard.querySelector('img').hidden`, "an unavailable replacement preview does not show the old attachment");
  await evaluate(`fixture.board.tasks[0].coverAttachment = 'cover.png'; push(); void 0`);
  await evaluate(`waitFor(() => !originalCard.querySelector('img').hidden)`);
  await check(`originalCard.querySelector('img').naturalWidth > 0`, "a valid preview loads after a failed replacement");
  await evaluate(`
    const previewSetting = () => body.querySelector('.form input[type="checkbox"]');
    const callsBeforeToggle = window.previewCalls;
    Object.assign(window.taskboard, {
      themes: async () => [],
      codexStatus: async () => ({ state: 'unavailable' }),
      command: async (name, id, input) => {
        if (name !== 'settings' || typeof input.showCardPreviews !== 'boolean') return { ok: false, error: { message: 'Invalid settings' } };
        fixture.board.settings = input;
        push();
        return { ok: true, data: input };
      },
    });
    settings();
    void 0;
  `);
  await check(`previewSetting().checked && previewSetting().labels[0].textContent === 'Показывать превью на карточках'`, "boards without a saved preview preference default to showing covers");
  await evaluate(`previewSetting().labels[0].click(); previewSetting().form.requestSubmit(); waitFor(() => !sheet.open)`);
  await check(`findCard('T-0001') === originalCard && !originalCard.querySelector('img') && fixture.board.settings.showCardPreviews === false && window.previewCalls === callsBeforeToggle`, "saving the unchecked setting hides the cover without replacing the task or requesting an image");
  await evaluate(`settings(); void 0`);
  await check(`!previewSetting().checked`, "reopening board settings shows the saved preference");
  await evaluate(`previewSetting().click(); previewSetting().form.requestSubmit(); waitFor(() => !sheet.open && originalCard.querySelector('img')?.naturalWidth > 0)`);
  await check(`fixture.board.settings.showCardPreviews === true && originalCard.querySelector('img').dataset.file === 'cover.png' && window.previewCalls === callsBeforeToggle`, "enabling previews restores the previously selected cover from the cache");
  await evaluate(`const archivedTask = fixture.board.tasks.shift(); fixture.board.archived.push({ ...archivedTask, status: 'done' }); push(); archiveView = true; render(); void 0`);
  await check(`document.querySelector('#archive-list').contains(findCard('T-0001'))`, "archived tasks remain accessible");
  await evaluate(`const archiveCard = findCard('T-0001'); push(); void 0`);
  await check(`findCard('T-0001') === archiveCard`, "archive refreshes retain cards too");
  await evaluate(`fixture.project = 'other-board'; fixture.board.tasks = [task('T-0001', 'Другая доска')]; fixture.board.archived = []; push(); void 0`);
  await check(`findCard('T-0001') !== originalCard && findCard('T-0001').textContent.includes('Другая доска') && !findCard('T-0001').querySelector('img')`, "switching projects isolates cards and covers with the same task number");
  await evaluate(`fixture.russian = false; push(); void 0`);
  await check(`lane('ready').querySelector('h2').textContent.includes('Ready') && findCard('T-0001').textContent.includes('Normal')`, "language changes update columns and cards");
  await evaluate(`const callsBeforeDelay = window.previewCalls; fixture.board.tasks[0].attachments = [{ file: 'delayed.png', name: 'delayed.png' }]; push(); void 0`);
  await evaluate(`waitFor(() => !!window.releasePreview)`);
  await evaluate(`const pendingImage = findCard('T-0001').querySelector('img'); fixture.board.tasks[0].title = 'Changed while loading'; push(); push(); window.releasePreview(); void 0`);
  await evaluate(`waitFor(() => !pendingImage.hidden)`);
  await check(`findCard('T-0001').querySelector('img') === pendingImage && window.previewCalls === callsBeforeDelay + 1`, "updates during preview loading retain the pending image and share its request");
  await evaluate(`fixture.board.tasks.push(...Array.from({ length: 40 }, (_, index) => task('S-' + index, 'Scroll task ' + index))); push(); void 0`);
  await evaluate(`(async () => { while (lane('ready').querySelector('.lane-more')) { lane('ready').querySelector('.lane-more').click(); await settle(); } })()`);
  await evaluate(`document.querySelector('#lanes').scrollTop = 400; const boardScroll = document.querySelector('#lanes').scrollTop; push(); void 0`);
  await check(`boardScroll > 0 && document.querySelector('#lanes').scrollTop === boardScroll`, "refresh retains the scroll position on a long board");
  await evaluate(`
    fixture.russian = true;
    fixture.project = 'sorting-fixture';
    const taskId = number => 'T-' + String(number).padStart(4, '0');
    fixture.board.tasks = lanes.flatMap(([status], index) => [
      task(taskId(100 + index * 2), 'Старая задача от 1 ноября', { status, createdAt: '2026-11-01T12:00:00.000Z' }),
      task(taskId(101 + index * 2), 'Новая задача от 3 ноября', { status, createdAt: '2026-11-03T12:00:00.000Z' })
    ]);
    const laneIds = state => [...lane(state).querySelectorAll('.task-id')].map(node => node.textContent).join(',');
    const allLanesSorted = () => lanes.every(([state], index) => laneIds(state) === taskId(101 + index * 2) + ',' + taskId(100 + index * 2));
    const sourceOrder = fixture.board.tasks.map(task => task.id).join(',');
    push(); void 0;
  `);
  await check(`allLanesSorted()`, "every column sorts tasks by descending creation date");
  await check(`frame.board.tasks.map(task => task.id).join(',') === sourceOrder`, "rendering does not reorder the source snapshot");
  await evaluate(`fixture.board.tasks.reverse(); push(); void 0`);
  await check(`allLanesSorted()`, "all columns retain creation order when a refresh changes snapshot order");
  await evaluate(`fixture.board.tasks.push(task('T-0000', 'Самая новая задача от 4 ноября', { createdAt: '2026-11-04T12:00:00.000Z', tags: ['UI'] })); push(); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0103,T-0102'`, "creation date takes precedence over task number");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "board-newest-first.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`fixture.board.tasks.find(task => task.id === 'T-0102').priority = 'high'; fixture.board.tasks.find(task => task.id === 'T-0000').priority = 'high'; push(); const sortingFilter = lane('ready').querySelector('select'); sortingFilter.value = 'high'; sortingFilter.dispatchEvent(new Event('change', { bubbles: true })); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0102'`, "column filters preserve newest-first order for the matching subset");
  await evaluate(`lane('ready').querySelector('.lane-filter-options button').click(); fixture.board.tasks.find(task => task.id === 'T-0103').unfinishedDependencies = ['T-0100']; push(); void 0`);
  await check(`laneIds('blocked') === 'T-0107,T-0103,T-0106'`, "dependency-blocked tasks use creation order within the blocked column");
  await evaluate(`fixture.board.tasks.push(task('T-9999', 'Совпадающая дата', { createdAt: '2026-11-04T12:00:00.000Z' })); push(); const tiedOrder = laneIds('ready'); fixture.board.tasks.reverse(); push(); void 0`);
  await check(`laneIds('ready') === tiedOrder && tiedOrder.startsWith('T-9999,T-0000,')`, "equal creation dates use a stable descending task-number tie-breaker");
  await evaluate(`fixture.board.tasks.push(task('T-9998', 'Без даты', { createdAt: '' }), task('T-9997', 'Повреждённая дата', { createdAt: 'invalid' })); push(); void 0`);
  await evaluate(`lane('ready').querySelector('.lane-more').click(); settle()`);
  await check(`laneIds('ready') === 'T-9999,T-0000,T-0102,T-9998,T-9997'`, "missing or invalid creation dates sort after dated tasks without breaking rendering");
  await evaluate(`fixture.russian = true; fixture.project = 'board-fixture'; fixture.board.tasks = [task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }), task('T-0002', 'Обновляемая карточка', { tags: ['UI'] })]; push(); void 0`);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "board-stable.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    fixture.tabs = [{ path: 'board-fixture', name: 'Первый проект' }, { path: 'cache-second', name: 'Второй проект' }, { path: 'cache-delayed', name: 'Загрузка' }];
    push();
    const tabCard = findCard('T-0001');
    const tabCover = tabCard.querySelector('img');
    const firstBoard = structuredClone(fixture.board);
    const secondBoard = { ...structuredClone(fixture.board), tasks: [task('T-0001', 'Превью другого проекта', { attachments: [{ file: 'cover.png', name: 'cover.png' }] })] };
    const callsBeforeSwitch = window.previewCalls;
    fixture.project = 'cache-second'; fixture.board = secondBoard; push(); void 0;
  `);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`findCard('T-0001') !== tabCard && findCard('T-0001').querySelector('img') !== tabCover && window.previewCalls === callsBeforeSwitch + 1`, "identical attachment paths in another project have a separate preview request and image");
  await evaluate(`
    const secondTabCard = findCard('T-0001');
    const secondTabCover = secondTabCard.querySelector('img');
    firstBoard.tasks[0].title = 'Обновлено в фоновой вкладке'; firstBoard.tasks[0].revision++;
    fixture.project = 'board-fixture'; fixture.board = firstBoard; push(); void 0;
  `);
  await check(`findCard('T-0001') === tabCard && tabCard.querySelector('img') === tabCover && tabCover.naturalWidth > 0 && !tabCover.hidden`, "returning to a project immediately reuses its decoded image and card");
  await check(`tabCard.textContent.includes('Обновлено в фоновой вкладке') && window.previewCalls === callsBeforeSwitch + 1`, "background changes reach the restored card without fetching its cover again");
  await evaluate(`
    for (let round = 0; round < 10; round++) {
      fixture.project = 'cache-second'; fixture.board = secondBoard; push();
      fixture.project = 'board-fixture'; fixture.board = firstBoard; push();
    }
    void 0;
  `);
  await check(`findCard('T-0001') === tabCard && tabCard.querySelector('img') === tabCover && window.previewCalls === callsBeforeSwitch + 1`, "repeated tab switches retain decoded images without additional preview requests");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "project-tabs-cached-images.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    delete window.releasePreview;
    fixture.project = 'cache-delayed';
    fixture.board = { ...firstBoard, tasks: [task('T-0001', 'Отложенное превью', { attachments: [{ file: 'delayed.png', name: 'delayed.png' }] })] };
    push(); void 0;
  `);
  await evaluate(`waitFor(() => !!window.releasePreview)`);
  await evaluate(`
    const delayedCache = cardCoverCache;
    fixture.project = 'board-fixture'; fixture.board = firstBoard; push();
    window.releasePreview(); void 0;
  `);
  await evaluate(`settle()`);
  await check(`cardCoverCache !== delayedCache && findCard('T-0001').querySelector('img') === tabCover && tabCover.dataset.file === 'cover.png'`, "a late response from an inactive board cannot replace the current project's image");
  await evaluate(`
    fixture.tabs = fixture.tabs.filter(tab => tab.path !== 'cache-second'); push();
    const callsBeforeReopen = window.previewCalls;
    void 0;
  `);
  await check(`!boardViews.has('cache-second') && !secondTabCard.isConnected`, "closing a tab releases its cached board view");
  await evaluate(`
    fixture.tabs.push({ path: 'cache-second', name: 'Второй проект' });
    fixture.project = 'cache-second'; fixture.board = secondBoard; push(); void 0;
  `);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`findCard('T-0001') !== secondTabCard && findCard('T-0001').querySelector('img') !== secondTabCover && window.previewCalls === callsBeforeReopen + 1`, "reopening a closed project creates a fresh card and preview");
  await evaluate(`fixture.project = 'board-fixture'; fixture.board = firstBoard; push(); delete fixture.tabs; void 0`);
  await evaluate(`
    const interrupted = task('T-0050', 'Добавить вкладки проектов в одном окне', {
      status: 'in_progress', codexThreadId: '01234567-1234-5678-1234-123456789012',
    });
    fixture.board.tasks.push(interrupted);
    const launchCalls = [];
    let completeLaunch;
    Object.assign(window.taskboard, {
      command: async (name, id) => ({ ok: name === 'show' && id === interrupted.id, data: structuredClone(interrupted) }),
      chatModels: async () => ({ ok: true, data: [] }),
      launchTask: id => {
        launchCalls.push(id);
        return new Promise(resolve => { completeLaunch = resolve; });
      },
    });
    const resume = () => [...byId('sheet-body').querySelectorAll('button')].find(node => node.textContent === 'Продолжить');
    push();
    findCard(interrupted.id).click();
    void 0;
  `);
  await check(`sheet.open && !!resume() && !resume().hidden`, "an interrupted task can be resumed from its open card");
  await evaluate(`resume().click(); void 0`);
  await check(`resume().disabled && launchCalls.join(',') === interrupted.id`, "Continue invokes the board launch for the selected task once");
  await evaluate(`completeLaunch({ ok: false, error: { code: 'CODEX_UNAVAILABLE', message: 'Codex unavailable' } }); void 0`);
  await check(`!resume().disabled && byId('sheet-notice').textContent === 'Codex unavailable'`, "a launch error is shown and allows retry");
  await evaluate(`resume().click(); void 0`);
  await evaluate(`fixture.runningTasks = [interrupted.id]; push(); completeLaunch({ ok: true, data: interrupted }); void 0`);
  await check(`resume().hidden && byId('task-agent-run').querySelector('.agent-spinner') !== null`, "the launch button is hidden while the agent is working");
  await evaluate(`fixture.runningTasks = []; push(); void 0`);
  await check(`!resume().hidden && !resume().disabled`, "a stopped launch can be resumed without reopening the card");
  await evaluate(`interrupted.status = 'ready'; interrupted.git = { worktree: 'saved-worktree' }; interrupted.revision++; push(); void 0`);
  await check(`resume()?.disabled === false`, "a previously started task can also continue from Ready");
  await evaluate(`delete interrupted.git; delete interrupted.codexThreadId; interrupted.unfinishedDependencies = ['T-0001']; interrupted.revision++; push(); void 0`);
  await check(`byId('task-launch')?.textContent === 'Передать в работу' && byId('task-launch').disabled`, "first launches retain their label and dependency check");
  await evaluate(`
    interrupted.status = 'review'; interrupted.codexThreadId = '01234567-1234-5678-1234-123456789012';
    interrupted.unfinishedDependencies = []; interrupted.revision++;
    const feedbackCalls = [];
    window.taskboard.command = async (name, id, input) => {
      if (name === 'request-changes') {
        feedbackCalls.push(input);
        interrupted.status = 'blocked'; interrupted.revision += 2;
        interrupted.blocked = { reason: 'thread ' + interrupted.codexThreadId + ' already has an active writer', condition: 'Resume the task.' };
        push();
      }
      return { ok: true, data: structuredClone(interrupted) };
    };
    (async () => {
      await showTask(interrupted.id);
      noteTask(interrupted, 'request-changes');
      const feedbackForm = body.querySelector('form');
      feedbackForm.querySelector('textarea').value = 'Сохранить изображения при переключении вкладок';
      feedbackForm.addEventListener('submit', event => { window.feedbackNavigationPrevented = event.defaultPrevented; });
      feedbackForm.requestSubmit();
      feedbackForm.requestSubmit();
    })();
  `);
  await evaluate(`waitFor(() => sheetKind === 'task' && !!byId('task-launch'))`);
  await check(`feedbackCalls.length === 1 && sheetKind === 'task' && !body.querySelector('form#note') && taskInSheet.revision === interrupted.revision`, "saved feedback closes its form and opens the current task after a busy-chat failure");
  await check(`window.feedbackNavigationPrevented`, "feedback submission synchronously prevents navigation and ignores duplicate submits");
  await check(`body.querySelector('.task-blocker').textContent.includes('другом процессе') && byId('task-launch').textContent === 'Продолжить в новом чате'`, "busy chat failures show a readable reason and the explicit new-chat action");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "task-busy-chat-recovery.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    let newChatChoice;
    window.taskboard.launchTask = async (id, options) => { newChatChoice = { id, options }; return { ok: true, data: null }; };
    byId('task-launch').click(); void 0;
  `);
  await evaluate(`settle()`);
  await check(`newChatChoice.id === interrupted.id && newChatChoice.options.newThread === true && taskInSheet.status === 'blocked'`, "the recovery action asks main to confirm a new chat and preserves the task on cancellation");
  window.setContentSize(1720, 960);
  await evaluate(`
    sheet.close();
    fixture.project = 'design-board'; fixture.theme = 'dark'; fixture.runningTasks = [];
    fixture.tabs = [{ path: 'design-board', name: 'AI Taskboard' }, { path: 'design-other', name: 'Electron2D' }];
    fixture.board = { gitInfo: { branch: 'main', user: 'Developer' }, tags: [{ name: 'интерфейс', color: 'blue' }, { name: 'карточки', color: 'purple' }],
      archived: [task('T-0580', 'Похожий номер', { status: 'done' }), task('T-0058', 'Настроить порядок вкладок', { status: 'done' })], tasks: [
      task('T-0056', 'Убрать надпись «Загрузка проектов»', { tags: ['интерфейс'], createdAt: '2026-11-05' }),
      task('T-0055', 'Исправить обрезку превью по скруглению карточки', { tags: ['интерфейс', 'карточки'], priority: 'high', attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
      task('T-0051', 'Исправить создание чатов вне папки проекта', { status: 'blocked', blocked: { reason: 'Нужно обновить Codex', condition: 'Установить обновление и продолжить задачу.' }, attachments: [{ file: 'notes.txt', name: 'notes.txt' }], priority: 'high' }),
      task('T-0017', 'Добавить отдельную прокрутку колонок доски', { status: 'cancelled', attachments: [{ file: 'notes.txt', name: 'notes.txt' }] }),
      ...Array.from({ length: 52 }, (_, index) => task('D-' + index, [
        'Добавить поддержку ссылок Markdown и открытие MD-файлов', 'Передавать вложения агенту при создании задачи',
        'Выровнять текст в карточке задачи', 'Добавить вкладки проектов в одном окне'
      ][index % 4], { status: 'done', attachments: index === 0 ? [{ file: 'cover.png', name: 'cover.png' }] : [] }))
    ] };
    const designBoard = structuredClone(fixture.board);
    const designOther = { tags: [], archived: [], tasks: [task('T-0001', 'Другая доска', { description: 'Описание другой задачи' })] };
    const draftCalls = [];
    window.taskboard.command = async (_name, id) => ({ ok: true, data: { ...fixture.board.tasks.find(task => task.id === id), criteria: [] } });
    window.taskboard.selectTab = async project => {
      fixture.project = project; fixture.board = project === 'design-board' ? designBoard : designOther; push();
    };
    const draftForm = () => byId('board-composer').querySelector('form');
    const draftText = () => draftForm().querySelector('.draft-input textarea');
    const draftPaste = (files, text = '') => {
      const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
      if (text) transfer.setData('text/plain', text);
      draftText().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    };
    const themeColor = name => {
      const probe = document.createElement('span'); probe.style.color = 'var(' + name + ')'; document.body.append(probe);
      const value = getComputedStyle(probe).color; probe.remove(); return value;
    };
    push(); showTask('T-0055'); void 0;
  `);
  await evaluate(`waitFor(() => sheetKind === 'task' && taskInSheet?.id === 'T-0055')`);
  await evaluate(`sheet.close(); waitFor(() => findCard('T-0055').querySelector('img')?.naturalWidth > 0)`);
  await check(`!byId('search') && !byId('filters') && !byId('create') && !byId('board-actions')`, "top search, global filters and creation button are removed");
  await check(`byId('lanes').children.length === 7 && getComputedStyle(lane('ready')).backgroundColor === 'rgba(0, 0, 0, 0)'`, "reference composition uses seven open columns");
  await check(`!byId('status-branch').hidden && byId('status-branch').textContent === 'main' && !byId('status-user').hidden && byId('status-user').textContent === 'Developer' && !byId('status-notifications').hidden && document.querySelector('.status-bar').getBoundingClientRect().bottom === innerHeight`, "status bar retains Git branch, user and notifications at the bottom of the window");
  await check(`document.fonts.check('16px codicon') && ['.codicon-git-branch', '.codicon-cloud-upload'].every(selector => { const node = document.querySelector(selector); return getComputedStyle(node).fontFamily === 'codicon' && getComputedStyle(node, '::before').content.length > 2 && node.getBoundingClientRect().width === 16; })`, "status Git branch and publication icons load the actual Codicons font and glyphs");
  await check(`byId('project-tabs').getAttribute('aria-orientation') === 'vertical' && byId('project-tabs').getBoundingClientRect().right <= byId('app-content').getBoundingClientRect().left`, "project tabs form a vertical rail to the left of the board");
  await check(`getComputedStyle(byId('project-tabs').querySelector('[role=tab]')).writingMode === 'vertical-rl'`, "project names are rotated vertically");
  await check(`(() => { const tab = byId('project-tabs').firstElementChild, close = tab.querySelector('.codicon-close'), label = tab.querySelector('.project-tab-name'); const gap = label.getBoundingClientRect().top - close.getBoundingClientRect().bottom; return getComputedStyle(close).fontFamily === 'codicon' && getComputedStyle(close, '::before').content.length > 2 && gap >= 6 && gap <= 8 && tab.getBoundingClientRect().height < 124; })()`, "compact tabs use the shared close icon with a six-to-eight pixel gap to the name");
  await check(`findCard('T-0055').dataset.selected === 'true' && getComputedStyle(findCard('T-0055')).borderTopColor === themeColor('--accent')`, "selection retains a theme accent border after details close");
  await check(`getComputedStyle(findCard('T-0051'), '::before').backgroundColor === themeColor('--warn') && !!lane('done').querySelector('.task-done[aria-label]')`, "blocked and done states have distinct stripe and accessible checkmark indicators");
  await check(`findCard('T-0055').querySelector('.task-card-heading').nextElementSibling.className === 'task-tags' && findCard('T-0055').querySelector('.task-tags').nextElementSibling.tagName === 'IMG'`, "card title, tags and inset cover follow reference order");
  await check(`(() => { const image = findCard('T-0055').querySelector('img'), card = findCard('T-0055'); return image.getBoundingClientRect().left > card.getBoundingClientRect().left && image.getBoundingClientRect().right < card.getBoundingClientRect().right && parseInt(getComputedStyle(image).borderRadius) > 0; })()`, "cover fits inside the card padding with its own rounded border");
  await check(`lane('done').querySelectorAll('.task-card').length === 4 && lane('done').querySelector('.lane-more').textContent === 'Ещё 48 задач' && lane('done').querySelector('.count').textContent === '52'`, "column initially shows four cards and the full matching count");
  await evaluate(`settle()`);
  await capture("board-reference-dark.png");
  await evaluate(`lane('done').querySelector('.lane-more').click(); settle()`);
  await check(`lane('done').querySelectorAll('.task-card').length === 8 && lane('done').querySelector('.lane-more').textContent === 'Ещё 44 задачи'`, "More reveals the next four cards and updates the remaining count");
  await evaluate(`push(); void 0`);
  await check(`lane('done').querySelectorAll('.task-card').length === 8`, "ordinary snapshots preserve expanded card batches");
  await evaluate(`lane('ready').querySelector('summary').click(); void 0`);
  await check(`lane('ready').querySelector('details').open && lane('ready').querySelector('.lane-filter-options').contains(lane('ready').querySelector('.lane-collapse'))`, "ellipsis opens column filters and collapse in one menu");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); void 0`);
  await check(`!lane('ready').querySelector('details').open && document.activeElement === lane('ready').querySelector('summary')`, "Escape closes the column menu and restores focus");
  await window.webContents.insertCSS(":root { --hover-time: 0ms; }");
  for (const theme of ["github-light", "nord"]) {
    nativeTheme.themeSource = theme.endsWith("light") ? "light" : "dark";
    await evaluate(`fixture.theme = '${theme}'; push(); new Promise(resolve => setTimeout(resolve, 220))`);
    await check(`getComputedStyle(findCard('T-0055')).borderTopColor === themeColor('--accent') && getComputedStyle(findCard('T-0055')).backgroundColor === themeColor('--panel') && getComputedStyle(findCard('T-0055')).color === themeColor('--text') && getComputedStyle(findCard('T-0051'), '::before').backgroundColor === themeColor('--warn') && getComputedStyle(draftForm().querySelector('.board-draft-field')).backgroundColor === themeColor('--panel') && getComputedStyle(draftForm().querySelector('.board-chat')).backgroundColor === themeColor('--bg')`, theme + " uses active theme colors for cards, states, the composer and the chat panel");
    await capture("board-reference-" + theme + ".png");
  }
  for (const width of [1380, 1280, 1180]) {
    window.setContentSize(width, 900);
    await evaluate(`settle()`);
    await check(`byId('lanes').scrollWidth === byId('lanes').clientWidth && [...byId('lanes').children].every(column => column.getBoundingClientRect().right <= innerWidth)`, "all seven columns fit without horizontal scrolling at " + width + " pixels");
    await check(`lane('blocked').querySelector('.lane-title > span').getClientRects().length === 1`, "a single-word column title stays intact at " + width + " pixels");
    if (width === 1380) await capture("board-adaptive-1380.png");
  }
  await check(`Math.abs(byId('lanes').getBoundingClientRect().bottom - document.querySelector('.status-bar').getBoundingClientRect().top) <= 1 && getComputedStyle(byId('board-composer')).position === 'absolute'`, "columns extend to the status bar underneath a floating composer");
  await evaluate(`byId('lanes').scrollTop = byId('lanes').scrollHeight; settle()`);
  await check(`(() => { const cards = lane('done').querySelectorAll('.task-card'); return cards[cards.length - 1].getBoundingClientRect().bottom <= draftForm().getBoundingClientRect().top; })()`, "the final card can scroll completely above the floating field");
  await evaluate(`byId('lanes').scrollTop = 0; void 0`);
  await check(`draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0 &&
    draftForm().querySelector('.draft-placeholder').textContent === 'Напишите менеджеру проекта…' &&
    draftText().getAttribute('aria-label') === 'Сообщение менеджеру проекта'`, "collapsed composer addresses the project manager while suggestions are pending");
  await evaluate(`
    const draftPrompt = () => draftForm().querySelector('.draft-placeholder').textContent;
    const initialPrompt = draftPrompt();
    const projectPrompt = 'Создай задачу на локализацию AI Taskboard';
    window.releaseSuggestions();
    void 0;
  `);
  await check(`(async () => {
    await waitFor(() => draftPrompt() && draftPrompt() !== initialPrompt && initialPrompt.startsWith(draftPrompt()));
    await waitFor(() => draftPrompt() && draftPrompt() !== projectPrompt && projectPrompt.startsWith(draftPrompt()));
    await waitFor(() => draftPrompt() === projectPrompt);
    return !draftText().value;
  })()`, "the empty composer erases its hint and types a generated project prompt");
  await evaluate(`
    const draftBounds = () => JSON.stringify(draftForm().querySelector('.board-draft-field').getBoundingClientRect());
    draftText().value = 'Первая строка\\nВторая строка';
    const collapsedDraftBounds = draftBounds();
    void 0;
  `);
  await hover(".draft-input textarea");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "hovering over the manager field leaves the chat closed");
  await evaluate(`draftText().focus(); settle()`);
  await check(`document.activeElement === draftText() && getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "focusing the manager field leaves the chat closed");
  await clickManagerField();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height > 200)`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).transitionProperty.includes('height') &&
    !draftForm().textContent.includes('Открыть в Codex') && !draftForm().querySelector('.board-chat h2, .board-chat-model')`,
    "clicking the manager field expands the chat without a title or model label");
  await check(`(() => {
    const chat = draftForm().querySelector('.board-chat');
    const panel = chat.getBoundingClientRect();
    const style = getComputedStyle(chat);
    const field = draftForm().querySelector('.board-draft-field').getBoundingClientRect();
    return draftBounds() === collapsedDraftBounds && field.left < panel.left && panel.right < field.right &&
      getComputedStyle(draftForm().querySelector('.draft-placeholder')).visibility === 'hidden' &&
      panel.top < field.top && panel.bottom > field.top && panel.bottom < field.bottom &&
      style.borderBottomLeftRadius === '0px' && style.borderBottomRightRadius === '0px' &&
      document.elementFromPoint(field.left + field.width / 2, field.top + 2)?.closest('.board-draft-field') !== null;
  })()`, "the narrower chat slides up behind the stationary multiline composer with square lower corners");
  await hover(".board-chat-log");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "moving the pointer into chat keeps it open");
  await evaluate(`draftText().focus(); void 0`);
  await hover("#app-menu");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "input focus keeps chat open after the pointer leaves");
  await capture("board-orchestrator-open.png");
  await evaluate(`draftText().blur(); void 0`);
  await hover("#lanes .lane-title");
  await evaluate(`new Promise(resolve => setTimeout(resolve, 250))`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "chat stays open after the pointer and input focus leave");
  await clickBoard();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0)`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden' && draftBounds() === collapsedDraftBounds`, "clicking outside the chat on the board collapses it without shifting the composer");
  await evaluate(`
    draftText().value = '';
    draftText().focus();
    draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => Math.abs(draftForm().querySelector('.board-chat').getBoundingClientRect().height - Math.min(390, innerHeight * .44)) < 2)`);
  await check(`!draftText().readOnly && !draftCalls.length`, "Enter in an empty focused field opens the chat without sending");
  await evaluate(`
    const taskMentions = () => draftForm().querySelector('.draft-task-mentions');
    const mentionKey = key => draftText().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const typeMention = (text, caret = text.length) => {
      const field = draftText();
      field.focus();
      field.value = text;
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    typeMention('Проверь (@58), пожалуйста', 'Проверь (@58'.length);
    void 0;
  `);
  await check(`taskMentions().matches(':popover-open') && taskMentions().firstElementChild.textContent === 'T-0058 · Настроить порядок вкладок' &&
    taskMentions().getBoundingClientRect().bottom <= draftText().getBoundingClientRect().top`, "typing @58 shows the exact task first above the manager input");
  await evaluate(`mentionKey('ArrowDown'); void 0`);
  await check(`taskMentions().querySelector('[aria-selected=true]').textContent.startsWith('T-0580')`, "arrow keys change the selected task");
  await evaluate(`mentionKey('ArrowUp'); mentionKey('Enter'); void 0`);
  await check(`draftText().value === 'Проверь (T-0058), пожалуйста' && !taskMentions().matches(':popover-open') && !draftCalls.length`, "Enter inserts the task reference at the caret without sending the message");
  await evaluate(`typeMention('@0058'); mentionKey('Escape'); typeMention('@0058'); void 0`);
  await check(`draftText().value === '@0058' && !taskMentions().matches(':popover-open')`, "Escape dismisses the current mention without altering the draft");
  await evaluate(`typeMention('user@58'); void 0`);
  await check(`!taskMentions().matches(':popover-open')`, "an at sign inside a word does not trigger task suggestions");
  await evaluate(`typeMention('@T-0058'); taskMentions().firstElementChild.click(); void 0`);
  await check(`draftText().value.trim() === 'T-0058' && document.activeElement === draftText()`, "clicking a suggestion inserts its canonical ID and keeps the composer focused");
  await evaluate(`typeMention(''); void 0`);
  await evaluate(`draftForm().querySelector('.draft-add').click(); settle()`);
  await check(`(() => {
    const menu = draftForm().querySelector('.draft-add-menu');
    const add = draftForm().querySelector('.draft-add');
    return menu.matches(':popover-open') && menu.getBoundingClientRect().bottom <= add.getBoundingClientRect().top &&
      [...menu.querySelectorAll('.draft-menu-actions button')].map(button => button.textContent).join('|') === 'Файлы|Задачи|Режим цели' &&
      !!draftForm().querySelector('.draft-add .codicon-add') && !!draftForm().querySelector('.draft-send .codicon-arrow-up') &&
      !!draftForm().querySelector('.draft-mic .codicon-mic');
  })()`, "the plus opens the three actions above the composer with font icons for plus, microphone and send");
  await evaluate(`
    const addMenuItems = () => draftForm().querySelectorAll('.draft-menu-actions button');
    addMenuItems()[1].click();
    const taskSearch = draftForm().querySelector('.draft-task-picker input');
    taskSearch.value = 'T-0055';
    taskSearch.dispatchEvent(new Event('input'));
    draftForm().querySelector('.draft-task-results button').click();
    void 0;
  `);
  await check(`draftText().value.trim() === 'T-0055' && !draftForm().querySelector('.draft-add-menu').matches(':popover-open')`, "selecting a task inserts its ID in the draft");
  await evaluate(`
    let openedFiles = 0;
    draftForm().querySelector('input[type=file]').click = () => openedFiles++;
    draftForm().querySelector('.draft-add').click();
    addMenuItems()[0].click();
    draftForm().querySelector('.draft-add').click();
    addMenuItems()[2].click();
    draftText().value = '';
    draftText().dispatchEvent(new Event('input'));
    void 0;
  `);
  await check(`openedFiles === 1 && !draftForm().querySelector('.draft-goal-chip').hidden && draftForm().querySelector('.draft-send').disabled &&
    draftForm().querySelector('.draft-placeholder').textContent === 'Опишите цель…'`, "files open the picker and goal mode prompts for a nonempty objective");
  await evaluate(`
    let recordedGoal;
    const normalRequest = window.taskboard.boardRequest;
    window.taskboard.boardRequest = async (text, files, project, goal) => {
      recordedGoal = { text, goal };
      window.pushChat({ project, type: 'orchestrator-goal', goal: {
        objective: goal === 'resume' ? 'Проверить карточки' : text, status: 'active',
      } });
      return { ok: true, data: { answer: 'Цель принята', changes: [] } };
    };
    draftText().value = 'Обновить карточки';
    draftForm().requestSubmit();
    waitFor(() => recordedGoal && draftForm().getAttribute('aria-busy') === 'false');
  `);
  await check(`recordedGoal.text === 'Обновить карточки' && recordedGoal.goal && draftForm().querySelector('.draft-goal-chip').hidden`, "sending a goal passes the objective to the manager and returns to message mode");
  await check(`!draftForm().querySelector('.board-goal').hidden && draftForm().querySelector('.board-goal-status').textContent === 'Активная цель'`, "the goal row shows the status confirmed by the provider");
  await evaluate(`
    const goalPanel = draftForm().querySelector('.board-goal');
    const [saveGoal, pauseGoal, resumeGoal, clearGoal] = goalPanel.querySelectorAll('button');
    const goalEditor = goalPanel.querySelector('textarea');
    let savedGoal = { objective: 'Обновить карточки', status: 'active' };
    window.taskboard.boardGoal = async (kind, objective) => {
      if (kind === 'edit' && objective === 'Ошибка') return { ok: false, error: { code: 'BOARD_GOAL_FAILED', message: 'Ошибка сохранения' } };
      if (kind === 'edit') savedGoal = { ...savedGoal, objective };
      if (kind === 'pause') savedGoal = { ...savedGoal, status: 'paused' };
      if (kind === 'clear') savedGoal = null;
      return { ok: true, data: savedGoal };
    };
    goalPanel.querySelector('summary').click();
    goalEditor.value = 'Ошибка';
    goalEditor.dispatchEvent(new Event('input'));
    saveGoal.click();
    waitFor(() => goalPanel.querySelector('[role=alert]').textContent.includes('Ошибка сохранения'));
  `);
  await check(`goalPanel.open && goalEditor.value === 'Ошибка' && goalPanel.querySelector('.board-goal-title').textContent === 'Обновить карточки'`, "a failed edit preserves both the stored goal and the proposed text");
  await evaluate(`
    goalEditor.value = 'Проверить карточки';
    goalEditor.dispatchEvent(new Event('input'));
    saveGoal.click();
    waitFor(() => goalPanel.querySelector('.board-goal-title').textContent === 'Проверить карточки');
  `);
  await evaluate(`pauseGoal.click(); waitFor(() => goalPanel.dataset.status === 'paused')`);
  await check(`pauseGoal.hidden && !resumeGoal.hidden && !resumeGoal.disabled`, "the paused goal can be resumed");
  await evaluate(`resumeGoal.click(); waitFor(() => recordedGoal.goal === 'resume' && draftForm().getAttribute('aria-busy') === 'false')`);
  await check(`recordedGoal.text === '' && goalPanel.dataset.status === 'active'`, "resuming restarts the saved goal without sending its text again");
  await evaluate(`clearGoal.click(); waitFor(() => goalPanel.hidden)`);
  await evaluate(`
    window.taskboard.boardRequest = normalRequest;
    const mediaDevices = {
      getUserMedia: async () => {
        voiceAudio = new AudioContext();
        const tone = voiceAudio.createOscillator();
        const output = voiceAudio.createMediaStreamDestination();
        tone.connect(output);
        tone.start();
        await voiceAudio.resume();
        return voiceStream = output.stream;
      },
    };
    let voiceStream, voiceAudio, voiceCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    window.taskboard.transcribeVoice = async (samples, locale) => {
      if (!(samples instanceof Float32Array) || !samples.length || locale !== 'ru') throw new Error('Wrong transcription input');
      voiceCalls++;
      return { ok: true, data: 'Голосовой черновик' };
    };
    const voiceStop = () => draftForm().querySelector('.draft-voice-stop');
    const voiceCancel = () => draftForm().querySelector('.draft-voice-cancel');
    draftText().value = 'Начало ';
    draftText().setSelectionRange(7, 7);
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !voiceStop().disabled);
  `);
  await check(`draftForm().hasAttribute('data-dictating') && draftForm().querySelector('.draft-voice-wave').checkVisibility() && !voiceCalls`, "one microphone click starts recording with the waveform in the composer");
  await evaluate(`
    new Promise(resolve => setTimeout(resolve, 1000)).then(() => {
      voiceStop().click();
      return waitFor(() => !draftForm().hasAttribute('data-dictating'));
    });
  `);
  await check(`draftText().value.trim() === 'Начало Голосовой черновик' && voiceCalls === 1 && !draftCalls.length &&
    voiceStream.getAudioTracks()[0].readyState === 'ended'`, "stopping releases the microphone and inserts the transcript in the existing draft");
  await evaluate(`
    void voiceAudio.close();
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !voiceStop().disabled);
  `);
  await evaluate(`voiceCancel().click(); waitFor(() => !draftForm().hasAttribute('data-dictating'))`);
  await check(`draftText().value.trim() === 'Начало Голосовой черновик' && voiceCalls === 1 &&
    voiceStream.getAudioTracks()[0].readyState === 'ended'`, "cancelling releases the microphone and preserves the draft");
  await evaluate(`
    void voiceAudio.close();
    mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !draftForm().hasAttribute('data-dictating') && !draftForm().querySelector('.draft-voice-status').hidden);
  `);
  await check(`draftForm().querySelector('.draft-voice-status').textContent.includes('Не удалось открыть микрофон') &&
    draftForm().querySelector('.draft-mic').checkVisibility() && draftText().value.trim() === 'Начало Голосовой черновик'`, "microphone denial restores the composer and preserves the draft");
  await check(`(() => {
    const button = draftForm().querySelector('.draft-send');
    const outer = button.getBoundingClientRect();
    const glyph = button.firstElementChild.getBoundingClientRect();
    return outer.width === 28 && outer.height === 28 && getComputedStyle(button).borderRadius === '50%' &&
      glyph.width === 16 && glyph.height === 16 &&
      Math.abs((glyph.left + glyph.right - outer.left - outer.right) / 2 + .5) < .1 &&
      Math.abs((glyph.top + glyph.bottom - outer.top - outer.bottom) / 2) < .1;
  })()`, "the circular send button centers its glyph");
  await evaluate(`
    delete navigator.mediaDevices;
    draftForm().querySelector('.draft-voice-status').hidden = true;
    draftText().value = ''; draftText().dispatchEvent(new Event('input')); void 0;
  `);
  await evaluate(`draftForm().querySelector('.board-chat-pin').click(); void 0`);
  await clickBoard();
  await check(`draftForm().querySelector('.board-chat-pin').getAttribute('aria-pressed') === 'true' &&
    !!draftForm().querySelector('.board-chat-pin .codicon-pinned') && getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`,
    "the active pin glyph appears and keeps the chat open when the board is clicked");
  const grip = await evaluate(`(() => {
    const rect = draftForm().querySelector('.board-chat-resize').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...grip });
  await evaluate(`settle()`);
  window.webContents.sendInputEvent({ type: "mouseMove", button: "left", x: grip.x, y: grip.y - 80 });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: grip.x, y: grip.y - 80 });
  await evaluate(`waitFor(() => !draftForm().hasAttribute('data-resizing') && draftForm().querySelector('.board-chat').getBoundingClientRect().height > 445)`)
    .catch(async error => { throw new Error("Drag did not settle: " + await evaluate(`JSON.stringify({
      height: draftForm().querySelector('.board-chat').getBoundingClientRect().height,
      resizing: draftForm().hasAttribute('data-resizing'),
    })`), { cause: error }); });
  await check(`parseFloat(getComputedStyle(draftForm().querySelector('.board-chat-log')).borderTopWidth) === 0`, "mouse drag increases chat height and leaves the transcript unframed");
  await evaluate(`draftForm().querySelector('.board-chat-pin').click(); void 0`);
  await clickBoard();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0)`)
    .catch(error => { throw new Error("Unpinned chat did not collapse", { cause: error }); });
  window.setContentSize(760, 760);
  await evaluate(`settle()`);
  await check(`byId('lanes').scrollWidth > byId('lanes').clientWidth && draftForm().getBoundingClientRect().right <= innerWidth && draftForm().getBoundingClientRect().bottom <= document.querySelector('.status-bar').getBoundingClientRect().top`, "narrow windows scroll the columns and retain a usable bottom composer");
  await capture("board-reference-narrow.png");
  await evaluate(`draftForm().requestSubmit(); void 0`);
  await check(`!draftText().readOnly`, "empty requests do not start preparation");
  await evaluate(`
    let finishWaiting;
    window.taskboard.boardRequest = (request, files) => {
      draftCalls.push({ request, files });
      return new Promise(resolve => { finishWaiting = resolve; });
    };
    window.taskboard.stopOrchestrator = async () => {
      finishWaiting({ ok: false, error: { code: 'BOARD_WAIT_CANCELLED', message: '' } });
      return { ok: true };
    };
    draftText().value = 'Сохранить мой запрос';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], 'image.png', { type: 'image/png' }));
    draftForm().dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => draftForm().querySelector('.board-attachment-preview img')?.naturalWidth > 0)`);
  await check(`!!draftForm().querySelector('.board-attachment-preview[aria-label="Просмотреть image.png"]')`, "dropping an image displays a preview before sending");
  await clickManagerField();
  await evaluate(`
    draftForm().requestSubmit(); draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !!finishWaiting)`);
  await evaluate(`window.pushChat({ project: fixture.project, type: 'orchestrator-waiting' }); void 0`);
  await check(`!draftText().readOnly && draftForm().querySelector('.chat-thinking').textContent.includes('Жду освобождения') &&
    !draftForm().querySelector('[aria-label="Отменить отправку"]').disabled && draftForm().querySelector('.draft-progress').hidden`, "busy chat keeps the pending request visible with a cancel button");
  await evaluate(`draftForm().querySelector('[aria-label="Отменить отправку"]').click(); void 0`);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false')`);
  await check(`draftCalls.length === 1 && draftCalls[0].files[0].name === 'image.png' && draftText().value === 'Сохранить мой запрос' && draftForm().querySelectorAll('.board-attachment img').length === 1 && draftForm().querySelector('.draft-progress').hidden && !draftForm().querySelector('.chat-thinking')`, "cancelling the wait restores the draft and its preview without an error");
  await evaluate(`byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-other' && !draftText().value && !draftForm().querySelectorAll('li').length && !draftForm().querySelectorAll('.chat-entry').length && findCard('T-0001').querySelector('.task-description').textContent === 'Описание другой задачи'`, "Down switches projects with isolated input, attachments, chat and description preview");
  await evaluate(`draftText().value = 'Другой запрос'; byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-board' && draftText().value === 'Сохранить мой запрос' && draftForm().querySelectorAll('li').length === 1 && findCard('T-0055').dataset.selected === 'true'`, "Up restores the source project's draft, attachment and selection");
  await evaluate(`draftForm().querySelector('.board-attachment-remove').click(); settle()`);
  await check(`draftForm().querySelector('.draft-attachments').hidden`, "attached files can be removed before sending");
  await evaluate(`draftPaste([new File([new Uint8Array(64 * 1024 * 1024 + 1)], 'large.bin')]); void 0`);
  await check(`draftForm().querySelectorAll('li').length === 0 && draftForm().textContent.includes('64 МиБ')`, "oversized attachments are rejected without changing the draft");
  await evaluate(`
    const pickerTransfer = new DataTransfer(); pickerTransfer.items.add(new File(['notes'], 'notes.txt'));
    const designPicker = draftForm().querySelector('[type=file]'); designPicker.files = pickerTransfer.files; designPicker.dispatchEvent(new Event('change'));
    draftText().value = '';
    let resolveDesignDraft;
    window.taskboard.boardRequest = (request, files) => { draftCalls.push({ request, files }); return new Promise(resolve => { resolveDesignDraft = resolve; }); };
    draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !!resolveDesignDraft)`);
  await check(`draftCalls.at(-1).request === '' && draftCalls.at(-1).files[0].name === 'notes.txt' && !draftText().readOnly && draftForm().getAttribute('aria-busy') === 'true'`, "attachment-only requests leave the composer editable during preparation");
  await evaluate(`window.taskboard.selectTab('design-other'); resolveDesignDraft({ ok: true, data: { answer: 'Готово', changes: [{ id: 'T-0999', action: 'create' }] } }); settle()`);
  await check(`!sheet.open && fixture.project === 'design-other' && draftText().value === 'Другой запрос'`, "a background draft completion cannot open a task or erase another project's input");
  await evaluate(`window.taskboard.selectTab('design-board'); settle()`);
  await check(`!draftText().value && draftForm().querySelector('.draft-attachments').hidden && draftForm().getAttribute('aria-busy') === 'false'`, "successful background preparation clears only its original composer");
  await clickBoard();
  await evaluate(`waitFor(() => getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden')`);
  await evaluate(`
    window.taskboard.boardRequest = async (request, files) => { draftCalls.push({ request, files }); return { ok: true, data: { answer: 'Готово', changes: [{ id: 'T-0056', action: 'create' }] } }; };
    draftText().value = 'Создать задачу'; draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && !!draftForm().querySelector('[data-task="T-0056"]'))`);
  await check(`!sheet.open && !draftText().value && draftCalls.at(-1).request === 'Создать задачу' && draftForm().querySelector('.board-chat-log').textContent.includes('Черновик создан')`, "Enter creates a draft and shows the result in the orchestrator chat");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "sending from the closed field keeps the chat closed");
  await clickManagerField();
  await evaluate(`waitFor(() => !draftForm().querySelector('.board-chat').getAnimations().length && draftForm().querySelector('.board-chat').getBoundingClientRect().height > 0); `);
  await evaluate(`settle()`);
  await check(`(() => { const log = draftForm().querySelector('.board-chat-log'), result = log.querySelector('[data-task="T-0056"]'); return result.getBoundingClientRect().bottom <= log.getBoundingClientRect().bottom + 1; })()`, "opening chat scrolls to the latest result");
  await check(`getComputedStyle(draftForm().querySelector('.chat-text')).fontFamily.includes('Segoe UI')`, "orchestrator messages retain the application font");
  await capture("board-orchestrator-result.png");
  await evaluate(`draftForm().querySelector('[data-task="T-0056"]').click(); void 0`);
  await evaluate(`waitFor(() => sheet.open && taskInSheet?.id === 'T-0056')`);
  await check(`taskInSheet.id === 'T-0056'`, "a chat result opens the created task on request");
  await evaluate(`const previousTaskLinks = draftForm().querySelectorAll('.board-chat-task').length; void 0`);
  await evaluate(`
    sheet.close();
    window.taskboard.boardRequest = async () => ({ ok: true, data: { answer: 'На доске три готовых задачи.', changes: [] } });
    draftText().value = 'Что на доске?'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && draftForm().textContent.includes('На доске три готовых задачи.'))`);
  await check(`!draftText().value && draftForm().querySelectorAll('.board-chat-task').length === previousTaskLinks`, "a discussion reply does not add a task result");
  await evaluate(`
    window.taskboard.boardRequest = async () => ({ ok: true, data: { answer: '', changes: [{ id: 'T-0055', action: 'cancel' }] } });
    draftText().value = 'Задача 55 не актуальна, отменяй'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && !!draftForm().querySelector('[data-task="T-0055"]'))`);
  await check(`draftForm().querySelector('[data-task="T-0055"]').parentElement.textContent.includes('Задача отменена') && !sheet.open`, "a cancellation links to the affected task and shows its action");
  await evaluate(`
    const savedItems = [
      { id: 'a', type: 'dynamicToolCall', title: 'board_list', text: 'Board contents', status: 'completed' },
      { id: 'b', type: 'commandExecution', title: 'Get-Content README.md', text: 'Documentation', status: 'completed' },
      { id: 'c', type: 'agentMessage', text: [
        'Ответ из истории. По текущей доске:', '',
        '- **Три задачи готовы к работе.** В очереди поддержка F11 и правки карточек.',
        '- **Одна задача заблокирована.** Она ждёт обновления интеграции с Codex.',
        '',
        'Могу уточнить детали по любой задаче.',
      ].join('\\n'), status: 'completed', phase: 'final_answer' },
    ];
    window.taskboard.boardHistory = async () => ({ ok: true, data: { id: 'thread', turns: [
      { messages: [{ text: 'Вопрос из истории', files: [{ name: 'notes.txt' }] }], changes: [], items: savedItems, durationMs: 13000 },
      { messages: [{ text: 'Задача 55 не актуальна', files: [] }],
        changes: [{ id: 'T-0055', title: 'Исправить обрезку превью по скруглению карточки', action: 'cancel' }],
        items: [{ id: 'd', type: 'agentMessage', text: 'T-0055 отменена как неактуальная.', status: 'completed', phase: 'final_answer' }] },
    ] } });
    window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
    draftText().focus(); void 0;
  `);
  await evaluate(`waitFor(() => !!draftForm().querySelector('.chat-work .chat-run-group'))`);
  await check(`draftForm().querySelectorAll('.chat-run-item').length === 2 && draftForm().querySelector('.chat-run-final').textContent.includes('Ответ из истории') && draftForm().textContent.includes('Вопрос из истории') && draftForm().querySelector('.chat-attachment').textContent.includes('notes.txt')`, "provider history uses the agent chat work group, tool details, attachments and final answer");
  await check(`(() => {
    const log = draftForm().querySelector('.board-chat-log');
    const answer = log.querySelector('.chat-run-final .chat-text');
    const style = getComputedStyle(log);
    const width = log.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return Math.abs(answer.getBoundingClientRect().width - width) < 1 && log.scrollWidth === log.clientWidth;
  })()`, "the manager's answer fills the transcript between its side insets without horizontal scrolling");
  await evaluate(`draftForm().querySelector('.board-chat-log').scrollTop = 0; settle()`);
  await capture("board-manager-spacing.png");
  await evaluate(`
    const work = draftForm().querySelector('.chat-work');
    const group = work.querySelector('.chat-run-group');
    const disclosureTransition = async detail => {
      const before = detail.open;
      detail.querySelector('summary').click();
      const animation = detail.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.height));
      if (!animation) return false;
      await animation.finished;
      await settle();
      return detail.open !== before;
    };
    void 0;
  `);
  await check(`disclosureTransition(work)`, "the completed turn animates when opened");
  await check(`disclosureTransition(group)`, "the nested tool group animates when opened");
  await check(`disclosureTransition(group)`, "the nested tool group animates when closed");
  await evaluate(`group.open = true; settle()`);
  await evaluate(`
    const screenshotFiles = new DataTransfer();
    screenshotFiles.items.add(new File([png], 'image.png', { type: 'image/png' }));
    draftForm().dispatchEvent(new DragEvent('drop', { dataTransfer: screenshotFiles, bubbles: true, cancelable: true }));
    settle();
  `);
  await capture("board-orchestrator-tools.png");
  await evaluate(`draftForm().querySelector('.board-attachment-remove').click(); void 0`);
  await evaluate(`
    const managerRequests = [];
    let stoppedOrchestrator = 0;
    window.taskboard.boardRequest = (text, files, project) => new Promise(resolve => {
      managerRequests.push({ text, files, project, resolve });
    });
    window.taskboard.stopOrchestrator = async () => {
      stoppedOrchestrator++;
      managerRequests[0].resolve({ ok: true, data: { id: 'thread', answer: '', changes: [], items: savedItems.slice(0, 2), error: 'Ответ остановлен.' } });
      return { ok: true };
    };
    draftText().value = 'Покажи, что происходит'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => managerRequests.length === 1)`);
  await check(`draftText().value === '' && [...draftForm().querySelectorAll('.chat-entry[data-actor="user"][data-enter]')].some(entry => entry.textContent.includes('Покажи, что происходит'))`, "the composer clears and animates the new user message before the reply");
  await evaluate(`
    window.pushChat({ project: fixture.project, type: 'orchestrator-ready', model: 'gpt-active-test' });
    window.pushChat({ project: fixture.project, type: 'orchestrator', items: savedItems.slice(0, 2) });
    void 0;
  `);
  await check(`!!draftForm().querySelector('.chat-run-group[data-enter]') && !draftForm().querySelector('[aria-label="Остановить ответ"]').disabled &&
    !draftForm().querySelector('.board-chat-model')`, "live activity animates tool groups and offers interruption without a model label");
  await check(`(() => {
    const update = text => window.pushChat({ project: fixture.project, type: 'orchestrator', items: [
      { id: 'streaming', type: 'agentMessage', title: '', text, status: 'inProgress', phase: 'final_answer' },
    ] });
    update('Проверяю');
    const first = draftForm().querySelector('.chat-stream-fragment');
    if (first?.textContent !== 'Проверяю' || first.getAnimations()[0]?.animationName !== 'board-chat-text-fade') return false;
    update('Проверяю **карточки**');
    const block = draftForm().querySelector('[data-item="message:streaming"]');
    const earlier = block.querySelector('.chat-stream-fragment');
    const tail = block.querySelector('strong .chat-stream-fragment');
    const fades = earlier?.textContent === 'Проверяю' && parseFloat(earlier.style.animationDelay) < 0 &&
      tail?.textContent === 'карточки' && block.textContent.trim() === 'Проверяю карточки';
    window.pushChat({ project: fixture.project, type: 'orchestrator', items: savedItems.slice(0, 2) });
    return fades;
  })()`, "streaming text fades each new fragment and keeps the earlier fade in progress while Markdown remains formatted");
  await check(`(() => {
    const status = draftForm().querySelector('.chat-thinking > span');
    const update = (type, text, state = 'inProgress') => window.pushChat({
      project: fixture.project, type: 'orchestrator',
      items: [...savedItems.slice(0, 2), { id: 'live', type, title: '', text, status: state }],
    });
    if (status.textContent !== 'Думаю…') return false;
    update('reasoning', '**Проверяю карточки**');
    if (status.textContent !== 'Проверяю карточки' || draftForm().querySelector('[data-item="item:live"]')) return false;
    update('reasoning', '**Проверяю карточки**\\n\\n**Готовлю ответ**');
    const animations = status.getAnimations();
    if (status.textContent !== 'Готовлю ответ' || !animations.length) return false;
    update('reasoning', '**Проверяю карточки**\\n\\n**Готовлю ответ**\\nПодробности');
    if (status.getAnimations()[0] !== animations[0]) return false;
    update('reasoning', '**Готовлю ответ**', 'completed');
    if (status.textContent !== 'Думаю…' || !draftForm().querySelector('[data-item="item:live"]')) return false;
    update('commandExecution', '');
    return status.textContent === 'Выполняю команду…' && status.closest('.chat-thinking').nextElementSibling.matches('.board-chat-queue:empty');
  })()`, "the latest activity replaces and animates one status line without duplicating the live summary");
  await clickBoard();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0)`);
  await check(`!draftText().readOnly && draftForm().getAttribute('aria-busy') === 'true'`, "an outside click collapses the chat and the field remains editable while the reply continues");
  await clickManagerField();
  await evaluate(`const managerAction = draftForm().querySelector('.draft-send'); void 0`);
  await check(`managerAction.dataset.action === 'stop' && managerAction.parentElement.querySelectorAll('button').length === 2`, "an empty composer shows microphone and a single stop action");
  await evaluate(`draftPaste([new File(['notes'], 'follow-up.txt')]); void 0`);
  await check(`draftForm().querySelector('.draft-send') === managerAction && managerAction.dataset.action === 'send' && managerAction.getAttribute('aria-label') === 'Отправить запрос'`, "an attachment alone switches the same control to send");
  await evaluate(`
    draftText().value = 'Уточнение к запросу';
    draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    draftText().value = 'Следующее сообщение';
    draftText().dispatchEvent(new Event('input', { bubbles: true }));
    draftForm().querySelector('.draft-send').click();
    window.stopModeAfterSend = managerAction.dataset.action;
    void 0;
  `);
  await check(`managerRequests.length === 1 && draftForm().querySelectorAll('.board-chat-queue .board-queued-status').length === 2 &&
    draftForm().querySelector('.board-chat-queue').textContent.includes('follow-up.txt') &&
    draftForm().querySelector('.board-chat-queue').textContent.includes('В очереди') && stopModeAfterSend === 'stop'`, "text and attachments can be sent with Enter or the button while a reply is active");
  await evaluate(`
    draftForm().querySelector('[aria-label="Остановить ответ"]').click();
    draftText().value = 'Новый черновик';
    draftText().dispatchEvent(new Event('input', { bubbles: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => managerRequests.length === 2)`);
  await check(`stoppedOrchestrator === 1 && draftForm().textContent.includes('Ответ остановлен.') &&
    managerRequests[1].text === 'Уточнение к запросу' && managerRequests[1].files[0].name === 'follow-up.txt' &&
    managerRequests[1].project === managerRequests[0].project && draftText().value === 'Новый черновик'`, "stopping a reply sends the first queued message with its own attachment and preserves the new draft");
  await evaluate(`managerRequests[1].resolve({ ok: false, error: { message: 'Не удалось отправить' } }); waitFor(() => draftForm().querySelector('.board-chat-queue button'))`);
  await check(`managerRequests.length === 2 && draftText().value === 'Новый черновик' &&
    draftForm().querySelector('.board-chat-queue').textContent.includes('Не отправлено')`, "a failed send keeps the draft and later messages and pauses the queue");
  await evaluate(`draftForm().querySelector('.board-chat-queue button').click(); waitFor(() => managerRequests.length === 3)`);
  await check(`managerRequests[2].text === 'Уточнение к запросу' && managerRequests[2].files[0].name === 'follow-up.txt'`, "retry sends the original message with its attachment");
  await evaluate(`managerRequests[2].resolve({ ok: true, data: { answer: 'Получил уточнение', changes: [] } }); waitFor(() => managerRequests.length === 4)`);
  await check(`managerRequests[3].text === 'Следующее сообщение' && !managerRequests[3].files.length &&
    draftForm().querySelector('.board-chat-queue').childElementCount === 0`, "successful retry sends the next message without mixing attachments");
  await evaluate(`managerRequests[3].resolve({ ok: true, data: { answer: 'Получил второе сообщение', changes: [] } }); waitFor(() => !draftForm().querySelector('.chat-thinking'))`);
  await check(`draftText().value === 'Новый черновик' && draftForm().textContent.includes('Получил второе сообщение')`, "the composer keeps text entered while queued requests complete");
  await evaluate(`archiveView = true; render(); void 0`);
  await check(`byId('board-composer').hidden`, "archive view hides task creation field");
  console.log(`Board Chromium checks passed: ${checks}`);
  if (keepArtifacts) console.log("Screenshots: " + artifacts);
}).catch(async error => {
  console.error(error);
  process.exitCode = 1;
  if (window && keepArtifacts) writeFileSync(join(artifacts, "board-failure.png"), (await window.webContents.capturePage()).toPNG());
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
