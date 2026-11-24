import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Task } from "../src/cli/model.ts";
import { initializeBoard, locateBoard, onBoard, withLock } from "../src/cli/storage.ts";
import { cachedTaskLimits, createAgentSlots, readProfileTaskLimits } from "../src/desktop/agent-limits.ts";
import { projectIdentity } from "../src/desktop/project-tabs.ts";
import { forgetExecutor, matchesQueuedExecutor, prepareQueuedTurn, queueWriteProbeRetry, recordWriteProbeRetryFailure,
  runtimeEntries, runtimeTransaction } from "../src/desktop/board-runtime.ts";
import { confirmFixtureDraft, plannedDraft } from "./fixtures/planned-draft.ts";

test("comments and priority changes retain saved manual executor requests", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-manual-first-launch-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  initializeBoard(locateBoard(project, true), () => {});
  const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const command = (args: string[], input?: Record<string, unknown>) => {
    const result = spawnSync(process.execPath,
      [cliPath, "--project", project, "--json", ...args, ...(input ? ["--stdin"] : [])],
      { encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout).data;
  };
  const taskCommand = (args: string[], input?: Record<string, unknown>): Task => command(args, input);
  const { id } = taskCommand(["create"], plannedDraft({
    title: "Manual first launch", criteria: ["Keep the assigned directory"], workingDirectory: project,
  }));
  confirmFixtureDraft(project, id);
  taskCommand(["approve", id]);
  taskCommand(["start", id], { actor: "user", queueExecutor: true });
  const queued = () => runtimeEntries(project).find(entry => entry.kind === "queue" && entry.task === id);
  const first = queued();
  assert.ok(first);
  assert.deepEqual(first.earlyLaunch, { cwd: project });

  // Recreate the queue entry shape written before the metadata was added.
  runtimeTransaction(project, entries => {
    const entry = entries.find(candidate => candidate.id === first.id);
    assert.ok(entry);
    delete entry.earlyLaunch;
  });
  for (const text of ["First comment", "Second comment"]) {
    const task = taskCommand(["comment", id], { text });
    const pending = queued();
    assert.ok(pending);
    assert.deepEqual(pending.earlyLaunch, { cwd: project });
    assert.equal(pending.revision, first.revision);
    assert.ok(matchesQueuedExecutor(pending, task));
  }
  forgetExecutor(project, id);
  taskCommand(["comment", id], { text: "Comment after stopping the launch" });
  assert.equal(queued(), undefined);

  const codexThreadId = "01234567-1234-5678-1234-123456789012";
  const linked = taskCommand(["update", id], { codexThreadId });
  taskCommand(["start", id], { actor: "user", queueExecutor: true, revision: linked.revision });
  const pending = queued();
  assert.ok(pending && matchesQueuedExecutor(pending, linked));
  const promoted = taskCommand(["update", id], { revision: linked.revision, priority: "urgent" });
  assert.equal(promoted.priority, "urgent");
  const preserved = queued();
  assert.ok(preserved && matchesQueuedExecutor(preserved, promoted));
  assert.ok(matchesQueuedExecutor(preserved, linked));

  const question = command(["expert-message", id], {
    to: "manager", kind: "question", text: "Continue with the current fixture?",
  });
  const reply = { actor: "manager", to: id, replyTo: question.sequence, text: "Yes, continue." };
  const result = command(["expert-message", id], reply);
  assert.deepEqual(command(["expert-message", id], reply), result);
  const inbox = command(["expert-inbox", id], { afterSequence: question.sequence });
  assert.deepEqual(inbox.messages.map((mail: { replyTo: number }) => mail.replyTo), [question.sequence]);
  const fresh = taskCommand(["show", id]);
  assert.equal(fresh.codexThreadId, codexThreadId);
  assert.equal(fresh.revision, promoted.revision);
  assert.deepEqual(queued(), preserved);
});

test("write probe retry persists its delay and respects shared slots and cancellation", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-write-probe-retry-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  initializeBoard(locateBoard(project, true), () => {});
  const first = createAgentSlots(true);
  first.configure({ executor: 1, manager: 0, reviewer: 1 });
  first.remember(project);
  const task = { id: "T-0001", revision: 4, status: "in_progress" as const };
  const initial = first.acquire(project, "executor", undefined, task.id);
  assert.ok(initial?.id);
  const retry = { cwd: project, fullAccess: false, windowsSandbox: "mxc" as const, notBefore: Date.now() + 60_000 };
  assert.ok(queueWriteProbeRetry(project, initial.id, task, retry, undefined, undefined));
  initial();

  const reopened = createAgentSlots(true);
  reopened.remember(project);
  const pending = runtimeEntries(project).find(entry => entry.kind === "queue");
  assert.ok(pending);
  assert.deepEqual(pending.writeProbeRetry, retry);
  assert.ok(matchesQueuedExecutor(pending, { ...task, revision: 5 }));
  assert.equal(matchesQueuedExecutor(pending, { ...task, status: "blocked" }), false);
  assert.equal(reopened.acquire(project, "executor", undefined, task.id, task.revision), undefined);
  runtimeTransaction(project, entries => {
    const queued = entries.find(entry => entry.id === pending.id);
    assert.ok(queued?.writeProbeRetry);
    queued.writeProbeRetry.notBefore = 0;
  });

  const occupied = first.acquire(project, "executor", undefined, "T-0002");
  assert.ok(occupied);
  assert.equal(reopened.acquire(project, "executor", undefined, task.id, task.revision), undefined);
  occupied();
  const attempt = reopened.acquire(project, "executor", undefined, task.id, task.revision);
  assert.ok(attempt?.id);
  assert.equal(first.acquire(project, "executor", undefined, task.id, task.revision), undefined);
  assert.ok(recordWriteProbeRetryFailure(project, attempt.id, task, "retry interrupted"));
  assert.equal(runtimeEntries(project).find(entry => entry.id === pending.id)?.writeProbeRetry?.failure, "retry interrupted");
  const threadId = "01234567-1234-5678-1234-123456789012";
  const turn = prepareQueuedTurn(project, task, threadId);
  assert.ok(turn);
  assert.equal(turn.recover, false);
  attempt("quota");
  const recovery = first.acquire(project, "executor", undefined, task.id, task.revision);
  assert.ok(recovery?.id);
  assert.deepEqual(prepareQueuedTurn(project, task, threadId), { ...turn, recover: true });
  assert.equal(recordWriteProbeRetryFailure(project, recovery.id, task, "wrong chat", { unconfirmedTurn: true }), false);
  assert.equal(recordWriteProbeRetryFailure(project, recovery.id, task, "old reply", { rejectedClientId: "another-request" }), false);
  assert.ok(recordWriteProbeRetryFailure(project, recovery.id, task, "server rejected start", { rejectedClientId: turn.clientId }));
  const rejected = runtimeEntries(project).find(entry => entry.id === pending.id);
  assert.equal(rejected?.turnRequest, undefined);
  assert.equal(rejected?.writeProbeRetry?.failure, "server rejected start");
  forgetExecutor(project, task.id);
  assert.equal(queueWriteProbeRetry(project, recovery.id, task, retry, undefined, undefined), false);
  recovery();
  assert.equal(runtimeEntries(project).some(entry => entry.task === task.id), false);
});

test("blocking an unconfirmed write probe turn retains its identity until the card is blocked", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-unconfirmed-write-probe-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  initializeBoard(locateBoard(project, true), () => {});
  const slots = createAgentSlots(true);
  slots.remember(project);
  const threadId = "01234567-1234-5678-1234-123456789012";
  const task = { id: "T-0001", revision: 4, status: "in_progress" as const, codexThreadId: threadId };
  const initial = slots.acquire(project, "executor", undefined, task.id);
  assert.ok(initial?.id);
  assert.ok(queueWriteProbeRetry(project, initial.id, task, {
    cwd: project, fullAccess: true, threadId, notBefore: 0,
  }, undefined, undefined));
  const turn = prepareQueuedTurn(project, task, threadId);
  assert.ok(turn);
  assert.ok(recordWriteProbeRetryFailure(project, initial.id, task, "access revoked", { unconfirmedTurn: true }));
  initial();
  const pending = runtimeEntries(project).find(entry => matchesQueuedExecutor(entry, task));
  assert.equal(pending?.turnRequest?.clientId, turn.clientId);
  assert.equal(pending?.writeProbeRetry?.unconfirmedTurn, true);
  assert.equal(pending?.writeProbeRetry?.failure, "access revoked");
  forgetExecutor(project, task.id);
  assert.equal(runtimeEntries(project).some(entry => matchesQueuedExecutor(entry, task)), false);
});

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

test("a profile save only replaces an older shared task limit", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-profile-limits-"));
  t.after(() => rmSync(project, { recursive: true, maxRetries: 5 }));
  initializeBoard(locateBoard(project, true), () => {});
  const first = createAgentSlots(true), second = createAgentSlots(true);
  first.configure({ executor: 4, manager: 0, reviewer: 3 }, 10);
  first.remember(project);
  const active = first.acquire(project, "executor", undefined, "T-0001");
  assert.ok(active);
  try {
    second.configure({ executor: 1, manager: 0, reviewer: 1 }, 20);
    second.remember(project);
    first.remember(project);
    // A save that reached the shared lock late must also keep the newer limits.
    first.configure({ executor: 2, manager: 0, reviewer: 2 }, 15);
    assert.equal(first.available(project, "executor"), 0);
    assert.equal(first.acquire(project, "executor", undefined, "T-0002"), undefined);
    assert.equal(first.available(project, "reviewer"), 1);
    assert.deepEqual(second.inherited(project), { executor: 1, manager: 0, reviewer: 1 });
  } finally {
    active();
  }
  assert.equal(second.available(project, "executor"), 1);
});

test("legacy profile limits replace undated caches but respect a newer explicit save", t => {
  const profile = mkdtempSync(join(tmpdir(), "taskboard-legacy-limits-"));
  t.after(() => rmSync(profile, { recursive: true, maxRetries: 5 }));
  const path = join(profile, "task-limits.json");
  const legacyLimits = { executor: 1, manager: 0, reviewer: 1 };
  const modernLimits = { executor: 4, manager: 0, reviewer: 2 };
  writeFileSync(path, JSON.stringify(legacyLimits));
  utimesSync(path, 100, 100);
  const preference = readProfileTaskLimits(profile);
  assert.ok(preference);
  const legacyCache = { id: "task-defaults", owner: 0, kind: "defaults" as const,
    limits: { executor: 5, manager: 0, reviewer: 1 } };
  const builtInCache = { ...legacyCache, id: "task-defaults-v2", limits: { executor: 3, manager: 0, reviewer: 2 } };
  assert.deepEqual(cachedTaskLimits([legacyCache], preference), legacyLimits);
  assert.deepEqual(cachedTaskLimits([builtInCache], preference), legacyLimits);
  assert.deepEqual(cachedTaskLimits([{ ...builtInCache, limits: modernLimits, limitsSavedAt: 100_001 }], preference), modernLimits);
  writeFileSync(path, JSON.stringify({ ...legacyLimits, savedAt: 100_000 }));
  utimesSync(path, 200, 200);
  assert.deepEqual(cachedTaskLimits([{ ...builtInCache, limits: modernLimits, limitsSavedAt: 100_001 }],
    readProfileTaskLimits(profile)), modernLimits);
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
