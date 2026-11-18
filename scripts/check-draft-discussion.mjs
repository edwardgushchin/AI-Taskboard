import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Real Electron, CLI and renderer. Pass --live to exercise the installed Codex provider.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const live = process.argv.includes("--live");
const creationOnly = process.argv.includes("--creation-only");
const { scratch, artifacts } = electronCheck(import.meta.url, "draft-discussion", live ? 240000 : 150000,
  live || creationOnly ? [[]] : [["--first-pass"], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const restart = process.argv.includes("--restart");
const project = join(scratch, "board");
const manual = join(scratch, "personal");
const profile = join(scratch, "profile");
const evidence = join(artifacts, "draft-discussion.json");
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const cli = (args, input, root = project, error) => {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning", cliPath,
    "--project", root, "--json", ...args, ...(input === undefined ? [] : ["--stdin"])],
  { cwd: scratch, encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input) });
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
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();

let selection = project;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selection] });
const calls = [];
let mutableSources = [];
let failProvider = true;
let staleGate;
let stopGate;
let failMessage = true;
globalThis.draftFixtureReply = async (_profile, cwd, configured, prompt, images, _commentary, _action, _scratch,
  _limit, _usage, onControl, _signal, id, _activity, mode) => {
  const context = JSON.parse(prompt);
  assert.equal(cwd, project);
  assert.equal(context.task.id, id);
  assert.equal(context.task.status, "draft");
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Use the project fixture.");
  if (mode === "initial" && context.task.title === "CLI with attachments") {
    // Change the originals after CLI staging, at the provider boundary.
    for (const path of mutableSources) writeFileSync(path, "Changed after staging");
  }
  calls.push({ context, configured, mode, images: images.map(path => readFileSync(path).toString("base64")),
    documents: context.attachments.filter(file => file.path && file.name.endsWith(".txt")).map(file => readFileSync(file.path, "utf8")) });
  const interrupted = Promise.withResolvers();
  onControl({ interrupt: async () => interrupted.resolve({ interrupted: true }),
    steer: async () => assert.fail("Unexpected steering request.") });
  if (context.latestUserMessage?.text === "Fail once" && failMessage) {
    failMessage = false;
    throw Error("Fixture provider unavailable");
  }
  if (context.latestUserMessage?.text === "Wait for stop") {
    stopGate = true;
    return interrupted.promise;
  }
  if (mode === "initial" && context.task.title === "Provider inactive" && failProvider) throw Error("Fixture provider unavailable");
  if (context.task.title === "Stale draft") await new Promise(resolve => { staleGate = resolve; });
  await delay(450);
  return { text: context.latestUserMessage ? "User answer recorded: " + context.latestUserMessage.text :
    context.task.title === "CLI with attachments" ? "Which viewport is required?" : "The draft has enough information." };
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
      "globalThis.draftFixtureReply(profile, project, settings, prompt, images, onCommentary, runAction, imageDirectory, imageLimit, onTokenUsage, onControl, signal, taskId, onActivity, mode)")));
    source = source.replace(chatUrl.href, pathToFileURL(chatEntry).href);
  }
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, compile(source));
  process.on("unhandledRejection", error => { console.error(error); app.exit(1); });
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  await until(() => BrowserWindow.getAllWindows().length > 0, "window");
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = code => window.webContents.executeJavaScript(code);
  await until(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
  const open = async (path, run = evaluate) => {
    selection = path;
    await run("window.taskboard.menuAction('open-project')");
    await until(() => run(`window.taskboard.bootstrap().then(f => !f.loading && f.board?.project === ${JSON.stringify(path)})`), "open board");
  };
  if (!(await evaluate(`window.taskboard.bootstrap().then(f => f.board?.project === ${JSON.stringify(project)})`))) await open(project);
  const display = id => evaluate(`showTask(${JSON.stringify(id)})`);
  const retry = () => evaluate("document.querySelector('.task-chat .chat-status button').click()");
  const waitReply = (id, count = 1) => until(() => messages(show(id)).length === count, "chat reply " + id);
  const capture = async name => {
    window.focus();
    await evaluate("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  if (live) {
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
    assert.match(question, /(?:recipient|alias|email)/i);
    assert.equal((question.match(/\?/g) ?? []).length, 1, question);
    assert.doesNotMatch(question, /(?:what|which)\s+(?:day|time|schedule)\b/i);
    const answer = "Use audits+north@example.invalid as the recipient. Please confirm the delivery time and recipient.";
    await until(() => evaluate(`window.taskboard.bootstrap().then(f => !f.replyingTasks?.includes(${JSON.stringify(unresolved.id)}))`),
      "released discussion writer before follow-up");
    const followup = await evaluate(`window.taskboard.chatSend(${JSON.stringify(unresolved.id)}, ${JSON.stringify({ ...execution, text: answer, files: [] })})`);
    assert.equal(followup.result.ok, true, JSON.stringify(followup));
    const confirmation = await waitAgent(unresolved.id, 2);
    assert.equal(messages(show(unresolved.id))[1].text, answer);
    assert.match(confirmation, /Tuesday/i);
    assert.match(confirmation, /09:40\s*UTC/i);
    assert.match(confirmation, /audits\+north@example\.invalid/i);
    assert.doesNotMatch(confirmation, /\?/);
    const complete = cli(["create"], plannedDraft({ ...brief, description: brief.description + " The recipient is audits+north@example.invalid." }));
    const completion = await waitAgent(complete.id, 1);
    assert.doesNotMatch(completion, /\?/);
    assert.match(completion, /(?:enough|sufficien|complete|everything (?:needed|in place)|no (?:\w+ )*(?:questions?|clarifications?)|ready|clear)/i);
    assert.equal(existsSync(join(project, ".worktrees")), false);
    await until(() => !readdirSync(staging).some(name => name.startsWith("ai-taskboard-chat-")), "Codex staging cleanup");
    const git = args => execFileSync("git", args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true,
    }).trim();
    assert.equal(git(["status", "--porcelain"]), "", "Run the live scenario from the committed revision.");
    writeFileSync(join(artifacts, "draft-discussion-live.json"), JSON.stringify({
      commit: git(["rev-parse", "HEAD"]), platform: process.platform, electron: process.versions.electron,
      chromium: process.versions.chrome, provider: "Codex App Server", execution,
      fixture: { projectInstructions: readFileSync(instructions, "utf8"), attachedSchedule: readFileSync(schedule, "utf8"),
        draft: brief.description, completeDraft: complete.description },
      observed: { question, answer, confirmation, completion },
    }, null, 2));
    console.log("PASS Codex asked about the missing recipient, applied the answer and confirmed the independently complete draft");
  } else if (restart) {
    await until(() => show(report.interrupted).draftDiscussion?.phase === "failed", "interrupted state after restart");
    assert.equal(calls.length, 0);
    await display(report.interrupted);
    await retry();
    await waitReply(report.interrupted);
    assert.deepEqual(calls.map(call => call.context.task.id), [report.interrupted]);
    assert.equal(messages(show(report.ui)).length, 1);
    check("A fresh Electron process exposes a retry for an orphaned turn and keeps existing replies single");
  } else {
    const { registerRuntime, runtimeEntries } = await import("../src/desktop/board-runtime.ts");
    slot = registerRuntime(project, { kind: "slot", role: "executor", task: "T-9999" });
    assert.ok(slot);
    const missingPlan = await evaluate(`window.taskboard.command("create", undefined, {
      title: "Unplanned desktop draft", description: "Verify the creation guard.", criteria: ["The draft is rejected"]
    })`);
    assert.equal(missingPlan.error?.code, "EXPERT_PLAN_REQUIRED", JSON.stringify(missingPlan));
    check("Desktop creation rejects an agent draft without an expert plan");
    const response = await evaluate(`window.taskboard.command("create", undefined, ${JSON.stringify(plannedDraft({ title: "Created in desktop" }))})`);
    assert.equal(response.ok, true, JSON.stringify(response));
    report.ui = response.data.id;
    await waitReply(report.ui);
    assert.equal(show(report.ui).status, "draft");
    assert.equal(messages(show(report.ui))[0].actor, "agent");
    assert.deepEqual(calls[0].configured, { model: "gpt-6.1-sol", effort: "medium" });
    check("Desktop creation starts in the background with the executor pool occupied and uses board settings");
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
    await evaluate("document.querySelector('.chat-retry-reply').click()");
    await waitReply(ordinary.id, 6);
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
    const created = await manager("task_create", { title: "Created by manager", description: "Complete draft", criteria: ["Observable result"] });
    assert.equal(created.ok, true, JSON.stringify(created));
    await waitReply(created.data.id);
    assert.equal(messages(show(created.data.id))[0].text, "The draft has enough information.");
    await evaluateOther(`showTask(${JSON.stringify(created.data.id)})`);
    await until(() => evaluateOther("document.querySelector('.task-chat')?.textContent.includes('The draft has enough information.')"), "second window receives reply");
    assert.equal(calls.filter(call => call.context.task.id === created.data.id).length, 1);
    check("Manager tool starts one reply for its saved draft and the second window receives it without a duplicate");

    const original = join(scratch, "file.txt"), linked = join(scratch, "linked.txt"), changed = join(scratch, "changed.txt");
    const image = join(scratch, "image.png");
    writeFileSync(original, "copied contents"); writeFileSync(linked, "linked contents"); writeFileSync(changed, "old");
    const imageBytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=";
    writeFileSync(image, Buffer.from(imageBytes, "base64"));
    mutableSources = [linked, image];
    const before = calls.length;
    const draft = cli(["create"], plannedDraft({ title: "CLI with attachments", dependencies: [created.data.id], execution: settings,
      attachmentSources: [{ path: original, name: "same.txt" }, { path: linked, name: "same.txt", link: true },
        { path: changed, link: true }, { path: image }, { path: image, link: true }] }));
    writeFileSync(changed, "changed contents of different length");
    await waitReply(draft.id);
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
    await until(() => evaluate("document.querySelector('.task-chat').textContent.includes('Which viewport is required?')"), "persisted question");
    const answer = await evaluate(`window.taskboard.chatSend(${JSON.stringify(draft.id)}, {
      model: "fixture-sol", effort: "high", text: "1280 pixels", files: []
    })`);
    assert.equal(answer.result.ok, true, JSON.stringify(answer));
    assert.deepEqual(messages(show(draft.id)).map(event => event.text),
      ["Which viewport is required?", "1280 pixels", "User answer recorded: 1280 pixels"]);
    assert.equal(calls.at(-1).context.history.some(event => event.text === "Which viewport is required?"), true);
    assert.deepEqual(calls.at(-1).context.attachments.filter(file => file.error).map(file => file.name),
      ["same.txt", "changed.txt", "image.png"]);
    await until(() => evaluate("document.querySelector('.task-chat')?.textContent.includes('User answer recorded: 1280 pixels')"), "visible follow-up");
    await capture("draft-discussion-reply.png");
    check("CLI passes distinct same-name files and stable linked text/image snapshots despite edits at the provider boundary; the next turn reports changed sources");

    const failure = cli(["create"], plannedDraft({ title: "Provider inactive", execution: settings }));
    await until(() => show(failure.id).draftDiscussion?.phase === "failed", "provider failure");
    await display(failure.id);
    await until(() => evaluate("document.querySelector('.task-chat').textContent.includes('Fixture provider unavailable')"), "visible failure");
    await capture("draft-discussion-error.png");
    failProvider = false;
    await retry();
    await waitReply(failure.id);
    check("Provider failure is persistent and the visible retry saves a single reply");

    const stale = cli(["create"], plannedDraft({ title: "Stale draft", execution: settings }));
    await until(() => staleGate, "in-flight response");
    cli(["update", stale.id], { title: "Fresh draft", revision: show(stale.id).revision });
    staleGate();
    await until(() => show(stale.id).draftDiscussion?.phase === "failed", "stale result rejected");
    assert.equal(show(stale.id).title, "Fresh draft");
    assert.equal(messages(show(stale.id)).length, 0);
    check("Editing during the turn prevents a stale reply");

    const busy = cli(["create"], plannedDraft({ title: "Writer occupied", execution: settings }));
    writer = registerRuntime(project, { kind: "task", task: busy.id });
    assert.ok(writer);
    await delay(2000);
    assert.equal(show(busy.id).draftDiscussion?.phase, "queued");
    writer(); writer = undefined;
    await waitReply(busy.id);
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
    report.interrupted = interrupted.id;
    check("Transient chat staging is cleaned");
  }
  if (!live) writeFileSync(evidence, JSON.stringify(report, null, 2));
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
