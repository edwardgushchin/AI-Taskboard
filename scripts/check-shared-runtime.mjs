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
  const managerOnly = process.argv.includes("--manager-only");
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
  checks: try {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    for (const board of [project, other]) { mkdirSync(board); cli(board, ["init"], { git: false }); cli(board, ["settings"], { autoMode: false, reviewMode: "human", taskLimits: { executor: 1, reviewer: 1 } }); }
    const tasks = [];
    for (let i = 0; !managerOnly && i < 6; i++) { const task = cli(project, ["create"], { title: "Isolated concurrency " + i, criteria: ["Fixture completes"], workingDirectory: project }); cli(project, ["approve", task.id]); tasks.push(task.id); }
    const a = await start("profile-a"), b = await start("profile-b");
    await a.ask({ action: "newWindow" });
    const frames = async () => [...await a.ask({ action: "frames" }), ...await b.ask({ action: "frames" })];
    const calls = async () => (await a.ask({ action: "managerCalls" })) + (await b.ask({ action: "managerCalls" }));
    const queueRows = async () => [...await a.ask({ action: "queueRows" }), ...await b.ask({ action: "queueRows" })];
    assert.equal(await a.ask({ action: "reserve", role: "manager" }), true);
    assert.equal(await b.ask({ action: "reserve", role: "manager" }), false);
    for (const phase of ["waiting", "running"]) {
      await a.ask({ action: "managerPhase", phase, lane: "chat" });
      await wait(async () => (await frames()).every(frame => frame.managerBusy && frame.managerRun?.phase === phase &&
        frame.managerWork === null), "shared manager dialogue phase " + phase);
    }
    await a.ask({ action: "release", role: "manager" });
    const binding = join(project, ".tasks", "manager-dialog.json");
    const goal = { objective: "Paused fixture goal", status: "paused" };
    const threadId = "20000000-0000-0000-0000-000000000001";
    writeFileSync(binding, JSON.stringify({ provider: "codex", id: threadId, history: "local", goal }));
    writeFileSync(join(project, ".tasks", "maintenance.json"), JSON.stringify([{
      id: "T-9999:cleanup", task: "T-9999", operation: "cleanup", attempts: 1, retryAt: 0,
      error: { code: "FIXTURE", message: "Closed-card worktree cleanup" },
    }]));
    await a.ask({ action: "startMaintenance" });
    await wait(async () => (await frames()).every(frame => !frame.managerBusy && frame.managerWork?.lane === "maintenance" &&
      frame.managerRun === null), "independent maintenance visible in all windows");
    assert.equal(await b.ask({ action: "reserve", role: "reviewer" }), false);
    assert.equal((await b.ask({ action: "sendNow", text: "Do not steer cleanup" })).error.code, "CHAT_NOT_RUNNING");

    const queuedMessage = "Queued while another window owns the dialogue";
    await a.ask({ action: "reserve", role: "manager" });
    await a.ask({ action: "managerPhase", phase: "running", lane: "chat" });
    await wait(async () => (await frames()).every(frame => frame.managerBusy), "dialogue lock visible");
    await b.ask({ action: "addMessage", text: queuedMessage });
    await wait(async () => (await queueRows()).every(rows => rows.length === 1 && rows[0] === queuedMessage),
      "same queued message in three windows");
    assert.equal(await calls(), 0);
    await b.ask({ action: "dialogue" });
    await b.ask({ action: "checkQueueActions" });
    if (output) {
      mkdirSync(output, { recursive: true });
      await b.ask({ action: "screenshot", path: join(output, "manager-queue.png") });
    }
    await b.ask({ action: "clickSendNow" });
    assert.equal(await calls(), 0);
    await a.ask({ action: "release", role: "manager" });
    await wait(async () => [...await a.ask({ action: "dialogue" }), ...await b.ask({ action: "dialogue" })]
      .every(text => text.includes("Isolated manager is working")), "live manager activity in three windows");
    await wait(async () => await calls() === 1 && (await queueRows()).every(rows => rows.length === 0),
      "queued message delivered across profiles");
    let finalDialogue;
    try {
      await wait(async () => {
        finalDialogue = [...await a.ask({ action: "dialogue" }), ...await b.ask({ action: "dialogue" })];
        return finalDialogue.every(text => text.includes("Isolated manager fixture"));
      }, "final reply in three windows");
    } catch (error) {
      console.error(JSON.stringify({ finalDialogue, history: await a.ask({ action: "history" }) }, null, 2));
      throw error;
    }
    await delay(1200);
    assert.equal(await calls(), 1);
    assert.deepEqual(JSON.parse(readFileSync(binding, "utf8")).goal, goal);
    assert.ok((await frames()).every(frame => frame.managerWork?.lane === "maintenance"));
    assert.equal(await a.ask({ action: "maintenanceCalls" }), 1);
    await a.ask({ action: "finishMaintenance" });
    await wait(async () => (await frames()).every(frame => frame.managerWork === null), "maintenance released");
    record("PASS: closed-card maintenance uses the shared reviewer slot without blocking dialogue or receiving Send Now; paused goal preserved");
    record("PASS: queued text and actions without waiting caption; dialogue lock and exactly one delivery across three windows");
    let expectedCalls = 1;
    for (const outcome of ["finish", "stop", "fail"]) {
      const first = "Hold manager: " + outcome;
      const second = "After " + outcome;
      await a.ask({ action: "addMessage", text: first });
      await wait(async () => await calls() === expectedCalls + 1 && (await frames())
        .every(frame => frame.managerRun?.phase === "running"), "active dialogue before " + outcome);
      await b.ask({ action: "addMessage", text: second });
      await wait(async () => (await queueRows()).every(rows => rows.includes(second)), "durable queue before " + outcome);
      assert.equal(await calls(), expectedCalls + 1);
      const owner = (await a.ask({ action: "hasHeldTurn" })) ? a : b;
      await owner.ask({ action: outcome === "stop" ? "stopManager" : "finishManager" });
      expectedCalls += 2;
      await wait(async () => await calls() === expectedCalls &&
        (await frames()).every(frame => !frame.managerBusy) &&
        (await queueRows()).every(rows => rows.length === (outcome === "fail" ? 1 : 0) &&
          (outcome !== "fail" || rows[0] === first)), "one delivery after " + outcome);
      if (outcome === "fail") await a.ask({ action: "removeFailed" });
    }
    record("PASS: the next queued message was delivered once after reply completion, stop and provider error");

    const crashed = await start("profile-crash-dialogue");
    assert.equal(await crashed.ask({ action: "reserve", role: "manager" }), true);
    await crashed.ask({ action: "managerPhase", phase: "running", lane: "chat" });
    await wait(async () => (await frames()).every(frame => frame.managerBusy), "crash fixture owns dialogue");
    await b.ask({ action: "addMessage", text: "Survives process restart" });
    await wait(async () => (await queueRows()).every(rows => rows.includes("Survives process restart")), "queue saved before restart");
    const crashedExit = once(crashed.child, "exit");
    crashed.child.kill();
    await crashedExit;
    const reloaded = await start("profile-crash-dialogue");
    await wait(async () => await calls() + (await reloaded.ask({ action: "managerCalls" })) === expectedCalls + 1 &&
      [...await frames(), ...await reloaded.ask({ action: "frames" })].every(frame => !frame.managerBusy) &&
      (await queueRows()).every(rows => rows.length === 0), "one delivery after restart");
    const countBeforeFailure = await calls() + await reloaded.ask({ action: "managerCalls" });
    record("PASS: a persisted message survived the dialogue owner's process restart and was delivered once");

    await a.ask({ action: "addMessage", text: "Fixture provider failure" });
    await wait(async () => [...await a.ask({ action: "queueFailures" }), ...await b.ask({ action: "queueFailures" })]
      .every(count => count === 1), "shared terminal queue failure");
    assert.equal(await calls() + await reloaded.ask({ action: "managerCalls" }), countBeforeFailure + 1);
    record("PASS: a terminal failure is visible in every queue without a competing retry");
    const gitBoard = join(scratch, "git-board"), remote = join(scratch, "remote");
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, windowsHide: true, encoding: "utf8" }).trim();
    git(scratch, "init", "--bare", remote);
    git(scratch, "init", "-b", "main", gitBoard);
    git(gitBoard, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture");
    git(gitBoard, "remote", "add", "origin", remote);
    cli(gitBoard, ["init"]);
    await a.ask({ action: "openGitBoard", project: gitBoard });
    await b.ask({ action: "openGitBoard", project: gitBoard });
    await a.ask({ action: "pushFromStatus" });
    await wait(async () => (await a.ask({ action: "gitStatus" })) === "0↓ 0↑" &&
      (await b.ask({ action: "gitStatus" })) === "0↓ 0↑", "both windows show the successful push");
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(gitBoard, "rev-parse", "HEAD"));
    await a.ask({ action: "closeGitBoard" });
    await b.ask({ action: "closeGitBoard" });
    record("PASS: desktop Push sends the pinned commit to the local remote and both profiles update their Git counts");
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
    for (const mode of ["resume", true]) {
      await a.ask({ action: "startGoal", mode });
      await wait(async () => (await a.ask({ action: "goalPanels" })).every(
        panel => panel.visible && panel.status === "active"), "active goal visible in both windows");
      assert.deepEqual((await a.ask({ action: "clearGoal" })).data, null);
      await wait(async () => (await a.ask({ action: "goalPanels" })).every(
        panel => !panel.visible), "cleared goal removed from both open windows");
      assert.equal(JSON.parse(readFileSync(binding, "utf8")).goal, null);
      await a.ask({ action: "finishGoal" });
    }
    await reloaded.ask({ action: "reopenGoalBoard" });
    record("PASS: clearing a new or resumed goal removes it from both windows and from the reopened board");
    if (managerOnly) {
      if (output) writeFileSync(join(output, "shared-runtime.txt"), results.join("\n") + "\n");
      break checks;
    }
    const expectCount = async total => {
      let latest;
      try { await wait(async () => { latest = await frames(); return latest.every(frame => frame.activeAgents.total === total) && [...await a.ask({action:"dom"}), ...await b.ask({action:"dom"})].every(view => view.count === total); }, "all windows count " + total); }
      catch (error) { console.error(JSON.stringify(latest.map(frame => ({ count: frame.activeAgents, error: frame.error, tasks: frame.board.tasks.map(task => ({id:task.id,status:task.status,blocked:task.blocked})), settings: frame.board.settings })), null, 2)); throw error; }
    };
    await a.ask({ action: "restoreBoards" });
    await delay(11000);
    await expectCount(0);
    await a.ask({ action: "closeRestored" });
    record("PASS: restored boards with autoMode off and no goals stay at zero while idle");
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
    await wait(async () => [...await a.ask({action:"order"}), ...await b.ask({action:"order"})].every(view =>
      view.execution[0] === "Isolated concurrency " + tasks.indexOf(runningId)), "running executor ahead of newer queued card");
    if (output) await peer.ask({ action: "screenshot", path: join(output, "waiting.png") });
    await owner.ask({ action: "stop", id: runningId });
    await wait(async () => (await frames()).every(frame => frame.runningTasks.includes(queued) && !frame.waitingTasks.includes(queued)), "queue continues after release");
    await expectCount(1);
    await wait(async () => (await Promise.all([a, b].map(worker => worker.ask({ action: "canStop", id: queued })))).some(Boolean),
      "queued agent has registered its stop control");
    await Promise.all([a.ask({ action: "stop", id: queued }), b.ask({ action: "stop", id: queued })]); await expectCount(0);
    record("PASS: shared waiting state and continuation queue drain after release");
    assert.equal(await a.ask({ action: "reserve", role: "reviewer" }), true);
    assert.equal(await b.ask({ action: "reserve", role: "reviewer" }), false);
    await a.ask({ action: "release", role: "reviewer" });
    assert.equal(await b.ask({ action: "reserve", role: "reviewer" }), true);
    await b.ask({ action: "release", role: "reviewer" });
    const discussion = await a.ask({ action: "discussion", id: tasks[3] }); assert.ok(discussion);
    await wait(() => b.ask({ action: "reserve", role: "executor" }), "executor slot is released after the provider turn");
    assert.equal(await b.ask({ action: "reserve", role: "executor", other: true }), true);
    await b.ask({ action: "release", role: "executor" }); await b.ask({ action: "release", role: "executor", other: true });
    await a.ask({ action: "endDiscussion" }); await expectCount(0);
    record("PASS: manager/reviewer limits cross processes; discussion uses no executor slot; boards isolated");
    cli(project, ["settings"], { autoMode: false, reviewMode: "reviewer", taskLimits: { executor: 2, reviewer: 2 } });
    await wait(async () => (await frames()).every(frame => frame.board.settings.reviewMode === "reviewer" && frame.board.settings.taskLimits.executor === 2), "settings propagation");
    cli(project, ["settings"], { reviewMode: "human", taskLimits: { executor: 1, reviewer: 1 }, autoMode: true });
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
    cli(project, ["settings"], { taskLimits: { executor: 6, reviewer: 7 } });
    const makeCards = (name, review) => Array.from({ length: 7 }, (_, index) => {
      const task = cli(project, ["create"], { title: name + " " + index, criteria: ["Fixture completes"], workingDirectory: project });
      cli(project, ["approve", task.id]);
      cli(project, ["start", task.id, "--compact"]);
      if (review) {
        const preview = cli(project, ["preview", task.id, "--compact"]);
        cli(project, ["submit", task.id, "--compact"], { token: preview.token, noChanges: true, summary: "Test submission", checks: ["Fixture checked"] });
      }
      return task.id;
    });
    const execution = makeCards("Execution order", false), reviews = makeCards("Review order", true);
    await Promise.all([b, restarted].map(worker => worker.ask({ action: "compactWindows" })));
    const readOrder = async () => [...await b.ask({ action: "order" }), ...await restarted.ask({ action: "order" })];
    let idleOrder;
    try {
      await wait(async () => {
        idleOrder = await readOrder();
        return idleOrder.every(view => view.execution[0] === "Execution order 6" &&
          view.review[0] === "Review order 6" && view.more && !view.execution.includes("Execution order 0") &&
          !view.review.includes("Review order 0"));
      }, "idle order and collapsed batches");
    } catch (error) { throw new Error(error.message + ": " + JSON.stringify(idleOrder)); }
    await restarted.ask({ action: "focusOrder" });
    await b.ask({ action: "openOrderDialog" });
    for (const id of execution.slice(0, 6)) assert.equal(await b.ask({ action: "reserve", role: "executor", task: id }), true);
    assert.equal(await b.ask({ action: "reserve", role: "reviewer", task: "review:" + reviews[0] }), true);
    assert.equal(await b.ask({ action: "reserve", role: "reviewer", task: reviews[1] }), true);
    const executionPrefix = [5, 4, 3, 2, 1, 0].map(index => "Execution order " + index);
    await wait(async () => (await readOrder()).every(view =>
      JSON.stringify(view.execution.slice(0, 6)) === JSON.stringify(executionPrefix) &&
      view.review[0] === "Review order 1" && view.review[1] === "Review order 0"), "active groups sorted before batch limit");
    assert.ok(await b.ask({ action: "discussion", id: execution[6] }));
    assert.ok(await restarted.ask({ action: "discussion", id: reviews[6] }));
    await wait(async () => [...await b.ask({ action: "frames" }), ...await restarted.ask({ action: "frames" })].every(frame =>
      frame.replyingTasks.includes(execution[6]) && frame.replyingTasks.includes(reviews[6])), "shared discussions in both columns");
    await delay(1200); // Allow the fallback runtime poll to deliver the frame to the other renderers.
    for (const view of await readOrder()) {
      assert.deepEqual(view.execution.slice(0, 6), executionPrefix);
      assert.deepEqual(view.review.slice(0, 2), ["Review order 1", "Review order 0"]);
    }
    await b.ask({ action: "endDiscussion" });
    await restarted.ask({ action: "endDiscussion" });
    record("PASS: standalone discussions in both columns stay below active execution, review and repair");
    assert.equal(await restarted.ask({ action: "orderFocusPreserved" }), true);
    assert.equal(await b.ask({ action: "orderDialogPreserved" }), true);
    if (output) await restarted.ask({ action: "screenshot", path: join(output, "active-order.png") });
    for (const id of execution.slice(0, 6)) await b.ask({ action: "release", role: "executor", task: id });
    await b.ask({ action: "release", role: "reviewer", task: "review:" + reviews[0] });
    await b.ask({ action: "release", role: "reviewer", task: reviews[1] });
    await wait(async () => (await readOrder()).every(view => view.execution[0] === "Execution order 6" && view.review[0] === "Review order 6"), "idle order restored");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await restarted.ask({ action: "reserve", role: "reviewer", task: "review:" + reviews[0] }), true);
      await wait(async () => (await readOrder()).every(view => view.review[0] === "Review order 0"), "repeated review starts");
      await restarted.ask({ action: "release", role: "reviewer", task: "review:" + reviews[0] });
      await wait(async () => (await readOrder()).every(view => view.review[0] === "Review order 6"), "repeated review ends");
    }
    record("PASS: active-first ordering in both columns across processes, including repeat review, repair, multiple runs and idle order; focus, scroll and dialog preserved");
    await restarted.ask({ action: "focusReviewMore", overflow: true });
    for (const id of reviews.slice(0, -1)) assert.equal(await b.ask({ action: "reserve", role: "reviewer", task: "review:" + id }), true);
    await wait(async () => (await readOrder()).every(view => view.review[0] === "Review order 5"), "six active reviews sorted first");
    await wait(() => restarted.ask({ action: "reviewMoreFitRetried" }), "last inactive card tried and removed");
    const focus = await restarted.ask({ action: "reviewMoreFocusRestored" });
    assert.equal(focus.restored, true, JSON.stringify(focus));
    assert.deepEqual(focus.scroll, focus.initialScroll, "scroll after rejected fit");
    await restarted.ask({ action: "resetReviewFit" });
    for (const id of reviews.slice(0, -1)) await b.ask({ action: "release", role: "reviewer", task: "review:" + id });
    await wait(async () => (await readOrder()).every(view => view.review[0] === "Review order 6" && view.review.length < reviews.length), "idle review batch restored");
    record("PASS: rejected fit restores focus to Show more without scrolling");
    await restarted.ask({ action: "focusReviewMore" });
    for (const id of reviews) assert.equal(await b.ask({ action: "reserve", role: "reviewer", task: "review:" + id }), true);
    await wait(async () => (await readOrder()).every(view => view.review.length === reviews.length), "all review cards visible after activation");
    assert.equal(await restarted.ask({ action: "reviewMoreFocusTransferred" }), true);
    for (const id of reviews) await b.ask({ action: "release", role: "reviewer", task: "review:" + id });
    record("PASS: when activity removes Show more, focus moves to a newly shown card without scrolling");
    if (output) { mkdirSync(output, { recursive: true }); await restarted.ask({ action: "screenshot", path: join(output, "shared-windows.png") }); writeFileSync(join(output, "shared-runtime.txt"), results.join("\n") + "\n"); }
  } catch (error) {
    if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, "failure.txt"), error.stack + "\n" + workers.map(worker => worker.logs).join("\n")); }
    throw error;
  } finally {
    await Promise.all(workers.map(async worker => {
      const child = worker.child;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      if (!child.killed) {
        try { await worker.ask({ action: "exit" }); } catch { child.kill(); }
      }
      await exited;
    }));
    for (const pid of providerPids) { try { process.kill(pid); } catch {} }
    await delay(1000);
    for (const pid of providerPids) assert.throws(() => process.kill(pid, 0), "fixture provider must be dead");
    if (process.platform === "win32") {
      // Windows Git uses hidden metadata and read-only loose objects.
      const modules = join(scratch, "node_modules");
      if (existsSync(modules)) rmSync(modules);
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        $base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $fixture = [IO.Path]::GetFullPath($env:TASKBOARD_SHARED_RUNTIME_FIXTURE)
        if ([IO.Path]::GetDirectoryName($fixture) -ne $base -or [IO.Path]::GetFileName($fixture) -notlike 'taskboard-shared-runtime-*') {
          throw 'Unexpected fixture directory'
        }
        $flags = [IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($fixture, '*', [IO.SearchOption]::AllDirectories)) {
          $attributes = [IO.File]::GetAttributes($entry)
          if ($attributes -band $flags) { [IO.File]::SetAttributes($entry, $attributes -band (-bnot $flags)) }
        }
        Remove-Item -LiteralPath $fixture -Recurse
      `], { env: { ...process.env, TASKBOARD_SHARED_RUNTIME_FIXTURE: scratch }, windowsHide: true });
    } else rmSync(scratch, { recursive: true, maxRetries: 10, retryDelay: 200 });
    assert.equal(existsSync(scratch), false);
    console.log("PASS: private profiles, boards and fixture providers cleaned");
  }
} else {
  const { app, BrowserWindow } = require("electron"), { transformSync } = require("esbuild");
  const scratch = process.argv[3], name = process.argv[4], project = join(scratch, "board"), other = join(scratch, "other");
  app.setPath("userData", join(scratch, name)); app.setPath("appData", join(scratch, "app-data-" + name));
  app.disableHardwareAcceleration(); app.requestSingleInstanceLock = () => true;
  const runs = new Map(), leases = new Map(), pids = new Set(), providerRequests = new Map(); let failNext = false, providerSequence = 0;
  let gitWindow;
  const active = await import(new URL("../src/desktop/active-runs.ts", import.meta.url));
  let managerCalls = 0, maintenanceCalls = 0, heldTurn, goalDone, goalRequest;
  const maintenanceDone = Promise.withResolvers();
  globalThis.runtimeCheckReply = async (_profile, _project, text, _images, _action, _tools, _instructions, _signal, hooks) => {
    if (hooks.goal || hooks.resumeGoal) {
      goalDone = Promise.withResolvers();
      hooks.onGoalControl(async ({ kind }) => {
        assert.equal(kind, "clear");
        hooks.onGoal(null);
        return null;
      });
      hooks.onGoal({ objective: hooks.goal ?? "Paused fixture goal", status: "active" });
      await goalDone.promise;
      return { text: "", goalStatus: "cleared" };
    }
    if (hooks.role === "reviewer") {
      assert.equal(hooks.id, undefined);
      assert.equal(hooks.resumeGoal, false);
      maintenanceCalls++;
      hooks.onControl({ steer: async () => assert.fail("Maintenance received a user message") });
      await maintenanceDone.promise;
      return { text: "Isolated maintenance fixture" };
    }
    managerCalls++;
    if (text === "Fixture provider failure") throw Error("Isolated provider failure");
    if (text.startsWith("Hold manager: ")) {
      heldTurn = Promise.withResolvers();
      hooks.onControl({ interrupt: async () => heldTurn.resolve("stop") });
      if (!text.endsWith("fail")) hooks.onMessage(hooks.messageId);
      const result = await heldTurn.promise;
      heldTurn = undefined;
      if (result === "stop") return { interrupted: true };
      if (text.endsWith("fail")) throw Error("Isolated active-turn failure");
      return { text: "Finished held turn" };
    }
    hooks.onActivity([{ id: "fixture-live", type: "agentMessage", title: "", text: "Isolated manager is working", phase: "commentary", status: "inProgress" }]);
    await delay(3000);
    return { text: "Isolated manager fixture" };
  };
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
    .replace('replyToBoard, replyToTask', 'replyToBoard as unusedReplyToBoard, replyToTask');
  source = 'const configuredCodex = async () => ({}); const startCodexRun = globalThis.runtimeCheckStart; const replyToBoard = globalThis.runtimeCheckReply;\n' + source;
  source = source.replaceAll("import.meta.url", JSON.stringify(sourceUrl.href)).replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, name + ".mjs");
  writeFileSync(entry, transformSync(source + "\nglobalThis.sharedCheck = {createWindow,launchTask,agentSlots,reserveAgent,scheduleAgentWork,scheduleMaintenance,activeAgents,subscriptions};", { loader: "ts", format: "esm" }).code);
  process.argv.push("--project", project);
  require(entry);
  const ready = wait(async () => BrowserWindow.getAllWindows().length && BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)"), "initial window");
  process.on("message", async command => {
    if (command.providerSpawned) { providerRequests.get(command.providerSpawned)?.(command.pid); providerRequests.delete(command.providerSpawned); return; }
    try {
      await ready;
      const qa = globalThis.sharedCheck; let data;
      const board = command.other ? other : project, key = command.role + (command.other ? ":other" : "") + (command.task ?? "");
      if (command.action === "ready") data = true;
      if (command.action === "restoreBoards") { const state = qa.createWindow([project, other]); await state.ready; globalThis.restoredCheckWindow = state.window; data = true; }
      if (command.action === "closeRestored") { globalThis.restoredCheckWindow.close(); data = true; }
      if (command.action === "newWindow") { const state = qa.createWindow([project]); await state.ready; data = true; }
      if (command.action === "compactWindows") for (const win of BrowserWindow.getAllWindows()) win.setSize(700, 550);
      if (command.action === "dom") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(`({ count: Number(document.querySelector('#status-agents span')?.textContent), waiting: document.body.innerText.includes('Ожидает свободного исполнителя') || document.body.innerText.includes('Waiting for an available executor') })`)));
      if (command.action === "order") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(`(() => {
        const titles = state => [...document.querySelectorAll('#lane-cards-' + state + ' .task-card-heading strong')].map(node => node.textContent);
        return { execution: titles('in_progress'), review: titles('review'), more: Boolean(document.querySelector('#lane-cards-in_progress .lane-more')) };
      })()`)));
      if (command.action === "focusReviewMore") {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const style = command.overflow ? await contents.insertCSS(
          "#lane-cards-review > .task-card { height: 42px; min-height: 0; overflow: hidden; } #lane-cards-review > .task-card:last-child { height: 1200px; }") : null;
        await contents.executeJavaScript(`(() => {
          const lane = document.querySelector('#lane-cards-review');
          const more = lane.querySelector('.lane-more');
          if (${Boolean(style)}) {
            const fit = globalThis.reviewFit = { style: ${JSON.stringify(style)}, more, retried: false };
            fit.observer = new MutationObserver(records => {
              if (more.isConnected && records.some(record => [...record.addedNodes].some(node =>
                  node.matches?.('.task-card') && !node.isConnected)) &&
                  records.some(record => [...record.removedNodes].includes(more))) fit.retried = true;
            });
            fit.observer.observe(lane, { childList: true });
          }
          more.focus({ preventScroll: true });
          const board = document.querySelector('#lanes');
          board.scrollLeft = 80;
          if (${Boolean(style)}) board.scrollTop = 0;
          if (document.activeElement !== more || board.scrollLeft <= 0) throw Error("Show more focus fixture not set");
          globalThis.reviewMoreFocus = { visible: new Set(lane.querySelectorAll('.task-card')), left: board.scrollLeft, top: board.scrollTop };
        })()`);
        data = true;
      }
      if (command.action === "reviewMoreFitRetried") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("reviewFit.retried");
      if (command.action === "reviewMoreFocusRestored") {
        data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
          const board = document.querySelector('#lanes');
          return { restored: document.activeElement === reviewFit.more,
            focused: document.activeElement.className, visible: reviewFit.more.isConnected,
            scroll: [board.scrollLeft, board.scrollTop], initialScroll: [reviewMoreFocus.left, reviewMoreFocus.top] };
        })()`);
      }
      if (command.action === "resetReviewFit") {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const key = await contents.executeJavaScript("reviewFit.observer.disconnect(); reviewFit.style");
        await contents.removeInsertedCSS(key);
        data = true;
      }
      if (command.action === "reviewMoreFocusTransferred") {
        data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
          const board = document.querySelector('#lanes');
          const card = document.activeElement;
          return card.matches('#lane-cards-review > .task-card') && !reviewMoreFocus.visible.has(card) &&
            !document.querySelector('#lane-cards-review .lane-more') &&
            board.scrollLeft === reviewMoreFocus.left && board.scrollTop === reviewMoreFocus.top;
        })()`);
      }
      if (["focusOrder", "openOrderDialog", "orderFocusPreserved", "orderDialogPreserved"].includes(command.action)) {
        const win = BrowserWindow.getAllWindows()[0];
        if (command.action === "focusOrder") {
          await win.webContents.executeJavaScript(`(() => {
            globalThis.orderCard = document.querySelector('#lane-cards-in_progress .task-card');
            orderCard.focus({ preventScroll: true });
            const board = document.querySelector('#lanes');
            board.scrollLeft = 80;
            globalThis.orderScroll = board.scrollLeft;
            if (orderScroll <= 0 || document.activeElement !== orderCard) throw Error("Focus and scroll fixture not set");
          })()`);
        }
        if (command.action === "openOrderDialog") {
          await win.webContents.executeJavaScript("document.querySelector('#lane-cards-review .task-card').click()");
          await wait(() => win.webContents.executeJavaScript("document.querySelector('#sheet').open"), "task dialog");
          await win.webContents.executeJavaScript("globalThis.orderDialogTitle = document.querySelector('#sheet-title').textContent");
        }
        if (command.action === "orderFocusPreserved") data = await win.webContents.executeJavaScript("document.activeElement === orderCard && document.querySelector('#lanes').scrollLeft === orderScroll");
        if (command.action === "orderDialogPreserved") data = await win.webContents.executeJavaScript("document.querySelector('#sheet').open && document.querySelector('#sheet-title').textContent === orderDialogTitle");
      }
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
      if (command.action === "reserve") {
        const lease = command.role === "manager" ? qa.agentSlots.claim(board, "manager:context") : qa.reserveAgent(board, command.role, command.task);
        if (lease) leases.set(key, lease);
        data = Boolean(lease);
      }
      if (command.action === "managerPhase") { qa.agentSlots.update(project, "manager:context", { id: "fixture-manager", phase: command.phase, startedAt: Date.now(), lane: command.lane }); data = true; }
      if (command.action === "startMaintenance") { void qa.scheduleMaintenance(project, qa.subscriptions.get(project)); data = true; }
      if (command.action === "finishMaintenance") { maintenanceDone.resolve(); data = true; }
      if (command.action === "maintenanceCalls") data = maintenanceCalls;
      if (command.action === "hasHeldTurn") data = Boolean(heldTurn);
      if (command.action === "finishManager") { heldTurn.resolve("finish"); data = true; }
      if (command.action === "stopManager") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "window.taskboard.stopOrchestrator()");
      if (command.action === "sendNow") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        `window.taskboard.boardRequest(${JSON.stringify(command.text)}, [], undefined, false, true)`);
      if (command.action === "checkQueueActions") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
        const status = document.querySelector(".board-queued-status");
        if (!status || status.querySelector(":scope > span") || status.querySelectorAll("button").length !== 3) {
          throw Error("Queued row should show only edit, send and remove controls");
        }
        return true;
      })()`);
      if (command.action === "clickSendNow") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        'document.querySelectorAll(".board-queued-status button")[1].click()');
      if (command.action === "removeFailed") {
        const win = BrowserWindow.getAllWindows()[0];
        data = await win.webContents.executeJavaScript(`(async () => {
          const { data } = await window.taskboard.boardQueue(${JSON.stringify(project)}, "list");
          const job = data.find(job => job.failed);
          if (!job) throw Error("Expected the failed predecessor in the queue");
          return window.taskboard.boardQueue(${JSON.stringify(project)}, "remove", job.id);
        })()`);
        assert.equal(data.ok, true);
      }
      if (command.action === "addMessage") {
        data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          `window.taskboard.boardQueue(${JSON.stringify(project)}, "add", undefined, ${JSON.stringify(command.text)}, false, [])`);
        assert.equal(data.ok, true, JSON.stringify(data));
      }
      if (command.action === "queueRows") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(
        'Array.from(document.querySelectorAll(".board-queued-preview"), node => node.textContent)')));
      if (command.action === "queueFailures") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(
        'document.querySelectorAll(".board-queued-failed").length')));
      if (command.action === "dialogue") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector("#board-composer .draft-input textarea");
        const composer = input.closest("form");
        if (!composer.matches("[data-open], [data-pinned]")) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        if (!composer.matches("[data-open], [data-pinned]")) throw new Error("Could not open the manager dialogue");
        return composer.textContent;
      })()`)));
      if (command.action === "managerCalls") data = managerCalls;
      if (command.action === "history") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.taskboard.boardHistory()");
      if (command.action === "startGoal") {
        goalRequest = BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          `window.taskboard.boardRequest(${JSON.stringify(command.mode === "resume" ? "" : "New fixture goal")}, [], undefined, ${JSON.stringify(command.mode)})`);
        data = true;
      }
      if (command.action === "clearGoal") data = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        'window.taskboard.boardGoal("clear")');
      if (command.action === "finishGoal") {
        goalDone.resolve();
        data = await goalRequest;
        assert.equal(data.ok, true, JSON.stringify(data));
      }
      if (command.action === "goalPanels") data = await Promise.all(BrowserWindow.getAllWindows().map(win => win.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector(".board-goal");
        return { visible: !panel.hidden, status: panel.dataset.status };
      })()`)));
      if (command.action === "reopenGoalBoard") {
        const { window, ready } = qa.createWindow([project]);
        try {
          await ready;
          const history = await window.webContents.executeJavaScript("window.taskboard.boardHistory()");
          assert.equal(history.data.goal, null);
          assert.equal(await window.webContents.executeJavaScript('document.querySelector(".board-goal").hidden'), true);
          data = true;
        } finally { window.close(); }
      }
      if (command.action === "openGitBoard") {
        const state = qa.createWindow([command.project]);
        gitWindow = state.window;
        await state.ready;
        data = true;
      }
      if (command.action === "pushFromStatus") {
        await wait(() => gitWindow.webContents.executeJavaScript('Boolean(document.querySelector("#status-tracking:not([hidden]):enabled"))'), "Push button");
        await gitWindow.webContents.executeJavaScript('document.querySelector("#status-tracking").click()');
        data = true;
      }
      if (command.action === "gitStatus") data = await gitWindow.webContents.executeJavaScript('document.querySelector("#status-tracking span").textContent');
      if (command.action === "closeGitBoard") { gitWindow.close(); data = true; }
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

