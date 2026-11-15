import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sha256, writeJson } from "../src/cli/storage.ts";

const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
test("incident recovery: success, refusal matrix, and interrupted commit", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "T-0077-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const cli = (args: string[], input?: unknown, project = root) => {
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "--project", project, "--json", ...args,
      ...(input ? ["--stdin"] : [])], { input: input ? JSON.stringify(input) : undefined, encoding: "utf8", windowsHide: true,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()) } });
    assert.ok(run.stdout, run.stderr);
    return JSON.parse(run.stdout);
  };
  const initialized = cli(["init"], { git: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  assert.equal(initialized.data.project, root);
  const created = cli(["create"], { title: "First" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const task = created.data;
  assert.ok(task.id);
  const cancelled = cli(["cancel", task.id], { revision: task.revision, reason: "Disposable fixture" });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const path = join(root, ".tasks/tasks/" + task.id + ".json");
  const card = JSON.parse(readFileSync(path, "utf8"));
  card.workingDirectory = join(root, "T-0068-live-absent");
  writeJson(path, card);
  const indexPath = join(root, ".tasks/board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.unknown = { keep: "yes" };
  writeJson(indexPath, index);
  const pendingPath = join(root, ".tasks/pending/" + task.id + ".start.sqlite");
  writeFileSync(pendingPath, "");
  const fingerprint = (relative: string) => { const bytes = readFileSync(join(root, relative)); return { path: relative, bytes: bytes.length, sha256: sha256(bytes) }; };
  const manifest = { schema: 1, targetRoot: root, boardIndex: fingerprint(".tasks/board.json"), nextId: index.nextId,
    cards: [{ ...fingerprint(".tasks/tasks/" + task.id + ".json"), identity: { id: card.id, revision: card.revision } }],
    pending: [fingerprint(".tasks/pending/" + task.id + ".start.sqlite")] };
  const beforeCard = readFileSync(path), beforeIndex = readFileSync(indexPath);
  const unchanged = () => { assert.deepEqual(readFileSync(path), beforeCard); assert.deepEqual(readFileSync(indexPath), beforeIndex); };
  const refuse = (m: unknown) => { assert.equal(cli(["recover-test-data"], { manifest: m, apply: true }).ok, false); unchanged(); };
  assert.equal(cli(["recover-test-data"], { manifest }).data.dryRun, true); unchanged();
  refuse({ ...manifest, targetRoot: root + "-wrong" });
  refuse({ ...manifest, nextId: index.nextId + 1 });
  refuse({ ...manifest, boardIndex: { ...manifest.boardIndex, sha256: "0".repeat(64) } });
  refuse({ ...manifest, cards: [{ ...manifest.cards[0], sha256: "0".repeat(64) }] });
  refuse({ ...manifest, cards: [{ ...manifest.cards[0], identity: { id: card.id, revision: card.revision + 1 } }] });
  refuse({ ...manifest, cards: [manifest.cards[0], manifest.cards[0]] });
  refuse({ ...manifest, pending: [] });
  refuse({ ...manifest, cards: [{ ...manifest.cards[0], modifiedAt: "2000-01-01T00:00:00.000Z" }] });
  assert.equal(cli(["recover-test-data"], { manifest }, join(root, ".tasks")).ok, false); unchanged();
  assert.equal(cli(["recover-test-data"], { manifest, apply: "true" }).ok, false); unchanged();
  for (const change of [{ codexThreadId: "active-thread" }, { status: "in_progress" },
    { workingDirectory: root }, { artifacts: [{ path: "anything" }] }]) {
    writeJson(path, { ...card, ...change });
    const altered = { ...manifest, cards: [{ ...manifest.cards[0], ...fingerprint(".tasks/tasks/" + task.id + ".json") }] };
    assert.equal(cli(["recover-test-data"], { manifest: altered, apply: true }).ok, false);
    writeFileSync(path, beforeCard);
    unchanged();
  }
  const unrelatedLockPath = join(root, ".tasks/pending/T-9999.start.sqlite");
  const unrelatedLock = new DatabaseSync(unrelatedLockPath);
  unrelatedLock.exec("BEGIN IMMEDIATE");
  try { assert.equal(cli(["recover-test-data"], { manifest }).ok, true); }
  finally { unrelatedLock.close(); }
  assert.equal(existsSync(unrelatedLockPath), true);
  const lock = new DatabaseSync(pendingPath);
  lock.exec("BEGIN IMMEDIATE");
  try { refuse(manifest); } finally { lock.close(); }
  // A second public card references the fixture through an unknown field.
  const other = cli(["create"], { title: "Preserved" }).data;
  const otherPath = join(root, ".tasks/tasks/" + other.id + ".json");
  const otherCard = JSON.parse(readFileSync(otherPath, "utf8"));
  writeJson(otherPath, { ...otherCard, unknownReference: task.id });
  const updatedIndex = fingerprint(".tasks/board.json");
  const current = { ...manifest, boardIndex: updatedIndex, nextId: index.nextId + 1 };
  assert.equal(cli(["recover-test-data"], { manifest: current, apply: true }).ok, false);
  writeJson(otherPath, otherCard);
  const keptCard = readFileSync(otherPath);
  // Before-index interruption leaves every original intact.
  const journalPath = join(root, ".tasks/test-recovery.json");
  writeJson(journalPath, { root, before: updatedIndex.sha256, after: "0".repeat(64), files: [] });
  assert.equal(cli(["show", task.id]).ok, true); assert.equal(existsSync(journalPath), false);
  const result = cli(["recover-test-data"], { manifest: current, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(path), false); assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(readFileSync(otherPath), keptCard);
  const afterIndex = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.deepEqual(afterIndex.unknown, index.unknown);
  assert.deepEqual(afterIndex.settings, index.settings);
  assert.equal(afterIndex.nextId, current.nextId);
  assert.equal(cli(["recover-test-data"], { manifest: current, apply: true }).ok, false);
  // After-index interruption resumes idempotent deletion, including files already absent.
  writeFileSync(path, beforeCard);
  writeJson(journalPath, { root, before: updatedIndex.sha256, after: sha256(readFileSync(indexPath)),
    files: [{ path: "tasks/" + task.id + ".json", sha256: manifest.cards[0].sha256 },
      { path: "pending/" + task.id + ".start.sqlite", sha256: manifest.pending[0].sha256 }] });
  writeFileSync(path, Buffer.concat([beforeCard, Buffer.from("\n")]));
  const conflict = cli(["doctor"]);
  assert.equal(conflict.error.code, "RECOVERY_CONFLICT");
  assert.equal(existsSync(path), true); assert.equal(existsSync(journalPath), true);
  writeFileSync(path, beforeCard);
  assert.equal(cli(["doctor"]).ok, true);
  assert.equal(existsSync(path), false); assert.equal(existsSync(journalPath), false);
  assert.equal(Number(cli(["create"], { title: "Next" }).data.id.slice(2)), current.nextId);
});
