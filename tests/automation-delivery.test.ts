import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Task, BoardSettings } from "../src/cli/model.ts";
import { automationDelivery } from "../src/desktop/automation-delivery.ts";

test("automation coalesces internal wakes without a conversation transport", async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const board = {
    settings: { autoMode: true, reviewMode: "reviewer", archiveAfterDays: null, integrationMode: "merge" } as BoardSettings,
    tasks: [{ id: "T-0001", title: "First", status: "ready", priority: "normal", revision: 1 } as Task],
    managerInbox: [] as { id: string; sequence: number; kind: string }[],
  };
  let running = false;
  let reviewing = false;
  let wakes = 0;
  const delivery = automationDelivery(() => { wakes++; }, controller.signal);
  const observe = () => delivery.observe(board, () => ({ running, reviewing }));
  observe();
  running = true;
  board.tasks[0].status = "in_progress";
  observe();
  running = false;
  reviewing = true;
  board.tasks[0].status = "review";
  observe();
  delivery.event({ error: "Review needs a decision" });
  delivery.event({ error: "Review needs a decision" });
  await delay(400);
  assert.equal(wakes, 1);
  assert.deepEqual(delivery.takeErrors(), [{ error: "Review needs a decision" }]);
  assert.deepEqual(delivery.takeErrors(), []);
  observe();
  delivery.event({ error: "Review needs a decision" });
  await delay(400);
  assert.equal(wakes, 1, "unchanged observations and errors do not wake again");
  board.managerInbox.push({ id: "T-0001", sequence: 2, kind: "question" });
  observe();
  await delay(400);
  assert.equal(wakes, 2, "a later question triggers another wake");
  board.settings.autoMode = false;
  observe();
  await delay(400);
  assert.equal(wakes, 3, "turning automation off wakes the current wait");
  controller.abort();
  board.settings.autoMode = true;
  observe();
  await delay(400);
  assert.equal(wakes, 3);
});

test("disposing cancels a pending wake and disabled automation stays silent", async () => {
  const board = { settings: { autoMode: false } as BoardSettings, tasks: [] };
  let wakes = 0;
  const delivery = automationDelivery(() => { wakes++; }, new AbortController().signal);
  const observe = () => delivery.observe(board, () => ({ running: false, reviewing: false }));
  observe();
  delivery.event({ error: "Ignored while disabled" });
  await delay(400);
  assert.equal(wakes, 0);
  board.settings.autoMode = true;
  observe();
  delivery.dispose();
  await delay(400);
  assert.equal(wakes, 0);
});

test("disabled automation wakes an active wait for a current reviewer approval once", async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const board = {
    settings: { autoMode: false, reviewMode: "reviewer-human" } as BoardSettings,
    tasks: [{ id: "T-0001", status: "review", reviewApproved: true }] as (Task & { reviewApproved: boolean })[],
    managerInbox: [{ id: "T-0001", sequence: 7, kind: "review-approve" }],
  };
  let wakes = 0;
  const delivery = automationDelivery(() => { wakes++; }, controller.signal);
  const observe = () => delivery.observe(board, () => ({ running: false, reviewing: false }));
  observe();
  await delay(350);
  assert.equal(wakes, 0);

  board.settings.reviewMode = "reviewer";
  observe();
  observe();
  await delay(350);
  assert.equal(wakes, 1);
  observe();
  await delay(350);
  assert.equal(wakes, 1);
});
