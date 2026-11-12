// Real Chromium checks for the chat renderer, without opening a board or contacting Codex.
// Optional: --references <task attachment directory> --artifacts <screenshot directory>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(createRequire(import.meta.url)("electron"), [script, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: "inherit", timeout: 90_000,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) console.error("Electron exited before completing chat checks: " + result.status);
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, nativeTheme } = await import("electron");
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const artifacts = resolve(option("--artifacts") ?? join(root, ".dev-diary", "chat-check"));
mkdirSync(artifacts, { recursive: true });
const profile = mkdtempSync(join(artifacts, "profile-"));
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
    ${read("chat.js")}
    ${read("renderer.js")}
    void 0;
  `);
  const evaluate = code => window.webContents.executeJavaScript(code);
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
  console.log("Chat Chromium checks passed; screenshots: " + artifacts);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  // Electron may hold profile files briefly on Windows; leave them in the ignored artifact directory.
  try {
    assert.equal(dirname(profile), artifacts);
    rmSync(profile, { recursive: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
  app.exit(process.exitCode ?? 0);
});
