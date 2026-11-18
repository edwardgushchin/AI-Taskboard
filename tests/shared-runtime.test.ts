import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeBoard, locateBoard, onBoard, withLock } from "../src/cli/storage.ts";
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
  const review = b.acquire(alias, "reviewer", { reviewer: 2 }, "review:T-0002")!;
  assert.ok(review, "a review can run while the work limit is full");
  assert.equal(a.acquire(project, "reviewer", undefined, "T-0002"), undefined);
  assert.equal(a.acquire(project, "reviewer", undefined, "review:T-0003"), undefined);
  review();
  first(); first(); assert.equal(b.available(alias, "executor"), 0);
  second(); assert.equal(b.available(alias, "executor"), 1);
  onBoard(locateBoard(project), store => { store.index.settings.taskLimits = { executor: 0, manager: 2 }; store.saveIndex(); });
  assert.equal(b.available(alias, "executor"), Infinity); assert.equal(b.available(alias, "manager"), Infinity);
  const discussion = a.claim(project, "T-0003")!; assert.ok(discussion);
  assert.equal(b.acquire(alias, "executor", undefined, "T-0003"), undefined);
  assert.equal(b.available(other, "manager"), Infinity);
  discussion();
  assert.equal(runtimeEntries(project).filter(entry => entry.kind === "slot" || entry.kind === "task").length, 0);
});

test("runtime snapshots and reservations stay responsive during a board transaction", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-runtime-lock-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  const location = locateBoard(project, true);
  initializeBoard(location, () => {});
  const slots = createAgentSlots(true);
  slots.remember(project);
  withLock(location.directory, () => {
    assert.equal(slots.available(project, "executor"), 3);
    const release = slots.acquire(project, "executor", undefined, "T-0001")!;
    assert.ok(release);
    assert.equal(runtimeEntries(project).some(entry => entry.task === "T-0001"), true);
    release();
    assert.equal(runtimeEntries(project).some(entry => entry.task === "T-0001"), false);
  });
});


test("manager context and reviewer capacity are shared with another process", t => {
  const scratch = mkdtempSync(join(tmpdir(), "taskboard-manager-pool-"));
  t.after(() => rmSync(scratch, { recursive: true, maxRetries: 5 }));
  const project = join(scratch, "board"); mkdirSync(project);
  initializeBoard(locateBoard(project, true), () => {});
  const slots = createAgentSlots(true); slots.remember(project);
  slots.configure({ executor: 1, manager: 1, reviewer: 1 });
  const writer = slots.claim(project, "manager:context")!;
  const reviewer = slots.acquire(project, "reviewer", undefined, "review:other")!;
  const source = `import {createAgentSlots} from ${JSON.stringify(new URL("../src/desktop/agent-limits.ts", import.meta.url).href)};
    const slots=createAgentSlots(true), project=process.argv[1]; slots.remember(project);
    const writer=slots.claim(project,'manager:context'), reviewer=slots.acquire(project,'reviewer',undefined,'T-0001');
    console.log(JSON.stringify({writer:Boolean(writer),reviewer:Boolean(reviewer),executor:slots.available(project,'executor'),manager:slots.available(project,'manager')===Infinity}));
    writer?.(); reviewer?.();`;
  const probe = () => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", source, project], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  try { assert.deepEqual(probe(), { writer: false, reviewer: false, executor: 1, manager: true }); }
  finally { reviewer(); writer(); }
  assert.deepEqual(probe(), { writer: true, reviewer: true, executor: 1, manager: true });
});
