// Real Chromium checks for the chat renderer, without opening a board or contacting Codex.
// Optional: --references <task attachment directory> --artifacts <screenshot directory>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "chat", 90_000);
const { app, BrowserWindow, nativeTheme, ipcMain } = await import("electron");
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
const sourcePreload = join(scratch, "source-preload.cjs");
writeFileSync(sourcePreload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('readSourceFixture', (id, link, source) => ipcRenderer.invoke('check:source', id, link, source));`);
ipcMain.handle("check:source", (_event, _id, link, source) => {
  // Run the production reader with Node's TypeScript support; Electron's loader differs.
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--input-type=module", "-e",
    `import { readMarkdownFile } from ${JSON.stringify(new URL("../src/desktop/markdown-files.ts", import.meta.url).href)};
try { console.log(JSON.stringify({ok:true,data:await readMarkdownFile(process.argv[1],process.argv[2],process.argv[3])})); }
catch { console.log(JSON.stringify({ok:false,error:{code:'MARKDOWN_UNAVAILABLE',message:'Не удалось открыть файл. Проверьте путь и права доступа.'}})); }`,
    root, link, ...(source ? [source] : [])], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
});
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 850, height: 960, show: false,
    webPreferences: { preload: sourcePreload, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const smoke = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const page = join(scratch, "source-scripts.html");
    const paths = [require.resolve("markdown-it/browser"), ...["source-files.cjs", "markdown.js"].map(name => join(root, "src/desktop", name))];
    writeFileSync(page, paths.map(path => `<script src="${pathToFileURL(path).href}"></script>`).join("\n"));
    await smoke.loadFile(page);
    assert.equal(await smoke.webContents.executeJavaScript(`chatMarkdown.render('[styles.css](src/desktop/styles.css:582)')`),
      '<p><a href="src/desktop/styles.css:582">styles.css</a></p>\n');
  } finally { smoke.destroy(); }
  window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const codicon = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
  const iconStyles = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + codicon);
  await window.webContents.insertCSS(read("themes.css") + "\n" + iconStyles + "\n" + read("styles.css"));
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
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${read("review-diff.js")}
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
        { at: '2026-11-12T13:00:10Z', action: 'coordination', actor: 'agent', text: 'Вызов ReadNodePath() в src/Core/Foo.cs:25 возвращает null. Можно повторить проверку без GPU?' },
        { at: '2026-11-12T13:00:20Z', action: 'coordination', actor: 'manager', text: 'Да, сначала проверь **CPU**.\\n\\n### Дальше\\nСверь Node.IsReady.' },
        { at: '2026-11-12T13:00:30Z', action: 'request-changes', actor: 'manager', to: 'in_progress', text: 'Добавь независимый тест.' },
        { at: '2026-11-12T13:01:00Z', action: 'run-log', actor: 'agent', run: activity, durationMs: 433000 },
        { at: '2026-11-12T13:01:10Z', action: 'block', actor: 'agent', to: 'blocked',
          text: 'Could not save task token usage: Another command is working on this board. Retry shortly.\\n\\nuth_storage"}\\n{"level":"WARN","target":"codex_otel::auth_storage"}' },
        { at: '2026-11-12T13:01:20Z', action: 'block', actor: 'agent', to: 'blocked',
          text: 'Не удалось загрузить тестовый ресурс.' },
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
  if (process.argv.includes("--references-only")) {
    await evaluate(`
      const hash = 'bc68941b378733bf3fd03ef354fe2fa0d0539659';
      const checksum = 'a'.repeat(64);
      const tick = String.fromCharCode(96);
      const sample = 'T-0051 ' + tick + 'T-0051' + tick + ' · 0.3.0-alpha ' + tick + 'v0.3.0-alpha' + tick +
        ' · Commit ' + hash + '. File archive.zip: ' + hash + '\\n\\n[Existing T-0051](https://example.com)\\n\\n' +
        tick.repeat(3) + '\\nT-0051 0.3.0-alpha ' + hash + '\\n' + tick.repeat(3);
      body.replaceChildren();
      for (const [label, context] of [
        ['Manager live', { agent: true }], ['Manager saved', { agent: true }],
        ['Executor live', { agent: true, taskId: 'T-0063' }], ['Executor saved', { agent: true, taskId: 'T-0063' }],
        ['Manager to executor', { coordination: true }], ['Executor to manager', { coordination: true }],
        ['Reviewer to manager', { coordination: true }], ['Plain message', {}]
      ]) {
        const section = element('section');
        section.append(element('h3', label));
        if (context.agent || context.coordination) {
          const run = element('div', undefined, 'chat-run');
          const items = context.coordination ? [{ ...action('reference-message', 'mcpToolCall'), messagesOnly: true,
            messages: [{ id: 'T-0063', sequence: 1, actor: label.startsWith('Reviewer') ? 'reviewer' : label.startsWith('Manager') ? 'manager' : 'agent', text: sample }] }] :
            [{ ...action('reference-answer', 'agentMessage', '', label.endsWith('live') ? 'inProgress' : 'completed', sample), phase: 'final_answer' }];
          renderRunActivity(run, items, label.endsWith('saved'), undefined, context.taskId,
            label.startsWith('Manager') && !context.coordination ? { dialogue: true } : undefined);
          section.append(run);
        } else section.append(chatText(sample, context));
        body.append(section);
      }
    `);
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme;
      await check(`(async () => {
        await document.fonts.ready;
        const copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
        try {
          for (const message of body.querySelectorAll('.chat-text')) {
            if (message.querySelectorAll('.chat-task-reference').length !== 2 ||
                message.querySelectorAll('.codicon-milestone').length !== 2 ||
                message.querySelector('a[href="https://example.com"]').textContent !== 'Existing T-0051' ||
                message.querySelector('pre code').textContent !== 'T-0051 0.3.0-alpha ' + hash + '\\n') return false;
            const digests = [...message.querySelectorAll('.chat-digest')];
            if (digests[0].textContent !== hash.slice(0, 7) || digests[0].title !== hash ||
                digests[1].textContent !== hash) return false;
            for (const control of message.querySelectorAll('.chat-digest, .chat-code-copy')) {
              const glyph = control.querySelector('.icon');
              if (getComputedStyle(glyph).fontSize !== getComputedStyle(control).fontSize) return false;
              control.click();
              await new Promise(resolve => setTimeout(resolve, 0));
              if (!glyph.matches('.codicon-check') || getComputedStyle(glyph).fontSize !== getComputedStyle(control).fontSize) return false;
            }
          }
          return copied.length === 24 && copied[0] === hash && copied[1] === hash;
        } finally { delete navigator.clipboard; }
      })()`, theme + ' references, versions, full copy, confirmation sizes, fences and existing links');
      await check(`(async () => {
        const contexts = [{}, { agent: true }, { coordination: true }];
        const copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
        try {
          for (const context of contexts) for (const quoted of [false, true]) {
            const quote = value => quoted ? tick + value + tick : value;
            const cases = [
              ['Commit ' + quote(hash) + '. Файл archive.zip: ' + quote(checksum), [hash, checksum], [hash.slice(0, 7), checksum]],
              ['Commit ' + quote(hash) + ', archive.zip: ' + quote(checksum), [hash, checksum], [hash.slice(0, 7), checksum]],
              ['SHA-256 ' + quote(checksum) + '. Commit ' + quote(hash), [checksum, hash], [checksum, hash.slice(0, 7)]],
              ['SHA-1 ' + quote(hash) + ', Commit: ' + quote(checksum), [hash, checksum], [hash, checksum.slice(0, 7)]],
              ['Commit ' + quote(checksum) + '. checksum: ' + quote(hash), [checksum, hash], [checksum.slice(0, 7), hash]],
              ['Коммит: ' + quote(checksum) + '. Контрольная сумма: ' + quote(hash), [checksum, hash], [checksum.slice(0, 7), hash]],
              ['SHA-256 ' + quote(checksum) + '. ' + quote(hash), [checksum, hash], [checksum, hash.slice(0, 7)]],
              ['Commit завершён. Файл archive.zip: ' + quote(checksum), [checksum], [checksum]]
            ];
            for (const sum of [hash, checksum]) for (const file of [
              'Файл archive.zip:', 'File archive.zip:', 'archive.zip:',
              'Файл README:', 'File README:', '[archive.zip](https://example.com/archive.zip):'
            ]) {
              cases.push(
                [file + ' ' + quote(sum), [sum], [sum]],
                ['Commit ' + quote(hash) + '. ' + file + ' ' + quote(sum), [hash, sum], [hash.slice(0, 7), sum]],
                ['Commit ' + quote(hash) + ', ' + file + ' ' + quote(sum), [hash, sum], [hash.slice(0, 7), sum]],
                [file + ' ' + quote(sum) + '. Commit ' + quote(hash), [sum, hash], [sum, hash.slice(0, 7)]]
              );
            }
            for (const [text, full, visible] of cases) {
              const message = chatText(text, context);
              const digests = [...message.querySelectorAll('.chat-digest')];
              if (digests.length !== full.length || digests.some((button, i) => button.title !== full[i] || button.textContent !== visible[i])) return false;
              const offset = copied.length;
              for (const button of digests) button.click();
              await new Promise(resolve => setTimeout(resolve, 0));
              if (full.some((value, i) => copied[offset + i] !== value)) return false;
            }
          }
          return true;
        } finally { delete navigator.clipboard; }
      })()`, theme + ' hash labels apply only to the adjacent hash in mixed plain and inline paragraphs');
      // A hidden Electron window paints its updated surface on capture.
      await window.webContents.capturePage();
      await evaluate(`new Promise(resolve => setTimeout(resolve, 100))`);
      await capture('references-' + theme + '.png');
    }
    await check(`(async () => {
      const text = 'SHA-1 ' + tick + hash + tick + '\\n\\nCommit ' + tick + checksum + tick;
      const message = chatText(text);
      const buttons = [...message.querySelectorAll('.chat-digest')];
      if (buttons[0].textContent !== hash || buttons[1].textContent !== checksum.slice(0, 7) || buttons[1].title !== checksum) return false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
      try {
        buttons[1].click();
        await new Promise(resolve => setTimeout(resolve, 0));
        return buttons[1].querySelector('.codicon-copy') && buttons[1].getAttribute('aria-label').includes('Не удалось');
      } finally { delete navigator.clipboard; }
    })().then(Boolean)`, 'SHA-1 stays exact, explicit SHA-256 commit shortens, clipboard rejection offers retry');
    await evaluate(`
      const taskBeforeNavigation = taskInSheet;
      const navigations = [];
      api.command = async (command, id) => {
        navigations.push([frame.project, command, id]);
        return { ok: true, data: { ...taskBeforeNavigation, id, history: [], attachments: [] } };
      };
      body.querySelector('.chat-task-reference').click();
    `);
    await check(`taskInSheet.id === 'T-0051' && navigations[0].join('/') === 'fixture/show/T-0051'`, 'mouse opens the task on the current board');
    await evaluate(`body.append(chatText('T-0052')); body.querySelector('.chat-task-reference').focus()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await check(`new Promise(resolve => setTimeout(() => resolve(taskInSheet.id === 'T-0052' && navigations.at(-1).join('/') === 'fixture/show/T-0052'), 100))`, 'Enter opens the task on the current board');
    await evaluate(`
      api.command = async () => ({ ok: false, error: { code: 'TASK_NOT_FOUND', message: 'Task T-9999 not found' } });
      body.append(chatText('T-9999')); body.querySelector('.chat-task-reference').click();
    `);
    await check(`!byId('sheet-notice').hidden && byId('sheet-notice').textContent.includes('T-9999') && body.textContent.includes('Повторить загрузку')`, 'missing task explains the error and offers retry');
    console.log('Chat reference Chromium checks passed');
    return;
  }
  if (process.argv.includes("--composer-only")) {
    await evaluate(`
      frame.board = { settings: { executor: { model: 'board', effort: 'high' } } };
      taskInSheet.execution = { model: 'task', effort: 'medium' };
      let chats = [];
      let modelLoads = 0;
      let pickerClicks = 0;
      let modelFailure = false;
      api.chatModels = async () => {
        modelLoads++;
        if (modelFailure) return { ok: false, error: { message: 'Провайдер недоступен' } };
        return { ok: true, data: [
          { id: 'task', effort: 'low' }, { id: 'preferred', effort: 'high', default: true },
        ] };
      };
      api.chatSend = async (_id, request) => {
        chats.push(request);
        return { saved: true, result: { ok: true } };
      };
      showTask = async () => { body.replaceChildren(taskChat(taskInSheet)); };
      const composerForm = () => body.querySelector('.chat-composer');
      const composerInput = () => byId('task-chat-input');
      const waitForSend = () => new Promise((resolve, reject) => {
        const until = Date.now() + 5000;
        const poll = () => !composerInput().readOnly ? resolve() : Date.now() > until ?
          reject(new Error('Task chat did not finish sending')) : requestAnimationFrame(poll);
        poll();
      });
      const sendText = text => {
        composerInput().value = text;
        composerInput().dispatchEvent(new Event('input'));
        composerForm().requestSubmit();
        return waitForSend();
      };
      showTask();
    `);
    await check(`!composerForm().querySelector('select, .chat-context, .chat-selection') && !modelLoads &&
      !!composerForm().querySelector('.chat-controls').firstElementChild.querySelector('.codicon-add') &&
      !!composerForm().querySelector('.chat-mic .codicon-mic')`, "the composer has a plus and voice input with no model controls or eager model request");
    await evaluate(`
      const picker = composerForm().querySelector('input[type=file]');
      picker.click = () => { pickerClicks++; };
      composerForm().querySelector('.chat-add').click();
      const selection = new DataTransfer();
      selection.items.add(new File(['content'], 'notes.txt', { type: 'text/plain' }));
      picker.files = selection.files;
      picker.dispatchEvent(new Event('change'));
      composerForm().requestSubmit();
      waitForSend();
    `);
    await check(`pickerClicks === 1 && chats[0].files[0].name === 'notes.txt' && chats[0].text === '' &&
      chats[0].model === 'task' && chats[0].effort === 'medium' && modelLoads === 0`, "plus opens the picker and attachment-only messages use the task settings");
    await evaluate(`delete taskInSheet.execution; sendText('Настройки доски')`);
    await check(`chats[1].model === 'board' && chats[1].effort === 'high' && modelLoads === 0`, "the board executor settings are used when the card has no override");
    await evaluate(`taskInSheet.execution = { model: 'task' }; sendText('Уровень по умолчанию')`);
    await check(`chats[2].model === 'task' && chats[2].effort === 'low' && modelLoads === 1`, "a task model without an effort gets the model's default effort");
    await evaluate(`delete taskInSheet.execution; frame.board.settings.executor = null; sendText('Модель по умолчанию')`);
    await check(`chats[3].model === 'preferred' && chats[3].effort === 'high' && modelLoads === 1`, "the default model is used when no executor settings exist");
    await evaluate(`chatCatalog = undefined; modelFailure = true; sendText('Черновик останется')`);
    await check(`composerInput().value === 'Черновик останется' && chats.length === 4 &&
      composerForm().querySelector('.chat-status').textContent.includes('Провайдер недоступен')`, "a catalog failure keeps the draft and shows the error");
    await evaluate(`modelFailure = false; composerForm().requestSubmit(); waitForSend()`);
    await check(`chats[4].text === 'Черновик останется' && composerInput().value === ''`, "sending again retries catalog loading and clears the saved draft");
    console.log("Executor composer Chromium checks passed: 7");
    return;
  }
  await check(`!completedWork.open && completedWork.querySelector('summary').textContent.includes('Выполнено за 7 мин 13 с')`, "completed chronology is folded with its measured duration");
  await check(`log.textContent.includes('Предыдущий запуск прервался при записи статистики токенов.') &&
    !log.textContent.includes('auth_storage') && !log.textContent.includes('Another command is working') &&
    log.textContent.includes('Не удалось загрузить тестовый ресурс.') &&
    [...log.querySelectorAll('.chat-event')].filter(event => event.textContent.includes('Заблокировал задачу')).length === 2`,
    "old token usage failures show a concise reason while preserving status events and other blockers");
  await check(`savedLog.querySelector('.chat-run-final').textContent.includes('Готово.') && !completedWork.querySelector('.chat-run-final')`, "final answer is outside the folded chronology");
  await check(`(() => {
    const entries = [...log.querySelectorAll(':scope > .chat-coordination')];
    return entries.length === 3 && entries[0].querySelector('.chat-author').textContent === 'Исполнитель' &&
      entries[1].querySelector('.chat-author').textContent === 'Менеджер проекта' &&
      getComputedStyle(entries[1].querySelector('.chat-author')).clipPath === 'none' &&
      entries.every(entry => getComputedStyle(entry).borderTopLeftRadius === '10px' &&
        getComputedStyle(entry.querySelector('.chat-text')).borderTopWidth === '1px') &&
      entries[0].querySelector('a[href="src/Core/Foo.cs:25"] code').textContent === 'Foo.cs:25' &&
      entries[0].querySelector('p > code').textContent === 'ReadNodePath()' &&
      entries[1].querySelector('strong').textContent === 'CPU' &&
      entries[1].querySelector('h3').textContent === 'Дальше' &&
      getComputedStyle(entries[1].querySelector('h3')).borderTopWidth === '1px' &&
      entries[1].querySelector('code').textContent === 'Node.IsReady' &&
      entries[2].querySelector('.chat-text').textContent.includes('независимый тест') &&
      entries[2].compareDocumentPosition(savedLog) === Node.DOCUMENT_POSITION_FOLLOWING;
  })()`, "task chat keeps executor messages, manager replies and review feedback visible in sequence");
  await check(`(() => {
    const manager = element('div', undefined, 'chat-run');
    const question = { id: 'T-0005', sequence: 21, actor: 'agent', text: 'Можно повторить проверку без GPU?' };
    const decision = { id: 'T-0005', sequence: 22, actor: 'manager', text: 'Да, сначала проверь **CPU**. Сверь src/Core/Foo.cs:25 и Node.IsReady.' };
    const updates = [
      { ...action('inbox', 'mcpToolCall'), messages: [question], messagesOnly: true },
      action('callback', 'agentMessage', '', 'completed', 'Уточню условия проверки.'),
      { ...action('send', 'mcpToolCall'), messages: [decision], messagesOnly: true },
      { ...action('repeat', 'mcpToolCall'), messages: [question], messagesOnly: true },
      { ...action('final', 'agentMessage', '', 'completed', 'Условия переданы. Node.IsReady сверён.'), phase: 'final_answer' }
    ];
    renderRunActivity(manager, updates, true);
    const [inbound, work, outbound, final] = manager.children;
    log.append(manager);
    const styled = [inbound, outbound].every(entry => getComputedStyle(entry).borderTopLeftRadius === '10px');
    manager.remove();
    if (manager.children.length !== 4 || !inbound.querySelector('.chat-coordination-header').textContent.includes('Исполнитель → Менеджер') ||
        !work.matches('.chat-work:not([open])') || !outbound.querySelector('.chat-coordination-header').textContent.includes('Менеджер → Исполнитель') ||
        outbound.querySelector('button').textContent !== 'T-0005' || outbound.querySelector('strong').textContent !== 'CPU' ||
        !styled ||
        !outbound.querySelector('a[href="src/Core/Foo.cs:25"]') || !final.matches('.chat-run-final') ||
        final.querySelector('code')?.textContent !== 'Node.IsReady') return false;
    renderRunActivity(manager, updates, false, undefined, undefined, { seenMessages: new Set(['T-0005/21']) });
    return manager.querySelectorAll('.chat-coordination').length === 1;
  })()`, "manager chat shows both directions next to the folded work and suppresses duplicate inbox reads");
  await check(`(() => {
    const manager = element('div', undefined, 'chat-run');
    const returned = { id: 'T-0027', sequence: 44, actor: 'reviewer', kind: 'request-changes',
      text: '[P2] Критерий 1: Уточни правила записи.\\n\\n[P3] Критерий 2: Проверь null.' };
    renderRunActivity(manager, ['inbox', 'wait'].map(id => ({
      ...action(id, 'mcpToolCall'), messages: [returned], messagesOnly: true,
    })), true);
    const rows = manager.querySelectorAll(':scope > .chat-coordination');
    log.append(manager);
    const styled = rows.length === 1 && getComputedStyle(rows[0]).borderTopLeftRadius === '10px';
    manager.remove();
    return rows.length === 1 && rows[0].querySelector('.chat-coordination-header').textContent.includes('Ревьюер → Менеджер') &&
      rows[0].querySelector('.chat-review-status')?.textContent === 'Возврат на доработку' &&
      rows[0].querySelector('button').textContent === 'T-0027' &&
      styled &&
      rows[0].querySelectorAll('.chat-review-finding').length === 2 &&
      rows[0].querySelector('.chat-review-priority').textContent === 'P2' &&
      rows[0].querySelector('.chat-review-finding p').textContent === 'Уточни правила записи.';
  })()`, "manager chat shows the reviewer return and findings once");
  await check(`(async () => {
    const run = element('div', undefined, 'chat-run');
    const tick = String.fromCharCode(96);
    const command = "& 'C:\\\\Test folder\\\\run.ps1'";
    const text = 'Запуск из PowerShell: ' + tick + command + tick + '. Скрипт вызывает ' +
      tick + 'dotnet Test.dll' + tick + ' для проверки.';
    renderRunActivity(run, [{ ...action('inbox-command', 'mcpToolCall'), messagesOnly: true,
      messages: [{ id: 'T-0005', sequence: 31, actor: 'agent', text }] }]);
    const message = run.querySelector('.chat-coordination .chat-text');
    const pre = message.querySelector('pre');
    if (pre?.querySelector('code').textContent !== command || message.querySelectorAll('pre').length !== 1 ||
        message.querySelector('p:last-child code')?.textContent !== 'dotnet Test.dll') return false;
    const multiline = 'if ($true) {\\n  ' + command + '\\n}\\n';
    const sample = chatText(tick.repeat(3) + 'powershell\\n' + multiline + tick.repeat(3), {});
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
    try {
      const buttons = [message, sample].map(block => block.querySelector('.chat-code-copy'));
      buttons.forEach(button => button.click());
      await new Promise(resolve => setTimeout(resolve, 0));
      return copied.length === 2 && copied[0] === command && copied[1] === multiline &&
        buttons.every(button => button.getAttribute('aria-label').startsWith('Скопировано.'));
    } finally { delete navigator.clipboard; }
  })()`, "runnable coordination commands and fenced examples copy verbatim as separate blocks");
  await check(`(async () => {
    const commit = 'bc68941b378733bf3fd03ef354fe2fa0d0539659';
    const logHash = '0a6685dffa7687afd0ae7e3c5d08ffaae4e158000442cc388742397126fa26e2';
    const diaryHash = 'a7a8e84224e43cdda6b4501014c5661b867b7e5136ffc855816a0126379d5aaf';
    const path = '.tasks/qa/T-0045/main-bc68941b-gates.log';
    const text = 'На ' + commit + ' прошли Release и сверка API. SHA main совпал. Журнал ' + path +
      ', SHA-256 ' + logHash + '. Дневник T-0046 сохранён в 2026-11-15.md, SHA-256 ' + diaryHash + '.';
    const run = element('div', undefined, 'chat-run');
    renderRunActivity(run, [{ ...action('inbox-evidence', 'mcpToolCall'), messagesOnly: true,
      messages: [{ id: 'T-0045', sequence: 45, actor: 'agent', text }] }]);
    const body = run.querySelector('.chat-coordination .chat-text');
    const [summary, report, diary] = body.querySelectorAll(':scope > p');
    const digests = [...body.querySelectorAll('.chat-digest')];
    const expected = [commit, logHash, diaryHash];
    const logLink = report?.querySelector('a');
    if (!summary?.textContent.endsWith('SHA main совпал. ') ||
        logLink?.getAttribute('href') !== path || logLink.textContent !== 'main-bc68941b-gates.log' ||
        diary?.querySelector('a:not(.chat-task-reference)')?.textContent !== '2026-11-15.md' || digests.length !== 3 ||
        !digests.every((button, i) => button.title === expected[i] && button.textContent === (i === 0 ? expected[i].slice(0, 7) : expected[i]))) return false;
    const tick = String.fromCharCode(96);
    const fenced = chatText(tick.repeat(3) + '\\n' + logHash + '\\n' + tick.repeat(3), { coordination: true });
    if (fenced.querySelector('pre code')?.textContent !== logHash + '\\n' || fenced.querySelector('.chat-digest')) return false;
    if (chatText(text, {}).querySelectorAll('.chat-digest').length !== 3) return false;
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
    try {
      digests.forEach(button => button.click());
      await new Promise(resolve => setTimeout(resolve, 0));
      return copied.length === 3 && copied.every((value, i) => value === expected[i]) &&
        digests.every(button => button.querySelector('.codicon-check'));
    } finally { delete navigator.clipboard; }
  })()`, "coordination evidence separates the summary and reports, with links and full hashes on copy");
  await evaluate(`
    window.foldOpenedLinks = [];
    window.foldOriginalOpenLink = api.openLink;
    api.openLink = async href => { foldOpenedLinks.push(href); };
    window.foldFixture = chatText('Введение.\\n\\n### [**Технические** *детали*](https://example.com/report?a=1&b=2)\\n\\nТело.\\n\\n#### Вложенный раздел\\n\\nПродолжение.\\n\\n### Дальше\\n\\nСледующий раздел.', { agent: true });
    window.foldDialog = element('dialog');
    foldDialog.style.width = '600px';
    foldDialog.append(foldFixture);
    document.body.append(foldDialog);
    foldDialog.showModal();
    window.foldDetails = foldFixture.querySelector('details');
    window.foldSummary = foldDetails.querySelector('summary');
  `);
  await check(`foldSummary.querySelector('a')?.getAttribute('href') === 'https://example.com/report?a=1&b=2' &&
    !!foldSummary.querySelector('strong') && !!foldSummary.querySelector('em')`,
    "folded heading retains the full link and safe inline markup");
  await check(`!foldDetails.open && foldDetails.querySelector('.chat-report-body').textContent.includes('Продолжение.') &&
    foldDetails.nextElementSibling.textContent === 'Дальше' && !foldDetails.textContent.includes('Следующий раздел.')`,
    "folding retains nested content and stops before the next peer heading");
  const foldClick = async selector => {
    const point = await evaluate(`(() => { const el = ${selector}; el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  };
  await foldClick("foldSummary.querySelector('a')");
  await check(`foldOpenedLinks.length === 1 && foldOpenedLinks[0] === 'https://example.com/report?a=1&b=2' && !foldDetails.open`,
    "mouse activation opens the full URL through the shared handler without toggling details");
  await evaluate("foldSummary.querySelector('a').focus()");
  const foldKey = async keyCode => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  };
  await foldKey("Enter");
  await check("foldOpenedLinks.length === 2 && !foldDetails.open", "Enter on the link opens its URL and leaves details closed");
  await evaluate("foldSummary.focus()");
  await foldKey("Enter");
  await check("foldDetails.open && document.activeElement === foldSummary", "Enter on summary expands native details");
  await foldKey("Space");
  await check("!foldDetails.open", "Space on summary collapses native details");
  await foldClick("foldSummary");
  await check("foldDetails.open", "mouse activation of summary expands native details");
  await check(`(() => {
    const tick = String.fromCharCode(96);
    const code = chatText('Введение.\\n\\n### Технические ' + tick + 'детали' + tick + '\\n\\nТело.', { agent: true });
    const bad = chatText('Введение.\\n\\n### [Технические детали](javascript:alert(1))\\n\\nТело.', { agent: true });
    const raw = chatText('Введение.\\n\\n### Технические детали\\n\\n<script>alert(1)</script>', { agent: true });
    const first = chatText('### Технические детали\\n\\nТело.', { agent: true });
    const empty = chatText('Введение.\\n\\n### Технические детали', { agent: true });
    return code.querySelector('summary code')?.textContent === 'детали' && !bad.querySelector('a') &&
      !raw.querySelector('script') && !first.querySelector('details') && !empty.querySelector('details');
  })()`, "inline code survives; URL and raw HTML restrictions and folding eligibility remain intact");
  await evaluate("foldDialog.close(); foldDialog.remove(); api.openLink = foldOriginalOpenLink");
  console.log("Folded heading link, markup, boundaries, mouse, keyboard and safety checks passed");
  await check(`(() => {
    const tick = String.fromCharCode(96);
    const text = 'Полный прогон остановился до проверки интерфейса из-за ошибки кодировки. Целевые проверки прошли.\\n\\n' +
      '### Технические детали\\n\\n' + tick.repeat(3) + 'text\\nSystem.ArgumentException: cp1251\\n' + tick.repeat(3) +
      '\\n\\nЖурнал .tasks/qa/T-0049/GREEN-full.log.\\n\\n### Дальше\\n\\nНазначить исполнителя на исправление кодировки.';
    const run = element('div', undefined, 'chat-run');
    const updates = [{ ...action('inbox-report', 'mcpToolCall'), messagesOnly: true,
      messages: [{ id: 'T-0049', sequence: 49, actor: 'agent', text }] }];
    renderRunActivity(run, updates);
    const body = run.querySelector('.chat-coordination .chat-text');
    const details = body.querySelector('details');
    if (!details || details.open || !body.firstElementChild.textContent.includes('Целевые проверки прошли') ||
        !details.nextElementSibling?.textContent.includes('Дальше')) return false;
    details.querySelector('summary').click();
    renderRunActivity(run, updates);
    return details.open && details.querySelector('pre code').textContent === 'System.ArgumentException: cp1251\\n' &&
      !!details.querySelector('.chat-code-copy') && !!details.querySelector('a[href=".tasks/qa/T-0049/GREEN-full.log"]') &&
      run.querySelector('.chat-report-details').open &&
      !chatText(text, { agent: true, source: 'report.md' }).querySelector('.chat-report-details');
  })()`, "coordination shows the outcome and next action with optional technical evidence");
  await check(`(() => {
    const manager = element('div', undefined, 'chat-run');
    const updates = [
      action('manager-note', 'agentMessage', '', 'completed', 'Проверяю задачу.'),
      { ...action('unblock', 'dynamicToolCall', 'task_unblock'),
        taskChanges: [{ id: 'T-0002', title: 'Удалить старый taskboard', action: 'unblock' }] },
      action('review', 'mcpToolCall', 'ai_taskboard / task_review'),
      { ...action('accept', 'mcpToolCall', 'ai_taskboard / task_accept'),
        taskChanges: [{ id: 'T-0002', title: 'Удалить старый taskboard', action: 'accept' }] },
      { ...action('start', 'mcpToolCall', 'ai_taskboard / task_start'),
        taskChanges: [{ id: 'T-0003', title: 'Следующая задача', action: 'start' }] },
      { ...action('manager-final', 'agentMessage', '', 'completed', 'Задача закрыта.'), phase: 'final_answer' }
    ];
    renderRunActivity(manager, updates);
    const statusRows = () => [...manager.querySelectorAll(':scope > .chat-run-item > summary')].map(row => row.textContent);
    if (!statusRows()[0]?.includes('Задача разблокирована T-0002') ||
        !statusRows()[2]?.includes('Задача принята T-0002')) return false;
    renderRunActivity(manager, updates, true);
    return !!manager.querySelector('.chat-work:not([open]) [data-item="item:review"]') &&
      statusRows()[1]?.includes('Задача принята T-0002') && statusRows()[2]?.includes('Задача запущена T-0003') &&
      manager.lastElementChild.matches('.chat-run-final');
  })()`, "confirmed status events stay visible and ordered even with the tool chronology collapsed");
  await check(`log.querySelectorAll('.chat-work').length === 2 && log.querySelectorAll('.chat-work')[1].textContent.includes('Проверяю оформление обсуждения.')`, "discussion commentary folds above its final answer too");
  await check(`getComputedStyle(log).backgroundColor !== getComputedStyle(body).backgroundColor`, "chat restores its distinct theme background");
  await evaluate(`completedWork.querySelector('summary').click()`);
  await check(`completedWork.open`, "the entire chronology can be disclosed");
  await check(`saved.querySelectorAll(':scope > .chat-run-group').length === 2 && !firstGroup().open`, "consecutive operations collapse into two groups separated by messages");
  await check(`firstGroup().querySelector('.chat-run-label').textContent.includes('3 действия')`, "group count is localized");
  await check(`row('cmd-1').querySelector('.chat-run-command').textContent === longCommand`, "full long command is retained");
  await check(`saved.querySelector('[data-state=failed] > summary').textContent.includes('Ошибок: 1') && saved.querySelector('[data-state=failed] > summary').textContent.includes('Выполняется: 1')`, "collapsed groups expose failed and running operations");
  await check(`!!row('image').querySelector('.codicon-files')`, "image operations have their own icon");
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
      if (link.endsWith('/verification.txt')) return { ok: true, data: {
        name: 'verification.txt', path: 'G:/Projects/2026/Electron2D/.tasks/qa/T-0018/verification.txt',
        text: '**Итог**\\n<script>window.unsafe = true</script>' } };
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
    body.append(chatText('[Отчёт](/G:/Projects/2026/Electron2D/.tasks/qa/T-0018/verification.txt)'));
    body.lastElementChild.querySelector('a').click();
    waitMarkdown('.markdown-preview pre');
  `);
  await check(`markdownReads.at(-1).link.startsWith('/G:/') && markdownReads.at(-1).id === taskInSheet.id &&
    document.querySelector('.markdown-preview pre').textContent.includes('**Итог**') &&
    !document.querySelector('.markdown-preview script') && !window.unsafe`,
    "Windows report links open in chat with literal text and inert HTML");
  await evaluate(`document.querySelector('.markdown-preview').close()`);

  // Exercise real filesystem reads after a DOM click, including live/saved manager renders.
  await evaluate(`
    const mockMarkdownReader = api.readMarkdown;
    api.readMarkdown = window.readSourceFixture;
    body.replaceChildren();
    const cssExample = '[styles.css](src/desktop/styles.css:582)';
    for (const saved of [false, true]) {
      const run = element('div', undefined, 'chat-run');
      renderRunActivity(run, [{ id: 'css-message', type: 'agentMessage', status: saved ? 'completed' : 'inProgress',
        phase: 'final_answer', text: cssExample }], saved, undefined, undefined, { dialogue: true });
      body.append(run);
    }
    for (const context of [{}, { agent: true }, { coordination: true }, { source: ${JSON.stringify(join(root, "README.md"))} }]) {
      body.append(chatText(cssExample, context));
    }
    const sourceOrigins = [...body.querySelectorAll('a')];
  `);
  assert.equal(await evaluate("sourceOrigins.length"), 6);
  for (let i = 0; i < 6; i++) {
    await evaluate(`sourceOrigins[${i}].focus(); sourceOrigins[${i}].click(); waitMarkdown('.markdown-preview .source-line')`, true);
    await check(`document.querySelector('.markdown-preview h2').textContent === 'styles.css:582' &&
      document.querySelector('.markdown-preview mark').textContent === document.querySelector('.markdown-preview pre').textContent.split('\\n')[581] &&
      !document.querySelector('.markdown-preview textarea, .markdown-preview [contenteditable], .markdown-preview script') &&
      sourceOrigins[${i}].textContent === 'styles.css'`, "CSS click reads the real file and selects line 582 as read-only text");
    if (i === 0) await capture("css-source-preview.png");
    await evaluate("document.querySelector('.markdown-preview').close(); new Promise(resolve => requestAnimationFrame(resolve))");
  }
  await evaluate(`body.append(chatText('[missing](src/desktop/missing.css:582)'));
    body.lastElementChild.querySelector('a').click();
    new Promise(resolve => { const poll = () => document.querySelector('.markdown-preview [role="status"]')?.textContent.includes('Проверьте путь') ? resolve() : requestAnimationFrame(poll); poll(); })`);
  await check(`document.querySelector('.markdown-preview [role="status"]').textContent.includes('права доступа')`, "missing CSS shows a readable error");
  await evaluate(`document.querySelector('.markdown-preview').close(); api.readMarkdown = mockMarkdownReader; void 0;`);
  console.log("Source links Chromium checks passed: native scripts, six CSS surfaces, real reader, line 582, missing file; task/hash regressions passed");
  if (process.argv.includes("--source-links-only")) return;

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
    const originalShowTask = showTask;
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
  await check(`!!body.querySelector('.chat-send .codicon-play') && body.querySelector('.chat-send').disabled && !body.querySelector('.chat-send').textContent`, "idle composer uses an accessible play icon");
  await evaluate(`window.typeMessage('Первое сообщение'); body.querySelector('.chat-composer').requestSubmit()`);
  await check(`body.querySelector('.chat-log').textContent.includes('Первое сообщение') && !!body.querySelector('.chat-send .codicon-debug-stop') && !body.querySelector('.chat-send').disabled`, "saved message is visible and empty input switches to stop before the reply");
  await capture('chat-stop-thinking.png');
  await evaluate(`window.typeMessage('Новые данные во время размышления')`);
  await check(`!!body.querySelector('.chat-send .codicon-play') && !body.querySelector('.chat-send').disabled`, "typing during a reply switches stop to enabled play");
  await capture('chat-play-steering.png');
  await evaluate(`body.querySelector('#task-chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))`);
  await check(`window.sentMessages.length === 2 && window.pendingReplies.length === 1 && body.querySelector('.chat-log').textContent.includes('Новые данные во время размышления') && body.querySelector('#task-chat-input').value === '' && !!body.querySelector('.chat-send .codicon-debug-stop')`, "Ctrl+Enter sends new input immediately, shows it, and leaves the first reply running");
  await capture('chat-steering-saved.png');
  await evaluate(`body.querySelector('.chat-send').click()`);
  await check(`window.stopCalls === 1 && !!body.querySelector('.chat-send .codicon-play') && body.querySelector('.chat-send').disabled`, "stop interrupts the running reply and resets the composer");
  await evaluate(`
    frame.runningTasks = ['T-0032'];
    body.querySelector('.task-chat').syncAgentState();
  `);
  await check(`!!body.querySelector('.chat-send .codicon-debug-stop') && !body.querySelector('.chat-send').disabled`, "activity from another window enables stop without a local pending reply");
  await evaluate(`window.typeMessage('Сохранить черновик'); frame.runningTasks = []; body.querySelector('.task-chat').syncAgentState()`);
  await check(`body.querySelector('#task-chat-input').value === 'Сохранить черновик' && !!body.querySelector('.chat-send .codicon-play')`, "completion retains a new draft");
  await evaluate(`api.chatSend = async () => ({ saved: false, result: { ok: false, error: { message: 'Write failed' } } }); body.querySelector('.chat-composer').requestSubmit()`);
  await check(`body.querySelector('#task-chat-input').value === 'Сохранить черновик' && body.querySelector('.chat-status').textContent.includes('Write failed')`, "a save failure retains the draft and displays the error");
  await evaluate(`
    sheet.close();
    showTask = originalShowTask;
    frame.russian = true;
    const reviewFiles = ['bin/verification.json', 'qa/build.log', 'bin/build.log', 'bin/build.log', 'bin/check.ps1',
      'bin/hashes.sha256', 'bin/' + 'a'.repeat(300) + '.bin'].map((source, index) => ({
        source, sha256: String(index).repeat(64),
      }));
    const taskWorktree = 'G:/Projects/2026/Electron2D/.tasks/worktrees/T-0008';
    const submittedCommit = 'a'.repeat(40);
    const acceptedCommit = 'b'.repeat(40);
    const reviewTask = { ...taskInSheet, id: 'T-0008', revision: 2, criteria: ['Пакет собран.'], artifacts: reviewFiles };
    const savedCommand = 'git diff --check; rg -n --glob **/bin/**/*.xml needle . - pass; no matches';
    const reportedResult = { summary: 'Пакет собран.', checks: [
      'dotnet build Electron2D.csproj -c Release - pass; 0 warnings, 0 errors',
      savedCommand,
      'Проверка экспорта — не пройдена; файл отсутствует.\\nКоманда: npm run export',
      'Проверка Windows — пропущена; доступна только сборка Linux.',
      'Проверен состав пакета вручную.',
    ], limitations: ['Приёмка macOS не выполнялась.'] };
    api.command = async () => ({ ok: true, data: { revision: 2, target: 'main', mode: 'merge', submitted: '1234567890123',
      targetHead: '1234567890123', message: 'feat: add package', diff: '', result: reportedResult } });
    showReview(reviewTask).then(() => true);
  `);
  assert.deepEqual(await evaluate(`(() => {
    const checks = body.querySelector('.task-checks');
    const rows = [...checks.querySelectorAll('.task-check')];
    const initiallyClosed = !rows[1].open;
    rows[1].querySelector('summary').click();
    return { length: rows.length, build: rows[0].querySelector('.task-check-name').textContent,
      result: rows[0].querySelector('.task-check-status').textContent,
      note: rows[0].querySelector('.task-check-note').textContent,
      command: rows[1].querySelector('pre').textContent === savedCommand,
      initiallyClosed, opened: rows[1].open && rows[1].querySelector('pre').getBoundingClientRect().height > 0,
      exportCommand: rows[2].querySelector('pre').textContent,
      failure: rows[2].querySelector('.task-check-status').dataset.outcome,
      skipped: rows[3].querySelector('.task-check-status').dataset.outcome,
      manual: rows[4].textContent.trim(), manualStatus: !!rows[4].querySelector('.task-check-status'),
      beforeForm: checks.compareDocumentPosition(body.querySelector('form')) === Node.DOCUMENT_POSITION_FOLLOWING };
  })()`), { length: 5, build: 'Сборка · Release', result: 'Пройдено', note: '0 warnings, 0 errors',
    command: true, initiallyClosed: true, opened: true, exportCommand: 'npm run export', failure: 'failed',
    skipped: 'skipped', manual: 'Проверен состав пакета вручную.', manualStatus: false, beforeForm: true },
  "review explains checks, preserves exact commands behind disclosures and shows explicit failures and skipped results");
  await check(`(() => {
    const files = body.querySelector('#task-review-files');
    const summary = files.querySelector('summary');
    return !files.open && summary.textContent.includes('Материалы проверки') && summary.textContent.includes('7 файлов') &&
      files.compareDocumentPosition(body.querySelector('form')) === Node.DOCUMENT_POSITION_FOLLOWING;
  })()`, "review offers a collapsed count of files before the acceptance form");
  await evaluate(`
    api.command = async () => ({ ok: true, data: { revision: 2, noChanges: true, result: reportedResult } });
    showReview(reviewTask).then(() => true);
  `);
  await check(`body.querySelectorAll('.task-check').length === 5 && !!body.querySelector('#task-review-files') &&
    body.textContent.includes('Сдано без изменений в Git.')`, "review without a Git diff shows both checks and review materials");
  await evaluate(`
    const sourceTask = { ...reviewTask, title: 'Собрать пакет', status: 'done', priority: 'normal',
      updatedAt: '2026-11-12T13:00:00Z', tags: [], subtasks: [], history: [], attachments: [],
      git: { target: 'refs/heads/main', worktree: taskWorktree, submission: { sha: submittedCommit }, accepted: acceptedCommit },
    };
    api.command = async () => ({ ok: true, data: sourceTask });
    const revealedFiles = [];
    api.revealArtifact = async (...args) => {
      revealedFiles.push(args);
      return { ok: revealedFiles.length === 1, error: { code: 'ARTIFACT_UNAVAILABLE' } };
    };
    showTask(sourceTask.id).then(() => true);
  `);
  assert.deepEqual(await evaluate(`(() => {
    const files = body.querySelector('#task-review-files');
    const git = body.querySelector('#task-git');
    return { filesOpen: files.open, gitOpen: git.open, branch: git.querySelector('.task-details-hint').textContent,
      showsOnlySummary: files.offsetHeight <= files.querySelector('summary').offsetHeight + 2 };
  })()`), { filesOpen: false, gitOpen: false, branch: "main", showsOnlySummary: true },
  "task card leaves files and Git details collapsed");
  await evaluate(`body.querySelector('#task-review-files summary').click(); body.querySelector('#task-git summary').click()`);
  assert.deepEqual(await evaluate(`[...body.querySelectorAll('#task-review-files h3')].map(item => item.textContent)`),
    ["Отчёты и документы", "Журналы", "Скрипты", "Контрольные суммы", "Другие файлы"]);
  assert.deepEqual(await evaluate(`[...body.querySelectorAll('#task-git :is(dt, dd)')].map(item => item.textContent)`),
    ["Целевая ветка", "refs/heads/main", "Рабочая копия задачи", "G:/Projects/2026/Electron2D/.tasks/worktrees/T-0008",
      "Сданный коммит", "a".repeat(40), "Коммит приёмки", "b".repeat(40)]);
  await check(`(() => {
    const entries = [...body.querySelectorAll('#task-review-files button')];
    return entries[0].querySelector('.task-review-file-name').textContent === 'verification.json' &&
      entries[0].title.startsWith('bin/verification.json') &&
      entries[1].querySelector('small').textContent === 'qa/' &&
      entries[2].querySelector('small').textContent === 'bin/ · ' + '2'.repeat(12) &&
      entries.at(-1).scrollWidth <= entries.at(-1).clientWidth + 1;
  })()`, "review files use short names, distinguish duplicates and wrap a long name");
  await evaluate(`body.querySelectorAll('#task-review-files button')[2].click(); body.querySelectorAll('#task-review-files button')[3].click()`);
  assert.deepEqual(await evaluate(`revealedFiles`),
    [["T-0008", "bin/build.log", "2".repeat(64)], ["T-0008", "bin/build.log", "3".repeat(64)]]);
  await check(`byId('sheet-notice').textContent === 'Этот файл проверки больше недоступен.'`, "a removed review file shows a localized error");
  await evaluate(`showTask(sourceTask.id).then(() => true)`);
  await check(`body.querySelector('#task-review-files').open && body.querySelector('#task-git').open`, "opened details remain open on refresh");
  await evaluate(`
    api.command = async () => ({ ok: true, data: { ...sourceTask, artifacts: [], git: undefined } });
    showTask(sourceTask.id).then(() => true);
  `);
  await check(`!body.querySelector('.task-details')`, "task card omits empty sections");
  await evaluate(`
    const previewTask = { ...sourceTask, id: 'T-0018', title: 'Карточка с большой историей', description: 'Описание из снимка' };
    frame.board = { tasks: [previewTask], archived: [] };
    let taskRead = Promise.withResolvers();
    api.command = () => taskRead.promise;
    let pendingTask = showTask(previewTask.id);
    void 0;
  `);
  await check(`sheet.open && byId('sheet-title').textContent.includes('Карточка с большой историей') &&
    body.textContent.includes('Описание из снимка') && body.querySelector('[role=status]') &&
    !body.querySelector('button') && !body.querySelector('.task-chat')`, "task title and preview appear while the details request is pending");
  await evaluate(`taskRead.resolve({ ok: false, error: { message: 'Read failed' } }); pendingTask.then(() => true)`);
  await check(`sheet.open && byId('sheet-notice').textContent === 'Read failed' &&
    body.querySelector('button').textContent === 'Повторить загрузку'`, "a failed details request can be retried from the open preview");
  await evaluate(`
    taskRead = Promise.withResolvers();
    const retry = body.querySelector('button');
    retry.click();
    Promise.resolve().then(() => {
      taskRead.resolve({ ok: true, data: { ...previewTask, description: 'Актуальное описание' } });
    });
  `);
  await check(`body.textContent.includes('Актуальное описание') && !body.textContent.includes('Описание из снимка') &&
    !!body.querySelector('.task-chat')`, "fresh task details replace the preview when retry completes");
  await evaluate(`
    taskRead = Promise.withResolvers();
    pendingTask = showTask(sourceTask.id);
    sheet.close();
    taskRead.resolve({ ok: true, data: sourceTask });
    pendingTask.then(() => true);
  `);
  await check(`!sheet.open`, "closing while details are loading does not reopen the card");
  await evaluate(`
    const closedTask = { ...sourceTask, artifacts: [], codexThreadId: '01234567-1234-5678-1234-123456789012',
      questions: ['Уточнение к задаче'], history: [
        { action: 'coordination', actor: 'manager', at: sourceTask.updatedAt, text: 'Перед запуском' },
        { action: 'run-log', actor: 'agent', at: sourceTask.updatedAt, durationMs: 8500 },
        { action: 'coordination', actor: 'agent', at: sourceTask.updatedAt, text: 'После запуска' },
      ],
    };
    let historyCalls = 0;
    api.taskRunHistory = async id => {
      if (id !== closedTask.id || ++historyCalls === 1) return { ok: false, error: { message: 'Codex unavailable' } };
      return { ok: true, data: { 1: [
        action('history-reason', 'reasoning', '', 'completed', 'Сверка проекта'),
        action('history-command', 'commandExecution', 'git status', 'completed', 'Clean'),
      ] } };
    };
    api.command = async () => ({ ok: true, data: closedTask });
    showTask(closedTask.id).then(() => true);
  `);
  await check(`historyCalls === 0 && !body.querySelector('.chat-work')`, "a completed card reads Codex history only on request");
  await evaluate(`const restoreRun = body.querySelector('.chat-header > button.button.quiet'); restoreRun.click(); void 0`);
  await check(`!restoreRun.disabled && body.querySelector('.chat-header [role=status]').textContent.includes('Codex unavailable')`,
    "a history failure leaves the load action available");
  await evaluate(`restoreRun.click(); void 0`);
  await check(`(() => {
    const log = body.querySelector('.chat-log');
    const entries = [...log.querySelectorAll('.chat-coordination')];
    const run = log.querySelector('.chat-work');
    return historyCalls === 2 && !restoreRun.isConnected && !run.open &&
      entries[0].compareDocumentPosition(run) === Node.DOCUMENT_POSITION_FOLLOWING &&
      run.compareDocumentPosition(entries[1]) === Node.DOCUMENT_POSITION_FOLLOWING &&
      run.textContent.includes('Сверка проекта') && run.textContent.includes('git status');
  })()`, "restored commands and summaries use the existing work disclosure between task messages");
  await evaluate(`
    const turn = Promise.withResolvers();
    const ready = Promise.withResolvers();
    let stopCallsForManager = 0;
    api.boardHistory = async () => ({ ok: true, data: { turns: [] } });
    api.boardQueue = async (_project, action) => ({ ok: true, data: action === 'list' ? [] : 'request' });
    api.boardSuggestions = async () => [];
    api.boardRequest = () => { manager.enableStop(); ready.resolve(true); return turn.promise; };
    api.stopOrchestrator = async () => {
      stopCallsForManager++;
      turn.resolve({ ok: true, data: {} });
      return { ok: true };
    };
    const manager = draftComposer();
    body.replaceChildren(manager);
    const actionButton = manager.querySelector('.draft-send');
    manager.querySelector('.draft-input textarea').value = 'Проверь доску';
    manager.requestSubmit();
    Promise.all([ready.promise, document.fonts.load('22px codicon', String.fromCharCode(0xeba5))]).then(() => true);
  `);
  assert.deepEqual(await evaluate(`(async () => {
    const panel = manager.querySelector('.board-chat');
    const pin = panel.querySelector('.board-chat-pin');
    const bounds = panel.querySelector('.board-chat-bar').getBoundingClientRect();
    const button = pin.getBoundingClientRect();
    const resize = panel.querySelector('.board-chat-resize').getBoundingClientRect();
    const tabs = panel.querySelector('.board-chat-views').getBoundingClientRect();
    pin.click();
    await Promise.resolve();
    manager.closeChat();
    const pinned = manager.hasAttribute('data-pinned') && manager.hasAttribute('data-open') && pin.getAttribute('aria-pressed') === 'true';
    pin.click();
    await Promise.resolve();
    return { inside: button.width > 0 && button.height > 0 && button.left >= bounds.left && button.right <= bounds.right &&
        button.top >= bounds.top && button.bottom <= bounds.bottom,
      separate: tabs.right <= resize.left && resize.right <= button.left && button.left > (bounds.left + bounds.right) / 2,
      centered: Math.abs((resize.left + resize.right - bounds.left - bounds.right) / 2) < .1,
      pinned, unpinned: pin.getAttribute('aria-pressed') === 'false' };
  })()`), { inside: true, separate: true, centered: true, pinned: true, unpinned: true },
  "manager pin sits in the top corner and remains separate from the centered resize handle");
  await check(`(() => {
    const status = manager.querySelector('.chat-thinking > span');
    const update = (type, { title = '', text = '', status = 'inProgress' } = {}) =>
      manager.updateActivity([{ id: 'live', type, title, text, status }]);
    if (status.textContent !== 'Думаю…') return false;
    update('reasoning', { text: '**Проверяю карточку**\\n\\n## Сверяю критерии' });
    if (status.textContent !== 'Сверяю критерии' || manager.querySelector('[data-item="item:live"]')) return false;
    const command = '"C:' + String.fromCharCode(92, 92) + 'bin' + String.fromCharCode(92, 92) + 'pwsh.exe" -Command "git status --short"';
    update('commandExecution', { title: command });
    if (status.textContent !== 'Выполняется git status --short' || !status.querySelector('.codicon-terminal')) return false;
    const animation = status.getAnimations()[0];
    update('commandExecution', { title: command, text: 'Строка вывода' });
    if (!animation || status.getAnimations()[0] !== animation) return false;
    update('mcpToolCall', { title: 'ai_taskboard / task_review' });
    if (status.textContent !== 'Вызов инструмента ai_taskboard / task_review' || status.querySelector('.codicon-terminal')) return false;
    update('webSearch', { title: 'Chromium CSS' });
    if (status.textContent !== 'Поиск в интернете · Chromium CSS') return false;
    manager.setWaiting(true);
    update('commandExecution', { title: command });
    if (status.textContent !== 'Жду освобождения чата Codex…') return false;
    manager.setWaiting(false);
    manager.enableStop();
    update('commandExecution', { title: command, status: 'completed' });
    return status.textContent === 'Думаю…' && !status.querySelector('.codicon-terminal');
  })()`, "manager status follows the current heading, readable command, tool and search without restarting on output");
  nativeTheme.themeSource = "dark";
  assert.deepEqual(await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    const button = actionButton.getBoundingClientRect();
    const glyph = actionButton.querySelector('.codicon-stop-circle');
    const bounds = glyph?.getBoundingClientRect();
    const style = getComputedStyle(actionButton);
    resolve({ enabled: !actionButton.disabled, label: actionButton.getAttribute('aria-label'),
      width: button.width, height: button.height, radius: style.borderRadius, fill: style.backgroundColor, ink: style.color,
      glyph: bounds && [bounds.width, bounds.height, bounds.left - button.left, bounds.top - button.top],
      usesFont: !!glyph && getComputedStyle(glyph, '::before').content.includes(String.fromCharCode(0xeba5)),
    });
  })))`), { enabled: true, label: "Остановить ответ", width: 28, height: 28, radius: "50%",
    fill: "rgb(191, 189, 182)", ink: "rgb(38, 42, 48)", glyph: [22, 22, 3, 3], usesFont: true },
  "manager stop uses a filled circle and a centered Codicons glyph");
  await capture("manager-stop-dark.png");
  nativeTheme.themeSource = "light";
  await evaluate(`new Promise(resolve => {
    const scheme = matchMedia('(prefers-color-scheme: light)');
    if (scheme.matches) resolve(true);
    else scheme.addEventListener('change', () => resolve(true), { once: true });
  })`);
  assert.deepEqual(await evaluate(`new Promise(resolve => {
    Promise.allSettled(actionButton.getAnimations().map(animation => animation.finished)).then(() => {
      const style = getComputedStyle(actionButton);
      resolve([style.backgroundColor, style.color]);
    });
  })`), ["rgb(61, 61, 58)", "rgb(255, 255, 255)"], "manager stop has an inverted high-contrast light theme");
  await evaluate(`actionButton.click(); turn.promise.then(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))))`);
  await check(`stopCallsForManager === 1 && actionButton.matches('[data-action="send"]') && !!actionButton.querySelector('.codicon-arrow-up')`,
    "the same manager button stops the reply and returns to send");
  await evaluate(`manager.dispose()`);
  // Use the production projection, also asserted at all request exits by the
  // orchestrator test. Observe added nodes, including ones removed before paint.
  const projection = spawnSync(process.env.TASKBOARD_CHECK_NODE, ['--input-type=module', '-e', `
    import { managerChatItems } from ${JSON.stringify(new URL('../src/desktop/manager-history.ts', import.meta.url).href)};
    const raw = ['manager_inbox', 'task_wait', 'task_message'].map((tool, index) => ({
      id: tool, type: 'mcpToolCall', title: 'ai_taskboard / ' + tool, text: 'PRIVATE RESULT', status: 'completed',
      messagesOnly: tool !== 'task_wait', messages: [{ id: 'T-0072', sequence: index + 1,
        actor: ['agent', 'reviewer', 'manager'][index], text: 'PRIVATE MESSAGE' }]
    }));
    console.log(JSON.stringify({ raw, chat: managerChatItems(raw) }));
  `], { encoding: 'utf8', windowsHide: true });
  assert.equal(projection.status, 0, projection.stderr);
  await evaluate(`
    const routed = ${projection.stdout};
    let finishCoordination = Promise.withResolvers();
    const coordinationReady = Promise.withResolvers();
    let savedCoordination = false;
    api.boardRequest = () => { coordinationManager.enableStop(); coordinationReady.resolve(); return finishCoordination.promise; };
    api.boardHistory = async (_project, _cursor, view) => ({ ok: true, data: view === 'live'
      ? { work: [], chat: routed.raw } : { turns: view === 'work' && savedCoordination
        ? [{ messages: [], items: routed.raw }] : [], nextCursor: null } });
    const coordinationManager = draftComposer();
    body.replaceChildren(coordinationManager);
    byId('sheet-title').textContent = 'T-0072 · Переписка агентов';
    // The task-sheet fixture needs room above the composer for its popup panel.
    body.style.paddingTop = '410px';
    coordinationManager.querySelector('.board-chat-pin').click();
    const dialogue = coordinationManager.querySelector('.board-chat-log:not(.board-work)');
    let leaks = [];
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches('.chat-coordination') || node.querySelector('.chat-coordination') ||
            node.textContent.includes('PRIVATE'))) leaks.push(node.textContent);
      }
    });
    observer.observe(dialogue, { childList: true, subtree: true });
    coordinationManager.querySelector('.draft-input textarea').value = 'Проверь сообщения агентов';
    coordinationManager.dispatchEvent(new Event('submit', { cancelable: true }));
    Promise.race([coordinationReady.promise, new Promise((_, reject) => setTimeout(() =>
      reject(new Error('Coordination request did not start: ' + coordinationManager.textContent)), 5000))]).then(() => true);
  `);
  for (const completed of [false, true]) {
    await evaluate(`coordinationManager.updateActivity(routed.chat); void 0`);
    await check(`leaks.length === 0`, 'streamed coordination never inserts dialogue DOM nodes');
    if (completed) await evaluate(`finishCoordination.resolve({ ok: true, data: {
      answer: 'Сообщения агентов доступны в ходе работы.', items: [...routed.chat,
        { ...action('public', 'agentMessage', '', 'completed', 'Сообщения агентов доступны в ходе работы.'), phase: 'final_answer' }]
    } }); finishCoordination.promise.then(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))))`);
  }
  await check(`leaks.length === 0 && dialogue.textContent.includes('Сообщения агентов доступны')`,
    'completed reply preserves public text without intermediate coordination insertions');
  await capture('coordination-dialogue.png');
  await evaluate(`coordinationManager.querySelector('.board-work-toggle').click(); void 0`);
  await check(`coordinationManager.querySelector('.board-work').querySelectorAll('.chat-coordination').length === 3 && leaks.length === 0`,
    'all three directions remain in live work without leaking into dialogue');
  await evaluate(`savedCoordination = true; coordinationManager.invalidateWork(); void 0`);
  await check(`coordinationManager.querySelector('.board-work').querySelectorAll('.chat-coordination').length === 3`,
    'saved work replaces live work without duplicates');
  await capture('coordination-work.png');
  await evaluate(`coordinationManager.querySelector('.board-dialogue-toggle').click(); void 0`);
  await check(`leaks.length === 0 && dialogue.textContent.includes('Сообщения агентов доступны')`,
    'switching back preserves dialogue and never inserts coordination');
  await evaluate(`
    const lateWork = Promise.withResolvers();
    api.boardHistory = async (_project, _cursor, view) => view === 'work' ? lateWork.promise :
      { ok: true, data: view === 'live' ? { work: [], chat: [] } : { turns: [] } };
    coordinationManager.querySelector('.board-work-toggle').click();
    coordinationManager.dispose();
    frame.project = 'other-fixture';
    const otherManager = draftComposer();
    body.replaceChildren(otherManager);
    lateWork.resolve({ ok: true, data: { turns: [{ messages: [], items: routed.raw }], nextCursor: null } });
    lateWork.promise.then(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));
  `);
  await check(`!otherManager.textContent.includes('PRIVATE') && !otherManager.querySelector('.chat-coordination') && leaks.length === 0`,
    'late history after disposal and project switch cannot mix streams');
  await evaluate(`observer.disconnect(); otherManager.dispose()`);
  console.log("Chat Chromium checks passed");
  if (keepArtifacts) console.log("Screenshots: " + artifacts);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
