import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Real Electron, CLI and renderer. Pass --live to exercise the installed Codex provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import localization from "../src/desktop/localization.cjs";

const live = process.argv.includes("--live");
const creationOnly = process.argv.includes("--creation-only");
const revisionOnly = process.argv.includes("--revision-only");
const approvalOnly = process.argv.includes("--approval-only");
const { scratch, artifacts } = electronCheck(import.meta.url, "draft-discussion", 240000,
  live || creationOnly || revisionOnly ? [[]] : [["--first-pass"], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const restart = process.argv.includes("--restart");
const project = join(scratch, "board");
const manual = join(scratch, "personal");
const profile = join(scratch, "profile");
const evidence = join(approvalOnly ? scratch : artifacts, "draft-discussion.json");
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const cli = (args, input, root = project, error, { nodeArgs = [], env } = {}) => {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, [
    ...nodeArgs, "--disable-warning=ExperimentalWarning", cliPath,
    "--project", root, "--json", ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], {
    cwd: scratch,
    encoding: "utf8",
    windowsHide: true,
    env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  const reply = JSON.parse(result.stdout);
  assert.equal(result.status, error ? 1 : 0, JSON.stringify(reply));
  assert.equal(reply.error?.code, error);
  return reply.data;
};
const until = async (predicate, label) => {
  const deadline = Date.now() + (live ? 65000 : 20000);
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw Error("Timed out: " + label);
    await delay(90);
  }
};
const settings = { model: "fixture-sol", effort: "high" };
const readyText = localization.text("draft_discussion.ready", {}, "ru");
const show = id => cli(["show", id]);
const messages = card => card.history.filter(event => event.chat);
const report = restart ? JSON.parse(readFileSync(evidence, "utf8")) :
  { platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome, checks: [] };
const check = text => { report.checks.push(text); console.log("PASS " + text); };
process.env.GIT_CEILING_DIRECTORIES = scratch;
const staging = join(scratch, "staging");
if (!restart) mkdirSync(staging);
process.env.TMPDIR = process.env.TEMP = process.env.TMP = staging;
app.setPath("userData", profile);
app.setPath("appData", join(scratch, "app-data"));
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru", theme: "dark" }));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();

let selection = project;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
const calls = [];
let mutableSources = [];
let failProvider = true;
const heldDrafts = new Set();
const draftGates = new Map();
let stopGate;
let failMessage = true;
let releaseClarification;
let formatUpdate;
const initialFormat = "Use CSV and save it in exports.";
const formatChanges = ["Use XLSX instead of CSV.", "Use JSON instead of XLSX."];
const revisedBrief = "Экспортировать архив с итоговым отчётом.";
const returnedTitle = "Экспорт отчёта после возврата в черновик";
const requestArchive = "Какой архив использовать?";
const archiveQuestion = "Использовать недельный или месячный архив?";
const archiveAnswer = "Использовать недельный архив.";
const archiveConfirmed = "Недельный архив подтверждён.";
globalThis.draftFixtureReply = async (_profile, cwd, configured, prompt, images, _commentary, action, _scratch,
  _limit, _usage, onControl, _signal, id, _activity, mode) => {
  const context = JSON.parse(prompt);
  assert.equal(cwd, project);
  assert.equal(context.task.id, id);
  const approvedDialogue = approvalOnly && context.task.title === returnedTitle && mode !== "initial";
  assert.equal(context.task.status, approvedDialogue ? "ready" : "draft");
  if (mode === "initial") {
    assert.equal(_commentary, undefined);
    assert.equal(_activity, undefined);
  }
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Use the project fixture.");
  if (mode === "initial" && context.task.title === "CLI with attachments") {
    // Change the originals after CLI staging, at the provider boundary.
    for (const path of mutableSources) writeFileSync(path, "Changed after staging");
  }
  calls.push({ context, configured, mode, images: images.map(path => readFileSync(path).toString("base64")),
    documents: context.attachments.filter(file => file.path && file.name.endsWith(".txt")).map(file => readFileSync(file.path, "utf8")) });
  const request = context.latestUserMessage?.text;
  if (approvedDialogue) {
    assert.ok(request === requestArchive || request === archiveAnswer, "Unexpected ready card message");
    const awaitingAnswer = request === requestArchive;
    const text = awaitingAnswer ? archiveQuestion : archiveConfirmed;
    return { text: JSON.stringify({ text, awaitingAnswer }) };
  }
  const update = approvalOnly && formatChanges.includes(request) ? {
    request, completion: Promise.withResolvers(), returned: Promise.withResolvers(),
    steeringGate: request === formatChanges[0] ? Promise.withResolvers() : undefined,
    steered: [],
    applyBrief: (authorization, description) => action("task_update", { authorization, description }),
  } : undefined;
  const interrupted = Promise.withResolvers();
  onControl({ interrupt: async () => interrupted.resolve({ interrupted: true }),
    steer: async prompt => {
      assert.ok(update, "Unexpected steering request.");
      update.steered.push(JSON.parse(prompt).latestUserMessage.text);
      await update.steeringGate?.promise;
    },
  });
  if (update) {
    formatUpdate = update;
    const text = await update.completion.promise;
    update.returned.resolve();
    return { text: JSON.stringify({ text, awaitingAnswer: false }) };
  }
  if (context.latestUserMessage?.text === "Fail once" && failMessage) {
    failMessage = false;
    throw Error("Fixture provider unavailable");
  }
  if (context.latestUserMessage?.text === "Fail clarification") {
    throw Error("Fixture clarification unavailable");
  }
  if (context.latestUserMessage?.text === "Wait for stop") {
    stopGate = true;
    return interrupted.promise;
  }
  if (mode === "initial" && context.task.title === "Provider inactive" && failProvider) throw Error("Fixture provider unavailable");
  if (mode === "initial" && heldDrafts.has(context.task.title)) {
    await new Promise(resolve => draftGates.set(id, resolve));
  }
  if (approvalOnly && context.latestUserMessage?.text === initialFormat) {
    await new Promise(resolve => { releaseClarification = resolve; });
  }
  await delay(450);
  if (mode === "initial") {
    let questions = "";
    if (context.task.title === "CLI with attachments") {
      questions = "Which viewport is required?";
    } else if (context.task.title === "Partial answer" && context.task.description !== revisedBrief) {
      questions = "Which format and destination are required?";
    } else if (context.task.title === "Concurrent edits") {
      questions = "Clarify: " + context.task.description;
    }
    return { text: JSON.stringify({ questions }) };
  }
  if (context.latestUserMessage.text === "CSV") {
    return { text: JSON.stringify({ text: "Which destination is required?", awaitingAnswer: true }) };
  }
  const text = context.task.awaitingAnswer ? readyText : "User answer recorded: " + context.latestUserMessage.text;
  return { text: JSON.stringify({ text, awaitingAnswer: false }) };
};

let writer;
let slot;
void (async () => {
try {
  if (!restart) {
    mkdirSync(project);
    mkdirSync(manual);
    cli(["init"], { git: false });
    cli(["init"], { git: false, boardType: "manual" }, manual);
    cli(["settings"], { executor: { provider: "codex", model: "gpt-6.1-sol", effort: "medium" }, taskLimits: { executor: 1, reviewer: 1 } });
    writeFileSync(join(project, "AGENTS.md"), "Use the project fixture.");
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
  }
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const readSource = url => readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
  const compile = source => require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code;
  let source = readSource(sourceUrl);
  if (!live) {
    // Keep replyToTask and its writer context in the test. Replace only the provider call.
    const chatUrl = new URL("./codex-chat.ts", sourceUrl);
    const providerCall = "reply(profile, project, prompt, images, runAction, { ...options, worklog, mcp: { config, env } })";
    const chat = readSource(chatUrl);
    assert.equal(chat.split(providerCall).length, 2);
    const chatEntry = join(scratch, "codex-chat-under-test.mjs");
    writeFileSync(chatEntry, compile(chat.replace(providerCall,
      "globalThis.draftFixtureReply(profile, project, settings, prompt, images, options.onCommentary, runAction, options.imageDirectory, imageLimit, onTokenUsage, onControl, signal, taskId, options.onActivity, mode)")));
    source = source.replace(chatUrl.href, pathToFileURL(chatEntry).href);
  }
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, compile(source));
  process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  await until(() => BrowserWindow.getAllWindows().length > 0, "window");
  const window = BrowserWindow.getAllWindows()[0];
  const viewport = [1280, approvalOnly ? 900 : 800];
  window.setContentSize(...viewport);
  const evaluate = code => window.webContents.executeJavaScript(code);
  await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
  const open = async (path, run = evaluate) => {
    selection = path;
    await run("window.taskboard.menuAction('open-project')");
    await until(() => run(`window.taskboard.bootstrap().then(f => !f.loading && f.board?.project === ${JSON.stringify(path)})`), "open board");
  };
  if (!(await evaluate(`window.taskboard.bootstrap().then(f => f.board?.project === ${JSON.stringify(project)})`))) await open(project);
  const display = id => evaluate(`showTask(${JSON.stringify(id)})`);
  const retry = async id => {
    const failed = show(id);
    assert.equal(failed.draftDiscussion?.phase, "failed");
    await until(async () => {
      if (show(id).revision > failed.revision) return true;
      await evaluate("document.querySelector('.task-chat .chat-status button:enabled')?.click()");
      return false;
    }, "visible draft retry " + id);
  };
  const waitReply = (id, count = 1) => until(() => messages(show(id)).length === count, "chat reply " + id);
  const waitReady = async (id, count = 1) => {
    await until(() => {
      const card = show(id);
      assert.notEqual(card.draftDiscussion?.phase, "failed", card.draftDiscussion?.reason);
      return !card.draftDiscussion;
    }, "ready completion " + id);
    const card = show(id);
    assert.equal(card.status, "draft");
    assert.equal(card.git, undefined);
    assert.equal(card.awaitingAnswer, false);
    assert.equal(messages(card).length, count);
    const confirmation = messages(card).at(-1);
    assert.equal(confirmation.actor, "agent");
    assert.equal(confirmation.text, readyText);
    assert.ok(Number.isFinite(Date.parse(confirmation.at)));
  };
  const reopen = async id => {
    await evaluate("document.querySelector('#close-sheet').click()");
    await display(id);
  };
  const readyDialogue = async () => {
    await until(() => evaluate(`document.querySelector('.task-dialogue:not([hidden])')?.textContent.includes(${JSON.stringify(readyText)})`),
      "visible readiness");
    assert.equal(await evaluate("document.querySelector('.task-dialogue:not([hidden])')?.querySelectorAll('.chat-entry').length"), 1);
    assert.ok(await evaluate("document.querySelector('.task-dialogue .chat-entry time')?.textContent"));
  };
  const capture = async name => {
    window.focus();
    await evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
    const image = await window.webContents.capturePage();
    assert.deepEqual(window.getContentSize(), viewport);
    writeFileSync(join(artifacts, name), image.toPNG());
  };
  const verifyRevision = async (evaluateOther, runtimeEntries) => {
    const failure = cli(["create"], plannedDraft({ title: "Provider inactive", execution: settings }));
    await until(() => show(failure.id).draftDiscussion?.phase === "failed", "provider failure");
    assert.equal(messages(show(failure.id)).length, 0);
    await display(failure.id);
    await until(() => evaluate("document.querySelector('.task-chat').textContent.includes('Fixture provider unavailable')"), "visible failure");
    await capture("draft-discussion-error.png");
    failProvider = false;
    await retry(failure.id);
    await waitReady(failure.id);
    check("Provider failure publishes no readiness until a successful retry");

    const held = async (title, description = "Exercise the task workflow.") => {
      heldDrafts.add(title);
      const card = cli(["create"], plannedDraft({ title, description, execution: settings }));
      await until(() => draftGates.has(card.id), "in-flight response for " + title);
      return card;
    };
    const releaseDraft = (card, holdNext = false) => {
      if (!holdNext) {
        heldDrafts.delete(card.title);
      }
      const release = draftGates.get(card.id);
      draftGates.delete(card.id);
      release();
    };
    const turnsFor = card => calls.filter(call => call.context.task.id === card.id && call.mode === "initial");
    const assignMilestone = card => {
      const git = args => execFileSync("git", args, { cwd: project, windowsHide: true, stdio: "pipe" });
      git(["init"]);
      git(["remote", "add", "origin", "https://github.com/fixture/draft-discussion.git"]);
      const tools = join(scratch, "github-fixture");
      mkdirSync(tools);
      writeFileSync(join(tools, process.platform === "win32" ? "gh.exe" : "gh"), "");
      const mock = `
        import cp from "node:child_process";
        import assert from "node:assert/strict";
        import { syncBuiltinESMExports } from "node:module";
        import { promisify } from "node:util";
        cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (_file, args) => {
          assert.deepEqual(args, ["api", "--hostname", "github.com", "repos/fixture/draft-discussion/milestones/5"]);
          return { stdout: JSON.stringify({ number: 5, title: "0.3.0-alpha", state: "open" }) };
        } });
        syncBuiltinESMExports();
      `;
      return cli(["milestone", card.id], {
        revision: show(card.id).revision,
        milestone: { repository: "fixture/draft-discussion", number: 5 },
      }, project, undefined, {
        nodeArgs: ["--import", "data:text/javascript," + encodeURIComponent(mock)],
        env: { ...process.env, PATH: tools + delimiter + process.env.PATH },
      });
    };
    const milestone = await held("Milestone during review");
    await display(milestone.id);
    const currentRevision = show(milestone.id).revision;
    for (const revision of [currentRevision + "x", "0x10"]) {
      cli(["chat", milestone.id], { draftDiscussion: true, actor: "agent", text: "Unusable revision", revision },
        project, "INVALID_INPUT");
    }
    assert.equal(show(milestone.id).revision, currentRevision);
    assert.equal(assignMilestone(milestone).milestone.title, "0.3.0-alpha");
    releaseDraft(milestone);
    await waitReady(milestone.id);
    await readyDialogue();
    assert.deepEqual(turnsFor(milestone).map(call => call.context.task.milestone?.title), [undefined, "0.3.0-alpha"]);
    check("Assigning a milestone during review automatically produces one readiness message from the latest card");

    const editedDraft = await held("Concurrent edits", "Original brief");
    await display(editedDraft.id);
    await evaluateOther(`showTask(${JSON.stringify(editedDraft.id)})`);
    for (const description of ["First edit", "Second edit", "Third edit"]) {
      cli(["update", editedDraft.id], { description, revision: show(editedDraft.id).revision });
    }
    releaseDraft(editedDraft, true);
    await until(() => draftGates.has(editedDraft.id), "coalesced retry");
    assert.equal(messages(show(editedDraft.id)).length, 0);
    cli(["update", editedDraft.id], { description: "Final brief", revision: show(editedDraft.id).revision });
    releaseDraft(editedDraft);
    await waitReply(editedDraft.id);
    assert.equal(show(editedDraft.id).draftDiscussion, undefined);
    assert.equal(messages(show(editedDraft.id))[0].text, "Clarify: Final brief");
    for (const run of [evaluate, evaluateOther]) {
      await until(() => run(`document.querySelector('.task-dialogue:not([hidden])')?.textContent.includes("Clarify: Final brief")`),
        "current question in both windows");
      assert.equal(await run("document.querySelectorAll('.task-dialogue:not([hidden]) .chat-entry').length"), 1);
    }
    assert.deepEqual(turnsFor(editedDraft).map(call => call.context.task.description), [
      "Original brief", "Third edit", "Final brief",
    ]);
    check("Rapid edits across two attempts coalesce, and both windows show one question about the final brief");

    const unapproved = await held("Approval during review");
    const unapprovedRevision = show(unapproved.id).revision;
    cli(["approve", unapproved.id], { revision: unapprovedRevision }, project, "DRAFT_DISCUSSION_REQUIRED");
    releaseDraft(unapproved);
    await waitReady(unapproved.id);
    check("Approval during automatic discussion is rejected and the review can finish");

    for (const action of ["cancel", "chat"]) {
      const superseded = await held("Superseded by " + action);
      const revision = show(superseded.id).revision;
      const input = { revision };
      if (action === "cancel") {
        input.reason = "Cancel during automatic discussion";
      }
      if (action === "chat") {
        input.actor = "user";
        input.text = "I will continue in chat";
        input.model = settings.model;
        input.effort = settings.effort;
      }
      const updated = cli([action, superseded.id], input);
      const expected = action === "cancel" ? "cancelled" : "draft";
      assert.equal(updated.status, expected);
      releaseDraft(superseded);
      await until(() => !runtimeEntries(project).some(entry => entry.task === superseded.id), "superseded writer released");
      const current = show(superseded.id);
      assert.equal(current.draftDiscussion, undefined);
      assert.equal(current.status, expected);
      assert.deepEqual(messages(current).map(event => event.actor), action === "chat" ? ["user"] : []);
      assert.equal(turnsFor(superseded).length, 1);
    }
    check("Cancelling or sending an ordinary chat message supersedes the automatic turn without a reply or retry");
  };
  const verifyApproval = async () => {
    const approvedLabel = localization.text("ui.approve_535c27a7", {}, "ru");
    const openLabel = localization.text("task_question.open_dialogue_button", {}, "ru");
    const button = label => `[...document.querySelectorAll('#sheet[open] button')]
      .find(button => button.textContent.trim() === ${JSON.stringify(label)} &&
        !button.disabled && button.checkVisibility())`;
    const available = (run = evaluate) => run(`Boolean(${button(approvedLabel)})`);
    const sheetHas = value => evaluate(`document.querySelector('#sheet[open]')?.textContent.includes(${JSON.stringify(value)})`);
    const activate = async (label, method) => {
      window.focus();
      await delay(100);
      const point = await evaluate(`(() => {
        const control = ${button(label)};
        if (!control) throw Error("Expected a visible action");
        control.scrollIntoView({ block: "center" });
        if (${JSON.stringify(method)} === "keyboard") control.focus();
        const { x, y, width, height } = control.getBoundingClientRect();
        return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
      })()`);
      if (method === "keyboard") {
        assert.equal(await evaluate("document.activeElement.textContent.trim()"), label);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      } else {
        window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      }
    };
    const showStatus = (key, values = {}) => until(
      () => sheetHas(localization.text(key, values, "ru")), key);
    const create = (title, description = "Определить формат и место сохранения результата.") =>
      cli(["create"], plannedDraft({
        title, description, criteria: ["Указаны формат и место сохранения."], execution: settings,
      }));
    const send = (id, text, attachment) => evaluate(`(async () => {
      const request = ${JSON.stringify({ ...settings, text, files: [] })};
      const attachment = ${JSON.stringify(attachment)};
      if (attachment) {
        const file = new File([attachment.text], attachment.name, { type: "text/plain" });
        request.files.push(await window.taskboard.filePayload(file));
      }
      return window.taskboard.chatSend(${JSON.stringify(id)}, request);
    })()`);
    const waitWriter = async (id, label) => {
      const { runtimeEntries } = await import("../src/desktop/board-runtime.ts");
      await until(() => !runtimeEntries(project).some(entry => entry.task === id), label);
    };
    const continueDraft = card => {
      heldDrafts.delete(card.title);
      const release = draftGates.get(card.id);
      draftGates.delete(card.id);
      release();
    };
    if (restart) {
      await display(report.approvalDraft);
      await until(available, "approval after restart");
      assert.equal(show(report.approvalDraft).awaitingAnswer, false);
      assert.deepEqual(messages(show(report.approvalDraft)), report.approvalMessages);
      assert.equal(calls.length, 0);
      await capture("approval-ready.png");
      await activate(approvedLabel, "keyboard");
      try {
        await until(() => show(report.approvalDraft).status === "ready", "keyboard approves the same card");
      } catch (error) {
        const notice = await evaluate("document.querySelector('#sheet-notice:not([hidden])')?.textContent");
        throw new Error(notice ? error.message + ": " + notice : error.message, { cause: error });
      }
      check("After Electron restarts, the same draft can be approved with Enter, with its saved reply intact");
      writeFileSync(join(artifacts, "approval-check.txt"), [
        "Ручное утверждение в Windows Electron",
        "Команда: node scripts/check-draft-discussion.mjs --approval-only --artifacts .tasks/qa/T-0314",
        "Git HEAD перед проверкой: " + report.head,
        `ОС: ${report.platform}; Electron: ${report.electron}; Chromium: ${report.chromium}; область содержимого: ${viewport.join("×")}`,
        "Представление хешей исходников: UTF-8, переводы строк CRLF приведены к LF, SHA-256.",
        ...Object.entries(report.sourceHashes).map(([path, hash]) => `${hash}  ${path}`),
        "Запущен реальный Electron и CLI. Провайдер заменён детерминированной фикстурой. Linux и macOS не проверялись.",
        ...report.checks.map(line => "PASS " + line), "",
      ].join("\n"));
      return;
    }

    heldDrafts.add("Partial answer");
    const pending = create("Partial answer");
    await until(() => draftGates.has(pending.id), "provider is reviewing the pending draft");
    await display(pending.id);
    await showStatus("draft_discussion.running");
    assert.equal(await available(), false);
    cli(["approve", pending.id], { revision: show(pending.id).revision }, project, "DRAFT_DISCUSSION_REQUIRED");
    await capture("approval-pending.png");
    continueDraft(pending);
    await waitReply(pending.id);
    await waitWriter(pending.id, "initial question writer released");
    assert.equal(show(pending.id).awaitingAnswer, true);
    await until(() => evaluate(`Boolean(${button(openLabel)})`), "open dialogue action");
    await activate(openLabel, "mouse");
    await until(() => evaluate(`document.querySelector('.task-dialogue:not([hidden])')
      ?.textContent.includes("Which format and destination are required?")`), "question visible after mouse opens dialogue");
    assert.equal(await available(), false);
    await capture("approval-question.png");
    check("A running review and an open question both hide approval; the mouse opens the question in its dialogue");

    const file = { name: "export-format.txt", text: "CSV in the exports directory." };
    const answer = send(pending.id, initialFormat, file);
    await until(() => Boolean(releaseClarification), "provider reading owner's answer");
    const answering = show(pending.id);
    assert.equal(answering.awaitingAnswer, true);
    assert.equal(answering.attachments.at(-1).name, file.name);
    assert.deepEqual(calls.at(-1).documents, [file.text]);
    cli(["approve", pending.id], { revision: show(pending.id).revision }, project, "TASK_AWAITING_ANSWER");
    assert.equal(await available(), false);
    releaseClarification();
    const reply = await answer;
    assert.equal(reply.result.ok, true, JSON.stringify(reply));
    await until(available, "approval after clarification");
    assert.equal(show(pending.id).status, "draft");
    assert.equal(show(pending.id).awaitingAnswer, false);
    check("An answer with an attachment preserves the open question and blocks approval until the agent confirms it in the same card");

    const beginFormatUpdate = async (id, request, steering) => {
      await waitWriter(id, "writer released before changing the format");
      const originalCalls = calls.length;
      const reply = send(id, request);
      await until(() => formatUpdate?.request === request, "provider receives " + request);
      await until(async () => !(await available()), "new text hides approval");
      assert.notEqual(show(id).awaitingAnswer, false);
      cli(["approve", id], { revision: show(id).revision }, project, "DRAFT_DISCUSSION_REQUIRED");
      const steeringReply = send(id, steering);
      await until(() => formatUpdate.steered.length > 0, "second message reaches the active provider");
      assert.deepEqual(formatUpdate.steered, [steering]);
      assert.equal(calls.length, originalCalls + 1, "Steering belongs to the active provider turn");
      assert.equal(await available(), false);
      return { reply, steeringReply, update: formatUpdate };
    };
    const waitForSteering = async ({ steeringReply }) => {
      const accepted = await steeringReply;
      assert.equal(accepted.saved, true, JSON.stringify(accepted));
      assert.equal(accepted.result.ok, true, JSON.stringify(accepted));
    };
    const applyBrief = async (id, { update }, description) => {
      const before = show(id);
      const result = await update.applyBrief(update.steered.at(-1), description);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.changed, true);
      assert.equal(result.data.revision, before.revision + 1);
      const saved = show(id);
      assert.equal(saved.revision, result.data.revision);
      assert.equal(saved.description, description);
      assert.notEqual(saved.awaitingAnswer, false);
      assert.equal(saved.draftDiscussion?.phase, "queued");
      cli(["approve", id], { revision: saved.revision }, project, "DRAFT_DISCUSSION_REQUIRED");
      return saved;
    };
    const xlsxFilename = "Name the file report.xlsx.";
    const xlsx = await beginFormatUpdate(pending.id, formatChanges[0], xlsxFilename);
    const xlsxBrief = "Выгрузить данные в файл report.xlsx.";
    const callsBeforeUpdate = calls.length;
    const xlsxEdit = await applyBrief(pending.id, xlsx, xlsxBrief);
    const xlsxConfirmation = "Подтверждаю выгрузку XLSX в report.xlsx.";
    xlsx.update.completion.resolve(xlsxConfirmation);
    await xlsx.update.returned.promise;
    const completedBeforeSteering = await Promise.race([xlsx.reply.then(() => true), delay(300, false)]);
    assert.equal(completedBeforeSteering, false, "The completed provider answer waits for steering acceptance");
    assert.notEqual(show(pending.id).awaitingAnswer, false);
    xlsx.update.steeringGate.resolve();
    await waitForSteering(xlsx);
    const confirmed = await xlsx.reply;
    assert.equal(confirmed.result.ok, true, JSON.stringify(confirmed));
    await until(available, "valid steered reply restores approval");
    const confirmedCard = show(pending.id);
    assert.equal(confirmedCard.revision, xlsxEdit.revision + 1);
    assert.equal(confirmedCard.description, xlsxBrief);
    assert.equal(confirmedCard.awaitingAnswer, false);
    assert.equal(confirmedCard.draftDiscussion, undefined);
    assert.equal(calls.length, callsBeforeUpdate, "The agent edit needs no extra automatic review");
    assert.deepEqual(messages(confirmedCard).slice(-3).map(event => event.text),
      [formatChanges[0], xlsxFilename, xlsxConfirmation]);
    check("An authorized XLSX edit advances the draft revision and blocks approval until the same turn confirms it after steering, without an extra review");

    const failure = create("Provider inactive");
    await until(() => show(failure.id).draftDiscussion?.phase === "failed", "provider failure");
    await waitWriter(failure.id, "failed discussion writer released");
    await display(failure.id);
    await showStatus("draft_discussion.failed", { reason: "Fixture provider unavailable" });
    assert.equal(await available(), false);
    cli(["approve", failure.id], { revision: show(failure.id).revision }, project, "DRAFT_DISCUSSION_REQUIRED");
    failProvider = false;
    const failedRevision = show(failure.id).revision;
    await activate(localization.text("draft_discussion.retry", {}, "ru"), "mouse");
    await until(() => show(failure.id).revision > failedRevision, "draft retry reaches the board");
    await waitReady(failure.id);
    await until(available, "approval enabled after retry");
    check("Provider failure blocks approval; retry from the dialogue restores it after a successful review");

    await evaluate("window.taskboard.menuAction('new-window')");
    const other = BrowserWindow.getAllWindows().find(candidate => candidate.id !== window.id);
    assert.ok(other);
    const evaluateOther = code => other.webContents.executeJavaScript(code);
    await until(() => evaluateOther("Boolean(window.taskboard)"), "second renderer");
    await open(project, evaluateOther);
    await evaluateOther(`showTask(${JSON.stringify(failure.id)})`);
    await until(() => available(evaluateOther), "second window sees the approved brief");
    const previous = show(failure.id);
    heldDrafts.add(previous.title);
    cli(["update", failure.id], { description: "Сохранять выгрузку в каталоге архива.", revision: previous.revision });
    await until(() => draftGates.has(failure.id), "new review after substantive edit");
    const stale = await evaluateOther(`window.taskboard.command("approve", ${JSON.stringify(failure.id)},
      { revision: ${previous.revision} })`);
    assert.equal(stale.error?.code, "REVISION_CONFLICT", JSON.stringify(stale));
    assert.equal(show(failure.id).status, "draft");
    await until(async () => !(await available(evaluateOther)), "second window hides the stale approval");
    continueDraft(previous);
    await waitReady(failure.id, 2);
    await until(() => available(evaluateOther), "same edited card ready after a fresh review");
    check("A substantive edit blocks an older window's approval and requires a fresh review");

    await display(pending.id);
    await until(available, "confirmed XLSX draft is visible");
    const json = await beginFormatUpdate(pending.id, formatChanges[1], "Name the file report.json.");
    await waitForSteering(json);
    const jsonEdit = await applyBrief(pending.id, json, "Выгрузить данные в файл report.json.");
    const outdatedText = "Устаревшее подтверждение JSON.";
    heldDrafts.add(pending.title);
    const externalEdit = cli(["update", pending.id], { description: revisedBrief, revision: jsonEdit.revision });
    assert.equal(externalEdit.revision, jsonEdit.revision + 1);
    json.update.completion.resolve(outdatedText);
    const outdated = await json.reply;
    assert.equal(outdated.result.error?.code, "REVISION_CONFLICT", JSON.stringify(outdated));
    await until(() => draftGates.has(pending.id), "fresh review after the external edit");
    assert.notEqual(show(pending.id).awaitingAnswer, false);
    assert.equal(messages(show(pending.id)).some(event => event.text === outdatedText), false);
    assert.equal(calls.at(-1).context.task.description, revisedBrief);
    cli(["approve", pending.id], { revision: show(pending.id).revision }, project, "DRAFT_DISCUSSION_REQUIRED");
    assert.equal(await available(), false);
    continueDraft(pending);
    await until(() => show(pending.id).awaitingAnswer === false, "fresh draft confirmation");
    await until(available, "approval after fresh review of the external edit");
    assert.equal(messages(show(pending.id)).at(-1).text, readyText);
    check("An external CLI edit after the same turn successfully updated the draft rejects the stale reply by revision and requires fresh confirmation");

    const returning = create(returnedTitle, "Экспортировать отчёт в архив.");
    await waitReady(returning.id);
    await waitWriter(returning.id, "initial review completed before approval");
    const approved = cli(["approve", returning.id], { revision: show(returning.id).revision });
    assert.equal(approved.status, "ready");
    const question = await send(returning.id, requestArchive);
    assert.equal(question.result.ok, true, JSON.stringify(question));
    const withQuestion = show(returning.id);
    assert.equal(withQuestion.awaitingAnswer, true);
    assert.equal(messages(withQuestion).at(-1).text, archiveQuestion);
    const editedBrief = "Экспортировать отчёт о сверке в архив.";
    const edited = cli(["update", returning.id], {
      actor: "user", note: "Уточнить состав отчёта", description: editedBrief, revision: withQuestion.revision,
    });
    assert.equal(edited.status, "ready");
    assert.equal(edited.awaitingAnswer, true);
    const closedQuestion = await send(returning.id, archiveAnswer);
    assert.equal(closedQuestion.result.ok, true, JSON.stringify(closedQuestion));
    const clarified = show(returning.id);
    assert.equal(clarified.status, "ready");
    assert.equal(clarified.awaitingAnswer, false);
    assert.equal(messages(clarified).at(-1).text, archiveConfirmed);
    await waitWriter(returning.id, "ordinary dialogue completed before return");
    heldDrafts.add(returning.title);
    const returned = cli(["return-to-draft", returning.id], { revision: clarified.revision });
    assert.equal(returned.status, "draft");
    assert.equal(returned.description, editedBrief);
    assert.equal(returned.awaitingAnswer, undefined);
    assert.equal(messages(returned).at(-1).text, archiveConfirmed);
    cli(["approve", returning.id], { revision: show(returning.id).revision }, project, "DRAFT_DISCUSSION_REQUIRED");
    await display(returning.id);
    assert.equal(await available(), false);
    const startLabel = localization.text("draft_discussion.start", {}, "ru");
    await until(() => evaluate(`Boolean(${button(startLabel)})`), "review action for returned draft");
    assert.equal(calls.filter(call => call.context.task.id === returning.id).length, 3);
    await activate(startLabel, "mouse");
    await until(() => draftGates.has(returning.id), "new review after returning the changed ready card to draft");
    assert.equal(calls.at(-1).context.task.description, editedBrief);
    continueDraft(returning);
    await until(() => show(returning.id).awaitingAnswer === false, "confirmation of the returned draft");
    await until(available, "approval of the returned draft after review");
    check("An ordinary ready-card reply closes the question, and returning the changed card to draft still requires a new review before approval");

    report.approvalDraft = pending.id;
    report.approvalMessages = messages(show(pending.id));
  };
  if (approvalOnly) {
    await verifyApproval();
  } else if (live) {
    const catalog = await evaluate("window.taskboard.chatModels()");
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    const model = catalog.data.find(entry => entry.default) ?? catalog.data[0];
    assert.ok(model?.id && model.effort);
    const execution = { model: model.id, effort: model.effort };
    const instructions = join(project, "AGENTS.md");
    const schedule = join(project, "pilot-schedule.txt");
    writeFileSync(instructions, "For the access-review pilot, the only variables in the handoff are the delivery time and the recipient email alias. Use pilot-schedule.txt if attached. The owner chooses the email alias. The deliverable is one sentence, with no tooling or implementation work.");
    writeFileSync(schedule, "The access-review pilot sends the handoff on Tuesdays at 09:40 UTC.");
    const brief = { title: "Document a weekly access-review handoff",
      description: "Prepare a one-sentence handoff naming the existing delivery time and the exact recipient email alias. Use the attached schedule and project instructions. Keep the document in English.",
      criteria: ["The handoff names the delivery time and exact recipient email alias."],
      execution, attachmentSources: [{ path: schedule, link: true }] };
    const unresolved = cli(["create"], plannedDraft(brief));
    const waitAgent = async (id, count) => {
      await until(() => {
        const card = show(id);
        assert.notEqual(card.draftDiscussion?.phase, "failed", card.draftDiscussion?.reason);
        return messages(card).filter(event => event.actor === "agent").length === count;
      }, "Codex reply " + id);
      const card = show(id);
      assert.equal(card.status, "draft");
      assert.equal(card.git, undefined);
      return messages(card).at(-1).text;
    };
    const question = await waitAgent(unresolved.id, 1);
    assert.equal(show(unresolved.id).awaitingAnswer, true);
    assert.match(question, /(?:recipient|alias|email)/i);
    assert.equal((question.match(/\?/g) ?? []).length, 1, question);
    assert.doesNotMatch(question, /(?:what|which)\s+(?:day|time|schedule)\b/i);
    await display(unresolved.id);
    await reopen(unresolved.id);
    await capture("draft-with-question.png");
    const answer = "Use audits+north@example.invalid as the recipient.";
    await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(unresolved.id)}))`),
      "released discussion writer before follow-up");
    const followup = await evaluate(`window.taskboard.chatSend(${JSON.stringify(unresolved.id)}, ${JSON.stringify({ ...execution, text: answer, files: [] })})`);
    assert.equal(followup.result.ok, true, JSON.stringify(followup));
    const confirmation = await waitAgent(unresolved.id, 2);
    assert.equal(show(unresolved.id).awaitingAnswer, false);
    assert.equal(messages(show(unresolved.id))[1].text, answer);
    assert.match(confirmation, /ready.*approval/i);
    assert.doesNotMatch(confirmation, /Tuesday|09:40|audits\+north/i);
    assert.doesNotMatch(confirmation, /\?/);
    await reopen(unresolved.id);
    await capture("draft-question-chat.png");
    const complete = cli(["create"], plannedDraft({ ...brief, description: brief.description + " The recipient is audits+north@example.invalid." }));
    await waitReady(complete.id);
    await display(complete.id);
    await reopen(complete.id);
    await readyDialogue();
    await capture("draft-ready-chat.png");
    assert.equal(existsSync(join(project, ".worktrees")), false);
    await until(() => !readdirSync(staging).some(name => name.startsWith("ai-taskboard-chat-")), "Codex staging cleanup");
    const git = args => execFileSync("git", args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true,
    }).trim();
    writeFileSync(join(artifacts, "draft-discussion-live.json"), JSON.stringify({
      head: git(["rev-parse", "HEAD"]), workingTreeChanged: Boolean(git(["status", "--porcelain"])),
      sourceRepresentation: "raw working-file bytes (SHA-256)",
      sourceHashes: Object.fromEntries(["src/desktop/codex-chat.ts", "src/desktop/main.ts", "src/cli/archive.ts",
        "src/cli/model.ts", "src/cli/storage.ts", "src/cli/main.ts", "scripts/check-draft-discussion.mjs"].map(path =>
        [path, createHash("sha256").update(readFileSync(new URL("../" + path, import.meta.url))).digest("hex")])),
      platform: process.platform, electron: process.versions.electron,
      chromium: process.versions.chrome, provider: "Codex App Server", execution,
      fixture: { projectInstructions: readFileSync(instructions, "utf8"), attachedSchedule: readFileSync(schedule, "utf8"),
        draft: brief.description, completeDraft: complete.description },
      observed: { question, answer, confirmation, completeDraftMessages: messages(show(complete.id)).length },
    }, null, 2));
    console.log("PASS Codex asked about the missing recipient, applied the answer and confirmed the clear draft is ready for approval");
  } else if (restart) {
    await until(() => show(report.interrupted).draftDiscussion?.phase === "failed", "interrupted state after restart");
    assert.equal(calls.length, 0);
    await display(report.interrupted);
    await retry(report.interrupted);
    await waitReady(report.interrupted);
    assert.deepEqual(calls.map(call => call.context.task.id), [report.interrupted]);
    await waitReady(report.ui);
    await display(report.ui);
    await readyDialogue();
    assert.deepEqual(messages(show(report.ui)), report.readyMessages);
    await display(report.question);
    assert.match(await evaluate("document.querySelector('.task-dialogue').textContent"), /Which viewport is required\?/);
    assert.equal(messages(show(report.question)).length, 3);
    assert.deepEqual(messages(show(report.question)), report.questionMessages);
    assert.equal(show(report.question).status, "draft");
    assert.equal(show(report.question).git, undefined);
    assert.deepEqual(calls.map(call => call.context.task.id), [report.interrupted]);
    check("Restart retains readiness and question with its answer and original timestamps, and only retries the interrupted draft on request");
    writeFileSync(join(artifacts, "draft-ready-check.txt"), [
      "Windows Electron draft discussion (deterministic provider fixture)",
      "Command: node scripts/check-draft-discussion.mjs --artifacts .tasks/qa/T-0220",
      "Tested HEAD: " + report.head,
      `Platform: ${report.platform}; Electron: ${report.electron}; Chromium: ${report.chromium}; viewport: 1280x800`,
      "Source representation: UTF-8 working text with CRLF normalized to LF (SHA-256)",
      ...Object.entries(report.sourceHashes).map(([path, hash]) => `${hash}  ${path}`),
      "Windows: runtime passed; Linux/macOS: runtime not run. Shared code uses the existing CLI history and writer registry; packaging unchanged.",
      "Provider boundary: deterministic fixture; --live separately exercises installed Codex.",
      ...report.checks.map(line => "PASS " + line), "",
    ].join("\n"));
  } else if (revisionOnly) {
    const { runtimeEntries } = await import("../src/desktop/board-runtime.ts");
    await evaluate("window.taskboard.menuAction('new-window')");
    const other = BrowserWindow.getAllWindows().find(candidate => candidate.id !== window.id);
    assert.ok(other);
    const evaluateOther = code => other.webContents.executeJavaScript(code);
    await until(() => evaluateOther("Boolean(window.taskboard)"), "second renderer");
    await open(project, evaluateOther);
    await verifyRevision(evaluateOther, runtimeEntries);
  } else {
    const { registerRuntime, runtimeEntries } = await import("../src/desktop/board-runtime.ts");
    slot = registerRuntime(project, { kind: "slot", role: "executor", task: "T-9999" });
    assert.ok(slot);
    const missingPlan = await evaluate(`window.taskboard.command("create", undefined, {
      title: "Unplanned desktop draft", description: "Verify the creation guard.", criteria: ["The draft is rejected"]
    })`);
    assert.equal(missingPlan.error?.code, "EXPERT_PLAN_REQUIRED", JSON.stringify(missingPlan));
    check("Desktop creation rejects an agent draft without an expert plan");
    const response = await evaluate(`window.taskboard.command("create", undefined, ${JSON.stringify(plannedDraft({
      title: "Document the screenshot viewport",
      description: "Add one sentence to README.md stating that desktop screenshots use a 1280 × 800 viewport.",
      criteria: ["README.md names the 1280 × 800 desktop screenshot viewport."],
    }))})`);
    assert.equal(response.ok, true, JSON.stringify(response));
    report.ui = response.data.id;
    await waitReady(report.ui);
    await display(report.ui);
    await reopen(report.ui);
    await readyDialogue();
    await capture("draft-ready-chat.png");
    report.readyMessages = messages(show(report.ui));
    assert.deepEqual(calls[0].configured, { model: "gpt-6.1-sol", effort: "medium" });
    check("Desktop creation saves one readiness message with time with the executor pool occupied and retains it after reopening");
    if (creationOnly) {
      await open(manual);
      const personal = await evaluate(`window.taskboard.command("create", undefined, {
        title: "Personal desktop task", actor: "user"
      })`);
      assert.equal(personal.ok, true, JSON.stringify(personal));
      const saved = cli(["show", personal.data.id], undefined, manual);
      assert.equal(saved.expertTeam, undefined);
      assert.equal(saved.draftDiscussion, undefined);
      check("Desktop creation persists a personal task without an expert plan");
      writeFileSync(evidence, JSON.stringify(report, null, 2));
      return;
    }

    const startMessage = (id, text, run = evaluate) => run(`window.taskboard.chatSend(
      ${JSON.stringify(id)}, ${JSON.stringify({ ...settings, text, files: [] })})`);
    const retryMessage = task => evaluate(`window.taskboard.chatSend(${JSON.stringify(task.id)}, ${JSON.stringify({
      ...settings, text: "", files: [], retryAt: task.history.findLastIndex(event => event.chat),
    })})`);
    const say = async (id, text, run) => {
      const reply = await startMessage(id, text, run);
      assert.equal(reply.result.ok, true, JSON.stringify(reply));
    };
    // Leave a new draft with no chat history, ready for a user's first message.
    const ordinary = cli(["create"], plannedDraft({ title: "Provider inactive", execution: settings }));
    await until(() => show(ordinary.id).draftDiscussion?.phase === "failed", "new draft before ordinary chat");
    await until(() => !runtimeEntries(project).some(entry => entry.task === ordinary.id), "initial writer released");
    await say(ordinary.id, "First message");
    await say(ordinary.id, "Follow-up");
    assert.deepEqual(messages(show(ordinary.id)).map(event => event.actor), ["user", "agent", "user", "agent"]);
    assert.equal(runtimeEntries(project).filter(entry => entry.kind === "slot").length, 1);
    assert.equal(show(ordinary.id).status, "draft");
    check("First message and follow-up get one reply each with the executor pool occupied");

    await display(ordinary.id);
    await evaluate(`{
      const input = document.querySelector("#task-chat-input");
      input.value = "Fail once";
      input.dispatchEvent(new Event("input"));
      input.form.requestSubmit();
    }`);
    await until(() => evaluate(`document.querySelector(".chat-retry-reply")?.disabled === false &&
      document.querySelector(".chat-status:not([hidden])")?.textContent === "Fixture provider unavailable"`), "saved-message retry");
    const unanswered = show(ordinary.id);
    assert.equal(messages(unanswered).at(-1).text, "Fail once");
    await capture("task-chat-retry.png");
    const pendingFile = join(project, ".tasks", "pending", ordinary.id + ".json");
    const callsBeforePending = calls.length;
    writeFileSync(pendingFile, JSON.stringify({ action: "start", revision: unanswered.revision }));
    try {
      assert.equal((await startMessage(ordinary.id, "New while pending")).result.error?.code, "PENDING_OPERATION");
      assert.equal((await retryMessage(unanswered)).result.error?.code, "PENDING_OPERATION");
      assert.equal(calls.length, callsBeforePending);
      assert.deepEqual(show(ordinary.id), unanswered);
      assert.equal(runtimeEntries(project).some(entry => entry.task === ordinary.id), false);
    } finally { unlinkSync(pendingFile); }
    check("A pending Git operation blocks both send and retry before a provider call");
    try {
      await until(async () => {
        if (messages(show(ordinary.id)).length === 6) return true;
        await evaluate("document.querySelector('.chat-retry-reply:not([hidden]):enabled')?.click()");
        return false;
      }, "visible retry of the saved message");
    } catch (error) {
      throw new Error(error.message + ": " + await evaluate(
        "document.querySelector('.chat-status:not([hidden])')?.textContent"));
    }
    assert.deepEqual(messages(show(ordinary.id)).slice(-2).map(event => [event.actor, event.text]),
      [["user", "Fail once"], ["agent", "User answer recorded: Fail once"]]);
    await until(() => !runtimeEntries(project).some(entry => entry.task === ordinary.id), "writer released after retry");
    check("The visible retry answers the saved message without appending it again");

    await evaluate("window.taskboard.menuAction('new-window')");
    const other = BrowserWindow.getAllWindows().find(candidate => candidate.id !== window.id);
    assert.ok(other);
    const evaluateOther = code => other.webContents.executeJavaScript(code);
    await until(() => evaluateOther("Boolean(window.taskboard)"), "second renderer");
    await open(project, evaluateOther);
    const pending = startMessage(ordinary.id, "Wait for stop");
    await until(() => stopGate, "ordinary provider is running");
    const beforeConflict = show(ordinary.id);
    const conflict = await startMessage(ordinary.id, "Competing message", evaluateOther);
    assert.equal(conflict.saved, false);
    assert.equal(conflict.result.error.code, "CHAT_BUSY");
    assert.equal(runtimeEntries(project).filter(entry => entry.kind === "task" && entry.task === ordinary.id).length, 1);
    assert.deepEqual(show(ordinary.id), beforeConflict);
    assert.equal((await evaluate(`window.taskboard.chatStop(${JSON.stringify(ordinary.id)})`)).ok, true);
    assert.equal((await pending).result.ok, true);
    assert.equal(messages(show(ordinary.id)).length, 7);
    await say(ordinary.id, "Competing message", evaluateOther);
    assert.deepEqual(messages(show(ordinary.id)).slice(-3).map(event => event.text),
      ["Wait for stop", "Competing message", "User answer recorded: Competing message"]);
    assert.equal(show(ordinary.id).status, "draft");
    assert.equal(show(ordinary.id).git, undefined);
    assert.equal(runtimeEntries(project).some(entry => entry.task === ordinary.id), false);
    check("The second window is rejected while one writer is active and can send after stopping it");

    cli(["chat", ordinary.id], { ...settings, text: "Unanswered before archive" });
    cli(["cancel", ordinary.id], { reason: "Archive fixture" });
    cli(["settings"], { archiveAfterDays: 0 });
    assert.ok(cli(["archive", "sweep"]).archived.includes(ordinary.id));
    await until(() => evaluate(`window.taskboard.bootstrap().then(f =>
      f.board.archived.some(card => card.id === ${JSON.stringify(ordinary.id)}))`), "archived card on desktop");
    await display(ordinary.id);
    await until(() => evaluate(`document.querySelector(".task-chat")?.textContent.includes("Unanswered before archive") &&
      document.querySelector(".chat-retry-reply")?.hidden`), "archived message without retry control");
    const archived = show(ordinary.id);
    const callsBeforeArchive = calls.length;
    assert.equal((await startMessage(ordinary.id, "New in archive")).result.error?.code, "TASK_NOT_FOUND");
    assert.equal((await retryMessage(archived)).result.error?.code, "TASK_NOT_FOUND");
    assert.equal(calls.length, callsBeforeArchive);
    assert.deepEqual(show(ordinary.id), archived);
    assert.equal(runtimeEntries(project).some(entry => entry.task === ordinary.id), false);
    check("Archived chat stays readable, hides retry, and rejects direct send and retry before the provider");

    const { boardActions } = await import("../src/desktop/board-actions.ts");
    const never = () => assert.fail("Unrelated manager action");
    const manager = boardActions(project, [], [], new AbortController().signal, never, () => undefined,
      () => false, never, never, undefined, never);
    const created = await manager("task_create", plannedDraft({ title: "Created by manager", tags: ["Draft discussion"] }));
    assert.equal(created.ok, true, JSON.stringify(created));
    await waitReady(created.data.id);
    await evaluateOther(`showTask(${JSON.stringify(created.data.id)})`);
    await until(() => evaluateOther("document.querySelector('.task-dialogue')?.querySelectorAll('.chat-entry').length === 1"),
      "second window readiness");
    assert.equal(calls.filter(call => call.context.task.id === created.data.id).length, 1);
    check("Manager creation reviews the draft once and the second window shows one readiness message");

    const original = join(scratch, "file.txt"), linked = join(scratch, "linked.txt"), changed = join(scratch, "changed.txt");
    const image = join(scratch, "image.png");
    writeFileSync(original, "copied contents"); writeFileSync(linked, "linked contents"); writeFileSync(changed, "old");
    const imageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=";
    writeFileSync(image, Buffer.from(imageBytes, "base64"));
    mutableSources = [linked, image];
    const before = calls.length;
    const draft = cli(["create"], plannedDraft({ title: "CLI with attachments",
      description: "Capture the desktop board at the viewport selected by the owner.",
      criteria: ["The capture uses the owner's viewport."], dependencies: [created.data.id], execution: settings,
      attachmentSources: [{ path: original, name: "same.txt" }, { path: linked, name: "same.txt", link: true },
        { path: changed, link: true }, { path: image }, { path: image, link: true }] }));
    writeFileSync(changed, "changed contents of different length");
    await waitReply(draft.id);
    report.question = draft.id;
    const input = calls[before];
    assert.equal(input.mode, "initial");
    assert.deepEqual(input.configured, settings);
    assert.deepEqual(input.documents, ["copied contents", "linked contents"]);
    assert.deepEqual(input.images, [imageBytes, imageBytes]);
    assert.ok(input.context.attachments.filter(file => file.linked).every(file => !mutableSources.includes(file.path) && !file.link));
    assert.equal(new Set(input.context.attachments.map(file => file.id)).size, 5);
    assert.equal(input.context.attachments.filter(file => file.error).length, 1);
    assert.equal(input.context.attachments.find(file => file.error).name, "changed.txt");
    assert.equal(input.context.dependencyContext[0].title, "Created by manager");
    await display(draft.id);
    await reopen(draft.id);
    await until(() => evaluate("document.querySelector('.task-chat').textContent.includes('Which viewport is required?')"), "persisted question");
    await capture("draft-with-question.png");
    const answer = await evaluate(`window.taskboard.chatSend(${JSON.stringify(draft.id)}, {
      model: "fixture-sol", effort: "high", text: "1280 pixels", files: []
    })`);
    assert.equal(answer.result.ok, true, JSON.stringify(answer));
    assert.deepEqual(messages(show(draft.id)).map(event => event.text),
      ["Which viewport is required?", "1280 pixels", readyText]);
    assert.equal(show(draft.id).awaitingAnswer, false);
    assert.equal(calls.at(-1).context.history.some(event => event.text === "Which viewport is required?"), true);
    assert.deepEqual(calls.at(-1).context.attachments.filter(file => file.error).map(file => file.name),
      ["same.txt", "changed.txt", "image.png"]);
    await until(() => evaluate(`document.querySelector('.task-chat')?.textContent.includes(${JSON.stringify(readyText)})`), "visible follow-up");
    await reopen(draft.id);
    await capture("draft-question-chat.png");
    report.questionMessages = messages(show(draft.id));
    check("CLI passes distinct same-name files and stable linked text/image snapshots despite edits at the provider boundary; the next turn reports changed sources");

    const partial = cli(["create"], plannedDraft({ title: "Partial answer", execution: settings }));
    await waitReply(partial.id);
    await until(() => !runtimeEntries(project).some(entry => entry.task === partial.id), "partial draft writer released");
    assert.equal(show(partial.id).awaitingAnswer, true);
    await say(partial.id, "CSV");
    assert.equal(show(partial.id).awaitingAnswer, true);
    assert.equal(messages(show(partial.id)).at(-1).text, "Which destination is required?");
    const failedClarification = await startMessage(partial.id, "Fail clarification");
    assert.equal(failedClarification.result.error.code, "CHAT_FAILED");
    assert.equal(show(partial.id).awaitingAnswer, true);
    assert.equal(messages(show(partial.id)).some(event => event.text === readyText), false);
    await say(partial.id, "Save it in exports.");
    assert.equal(show(partial.id).awaitingAnswer, false);
    assert.equal(messages(show(partial.id)).at(-1).text, readyText);
    assert.equal(show(partial.id).status, "draft");
    check("Partial answers and failed clarification keep the question open without readiness; sufficient clarification confirms readiness");

    await verifyRevision(evaluateOther, runtimeEntries);

    const busy = cli(["create"], plannedDraft({ title: "Writer occupied", execution: settings }));
    writer = registerRuntime(project, { kind: "task", task: busy.id });
    assert.ok(writer);
    await delay(2000);
    assert.equal(show(busy.id).draftDiscussion?.phase, "queued");
    writer(); writer = undefined;
    await waitReady(busy.id);
    check("The shared writer keeps a draft queued until released");
    const count = calls.length;
    cli(["create"], plannedDraft({ title: "Invalid creation", attachmentSources: [{ path: join(scratch, "missing") }] }), project, "IO_ERROR");
    await open(manual);
    const personal = cli(["create"], { title: "Personal card" }, manual);
    await delay(1600);
    assert.equal(personal.draftDiscussion, undefined);
    assert.equal(calls.length, count);
    assert.equal(existsSync(join(project, ".worktrees")), false);
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "Use the project fixture.");
    check("Failed create and personal board schedule no review, and project/worktree contents stay untouched");

    await until(() => !readdirSync(staging).some(name => name.startsWith("ai-taskboard-chat-")), "staging cleanup");
    const interrupted = cli(["create"], plannedDraft({ title: "Interrupted draft", execution: settings }));
    writer = registerRuntime(project, { kind: "task", task: interrupted.id });
    assert.ok(writer);
    cli(["draft-discussion", interrupted.id], { revision: interrupted.revision, phase: "running" });
    assert.equal(messages(show(interrupted.id)).length, 0);
    report.interrupted = interrupted.id;
    check("Transient chat staging is cleaned");
  }
  if (!live && !(approvalOnly && restart)) {
    const paths = ["src/desktop/main.ts", "src/desktop/codex-chat.ts", "src/desktop/chat-actions.ts", "src/cli/archive.ts", "src/cli/main.ts",
      "src/cli/model.ts", "src/cli/storage.ts", "src/cli/tasks.ts", "src/desktop/renderer.js", "src/desktop/chat.js",
      "src/desktop/locales/ru.json", "src/desktop/preload.cjs", "scripts/check-draft-discussion.mjs",
      "scripts/electron-check.mjs", "tests/fixtures/planned-draft.ts"];
    report.sourceHashes = Object.fromEntries(paths.map(path => {
      const source = readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      return [path, createHash("sha256").update(source).digest("hex")];
    }));
    report.head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true,
    }).trim();
    writeFileSync(evidence, JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // The interrupted fixture intentionally has no surviving writer after process exit.
  if (process.exitCode) writer?.();
  slot?.();
  if (live && !process.exitCode) app.quit();
  else {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(process.exitCode ?? 0);
  }
}
})();
