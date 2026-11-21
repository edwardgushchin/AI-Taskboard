// Run the real renderer in Windows Electron with a disposable board and delayed task loading.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "task-description", 90_000);
const { app, BrowserWindow } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();

const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
mkdirSync(project);
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
const require = createRequire(import.meta.url);

function cli(args, input) {
  const flags = input === undefined ? [] : ["--stdin"];
  const output = execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src", "cli", "main.ts"),
    "--project", project, "--json", ...args, ...flags,
  ], { encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true });
  return JSON.parse(output);
}

let window;
const checks = [];
const captures = [];
const headings = ["Описание", "Подзадачи", "Критерии приёмки"];
const states = ["Выполнено", "Ожидает"];
const link = "https://example.com/guide?q=full#setup";

app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 1280, height: 800, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const fixturePath = join(scratch, "description.html");
  writeFileSync(fixturePath, html);
  await window.loadFile(fixturePath);
  const font = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
  const icons = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + font);
  await window.webContents.insertCSS(read("themes.css") + icons + read("styles.css"));
  const evaluate = async code => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      console.error("Renderer expression failed:", code.slice(-500));
      throw error;
    }
  };
  const check = async (actual, expected, label) => {
    assert.deepEqual(await evaluate(actual), expected, label);
    checks.push(label);
  };
  const settle = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))";
  const description = [
    "### Проблема",
    "Проверим **сроки проекта** и " + "[план работ](" + link + ").",
    "",
    "### Диагностика и связанные файлы",
    "Скрытые сведения.",
    "",
    "#### Вложенный раздел",
    "Скрытые вложенные сведения.",
    "",
    "### Ограничения",
    "Сроки указаны в рабочих днях.",
    "",
    "### Следующий раздел",
    "Согласование выполняется по [инструкции](" + link + ").",
    "",
    "~~~text",
    "  full value",
    "second line",
    "~~~",
  ].join("\n");
  const subtasks = [
    { title: "Собрать исходные данные", done: true },
    { title: "Проверить [план](docs/plan.md)", done: false },
  ];
  const criteria = ["Изменения согласованы по [справке](docs/help.md)."];
  cli(["init"], { boardType: "manual" });
  const fixture = cli(["create"], { title: "Проверка плана проекта", description, subtasks, criteria }).data;
  const empty = cli(["create"], {
    title: "Карточка без подзадач", description: "Обычный Markdown с **выделением**.", criteria: ["Текст виден."],
  }).data;
  let board = cli(["list", "--compact"]).data;
  assert.deepEqual(board.tasks.find(task => task.id === fixture.id).criteria, criteria);
  checks.push("Компактный список CLI содержит критерии");

  window.webContents.setZoomFactor(1);
  await evaluate([
    "window.taskboard = {",
    "  subscribe() {},",
    "  onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),",
    "  openLink: async href => { window.lastLink = href; },",
    "  async readMarkdown(id, path) {",
    "    window.markdownReads.push([id, path]);",
    "    return { ok: true, data: { name: path.split('/').at(-1), path, text: 'Текст документа.' } };",
    "  },",
    "  command(action, id, input) {",
    "    if (action === 'show') return new Promise(resolve => { window.releaseTask = resolve; });",
    "    if (action === 'update') return new Promise(resolve => { window.pendingEdit = { id, input, resolve }; });",
    "    throw new Error('Unexpected command: ' + action);",
    "  }",
    "};",
    readFileSync(require.resolve("markdown-it/browser"), "utf8"),
    read("image-preview.js"),
    read("source-files.cjs"),
    read("markdown.js"),
    read("chat.js"),
    localizationFixture(),
    read("renderer.js"),
    "window.settle = () => " + settle + ";",
    "window.sectionNames = () => [...body.querySelectorAll(':scope > .sheet-section > h3')].map(el => el.textContent);",
    "window.subtaskStates = () => {",
    "  const section = [...body.querySelectorAll('.sheet-section')].find(el => el.firstChild.textContent === 'Подзадачи');",
    "  return [...section.querySelectorAll('[role=img]')].map(el => el.getAttribute('aria-label'));",
    "};",
    "void 0;",
  ].join("\n"));
  await evaluate([
    "frame = { project: " + JSON.stringify(project) + ", russian: true, runningTasks: [], board: " + JSON.stringify(board) + " };",
    "byId('workspace').hidden = false;",
    "byId('welcome').hidden = true;",
    "byId('lanes').append(...frame.board.tasks.map(task => card(task)));",
    "void 0;",
  ].join("\n"));

  await check(String.raw`(() => {
    const plain = cardDescription("### Проблема\nАбзац с **выделением**, " + String.fromCharCode(96) + "код" + String.fromCharCode(96));
    return plain.textContent === "Абзац с выделением, код" && !plain.childElementCount;
  })()`, true, "Безопасное Markdown-превью на доске");
  await check(
    "cardDescription('<img src=x onerror=alert(1)> [link](javascript:alert(1)) ![alt](https://example.com/x.png)').childElementCount",
    0, "На доске карточка не получает интерактивные узлы из Markdown",
  );
  const open = id => evaluate("void showTask(" + JSON.stringify(id) + "); settle()");
  const release = task => evaluate("releaseTask(" + JSON.stringify({ ok: true, data: task }) + "); settle()");
  const checkContent = async label => {
    await check("sectionNames()", headings, label + " — порядок");
    await check("subtaskStates()", states, label + " — отметки");
    await check(String.raw`(() => {
      const description = body.querySelector('.task-sheet-description .chat-text');
      return !description.querySelector('details') &&
        !/Диагностика и связанные файлы|Скрытые|Вложенный раздел|Ограничения/.test(description.textContent) &&
        description.textContent.includes('Сроки указаны в рабочих днях.') &&
        description.textContent.includes('Следующий раздел');
    })()`, true, label + " — границы Markdown");
  };

  for (const [name, width, height] of [["wide", 1280, 800], ["narrow", 900, 700]]) {
    window.setContentSize(width, height);
    if (name === "wide") {
      await evaluate("[...document.querySelectorAll('.task-card')].find(card => card.textContent.includes(" +
        JSON.stringify(fixture.title) + ")).focus(); void 0");
      window.webContents.focus();
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
      await evaluate("settle()");
      await check("sheet.open", true, "Карточка открывается клавишей пробела");
    } else {
      await open(fixture.id);
    }
    await checkContent(name + " до загрузки");
    await check("Boolean(body.querySelector('[role=status]'))", true, name + " — загрузка ещё идёт");
    await evaluate("window.markdownReads = []; void 0;");
    for (const heading of headings.slice(1)) {
      await evaluate(`[...body.querySelectorAll('.sheet-section')]
        .find(section => section.firstChild.textContent === ${JSON.stringify(heading)})
        .querySelector('a').click(); settle()`);
      await check("document.querySelector('.markdown-preview[open] .chat-text').textContent.trim()", "Текст документа.",
        name + " — предпросмотр ссылки из секции «" + heading + "»");
      await evaluate("document.querySelector('.markdown-preview[open] button').click(); settle()");
    }
    await check("markdownReads", [[fixture.id, "docs/plan.md"], [fixture.id, "docs/help.md"]],
      name + " — обе относительные ссылки используют ID карточки до загрузки");
    await release(fixture);
    await checkContent(name + " после загрузки");
    await check("Boolean(body.querySelector('[role=status]'))", false, name + " — загрузка завершена");
    await evaluate("body.querySelector('.task-sheet-description a:last-of-type').click(); settle()");
    await check("lastLink", link, name + " — полный URL в описании");
    await check("[innerWidth, innerHeight, body.scrollWidth <= body.clientWidth + 1]", [width, height, true],
      name + " — размер CSS и отсутствие горизонтальной прокрутки");
    await check(String.raw`(() => {
      const p = body.querySelector('.task-sheet-description .chat-text p');
      const style = getComputedStyle(p);
      return style.fontSize === '15px' && style.lineHeight === '24px';
    })()`, true, name + " — типографика описания");
    const filename = "task-sections-" + name + ".png";
    const image = await window.webContents.capturePage();
    const png = image.toPNG();
    assert.ok(png.length > 0 && png.length <= 4 * 1024 * 1024);
    const size = image.getSize();
    assert.ok(size.width * size.height <= 16_000_000);
    writeFileSync(join(artifacts, filename), png);
    captures.push({ filename, viewport: width + "×" + height, size: size.width + "×" + size.height, sha: sha256(png) });
    if (name === "wide") await evaluate("byId('close-sheet').click(); settle()");
  }

  await check("body.querySelector('.task-sheet-description pre code').textContent",
    "  full value\nsecond line\n", "Текст блока кода после скрытого раздела");

  const refreshed = cli(["update", fixture.id], {
    revision: fixture.revision, criteria: ["Уточнённый критерий"], subtasks: subtasks.map(item => ({ ...item, done: !item.done })),
  }).data;
  await open(fixture.id);
  await check("sectionNames()", headings, "Секции сохраняют порядок при ожидании обновления");
  await release(refreshed);
  await check("sectionNames()", headings, "Порядок после обновления");
  await check("subtaskStates()", states.toReversed(), "Новые отметки после обновления");
  await check("body.textContent.includes('Уточнённый критерий')", true, "Новый критерий после обновления");
  await evaluate("[...body.querySelectorAll('button')].find(button => button.textContent === 'Редактировать').click(); settle()");
  await check("body.querySelector('textarea[name=description]').value", description, "Исходный Markdown в форме редактирования");
  await evaluate("body.querySelector('input[name=title]').value = 'Уточнённый план'; body.querySelector('form').requestSubmit(); settle()");
  const input = await evaluate("pendingEdit.input");
  assert.equal(input.description, description);
  const saved = cli(["update", fixture.id], input).data;
  const stored = cli(["show", fixture.id, "--compact"]).data;
  assert.equal(stored.description, description);
  assert.deepEqual(stored.subtasks, refreshed.subtasks);
  assert.equal(stored.title, "Уточнённый план");
  checks.push("Публичный CLI сохранил исходный Markdown и обе отметки после отправки формы");
  await evaluate("pendingEdit.resolve(" + JSON.stringify({ ok: true, data: saved }) + "); settle()");
  await release(stored);
  await check("sectionNames()", headings, "Порядок после сохранения через форму");

  board = cli(["list", "--compact"]).data;
  await evaluate("frame.board = " + JSON.stringify(board) + "; byId('close-sheet').click(); settle()");
  await open(empty.id);
  await check("sectionNames()", ["Описание", "Критерии приёмки"], "Пустые подзадачи до загрузки");
  await release(empty);
  await check("sectionNames()", ["Описание", "Критерии приёмки"], "Пустые подзадачи после загрузки");
  await check("body.querySelector('.task-sheet-description strong').textContent", "выделением", "Обычный Markdown");

  const examples = [
    ["### Диагностика и связанные файлы\nСкрыто\n\n### Конец\nВидно", false],
    ["### Диагностика и связанные файлы\nСкрыто\n\n## Конец\nВидно", false],
    ["Диагностика и связанные файлы\n---\nСкрыто\n\n# Конец\nВидно", false],
    ["~~~\n### Диагностика и связанные файлы\nВидно\n~~~", true],
    ["> ### Диагностика и связанные файлы\n> Видно", true],
    ["Диагностика и связанные файлы без заголовка\n\nВидно", true],
  ];
  for (const [text, plain] of examples) {
    await evaluate("body.replaceChildren(); taskDescription(" + JSON.stringify(text) + ", " + JSON.stringify(fixture.id) + "); void 0");
    await check("body.textContent.includes('Видно') && !body.textContent.includes('Скрыто') && !body.querySelector('details')", true,
      (plain ? "Обычное упоминание" : "Граница старого раздела") + " — " + text.split("\n")[0]);
  }
  await check(String.raw`(() => {
    const report = chatText('Введение.\n\n### Технические детали\n\nТекст.', {agent:true});
    const details = report.querySelector('.chat-report-details');
    return details?.open === false && details.textContent.includes('Текст.');
  })()`, true, "Технические детали чата по-прежнему свёрнуты");
  await check("Boolean(document.querySelector('.task-card'))", true, "На доске остаются карточки");

  const guide = readFileSync(join(root, "docs/reference/board.md"), "utf8");
  assert.match(guide, /за описанием идут подзадачи, затем критерии приёмки/);
  assert.match(guide, /Его текст остаётся в исходном Markdown и доступен при редактировании/);
  assert.doesNotMatch(read("agent-instructions/task-writing.md") + read("board-actions.ts"), /### Диагностика и связанные файлы/);
  checks.push("Справка описывает проверенное поведение, подсказки не предлагают скрытый раздел");

  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  const relevant = [
    "scripts/check-task-description.mjs", "src/desktop/renderer.js", "src/desktop/markdown.js", "src/desktop/styles.css",
    "src/cli/main.ts", "src/desktop/agent-instructions/task-writing.md", "src/desktop/board-actions.ts", "docs/reference/board.md",
  ];
  const sources = [...new Set([...changed, ...relevant])].sort();
  const report = [
    "# Проверка порядка секций карточки",
    "",
    "Пройдено проверок — " + checks.length + ". Electron " + process.versions.electron +
      ", Chromium " + process.versions.chrome + ", Node.js " + process.versions.node + ", " + process.platform + " " + process.arch + ".",
    "",
    "Масштаб 100%. Реальные HTML, CSS, Markdown и рендерер открыты в BrowserWindow с sandbox и contextIsolation. " +
      "Команды выполнялись на временной доске через штатный CLI. Подмена IPC задерживала ответ show до проверки предварительного состояния.",
    "",
    "## Наблюдения",
    "",
    ...checks.map(label => "- " + label + "."),
    "",
    "## Воспроизведение",
    "",
    "Из корня репозитория с установленными по lock-файлу зависимостями выполните:",
    "",
    "~~~powershell",
    "node scripts/check-task-description.mjs --artifacts .tasks/qa",
    "~~~",
    "",
    "## Снимки",
    "",
    ...captures.map(entry => "- [" + entry.filename + "](" + entry.filename + "), " + entry.viewport + " CSS px, PNG " + entry.size +
      " px, SHA-256 " + entry.sha + "."),
    "",
    "## Проверенный снимок исходников",
    "",
    "Git HEAD " + base + ". SHA-256 от фактических байтов файлов в рабочей копии.",
    "",
    "~~~text",
    ...sources.map(path => sha256(readFileSync(join(root, path))) + "  " + path),
    "~~~",
    "",
  ].join("\n");
  writeFileSync(join(artifacts, "task-sections-check.md"), report);
  console.log(JSON.stringify({ result: "passed", checks: checks.length, electron: process.versions.electron, captures }));
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
