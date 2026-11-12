import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startCodexRun } from "../src/desktop/codex-run.ts";
import { createTask } from "../src/cli/tasks.ts";

test("the Codex launch waits for a real turn, passes execution settings and surfaces startup errors", async t => {
  const folder = mkdtempSync(join(tmpdir(), "ai-taskboard-codex-run-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const stub = join(folder, "codex.cjs");
  const capture = join(folder, "captured.json");
  const thread = "01234567-1234-5678-1234-123456789012";
  writeFileSync(stub, [
    'const fs = require("node:fs");',
    'const [capture, outcome, ...flags] = process.argv.slice(2);',
    'const prompt = fs.readFileSync(0, "utf8");',
    'fs.writeFileSync(capture, JSON.stringify({ cwd: process.cwd(), flags, prompt }));',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: ' + JSON.stringify(thread) + ' }));',
    'if (outcome === "fail") console.error("Could not authenticate");',
    'else console.log(JSON.stringify({ type: "turn.started" }));',
  ].join("\n"));
  const task = { ...createTask("T-0001", { title: "Test task", description: "Проверка" }),
    execution: { model: "test-model", effort: "high" } };
  const client = { path: process.execPath, args: [stub, capture, "ok"], version: "test" };
  assert.equal(await startCodexRun(client, folder, folder, task), thread);
  const launched = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(launched.cwd, folder);
  assert.deepEqual(launched.flags, [
    "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--json",
    "--model", "test-model", "--config", 'model_reasoning_effort="high"', "-",
  ]);
  assert.match(launched.prompt, /T-0001/);
  assert.match(launched.prompt, /Проверка/);
  await assert.rejects(startCodexRun({ ...client, args: [stub, capture, "fail"] }, folder, folder, task),
    /Could not authenticate/);
});
