// Exercise manager callbacks, CLI persistence, the board watcher and the real renderer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { registerRuntime } from "../src/desktop/board-runtime.ts";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-auto-mode", 90_000, [["switch"], ["restart"]]);
const restart = process.argv.at(-1) === "restart";
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const other = join(scratch, "other");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const report = join(artifacts, "manager-auto-check.txt");
const log = [];
process.env.GIT_CEILING_DIRECTORIES = scratch;
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
process.argv.push("--project", project);

function cli(cwd, args, input) {
  return JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning",
    cliEntry, "--project", cwd, "--json", ...args, ...(input ? ["--stdin"] : [])],
  { cwd: scratch, windowsHide: true, encoding: "utf8", input: input && JSON.stringify(input) }));
}
function data(cwd, args, input) {
  const result = cli(cwd, args, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function waitFor(probe, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}
const evaluate = (window, js) => window.webContents.executeJavaScript(js);
const pressed = window => evaluate(window,
  "document.querySelector('#status-auto-mode')?.getAttribute('aria-pressed')");
const expectMode = (windows, enabled) => waitFor(async () =>
  (await Promise.all(windows.map(pressed))).every(value => value === String(enabled)), "mode " + enabled);
const ready = window => waitFor(async () => !window.webContents.isLoading() && await evaluate(window,
  "window.taskboard?.bootstrap().then(f => Boolean(f.board) && !f.loading)"), "loaded board");
async function capture(window, name) {
  await evaluate(window, "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))");
  const screenshot = await window.webContents.capturePage();
  assert.deepEqual(screenshot.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name), screenshot.toPNG());
}

void (async () => {
try {
  let waiting, running, held, runtime;
  if (!restart) {
    for (const board of [project, other]) {
      mkdirSync(board);
      data(board, ["init"], { git: false });
      data(board, ["settings"], { reviewMode: "human", taskLimits: { executor: 1, reviewer: 1 } });
    }
    const task = title => {
      const { id } = data(project, ["create"], plannedDraft({ title, criteria: ["Verify fixture"] }));
      return data(project, ["approve", id]);
    };
    running = task("Work already started");
    data(project, ["start", running.id]);
    waiting = task("Waiting for capacity");
    held = task("Held by manager");
    data(project, ["auto-queue"], { revision: 0, order: [held.id, waiting.id], hold: [held.id] });
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  }
  const runningId = running?.id ?? data(project, ["list", "--compact"]).tasks.find(task => task.status === "in_progress").id;
  runtime = registerRuntime(project, { task: runningId, kind: "slot", role: "executor" });
  assert.ok(runtime);
  const queue = data(project, ["auto-queue"]);
  const thread = randomUUID();
  let calls = 0;
  globalThis.fixtureManager = async (_profile, cwd, prompt, _images, action, _tools, _instructions, _signal, session) => {
    assert.equal(cwd, project);
    assert.ok(session.mcpTools.some(tool => tool.name === "board_set_auto_mode"));
    if (calls++) assert.equal(session.id, thread);
    else session.save(thread);
    if (session.messageId) session.onMessage(session.messageId);
    const enabled = prompt === "Enable auto mode";
    if (prompt !== "Read auto mode") {
      assert.deepEqual(await action("board_set_auto_mode", { enabled, reason: " " }),
        { ok: false, error: { code: "INVALID_INPUT", message: "Supply enabled (boolean) and a non-empty reason." } });
      const saved = await action("board_set_auto_mode", { enabled, reason: "Fixture dispatch decision" });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(saved.data.enabled, enabled);
    }
    const state = await action("board_auto_queue", {});
    assert.equal(state.ok, true, JSON.stringify(state));
    assert.deepEqual(state.data.queue, queue);
    assert.equal(state.data.enabled, prompt === "Read auto mode" || enabled);
    return { text: "Saved mode " + state.data.enabled, model: "Fixture manager" };
  };
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync("const replyToBoard = (...args) => globalThis.fixtureManager(...args);\n" +
    source + "\nglobalThis.openTestWindow = project => createWindow([project]).window;", { loader: "ts", format: "esm" }).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  const window = await waitFor(() => BrowserWindow.getAllWindows()[0], "main window");
  window.setContentSize(1280, 800);
  await ready(window);
  const ask = async message => {
    const reply = await evaluate(window, "window.taskboard.boardRequest(" + JSON.stringify(message) + ")");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(reply.data.answer.startsWith("Saved mode"), JSON.stringify(reply));
  };

  if (restart) {
    await expectMode([window], true);
    assert.equal(data(project, ["settings"]).autoMode, true);
    assert.equal(data(other, ["settings"]).autoMode === true, false);
    log.push("A second Electron process restored ON from disk; the other board remained OFF.");
  } else {
    const mirror = globalThis.openTestWindow(project);
    const isolated = globalThis.openTestWindow(other);
    await Promise.all([ready(mirror), ready(isolated)]);
    await expectMode([window, mirror, isolated], false);
    await ask("Enable auto mode");
    await expectMode([window, mirror], true);
    await expectMode([isolated], false);
    await capture(window, "manager-auto-on.png");
    await ask("Disable auto mode");
    await expectMode([window, mirror, isolated], false);
    await capture(window, "manager-auto-off.png");
    assert.equal(data(project, ["show", running.id]).status, "in_progress");
    assert.equal(data(project, ["show", waiting.id]).status, "ready");
    assert.equal(data(project, ["show", held.id]).status, "ready");
    assert.deepEqual(data(project, ["auto-queue"]), queue);
    window.focus();
    window.webContents.focus();
    await evaluate(window, "document.querySelector('#status-auto-mode').focus()");
    for (const type of ["keyDown", "char", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode: "Return" });
    await expectMode([window, mirror], true);
    await ask("Read auto mode");
    await expectMode([isolated], false);
    log.push(`Node ${process.env.TASKBOARD_CHECK_NODE}; Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform}/${process.arch}.`,
      "Real renderer, preload IPC, manager action, CLI and board watcher; deterministic provider callback without network.",
      "Manager enabled mode, disabled it in the continued chat, and read it as ON after a physical keyboard event on the button.",
      "Both 1280x800 states captured. The second window agreed and the other board stayed OFF.",
      "Running fixture retained its status; the waiting/held fixtures and queue revision, order and hold stayed intact.");
  }
  writeFileSync(report, (restart ? readFileSync(report, "utf8") : "") + log.join("\n") + "\n");
  console.log(log.join("\n"));
  runtime();
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
})();
