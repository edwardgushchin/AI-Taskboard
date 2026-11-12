import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { codexRpc, turnControl } from "../src/desktop/codex-rpc.ts";
import type { AgentControl } from "../src/desktop/codex-rpc.ts";

const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replaceAll("export function", "function");

test("discussion steering and interruption share the streaming connection, including during a tool call", async t => {
  const directory = mkdtempSync(fileURLToPath(new URL("../.codex-chat-test-", import.meta.url)));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const script = join(directory, "provider.cjs");
  writeFileSync(script, `
    const send = value => console.log(JSON.stringify(value));
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined || !method) return;
      let result = {};
      if (method === 'model/list') result = { data: [{ model: 'test', defaultReasoningEffort: 'low', supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === 'thread/start') result = { thread: { id: 'thread' } };
      if (method === 'turn/start') result = { turn: { id: 'turn', status: 'inProgress' } };
      if (method === 'turn/steer') {
        if (params.expectedTurnId !== 'turn') throw new Error('Wrong turn');
        if (params.input[0].text === 'reject') { send({ id, error: { message: 'No active turn' } }); return; }
        send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', phase: 'commentary', text: params.input[0].text } } });
      }
      send({ id, result });
      if (method === 'turn/start') for (const id of ['tool', 'retry']) send({ id, method: 'item/tool/call', params: { threadId: 'thread', callId: 'call', tool: 'task_update', arguments: {} } });
      if (method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
    });
  `);
  const runtime = runInNewContext(stripTypeScriptTypes(source) + "\nreplyToTask", {
    spawn, codexRpc, turnControl, setTimeout, clearTimeout,
    configuredCodex: async () => ({ path: process.execPath, args: [script] }),
    chatTools: [], cliFailure: () => ({ ok: false }), saveChatImages: async () => [],
  });
  const ready = Promise.withResolvers<AgentControl>();
  const toolStarted = Promise.withResolvers<void>();
  const releaseTool = Promise.withResolvers<{ ok: true }>();
  let toolCalls = 0;
  const commentary: string[] = [];
  const pending = runtime("profile", directory, { model: "test", effort: "low" }, "Initial", [],
    (text: string) => commentary.push(text), () => { toolCalls++; toolStarted.resolve(); return releaseTool.promise; },
    directory, 1000, (control: AgentControl) => ready.resolve(control));
  const control = await ready.promise;
  await toolStarted.promise;
  await control.steer("New details", []);
  assert.deepEqual(commentary, ["New details"]);
  assert.equal(toolCalls, 1);
  await assert.rejects(control.steer("reject", []), /No active turn/);
  await control.interrupt();
  assert.equal((await pending).interrupted, true);
  releaseTool.resolve({ ok: true });
});
