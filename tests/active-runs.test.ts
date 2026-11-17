import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeBoard, locateBoard } from "../src/cli/storage.ts";
import { registerRuntime } from "../src/desktop/board-runtime.ts";
import { activeRunSummary, enableSharedRuns, observeActiveRuns, trackActiveRun } from "../src/desktop/active-runs.ts";

test("real turns retain roles across boards and ignore idle reservations, queue and goal state", t => {
  const scratch = mkdtempSync(join(tmpdir(), "taskboard-tab-activity-"));
  const releases: (() => void)[] = [];
  t.after(() => {
    try { releases.reverse().forEach(release => release()); }
    finally { rmSync(scratch, { recursive: true, maxRetries: 5 }); }
  });
  let events = 0;
  const stop = observeActiveRuns(() => events++);
  t.after(stop);
  const first = trackActiveRun(scratch, "manager"); releases.push(first);
  assert.equal(activeRunSummary().boards[0].roles.manager, 1);
  first(); first(); assert.equal(activeRunSummary().total, 0);
  assert.equal(events, 2);
  initializeBoard(locateBoard(scratch, true), () => {});
  enableSharedRuns();
  const projects = [{ path: scratch, name: "Board" }];
  for (const kind of ["slot", "queue", "task", "provider"] as const) {
    releases.push(registerRuntime(scratch, { kind, role: "manager", task: "manager:work", pid: process.pid,
      state: { id: "paused-goal", phase: "waiting", startedAt: Date.now() } })!);
  }
  assert.equal(activeRunSummary(projects).total, 0);
  const manager = trackActiveRun(scratch, "manager"), executor = trackActiveRun(scratch), reviewer = trackActiveRun(scratch, "reviewer");
  releases.push(manager, executor, reviewer);
  assert.deepEqual(activeRunSummary(projects).boards[0].roles, { manager: 1, executor: 1, reviewer: 1 });
  manager(); reviewer(); // Pausing or ending the manager cannot hide the executor.
  assert.deepEqual(activeRunSummary(projects).boards[0].roles, { manager: 0, executor: 1, reviewer: 0 });
  executor(); assert.equal(activeRunSummary(projects).total, 0);
});
