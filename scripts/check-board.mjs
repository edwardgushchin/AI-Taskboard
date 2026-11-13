// Real Chromium regression checks for board refreshes, with a local fixture and no Codex calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const require = createRequire(import.meta.url);
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [script], {
    env, windowsHide: true, stdio: "inherit", timeout: 60_000,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) console.error("Electron exited before completing board checks: " + result.status);
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow } = await import("electron");
const artifacts = join(root, ".dev-diary", "board-check");
mkdirSync(artifacts, { recursive: true });
app.setPath("userData", mkdtempSync(join(artifacts, "profile-")));
app.disableHardwareAcceleration();
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
let window;
let checks = 0;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1380, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await window.webContents.insertCSS(read("themes.css") + "\n" + read("styles.css"));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const check = async (code, message) => {
    assert.equal(await evaluate(code), true, message);
    checks++;
  };
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
      tags: [], subtasks: [], attachments: [], history: [], ...extra });
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
    push();
    void 0;
  `);
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
  await check(`findCard('T-0001') !== originalCard && findCard('T-0001').textContent.includes('Другая доска') && !findCard('T-0001').querySelector('img')`, "switching projects discards cached cards and covers");
  await check(`document.querySelector('#tag-filter input')?.value === 'ui'`, "switching between projects with the same tags restores the global filter options");
  await evaluate(`fixture.russian = false; push(); void 0`);
  await check(`lane('ready').querySelector('h2').textContent.includes('Ready') && findCard('T-0001').textContent.includes('Normal')`, "language changes update columns and cards");
  await evaluate(`const callsBeforeDelay = window.previewCalls; fixture.board.tasks[0].attachments = [{ file: 'delayed.png', name: 'delayed.png' }]; push(); void 0`);
  await evaluate(`waitFor(() => !!window.releasePreview)`);
  await evaluate(`const pendingImage = findCard('T-0001').querySelector('img'); fixture.board.tasks[0].title = 'Changed while loading'; push(); push(); window.releasePreview(); void 0`);
  await evaluate(`waitFor(() => !pendingImage.hidden)`);
  await check(`findCard('T-0001').querySelector('img') === pendingImage && window.previewCalls === callsBeforeDelay + 1`, "updates during preview loading retain the pending image and share its request");
  await evaluate(`fixture.board.tasks.push(...Array.from({ length: 40 }, (_, index) => task('S-' + index, 'Scroll task ' + index))); push(); document.querySelector('#lanes').scrollTop = 400; const boardScroll = document.querySelector('#lanes').scrollTop; push(); void 0`);
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
  await evaluate(`byId('search').value = 'задача'; render(); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0103,T-0102'`, "search results keep newest-first order");
  await evaluate(`fixture.board.tasks.find(task => task.id === 'T-0102').priority = 'high'; fixture.board.tasks.find(task => task.id === 'T-0000').priority = 'high'; push(); const sortingFilter = lane('ready').querySelector('select'); sortingFilter.value = 'high'; sortingFilter.dispatchEvent(new Event('change', { bubbles: true })); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0102'`, "column filters preserve newest-first order for the matching subset");
  await evaluate(`lane('ready').querySelector('.lane-filter-options button').click(); byId('search').value = ''; byId('search').dispatchEvent(new Event('input', { bubbles: true })); fixture.board.tasks.find(task => task.id === 'T-0103').unfinishedDependencies = ['T-0100']; push(); void 0`);
  await check(`laneIds('blocked') === 'T-0107,T-0103,T-0106'`, "dependency-blocked tasks use creation order within the blocked column");
  await evaluate(`fixture.board.tasks.push(task('T-9999', 'Совпадающая дата', { createdAt: '2026-11-04T12:00:00.000Z' })); push(); const tiedOrder = laneIds('ready'); fixture.board.tasks.reverse(); push(); void 0`);
  await check(`laneIds('ready') === tiedOrder && tiedOrder.startsWith('T-9999,T-0000,')`, "equal creation dates use a stable descending task-number tie-breaker");
  await evaluate(`fixture.board.tasks.push(task('T-9998', 'Без даты', { createdAt: '' }), task('T-9997', 'Повреждённая дата', { createdAt: 'invalid' })); push(); void 0`);
  await check(`laneIds('ready') === 'T-9999,T-0000,T-0102,T-9998,T-9997'`, "missing or invalid creation dates sort after dated tasks without breaking rendering");
  await evaluate(`fixture.russian = true; fixture.project = 'board-fixture'; fixture.board.tasks = [task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }), task('T-0002', 'Обновляемая карточка', { tags: ['UI'] })]; push(); void 0`);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "board-stable.png"), (await window.webContents.capturePage()).toPNG());
  console.log(`Board Chromium checks passed: ${checks}; screenshots: ${join(artifacts, "board-stable.png")}, ${join(artifacts, "board-newest-first.png")}`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
