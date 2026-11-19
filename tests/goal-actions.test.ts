import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { goalMessages, readDialogueReference, saveManagerHistory, sendGoalMessage } from "../src/desktop/manager-history.ts";
import { runGoalAction } from "../src/desktop/goal-actions.ts";

function fixture(t: import("node:test").TestContext) {
  const project = mkdtempSync(join(tmpdir(), "taskboard-goal-actions-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  mkdirSync(join(project, ".tasks"));
  const goal = randomUUID();
  const message = sendGoalMessage(project, goal, "Record a result");
  return { project, goal, message };
}

test("a repeated instruction/action replays its result, while another instruction is independent", async t => {
  const { project, goal, message } = fixture(t);
  let effects = 0;
  const invoke = async () => ({ ok: true as const, data: { effect: ++effects } });
  const input = { goalMessageId: message.id, goalActionKey: "create-card", title: "One card" };
  const first = await runGoalAction(project, goal, "task_create", input, invoke);
  goalMessages(project, goal, { id: message.id, status: "applied", reply: "Recorded" });
  assert.deepEqual(await runGoalAction(project, goal, "task_create", input, invoke), first);
  const conflict = await runGoalAction(project, goal, "task_create", { ...input, title: "Different card" }, invoke);
  assert.ok(!conflict.ok && conflict.error.code === "GOAL_ACTION_CONFLICT");
  const next = sendGoalMessage(project, goal, "Record another result");
  assert.equal((await runGoalAction(project, goal, "task_create", { ...input, goalMessageId: next.id }, invoke)).ok, true);
  assert.equal(effects, 2);
  assert.deepEqual(goalMessages(project, goal).filter(entry => entry.status === "pending").map(entry => entry.id), [next.id]);
});

test("an in-flight or interrupted effect cannot run twice, even without a saved result", async t => {
  const { project, goal, message } = fixture(t);
  const input = { goalMessageId: message.id, goalActionKey: "write" };
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let effects = 0;
  const first = runGoalAction(project, goal, "task_comment", input, async () => {
    effects++;
    started.resolve();
    await finish.promise;
    throw new Error("Interrupted after effect");
  });
  await started.promise;
  const duplicate = await runGoalAction(project, goal, "task_comment", input, async () => {
    effects++;
    return { ok: true, data: null };
  });
  assert.ok(!duplicate.ok && duplicate.error.code === "GOAL_ACTION_UNCERTAIN");
  finish.resolve();
  await assert.rejects(first, /Interrupted after effect/);
  const afterRestart = await runGoalAction(project, goal, "task_comment", input, async () => {
    effects++;
    return { ok: true, data: null };
  });
  assert.ok(!afterRestart.ok && afterRestart.error.code === "GOAL_ACTION_UNCERTAIN");
  assert.equal(effects, 1);
});

test("invalid IDs and keys are rejected before conversion, and corrected input is accepted", async t => {
  const { project, goal, message } = fixture(t);
  let effects = 0;
  const invoke = async (input: unknown) => {
    effects++;
    assert.deepEqual(input, { text: "Result" });
    return { ok: true as const, data: null };
  };
  for (const fields of [
    { goalMessageId: message.id + "x", goalActionKey: "valid" },
    { goalMessageId: " " + message.id, goalActionKey: "valid" },
    { goalMessageId: message.id, goalActionKey: " write " },
    { goalMessageId: message.id, goalActionKey: "../write" },
    { goalMessageId: message.id, goalActionKey: 1 },
  ]) {
    const result = await runGoalAction(project, goal, "task_comment", { ...fields, text: "Result" }, invoke);
    assert.ok(!result.ok && result.error.code === "INVALID_INPUT");
  }
  assert.equal(effects, 0);
  assert.equal((await runGoalAction(project, goal, "task_comment", {
    goalMessageId: message.id, goalActionKey: "write", text: "Result",
  }, invoke)).ok, true);
  assert.equal(effects, 1);
});

test("dialogue reference is bounded, board-local, stable and separate from the instruction inbox", t => {
  const { project, goal, message } = fixture(t);
  const started = Date.now();
  for (let i = 0; i < 45; i++) saveManagerHistory(project, started + i, randomUUID(), {
    lane: "chat", message: { text: "Question " + i, files: [] },
    items: [{ id: "answer-" + i, type: "agentMessage", phase: "final_answer", status: "completed", title: "", text: "x".repeat(3000) }],
  });
  const reference = readDialogueReference(project);
  assert.ok(reference.messages.length <= 40);
  assert.ok(reference.messages.reduce((size, entry) => size + entry.text.length, 0) <= 16_000);
  assert.ok(reference.messages.every(entry => entry.text.length <= 2000 && entry.id && Number.isFinite(Date.parse(entry.at))));
  assert.deepEqual(reference, readDialogueReference(project));
  assert.deepEqual(goalMessages(project, goal).map(entry => entry.id), [message.id]);
});
