import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openBoardMcp } from "../src/desktop/board-mcp.ts";
import { checkWaitTool, waitForCheck } from "../src/desktop/check-wait.ts";

test("a detached check records its failure before publishing its completion marker", async t => {
  const parent = await realpath(tmpdir());
  const cwd = await mkdtemp(join(parent, "ai-taskboard-check-wait-"));
  const helper = spawn(process.execPath, ["-e", [
    "const {spawnSync}=require('node:child_process'),fs=require('node:fs');",
    "setTimeout(()=>{const r=spawnSync(process.execPath,['-e','process.exit(7)']);",
    "fs.writeFileSync('exit-code.txt',String(r.status));fs.writeFileSync('unique-completion.marker','');},1200);",
  ].join("")], { cwd, detached: true, stdio: "ignore", windowsHide: true });
  const closed = once(helper, "close");
  t.after(async () => {
    if (helper.exitCode === null) helper.kill();
    await closed;
    assert.equal(dirname(await realpath(cwd)), parent);
    await rm(cwd, { recursive: true });
  });
  const signal = new AbortController().signal;
  const first = await waitForCheck(cwd, { path: "unique-completion.marker", timeoutSeconds: 1 }, signal);
  assert.equal(first.ok && first.data.timedOut, true);
  const completed = await waitForCheck(cwd, { path: "unique-completion.marker", timeoutSeconds: 5 }, signal);
  assert.equal(completed.ok && completed.data.timedOut, false);
  assert.equal(await readFile(join(cwd, "exit-code.txt"), "utf8"), "7");
  await closed;
});

test("a check wait times out and rejects paths outside the work directory", async t => {
  const parent = await realpath(tmpdir());
  const cwd = await mkdtemp(join(parent, "ai-taskboard-check-wait-"));
  t.after(async () => {
    assert.equal(dirname(await realpath(cwd)), parent);
    await rm(cwd, { recursive: true });
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await waitForCheck(cwd, { path: "missing.marker", timeoutSeconds: 1 }, signal), {
    ok: true, data: { path: "missing.marker", timedOut: true },
  });
  await writeFile(join(cwd, "finished.marker"), "");
  assert.deepEqual(await waitForCheck(cwd, { path: "finished.marker", timeoutSeconds: 1200 }, signal), {
    ok: true, data: { path: "finished.marker", timedOut: false },
  });
  for (const input of [{ path: "../outside.marker" }, { path: "missing.marker", timeoutSeconds: 1201 }, { path: "." }]) {
    const result = await waitForCheck(cwd, input, signal);
    assert.equal(result.ok ? undefined : result.error.code, "INVALID_INPUT");
  }
});

test("disconnecting the MCP caller aborts a pending check wait", { timeout: 5_000 }, async t => {
  const parent = await realpath(tmpdir());
  const cwd = await mkdtemp(join(parent, "ai-taskboard-check-wait-"));
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<boolean>();
  const mcp = await openBoardMcp([checkWaitTool], async (_name, args, signal) => {
    started.resolve();
    try { return await waitForCheck(cwd, args, signal); }
    finally { ended.resolve(signal.aborted); }
  });
  t.after(async () => {
    await mcp.close();
    assert.equal(dirname(await realpath(cwd)), parent);
    await rm(cwd, { recursive: true });
  });
  const client = new AbortController();
  const request = fetch(/http[^\"]+/.exec(mcp.config)![0], {
    method: "POST", signal: client.signal,
    headers: { authorization: "Bearer " + mcp.env.AI_TASKBOARD_MCP_TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: checkWaitTool.name, arguments: { path: "missing.marker" } } }),
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await started.promise;
  client.abort();
  await rejected;
  assert.equal(await ended.promise, true);
});
