// Two real Electron processes and three windows; provider turns are isolated
// Node stand-ins so this check never contacts a model or opens a user's board.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label) {
  const until = Date.now() + 25000;
  while (!await predicate()) {
    if (Date.now() > until) throw Error("Timed out: " + label);
    await delay(80);
  }
}
function cli(project, args, input) {
  const reply = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE ?? process.execPath, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project, "--json", ...args,
    ...(input === undefined ? [] : ["--stdin"]),
  ], { encoding: "utf8", windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, input: input === undefined ? undefined : JSON.stringify(input) }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}
if (!process.versions.electron) {
  const scratch = mkdtempSync(join(tmpdir(), "taskboard-shared-runtime-"));
  const outputIndex = process.argv.indexOf("--artifacts");
  const output = outputIndex < 0 ? undefined : resolve(process.argv[outputIndex + 1]);
  const workers = [], providerPids = new Set();
  const results = [];
  const env = { ...process.env, TASKBOARD_CHECK_NODE: process.execPath, GIT_CEILING_DIRECTORIES: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const project = join(scratch, "board"), other = join(scratch, "other");
  const record = text => { results.push(text); console.log(text); };
  const start = async name => {
    const child = spawn(require("electron"), [script, "--worker", scratch, name], { cwd: scratch, env: { ...env, ELECTRON_LOG_FILE: join(scratch, name + "-electron.log") }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let logs = "", sequence = 0;
    const pending = new Map();
    child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
    child.on("message", reply => {
      if (reply.spawnProvider) {
        const provider = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: scratch, windowsHide: true, stdio: "ignore" });
        providerPids.add(provider.pid);
        child.send({ providerSpawned: reply.spawnProvider, pid: provider.pid });
        return;
      }
      for (const pid of reply.pids ?? []) providerPids.add(pid);
      const waiter = pending.get(reply.sequence);
      if (waiter) { pending.delete(reply.sequence); reply.error ? waiter.reject(Error(reply.error + "\n" + logs)) : waiter.resolve(reply.data); }
    });
    const ask = command => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error("Worker timed out: " + JSON.stringify(command) + "\n" + logs)); }, 35000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      child.send({ sequence: id, ...command });
    });
    const worker = { child, ask, get logs() { return logs; } }; workers.push(worker);
    await ask({ action: "ready" });
    return worker;
  };
  try {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const board of [project, other]) { mkdirSync(board); cli(board, ["init"], { git: false }); cli(board, ["settings"], { autoMode: false, reviewMode: "human", agentLimits: { executor: 1, manager: 1, reviewer: 1 } }); }
    const tasks = [];
    for (let i = 0; i < 6; i++) { const task = cli(project, ["create"], { title: "Isolated concurrency " + i, criteria: ["Fixture completes"], workingDirectory: project }); cli(project, ["approve", task.id]); tasks.push(task.id); }
    const a = await start("profile-a"), b = await start("profile-b");
    await a.ask({ action: "newWindow" });
    const boardLock = new DatabaseSync(join(project, ".tasks", ".lock.sqlite"));
    try {
      boardLock.exec("PRAGMA busy_timeout=2000");
      boardLock.exec("BEGIN IMMEDIATE");
      const check = Promise.all([a.ask({ action: "checkInput" }), b.ask({ action: "checkInput" })]);
      let timer;
      try {
        await Promise.race([check, new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Board lock delayed window input or bootstrap IPC")), 2000);
        })]);
      } finally { clearTimeout(timer); }
    } finally { boardLock.close(); }
    record("PASS: focus, click and board IPC stay responsive while the board transaction lock is held");
    const frames = async () => [...await a.ask({ action: "frames" }), ...await b.ask({ action: "frames" })];
    const expectCount = async total => {
      let latest;
      try { await wait(async () => { latest = await frames(); return latest.every(frame => frame.activeAgents.total === total) && [...await a.ask({action:"dom"}), ...await b.ask({action:"dom"})].every(view => view.count === total); }, "all windows count " + total); }
      catch (error) { console.error(JSON.stringify(latest.map(frame => ({ count: frame.activeAgents, error: frame.error, tasks: frame.board.tasks.map(task => ({id:task.id,status:task.status,blocked:task.blocked})), settings: frame.board.settings })), null, 2)); throw error; }
    };
    const race = await Promise.all([a.ask({ action: "launch", id: tasks[0] }), b.ask({ action: "launch", id: tasks[1] })]);
    assert.equal(race.filter(result => result.ok).length, 1, JSON.stringify(race));
    const owner = race[0].ok ? a : b, peer = owner === a ? b : a, runningId = race[0].ok ? tasks[0] : tasks[1];
    await expectCount(1);
    await wait(async () => (await frames()).every(frame => frame.runningTasks.includes(runningId)), "shared running task");
    const duplicate = await peer.ask({ action: "launch", id: runningId }); assert.equal(duplicate.ok, false);
    if (output) {
      mkdirSync(output, { recursive: true });
      await a.ask({ action: "screenshot", path: join(output, "process-a-running.png") });
      await b.ask({ action: "screenshot", path: join(output, "process-b-running.png") });
    }
    record("PASS: concurrent launch gives exactly one provider; duplicate rejected; three windows agree");
    // Persist a continuation while full. Both processes discover the same queue.
    const queued = tasks[2]; cli(project, ["start", queued, "--compact"]);
    const task = cli(project, ["show", queued, "--compact"]);
    await peer.ask({ action: "queue", id: queued, revision: task.revision });
    await wait(async () => (await frames()).every(frame => frame.waitingTasks.includes(queued)), "shared waiting task");
    await wait(async () => [...await a.ask({action:"dom"}), ...await b.ask({action:"dom"})].every(view => view.waiting), "rendered waiting state in three windows");
    if (output) await peer.ask({ action: "screenshot", path: join(output, "waiting.png") });
    await owner.ask({ action: "stop", id: runningId });
    await wait(async () => (await frames()).every(frame => frame.runningTasks.includes(queued) && !frame.waitingTasks.includes(queued)), "queue continues after release");
    await expectCount(1);
    await wait(async () => (await Promise.all([a, b].map(worker => worker.ask({ action: "canStop", id: queued })))).some(Boolean),
      "queued agent has registered its stop control");
    await Promise.all([a.ask({ action: "stop", id: queued }), b.ask({ action: "stop", id: queued })]); await expectCount(0);
    record("PASS: shared waiting state and continuation queue drain after release");
    for (const role of ["manager", "reviewer"]) {
      assert.equal(await a.ask({ action: "reserve", role }), true);
      assert.equal(await b.ask({ action: "reserve", role }), false);
      if (role === "manager") {
        for (const phase of ["waiting", "running"]) {
          await a.ask({ action: "managerPhase", phase });
          await wait(async () => (await frames()).every(frame => frame.managerWork?.phase === phase), "shared manager phase " + phase);
        }
      }
      await a.ask({ action: "release", role });
      assert.equal(await b.ask({ action: "reserve", role }), true);
      await b.ask({ action: "release", role });
    }
    const discussion = await a.ask({ action: "discussion", id: tasks[3] }); assert.ok(discussion);
    assert.equal(await b.ask({ action: "reserve", role: "executor" }), true);
    assert.equal(await b.ask({ action: "reserve", role: "executor", other: true }), true);
    await b.ask({ action: "release", role: "executor" }); await b.ask({ action: "release", role: "executor", other: true });
    await a.ask({ action: "endDiscussion" }); await expectCount(0);
    record("PASS: manager/reviewer limits cross processes; discussion uses no executor slot; boards isolated");
    cli(project, ["settings"], { autoMode: false, reviewMode: "reviewer", agentLimits: { executor: 2, manager: 2, reviewer: 2 } });
    await wait(async () => (await frames()).every(frame => frame.board.settings.reviewMode === "reviewer" && frame.board.settings.agentLimits.executor === 2), "settings propagation");
    cli(project, ["settings"], { reviewMode: "human", agentLimits: { executor: 1, manager: 1, reviewer: 1 }, autoMode: true });
    await expectCount(1);
    cli(project, ["settings"], { autoMode: false });
    await wait(async () => (await frames()).every(frame => !frame.board.settings.autoMode), "auto false propagation");
    await a.ask({ action: "stopAll" }); await b.ask({ action: "stopAll" }); await expectCount(0); await delay(1300); await expectCount(0);
    record("PASS: limits, review mode, statuses and autoMode propagate; auto false prevents subsequent starts");
    await a.ask({ action: "failNext" });
    const failed = await a.ask({ action: "launch", id: tasks[4] }); assert.equal(failed.ok, false);
    assert.equal(await b.ask({ action: "reserve", role: "executor" }), true); await b.ask({ action: "release", role: "executor" });
    // A fixture provider intentionally survives desktop death, exercising the
    // conservative recovery path instead of assuming stdin death ends a turn.
    const resumed = cli(project, ["show", tasks[5], "--compact"]);
    if (resumed.status === "blocked") cli(project, ["resume", tasks[5]], { reason: "isolated crash scenario" });
    const launched = await a.ask({ action: "launch", id: tasks[5] }); assert.equal(launched.ok, true, JSON.stringify(launched));
    await expectCount(1);
    await a.ask({ action: "stopWatches" });
    a.child.kill(); await once(a.child, "exit");
    const restarted = await start("profile-restarted");
    await wait(async () => (await restarted.ask({ action: "frames" })).every(frame => frame.runningTasks.includes(tasks[5])), "restart sees orphan provider");
    assert.equal((await restarted.ask({ action: "launch", id: tasks[5] })).ok, false);
    for (const pid of providerPids) { try { process.kill(pid); } catch {} }
    await wait(async () => (await restarted.ask({ action: "frames" })).every(frame => frame.activeAgents.total === 0 && !frame.runningTasks.includes(tasks[5])), "dead owner and provider reclaimed");
    assert.equal(await restarted.ask({ action: "reserve", role: "executor" }), true); await restarted.ask({ action: "release", role: "executor" });
    record("PASS: launch failure releases slot; restart preserves living orphan; provider death reclaims slot");
    if (output) { mkdirSync(output, { recursive: true }); await restarted.ask({ action: "screenshot", path: join(output, "shared-windows.png") }); writeFileSync(join(output, "shared-runtime.txt"), results.join("\n") + "\n"); }
  } catch (error) {
    if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, "failure.txt"), error.stack + "\n" + workers.map(worker => worker.logs).join("\n")); }
    throw error;
  } finally {
    for (const worker of workers) { if (worker.child.exitCode === null && !worker.child.killed) { try { await worker.ask({ action: "exit" }); } catch {} } }
    for (const worker of workers) if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill();
    for (const pid of providerPids) { try { process.kill(pid); } catch {} }
    await delay(1000);
    for (const pid of providerPids) assert.throws(() => process.kill(pid, 0), "fixture provider must be dead");
    rmSync(scratch, { recursive: true, maxRetries: 10, retryDelay: 200 });
    assert.equal(existsSync(scratch), false);
    console.log("PASS: private profiles, boards and fixture providers cleaned");
  }
} else {
  const { app, BrowserWindow } = require("electron"), { transformSync } = require("esbuild");
  const scratch = process.argv[3], name = process.argv[4], project = join(scratch, "board"), other = join(scratch, "other");
  app.setPath("userData", join(scratch, name)); app.setPath("appData", join(scratch, "app-data-" + name));
  app.disableHardwareAcceleration(); app.requestSingleInstanceLock = () => true;
  const runs = new Map(), leases = new Map(), pids = new Set(), providerRequests = new Map(); let failNext = false, providerSequence = 0;
  const active = await import(new URL("../src/desktop/active-runs.ts", import.meta.url));
  globalThis.runtimeCheckStart = async (_client, board, _cwd, task, _activity, _usage, _signal, beforeTurn) => {
    if (failNext) { failNext = false; throw Error("Isolated provider launch failure"); }
    const request = ++providerSequence;
    const pid = await new Promise(resolve => { providerRequests.set(request, resolve); process.send({spawnProvider: request}); });
    pids.add(pid);
    const provider = active.trackProvider(board, pid), finish = provider.run(() => active.trackActiveRun(board));
    const threadId = "10000000-0000-0000-0000-" + String(pid).padStart(12, "0");
    await beforeTurn(threadId);
    const completion = new Promise(resolve => {
      const timer = setInterval(() => {
        try { process.kill(pid, 0); } catch {
          clearInterval(timer); finish(); provider(); runs.delete(task.id);
          resolve({ interrupted: true, reason: "Isolated fixture finished" });
        }
      }, 50);
    });
    const control = { threadId, completion, interrupt: async () => { try { process.kill(pid); } catch {} }, steer: async () => {} };
    runs.set(task.id, control); return control;
  };
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  let source = readFileSync(sourceUrl, "utf8").replace('missingCodexThread, startCodexRun', 'missingCodexThread')
    .replace('codexStatus, configuredCodex,', 'codexStatus, configuredCodex as unusedConfiguredCodex,')
    .replace('replyToBoard, replyToTask', 'replyToBoard as unusedReplyToBoard, replyToTask')
    .replace('boardSuggestions, chatModels', 'boardSuggestions as unusedBoardSuggestions, chatModels');
  source = 'const boardSuggestions = async () => []; const configuredCodex = async () => ({}); const startCodexRun = globalThis.runtimeCheckStart; const replyToBoard = async () => ({text: "Isolated manager fixture"});\n' + source;
  source = source.replaceAll("import.meta.url", JSON.stringify(sourceUrl.href)).replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, name + ".mjs");
  writeFileSync(entry, transformSync(source + "\nglobalThis.sharedCheck = {createWindow,launchTask,agentSlots,reserveAgent,scheduleAgentWork,activeAgents,subscriptions};", { loader: "ts", format: "esm" }).code);
  process.argv.push("--project", project);
  require(entry);
  const ready = wait(async () => BrowserWindow.getAllWindows().length && BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)"), "initial window");
  process.on("message", async command => {
    if (command.providerSpawned) { providerRequests.get(command.providerSpawned)?.(command.pid); providerRequests.delete(command.providerSpawned); return; }
    try {
      await ready;
      const qa = globalThis.sharedCheck; let data;
      const board = command.other ? other : project, key = command.role + (command.other ? ":other" : "");
      if (command.action === "ready") data = true;
      if (command.action === "newWindow") { const state = qa.createWindow([project]); await state.ready; data = true; }
      if (command.action === "dom") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(`({ count: Number(document.querySelector('#status-agents span')?.textContent), waiting: document.body.innerText.includes('Ожидает свободного исполнителя') || document.body.innerText.includes('Waiting for an available executor') })`)));
      if (command.action === "frames") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript("window.taskboard.bootstrap()")));
      if (command.action === "checkInput") {
        for (const win of BrowserWindow.getAllWindows()) {
          assert.equal(await win.webContents.executeJavaScript(`(async () => {
            const snapshot = await window.taskboard.bootstrap();
            const button = document.querySelector("#app-settings");
            button.focus();
            const focused = document.activeElement === button;
            button.click();
            const menu = document.querySelector("#settings-menu");
            const opened = menu.matches(":popover-open");
            if (opened) menu.hidePopover();
            return Boolean(snapshot.board) && focused && opened;
          })()`), true);
        }
        data = true;
      }
      if (command.action === "launch") data = await qa.launchTask(project, command.id, undefined, false, undefined, undefined, false, false, false, false, true);
      if (command.action === "canStop") data = qa.activeAgents.has(project + "\0" + command.id);
      if (command.action === "stop") { await qa.activeAgents.get(project + "\0" + command.id)?.control.interrupt(); data = true; }
      if (command.action === "stopWatches") { for (const watch of qa.subscriptions.values()) watch.stop(); data = true; }
      if (command.action === "stopAll") { for (const agent of qa.activeAgents.values()) await agent.control.interrupt(); data = true; }
      if (command.action === "queue") { qa.agentSlots.defer(project, command.id, { revision: command.revision }); qa.scheduleAgentWork(); data = true; }
      if (command.action === "reserve") { const lease = qa.reserveAgent(board, command.role, command.role === "manager" ? "manager:work" : undefined); if (lease) leases.set(key, lease); data = Boolean(lease); }
      if (command.action === "managerPhase") { qa.agentSlots.update(project, "manager:work", { id: "fixture-manager", phase: command.phase, startedAt: Date.now() }); data = true; }
      if (command.action === "release") { leases.get(key)?.(); leases.delete(key); data = true; }
      if (command.action === "discussion") { const lease = active.claimDiscussion(project, command.id); const finish = lease.run(() => active.trackActiveRun(project)); leases.set("discussion", () => { finish(); lease(); }); data = true; }
      if (command.action === "endDiscussion") { leases.get("discussion")?.(); leases.delete("discussion"); data = true; }
      if (command.action === "failNext") { failNext = true; data = true; }
      if (command.action === "screenshot") {
        const win = BrowserWindow.getAllWindows()[0]; win.showInactive();
        for (let attempt = 0; ; attempt++) {
          await delay(250);
          try { writeFileSync(command.path, (await win.webContents.capturePage()).toPNG()); break; }
          catch (error) { if (attempt >= 2) throw error; }
        }
        data = true;
      }
      if (command.action === "exit") { for (const watch of globalThis.sharedCheck.subscriptions.values()) watch.stop(); for (const run of runs.values()) await run.interrupt(); for (const lease of leases.values()) lease(); process.send({ sequence: command.sequence, data: true }); setTimeout(() => app.exit(0), 100); return; }
      process.send({ sequence: command.sequence, data, pids: [...pids] });
    } catch (error) { process.send({ sequence: command.sequence, error: command.action + ": " + error.stack }); }
  });
}

