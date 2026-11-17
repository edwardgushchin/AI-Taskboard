import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Task, BoardSettings } from "../src/cli/model.ts";
import { automationDelivery } from "../src/desktop/automation-delivery.ts";

test("automation delivers state changes, retains events during a failed steer and stops with its manager", async t => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const board = {
    settings: { autoMode: true, reviewMode: "reviewer", archiveAfterDays: null, integrationMode: "merge" } as BoardSettings,
    tasks: [{ id: "T-0001", title: "First", status: "ready", priority: "normal", revision: 1 } as Task],
    managerInbox: [] as { id: string; sequence: number; kind: string }[],
  };
  let running = false, reviewing = false, wakes = 0;
  const delivered: string[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let failed = false;
  const delivery = automationDelivery(async text => {
    if (!failed) {
      failed = true;
      entered.resolve();
      await release.promise;
      throw Error("Temporary steer failure");
    }
    delivered.push(text);
  }, () => { wakes++; }, controller.signal);
  const observe = () => delivery.observe(board, () => ({ running, reviewing }));
  observe();
  await entered.promise;
  running = true;
  board.tasks[0].status = "in_progress";
  observe();
  running = false;
  reviewing = true;
  board.tasks[0].status = "review";
  observe();
  delivery.event({ error: "Review needs a decision" });
  delivery.event({ error: "Review needs a decision" });
  release.resolve();
  for (let attempt = 0; !delivered.length && attempt < 30; attempt++) await delay(100);
  assert.equal(wakes, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /"status":"ready"/);
  assert.match(delivered[0], /"running":true/);
  assert.match(delivered[0], /"reviewing":true/);
  assert.match(delivered[0], /Review needs a decision/);
  assert.equal(delivered[0].split("Review needs a decision").length - 1, 1);
  observe();
  await delay(400);
  assert.equal(delivered.length, 1, "unchanged observations do not resend");
  board.settings.autoMode = false;
  observe();
  await delay(400);
  assert.match(delivered[1], /"enabled":false/);
  controller.abort();
  board.settings.autoMode = true;
  observe();
  await delay(400);
  assert.equal(delivered.length, 2);
});
