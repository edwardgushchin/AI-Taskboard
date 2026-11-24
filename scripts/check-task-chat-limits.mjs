import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "task-chat-limits", 180_000,
  [["--before-restart"], ["--after-restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const { codexLimitSnapshot } = require("../src/desktop/provider-limits.ts");
const { CodexQuotaExceeded } = require("../src/desktop/codex-rpc.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const saved = join(scratch, "scenario.json");
const restarting = process.argv.includes("--after-restart");
const settings = { model: "fixture-sol", effort: "high" };
const filename = "уточнение.txt";
const waiting = "Ожидает сброса лимита";
const messages = {
  budget: "Разбор черновика: сохранить отчёт в CSV.",
  quota: "Диалог: сохранить недельный отчёт.",
  combined: "Диалог: добавить сводку.",
  running: "Диалог: продолжить уже начатый ответ.",
  interrupted: "Диалог: сохранить отчёт в XLSX.",
  followup: "Диалог: обработать следующее вложение.",
};
const calls = [];
const checks = [];
const sessionId = "438af716-e741-4385-8a55-f23e82c5db30";
const updatedDescription = "Сохранять итоговый отчёт в XLSX.";
let exhausted = restarting;
let failWrite = false;
let writeRejected = false;
const finishRejectedWrite = Promise.withResolvers();
let pausedAttachment;
let budgetTurn = 0;
const gates = new Map();

function cli(args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project, "--json",
    ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: scratch, encoding: "utf8", windowsHide: true, input: JSON.stringify(input) }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function until(label, probe) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error("Timed out: " + label + " · " + JSON.stringify(calls));
}

function pass(message) {
  checks.push(message);
  console.log("PASS " + message);
}

globalThis.limitChatFixture = {
  limits: () => Promise.resolve(codexLimitSnapshot({ rateLimits: {
    primary: { usedPercent: exhausted ? 100 : 20, resetsAt: Date.now() / 1000 + 3600 },
  } })),
  rejectWrite(args) {
    if (!failWrite || args[1][0] !== "chat" || args[2]?.text !== messages.quota) return;
    failWrite = false;
    writeRejected = true;
    return finishRejectedWrite.promise.then(() => ({
      ok: false,
      error: { code: "BOARD_BUSY", message: "Проверка ошибки записи" },
    }));
  },
  waitForAttachment(args, read) {
    const [command, action] = args[1];
    const file = args[2]?.file;
    if (command !== "attachment" || action !== "read" || !pausedAttachment || pausedAttachment.file !== file) {
      return read();
    }
    pausedAttachment.started = true;
    return pausedAttachment.release.promise.then(read);
  },
  async reply(prompt, action, options) {
    options.beforeStart?.();
    const context = JSON.parse(prompt);
    const request = context.latestUserMessage?.text;
    if (!request) throw new Error("Unexpected initial discussion");
    const docs = context.attachments.filter(file => context.latestUserMessage.files.includes(file.id));
    calls.push({ request, docs: docs.map(file => readFileSync(file.path, "utf8")),
      resume: options.discussionThread?.id, draft: context.task.status === "draft" });
    options.discussionThread?.accepted(sessionId);
    options.onControl({ interrupt: async () => { throw new Error("Explicit answer was interrupted by the board"); } });
    if (request.startsWith(messages.running)) await gates.get(request).promise;
    if (request === messages.interrupted && !options.discussionThread?.id) {
      const result = await action("task_update", { authorization: "сохранить отчёт в XLSX", description: updatedDescription });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.changed, true);
      await gates.get(request).promise;
      exhausted = true;
      await globalThis.limitChatApp.refresh();
      throw new CodexQuotaExceeded("Fixture provider ended the turn because quota was exhausted");
    }
    if (request === messages.interrupted) {
      assert.equal(context.task.description, updatedDescription);
      assert.equal(options.discussionThread?.id, sessionId);
    }
    const draft = context.task.status === "draft";
    const text = draft ? "Разбор учёл новый формат CSV." : "Ответ сохранён. " + request;
    return { text: JSON.stringify({ text, awaitingAnswer: false, awaitingOwnerAnswer: false,
      ...(draft ? { confirmsDraft: true } : {}) }) };
  },
};

function compile(url, target, transform) {
  const source = readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
  writeFileSync(target, transformSync(transform(source), { loader: "ts", format: "esm" }).code);
}

const evaluate = (window, code) => window.webContents.executeJavaScript(code);
const task = id => cli(["show", id]);
const chat = id => task(id).history.filter(event => event.chat);
const savedUsers = id => chat(id).filter(event => event.actor === "user");

async function open(window, id) {
  await evaluate(window, "showTask(" + JSON.stringify(id) + ", true)");
  await until("enabled composer " + id, () =>
    evaluate(window, "Boolean(document.querySelector('#task-chat-input:not([readonly])'))"));
}

async function send(window, message, enter, withFile = true) {
  window.focus();
  window.webContents.focus();
  const file = withFile ? "const data = new DataTransfer();\n" +
    "data.items.add(new File(['fixture attachment'], " + JSON.stringify(filename) + ", { type: 'text/plain' }));\n" +
    "input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));\n" : "";
  await evaluate(window, "(() => {\nconst input = document.querySelector('#task-chat-input');\n" + file +
    "input.value = " + JSON.stringify(message) + ";\ninput.dispatchEvent(new Event('input'));\ninput.focus();\n})()");
  if (enter) {
    const protocol = window.webContents.debugger;
    protocol.attach("1.3");
    try {
      await protocol.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      });
      await protocol.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      });
    } finally {
      protocol.detach();
    }
  } else {
    await evaluate(window, "document.querySelector('.task-chat .chat-send').click()");
  }
}

async function rows(window, message, actor = "user") {
  return evaluate(window, "Array.from(document.querySelectorAll('.task-dialogue .chat-entry[data-actor=" + actor +
    "]')).filter(row => row.textContent.includes(" + JSON.stringify(message) + ")).map(row => row.textContent)");
}

async function waitSaved(window, id, message) {
  await until("one queued row " + message, async () => {
    const visible = await rows(window, message);
    return visible.length === 1 && visible[0].includes(waiting) && visible[0].includes(filename);
  }).catch(async error => {
    console.error("Composer after send", await evaluate(window, "document.querySelector('.task-chat').innerText"));
    throw error;
  });
  assert.equal(await evaluate(window, "document.querySelector('#task-chat-input').value"), "");
  const entries = savedUsers(id).filter(event => event.text === message);
  assert.equal(entries.length, 1);
  const [file] = entries[0].chat.files;
  assert.equal(task(id).attachments.find(item => item.file === file)?.name, filename);
  assert.equal(Buffer.from(cli(["attachment", "read", id], { file }).base64, "base64").toString(), "fixture attachment");
  return entries[0].chat.requestId;
}

async function capture(window, name, message, actor) {
  await evaluate(window, "document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
  assert.equal((await rows(window, message, actor)).length, 1);
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name), image.toPNG());
}

async function phase() {
  if (!restarting) {
    mkdirSync(project);
    mkdirSync(profile);
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru", theme: "dark" }));
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    cli(["init"], { git: false });
    cli(["settings"], { autoMode: false, codexDailyTokens: 100, executor: { provider: "codex", ...settings } });
  }
  app.setPath("userData", profile);
  app.setPath("appData", scratch);
  app.requestSingleInstanceLock = () => true;
  app.disableHardwareAcceleration();
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  const source = new URL("../src/desktop/main.ts", import.meta.url);
  const chatSource = new URL("./codex-chat.ts", source);
  const chatEntry = join(scratch, "limits-chat.mjs");
  const mainEntry = join(scratch, "limits-main.mjs");
  compile(chatSource, chatEntry, value => {
    const target = "reply(profile, project, prompt, images, runAction, { ...options, worklog, mcp: { config, env } })";
    assert.equal(value.split(target).length, 2);
    return value.replace(target, "globalThis.limitChatFixture.reply(prompt, runAction, options)");
  });
  compile(source, mainEntry, value => value
    .replace(chatSource.href, pathToFileURL(chatEntry).href)
    .replace("readCodexLimits(app.getPath(\"userData\"))", "globalThis.limitChatFixture.limits()")
    .replace("import { callCli,", "import { callCli as realCallCli,")
    .replace("codexStatus, configuredCodex,", "codexStatus, configuredCodex as realConfiguredCodex,")
    .replace("import { chatModels,", "import { chatModels as realChatModels,") + [
    "const callCli = (...args) => Promise.resolve(globalThis.limitChatFixture.rejectWrite(args) ??",
    "  globalThis.limitChatFixture.waitForAttachment(args, () => realCallCli(...args)))",
    "  .then(reply => globalThis.limitChatFixture.afterWrite?.(args, reply) ?? reply);",
    "const configuredCodex = async () => ({});",
    "const chatModels = async () => [{ id: 'fixture-sol', effort: 'high', default: true, efforts: ['high'] }];",
    "globalThis.limitChatApp = { createWindow,",
    "  refresh: () => { readProviderLimits.invalidate(); return refreshQuota(); },",
    "  budget: boardCodexBudget,",
    "  isIdle: project => !projectOperations.get(project)?.size,",
    "  spend: (project, turnId) => {",
    "    const usage = usageForBoard(project);",
    "    usage.observe({ threadId: 'fixture-budget', turnId, tokens: 100, observedAt: Date.now() });",
    "    usage.flush();",
    "    budgetUpdated(project);",
    "  },",
    "};",
  ].join("\n"));
  require(mainEntry);
  const first = await until("first window", () => BrowserWindow.getAllWindows()[0]);
  const second = globalThis.limitChatApp.createWindow([project]).window;
  for (const window of [first, second]) {
    window.setContentSize(1280, 800);
    await until("loaded board", () =>
      evaluate(window, "Boolean(typeof frame !== 'undefined' && frame.board)").catch(() => false));
  }
  const refresh = () => globalThis.limitChatApp.refresh();
  const spend = () => globalThis.limitChatApp.spend(project, (restarting ? "restored-" : "initial-") + ++budgetTurn);
  const reset = () => evaluate(first, "taskboard.resetBoardBudget(" + JSON.stringify(project) + ")");
  if (!restarting) {
    spend();
    const draft = cli(["create"], plannedDraft({ title: "Черновик отчёта", execution: { provider: "codex", ...settings } }));
    await open(first, draft.id);
    await send(first, messages.budget, true);
    await waitSaved(first, draft.id, messages.budget);
    assert.equal(calls.length, 0);
    await capture(first, "budget-wait.png", messages.budget, "user");
    await reset();
    await until("draft included message in review", async () => (await rows(first, "Разбор учёл новый формат CSV.", "agent")).length);
    assert.deepEqual(calls.map(call => [call.request, call.docs, call.draft]), [[messages.budget, ["fixture attachment"], true]]);
    await capture(first, "draft-reply.png", "Разбор учёл новый формат CSV.", "agent");
    pass("При дневном лимите Enter сохранил текст и вложение. После сброса разбор черновика получил текст и файл.");

    const existing = cli(["create"], plannedDraft({ title: "Отчёт с существующим диалогом", execution: { provider: "codex", ...settings } }));
    const seeded = cli(["chat", existing.id], { ...settings, text: "Предыдущий вопрос." });
    cli(["chat", existing.id], {
      ...settings,
      actor: "agent",
      text: "Предыдущий ответ.",
      replyTo: seeded.history.length - 1,
      revision: seeded.revision,
      awaitingAnswer: false,
      confirmsDraft: true,
    });
    assert.equal(cli(["approve", existing.id]).status, "ready");
    await open(first, existing.id);
    await open(second, existing.id);
    failWrite = true;
    await send(first, messages.quota, false);
    await until("pending write", () => writeRejected);
    exhausted = true;
    await refresh();
    const held = await evaluate(first, `(() => {
      const input = document.querySelector('#task-chat-input');
      const attachments = input.closest('.task-chat').querySelector('.draft-attachments');
      return { text: input.value, readOnly: input.readOnly, files: attachments.textContent };
    })()`);
    assert.equal(held.text, messages.quota);
    assert.equal(held.readOnly, false);
    assert.ok(held.files.includes(filename));
    assert.equal((await rows(first, messages.quota)).length, 1);
    finishRejectedWrite.resolve();
    await until("draft retained on write error", () => evaluate(first,
      "document.querySelector('#task-chat-input:not([readonly])')?.value === " + JSON.stringify(messages.quota) +
      " && Boolean(document.querySelector('.task-chat p.chat-status:not([hidden])')?.textContent)"));
    assert.equal(savedUsers(existing.id).length, 1);
    await evaluate(first, "frame.quotaWait = undefined; void 0");
    await send(first, messages.quota, false, false);
    const requestId = await waitSaved(first, existing.id, messages.quota);
    const duplicate = await evaluate(second, "taskboard.chatSend(" + JSON.stringify(existing.id) + ", " +
      JSON.stringify({ ...settings, text: messages.quota, requestId, files: [] }) + ")");
    assert.equal(duplicate.saved, true);
    await waitSaved(second, existing.id, messages.quota);
    spend();
    await send(second, messages.combined, true);
    await waitSaved(second, existing.id, messages.combined);
    assert.equal(calls.length, 1);
    await capture(second, "quota-wait.png", messages.combined, "user");
    await evaluate(second, "document.querySelector('#close-sheet').click()");
    await open(second, existing.id);
    await waitSaved(second, existing.id, messages.combined);
    pass("Квота исчерпана между отправкой и отказом записи. Поле сохранило текст и вложение. Повтор при устаревшем снимке окна сохранил их один раз. При обоих лимитах Enter сохранил вторую реплику.");
    writeFileSync(saved, JSON.stringify({ checks, existing: existing.id, pending: task(existing.id).pendingLimitChat }));
    return;
  }
  const previous = JSON.parse(readFileSync(saved, "utf8"));
  checks.push(...previous.checks);
  const id = previous.existing;
  await open(first, id);
  await open(second, id);
  assert.deepEqual(task(id).pendingLimitChat, previous.pending);
  await waitSaved(first, id, messages.quota);
  await waitSaved(second, id, messages.combined);
  assert.equal((await evaluate(first, "taskboard.bootstrap()")).board.settings.autoMode, false);
  exhausted = false;
  await refresh();
  assert.equal(globalThis.limitChatApp.budget(project)?.reason, "exhausted");
  assert.equal(calls.length, 0);
  await reset();
  await until("both replies after reset", () => chat(id).filter(event => event.actor === "agent").length === 3);
  assert.deepEqual(calls.map(call => [call.request, call.docs]), [
    [messages.quota, ["fixture attachment"]],
    [messages.combined, ["fixture attachment"]],
  ]);
  assert.equal(task(id).pendingLimitChat, undefined);
  await until("reply shown in both windows", async () =>
    (await rows(first, messages.combined, "agent")).length === 1 && (await rows(second, messages.combined, "agent")).length === 1);
  await capture(second, "quota-reply.png", messages.combined, "agent");
  pass("После перезапуска при выключенном авторежиме обе реплики видны в двух окнах. Снятие одной общей квоты не запускает ответ. После сброса бюджета ответы и вложения обрабатываются один раз в порядке отправки.");

  async function sendWithPausedAttachment(message) {
    // Gate attachment preparation after the next user event is durably recorded.
    const release = Promise.withResolvers();
    globalThis.limitChatFixture.afterWrite = (args, reply) => {
      if (args[1][0] === "chat" && args[2]?.text === message && reply.ok) {
        const [file] = reply.data.history.at(-1).chat.files;
        pausedAttachment = { file, release, started: false };
        delete globalThis.limitChatFixture.afterWrite;
      }
      return reply;
    };
    await send(first, message, false);
    await until("saved follow-up attachment in preparation", () => pausedAttachment?.started);
    assert.equal(task(id).pendingLimitChat, undefined);
    return () => {
      pausedAttachment = undefined;
      release.resolve();
    };
  }

  const answers = message => chat(id).filter(event => event.actor === "agent" && event.text.endsWith(message));
  for (const limits of [
    { label: "дневной бюджет", budget: true, quota: false },
    { label: "общая квота", budget: false, quota: true },
    { label: "оба лимита", budget: true, quota: true },
  ]) {
    const firstMessage = messages.running + " " + limits.label;
    const secondMessage = `Диалог: следующий файл (${limits.label}).`;
    const complete = Promise.withResolvers();
    gates.set(firstMessage, complete);
    await send(first, firstMessage, false, false);
    await until("active reply", () => calls.some(call => call.request === firstMessage));
    const releaseAttachment = await sendWithPausedAttachment(secondMessage);
    if (limits.budget) spend();
    if (limits.quota) {
      exhausted = true;
      await refresh();
    }
    complete.resolve();
    await until("successful reply saved while the attachment is paused", () => answers(firstMessage).length === 1);
    const card = task(id);
    assert.deepEqual(card.pendingLimitChat.map(index => card.history[index].text), [secondMessage]);
    assert.equal(card.limitChatContinuation, undefined);
    assert.equal(calls.some(call => call.request === secondMessage), false);
    await open(first, id);
    await waitSaved(first, id, secondMessage);
    releaseAttachment();
    if (limits.quota) {
      exhausted = false;
      await refresh();
    }
    if (limits.budget) await reset();
    await until("next answer after reset", () => answers(secondMessage).length === 1);
    await until("chat operations released", () => globalThis.limitChatApp.isIdle(project));
    assert.equal(answers(firstMessage).length, 1);
    assert.equal(task(id).pendingLimitChat, undefined);
    assert.deepEqual(calls.slice(-2).map(call => [call.request, call.docs]), [
      [firstMessage, []],
      [secondMessage, ["fixture attachment"]],
    ]);
    pass(`При задержке следующего вложения готовый ответ сохранён один раз. Проверка охватила ${limits.label}. После сброса агент получил следующую реплику с вложением и ответил на неё.`);
  }

  gates.set(messages.interrupted, Promise.withResolvers());
  await send(first, messages.interrupted, false, false);
  await until("interrupted reply wrote its change", () => task(id).description === updatedDescription);
  const releaseAttachment = await sendWithPausedAttachment(messages.followup);
  gates.get(messages.interrupted).resolve();
  await until("previous reply is deferred", () => task(id).limitChatContinuation?.threadId === sessionId);
  assert.equal(task(id).description, updatedDescription);
  await until("interrupted reply shown as waiting", async () => (await rows(first, messages.interrupted))[0]?.includes(waiting));
  const queued = task(id);
  assert.deepEqual(queued.pendingLimitChat.map(index => queued.history[index].text), [messages.interrupted, messages.followup]);
  await open(first, id);
  await waitSaved(first, id, messages.followup);
  releaseAttachment();
  exhausted = false;
  await refresh();
  await until("interrupted answer completed automatically", () =>
    chat(id).some(event => event.actor === "agent" && event.text.includes(messages.interrupted)));
  assert.deepEqual(calls.filter(call => call.request === messages.interrupted).map(call => call.resume), [undefined, sessionId]);
  assert.equal(savedUsers(id).filter(event => event.text === messages.interrupted).length, 1);
  assert.equal(task(id).history.filter(event => event.action === "update" && event.ownerBriefSource).length, 1);
  assert.equal(task(id).limitChatContinuation, undefined);
  await until("follow-up answered after the continuation", () =>
    chat(id).some(event => event.actor === "agent" && event.text.includes(messages.followup)));
  assert.deepEqual(calls.slice(-2).map(call => [call.request, call.docs]), [
    [messages.interrupted, []],
    [messages.followup, ["fixture attachment"]],
  ]);
  assert.equal(task(id).pendingLimitChat, undefined);
  pass("Квота прервала ход, пока готовилось вложение уже сохранённой следующей реплики. Первый ответ продолжился в том же сеансе с одной правкой, второй получил вложение после него.");
  const files = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean);
  const tested = [...new Set([
    ...files, "src/cli/archive.ts", "src/desktop/main.ts", "src/desktop/chat.js", "src/desktop/renderer.js",
    "scripts/check-task-chat-limits.mjs",
  ])];
  const report = {
    command: "node scripts/check-task-chat-limits.mjs --artifacts .tasks/qa/T-0351",
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    gitBase: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    fixture: "Изолированная доска и профиль. Реальные renderer, preload, IPC, планировщик, бюджет и CLI. Лимиты и ответы Codex заданы на границе провайдера.",
    checks,
    sha256CheckoutBytes: Object.fromEntries(tested.map(path => [path,
      createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])),
  };
  writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

process.on("unhandledRejection", error => {
  console.error(error);
  app.exit(1);
});
void phase().then(async () => {
  await until("chat operations released", () => globalThis.limitChatApp.isIdle(project));
  app.quit();
});
