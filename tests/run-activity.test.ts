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
