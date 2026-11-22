// Real Electron, CLI, IPC and renderer; only the provider response is deterministic.
// node scripts/check-task-chat-bubbles.mjs --artifacts .tasks/qa/T-0255
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "task-bubbles", 120000, [["--first"], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, nativeTheme } = require("electron");
const restart = process.argv.includes("--restart");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const staging = join(scratch, "staging");
if (!restart) mkdirSync(staging);
process.env.TMPDIR = process.env.TEMP = process.env.TMP = staging;
const reportPath = join(artifacts, "card-reply-activity-check.txt");
const statePath = join(scratch, "saved.json");
const settings = { model: "fixture", effort: "low" };
const question = "Если карточку отменили через CLI при закрытом Electron и без запущенного watch, должна ли рабочая копия удалиться автоматически после завершения сеанса или достаточно убрать её при следующем открытии доски или запуске watch?";
const answer = "должна удаляться";
const reply = "Рабочая копия должна удалиться автоматически после отмены карточки. Уточнение записано.";
const report = restart ? JSON.parse(readFileSync(statePath, "utf8")).report : {
  command: "node scripts/check-task-chat-bubbles.mjs --artifacts .tasks/qa/T-0255",
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  representation: "SHA-256 of UTF-8 source with CRLF normalized to LF (Git text representation)",
  sources: Object.fromEntries([
    "src/desktop/chat.js", "src/desktop/styles.css", "src/desktop/codex-chat.ts", "src/desktop/main.ts",
    "src/desktop/renderer.js", "src/desktop/preload.cjs", "src/desktop/run-activity.ts", "src/desktop/reviewer-chat.ts",
    "src/desktop/codex-run.ts",
    "src/cli/archive.ts", "scripts/check-task-chat-bubbles.mjs", "scripts/electron-check.mjs",
    "tests/task-question.test.ts", "docs/explanation/architecture.md",
  ].map(path => [path, createHash("sha256").update(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")).digest("hex")])),
  environment: { platform: process.platform, node: process.versions.node, electron: process.versions.electron, chromium: process.versions.chrome },
  matrix: { Windows: "Electron runtime checked", Linux: "Not run; shared renderer, no process/path/packaging changes", macOS: "Not run; shared renderer, no process/path/packaging changes" },
  fixture: "The T-0252 question and owner answer are reproduced on an in-progress card with an active executor. The fixture replaces the provider launch and drives the real launchTask, chatSend, active control, CLI and renderer.",
  checks: [],
};
const check = label => {
  report.checks.push(label);
  console.log("PASS " + label);
};
const cli = (args, input) => {
  const inputPath = join(scratch, "input.json");
  if (input !== undefined) writeFileSync(inputPath, JSON.stringify(input));
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning",
    join(root, "src/cli/main.ts"), "--project", project, "--json", ...args,
    ...(input === undefined ? [] : ["--input-file", inputPath])],
  { cwd: scratch, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
};
const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error("Timed out: " + label);
    await delay(60);
  }
};
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
process.env.GIT_CEILING_DIRECTORIES = scratch;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });

let provider;
let executor;
globalThis.taskBubbleProvider = async (options, mode) => {
  options.onControl({ interrupt: async () => provider?.finish.resolve({ interrupted: true }), steer: async () => {} });
  if (mode === "initial") return { text: JSON.stringify({ questions: question }) };
  const finish = Promise.withResolvers();
  provider = { publish: options.onActivity, finish, at: new Date().toISOString() };
  return finish.promise;
};
globalThis.taskBubbleExecutor = async (_client, _project, _cwd, task, onActivity, _onUsage, signal, beforeTurn,
  _profile, _recoveringThread, _strict, onUserMessage) => {
  const threadId = task.codexThreadId ?? "00000000-0000-4000-8000-000000000252";
  await beforeTurn(threadId, !task.codexThreadId);
  const finish = Promise.withResolvers();
  const interrupt = () => finish.resolve({ interrupted: true, reason: "Fixture interrupted" });
  signal.addEventListener("abort", interrupt, { once: true });
  const run = { publish: onActivity, acknowledge: onUserMessage, finish, messages: [], steeringGate: undefined };
  executor = run;
  return {
    threadId,
    completion: finish.promise.finally(() => signal.removeEventListener("abort", interrupt)),
    interrupt,
    async steer(prompt, _images, messageId) {
      run.messages.push({ messageId, text: JSON.parse(prompt).latestUserMessage.text });
      await run.steeringGate?.promise;
    },
  };
};

void (async () => {
  try {
    let activeCard;
    if (!restart) {
      mkdirSync(project);
      cli(["init"], { git: false });
      cli(["settings"], { executor: { provider: "codex", ...settings }, autoMode: false });
      const draft = cli(["create"], plannedDraft({
        title: "Удалять рабочую копию после отмены задачи",
        description: "Проверить уточнение о моменте удаления рабочей копии.",
        criteria: ["После отмены карточки рабочая копия удаляется автоматически."],
        execution: settings,
      }));
      confirmFixtureDraft(project, draft.id);
      activeCard = cli(["approve", draft.id], { revision: draft.revision });
      symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
        process.platform === "win32" ? "junction" : "dir");
    }
    const readSource = url => readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
    const compile = source => require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code;
    const mainUrl = new URL("../src/desktop/main.ts", import.meta.url);
    const chatUrl = new URL("./codex-chat.ts", mainUrl);
    const providerCall = "reply(profile, project, prompt, images, runAction, { ...options, worklog, mcp: { config, env } })";
    const chatSource = readSource(chatUrl);
    assert.equal(chatSource.split(providerCall).length, 2);
    const chatEntry = join(scratch, "chat-under-test.mjs");
    writeFileSync(chatEntry, compile(chatSource.replace(providerCall, "globalThis.taskBubbleProvider(options, mode)")));
    const entry = join(scratch, "main-under-test.mjs");
    const mainSource = readSource(mainUrl)
      .replace(chatUrl.href, pathToFileURL(chatEntry).href)
      .replace("missingCodexThread, startCodexRun", "missingCodexThread")
      .replace("codexStatus, configuredCodex,", "codexStatus,");
    writeFileSync(entry, compile(`
      const configuredCodex = async () => ({});
      const startCodexRun = globalThis.taskBubbleExecutor;
      ${mainSource}
    `));
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    require(entry);
    await until(() => BrowserWindow.getAllWindows().length, "window");
    const window = BrowserWindow.getAllWindows()[0];
    const evaluate = code => window.webContents.executeJavaScript(code);
    await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
    const preferences = window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    await evaluate("window.taskboard.setLanguage('ru')");
    await until(() => evaluate("localization.locale === 'ru'"), "Russian localization");
    await evaluate("window.taskboard.menuAction('open-project')");
    await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.loading && f.board?.project === ${JSON.stringify(project)})`), "board");
    const saved = restart ? JSON.parse(readFileSync(statePath, "utf8")) : {};
    let card = restart ? cli(["show", saved.id]) : cli(["create"], plannedDraft({
      title: "Диалог карточки: пузыри и время", description: "Уточнить отображение истории.", execution: settings,
    }));
    const show = () => cli(["show", card.id]);
    const messages = () => show().history.filter(event => event.chat);
    await until(() => messages().length === (restart ? 3 : 1), "first question");
    const display = () => evaluate(`showTask(${JSON.stringify(card.id)})`);
    const reopen = async () => {
      await evaluate("document.querySelector('#close-sheet').click()");
      await display();
    };
    const send = text => evaluate(`{
      const input = document.querySelector('#task-chat-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    }`);
    const paint = () => evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
    const capture = async (file, selector) => {
      await paint();
      assert.deepEqual(window.getContentSize(), [1280, 900]);
      assert.equal(await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        const viewport = document.querySelector('.task-dialogue').getBoundingClientRect();
        const box = node?.getBoundingClientRect();
        return Boolean(box?.height && box.top >= viewport.top && box.bottom <= viewport.bottom);
      })()`), true, file + " target must be fully visible");
      writeFileSync(join(artifacts, file), (await window.webContents.capturePage()).toPNG());
    };
    await display();
    const snapshot = () => evaluate(`Array.from(document.querySelectorAll('.task-dialogue .chat-entry'), row => ({
      actor: row.dataset.actor,
      text: row.querySelector('.chat-text')?.textContent.trim(),
      at: row.querySelector('time')?.dateTime,
      time: row.querySelector('time')?.textContent,
      side: getComputedStyle(row).alignSelf,
      radius: getComputedStyle(row).borderRadius,
    }))`);
    if (!restart) {
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(card.id)}))`), "initial writer released");
      nativeTheme.themeSource = "dark";
      window.setContentSize(1280, 900);
      await evaluate("applyTheme('dark'); void 0");
      await send(answer);
      await until(() => provider, "provider");
      await until(async () => (await snapshot()).length === 2 &&
        await evaluate("Boolean(document.querySelector('.task-dialogue .chat-thinking[role=status]'))"), "saved user message and waiting indicator");
      assert.equal(await evaluate("document.querySelector('.chat-thinking').textContent"), "Думаю…");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-thinking')).borderRadius"), "0px");
      assert.deepEqual((await snapshot()).map(row => row.text), [question, answer]);
      check("A separate discussion shows Думаю… after the saved answer and before any provider activity");

      const firstTool = {
        id: "reply-update", type: "dynamicToolCall", title: "task_update", status: "inProgress",
        text: JSON.stringify({ arguments: { criterion: "Рабочая копия должна удаляться" } }, null, 2),
        at: provider.at,
      };
      provider.publish([firstTool]);
      const action = ".chat-turn details[data-item='item:reply-update']";
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(action)}))`), "live tool call");
      await evaluate(`document.querySelector(${JSON.stringify(action + " summary")}).click()`);
      assert.equal(await evaluate(`(() => {
        const row = document.querySelector(${JSON.stringify(action)});
        return row.open && row.textContent.includes('task_update') && row.textContent.includes('Рабочая копия должна удаляться');
      })()`), true);
      assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking, .chat-turn .chat-entry'))"), false);
      check("A separate discussion expands task_update and shows its arguments before any final reply");

      const activity = [
        { ...firstTool, status: "completed" },
        { id: "reply-check", type: "mcpToolCall", title: "ai_taskboard / task_show", text: "Проверено", status: "completed", at: provider.at },
      ];
      await evaluate(`updateChat({
        project: frame.project, id: ${JSON.stringify(card.id)}, type: 'run',
        items: [{ id: 'foreign', type: 'mcpToolCall', title: 'Foreign executor event', text: '', status: 'completed' }]
      })`);
      const encoded = JSON.stringify({ text: reply, awaitingAnswer: false, confirmsDraft: false });
      const publish = text => {
        provider.publish([...activity, {
          id: "reply", type: "agentMessage", phase: "final_answer", text, at: provider.at, status: "inProgress",
        }]);
      };
      for (const length of [35, 60, encoded.length]) {
        publish(encoded.slice(0, length));
        await until(async () => (await snapshot()).length === 3, "stream bubble");
        const rows = await snapshot();
        assert.equal(rows[2].actor, "agent");
        assert.equal(rows[2].radius, "14px 14px 14px 5px");
        assert.equal(rows[2].at, provider.at);
        assert.ok(reply.startsWith(rows[2].text.trim()), JSON.stringify(rows[2]));
        assert.ok(rows[2].text.length > 0);
        assert.doesNotMatch(rows[2].text, /awaitingAnswer|\{"text"/);
      }
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.chat-turn [data-item^="item:"], .chat-turn .chat-entry'),
        node => node.dataset.item)`), ["item:reply-update", "item:reply-check", "message:reply"]);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(action)}).open`), true);
      check("Live tool calls retain their order and expansion. The executor event stays out of the reply");

      const { withReviewerChat } = require("../src/desktop/reviewer-chat.ts");
      const reviewDone = Promise.withResolvers();
      const review = withReviewerChat(project, card.id, () => {
        window.webContents.send("chat:update", { project, id: card.id, type: "reviewer-chat" });
      }, async publish => {
        publish([{ id: "reviewer-foreign", type: "mcpToolCall", title: "Reviewer-only tool", text: "Fixture result", status: "inProgress" }]);
        await reviewDone.promise;
      });
      try {
        await evaluate(`{
          const reviewCard = { ...taskInSheet, status: 'review' };
          const area = taskChat(reviewCard);
          byId('task-side').replaceChildren(area);
          area.querySelector('[aria-controls="task-chat-work"]').click();
        }`);
        await delay(200);
        assert.equal(await evaluate("Boolean(document.querySelector('.task-work [data-item=\"item:reviewer-foreign\"]'))"), false);
        await evaluate("byId('task-side').firstElementChild.openDialogue()");
        assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn [data-item=\"item:reviewer-foreign\"]'))"), false);
        assert.equal((await snapshot()).length, 3);
        check("The reviewer tool stays out of both tabs of the task dialogue");
      } finally {
        reviewDone.resolve();
        await review;
      }
      await reopen();
      await until(async () => (await snapshot()).length === 3, "stream after reopening");
      assert.equal((await snapshot())[2].at, provider.at);
      check("Incremental provider JSON renders text inside one agent bubble and survives reopening during the stream");
      provider.finish.resolve({ text: encoded, run: activity });
      await until(() => messages().length === 3, "saved reply");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(card.id)}))`), "writer released");
      assert.equal(messages()[2].at, provider.at);
      await reopen();
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      await evaluate("byId('task-side').querySelector('[aria-controls=task-chat-work]').click()");
      assert.equal(await evaluate(`document.querySelectorAll('.task-work details[data-item^="item:reply-"]').length`), 0);
      assert.deepEqual(messages()[2].run, activity);
      await evaluate("byId('task-side').firstElementChild.openDialogue()");
      check("Completion leaves one reply in Диалог, with its separate provider activity retained in history and excluded from Ход работы");
    }
    card = show();
    assert.equal(card.status, "draft");
    assert.deepEqual(messages().map(event => event.text), [question, answer, reply]);
    await reopen();
    if (restart) assert.deepEqual(messages(), saved.messages);
    const expectedTimes = messages().map(event => event.at);
    assert.deepEqual((await snapshot()).map(row => row.at), expectedTimes);
    assert.deepEqual((await snapshot()).map(row => row.side), ["flex-start", "flex-end", "flex-start"]);
    check(restart ? "New Electron process restores the exact message order, text, source times and bubble positions" :
      "First automatic question, user answer and next agent reply keep their source times after completion and reopening");
    await evaluate(`{
      updateChat({ project: frame.project, id: ${JSON.stringify(card.id)}, type: 'discussion',
        items: [{ id: 'saved-reply', type: 'agentMessage', phase: 'final_answer',
          text: ${JSON.stringify(reply)}, at: ${JSON.stringify(expectedTimes[2])}, status: 'completed' }] });
    }`);
    assert.equal((await snapshot()).length, 3);
    await evaluate(`updateChat({ project: frame.project, id: ${JSON.stringify(card.id)}, type: 'discussion' })`);
    check("A saved reply and its late live snapshot never produce duplicate bubbles");

    for (const [theme, width, height] of [
      ["dark", 1280, 800],
      ["light", 1280, 800],
      ["dark", 1024, 900],
      ["light", 1024, 900],
    ]) {
      nativeTheme.themeSource = theme;
      window.setContentSize(width, height);
      await evaluate(`applyTheme(${JSON.stringify(theme)}); document.querySelector('.task-dialogue').scrollTop = 0; void 0`);
      await paint();
      const layout = await evaluate(`(() => {
        const log = document.querySelector('.task-dialogue');
        const rows = [...log.querySelectorAll('.chat-entry')];
        return {
          fits: log.scrollWidth <= log.clientWidth + 1,
          entries: rows.map(row => {
            const box = row.getBoundingClientRect();
            const time = row.querySelector('time');
            const stamp = time.getBoundingClientRect();
            const style = getComputedStyle(row);
            const date = new Intl.DateTimeFormat(localization.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(time.dateTime));
            return { actor: row.dataset.actor, radius: style.borderRadius, background: style.backgroundColor, color: style.color,
              timeColor: getComputedStyle(time).color, correctTime: time.textContent === date && /^\\d{2}:\\d{2}$/.test(date),
              accessible: time.title === time.getAttribute('aria-label'),
              inside: stamp.top >= box.top && stamp.bottom <= box.bottom && stamp.left >= box.left && stamp.right <= box.right,
              visible: box.top >= log.getBoundingClientRect().top && box.bottom <= log.getBoundingClientRect().bottom,
              lines: row.querySelector('.chat-text').clientHeight / parseFloat(getComputedStyle(row.querySelector('.chat-text')).lineHeight) };
          }),
          dividers: [...log.querySelectorAll('.chat-day')].map(row => ({
            side: getComputedStyle(row).alignSelf,
            rule: getComputedStyle(row, '::before').borderBlockStartWidth,
          })),
        };
      })()`);
      assert.equal(layout.fits, true);
      assert.equal(layout.entries.length, 3);
      for (const row of layout.entries) {
        assert.equal(row.radius, row.actor === "user" ? "16px" : "14px 14px 14px 5px");
        assert.ok(row.correctTime && row.accessible && row.inside && row.visible, JSON.stringify(layout));
      }
      assert.ok(layout.entries[0].lines >= 2);
      assert.ok(layout.dividers.length > 0 && layout.dividers.every(row => row.side === "stretch" && row.rule === "1px"));
      const luminance = color => {
        const values = color.match(/[\d.]+/g).map(Number);
        const components = color.startsWith("color(") ? values : values.map(value => value / 255);
        const linear = components.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      for (const row of layout.entries) {
        const background = luminance(row.background);
        for (const foreground of [row.color, row.timeColor]) {
          const value = luminance(foreground);
          assert.ok((Math.max(value, background) + 0.05) / (Math.min(value, background) + 0.05) >= 4.5);
        }
      }
      report[theme + "-" + width] = layout;
      check(`${theme} ${width}×${height}: all three bubbles and local HH:MM fit, long question wraps, date divider stays centered`);
    }

    await evaluate(`{
      const long = structuredClone(taskInSheet);
      long.history = [{ action: 'chat', actor: 'agent', text: ${JSON.stringify(question.repeat(8))}, at: ${JSON.stringify(expectedTimes[0])} }];
      byId('task-side').replaceChildren(taskChat(long));
    }`);
    assert.equal(await evaluate(`(() => {
      const log = document.querySelector('.task-dialogue');
      const bubble = log.querySelector('.chat-entry');
      return log.scrollWidth <= log.clientWidth + 1 && bubble.scrollWidth <= bubble.clientWidth + 1 &&
        bubble.querySelector('.chat-text').clientHeight > 150;
    })()`), true);
    check("A much longer question wraps inside the narrow bubble without horizontal overflow");
    await reopen();

    if (!restart) {
      const interrupted = cli(["create"], plannedDraft({ title: "Interrupted stream", execution: settings }));
      await until(() => cli(["show", interrupted.id]).history.some(event => event.chat), "interrupted fixture question");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(interrupted.id)}))`), "fixture writer");
      await evaluate(`showTask(${JSON.stringify(interrupted.id)})`);
      provider = undefined;
      await send("Останови этот ответ");
      await until(() => provider, "interruptible provider");
      provider.publish([{ id: "interrupted", type: "agentMessage", phase: "final_answer", text: '{"text":"Незавершённый ответ',
        at: provider.at, status: "inProgress" }]);
      await until(() => evaluate("document.querySelector('.chat-turn .chat-text')?.textContent.includes('Незавершённый ответ')"), "partial reply");
      assert.equal((await evaluate(`window.taskboard.chatStop(${JSON.stringify(interrupted.id)})`)).ok, true);
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(interrupted.id)}))`), "stopped writer");
      await evaluate(`showTask(${JSON.stringify(interrupted.id)})`);
      assert.equal(await evaluate("document.querySelector('.task-dialogue').textContent.includes('Незавершённый ответ')"), false);
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      assert.equal(cli(["show", interrupted.id]).history.filter(event => event.chat && event.actor === "agent").length, 1);
      check("Stopping a partial reply removes its live bubble without saving an unfinished agent message");

      provider = undefined;
      await until(() => evaluate("document.querySelector('.chat-retry-reply')?.disabled === false"), "retry enabled after stop");
      await evaluate("document.querySelector('.chat-retry-reply').click()");
      await until(() => provider, "retry after interruption");
      await until(() => evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), "retry thinking");
      provider.finish.reject(new Error("Fixture provider error"));
      await until(() => evaluate("document.querySelector('.chat-composer .chat-status')?.textContent.includes('Fixture provider error')"), "provider error shown");
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      check("A failed retry reports the provider error and clears Думаю…");

      const interruptedMessages = () => cli(["show", interrupted.id]).history.filter(event => event.chat);
      const showInterrupted = () => evaluate(`showTask(${JSON.stringify(interrupted.id)})`);
      provider = undefined;
      await until(() => evaluate("document.querySelector('.chat-retry-reply')?.disabled === false"), "retry enabled after failure");
      await evaluate("document.querySelector('.chat-retry-reply').click()");
      await until(() => provider, "retry provider after error");
      await until(() => evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), "continued reply thinking");
      const continued = "Обработка продолжена.";
      provider.finish.resolve({ text: JSON.stringify({ text: continued, awaitingAnswer: false, confirmsDraft: false }) });
      await until(() => interruptedMessages().length === 3, "continued reply saved");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(interrupted.id)}))`), "continued writer released");
      await showInterrupted();
      await until(async () => (await snapshot()).at(-1)?.text === continued, "continued reply rendered");
      assert.deepEqual((await snapshot()).map(row => row.text), [question, "Останови этот ответ", continued]);
      check("Continuing the interrupted reply keeps the saved user message and stores one completed response");

      provider = undefined;
      await send("Расскажи, что записано в карточке");
      await until(() => provider, "ordinary message provider");
      await until(() => evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), "ordinary message thinking");
      const ordinary = "В карточке записано требование автоматически удалить рабочую копию.";
      const encoded = JSON.stringify({ text: ordinary, awaitingAnswer: false, confirmsDraft: false });
      provider.finish.resolve({ text: encoded });
      await until(() => interruptedMessages().length === 5, "ordinary reply without tool events saved");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(interrupted.id)}))`), "ordinary writer released");
      await showInterrupted();
      await until(async () => (await snapshot()).at(-1)?.text === ordinary, "ordinary reply rendered");
      assert.deepEqual((await snapshot()).map(row => row.text), [question, "Останови этот ответ", continued, "Расскажи, что записано в карточке", ordinary]);
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      check("An ordinary message gets Думаю… and exactly one saved reply without tool events");

      const activeId = JSON.stringify(activeCard.id);
      const showActive = () => evaluate(`showTask(${activeId})`);
      const showActiveFromCli = () => cli(["show", activeCard.id]);
      const launched = await evaluate(`window.taskboard.launchTask(${activeId})`);
      assert.equal(launched.ok, true, JSON.stringify(launched));
      await until(() => evaluate(`frame.runningTasks?.includes(${activeId})`), "active executor visible");
      assert.equal(showActiveFromCli().status, "in_progress");
      const contextMessage = "Уточни, когда должна удаляться рабочая копия.";
      const questionRequest = cli(["chat", activeCard.id], { ...settings, text: contextMessage });
      cli(["chat", activeCard.id], {
        ...settings, actor: "agent", text: question, awaitingAnswer: true, replyTo: questionRequest.history.length - 1,
      });
      await showActive();
      await until(async () => (await snapshot()).at(-1)?.text === question, "question visible during execution");
      const active = executor;
      const oldAction = {
        id: "before-owner-reply", type: "commandExecution", title: "Existing executor action",
        text: "Action started before the owner replied", status: "inProgress",
      };
      active.publish(oldAction);
      await until(() => evaluate(`frame.runActivity?.[${activeId}]?.some(item => item.id === 'before-owner-reply')`), "pre-existing executor action");
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      nativeTheme.themeSource = "dark";
      window.setContentSize(1280, 900);
      await evaluate("applyTheme('dark'); void 0");
      await send(answer);
      await until(() => active.messages.length === 1, "active executor steering");
      const [steered] = active.messages;
      assert.equal(steered.text, answer);
      assert.ok(steered.messageId, "owner message has a client identifier");
      await until(async () => (await snapshot()).at(-1)?.text === answer &&
        await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking[role=status]'))"), "saved owner reply and thinking on in-progress card");
      assert.equal(await evaluate(`taskInSheet.status === 'in_progress' && frame.runningTasks.includes(${activeId})`), true);
      assert.equal(await evaluate("document.querySelector('.chat-thinking').textContent"), "Думаю…");
      active.publish({ ...oldAction, text: "Completed after the owner replied", status: "completed" });
      await until(() => evaluate(`frame.runActivity?.[${activeId}]?.some(item =>
        item.id === 'before-owner-reply' && item.status === 'completed')`), "pre-existing executor action completes");
      assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), true);
      assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn .chat-run-item'))"), false);
      await capture("card-reply-thinking.png", ".chat-turn .chat-thinking");
      check("1280×900: an in-progress card shows Думаю… after its active executor receives должна удаляться; the older running action stays in Ход работы");

      active.acknowledge(steered.messageId);
      const liveTool = {
        id: "steered-task-update", type: "dynamicToolCall", title: "task_update", status: "inProgress",
        text: JSON.stringify({ arguments: { criterion: "Рабочая копия должна удаляться" } }, null, 2),
        at: new Date().toISOString(),
      };
      active.publish({
        id: "old-provider-turn", type: "mcpToolCall", title: "Event from a different provider turn", status: "completed", text: "",
      }, false);
      active.publish(liveTool);
      const liveAction = ".chat-turn details[data-item='item:steered-task-update']";
      await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(liveAction)}))`), "active executor tool in Dialogue");
      await evaluate(`{
        document.querySelector(${JSON.stringify(liveAction + " summary")}).click();
        const log = document.querySelector('.task-dialogue');
        log.scrollTop = log.scrollHeight;
      }`);
      assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking, .chat-turn .chat-entry'))"), false);
      assert.equal(await evaluate("Boolean(document.querySelector('.chat-turn [data-item=\"item:old-provider-turn\"]'))"), false);
      await capture("card-reply-tool-call.png", liveAction + "[open] .chat-run-output");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(liveAction)}).textContent.includes('Рабочая копия должна удаляться')`), true);
      check("1280×900: the in-progress card shows the active executor’s expanded task_update with arguments before the final reply and excludes events from another provider turn");

      active.publish({ ...liveTool, status: "completed" });
      active.publish({
        id: "steered-final", type: "agentMessage", title: "", phase: "final_answer", status: "completed",
        text: reply, at: new Date().toISOString(),
      });
      await until(async () => (await snapshot()).at(-1)?.text === reply, "active executor final reply visible");
      assert.deepEqual((await snapshot()).map(row => row.text), [contextMessage, question, answer, reply]);
      active.finish.resolve();
      await until(() => showActiveFromCli().history.some(event => event.chat && event.text === reply), "active executor final reply saved");
      await evaluate("document.querySelector('#close-sheet').click()");
      await showActive();
      await until(async () => (await snapshot()).at(-1)?.text === reply, "active executor reply restored from history");
      assert.deepEqual((await snapshot()).map(row => row.text), [contextMessage, question, answer, reply]);
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      await evaluate("byId('task-side').querySelector('[aria-controls=task-chat-work]').click()");
      await until(() => evaluate("Boolean(document.querySelector('.task-work [data-item=\"item:before-owner-reply\"]'))"), "older executor action in work");
      assert.equal(await evaluate("document.querySelectorAll('.task-work [data-item=\"item:steered-task-update\"]').length"), 1);
      check("The active executor final reply is saved exactly once. Both old and new actions remain in Ход работы after reopening");

      await until(() => executor !== active, "executor continues after the completed response");
      await until(() => evaluate(`frame.runningTasks?.includes(${activeId})`), "continued executor visible");
      await evaluate("byId('task-side').firstElementChild.openDialogue()");
      const continuedExecutor = executor;
      const rejected = "Уточни, как удалится рабочая копия.";
      const requestError = "Fixture provider rejected steering";
      continuedExecutor.steeringGate = Promise.withResolvers();
      await send(rejected);
      await until(() => continuedExecutor.messages.length === 1, "steering starts before simulated rejection");
      await until(async () => (await snapshot()).at(-1)?.text === rejected &&
        await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), "saved message and thinking before steering rejection");
      continuedExecutor.steeringGate.reject(new Error(requestError));
      await until(() => evaluate(`document.querySelector('.chat-composer .chat-status')?.textContent.includes(${JSON.stringify(requestError)})`), "steering rejection displayed");
      assert.equal(await evaluate("document.querySelector('.chat-turn').childElementCount"), 0);
      assert.equal((await snapshot()).at(-1)?.text, rejected);
      assert.equal(await evaluate(`frame.runningTasks?.includes(${activeId})`), true);
      await evaluate("byId('task-side').querySelector('[aria-controls=task-chat-work]').click()");
      await until(() => evaluate("Boolean(document.querySelector('.task-work [data-item=\"item:before-owner-reply\"]'))"), "old action kept after failed steering");
      check("A rejected steering request clears Думаю…, keeps the owner’s message and preserves older work while the executor runs");

      continuedExecutor.steeringGate = undefined;
      await evaluate("byId('task-side').firstElementChild.openDialogue()");
      const toStop = "Останови активного исполнителя.";
      await send(toStop);
      await until(() => continuedExecutor.messages.length === 2, "steering before stop");
      await until(async () => (await snapshot()).at(-1)?.text === toStop &&
        await evaluate("Boolean(document.querySelector('.chat-turn .chat-thinking'))"), "thinking before active executor stop");
      await until(() => evaluate(`(() => {
        const stop = document.querySelector('.task-chat .chat-send');
        return stop && !stop.disabled && stop.getAttribute('aria-label') === 'Остановить агента';
      })()`), "task Stop button enabled");
      await evaluate("document.querySelector('.task-chat .chat-send').click()");
      await until(() => evaluate(`!frame.runningTasks?.includes(${activeId}) &&
        document.querySelector('.chat-turn').childElementCount === 0`), "active executor stopped and thinking cleared");
      assert.deepEqual(showActiveFromCli().history.filter(event => event.chat).map(event => event.text),
        [contextMessage, question, answer, reply, rejected, toStop]);
      check("Stopping the executor before it acknowledges the latest message clears Думаю… and stores no unfinished reply");
      await display();
    }

    // Compatibility records are renderer fixtures; the current CLI always records an event time.
    await evaluate(`{
      const legacy = structuredClone(taskInSheet);
      legacy.history = [{ action: 'chat', actor: 'agent', text: 'Старая запись без времени' },
        { action: 'chat', actor: 'user', text: 'Старая реплика пользователя', at: 'invalid-date' }];
      byId('task-side').replaceChildren(taskChat(legacy));
    }`);
    assert.equal(await evaluate("document.querySelectorAll('.task-dialogue time').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('.task-dialogue .chat-entry').length"), 2);
    check("Legacy agent/user records with missing or invalid dates remain untimed");
    await reopen();
    if (!restart) writeFileSync(statePath, JSON.stringify({ id: card.id, messages: messages(), report }));
  } catch (error) {
    report.failure = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(process.exitCode ?? 0);
  }
})();
