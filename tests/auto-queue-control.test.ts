import { plannedDraft } from "./fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("queue controls persist, reject stale edits and gate an automatic start under the board lock", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-auto-controls-"));
  t.after(() => {
    rmSync(project, { recursive: true, maxRetries: 3 });
    assert.equal(existsSync(project), false);
  });
  const cli = (args: string[], input?: unknown) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", project, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], {
      encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input),
      env: { ...process.env, GIT_CEILING_DIRECTORIES: project },
    });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(cli(["init"], { git: false }).ok, true);
  const task = cli(["create"], plannedDraft({ title: "Controlled task", criteria: ["Done"] })).data;
  const ready = cli(["approve", task.id]).data;
  assert.equal(cli(["settings"], { autoMode: true }).ok, true);
  const controls = cli(["auto-queue"], { revision: 0, order: [task.id], hold: [task.id] });
  assert.equal(controls.ok, true);
  assert.equal(cli(["auto-queue"]).data.revision, 1);
  assert.equal(cli(["auto-queue"], { revision: 0, release: [task.id] }).error.code, "REVISION_CONFLICT");
  assert.equal(cli(["start", task.id], { revision: ready.revision, autoMode: true, autoQueueRevision: 1 }).error.code, "AUTO_QUEUE_PAUSED");
  assert.equal(cli(["show", task.id]).data.status, "ready");
  assert.equal(cli(["auto-queue"], { revision: 1, hold: [task.id], release: [task.id] }).error.code, "INVALID_INPUT");
  assert.equal(cli(["auto-queue"], { revision: 1, release: [task.id] }).ok, true);
  assert.equal(cli(["start", task.id], { revision: ready.revision, autoMode: true, autoQueueRevision: 1 }).error.code, "AUTO_QUEUE_CHANGED");
  assert.equal(cli(["auto-queue"], { revision: 2, paused: true }).ok, true);
  assert.equal(cli(["start", task.id], { revision: ready.revision, autoMode: true, autoQueueRevision: 3 }).error.code, "AUTO_QUEUE_PAUSED");
  assert.equal(cli(["auto-queue"], { revision: 3, paused: false, order: [] }).ok, true);
  assert.equal(cli(["start", task.id], { revision: ready.revision, autoMode: true, autoQueueRevision: 4 }).ok, true);
  assert.equal(cli(["auto-queue"], { revision: 4, hold: [task.id] }).error.code, "INVALID_TRANSITION");
});
