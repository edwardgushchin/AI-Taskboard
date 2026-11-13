import assert from "node:assert/strict";
import { test } from "node:test";
import { runActivity } from "../src/desktop/run-activity.ts";

test("nonzero command exit codes remain visible as failures in collapsed activity groups", () => {
  const item = { id: "command", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "failed", exitCode: 1 };
  const failed = runActivity(new Map(), "item/completed", { item })!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.title, "npm test");
  assert.equal(failed.text, "failed\nExit code: 1");
  assert.equal(runActivity(new Map(), "item/completed", { item: { ...item, exitCode: 0 } })!.status, "completed");
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
