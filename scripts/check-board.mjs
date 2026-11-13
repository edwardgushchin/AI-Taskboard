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
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "board", 60_000);
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
      subscribe(callback) { window.pushBoard = callback; }, onChatUpdate() {}, onTheme() {},
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
      board: { tags: [{ name: 'UI', color: 'blue' }], archived: [], tasks: [
        task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
        task('T-0002', 'Обновляемая карточка', { tags: ['UI'], createdAt: '2026-11-02T12:00:00.000Z' })
      ] } };
    const push = () => window.pushBoard(structuredClone(fixture));
    const lane = state => document.querySelector('.lane[data-state="' + state + '"]');
    const findCard = id => [...document.querySelectorAll('.task-card')].find(node => node.querySelector('.task-id').textContent === id);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const waitFor = predicate => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error('Timed out waiting for preview')) : requestAnimationFrame(poll);
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
    fixture.board = { gitInfo: { branch: 'main', user: 'Developer' }, tags: [{ name: 'интерфейс', color: 'blue' }, { name: 'карточки', color: 'purple' }], archived: [], tasks: [
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
    const draftText = () => draftForm().querySelector('textarea');
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
    await check(`getComputedStyle(findCard('T-0055')).borderTopColor === themeColor('--accent') && getComputedStyle(findCard('T-0055')).backgroundColor === themeColor('--panel') && getComputedStyle(findCard('T-0055')).color === themeColor('--text') && getComputedStyle(findCard('T-0051'), '::before').backgroundColor === themeColor('--warn') && getComputedStyle(draftForm()).backgroundColor === themeColor('--panel')`, theme + " uses active theme colors for cards, states and composer");
    await capture("board-reference-" + theme + ".png");
  }
  window.setContentSize(760, 760);
  await evaluate(`settle()`);
  await check(`byId('lanes').scrollWidth > byId('lanes').clientWidth && draftForm().getBoundingClientRect().right <= innerWidth && draftForm().getBoundingClientRect().bottom <= document.querySelector('.status-bar').getBoundingClientRect().top`, "narrow windows scroll the columns and retain a usable bottom composer");
  await capture("board-reference-narrow.png");
  await evaluate(`draftForm().requestSubmit(); void 0`);
  await check(`!draftText().readOnly`, "empty requests do not start preparation");
  await evaluate(`
    window.taskboard.draft = async (request, files) => { draftCalls.push({ request, files }); return { ok: false, error: { message: 'Draft unavailable' } }; };
    draftText().value = 'Сохранить мой запрос';
    draftPaste([new File(['image bytes'], 'image.png', { type: 'image/png' })]);
    draftForm().requestSubmit(); draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !draftText().readOnly)`);
  await check(`draftCalls.length === 1 && draftCalls[0].files[0].name === 'image.png' && draftText().value === 'Сохранить мой запрос' && draftForm().querySelectorAll('li').length === 1 && draftForm().textContent.includes('Draft unavailable')`, "failed preparation retains request and attachment and rejects duplicate submits");
  await evaluate(`byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-other' && !draftText().value && !draftForm().querySelectorAll('li').length && findCard('T-0001').querySelector('.task-description').textContent === 'Описание другой задачи'`, "Down switches projects with isolated input, attachments and description preview");
  await evaluate(`draftText().value = 'Другой запрос'; byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-board' && draftText().value === 'Сохранить мой запрос' && draftForm().querySelectorAll('li').length === 1 && findCard('T-0055').dataset.selected === 'true'`, "Up restores the source project's draft, attachment and selection");
  await evaluate(`draftForm().querySelector('.draft-attachments button').click(); settle()`);
  await check(`draftForm().querySelector('.draft-attachments').hidden`, "attached files can be removed before sending");
  await evaluate(`draftPaste([new File([new Uint8Array(64 * 1024 * 1024 + 1)], 'large.bin')]); void 0`);
  await check(`draftForm().querySelectorAll('li').length === 0 && draftForm().textContent.includes('64 МиБ')`, "oversized attachments are rejected without changing the draft");
  await evaluate(`
    const pickerTransfer = new DataTransfer(); pickerTransfer.items.add(new File(['notes'], 'notes.txt'));
    const designPicker = draftForm().querySelector('[type=file]'); designPicker.files = pickerTransfer.files; designPicker.dispatchEvent(new Event('change'));
    draftText().value = '';
    let resolveDesignDraft;
    window.taskboard.draft = (request, files) => { draftCalls.push({ request, files }); return new Promise(resolve => { resolveDesignDraft = resolve; }); };
    draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !!resolveDesignDraft)`);
  await check(`draftCalls.at(-1).request === '' && draftCalls.at(-1).files[0].name === 'notes.txt' && draftText().readOnly`, "file picker supports attachment-only drafts and locks preparation");
  await evaluate(`window.taskboard.selectTab('design-other'); resolveDesignDraft({ ok: true, data: { id: 'T-0999' } }); settle()`);
  await check(`!sheet.open && fixture.project === 'design-other' && draftText().value === 'Другой запрос'`, "a background draft completion cannot open a task or erase another project's input");
  await evaluate(`window.taskboard.selectTab('design-board'); settle()`);
  await check(`!draftText().value && draftForm().querySelector('.draft-attachments').hidden && !draftText().readOnly`, "successful background preparation clears only its original composer");
  await evaluate(`
    window.taskboard.draft = async (request, files) => { draftCalls.push({ request, files }); return { ok: true, data: { id: 'T-0056' } }; };
    draftText().value = 'Создать задачу'; draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); void 0;
  `);
  await evaluate(`waitFor(() => sheet.open && taskInSheet?.id === 'T-0056')`);
  await check(`!draftText().value && draftCalls.at(-1).request === 'Создать задачу'`, "Enter creates a draft and opens the confirmed task");
  await evaluate(`sheet.close(); archiveView = true; render(); void 0`);
  await check(`byId('board-composer').hidden`, "archive view hides task creation field");
  console.log(`Board Chromium checks passed: ${checks}`);
  if (keepArtifacts) console.log("Screenshots: " + artifacts);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
