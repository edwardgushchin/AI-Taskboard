import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask, recordRunLog } from "../src/cli/tasks.ts";
import { runActivity, runLog } from "../src/desktop/run-activity.ts";

test("nonzero command exit codes remain visible as failures in collapsed activity groups", () => {
  const item = { id: "command", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "failed", exitCode: 1 };
  const failed = runActivity(new Map(), "item/completed", { item })!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.title, "npm test");
  assert.equal(failed.text, "failed\nExit code: 1");
  assert.equal(runActivity(new Map(), "item/completed", { item: { ...item, exitCode: 0 } })!.status, "completed");
});

test("repeated command snapshots render one exit code and keep streamed output", () => {
  const entries = new Map();
  const command = { id: "command", type: "commandExecution", command: "npm test" };
  const update = (method: string, params: Record<string, unknown>) => {
    const item = runActivity(entries, method, params)!;
    entries.set(item.id, item);
    return item;
  };
  update("item/started", { item: command });
  update("item/commandExecution/outputDelta", { itemId: command.id, delta: "Exit code: 42\nExample output" });
  const completed = { ...command, aggregatedOutput: "", exitCode: 42 };
  const expected = "Exit code: 42\nExample output\nExit code: 42";
  for (let poll = 0; poll < 3; poll++) {
    const item = update("item/completed", { item: completed });
    assert.equal(item.text, expected);
    assert.equal(item.status, "failed");
  }
  const replaced = { ...completed, aggregatedOutput: "Full output", exitCode: 0 };
  assert.equal(update("item/completed", { item: replaced }).text, "Full output\nExit code: 0");
  assert.equal(update("item/completed", { item: { ...replaced, aggregatedOutput: "" } }).status, "completed");
});

test("agent message phases survive streaming updates and completion", () => {
  const entries = new Map();
  const started = runActivity(entries, "item/started", { item: { id: "answer", type: "agentMessage", phase: "final_answer" } })!;
  entries.set(started.id, started);
  const delta = runActivity(entries, "item/agentMessage/delta", { itemId: "answer", delta: "Done" })!;
  entries.set(delta.id, delta);
  const completed = runActivity(entries, "item/completed", { item: { id: "answer", type: "agentMessage", text: "Done" } })!;
  assert.equal(completed.phase, "final_answer");
  assert.equal(completed.text, "Done");
  assert.equal(completed.status, "completed");
});

test("streamed reasoning keeps new summary sections on separate lines", () => {
  const entries = new Map();
  const update = (method: string, params: object) => {
    const item = runActivity(entries, "item/reasoning/" + method, { itemId: "summary", ...params })!;
    entries.set(item.id, item);
    return item;
  };
  update("summaryTextDelta", { summaryIndex: 0, delta: "**Checking the board**" });
  update("summaryPartAdded", { summaryIndex: 1 });
  const next = update("summaryTextDelta", { summaryIndex: 1, delta: "**Preparing the answer**" });
  assert.equal(next.text, "**Checking the board**\n\n**Preparing the answer**");
});


test("review logs retain provider summaries in order across the activity limit", () => {
  const entries = new Map();
  const add = (id: string, type: string, text: string) =>
    entries.set(id, { id, type, title: "", text, status: "completed" });
  add("start", "commandExecution", "before");
  add("summary", "reasoning", "Provider summary");
  for (let index = 0; index < 6; index++) add("tool" + index, "dynamicToolCall", "x".repeat(200));
  add("final", "agentMessage", "Review outcome");
  assert.deepEqual(runLog(entries, 700, true).map(item => item.id), ["truncated", "summary", "truncated", "tool5", "final"]);
  assert.deepEqual(runLog(entries, 700).map(item => item.id), ["truncated", "tool4", "tool5", "final"]);
  entries.delete("summary");
  assert.deepEqual(runLog(entries, 700, true), runLog(entries, 700));
});

test("first event time survives deltas, completion and journal validation", () => {
  const entries = new Map();
  const at = "2026-11-14T21:59:00.000Z";
  const update = (method: string, params: Record<string, unknown>, time?: string) => {
    const item = runActivity(entries, method, params, time)!;
    entries.set(item.id, item);
    return item;
  };
  update("item/started", { item: { id: "message", type: "agentMessage" } }, at);
  assert.equal(update("item/agentMessage/delta", { itemId: "message", delta: "Part" }, "2026-11-14T22:00:00.000Z").at, at);
  const completed = update("item/completed", { item: { id: "message", type: "agentMessage", text: "Done" } }, "2026-11-14T22:01:00.000Z");
  assert.equal(completed.at, at);
  const task = createTask("T-0001", { title: "Timestamp" });
  const saved = JSON.parse(JSON.stringify(recordRunLog(task, { entries: [completed] })));
  assert.equal(saved.history.at(-1).run[0].at, at);
  const deltaFirst = runActivity(new Map(), "item/agentMessage/delta", { itemId: "delta-first", delta: "First" }, at)!;
  assert.equal(deltaFirst.at, at);
  const completedFirst = runActivity(new Map(), "item/completed", { item: { id: "complete-first", type: "agentMessage", text: "Only completion" } }, at)!;
  assert.equal(completedFirst.at, at);
  const legacy = { ...completed, at: undefined };
  assert.equal(recordRunLog(task, { entries: [legacy] }).history.at(-1)!.run![0]!.at, undefined);
  for (const invalid of [null, 123, "", "invalid"]) assert.throws(() => recordRunLog(task, {
    entries: [{ ...completed, at: invalid }],
  }), /valid item timestamp/);
});
