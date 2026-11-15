import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configuredCodex } from "../src/desktop/codex.ts";
import { codexRpc } from "../src/desktop/codex-rpc.ts";
import { managerCodexArgs, boardCodexArgs } from "../src/desktop/board-agent-hooks.ts";
import { openBoardMcp } from "../src/desktop/board-mcp.ts";
import { executorToolConfig, providerActions, providerTools, verifyExecutorTools } from "../src/desktop/provider-tools.ts";
import { callCli } from "../src/desktop/cli.ts";
import type { Task } from "../src/cli/model.ts";

test("live provider: request, assignment, real MCP call, process restart and task isolation", {
  skip: process.env.TASKBOARD_LIVE_PROVIDER !== "1", timeout: 240_000,
}, async t => {
  const client = await configuredCodex(process.cwd());
  assert.ok(client);
  const root = mkdtempSync(join(tmpdir(), "T-0068-live-"));
  t.after(() => { if (existsSync(root)) rmSync(root, { recursive: true }); });
  const owned = new Set<string>();
  const ids: string[] = [];
  const ref = { server: "openaiDeveloperDocs", tool: "list_openai_docs" };
  const local = await openBoardMcp([{ name: "task_tool_request", description: "Request a tool for this task",
    inputSchema: { type: "object", properties: {}, additionalProperties: true } }],
  async (_name, args) => callCli(root, ["tool-request", ids[0]], args));
  const command = async <T>(args: string[], input?: unknown) => {
    const reply = await callCli<T>(root, args, input);
    assert.ok(reply.ok, reply.ok ? "" : reply.error.code);
    return reply.data;
  };
  async function server(manager: boolean, callback: (rpc: ReturnType<typeof codexRpc>) => Promise<void>) {
    const child = spawn(client!.path, [...client!.args, ...(manager ? managerCodexArgs : boardCodexArgs), "-c", local.config], {
      cwd: root, windowsHide: true, stdio: "pipe", env: { ...(client!.env ?? process.env), ...local.env },
    });
    const closed = once(child, "close");
    child.stderr.resume();
    const rpc = codexRpc(child, () => {});
    const timeout = setTimeout(() => rpc.fail(new Error("Live provider timed out")), 90_000);
    try {
      await rpc.request("initialize", { clientInfo: { name: "ai_taskboard", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      rpc.send({ method: "initialized" });
      await callback(rpc);
    } finally { clearTimeout(timeout); rpc.close(); child.stdin.end(); child.kill(); await closed; }
  }
  try {
    const initialized = await command<{ project: string }>(["init"], { git: true });
    assert.equal(initialized.project, root);
    for (const title of ["First", "Second"]) {
      const task = await command<Task>(["create"], { title, criteria: ["Verify provider tool access"], workingDirectory: root });
      ids.push(task.id);
      await command(["approve", task.id], { revision: task.revision });
      await command(["start", task.id]);
    }
    console.log("Fixture tasks", ids);
    await server(true, async rpc => {
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", { cwd: root, ephemeral: true, sandbox: "read-only" });
      const id = started.thread.id;
      const catalog = await providerTools(rpc.request, id, root);
      const effective = await rpc.request<{ config: { mcp_servers: Record<string, unknown> } }>("config/read", { cwd: root, includeLayers: false });
      const configured = Object.keys(effective.config.mcp_servers).filter(name => name !== "ai_taskboard");
      assert.ok(configured.every(name => catalog.tools.some(tool => tool.server === name)));
      console.log("Configured MCP servers", configured.length, "retained", configured.length,
        "apps", catalog.tools.filter(tool => tool.kind === "app").length);
      const selected = catalog.tools.find(t => t.server === ref.server && t.tool === ref.tool);
      assert.equal(selected?.assignable, true, "Configured docs MCP is required for this live check");
      console.log("Provider", client!.version, "catalog entries", catalog.tools.length);
      const requested = await rpc.request<{ isError?: boolean; content?: { text?: string }[] }>("mcpServer/tool/call", { threadId: id,
        server: "ai_taskboard", tool: "task_tool_request", arguments: { ...ref, reason: "Read the public API docs" } });
      assert.equal(requested.isError, false, JSON.stringify(requested.content));
      const inbox = await command<{ id: string; kind: string }[]>(["manager-inbox"]);
      assert.ok(inbox.some(m => m.id === ids[0] && m.kind === "question"));
      const task = await command<Task>(["show", ids[0]]);
      const result = await providerActions(root, rpc.request, id)("task_tool_grant", { id: task.id, revision: task.revision, ...ref });
      assert.ok(result.ok);
      assert.equal((result.data as { restartRequired: boolean }).restartRequired, true);
      assert.equal((result.data as { applied: boolean }).applied, false);
    });
    let threadId: string;
    for (const resumed of [false, true]) await server(false, async rpc => {
      const task = await command<Task>(["show", ids[0]]);
      assert.deepEqual(task.toolGrants, [ref]);
      const config = await executorToolConfig(rpc.request, root, task.toolGrants);
      const started = await rpc.request<{ thread: { id: string } }>(resumed ? "thread/resume" : "thread/start", {
        cwd: root, sandbox: "read-only", approvalPolicy: "on-request", config,
        ...(resumed ? { threadId: threadId! } : { historyMode: "paginated" }),
      });
      threadId = started.thread.id; owned.add(threadId);
      await verifyExecutorTools(rpc.request, threadId, task.toolGrants);
      const status = await rpc.request<{ data: { name: string; tools: object }[] }>("mcpServerStatus/list", { threadId });
      assert.deepEqual(Object.keys(status.data.find(row => row.name === ref.server)!.tools), [ref.tool],
        "Assignment must not expose other tools from the same server");
      const called = await rpc.request<{ isError?: boolean; content?: unknown[] }>("mcpServer/tool/call", {
        threadId, server: ref.server, tool: ref.tool, arguments: { limit: 1 },
      });
      assert.notEqual(called.isError, true);
      assert.ok(called.content?.length, "Real docs MCP must return content");
      if (!resumed) {
        await rpc.request("turn/start", { threadId, input: [{ type: "text", text: "Reply OK only. Do not use tools or read files." }] });
        for (;;) { const message = await rpc.receive(); if (message.method === "turn/completed") {
          assert.equal((message.params as { turn: { status: string } }).turn.status, "completed"); break;
        } }
        await rpc.request("thread/unsubscribe", { threadId });
      } else { await rpc.request("thread/delete", { threadId }); owned.delete(threadId); }
      console.log(resumed ? "Resumed real MCP call passed" : "New real MCP call passed");
    });
    await server(false, async rpc => {
      const task = await command<Task>(["show", ids[1]]);
      assert.equal(task.toolGrants, undefined);
      const config = await executorToolConfig(rpc.request, root, task.toolGrants);
      assert.equal(config.mcp_servers[ref.server].enabled, false);
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", { cwd: root, ephemeral: true, sandbox: "read-only", config });
      const rows = await rpc.request<{ data: { name: string; tools: object }[] }>("mcpServerStatus/list", { threadId: started.thread.id });
      assert.ok(!rows.data.some(row => row.name === ref.server && Object.keys(row.tools).length));
      await verifyExecutorTools(rpc.request, started.thread.id, []);
      console.log("Other task has no external docs tools; local board retained");
    });
  } finally {
    try { if (owned.size) await server(false, async rpc => {
      for (const threadId of owned) {
        try { await rpc.request("thread/delete", { threadId }); }
        catch { await assert.rejects(rpc.request("thread/read", { threadId }), /no rollout found|thread not loaded/); }
      }
    }); } finally { await local.close(); rmSync(root, { recursive: true }); assert.equal(existsSync(root), false); }
  }
});
