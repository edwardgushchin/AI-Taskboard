// Real Chromium, production renderer and synthetic API; no model or board writes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-question", 90_000);
console.log('Starting manager question Chromium check');
const { app, BrowserWindow, clipboard, nativeTheme } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
const read = name => readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const commands = [
  ["bat", '@echo off\nset "ROOT=C:\\Synthetic Folder\\100%"\necho "%ROOT%" ^& echo ^<tag^> | find "tag"\n'],
  ["cmd", 'cmd /d /c "echo %TEMP% && echo a^&b || echo failed"\nREM C:\\Synthetic\\file.txt\n'],
  ["PowerShell", '$path = "C:\\Synthetic Folder\\file.txt"\nWrite-Output "$path `"quoted`" 100% & < > |"\n'],
  ["unknown-synthetic", 'literal \\ % ! ^ & | < > "quote" \'single\'\nsecond line\n'],
];
const question = {
  id: "synthetic-question", options: ["**Literal** `option`", "Второй вариант",
    '*Выбрать* [документ](docs/design.md) и [сайт](https://example.com/) ![Описание](https://example.com/option.png) <img src=x onerror="window.questionExecuted=true">',
    '**Длинный вариант**\n`' + 'C:\\Synthetic\\100%&|<>"quoted"\\'.repeat(12) + '`'],
  text: 'Проверить **команды** и *оформление* для `C:\\Synthetic`?\n\n' +
    '- Первый пункт\n- Второй пункт\n\n[Документ](docs/design.md) и [сайт](https://example.com/)\n\n' +
    '<script>window.questionExecuted = true</script>\n\n<img src=x onerror="window.questionExecuted = true">\n\n' +
    '[Опасная ссылка](javascript:alert(1))\n\n' +
    commands.map(([language, code]) => '```' + language + '\n' + code + '```').join('\n\n') +
    '\n\n```cmd\necho ' + 'synthetic-long-path\\'.repeat(60) + '\n```\n\n' +
    Array.from({ length: 15 }, (_, i) => `Абзац ${i + 1}: синтетический длинный вопрос с доступной прокруткой.`).join('\n\n'),
};
let window;
let status = 0;
const results = [];
app.whenReady().then(async () => {
try {
  console.log('Chromium ready');
  window = new BrowserWindow({ width: 850, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on('console-message', details => {
    if (details.level === 'error') console.error(details.message);
  });
  const imageRequests = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['https://example.com/*'] }, (details, done) => {
    imageRequests.push(details.url);
    done({ cancel: true });
  });
  const evaluate = (code, gesture = false) => window.webContents.executeJavaScript(code, gesture);
  const check = async (code, name) => { assert.equal(await evaluate(code), true, name); results.push(name); };
  const settle = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await settle();
  };
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const page = join(scratch, "question.html");
  writeFileSync(page, html);
  await window.loadFile(page);
  const font = readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url)).toString("base64");
  await window.webContents.insertCSS(read("themes.css") + read("styles.css") +
    read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + font));
  await evaluate(`
    window.taskboard = { subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
      chatModels: async () => ({ ok: true, data: [] }), boardHistory: async () => ({ ok: true, data: { turns: [] } }),
      boardQueue: async () => ({ ok: true, data: [] }) };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${read("review-diff.js")}
    ${localizationFixture()}
    ${read("renderer.js")}
    ${read("keyboard-focus.js")}
    frame = { project: 'synthetic-board', russian: true };
    taskInSheet = { id: 'T-9999' }; // An open task must not become the question's document base.
    window.answers = []; window.links = []; window.documents = [];
    api.answerBoardQuestion = async (id, answer) => { answers.push({ id, answer }); return { ok: true }; };
    api.openLink = async href => { links.push(href); return { ok: true }; };
    api.readMarkdown = async (...args) => { documents.push(args); return { ok: true, data: { name: 'design.md', path: 'docs/design.md', text: '# Synthetic document' } }; };
    window.fixture = ${JSON.stringify(question)};
    window.composer = draftComposer(); document.body.append(composer);
    window.trigger = composer.querySelector('.manager-question-trigger');
    window.dialog = () => document.querySelector('.manager-question');
    composer.updateQuestion(fixture); void 0;
  `);
  await check(`dialog()?.open && dialog().querySelector('.manager-question-text').tagName === 'DIV' &&
    dialog().querySelectorAll('.manager-question-text > p').length > 10 &&
    !!dialog().querySelector('strong') && !!dialog().querySelector('em') &&
    dialog().querySelector('p > code')?.textContent === 'C:\\\\Synthetic' &&
    dialog().querySelectorAll('li').length === 2 && dialog().querySelectorAll('pre > code').length === 5 &&
    !dialog().querySelector('p pre, p div')`, "live question renders Markdown with valid block nesting");
  await check(`!window.questionExecuted && !dialog().querySelector('script, img, a[href^="javascript:"]') &&
    dialog().textContent.includes('<script>')`, "HTML and executable links stay inert");
  await check(`(() => { const options = dialog().querySelectorAll('.manager-question-options button');
    return options[0].textContent === 'Literal option' && options[0].querySelector('strong')?.textContent === 'Literal' &&
      options[0].querySelector('code')?.textContent === 'option' && options[1].textContent === fixture.options[1] &&
      !dialog().querySelector('.manager-question-options :is(a, img, input, pre, p, div)') &&
      options[2].querySelector('em')?.textContent === 'Выбрать' && options[2].textContent.includes('Описание') &&
      options[2].textContent.includes('<img src=x') && !dialog().querySelector('.manager-question-options a, .manager-question-options img') &&
      !!options[3].querySelector('br') && !!options[3].querySelector('code'); })()`,
    "option captions render inline Markdown; plain text stays unchanged; links and images are inert captions");
  const previousClipboard = await clipboard.readText();
  await evaluate(`const writeClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async text => { window.copiedSource = text; return writeClipboard(text); }; void 0;`);
  try {
    window.show();
    window.focus();
    window.webContents.focus();
    for (let i = 0; i < commands.length; i++) {
      await evaluate(`dialog().querySelectorAll('.chat-code-copy')[${i}].click(); void 0;`, true);
      await evaluate(`new Promise((resolve, reject) => {
        const start = performance.now(); const poll = () => {
          const copy = dialog().querySelectorAll('.chat-code-copy')[${i}];
          if (copy.querySelector('.codicon-check')) return resolve();
          if (performance.now() - start > 3000) return reject(Error(copy.getAttribute('aria-label')));
          setTimeout(poll, 20);
        }; poll();
      })`);
      assert.equal(await evaluate('window.copiedSource'), commands[i][1], commands[i][0] + " exact source");
      const nativeText = process.platform === 'win32' ? commands[i][1].replaceAll('\n', '\r\n') : commands[i][1];
      assert.equal(await clipboard.readText(), nativeText, commands[i][0] + " native clipboard");
      results.push(commands[i][0] + " copies exact multiline source to OS clipboard");
    }
  } finally { await clipboard.writeText(previousClipboard); }
  console.log('Clipboard checks passed');
  await evaluate(`dialog().querySelector('a[href="docs/design.md"]').click(); void 0;`);
  await settle();
  await check(`documents.length === 1 && documents[0][0] === undefined && documents[0][1] === 'docs/design.md' &&
    !!document.querySelector('.markdown-preview[open]')`, "document link uses board context despite open task");
  await evaluate(`document.querySelector('.markdown-preview').close(); dialog().querySelector('a[href="https://example.com/"]').click(); void 0;`);
  await check(`links.join() === 'https://example.com/'`, "external link follows existing openLink policy");
  console.log('Link checks passed');

  for (const width of [850, 480]) {
    window.setSize(width, 800);
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await settle();
      await check(`(() => {
        const d = dialog(), form = d.querySelector('form'), code = d.querySelectorAll('pre')[4];
        const box = d.getBoundingClientRect(), header = d.querySelector('header').getBoundingClientRect();
        code.scrollLeft = 200;
        form.scrollTop = form.scrollHeight;
        const submit = d.querySelector('[type=submit]').getBoundingClientRect();
        const valid = box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
          form.scrollHeight > form.clientHeight && form.scrollWidth <= form.clientWidth && code.scrollLeft > 0 &&
          header.top >= 0 && submit.bottom <= box.bottom && submit.top > header.bottom;
        form.scrollTop = 0; code.scrollLeft = 0;
        return valid;
      })()`, `bounded dialog, inner code scroll and reachable actions: ${width}/${theme}`);
      await evaluate(`dialog().querySelector('header button').focus(); void 0;`);
      await key("Tab");
      await check(`dialog().contains(document.activeElement)`, `keyboard stays in modal: ${width}/${theme}`);
      await evaluate(`dialog().querySelector('.sheet-actions .quiet').focus(); void 0;`);
      await key('Tab');
      await check(`document.activeElement === dialog().querySelector('header button')`, `Tab wraps to close: ${width}/${theme}`);
      await key('Tab', ['shift']);
      await check(`document.activeElement === dialog().querySelector('.sheet-actions .quiet')`, `Shift+Tab wraps to skip: ${width}/${theme}`);
      await evaluate(`dialog().querySelectorAll('pre')[4].focus(); void 0;`);
      await key('Right');
      await evaluate(`new Promise(r => setTimeout(r, 150))`);
      await check(`document.activeElement === dialog().querySelectorAll('pre')[4] &&
        dialog().querySelectorAll('pre')[4].scrollLeft > 0`, `code scrolls with keyboard: ${width}/${theme}`);
      if (width === 480) {
        await evaluate(`dialog().querySelectorAll('pre')[4].scrollIntoView({ block: 'center' }); void 0;`);
        await settle();
        writeFileSync(join(artifacts, `code-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        await evaluate(`dialog().querySelector('.manager-question-options').scrollIntoView({ block: 'start' }); void 0;`);
        await settle();
        writeFileSync(join(artifacts, `options-${theme}.png`), (await window.webContents.capturePage()).toPNG());
        await evaluate(`dialog().querySelector('textarea').focus(); void 0;`);
        await settle();
        writeFileSync(join(artifacts, `answer-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await evaluate(`dialog().querySelector('form').scrollTop = 0; void 0;`);
      await settle();
      writeFileSync(join(artifacts, `question-${width}-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await key("Escape");
  await check(`!dialog() && document.activeElement === trigger && !trigger.hidden && answers.length === 0`,
    "Escape closes without answering and restores trigger focus");
  await evaluate(`trigger.click(); void 0;`);
  await check(`dialog().open && dialog().querySelectorAll('pre').length === 5 &&
    dialog().querySelector('.manager-question-options strong')?.textContent === 'Literal' &&
    dialog().querySelector('.manager-question-options code')?.textContent === 'option'`, "pending question reopens with Markdown in body and options");
  await evaluate(`dialog().querySelector('.manager-question-options button').click(); void 0;`);
  await settle();
  await check(`!dialog() && answers[0].id === fixture.id && answers[0].answer === fixture.options[0]`, "choice sends unchanged text");
  await evaluate(`composer.updateQuestion(undefined); composer.updateQuestion({ ...fixture, id: 'free' });
    window.freeText = ${JSON.stringify('  **raw** \nC:\\Synthetic\\100% & | < > "quoted"  ')};
    dialog().querySelector('textarea').value = freeText;
    dialog().querySelector('textarea').dispatchEvent(new Event('input')); void 0;`);
  await check(`dialog().querySelector('textarea').value === freeText && !dialog().querySelector('[type=submit]').disabled`,
    "free answer retains literal text and existing validation");
  await evaluate(`dialog().querySelector('form').requestSubmit(); void 0;`);
  await settle();
  await check(`answers[1].answer === freeText.trim() && !dialog()`, "free answer submits with existing trim behavior");
  await evaluate(`composer.updateQuestion(undefined); composer.updateQuestion({ ...fixture, id: 'skip' });
    dialog().querySelector('.sheet-actions .quiet').click(); void 0;`);
  await settle();
  await check(`answers[2].answer === null && !dialog()`, "skip sends null");
  for (const index of [1, 2, 3]) {
    await evaluate(`(() => { composer.updateQuestion(undefined); composer.updateQuestion({ ...fixture, id: 'option-${index}' });
      const option = dialog().querySelectorAll('.manager-question-options button')[${index}];
      (option.querySelector('code, em') ?? option).click(); })(); void 0;`);
    await settle();
    await check(`!dialog() && answers.at(-1).id === 'option-${index}' && answers.at(-1).answer === fixture.options[${index}]`,
      `option ${index} sends its exact original string from nested caption clicks`);
  }
  await evaluate(`composer.dispose(); composer.remove(); composer = draftComposer(); document.body.append(composer);
    trigger = composer.querySelector('.manager-question-trigger'); composer.updateQuestion(fixture); void 0;`);
  await check(`dialog().open && dialog().querySelectorAll('pre').length === 5 &&
    dialog().querySelector('.manager-question-options strong')?.textContent === 'Literal' &&
    dialog().querySelector('.manager-question-options code')?.textContent === 'option'`, "restored pending question renders body and options after composer recreation");
  await evaluate(`api.answerBoardQuestion = async () => ({ ok: false, error: { message: 'Synthetic failure' } });
    dialog().querySelector('.manager-question-options button').click(); void 0;`);
  await settle();
  await check(`dialog().open && !dialog().querySelector('[role=alert]').hidden &&
    !dialog().querySelector('.manager-question-options button').disabled && !dialog().querySelector('textarea').readOnly`,
    "send failure keeps question open and restores controls");
  await evaluate(`api.answerBoardQuestion = async () => ({ ok: true });
    dialog().querySelector('.manager-question-options button').click(); void 0;`);
  await settle();
  await check(`!dialog()`, "answer can be retried after failure");
  await evaluate(`api.answerBoardQuestion = async (id, answer) => { answers.push({ id, answer }); return { ok: true }; };
    composer.updateQuestion(undefined); composer.updateQuestion({ ...fixture, id: 'approval', approval: true }); void 0;`);
  await check(`dialog().open && dialog().querySelectorAll('pre').length === 5 && !dialog().querySelector('textarea') &&
    !dialog().querySelector('.sheet-actions') && !!dialog().querySelector('.manager-question-options strong')`,
    "shared approval dialog renders option Markdown and retains option-only controls");
  await evaluate(`dialog().querySelector('.manager-question-options button').focus(); void 0;`);
  await key('Space');
  await check(`!dialog() && answers.at(-1).id === 'approval' && answers.at(-1).answer === fixture.options[0]`,
    "keyboard activation sends original Markdown option in approval dialog");
  await evaluate(`window.emptyCaption = '![](https://example.com/empty.png)';
    composer.updateQuestion({ ...fixture, id: 'empty-caption', options: [emptyCaption] }); void 0;`);
  await check(`dialog().querySelector('.manager-question-options button').textContent === emptyCaption &&
    !dialog().querySelector('.manager-question-options img')`, "empty image caption falls back to original text for an accessible answer");
  await evaluate(`dialog().querySelector('.manager-question-options button').click(); void 0;`);
  await settle();
  await check(`!dialog() && answers.at(-1).answer === emptyCaption`, "empty caption fallback sends original text");
  await evaluate(`composer.updateQuestion({ ...fixture, id: 'no-options', options: [] }); void 0;`);
  await check(`!dialog().querySelector('.manager-question-options') && !!dialog().querySelector('textarea')`,
    "question without options keeps free input controls");
  await evaluate(`dialog().querySelector('textarea').value = freeText;
    dialog().querySelector('textarea').dispatchEvent(new Event('input'));
    dialog().querySelector('form').requestSubmit(); void 0;`);
  await settle();
  await check(`!dialog() && answers.at(-1).id === 'no-options' && answers.at(-1).answer === freeText.trim()`,
    "free answer works without options");
  await evaluate(`composer.updateQuestion(undefined); composer.dispose(); void 0;`);
  await settle();
  await check(`!dialog() && !window.questionExecuted`, "clearing question removes its modal; commands never execute");
  assert.deepEqual(imageRequests, [], 'option images never request external resources');
  results.push('option images never request external resources');
  writeFileSync(join(artifacts, 'checks.json'), JSON.stringify({ node: process.env.TASKBOARD_CHECK_NODE,
    electron: process.versions.electron, chromium: process.versions.chrome, checks: results }, null, 2) + '\n');
  console.log(`Manager question Chromium checks passed: ${results.length}`);
} catch (error) {
  console.error(error);
  status = 1;
} finally {
  window?.destroy();
  app.exit(status);
}
});
