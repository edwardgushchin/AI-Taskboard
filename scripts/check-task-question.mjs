import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

// Keep Electron, replyToTask, IPC, the CLI, storage and renderer real; replace only the provider transport.
const { scratch, artifacts } = electronCheck(import.meta.url, "task-question", 180_000,
  [["--first-pass"], ["--restart"]]);
const restart = process.argv.includes("--restart");
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const other = join(scratch, "other");
const profile = join(scratch, "profile");
const report = join(artifacts, "cancelled-task-question-check.md");
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const settings = { model: "fixture-sol", effort: "high" };
const log = text => {
  console.log(text);
  appendFileSync(report, text + "\n");
};

function cli(args, input, root = project) {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning", cliPath,
    "--project", root, "--json", ...args, ...(input === undefined ? [] : ["--stdin"])], {
    cwd: scratch, windowsHide: true, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const reply = JSON.parse(result.stdout);
  assert.ok(reply.ok, JSON.stringify(reply));
  return reply.data;
}

async function until(probe, label) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await probe()) {
      return;
    }
    await delay(100);
  }
  throw Error("Timed out: " + label);
}

let failReply = false;
let holdReply;
globalThis.questionFixtureReply = async (_profile, _project, _settings, prompt, _images, _commentary,
  _action, _directory, _limit, _usage, onControl, _signal, _id, _activity, mode) => {
  const context = JSON.parse(prompt);
  onControl({ steer: async () => assert.fail("Unexpected steering"), interrupt: async () => {} });
  if (mode === "initial") {
    return { text: JSON.stringify({ questions: context.task.title === "Уточнить формат отчёта"
      ? "Какой формат отчёта нужен и куда сохранить результат?" : "" }) };
  }
  if (failReply) {
    failReply = false;
    throw Error("Fixture provider unavailable");
  }
  if (holdReply) {
    await new Promise(resolve => { holdReply = resolve; });
  }
  const partial = context.latestUserMessage.text === "Формат CSV";
  return { text: JSON.stringify({
    text: partial ? "Формат CSV принят. Куда сохранить результат?" : "Уточнение получено. Вопросов больше нет.",
    awaitingAnswer: partial,
    ...(context.task.status === "draft" ? { confirmsDraft: !partial } : {}),
  }) };
};

app.setPath("userData", profile);
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
process.env.GIT_CEILING_DIRECTORIES = scratch;
const staging = join(scratch, "staging");
process.env.TEMP = process.env.TMP = process.env.TMPDIR = staging;
let selection = project;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });

void (async () => {
  try {
    if (!restart) {
      for (const path of [project, other, profile, staging]) {
        mkdirSync(path);
      }
      writeFileSync(report, "# Task question indicator\n\nCommand: node scripts/check-task-question.mjs --artifacts .tasks/qa/task-question\n\n");
      log("Source SHA-256: raw working-file bytes; compare these with the submitted snapshot (including checkout line endings).");
      const paths = ["src/cli/model.ts", "src/cli/archive.ts", "src/cli/main.ts", "src/cli/storage.ts",
        "src/desktop/main.ts", "src/desktop/codex-chat.ts", "src/desktop/renderer.js", "src/desktop/chat.js",
        "src/desktop/styles.css", "src/desktop/vendor/codicons/codicon.css", "src/desktop/locales/ru.json", "scripts/check-task-question.mjs"];
      for (const path of paths) {
        log(createHash("sha256").update(readFileSync(new URL("../" + path, import.meta.url))).digest("hex") + "  " + path);
      }
      writeFileSync(join(profile, "appearance.json"), JSON.stringify({ theme: "dark", language: "ru" }));
      cli(["init"], { git: false });
      cli(["init"], { git: false }, other);
      cli(["settings"], { executor: { provider: "codex", ...settings }, autoMode: false });
      symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
        process.platform === "win32" ? "junction" : "dir");
      cli(["create"], plannedDraft({ title: "Уточнить формат отчёта", execution: settings,
        tags: ["отчёт"], priority: "high", dueDate: "2026-12-01", subtasks: [{ title: "Подготовить отчёт", done: false }] }));
      cli(["create"], plannedDraft({ title: "Соседняя карточка без вопроса", execution: settings }));
      const old = cli(["create"], plannedDraft({ title: "Вопрос из старого диалога", execution: settings }));
      const user = cli(["chat", old.id], { ...settings, text: "Обсудим" });
      cli(["chat", old.id], { ...settings, actor: "agent", replyTo: user.history.length - 1, text: "Какой формат?" });
    }
    log(`${restart ? "restart" : "first-pass"}: ${process.platform} ${process.arch}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}; content 1280x800; Chromium sandbox enabled.`);
    log("Provider transport is deterministic. Live model interpretation is not tested by this check.");
    const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
    const readSource = url => readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
    const compile = source => transformSync(source, { loader: "ts", format: "esm" }).code;
    const chatUrl = new URL("./codex-chat.ts", sourceUrl);
    const call = "reply(profile, project, prompt, images, runAction, { ...options, worklog, mcp: { config, env } })";
    const chat = readSource(chatUrl);
    assert.equal(chat.split(call).length, 2);
    const chatEntry = join(scratch, "codex-chat-under-test.mjs");
    writeFileSync(chatEntry, compile(chat.replace(call,
      "globalThis.questionFixtureReply(profile, project, settings, prompt, images, options.onCommentary, runAction, options.imageDirectory, imageLimit, onTokenUsage, onControl, signal, taskId, options.onActivity, mode)")));
    const entry = join(scratch, "main-under-test.mjs");
    writeFileSync(entry, compile(readSource(sourceUrl).replace(chatUrl.href, pathToFileURL(chatEntry).href)));
    process.on("unhandledRejection", error => {
      console.error(error);
      app.exit(1);
    });
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    require(entry);
    await until(() => BrowserWindow.getAllWindows().length, "window");
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1280, 800);
    window.webContents.setZoomFactor(1);
    const evaluate = code => window.webContents.executeJavaScript(code);
    await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
    const open = async path => {
      selection = path;
      await evaluate("window.taskboard.menuAction('open-project')");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.loading && f.board?.project === ${JSON.stringify(path)})`), "open board");
    };
    if (!await evaluate(`window.taskboard.bootstrap().then(f => f.board?.project === ${JSON.stringify(project)})`)) {
      await open(project);
    }
    const show = () => cli(["show", "T-0001"]);
    const card = "[...document.querySelectorAll('.task-card')].find(c => c.querySelector('.task-id')?.textContent === 'T-0001')";
    const badge = state => until(() => evaluate(`Boolean(${card}?.querySelector('.task-question')) === ${state}`), "badge " + state);
    const close = () => evaluate("document.querySelector('#close-sheet').click()");
    const send = async text => {
      await evaluate(`(() => {
        const input = document.querySelector('#task-chat-input');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form.requestSubmit();
      })()`);
      await until(() => evaluate("window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes('T-0001'))"), "reply completes");
    };
    const keyboard = async keyCode => {
      window.focus();
      await delay(100);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode });
      window.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : " " });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode });
      try {
        await until(() => evaluate("!document.querySelector('.task-dialogue')?.hidden && document.activeElement.classList.contains('task-dialogue')"), "keyboard opens dialogue");
      } catch (error) {
        log("Keyboard diagnostic: " + JSON.stringify(await evaluate("({ focused: document.activeElement.outerHTML.slice(0, 500), sheet: document.querySelector('#sheet')?.open, task: taskInSheet?.id, dialogue: document.querySelector('.task-dialogue')?.hidden })")));
        throw error;
      }
    };
    const capture = async name => {
      await evaluate("Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))");
      await evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
      const image = await window.webContents.capturePage();
      assert.deepEqual(window.getContentSize(), [1280, 800]);
      assert.deepEqual(await evaluate("[innerWidth, innerHeight]"), [1280, 800]);
      assert.ok(!image.isEmpty());
      writeFileSync(join(artifacts, name), image.toPNG());
    };
    const assertCancelled = async () => {
      await until(() => evaluate(`${card}?.dataset.state === 'cancelled'`), "cancelled card in board");
      assert.equal(await evaluate(`Boolean(${card}.querySelector('.task-question'))`), false);
      const metadata = await evaluate(`({
        text: ${card}.textContent,
        description: ${card}.getAttribute('aria-description')
      })`);
      assert.doesNotMatch(metadata.text, /Нужен ответ/);
      assert.doesNotMatch(metadata.description, /Нужен ответ|Открыть диалог/);
      assert.match(metadata.description, /0\/1/);
      assert.equal(show().awaitingAnswer, true);
      assert.match(show().history.find(event => event.text?.includes("Какой формат"))?.text, /Какой формат/);
    };
    if (restart) {
      await assertCancelled();
      cli(["return-to-draft", "T-0001"], { revision: show().revision });
      await until(() => evaluate(`${card}?.dataset.state === 'draft'`), "returned draft in board");
      log("PASS a fresh Electron process hides the badge on the saved cancelled card; its question history survives return to draft.");
    }
    await until(() => show().awaitingAnswer === true, "saved first question");
    await badge(true);
    assert.equal(cli(["list", "--compact"]).tasks.find(task => task.id === "T-0001").awaitingAnswer, true);
    assert.equal(await evaluate("[...document.querySelectorAll('.task-question')].length"), 1);
    log("PASS first question is persisted, exposed by compact board snapshot and appears without restarting; neighbor and old unmarked history have no badges.");
    await evaluate(`${card}.focus()`);
    await keyboard("Enter");
    assert.match(await evaluate("document.querySelector('.task-dialogue').textContent"), /Какой формат/);
    await evaluate("document.querySelector('[aria-controls=task-chat-work]').click()");
    await close();
    await evaluate(`${card}.focus()`);
    await keyboard("Space");
    assert.equal(show().awaitingAnswer, true);
    await close();
    await badge(true);
    log("PASS Enter and Space open this card's Dialogue, replacing a remembered Work Activity view; reading and closing keep the badge.");
    if (!restart) {
      await evaluate("window.taskboard.setTheme('dark')");
      const layout = await evaluate(`(() => {
        const c = ${card};
        const q = c.querySelector('.task-question');
        const bounds = c.getBoundingClientRect();
        const b = q.getBoundingClientRect();
        return { cardWidth: bounds.width, badge: q.textContent, inside: b.left >= bounds.left && b.right <= bounds.right,
          overflow: c.scrollWidth > c.clientWidth, metadata: c.querySelector('.task-meta').textContent,
          color: getComputedStyle(q).color, background: getComputedStyle(q).backgroundColor,
          icon: q.querySelector('.codicon').className,
          glyph: getComputedStyle(q.querySelector('.codicon'), '::before').content }; })()`);
      assert.ok(layout.cardWidth < 260 && layout.inside && !layout.overflow, JSON.stringify(layout));
      assert.match(layout.metadata, /T-0001.*Нужен ответ.*2026-12-01/);
      assert.match(layout.icon, /codicon-question/);
      assert.equal(layout.glyph, '"\ueb32"');
      log("PASS dark narrow column retains question, ID, due date and subtask progress: " + JSON.stringify(layout));
      await capture("draft-task-question.png");
      // A real pointer click on the visible label uses the enclosing native card button.
      const point = await evaluate(`(() => {
        const r = ${card}.querySelector('.task-question').getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      await until(() => evaluate("document.querySelector('.task-dialogue') && !document.querySelector('.task-dialogue').hidden"), "pointer opens dialogue");
      await close();
      await open(other);
      await open(project);
      await badge(true);
      log("PASS pointer activates the badge; reopening the board preserves the question.");
      await evaluate(`${card}.click()`);
      await until(() => evaluate("Boolean(document.querySelector('[aria-controls=task-chat-work]'))"), "card chat tabs");
      await evaluate("document.querySelector('[aria-controls=task-chat-work]').click()");
      await close();
      cli(["cancel", "T-0001"], { reason: "Проверка отмены черновика", revision: show().revision });
      await assertCancelled();
      await evaluate(`${card}.scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
      await capture("cancelled-task-question.png");
      await evaluate(`${card}.click()`);
      await until(() => evaluate("Boolean(document.querySelector('[aria-controls=task-chat-work]'))"), "cancelled card chat tabs");
      await until(() => evaluate("document.querySelector('[aria-controls=task-chat-work]')?.getAttribute('aria-pressed') === 'true'"), "cancelled card preserves Work Activity");
      await close();
      await open(other);
      await open(project);
      await assertCancelled();
      log("PASS cancellation removes the badge and its accessible prompt immediately. Opening the cancelled card preserves Work Activity. Reopening the board keeps the badge hidden.");
    } else {
      log("PASS the returned draft restores its unresolved question, badge and Dialogue navigation; neighboring cards stay unmarked.");
      await evaluate("window.taskboard.setTheme('light')");
      await until(() => evaluate("getComputedStyle(document.body).backgroundColor === 'rgb(238, 241, 247)'"), "light board background");
      const light = await evaluate(`(() => {
        const c = ${card};
        const q = c.querySelector('.task-question');
        const bounds = c.getBoundingClientRect();
        const b = q.getBoundingClientRect();
        return {
          text: q.textContent,
          inside: b.left >= bounds.left && b.right <= bounds.right,
          color: getComputedStyle(q).color,
          background: getComputedStyle(q).backgroundColor,
        };
      })()`);
      assert.ok(light.inside);
      assert.equal(light.text, "Нужен ответ");
      log("PASS the open-question badge remains legible in the light narrow column: " + JSON.stringify(light));
      await capture("task-question-light.png");
      await evaluate(`showTask('T-0001', true)`);
      failReply = true;
      await send("Проверка сбоя");
      assert.equal(show().awaitingAnswer, true);
      log("PASS provider failure keeps the saved question open.");
      await send("Формат CSV");
      assert.equal(show().awaitingAnswer, true);
      assert.match(show().history.at(-1).text, /Куда сохранить/);
      await close();
      await badge(true);
      log("PASS a partial answer followed by another clarification keeps the badge.");
      await evaluate(`showTask('T-0001', true)`);
      holdReply = true;
      const sending = send("Сохранить в reports");
      await until(() => typeof holdReply === "function", "provider awaiting release");
      assert.equal(show().awaitingAnswer, true);
      holdReply();
      await sending;
      await until(() => show().awaitingAnswer === false, "last question resolved");
      await close();
      await badge(false);
      await evaluate("window.taskboard.setTheme('light')");
      await capture("task-question-resolved.png");
      log("PASS sending alone preserves the badge; the agent's sufficient-answer acknowledgement removes it immediately in the light theme.");
      for (const [text, awaitingAnswer] of [["Обычное сообщение", false], ["Всё готово", false], ["Символ ? сам по себе", false],
        ["Какой раздел включить?", true], ["Последний вопрос больше не нужен.", false]]) {
        const user = cli(["chat", "T-0002"], { ...settings, text: "Обсудим" });
        cli(["chat", "T-0002"], {
          ...settings, actor: "agent", text, awaitingAnswer, replyTo: user.history.length - 1, revision: user.revision,
        });
        await until(() => evaluate(`Boolean([...document.querySelectorAll('.task-card')].find(c => c.querySelector('.task-id')?.textContent === 'T-0002')?.querySelector('.task-question')) === ${awaitingAnswer}`), text);
      }
      log("PASS ordinary text, readiness and punctuation do not mark a card; a new explicit question and its withdrawal update only that card.");
      log("Platform matrix: Windows x64 — runtime verified; Linux and macOS — not run. State uses existing platform-neutral CLI storage and native HTML button activation; no path, process-launch or packaging behavior changed.");
    }
  } catch (error) {
    console.error(error);
    log("FAIL " + (error.stack ?? error));
    process.exitCode = 1;
  } finally {
    for (const window of BrowserWindow.getAllWindows()) {
      window.destroy();
    }
    app.exit(process.exitCode ?? 0);
  }
})();
