import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReadyTask } from "../src/desktop/auto-queue.ts";
import type { QueueTask } from "../src/desktop/auto-queue.ts";
import { earliestOpenRelease, releaseWait } from "../src/cli/auto-queue.ts";
import { goalQueueCondition } from "../src/desktop/iterative-goal.ts";

const task = (id: string, extra: Partial<QueueTask> = {}): QueueTask => ({ id, status: "ready", priority: "normal", ...extra });
const milestone = (number: number) => ({ repository: "owner/repo", number, title: "Release" });
test("ready selection compares urgency, deadlines, priority and milestone dates before readiness or column position", () => {
  const dates = new Map([[1, "2026-11-20T00:00:00Z"], [2, "2026-11-21T00:00:00Z"]]);
  const winner = (a: Partial<QueueTask>, b: Partial<QueueTask>) => {
    const first = task("T-0002", a), second = task("T-0001", b);
    for (const order of [[first, second], [second, first]]) assert.equal(nextReadyTask(order, dates, () => false)?.id, first.id);
  };
  winner({ dueDate: "2026-11-18" }, { dueDate: "2026-11-19" });
  winner({ dueDate: "2020-01-01" }, { dueDate: "2026-01-01" });
  winner({ dueDate: "2020-01-01" }, {});
  winner({ priority: "urgent" }, { priority: "high" });
  winner({ priority: "high" }, { priority: "normal" });
  winner({ priority: "normal" }, { priority: "low" });
  winner({ milestone: milestone(1) }, { milestone: milestone(2) });
  winner({ milestone: milestone(1) }, {});
  winner({ readySince: "2026-11-01T00:00:00Z" }, { readySince: "2026-11-02T00:00:00Z" });
  winner({ dueDate: "2026-11-19", priority: "urgent" }, { dueDate: "2026-11-18", priority: "low" });
  winner({ dueDate: "2026-11-18", priority: "urgent" }, { dueDate: "2026-11-19", priority: "urgent" });
  const pair = [task("T-0002"), task("T-0001")];
  assert.equal(nextReadyTask(pair, dates, () => false)?.id, "T-0001");
  pair[0].dueDate = "2026-11-18";
  assert.equal(nextReadyTask(pair, dates, () => false)?.id, "T-0002");
  delete pair[0].dueDate;
  pair[0].priority = "high";
  assert.equal(nextReadyTask(pair, dates, () => false)?.id, "T-0002");
  pair[0].priority = "normal";
  pair[0].milestone = milestone(1); pair[1].milestone = milestone(2);
  assert.equal(nextReadyTask(pair, dates, () => false)?.id, "T-0002");
  dates.set(2, "2026-11-19T00:00:00Z");
  assert.equal(nextReadyTask(pair, dates, () => false)?.id, "T-0001");
});

test("ready selection excludes drafts, busy tasks, unfinished dependencies and future schedules", () => {
  const now = Date.parse("2026-11-16T00:00:00Z");
  const future = { everyMinutes: 60, nextAt: "2026-11-17T00:00:00Z" };
  const tasks = [task("T-0001", { status: "draft" }), task("T-0002", { unfinishedDependencies: ["T-9999"] }),
    task("T-0000", { schedule: { ...future, paused: true, nextAt: new Date(now).toISOString() } }),
    task("T-0003", { schedule: future }), task("T-0004"), task("T-0005", { schedule: { ...future, nextAt: new Date(now).toISOString() } })];
  assert.equal(nextReadyTask(tasks, new Map(), id => id === "T-0004", now)?.id, "T-0005");
  tasks[1].unfinishedDependencies = [];
  assert.equal(nextReadyTask(tasks, new Map(), () => false, now)?.id, "T-0002");
});

test("explicit queue ordering and holds preserve eligibility and restore default ordering", () => {
  const tasks = [task("T-0001", { priority: "urgent" }), task("T-0002"), task("T-0003", { unfinishedDependencies: ["T-0001"] })];
  const controls = { revision: 1, paused: false, order: ["T-0003", "T-0002"], held: [] as string[] };
  const next = () => nextReadyTask(tasks, new Map(), () => false, Date.now(), controls)?.id;
  assert.equal(next(), "T-0001");
  controls.held = ["T-0001"];
  assert.equal(next(), "T-0002");
  controls.held = [];
  tasks[1].priority = "urgent";
  assert.equal(next(), "T-0002");
  controls.held = ["T-0002"];
  assert.equal(next(), "T-0001");
  controls.paused = true;
  assert.equal(next(), undefined);
  controls.paused = false;
  controls.order = [];
  controls.held = [];
  assert.equal(next(), "T-0001");
});

test("release eligibility follows SemVer before saved order, deadlines and priority", () => {
  const versions = ["0.1.2-alpha.2", "0.1.2-alpha.10", "0.1.2", "0.1.3-alpha", "0.1.10-alpha"];
  const tasks = versions.map((title, index) => task("T-000" + index, {
    milestone: { ...milestone(index + 1), title },
    dueDate: index ? "2026-01-01" : "2026-12-01",
    priority: index ? "urgent" : "low",
  }));
  const dates = new Map();
  const controls = { revision: 1, paused: false, order: tasks.slice(1).reverse().map(card => card.id), held: [] };
  for (const expected of tasks) {
    assert.equal(nextReadyTask([...tasks].reverse(), dates, () => false, 0, controls), expected);
    expected.status = "done";
  }

  const first = { ...tasks[0], status: "ready" as const };
  const sameRelease = task("T-0100", { milestone: first.milestone });
  const namedMilestone = task("T-0101", { milestone: { ...milestone(9), title: "0.1.2junk" } });
  controls.order.unshift(namedMilestone.id, sameRelease.id);
  assert.equal(nextReadyTask([first, sameRelease], dates, () => false, 0, controls), sameRelease);
  assert.equal(nextReadyTask([first, sameRelease, namedMilestone], dates, () => false, 0, controls), namedMilestone);
});

test("open release work holds later ordinary starts while independent launch paths remain eligible", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  const earlier = task("T-0001", { milestone: { ...milestone(1), title: "0.1.2-alpha" } });
  const later = task("T-0002", { milestone: { ...milestone(2), title: "0.1.3-alpha" } });
  const schedule = { everyMinutes: 60, nextAt: new Date(now).toISOString() };
  const queue = { revision: 1, paused: false, order: [later.id], held: [earlier.id] };
  for (const status of ["ready", "in_progress", "review", "blocked"] as const) {
    earlier.status = status;
    assert.equal(nextReadyTask([earlier, later], new Map(), () => false, now, queue), undefined);
  }
  for (const status of ["draft", "done", "cancelled"] as const) {
    earlier.status = status;
    assert.equal(nextReadyTask([earlier, later], new Map(), () => false, now, queue), later);
  }

  earlier.status = "ready";
  earlier.unfinishedDependencies = [later.id];
  const tasks = [earlier, later];
  assert.deepEqual(releaseWait(later, earliestOpenRelease(tasks)), { version: "0.1.2-alpha", taskIds: [earlier.id] });
  assert.equal(nextReadyTask(tasks, new Map(), () => false, now), undefined);
  const requested = { ...later, launchRequested: true };
  assert.equal(nextReadyTask([earlier, requested], new Map(), () => false, now), requested);
  const scheduled = { ...later, schedule };
  assert.equal(nextReadyTask([earlier, scheduled], new Map(), () => false, now), scheduled);
  assert.equal(nextReadyTask([earlier, scheduled], new Map(), () => false, now - 1), undefined);
  for (const waiting of [{ ...schedule, nextAt: new Date(now + 1).toISOString() }, { ...schedule, paused: true }]) {
    earlier.schedule = waiting;
    assert.equal(nextReadyTask(tasks, new Map(), () => false, now), later);
  }
});

test("the goal reserves ordinary cards that pass the same release gate as dispatch", () => {
  const now = Date.parse("2026-11-21T00:00:00Z");
  const early = task("T-0001", {
    status: "review",
    milestone: { ...milestone(1), title: "0.1.2-alpha" },
  });
  const late = task("T-0002", { milestone: { ...milestone(2), title: "0.1.3-alpha" } });
  const due = task("T-0003", {
    milestone: late.milestone,
    schedule: { everyMinutes: 60, nextAt: new Date(now).toISOString() },
  });
  const unversioned = task("T-0004");
  const planned = [late, due, unversioned];
  const board = [early, ...planned];
  const countReady = () => goalQueueCondition(board, planned, new Set(), 2, now).ready;
  assert.equal(countReady(), 1, "review blocks the ordinary late release and a due schedule is excluded");

  early.status = "ready";
  early.schedule = { everyMinutes: 60, nextAt: new Date(now + 60_000).toISOString() };
  assert.equal(countReady(), 2, "a future early schedule does not hold the ordinary late task");
  early.schedule = { everyMinutes: 60, nextAt: new Date(now).toISOString(), paused: true };
  assert.equal(countReady(), 2, "a paused early schedule does not hold the ordinary late task");
  early.schedule = { everyMinutes: 60, nextAt: new Date(now).toISOString() };
  assert.equal(countReady(), 2, "a due early schedule leaves the ordinary late task eligible");
  assert.equal(releaseWait(late, earliestOpenRelease(board)), undefined);
});

test("an early schedule becoming due leaves both reserve rules and ordinary dispatch unchanged", () => {
  const due = 1_000;
  const release = { ...milestone(1), title: "0.1.2-alpha" };
  const rule = { everyMinutes: 60, nextAt: new Date(due).toISOString() };
  const schedule = task("T-0001", { milestone: release, schedule: rule });
  const early = ["T-0002", "T-0003", "T-0004"].map(id => task(id));
  const later = task("T-0005", { milestone: { ...milestone(2), title: "0.1.3-alpha" } });
  for (const ordinary of [early, [...early, later]]) {
    const cards = [schedule, ...ordinary];
    for (const target of [undefined, 4]) {
      const reserve = (now: number) => goalQueueCondition(cards, cards, new Set(), 2, now, undefined, target);
      schedule.status = "ready";
      schedule.schedule = rule;
      const before = reserve(due - 1);
      assert.equal(before.ready, ordinary.length);
      assert.equal(Boolean(before.waitFor), ordinary.length < 4);
      assert.deepEqual(reserve(due), before);
      assert.equal(nextReadyTask([schedule], new Map(), () => false, due - 1, undefined, cards), undefined);
      assert.equal(nextReadyTask([schedule], new Map(), () => false, due, undefined, cards), schedule);

      schedule.status = "in_progress";
      assert.deepEqual(reserve(due + 1), before);
      schedule.status = "ready";
      schedule.schedule = { ...rule, paused: true };
      assert.deepEqual(reserve(due + 1), before);
      assert.equal(nextReadyTask([schedule], new Map(), () => false, due + 1, undefined, cards), undefined);
      assert.equal(releaseWait(later, earliestOpenRelease(cards)), undefined);
    }
  }
});
