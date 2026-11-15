import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openBoardMcp } from "../src/desktop/board-mcp.ts";
import { checkWaitTool, waitForCheck } from "../src/desktop/check-wait.ts";

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
  for (const input of [{ path: "../outside.marker" }, { path: "missing.marker", timeoutSeconds: 301 }, { path: "." }]) {
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
