import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import type { Task } from "../src/cli/model.ts";
import { emptyTokenCounts } from "../src/cli/token-usage.ts";
import { callCli } from "../src/desktop/cli.ts";
import { TokenUsageQueue } from "../src/desktop/token-usage-queue.ts";
import { plannedDraft } from "./fixtures/planned-draft.ts";

const nativeSpawn = childProcess.spawn;
const unknownSpawn = () => Object.assign(new Error("spawn UNKNOWN private-path"), {
  code: "UNKNOWN", errno: -4094, syscall: "spawn",
});

async function successful<T = unknown>(board: string, args: string[], input?: unknown): Promise<T> {
  const result = await callCli<T>(board, args, input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await wait(25);
  }
  assert.fail("Timed out waiting for token usage recovery");
}

test("CLI reports synchronous UNKNOWN and asynchronous launch failure, and maintenance can try again", async t => {
  const board = mkdtempSync(join(tmpdir(), "taskboard-cli-recovery-"));
  t.after(() => rmSync(board, { recursive: true }));
  childProcess.execFileSync("git", ["init", "--quiet"], { cwd: board });
  await successful(board, ["init"]);
  let failures = 0;
  const mock = t.mock.method(childProcess, "spawn", (file: string, args: string[], options: SpawnOptions) => {
    if (!args.includes("maintenance")) return nativeSpawn(file, args, options);
    failures++;
    if (failures === 1) throw unknownSpawn();
    if (failures === 2) return nativeSpawn(join(board, "missing-executable"), args, options);
    return nativeSpawn(file, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  const sync = await callCli(board, ["maintenance"]);
  assert.ok(!sync.ok);
  assert.equal(sync.error.code, "CLI_UNAVAILABLE");
  assert.deepEqual(sync.error.details, {
    operation: "maintenance", phase: "spawn", platform: process.platform,
    runtime: "source", code: "UNKNOWN", errno: -4094, syscall: "spawn",
  });
  assert.doesNotMatch(JSON.stringify(sync), /private-path/);
  const async = await callCli(board, ["maintenance"]);
  assert.ok(!async.ok);
  assert.equal(async.error.code, "CLI_UNAVAILABLE");
  assert.match(JSON.stringify(async.error.details), /"phase":"error".*"code":"ENOENT"/);
  assert.doesNotMatch(JSON.stringify(async), /missing-executable/);
  await successful(board, ["maintenance"]);
  assert.equal(failures, 3);
});

test("CLI handles EMFILE and ENFILE from a child without stdio", async t => {
  const mock = t.mock.method(childProcess, "spawn", () => {
    const child = new childProcess.ChildProcess();
    const code = mock.mock.callCount() === 0 ? "EMFILE" : "ENFILE";
    assert.equal(child.stdin, undefined);
    assert.equal(child.stdout, undefined);
    assert.equal(child.stderr, undefined);
    process.nextTick(() => {
      child.emit("error", Object.assign(new Error("spawn " + code), { code, syscall: "spawn" }));
      child.emit("close", -1, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  for (const code of ["EMFILE", "ENFILE"]) {
    const result = await callCli(process.cwd(), ["token-usage", "T-0001"], {});
    assert.ok(!result.ok);
    assert.equal(result.error.code, "CLI_UNAVAILABLE");
    assert.deepEqual(result.error.details, {
      operation: "token-usage", phase: "error", platform: process.platform,
      runtime: "source", code, errno: undefined, syscall: "spawn",
    });
  }
  assert.equal(mock.mock.callCount(), 2);
});

test("token reports survive bounded retries and replay once after reopening the queue", async t => {
  const scratch = mkdtempSync(join(tmpdir(), "taskboard-token-recovery-"));
  t.after(() => rmSync(scratch, { recursive: true }));
  const board = join(scratch, "board");
  mkdirSync(board);
  childProcess.execFileSync("git", ["init", "--quiet"], { cwd: board });
  await successful(board, ["init"]);
  const first = await successful<Task>(board, ["create"], plannedDraft({ title: "First report" }));
  const second = await successful<Task>(board, ["create"], plannedDraft({ title: "Second report" }));
  const profile = join(scratch, "profile");
  const pending = join(profile, "pending-token-usage");
  const report = {
    id: "stable-id", sequence: 1, records: [
      { ...emptyTokenCounts(), totalTokens: 17, threadId: "thread", turnId: "turn", model: "model", incomplete: true },
    ],
  };
  let temporaryAttempts = 0;
  let permanentAttempts = 0;
  let recovered = false;
  const mock = t.mock.method(childProcess, "spawn", (file: string, args: string[], options: SpawnOptions) => {
    if (args.includes("token-usage") && !recovered) {
      if (args.includes(second.id)) {
        permanentAttempts++;
        throw unknownSpawn();
      }
      if (++temporaryAttempts === 1) throw unknownSpawn();
    }
    return nativeSpawn(file, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  const queue = new TokenUsageQueue(profile, [10, 20]);
  await Promise.all([queue.enqueue(board, first.id, report), queue.enqueue(board, second.id, report)]);
  await until(() => permanentAttempts === 3 && readdirSync(pending).length === 1);
  await wait(100);
  assert.equal(permanentAttempts, 3);
  assert.equal(temporaryAttempts, 2);
  const saved = JSON.parse(readFileSync(join(pending, readdirSync(pending)[0]), "utf8"));
  assert.equal(saved.report.id, report.id);
  assert.equal(saved.report.sequence, report.sequence);
  assert.equal(saved.failure.code, "CLI_UNAVAILABLE");
  assert.equal(saved.failure.details.code, "UNKNOWN");
  assert.equal((await successful<Task>(board, ["show", second.id])).tokenUsage, undefined);
  recovered = true;
  const restarted = new TokenUsageQueue(profile);
  restarted.restore();
  await restarted.enqueue(board, second.id, report);
  await restarted.enqueue(board, first.id, report);
  assert.deepEqual(readdirSync(pending), []);
  for (const task of [first, second]) {
    const result = await successful<Task>(board, ["show", task.id]);
    assert.equal(result.tokenUsage?.reports.length, 1);
    assert.equal(result.tokenUsage?.byModel[0].totalTokens, 17);
  }

  const config = join(board, ".git", "config");
  const original = readFileSync(config);
  try {
    appendFileSync(config, "\n[broken\n");
    const git = await callCli(board, ["token-usage", first.id], report);
    assert.ok(!git.ok);
    assert.equal(git.error.code, "GIT_FAILED");
    const details = git.error.details as { operation: string; exitCode: number; output: string };
    assert.equal(details.operation, "worktree list");
    assert.equal(details.exitCode, 128);
    assert.match(details.output, /fatal: bad config line/);
    await new TokenUsageQueue(profile, []).enqueue(board, first.id, report);
    const files = readdirSync(pending);
    assert.equal(files.length, 1);
    const deferred = JSON.parse(readFileSync(join(pending, files[0]), "utf8"));
    const configLine = /^fatal: bad config line ([0-9]+) in file /m.exec(details.output)?.[1];
    assert.ok(configLine);
    assert.deepEqual(deferred.failure, {
      code: "GIT_FAILED",
      message: "Invalid Git configuration at line " + configLine + ".",
      details: { operation: "worktree list", exitCode: 128 },
    });
  } finally {
    writeFileSync(config, original);
  }
  new TokenUsageQueue(profile, []).restore();
  await until(() => readdirSync(pending).length === 0);
  const afterGitRecovery = await successful<Task>(board, ["show", first.id]);
  assert.equal(afterGitRecovery.tokenUsage?.reports.length, 1);
  assert.equal(afterGitRecovery.tokenUsage?.byModel[0].totalTokens, 17);
});
