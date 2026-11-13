// Real Chromium checks for the chat renderer, without opening a board or contacting Codex.
// Optional: --references <task attachment directory> --artifacts <screenshot directory>
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "chat", 90_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
const references = option("--references");
const images = references ? readdirSync(references).filter(name => !name.startsWith(".")).map(name =>
  "data:image/png;base64," + readFileSync(join(references, name)).toString("base64")) :
  ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="];
const require = createRequire(import.meta.url);
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 850, height: 960, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await window.webContents.insertCSS(read("themes.css") + "\n" + read("styles.css"));
  await window.webContents.executeJavaScript(`
    window.testImages = ${JSON.stringify(images)};
    window.taskboard = {
      subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
      chatModels: async () => ({ ok: true, data: [{ id: 'test', name: 'Codex', efforts: ['high'], effort: 'high' }] }),
      attachmentPreview: async (_task, file) => window.testImages[Number(file)],
      saveAttachment: async () => ({ ok: true })
    };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${read("renderer.js")}
    void 0;
  `);
  const evaluate = (code, userGesture = false) => window.webContents.executeJavaScript(code, userGesture);
  const check = async (code, message) => assert.equal(await evaluate(code), true, message);
  const capture = async name => {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  await evaluate(`
    frame = { project: 'fixture', russian: true };
    sheetKind = 'task';
    const longCommand = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content -LiteralPath ' + 'very-long-path/'.repeat(100) + 'SKILL.md"';
    const action = (id, type, title = '', status = 'completed', text = 'Result') => ({ id, type, title, text, status,
      ...(type === 'agentMessage' ? { phase: 'commentary' } : {}) });
    const activity = [
      action('intro', 'agentMessage', '', 'completed', 'Проверяю карточку и приложенные примеры. **Подробности действий** можно раскрыть.'),
      action('cmd-1', 'commandExecution', longCommand),
      action('cmd-2', 'commandExecution', 'git status --short'),
      action('search', 'webSearch', 'Оформление чата'),
      action('message', 'agentMessage', '', 'completed', 'Сравнил варианты. Сохраняю полный текст команд в подробностях и проверяю просмотр изображений.'),
      action('image', 'imageView', 'reference.png'),
      action('note', 'agentMessage', '', 'completed', 'Ниже — ошибка и операция, которая ещё выполняется.'),
      action('failed', 'commandExecution', 'npm test', 'failed', 'Exit code: 1'),
      action('running', 'mcpToolCall', 'local / inspect', 'inProgress'),
      action('reason', 'reasoning', '', 'completed', 'Краткая сводка'),
      action('unknown', 'futureTool', '<script>alert(1)</script>', 'completed', '<img src=x onerror=alert(1)>'),
      action('error', 'error', '', 'failed', 'Provider disconnected'),
      action('truncated', 'truncated'),
      { ...action('final', 'agentMessage', '', 'completed', 'Готово. Весь ход работы доступен над этим итоговым ответом.'), phase: 'final_answer' }
    ];
    taskInSheet = { id: 'T-0032', createdAt: '2026-11-12T13:00:00Z', status: 'in_progress', questions: [],
      attachments: window.testImages.map((_, index) => ({ file: String(index), name: 'reference-' + index + '.png', bytes: 100 })),
      history: [
        { at: '2026-11-12T13:00:00Z', action: 'chat', actor: 'user', text: 'Сделай чат компактнее, как в этих примерах.', chat: { model: 'test', effort: 'high', files: window.testImages.map((_, index) => String(index)) } },
        { at: '2026-11-12T13:01:00Z', action: 'run-log', actor: 'agent', run: activity, durationMs: 433000 },
        { at: '2026-11-12T13:02:00Z', action: 'chat', actor: 'agent', text: 'Сообщения остаются легко читаемыми.\\n\\n- Действия объединены в группы.\\n- Изображения открываются в просмотре.', durationMs: 12000,
          chat: { model: 'test', effort: 'high', commentary: ['Проверяю оформление обсуждения.', 'Подготовил итоговый ответ.'] } }
      ] };
    document.querySelector('#welcome').hidden = true;
    body.replaceChildren(taskChat(taskInSheet));
    sheet.showModal();
    const log = body.querySelector('.chat-log');
    const savedLog = log.querySelector('.chat-run');
    const completedWork = savedLog.querySelector('.chat-work');
    const saved = completedWork.querySelector('.chat-run-body');
    const firstGroup = () => saved.querySelector('.chat-run-group');
    const row = id => [...saved.querySelectorAll('details')].find(node => node.dataset.item === 'item:' + id);
  `);
  await check(`!completedWork.open && completedWork.querySelector('summary').textContent.includes('Выполнено за 7 мин 13 с')`, "completed chronology is folded with its measured duration");
  await check(`savedLog.querySelector('.chat-run-final').textContent.includes('Готово.') && !completedWork.querySelector('.chat-run-final')`, "final answer is outside the folded chronology");
  await check(`log.querySelectorAll('.chat-work').length === 2 && log.querySelectorAll('.chat-work')[1].textContent.includes('Проверяю оформление обсуждения.')`, "discussion commentary folds above its final answer too");
  await check(`getComputedStyle(log).backgroundColor !== getComputedStyle(body).backgroundColor`, "chat restores its distinct theme background");
  await evaluate(`completedWork.querySelector('summary').click()`);
  await check(`completedWork.open`, "the entire chronology can be disclosed");
  await check(`saved.querySelectorAll(':scope > .chat-run-group').length === 2 && !firstGroup().open`, "consecutive operations collapse into two groups separated by messages");
  await check(`firstGroup().querySelector('.chat-run-label').textContent.includes('3 действия')`, "group count is localized");
  await check(`row('cmd-1').querySelector('.chat-run-command').textContent === longCommand`, "full long command is retained");
  await check(`saved.querySelector('[data-state=failed] > summary').textContent.includes('Ошибок: 1') && saved.querySelector('[data-state=failed] > summary').textContent.includes('Выполняется: 1')`, "collapsed groups expose failed and running operations");
  await check(`row('image').querySelector('use').getAttribute('href') === '#icon-images'`, "image operations have their own icon");
  await check(`row('unknown').querySelector('script') === null && row('unknown').querySelector('pre').textContent.includes('<script>')`, "tool payloads are rendered as text");
  await check(`saved.querySelector('.chat-run-error').textContent === 'Provider disconnected' && saved.lastChild.textContent.includes('журнал')`, "errors and truncation notices remain visible");
  await evaluate(`log.scrollTop = 0`);
  await evaluate(`firstGroup().querySelector('summary').click()`);
  await check(`firstGroup().open`, "activating a native summary opens its group");
  await evaluate(`row('cmd-1').open = true; row('cmd-1').querySelector('summary').focus(); activity[1].text = 'Updated output'; renderRunActivity(saved, activity)`);
  await check(`firstGroup().open && row('cmd-1').open && row('cmd-1').querySelector('.chat-run-output').textContent === 'Updated output' && document.activeElement === row('cmd-1').querySelector('summary')`, "stream updates retain disclosures, keyboard focus and fresh output");
  await evaluate(`firstGroup().open = false; renderRunActivity(saved, activity)`);
  await check(`!firstGroup().open`, "an explicitly closed group stays closed even with an expanded child");
  await evaluate(`renderRunActivity(log.querySelector('.chat-run-live'), [activity[1]]); const live = log.querySelector('.chat-run-live'); live.querySelector('details').open = true; renderRunActivity(live, [activity[1], activity[2]])`);
  await check(`live.querySelector('.chat-run-group').open && live.querySelector('.chat-run-item').open`, "a newly formed live group keeps an already open operation visible");
  await evaluate(`renderRunActivity(live, []); renderRunActivity(saved, activity.filter(item => item.phase !== 'final_answer')); const showActions = () => {
    log.scrollTop += completedWork.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
  }`);
  await check(`live.hidden`, "empty live journals take no space");
  for (const theme of ["dark", "light"]) {
    nativeTheme.themeSource = theme;
    for (const width of [850, 390]) {
      window.setSize(width, 960);
      await evaluate(`completedWork.open = false; showActions()`);
      await check(`log.scrollWidth <= log.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1`, `${theme} at ${width}px has no horizontal overflow`);
      await check(`!completedWork.open && completedWork.querySelector('summary').getBoundingClientRect().height <= ${width > 480 ? 34 : 64}`, `${theme} at ${width}px keeps completed work compact`);
      await check(`completedWork.querySelector('.chat-run-label').scrollWidth <= completedWork.querySelector('.chat-run-label').clientWidth + 1`, `${theme} at ${width}px shows the full duration`);
      await capture(`chat-${theme}-${width}.png`);
    }
  }
  window.setSize(850, 960);
  nativeTheme.themeSource = "dark";
  await evaluate(`completedWork.open = true; firstGroup().open = false; showActions()`);
  await capture("chat-work-expanded.png");
  await evaluate(`firstGroup().open = true; row('cmd-1').open = true; showActions()`);
  await check(`log.scrollWidth <= log.clientWidth + 1 && row('cmd-1').querySelector('pre').scrollHeight > 0`, "expanded long commands stay inside the log");
  await capture("chat-expanded.png");
  // Open the actual attachment tile, using the existing viewer and supplied reference images.
  await evaluate(`log.scrollTop = 0; log.querySelector('.chat-attachment').click()`);
  await check(`document.querySelector('.image-preview').open`, "clicking an attachment opens image preview");
  await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.image-preview-stage img:not([hidden])') ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`document.querySelector('.image-preview-stage img').naturalWidth > 0 &&
    document.querySelector('.image-preview-stage img').src === window.testImages[0]`, "reference image decodes in the viewer");
  await capture("chat-image-preview.png");
  for (let index = 1; index < images.length; index++) {
    await evaluate(`document.querySelector('.image-preview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.image-preview-toolbar strong').textContent === 'reference-${index}.png' ? resolve() : requestAnimationFrame(poll); poll(); })`);
    await check(`document.querySelector('.image-preview-stage img').src === window.testImages[${index}]`, "reference images can be navigated in order");
  }
  await evaluate(`document.querySelector('.image-preview').close(); frame.russian = false; renderRunActivity(saved, activity)`);
  await check(`firstGroup().querySelector('.chat-run-label').textContent.includes('3 actions')`, "English activity labels are available");
  await evaluate(`const testDraft = chatDrafts.get('fixture' + String.fromCharCode(0) + 'T-0032');
    testDraft.pending = 'replying'; testDraft.commentary = ['Live discussion update']; renderChatTurn(log, testDraft)`);
  await check(`!log.querySelector('.chat-turn').hidden && log.querySelector('.chat-turn').textContent.includes('Live discussion update') && !log.querySelector('.chat-turn details')`, "discussion progress stays visible while replying");
  await evaluate(`testDraft.pending = undefined; testDraft.commentary = []; renderChatTurn(log, testDraft);
    updateChat({ project: 'fixture', id: 'T-0032', type: 'run', items: activity })`);
  await check(`!live.hidden && !live.querySelector('.chat-work') && live.textContent.includes('Проверяю карточку')`, "live run chronology stays visible through the normal update handler");
  await evaluate(`updateChat({ project: 'fixture', id: 'T-0032', type: 'run', items: [] }); body.replaceChildren(taskChat(taskInSheet))`);
  await check(`!body.querySelector('.chat-work').open && body.querySelector('.chat-run-final').textContent.includes('Готово.') && body.querySelector('.chat-run-live').hidden`, "reopening restores folded work and a visible final reply without duplicating the live log");

  // Native imageView results, including old saved JSON, use the same viewer as attachments.
  await evaluate(`
    const imageReads = [], imageSaves = [];
    frame.russian = true;
    api.runImagePreview = async (_task, path) => {
      imageReads.push(path);
      if (path === 'missing.png') return null;
      if (path === 'corrupt.png') return 'data:image/png;base64,bm90IGFuIGltYWdl';
      return window.testImages[Number(path.match(/viewed-(\\d+)/)[1])];
    };
    api.saveRunImage = async (_task, path) => { imageSaves.push(path); return { ok: true }; };
    const viewedImages = [...window.testImages.map((_, index) => 'viewed-' + index + '.png'), 'missing.png', 'corrupt.png']
      .map((path, index) => ({ id: 'view-' + index, type: 'imageView', title: '', status: 'completed',
        text: JSON.stringify({ path, startedAtMs: 1, completedAtMs: 1 }) }));
    taskInSheet.history = [{ at: '2026-11-12T15:00:00Z', actor: 'agent', action: 'run-log', run: viewedImages }];
    body.replaceChildren(taskChat(taskInSheet));
    const imageLog = body.querySelector('.chat-log');
    const imageWork = imageLog.querySelector('.chat-work');
    imageWork.open = true;
    imageWork.querySelector('.chat-run-group').open = true;
    imageLog.scrollTop = 0;
  `);
  await evaluate(`new Promise(resolve => { const poll = () => imageWork.querySelectorAll('.has-preview img').length === window.testImages.length &&
    [...imageWork.querySelectorAll('.chat-attachment span')].filter(node => node.textContent.includes('недоступно')).length === 2 ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`!imageWork.querySelector('pre') && !imageWork.textContent.includes('startedAtMs')`, "image views replace service JSON with thumbnails");
  await check(`imageWork.querySelectorAll('.chat-run-images').length === viewedImages.length`, "every viewed image has its own tile");
  await check(`imageWork.textContent.includes('Изображение недоступно: missing.png') && imageWork.textContent.includes('Изображение недоступно: corrupt.png')`, "missing and corrupt image files have readable fallbacks");
  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme;
    for (const width of [850, 390]) {
      window.setSize(width, 960);
      await check(`imageLog.scrollWidth <= imageLog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1`, `image thumbnails fit ${theme} at ${width}px`);
      await capture(`image-views-${theme}-${width}.png`);
    }
  }
  window.setSize(850, 960);
  nativeTheme.themeSource = 'dark';
  await evaluate(`imageWork.querySelector('.chat-attachment').click()`);
  await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.image-preview-stage img')?.naturalWidth > 0 ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`document.querySelector('.image-preview').open && document.querySelector('.image-preview-stage img').src === window.testImages[0]`, "clicking a viewed image opens the enlarged viewer");
  await capture('image-view-enlarged.png');
  await evaluate(`document.querySelector('[aria-label="Zoom in"], [aria-label="Увеличить"]').click()`);
  await check(`parseInt(document.querySelector('.image-preview-toolbar output').value) > 0`, "viewed images can be zoomed");
  for (let index = 1; index < images.length; index++) {
    await evaluate(`document.querySelector('.image-preview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.image-preview-toolbar strong').textContent === 'viewed-${index}.png' ? resolve() : requestAnimationFrame(poll); poll(); })`);
    await check(`document.querySelector('.image-preview-stage img').src === window.testImages[${index}]`, "all viewed images can be navigated in order");
  }
  await evaluate(`document.querySelector('.image-preview').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.image-preview-status').textContent.includes('missing.png') ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`document.querySelector('.image-preview-stage img').src === window.testImages[${images.length - 1}]`, "an unavailable next view retains the current image");
  await evaluate(`[...document.querySelectorAll('.image-preview button')].find(node => ['Save', 'Сохранить'].includes(node.textContent)).click()`);
  await check(`imageSaves.at(-1) === 'viewed-${images.length - 1}.png'`, "saving targets the visible image");
  await evaluate(`document.querySelector('.image-preview').close();
    body.replaceChildren(taskChat(taskInSheet));
    const restoredImages = body.querySelector('.chat-work'); restoredImages.open = true; restoredImages.querySelector('.chat-run-group').open = true;
    updateChat({ project: 'fixture', id: 'T-0032', type: 'run', items: viewedImages });
    const liveImages = body.querySelector('.chat-run-live'); liveImages.querySelector('.chat-run-group').open = true;
  `);
  await check(`body.querySelector('.chat-work').querySelectorAll('.chat-run-images').length === viewedImages.length && liveImages.querySelectorAll('.chat-run-images').length === viewedImages.length`, "reopening and live updates both retain every viewed image");
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await evaluate(`const retainedImageTile = liveImages.querySelector('.chat-attachment'); retainedImageTile.focus();
    const readsBeforeUpdate = imageReads.length; updateChat({ project: 'fixture', id: 'T-0032', type: 'run', items: viewedImages });`);
  await check(`liveImages.querySelector('.chat-attachment') === retainedImageTile`, "stream updates retain image tiles");
  await check(`document.activeElement === retainedImageTile`, "stream updates retain image keyboard focus");
  await check(`imageReads.length === readsBeforeUpdate`, "stream updates do not repeat image reads");

  await evaluate(`
    window.markdownReads = [];
    api.readMarkdown = async (id, link, source) => {
      markdownReads.push({ id, link, source });
      if (link.includes('missing.md')) return { ok: false, error: { code: 'MARKDOWN_UNAVAILABLE', message: 'Документ недоступен' } };
      if (link === 'next.md') return { ok: true, data: { name: 'next.md', path: 'G:/AI Taskboard/docs/next.md', text: '# Следующий документ' } };
      return { ok: true, data: { name: 'diagnostic report.md', path: 'G:/AI Taskboard/docs/diagnostic report.md',
        text: '# Диагностика\\n\\n**Файл открыт.**\\n\\n[Следующий](next.md)\\n\\n<script>window.unsafe = true</script>' } };
    };
    const mdLink = '[Подробная диагностика](<G:/Projects/2026/AI Taskboard/.tasks/worktrees/T-0051/docs/codex-project-placement.md>)';
    taskInSheet.history.push({ at: '2026-11-12T13:05:00Z', action: 'chat', actor: 'agent', text: mdLink,
      chat: { model: 'test', effort: 'high' } });
    body.replaceChildren();
    section('Описание', mdLink);
    body.append(taskChat(taskInSheet));
    const descriptionLink = body.querySelector('.sheet-section a');
    const chatLink = [...body.querySelectorAll('.chat-entry a')].find(node => node.textContent === 'Подробная диагностика');
    const waitMarkdown = selector => new Promise((resolve, reject) => {
      const until = Date.now() + 5000;
      const poll = () => document.querySelector(selector) ? resolve() : Date.now() > until ? reject(new Error('Markdown preview timed out')) : requestAnimationFrame(poll);
      poll();
    });
  `);
  await check(`descriptionLink.textContent === 'Подробная диагностика' && chatLink.textContent === 'Подробная диагностика' && !descriptionLink.parentElement.textContent.includes('](')`, "description and agent chat show the caption without Markdown syntax");
  await capture("markdown-links.png");
  // User activation gives each nested native dialog its own close-request group.
  for (const origin of ["descriptionLink", "chatLink"]) {
    await evaluate(`${origin}.focus(); ${origin}.click(); waitMarkdown('.markdown-preview .chat-text h1')`, true);
    await check(`markdownReads.at(-1).id === taskInSheet.id && markdownReads.at(-1).link.includes('AI%20Taskboard') && document.querySelector('.markdown-preview .chat-text strong').textContent === 'Файл открыт.'`, "caption clicks route the encoded Windows path and task to the document reader");
    await check(`!window.unsafe && !document.querySelector('.markdown-preview script') && document.querySelector('.markdown-preview .chat-text').textContent.includes('<script>')`, "document HTML stays inert");
    if (origin === "descriptionLink") await capture("markdown-preview.png");
    await evaluate(`document.querySelector('.markdown-preview .chat-text a').focus(); document.querySelector('.markdown-preview .chat-text a').click(); waitMarkdown('.markdown-preview[aria-label="next.md"]')`, true);
    await check(`markdownReads.at(-1).source === 'G:/AI Taskboard/docs/diagnostic report.md' && document.querySelectorAll('.markdown-preview').length === 2`, "nested links use the current document path and retain its preview");
    if (!window.webContents.debugger.isAttached()) {
      window.webContents.debugger.attach("1.3");
      await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    }
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await evaluate(`new Promise((resolve, reject) => {
      const until = Date.now() + 5000;
      const poll = () => document.querySelectorAll('.markdown-preview').length === 1 ? resolve() : Date.now() > until ? reject(new Error('Escape left ' + document.querySelectorAll('.markdown-preview').length + ' previews')) : requestAnimationFrame(poll); poll();
    })`);
    await check(`document.querySelector('.markdown-preview').getAttribute('aria-label') === 'diagnostic report.md' && document.activeElement.textContent === 'Следующий'`, "Escape restores the previous preview and link focus");
    await evaluate(`document.querySelector('.markdown-preview .sheet-header button').click();
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await check(`!document.querySelector('.markdown-preview') && sheet.open && document.activeElement === ${origin}`, "closing restores the task and originating link focus");
  }
  await evaluate(`body.append(chatText('[Недоступный файл](docs/missing.md)')); body.lastElementChild.querySelector('a').click(); waitMarkdown('.markdown-preview [role="status"]')`);
  await evaluate(`new Promise(resolve => { const poll = () => document.querySelector('.markdown-preview [role="status"]').textContent === 'Документ недоступен' ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`document.querySelector('.markdown-preview [role="status"]').textContent === 'Документ недоступен' && sheet.open`, "unavailable documents show an error and retain the task");
  await capture("markdown-unavailable.png");
  await evaluate(`document.querySelector('.markdown-preview').close()`);

  await evaluate(`
    sheetKind = 'task';
    frame.runningTasks = [];
    frame.runActivity = {};
    taskInSheet.history = [];
    taskInSheet.attachments = [];
    chatDrafts.clear();
    window.sentMessages = [];
    window.pendingReplies = [];
    window.stopCalls = 0;
    showTask = async () => { body.replaceChildren(taskChat(taskInSheet)); };
    api.chatSend = async (_id, request) => {
      window.sentMessages.push(request.text);
      taskInSheet.history.push({ at: new Date().toISOString(), action: 'chat', actor: 'user', text: request.text,
        chat: { model: request.model, effort: request.effort, files: [] } });
      updateChat({ project: 'fixture', id: taskInSheet.id, type: 'saved' });
      if (window.sentMessages.length === 1) return new Promise(resolve => window.pendingReplies.push(resolve));
      return { saved: true, result: { ok: true, data: taskInSheet } };
    };
    api.chatStop = async () => {
      window.stopCalls++;
      window.pendingReplies.splice(0).forEach(resolve => resolve({ saved: true, result: { ok: true, data: taskInSheet } }));
      return { ok: true };
    };
    body.replaceChildren(taskChat(taskInSheet));
    window.typeMessage = text => {
      const input = body.querySelector('#task-chat-input');
      input.value = text;
      input.dispatchEvent(new Event('input'));
    };
    void 0;
  `);
  await check(`body.querySelector('.chat-send use').getAttribute('href') === '#icon-play' && body.querySelector('.chat-send').disabled && !body.querySelector('.chat-send').textContent`, "idle composer uses an accessible play icon");
  await evaluate(`window.typeMessage('Первое сообщение'); body.querySelector('.chat-composer').requestSubmit()`);
  await check(`body.querySelector('.chat-log').textContent.includes('Первое сообщение') && body.querySelector('.chat-send use').getAttribute('href') === '#icon-stop' && !body.querySelector('.chat-send').disabled`, "saved message is visible and empty input switches to stop before the reply");
  await capture('chat-stop-thinking.png');
  await evaluate(`window.typeMessage('Новые данные во время размышления')`);
  await check(`body.querySelector('.chat-send use').getAttribute('href') === '#icon-play' && !body.querySelector('.chat-send').disabled`, "typing during a reply switches stop to enabled play");
  await capture('chat-play-steering.png');
  await evaluate(`body.querySelector('#task-chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  await check(`window.sentMessages.length === 2 && window.pendingReplies.length === 1 && body.querySelector('.chat-log').textContent.includes('Новые данные во время размышления') && body.querySelector('#task-chat-input').value === '' && body.querySelector('.chat-send use').getAttribute('href') === '#icon-stop'`, "Ctrl+Enter sends new input immediately, shows it, and leaves the first reply running");
  await capture('chat-steering-saved.png');
  await evaluate(`body.querySelector('.chat-send').click()`);
  await check(`window.stopCalls === 1 && body.querySelector('.chat-send use').getAttribute('href') === '#icon-play' && body.querySelector('.chat-send').disabled`, "stop interrupts the running reply and resets the composer");
  await evaluate(`
    frame.runningTasks = ['T-0032'];
    body.querySelector('.task-chat').syncAgentState();
  `);
  await check(`body.querySelector('.chat-send use').getAttribute('href') === '#icon-stop' && !body.querySelector('.chat-send').disabled`, "activity from another window enables stop without a local pending reply");
  await evaluate(`window.typeMessage('Сохранить черновик'); frame.runningTasks = []; body.querySelector('.task-chat').syncAgentState()`);
  await check(`body.querySelector('#task-chat-input').value === 'Сохранить черновик' && body.querySelector('.chat-send use').getAttribute('href') === '#icon-play'`, "completion retains a new draft");
  await evaluate(`api.chatSend = async () => ({ saved: false, result: { ok: false, error: { message: 'Write failed' } } }); body.querySelector('.chat-composer').requestSubmit()`);
  await check(`body.querySelector('#task-chat-input').value === 'Сохранить черновик' && body.querySelector('.chat-status').textContent.includes('Write failed')`, "a save failure retains the draft and displays the error");
  console.log("Chat Chromium checks passed");
  if (keepArtifacts) console.log("Screenshots: " + artifacts);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
