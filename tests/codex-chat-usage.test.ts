import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRpc } from "../src/desktop/codex-rpc.ts";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";

test("task discussion streams task usage before success, provider failure, or a disconnect", async t => {
  const folder = mkdtempSync(join(tmpdir(), "ai-taskboard-chat-usage-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const stub = join(folder, "server.cjs");
  writeFileSync(stub, `
    const send = value => console.log(JSON.stringify(value));
    const outcome = process.argv[2];
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const { id, method } = JSON.parse(line);
      if (id === undefined) return;
      let result = {};
      if (method === "model/list") result = { data: [{ model: "selected", defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === "thread/start") result = { thread: { id: "root" }, model: "actual" };
      if (method === "turn/start") {
        send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn-1" } } });
        const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10 };
        const notify = () => send({ method: "thread/tokenUsage/updated", params: { threadId: "root", turnId: "turn-1", tokenUsage: { total: counts, last: counts, modelContextWindow: 1000 } } });
        if (outcome !== "unknown") { notify(); notify(); }
        result = { turn: { id: "turn-1", status: "inProgress" } };
        send({ id, result });
        if (outcome === "closed") { process.stdin.destroy(); return; }
        send({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "root", model: "child-model" } } });
        send({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
        if (outcome !== "unknown") send({ method: "thread/tokenUsage/updated", params: { threadId: "child", turnId: "child-turn", tokenUsage: { total: counts, last: counts } } });
        send({ method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } });
        send({ method: "item/completed", params: { threadId: "root", item: { type: "agentMessage", text: "Reply" } } });
        send({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn-1", status: outcome === "failed" ? "failed" : "completed", error: { message: "Provider failed" } } } });
        return;
      }
      send({ id, result });
    });
  `);
  const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  for (const outcome of ["ok", "unknown", "failed", "closed", "storage-failed"]) {
    const reports: TokenUsageReport[] = [];
    const runtime = runInNewContext(stripTypeScriptTypes(source) + "\n({ replyToTask })", {
      spawn, codexRpc, CodexTokenUsage, setTimeout, clearTimeout,
      configuredCodex: async () => ({ path: process.execPath, args: [stub, outcome] }),
      chatTools: [], saveChatImages: async () => [],
      cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    });
    const reply = runtime.replyToTask("profile", folder, { model: "selected", effort: "low" }, "Prompt", [],
      () => {}, async () => ({ ok: true }), folder, 1024, async (report: TokenUsageReport) => {
        if (outcome === "storage-failed") throw new Error("Usage storage denied");
        reports.push(report);
      });
    if (["failed", "closed", "storage-failed"].includes(outcome)) {
      await assert.rejects(reply, /Provider failed|process closed|Usage storage denied/);
    } else {
      const answer = await reply;
      assert.equal(answer.text, "Reply");
      assert.equal(answer.usage?.used, outcome === "unknown" ? undefined : 120);
    }
    if (outcome === "storage-failed") continue;
    const report = reports.at(-1)!;
    assert.equal(new Set(reports.map(report => report.id)).size, 1);
    const root = report.records.find(record => record.threadId === "root")!;
    assert.equal(root.model, "actual");
    assert.equal(root.totalTokens, outcome === "unknown" ? null : 120);
    assert.equal(root.incomplete, outcome !== "ok");
    if (outcome !== "closed") {
      const child = report.records.find(record => record.threadId === "child")!;
      assert.equal(child.model, "child-model");
      assert.equal(child.incomplete, outcome === "unknown");
    }
  }
});
