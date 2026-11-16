import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeBoard, locateBoard, onBoard } from "../src/cli/storage.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { projectIdentity } from "../src/desktop/project-tabs.ts";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";

test("shared defaults, overrides and canonical aliases use one pool without interrupting current leases", t => {
  const scratch = mkdtempSync(join(tmpdir(), "taskboard-shared-limits-"));
  t.after(() => rmSync(scratch, { recursive: true, maxRetries: 5 }));
  const project = join(scratch, "board"), alias = join(scratch, "alias"), other = join(scratch, "other");
  for (const path of [project, other]) { mkdirSync(path); initializeBoard(locateBoard(path, true), () => {}); }
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  const a = createAgentSlots(true), b = createAgentSlots(true);
  a.configure({ executor: 2, manager: 1, reviewer: 1 }); a.remember(project); b.remember(alias); b.remember(other);
  assert.equal(b.available(alias, "executor"), 2);
  const first = a.acquire(project, "executor", undefined, "T-0001")!;
  assert.ok(first); assert.equal(b.acquire(alias, "executor", undefined, "T-0001"), undefined);
  const second = b.acquire(projectIdentity(alias), "executor", undefined, "T-0002")!; assert.ok(second);
  a.configure({ executor: 1, manager: 1, reviewer: 1 });
  assert.equal(b.inherited(alias).executor, 1); assert.equal(b.available(alias, "executor"), 0);
  assert.equal(runtimeEntries(alias).filter(entry => entry.kind === "slot").length, 2);
  first(); first(); assert.equal(b.available(alias, "executor"), 0);
  second(); assert.equal(b.available(alias, "executor"), 1);
  onBoard(locateBoard(project), store => { store.index.settings.agentLimits = { executor: 0, manager: 2 }; store.saveIndex(); });
  assert.equal(b.available(alias, "executor"), Infinity); assert.equal(b.available(alias, "manager"), 2);
  const discussion = a.claim(project, "T-0003")!; assert.ok(discussion);
  assert.equal(b.acquire(alias, "executor", undefined, "T-0003"), undefined);
  assert.equal(b.available(other, "manager"), 1);
  discussion();
  assert.equal(runtimeEntries(project).filter(entry => entry.kind === "slot" || entry.kind === "task").length, 0);
});
