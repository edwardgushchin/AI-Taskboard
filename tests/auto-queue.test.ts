import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReadyTask } from "../src/desktop/auto-queue.ts";
import type { QueueTask } from "../src/desktop/auto-queue.ts";

const task = (id: string, extra: Partial<QueueTask> = {}): QueueTask => ({ id, status: "ready", priority: "normal", ...extra });
const milestone = (number: number) => ({ repository: "owner/repo", number, title: "Release" });
test("ready selection compares deadlines, priority and milestone dates before readiness or column position", () => {
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
  winner({ dueDate: "2026-11-18", priority: "low" }, { dueDate: "2026-11-19", priority: "urgent" });
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
