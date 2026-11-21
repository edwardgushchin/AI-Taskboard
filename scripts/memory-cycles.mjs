import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const warmup = 2;
const cycles = 6;
const idleMs = 1500;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

export async function checkMemoryCycles({ worker, id, providerPids, electronPids, wait, output, record, retain, resetCard }) {
  const samples = [];
  const versions = await worker.ask({ action: "versions" });
  const sample = async (cycle, providerPid) => {
    await delay(idleMs);
    const result = await worker.ask({ action: "memorySample" });
    for (const { pid } of result.processes) electronPids.add(pid);
    assert.equal(result.windows, 1);
    assert.equal(result.sheetOpen, false);
    const row = { cycle, providerPid, ...result };
    samples.push(row);
    record(JSON.stringify(row));
  };
  try {
    for (let cycle = 1; cycle <= warmup + cycles; cycle++) {
      if (cycle > 1) assert.equal(resetCard().status, "ready");
      const launch = await worker.ask({ action: "launch", id });
      assert.equal(launch.ok, true, JSON.stringify(launch));
      await wait(() => worker.ask({ action: "canStop", id }), "executor stop control");
      const pid = [...providerPids].at(-1);
      assert.equal(providerPids.size, cycle, "one new provider per cycle");
      assert.equal(alive(pid), true);
      const stopped = await worker.ask({ action: "stopFromWindow", id });
      assert.equal(stopped.ok, true, JSON.stringify(stopped));
      await wait(async () => {
        const { controls, windows } = await worker.ask({ action: "agentTrace" });
        return !alive(pid) && !controls.length && windows.every(window => window.total === 0 && !window.running.length);
      }, "provider exit, stop control and active slot released");
      await worker.ask({ action: "memoryCycle", retain, cycle });
      await sample(cycle, pid);
    }
    const baseline = samples[warmup - 1];
    const measured = samples.slice(warmup);
    assert.ok(samples.every(sample => sample.rendererPid === baseline.rendererPid), "same renderer throughout");
    for (const row of [baseline, ...measured]) {
      const expected = retain ? Array.from({ length: row.cycle }, (_, index) => index + 1) : [];
      assert.deepEqual(row.retainedChatCycles, expected, "detached chat objects surviving idle and GC");
    }
    record(retain
      ? "PASS: detected cumulative detached chat retention (globalThis.memoryControl -> .task-chat)"
      : "PASS: detached chats collected, fixture providers exited and executor slots released");
  } finally {
    if (output) {
      mkdirSync(output, { recursive: true });
      const name = retain ? "retained-control" : "normal";
      writeFileSync(join(output, "memory-" + name + ".json"), JSON.stringify({
        versions, warmup, cycles, idleMs, retain, samples,
      }, null, 2) + "\n");
    }
  }
}

export async function memoryWindowAction(command, window, { app, BrowserWindow, project, other, wait }) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  if (command.action === "memoryCycle") {
    contents.setBackgroundThrottling(false);
    await wait(() => evaluate("Boolean(document.querySelector('.task-card'))"), "fixture card");
    await evaluate("document.querySelector('.task-card').click()");
    await wait(() => evaluate("Boolean(document.querySelector('#sheet[open] .task-chat'))"), "loaded task sheet");
    await evaluate("document.querySelector('[aria-controls=task-chat-dialogue]').click()");
    assert.equal(await evaluate("document.querySelector('#task-chat-dialogue').checkVisibility()"), true);
    await evaluate(`(() => {
      const chat = document.querySelector('#sheet .task-chat');
      (globalThis.memoryChatRefs ??= []).push({ cycle: ${command.cycle}, ref: new WeakRef(chat) });
      if (${command.retain}) (globalThis.memoryControl ??= []).push(chat);
    })()`);
    assert.equal(await evaluate(`(() => {
      document.querySelector('#close-sheet').click();
      return document.querySelector('#sheet').open;
    })()`), false, "Close button closes the card");
    await wait(() => evaluate("!document.querySelector('#sheet').open && !document.querySelector('#sheet .task-chat')"), "closed sheet and chat removed");
    for (const path of [other, project]) {
      const selectTab = `[...document.querySelectorAll('.project-tab')].find(tab => tab.dataset.project === ${JSON.stringify(path)})?.querySelector('.project-tab-button')`;
      assert.equal(await evaluate(`Boolean(${selectTab})`), true);
      await evaluate(`(${selectTab}).click()`);
      await wait(() => evaluate(`window.taskboard.bootstrap().then(frame => frame.project === ${JSON.stringify(path)} && !frame.loading)`), "selected board ready");
    }
    return;
  }

  assert.equal(command.action, "memorySample");
  contents.debugger.attach();
  try {
    await contents.debugger.sendCommand("HeapProfiler.collectGarbage");
    const heap = await contents.debugger.sendCommand("Runtime.getHeapUsage");
    const view = await evaluate(`({
      sheetOpen: document.querySelector('#sheet').open,
      retainedChatCycles: (globalThis.memoryChatRefs ?? [])
        .filter(({ ref }) => ref.deref()?.isConnected === false)
        .map(({ cycle }) => cycle)
    })`);
    return {
      ...view,
      rendererPid: contents.getOSProcessId(),
      windows: BrowserWindow.getAllWindows().length,
      heap,
      mainHeapBytes: process.memoryUsage().heapUsed,
      processes: app.getAppMetrics().map(({ pid, type, memory }) => ({
        pid, type, privateBytes: memory.privateBytes * 1024, workingSetBytes: memory.workingSetSize * 1024,
      })),
    };
  } finally {
    contents.debugger.detach();
  }
}
