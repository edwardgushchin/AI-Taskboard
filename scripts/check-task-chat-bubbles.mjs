// Real Electron, CLI, IPC and renderer; only the provider response is deterministic.
// node scripts/check-task-chat-bubbles.mjs --artifacts .tasks/qa/T-0219
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
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
const reportPath = join(artifacts, "task-chat-bubbles-check.txt");
const statePath = join(scratch, "saved.json");
const settings = { model: "fixture", effort: "low" };
const question = "Старые записи оставить в прежних вкладках или перенести в «Ход работы»?";
const answer = "Сохранить в прежних вкладках.";
const reply = "Старые записи останутся на месте. Новые реплики появятся в «Диалоге».";
const report = restart ? JSON.parse(readFileSync(statePath, "utf8")).report : {
  command: "node scripts/check-task-chat-bubbles.mjs --artifacts .tasks/qa/T-0219",
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
  representation: "SHA-256 of UTF-8 source with CRLF normalized to LF (Git text representation)",
  sources: Object.fromEntries([
    "src/desktop/chat.js", "src/desktop/styles.css", "src/desktop/codex-chat.ts", "src/desktop/main.ts",
    "src/cli/archive.ts", "scripts/check-task-chat-bubbles.mjs", "scripts/electron-check.mjs",
    "tests/task-question.test.ts", "docs/explanation/architecture.md",
  ].map(path => [path, createHash("sha256").update(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")).digest("hex")])),
  environment: { platform: process.platform, node: process.versions.node, electron: process.versions.electron, chromium: process.versions.chrome },
  matrix: { Windows: "Electron runtime checked", Linux: "Not run; shared renderer, no process/path/packaging changes", macOS: "Not run; shared renderer, no process/path/packaging changes" },
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
globalThis.taskBubbleProvider = async (options, mode) => {
  options.onControl({ interrupt: async () => provider?.finish.resolve({ interrupted: true }), steer: async () => {} });
  if (mode === "initial") return { text: JSON.stringify({ questions: question }) };
  const finish = Promise.withResolvers();
  provider = { publish: options.onActivity, finish, at: new Date().toISOString() };
  return finish.promise;
};

void (async () => {
  try {
    if (!restart) {
      mkdirSync(project);
      cli(["init"], { git: false });
      cli(["settings"], { executor: { provider: "codex", ...settings }, autoMode: false });
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
    writeFileSync(entry, compile(readSource(mainUrl).replace(chatUrl.href, pathToFileURL(chatEntry).href)));
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    require(entry);
    await until(() => BrowserWindow.getAllWindows().length, "window");
    const window = BrowserWindow.getAllWindows()[0];
    const evaluate = code => window.webContents.executeJavaScript(code);
    await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
    const preferences = window.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
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
    await display();
    const snapshot = () => evaluate(`Array.from(document.querySelectorAll('.task-dialogue .chat-entry'), row => ({
      actor: row.dataset.actor,
      text: row.querySelector('.chat-text')?.textContent,
      at: row.querySelector('time')?.dateTime,
      time: row.querySelector('time')?.textContent,
      side: getComputedStyle(row).alignSelf,
      radius: getComputedStyle(row).borderRadius,
    }))`);
    if (!restart) {
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(card.id)}))`), "initial writer released");
      await evaluate(`{
        const input = document.querySelector('#task-chat-input');
        input.value = ${JSON.stringify(answer)};
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      }`);
      await until(() => provider, "provider");
      await until(() => evaluate("Boolean(document.querySelector('.task-dialogue .chat-thinking[role=status]'))"), "waiting indicator");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-thinking')).borderRadius"), "0px");
      check("Waiting indicator retains its separate status appearance");
      const encoded = JSON.stringify({ text: reply, awaitingAnswer: false });
      const publish = text => provider.publish([{ id: "reply", type: "agentMessage", phase: "final_answer", text,
        at: provider.at, status: "inProgress" }]);
      for (const length of [35, 60, encoded.length]) {
        publish(encoded.slice(0, length));
        await until(async () => (await snapshot()).length === 3, "stream bubble");
        const rows = await snapshot();
        assert.equal(rows[2].actor, "agent");
        assert.equal(rows[2].radius, "16px");
        assert.equal(rows[2].at, provider.at);
        assert.ok(reply.startsWith(rows[2].text.trim()), JSON.stringify(rows[2]));
        assert.ok(rows[2].text.length > 0);
        assert.doesNotMatch(rows[2].text, /awaitingAnswer|\{"text"/);
      }
      await reopen();
      await until(async () => (await snapshot()).length === 3, "stream after reopening");
      assert.equal((await snapshot())[2].at, provider.at);
      check("Incremental provider JSON renders text inside one agent bubble and survives reopening during the stream");
      provider.finish.resolve({ text: encoded });
      await until(() => messages().length === 3, "saved reply");
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(card.id)}))`), "writer released");
      assert.equal(messages()[2].at, provider.at);
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
      frame.replyingTasks = [${JSON.stringify(card.id)}];
      byId('task-side').firstElementChild.updateRun([{ id: 'saved-reply', type: 'agentMessage', phase: 'final_answer',
        text: ${JSON.stringify(reply)}, at: ${JSON.stringify(expectedTimes[2])}, status: 'completed' }]);
    }`);
    assert.equal((await snapshot()).length, 3);
    await evaluate("frame.replyingTasks = []; byId('task-side').firstElementChild.updateRun([]); void 0");
    check("A saved reply and its late live snapshot never produce duplicate bubbles");

    for (const [theme, width, height, name] of [
      ["dark", 1280, 800, "task-chat-bubbles-dark.png"],
      ["light", 1280, 800],
      ["dark", 1024, 768],
      ["light", 1024, 768, "task-chat-bubbles-light-narrow.png"],
    ]) {
      nativeTheme.themeSource = theme;
      window.setContentSize(width, height);
      await evaluate(`applyTheme(${JSON.stringify(theme)}); document.querySelector('.task-dialogue').scrollTop = 0; void 0`);
      await evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
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
            return { radius: style.borderRadius, background: style.backgroundColor, color: style.color,
              timeColor: getComputedStyle(time).color, correctTime: time.textContent === date && /^\\d{2}:\\d{2}$/.test(date),
              accessible: time.title === time.getAttribute('aria-label'),
              inside: stamp.top >= box.top && stamp.bottom <= box.bottom && stamp.left >= box.left && stamp.right <= box.right,
              visible: box.top >= log.getBoundingClientRect().top && box.bottom <= log.getBoundingClientRect().bottom,
              lines: row.querySelector('.chat-text').clientHeight / parseFloat(getComputedStyle(row.querySelector('.chat-text')).lineHeight) };
          }),
          dividers: [...log.querySelectorAll('.chat-day')].map(row => ({ side: getComputedStyle(row).alignSelf, radius: getComputedStyle(row).borderRadius })),
        };
      })()`);
      assert.equal(layout.fits, true);
      assert.equal(layout.entries.length, 3);
      assert.ok(layout.entries.every(row => row.radius === "16px" && row.correctTime && row.accessible && row.inside && row.visible), JSON.stringify(layout));
      assert.ok(layout.entries[0].lines >= 2);
      assert.ok(layout.dividers.length > 0 && layout.dividers.every(row => row.side === "center" && row.radius === "0px"));
      if (restart && name) writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
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
      await evaluate(`{
        const input = document.querySelector('#task-chat-input');
        input.value = 'Stop this reply';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      }`);
      await until(() => provider, "interruptible provider");
      provider.publish([{ id: "interrupted", type: "agentMessage", phase: "final_answer", text: '{"text":"Незавершённый ответ',
        at: provider.at, status: "inProgress" }]);
      await until(() => evaluate("document.querySelector('.chat-turn .chat-text')?.textContent.includes('Незавершённый ответ')"), "partial reply");
      assert.equal((await evaluate(`window.taskboard.chatStop(${JSON.stringify(interrupted.id)})`)).ok, true);
      await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(interrupted.id)}))`), "stopped writer");
      await evaluate(`showTask(${JSON.stringify(interrupted.id)})`);
      assert.equal(await evaluate("document.querySelector('.task-dialogue').textContent.includes('Незавершённый ответ')"), false);
      assert.equal(cli(["show", interrupted.id]).history.filter(event => event.chat && event.actor === "agent").length, 1);
      check("Stopping a partial reply removes its live bubble without saving an unfinished agent message");
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
