// Real Electron, CLI and renderer with a deterministic task-chat provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "draft-discussion", 90000,
  [["--first-pass"], ["--restart"]]);
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
  const deadline = Date.now() + 20000;
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
let failProvider = true;
let staleGate;
globalThis.draftFixtureReply = async (_profile, cwd, configured, prompt, images, _commentary, _action, _scratch,
  _limit, _usage, onControl, _signal, id, _activity, mode) => {
  const context = JSON.parse(prompt);
  assert.equal(cwd, project);
  assert.equal(context.task.id, id);
  assert.equal(context.task.status, "draft");
  assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "Use the project fixture.");
  calls.push({ context, configured, mode, images: images.length,
    documents: context.attachments.filter(file => file.path && file.name.endsWith(".txt")).map(file => readFileSync(file.path, "utf8")) });
  onControl({ interrupt: async () => {}, steer: async () => assert.fail("An automatic review must own its turn.") });
  if (context.task.title === "Provider inactive" && failProvider) throw Error("Fixture provider unavailable");
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
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href))
    .replace("writer.run(() => replyToTask(", "writer.run(() => globalThis.draftFixtureReply(");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code);
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
  if (restart) {
    await until(() => show(report.interrupted).draftDiscussion?.phase === "failed", "interrupted state after restart");
    assert.equal(calls.length, 0);
    await display(report.interrupted);
    await retry();
    await waitReply(report.interrupted);
    assert.deepEqual(calls.map(call => call.context.task.id), [report.interrupted]);
    assert.equal(messages(show(report.ui)).length, 1);
    check("A fresh Electron process exposes a retry for an orphaned turn and keeps existing replies single");
  } else {
    const { registerRuntime } = await import("../src/desktop/board-runtime.ts");
    slot = registerRuntime(project, { kind: "slot", role: "executor", task: "T-9999" });
    assert.ok(slot);
    const response = await evaluate(`window.taskboard.command("create", undefined, { title: "Created in desktop" })`);
    assert.equal(response.ok, true, JSON.stringify(response));
    report.ui = response.data.id;
    await waitReply(report.ui);
    assert.equal(show(report.ui).status, "draft");
    assert.equal(messages(show(report.ui))[0].actor, "agent");
    assert.deepEqual(calls[0].configured, { model: "gpt-6.1-sol", effort: "medium" });
    check("Desktop creation starts in the background with the executor pool occupied and uses board settings");

    await evaluate("window.taskboard.menuAction('new-window')");
    const other = BrowserWindow.getAllWindows().find(candidate => candidate.id !== window.id);
    assert.ok(other);
    const evaluateOther = code => other.webContents.executeJavaScript(code);
    await until(() => evaluateOther("Boolean(window.taskboard)"), "second renderer");
    await open(project, evaluateOther);

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
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=", "base64"));
    const before = calls.length;
    const draft = cli(["create"], { title: "CLI with attachments", dependencies: [created.data.id], execution: settings,
      attachmentSources: [{ path: original, name: "same.txt" }, { path: linked, name: "same.txt", link: true },
        { path: changed, link: true }, { path: image }, { path: image, link: true }] });
    writeFileSync(changed, "changed contents of different length");
    await waitReply(draft.id);
    const input = calls[before];
    assert.equal(input.mode, "initial");
    assert.deepEqual(input.configured, settings);
    assert.deepEqual(input.documents, ["copied contents", "linked contents"]);
    assert.equal(input.images, 2);
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
    await until(() => evaluate("document.querySelector('.task-chat')?.textContent.includes('User answer recorded: 1280 pixels')"), "visible follow-up");
    await capture("draft-discussion-reply.png");
    check("CLI passes distinct same-name files, copied and linked images, failed link, dependency, model and follow-up to the same chat");

    const failure = cli(["create"], { title: "Provider inactive", execution: settings });
    await until(() => show(failure.id).draftDiscussion?.phase === "failed", "provider failure");
    await display(failure.id);
    await until(() => evaluate("document.querySelector('.task-chat').textContent.includes('Fixture provider unavailable')"), "visible failure");
    await capture("draft-discussion-error.png");
    failProvider = false;
    await retry();
    await waitReply(failure.id);
    check("Provider failure is persistent and the visible retry saves a single reply");

    const stale = cli(["create"], { title: "Stale draft", execution: settings });
    await until(() => staleGate, "in-flight response");
    cli(["update", stale.id], { title: "Fresh draft", revision: show(stale.id).revision });
    staleGate();
    await until(() => show(stale.id).draftDiscussion?.phase === "failed", "stale result rejected");
    assert.equal(show(stale.id).title, "Fresh draft");
    assert.equal(messages(show(stale.id)).length, 0);
    check("Editing during the turn prevents a stale reply");

    const busy = cli(["create"], { title: "Writer occupied", execution: settings });
    writer = registerRuntime(project, { kind: "task", task: busy.id });
    assert.ok(writer);
    await delay(2000);
    assert.equal(show(busy.id).draftDiscussion?.phase, "queued");
    writer(); writer = undefined;
    await waitReply(busy.id);
    check("The shared writer keeps a draft queued until released");
    const count = calls.length;
    cli(["create"], { title: "Invalid creation", attachmentSources: [{ path: join(scratch, "missing") }] }, project, "IO_ERROR");
    await open(manual);
    const personal = cli(["create"], { title: "Personal card" }, manual);
    await delay(1600);
    assert.equal(personal.draftDiscussion, undefined);
    assert.equal(calls.length, count);
    assert.equal(existsSync(join(project, ".worktrees")), false);
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "Use the project fixture.");
    check("Failed create and personal board schedule no review, and project/worktree contents stay untouched");

    await until(() => !readdirSync(staging).some(name => name.startsWith("ai-taskboard-chat-")), "staging cleanup");
    const interrupted = cli(["create"], { title: "Interrupted draft", execution: settings });
    writer = registerRuntime(project, { kind: "task", task: interrupted.id });
    assert.ok(writer);
    cli(["draft-discussion", interrupted.id], { revision: interrupted.revision, phase: "running" });
    report.interrupted = interrupted.id;
    check("Transient chat staging is cleaned");
  }
  writeFileSync(evidence, JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // The interrupted fixture intentionally has no surviving writer after process exit.
  if (process.exitCode) writer?.();
  slot?.();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(process.exitCode ?? 0);
}
})();
