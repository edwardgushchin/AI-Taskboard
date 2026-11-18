// Exercise the real queue IPC and renderer with a deterministic manager provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { registerRuntime } from "../src/desktop/board-runtime.ts";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-queue", 90_000, [["reorder"], ["deliver"]]);
const phase = process.argv.at(-1);
const { app } = await import("electron");
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const attachment = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6uYUV8AAAAASUVORK5CYII=";
const expectedImage = "data:image/png;base64," + attachment;
const reports = [];
const pass = text => { reports.push(text); console.log("PASS " + text); };

async function waitFor(probe, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for " + label);
}

const queueApi = (window, method, ...args) => evaluate(window,
  "window.taskboard.boardQueue(" + [project, method, ...args].map(value => JSON.stringify(value) ?? "undefined").join(",") + ")");
const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
const pendingRows = ".board-queued-row:has(.board-queue-handle[aria-disabled=false])";
const rows = "Array.from(document.querySelectorAll(" + JSON.stringify(pendingRows + " .board-queued-preview") +
  "), node => node.textContent)";
const expectRows = (window, labels) =>
  waitFor(async () => JSON.stringify(await evaluate(window, rows)) === JSON.stringify(labels), labels.join(", "));
async function openChat(window, width, height) {
  window.setSize(width, height);
  await waitFor(async () => !window.webContents.isLoading() && await evaluate(window,
    "Boolean(document.querySelector('#board-draft textarea'))"), "board composer").catch(async error => {
    const info = await evaluate(window, "window.taskboard?.bootstrap().then(frame => ({ project: frame.project, loading: frame.loading, loaded: !!frame.board, error: frame.error, text: document.body.innerText.slice(0, 500) }))");
    throw new Error(error.message + ": " + JSON.stringify(info));
  });
  await evaluate(window, "document.querySelector('#board-draft textarea[name=request]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}));");
}

async function drag(window, from, to, after, screenshot) {
  const contents = window.webContents;
  window.focus();
  contents.focus();
  await delay(250);
  const points = await evaluate(window, "(() => {" + [
    "const rows = document.querySelectorAll('.board-queued-row');",
    "const from = rows[" + from + "].querySelector('.board-queue-handle').getBoundingClientRect();",
    "const to = rows[" + to + "].getBoundingClientRect();",
    "return [{x:from.x+from.width/2,y:from.y+from.height/2},",
    "{x:to.x+to.width/2,y:to.y+to.height*" + (after ? ".75" : ".25") + "}];",
  ].join("") + "})()");
  const [source, target] = points;
  const hit = await evaluate(window, "document.elementFromPoint(" + source.x + "," + source.y + ")?.closest('.board-queue-handle')?.outerHTML");
  assert.ok(hit?.includes('draggable="true"'), "The drag handle is visible and draggable: " + JSON.stringify({ source, target, hit }));
  const debug = contents.debugger;
  debug.attach("1.3");
  try {
    const send = (method, params) => debug.sendCommand("Input." + method, params);
    await send("setInterceptDrags", { enabled: true });
    const intercepted = Promise.withResolvers();
    const receive = (_event, method, params) => {
      if (method === "Input.dragIntercepted") intercepted.resolve(params.data);
    };
    debug.on("message", receive);
    await send("dispatchMouseEvent", { type: "mousePressed", ...source, button: "left", buttons: 1, clickCount: 1 });
    await send("dispatchMouseEvent", { type: "mouseMoved", x: source.x + 12, y: source.y, button: "left", buttons: 1 });
    await send("dispatchMouseEvent", { type: "mouseMoved", ...target, button: "left", buttons: 1 });
    const data = await waitFor(() => Promise.race([intercepted.promise, delay(50)]), "Chromium native drag");
    debug.removeListener("message", receive);
    await send("dispatchDragEvent", { type: "dragEnter", ...target, data });
    await send("dispatchDragEvent", { type: "dragOver", ...target, data });
    assert.equal(await evaluate(window, "document.querySelectorAll('.board-queued-row')[" + to + "].dataset.queueDrop"),
      after ? "after" : "before");
    assert.notEqual(await evaluate(window, "getComputedStyle(document.querySelector('[data-queue-drop]')).boxShadow"), "none");
    if (screenshot) {
      await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      writeFileSync(join(artifacts, screenshot), (await contents.capturePage()).toPNG());
    }
    await send("dispatchDragEvent", { type: "drop", ...target, data });
  } finally {
    debug.detach();
  }
}

async function run() {
  if (phase === "reorder") {
    mkdirSync(project);
    const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true });
    git("init", "--initial-branch=main");
    git("-c", "user.name=Queue Fixture", "-c", "user.email=queue@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
    execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning", cliEntry,
      "--project", project, "--json", "init"], { windowsHide: true });
  }

  app.setPath("userData", join(scratch, "profile-" + phase));
  app.setPath("appData", join(scratch, "app-data-" + phase));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  process.argv.push("--project", project);
  const modules = join(scratch, "node_modules");
  if (!existsSync(modules)) symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), modules, "junction");
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync("const replyToBoard = (...args) => globalThis.queueProvider(...args);\n" + source +
    "\nglobalThis.openQueueWindow = project => createWindow([project]);", { loader: "ts", format: "esm" }).code);

  const requests = [];
  const first = Promise.withResolvers();
  const hold = registerRuntime(project, { task: "manager:context", kind: "task" });
  assert.ok(hold);
  globalThis.queueProvider = async (_profile, _project, prompt, images, _action, _tools, _instructions, _signal, session) => {
    requests.push({ prompt, images, id: session.messageId });
    session.onControl({
      interrupt() {},
      async steer(text, files, id) {
        if (!id) return;
        requests.push({ prompt: text, images: files, id, steered: true });
        session.onMessage(id);
      },
    }, "Queue fixture");
    if (prompt === "First with image" || prompt === "Keep chat active") await first.promise;
    session.onMessage(session.messageId);
    return { text: "Received " + prompt, model: "Queue fixture" };
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.setBackgroundThrottling(false);
    contents.on("console-message", details => { if (details.level === "error") console.error(details.message); });
  });
  require(entry);
  const { BrowserWindow } = require("electron");
  const wide = await waitFor(() => BrowserWindow.getAllWindows()[0], "first window");
  await openChat(wide, 1130, 740);
  const narrow = globalThis.openQueueWindow(project).window;
  await openChat(narrow, 720, 680);
  const snapshot = async window => {
    const result = await queueApi(window, "list");
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const drained = () => waitFor(async () => !(await snapshot(wide)).length &&
    await evaluate(wide, "window.taskboard.bootstrap().then(({managerBusy}) => !managerBusy)"), "empty queue and idle manager");
  async function add(draft, image = false) {
    const files = image ? "[{name:'sample.png',type:'image/png',bytes:Uint8Array.from(atob(" +
      JSON.stringify(attachment) + "),c=>c.charCodeAt(0)).buffer}]" : "[]";
    const result = await evaluate(wide, "window.taskboard.boardQueue(" + JSON.stringify(project) +
      ",'add',undefined," + JSON.stringify(draft) + ",false," + files + ")");
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  }
  if (phase === "reorder") {
    await add("Second");
    await add("Third");
    await add("First with image", true);
    // The initiating renderer normally enqueues after its own add.
    await evaluate(wide, "document.querySelector('#board-draft').refreshQueue()");
    await expectRows(wide, ["Second", "Third", "First with image"]);
    await expectRows(narrow, ["Second", "Third", "First with image"]);
    wide.focus();
    await drag(wide, 2, 0, false, "manager-queue-reorder-wide.png");
    await expectRows(wide, ["First with image", "Second", "Third"]);
    await expectRows(narrow, ["First with image", "Second", "Third"]);
    narrow.focus();
    await drag(narrow, 0, 2, true);
    await expectRows(wide, ["Second", "Third", "First with image"]);
    await expectRows(narrow, ["Second", "Third", "First with image"]);
    pass("Drag up at 1130×740 and down at 720×680; insertion line before drop; both windows agree.");

    assert.match(await evaluate(narrow, "document.querySelector('.board-queue-handle').getAttribute('aria-label')"), /Second/);
    assert.equal(await evaluate(narrow, "getComputedStyle(document.querySelector('.codicon-gripper'), '::before').content.codePointAt(1)"), 0xeb04);
    await evaluate(narrow, "document.querySelectorAll('.board-queue-handle')[2].focus()");
    narrow.webContents.focus();
    for (const labels of [["Second", "First with image", "Third"], ["First with image", "Second", "Third"]]) {
      narrow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up" });
      narrow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Up" });
      await expectRows(narrow, labels);
    }
    assert.equal(await evaluate(narrow, "document.activeElement === document.querySelector('.board-queue-handle')"), true);
    narrow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
    narrow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
    await expectRows(narrow, ["Second", "First with image", "Third"]);
    narrow.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up" });
    narrow.webContents.sendInputEvent({ type: "keyUp", keyCode: "Up" });
    await expectRows(narrow, ["First with image", "Second", "Third"]);
    assert.equal(await evaluate(narrow, "document.querySelectorAll('.board-queued-thumbnail img').length"), 1);
    await expectRows(wide, ["First with image", "Second", "Third"]);
    writeFileSync(join(artifacts, "manager-queue-reorder.png"), (await narrow.webContents.capturePage()).toPNG());
    pass("Up and Down Arrow moves retain focus, preserve thumbnail and update both windows.");
    hold();
  } else {
    await expectRows(wide, ["First with image", "Second", "Third"]);
    await expectRows(narrow, ["First with image", "Second", "Third"]);
    const [a, b, c] = await snapshot(wide);
    assert.deepEqual(Buffer.from(a.files[0].bytes), Buffer.from(attachment, "base64"));
    pass("Restart with a new Electron profile restores saved order and exact PNG bytes.");

    hold();
    // Try the former head before the periodic context update wakes the automatic sender.
    const stale = await evaluate(wide, "window.taskboard.boardRequest(" +
      [b.draft, [], project, false, false, b.id].map(value => JSON.stringify(value)).join(",") + ")");
    assert.equal(stale.error?.code, "BOARD_QUEUE_CHANGED", JSON.stringify(stale));
    await waitFor(() => requests[0], "first automatic request");
    assert.equal(requests[0].id, a.id);
    const moveClaimed = await queueApi(narrow, "move", a.id, c.id, true);
    assert.equal(moveClaimed.ok, true);
    assert.equal((await snapshot(narrow))[0].inFlight, true);
    assert.deepEqual((await snapshot(narrow)).map(job => job.id), [a.id, b.id, c.id]);
    assert.equal((await queueApi(narrow, "move", b.id, c.id, true)).ok, true);
    assert.deepEqual((await snapshot(narrow)).map(job => job.id), [a.id, c.id, b.id]);
    assert.equal((await queueApi(narrow, "move", b.id, c.id, false)).ok, true);
    first.resolve();
    await waitFor(() => requests.length >= 3, "three automatic sends").catch(async error => {
      const [wideState, narrowState] = await Promise.all([wide, narrow].map(window => evaluate(window,
        "window.taskboard.bootstrap().then(({managerBusy, managerRun})=>({managerBusy, phase:managerRun?.phase, queue:document.querySelector('.board-chat-queue')?.innerText, composer:document.querySelector('#board-draft')?.innerText.slice(-500)}))")));
      throw new Error(error.message + ": " + JSON.stringify({ sent: requests.map(job => job.prompt), wideState, narrowState }));
    });
    await expectRows(wide, []);
    await expectRows(narrow, []);
    assert.deepEqual(requests.map(({ prompt, id }) => [prompt, id]), [[a.draft, a.id], [b.draft, b.id], [c.draft, c.id]]);
    assert.deepEqual(requests[0].images, [expectedImage]);
    await drained();
    pass("Stale selection is refused; moving a claimed message is ignored; three messages arrive once in saved order with the PNG.");

    const gate = Promise.withResolvers();
    const steeringStarted = Promise.withResolvers();
    const rejectSteering = Promise.withResolvers();
    const provider = globalThis.queueProvider;
    let activeFixture = false;
    globalThis.queueProvider = async (...args) => {
      if (args[2] !== "Keep chat active") return provider(...args);
      const session = args[8];
      session.onControl({ interrupt() {}, async steer(text, images, id) {
        if (text === "Edited text") {
          steeringStarted.resolve(id);
          await rejectSteering.promise;
          throw new Error("Fixture refused the immediate send");
        }
        requests.push({ prompt: text, images, id, steered: true });
        session.onMessage(id);
      } }, "Queue fixture");
      activeFixture = true;
      await gate.promise;
      return { text: "Closed", model: "Queue fixture" };
    };
    await evaluate(wide, "(() => { const input=document.querySelector('#board-draft textarea[name=request]'); input.value='Keep chat active'; input.dispatchEvent(new Event('input')); input.form.requestSubmit(); })()");
    await waitFor(() => activeFixture, "active chat");
    const removed = await add("Delete me");
    const edited = await add("Edit me");
    const keep = await add("Keep me");
    const follow = await add("Follow me");
    await evaluate(wide, "document.querySelector('#board-draft').refreshQueue()");
    await expectRows(wide, ["Delete me", "Edit me", "Keep me", "Follow me"]);
    await expectRows(narrow, ["Delete me", "Edit me", "Keep me", "Follow me"]);
    const action = (window, row, selector) => evaluate(window, "document.querySelectorAll(" + JSON.stringify(pendingRows) + ")[" +
      row + "].querySelector(" + JSON.stringify(selector) + ").click()");
    await action(narrow, 0, ".board-queued-remove");
    await expectRows(wide, ["Edit me", "Keep me", "Follow me"]);
    assert.equal((await queueApi(narrow, "move", edited, removed, false)).ok, true);
    assert.equal((await queueApi(narrow, "move", removed, keep, true)).ok, true);
    await expectRows(narrow, ["Edit me", "Keep me", "Follow me"]);
    await action(wide, 0, ".board-queued-status button:first-child");
    await evaluate(wide, "(() => { const input=document.querySelector('.board-queued-edit'); input.value='Edited text'; input.dispatchEvent(new Event('input')); input.closest('.board-queued-row').querySelector('.board-queued-status button').click(); })()");
    await expectRows(narrow, ["Edited text", "Keep me", "Follow me"]);
    await action(wide, 0, ".board-queued-status button:nth-child(2)");
    assert.equal(await waitFor(() => Promise.race([steeringStarted.promise, delay(50)]), "immediate send"), edited);
    assert.equal((await snapshot(narrow)).find(job => job.id === edited).inFlight, true);
    assert.equal((await queueApi(narrow, "move", follow, keep, false)).ok, true);
    await expectRows(wide, ["Edited text", "Follow me", "Keep me"]);
    // Let the periodic directory watcher see the move while steering is still pending.
    await delay(1200);
    rejectSteering.resolve();
    await waitFor(() => evaluate(wide, "document.querySelector('#board-draft').innerText.includes('Fixture refused the immediate send')"),
      "provider refusal in the sending window");
    await waitFor(() => evaluate(wide, `(() => {
      const row = [...document.querySelectorAll('.board-queued-row')].find(row =>
        row.querySelector('.board-queued-preview')?.textContent === "Edited text");
      return row?.querySelector('.board-queue-handle')?.getAttribute('aria-disabled') === "false" &&
        row.querySelectorAll('.board-queued-status button').length === 3;
    })()`), "restored edit, send now and delete actions in the sending window");
    await expectRows(narrow, ["Edited text", "Follow me", "Keep me"]);
    await action(wide, 2, ".board-queued-status button:nth-child(2)");
    await waitFor(() => requests.some(job => job.id === keep && job.steered), "second Send now during active chat");
    gate.resolve();
    await drained();
    assert.deepEqual(requests.slice(3).map(({ prompt, id, steered }) => [prompt, id, steered]),
      [["Keep me", keep, true], ["Edited text", edited, undefined], ["Follow me", follow, undefined]]);
    pass("During Send now, the other window reorders pending rows. After provider rejection the sender restores all row actions.");
    pass("Removed source and target are ignored; edit reaches the other window; Send now and automatic delivery succeed once per message.");
  }
  const report = join(artifacts, "manager-queue-reorder.txt");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  const commit = git("rev-parse", "HEAD");
  const dirty = Boolean(git("status", "--porcelain"));
  const header = "Electron " + process.versions.electron + ", Node " + process.versions.node + ", " + process.platform + "\n" +
    "Git commit: " + commit + (dirty ? " (working tree has changes)" : "") + "\n" +
    "Command: node scripts/check-manager-queue.mjs --artifacts .tasks/qa\n";
  const previous = phase === "reorder" ? header : readFileSync(report, "utf8");
  assert.ok(previous.startsWith(header), "Both phases test the same Git revision");
  writeFileSync(report, previous + reports.join("\n") + "\n");
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
