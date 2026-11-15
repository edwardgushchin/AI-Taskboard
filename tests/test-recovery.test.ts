import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { locateBoard, onBoard, sha256, writeJson } from "../src/cli/storage.ts";
import { recoverTestData } from "../src/cli/test-recovery.ts";

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

test("recovery and journal continuation exclude a competing start until pending deletion", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "T-0077-race-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()) };
  const cli = (args: string[], input?: unknown) => {
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", entry, "--project", root, "--json", ...args,
      ...(input ? ["--stdin"] : [])], { input: input ? JSON.stringify(input) : undefined, encoding: "utf8", windowsHide: true, env });
    assert.ok(run.stdout, run.stderr);
    return JSON.parse(run.stdout);
  };
  assert.equal(cli(["init"], { git: true }).data.project, root);
  const card = cli(["create"], { title: "First" }).data;
  assert.equal(cli(["cancel", card.id], { revision: card.revision, reason: "Fixture" }).ok, true);
  const other = cli(["create"], { title: "Unrelated" }).data;
  const location = locateBoard(root);
  const cardPath = join(root, ".tasks/tasks/" + card.id + ".json");
  writeJson(cardPath, { ...JSON.parse(readFileSync(cardPath, "utf8")), workingDirectory: join(root, "T-0068-live-absent") });
  const pendingPath = join(root, ".tasks/pending/" + card.id + ".start.sqlite");
  writeFileSync(pendingPath, "");
  const indexPath = join(root, ".tasks/board.json"), journalPath = join(root, ".tasks/test-recovery.json");
  const originalCard = readFileSync(cardPath), originalIndex = readFileSync(indexPath), originalPending = readFileSync(pendingPath);
  const index = JSON.parse(originalIndex.toString());
  const fingerprint = (path: string) => ({ path, bytes: readFileSync(join(root, path)).length, sha256: sha256(readFileSync(join(root, path))) });
  const manifest = { schema: 1, targetRoot: root, nextId: index.nextId, boardIndex: fingerprint(".tasks/board.json"),
    cards: [{ ...fingerprint(".tasks/tasks/" + card.id + ".json"), identity: { id: card.id } }],
    pending: [fingerprint(".tasks/pending/" + card.id + ".start.sqlite")] };
  const storageUrl = new URL("../src/cli/storage.ts", import.meta.url).href;
  const prelude = `import {withTaskStartLock} from ${JSON.stringify(storageUrl)}; const location=${JSON.stringify(location)};`;
  const attempt = (id = card.id) => {
    const script = prelude + `try { withTaskStartLock(location,${JSON.stringify(id)},()=>process.stdout.write('acquired'),0); }
      catch(error) { process.stdout.write(error.code); }`;
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module"],
      { input: script, encoding: "utf8", windowsHide: true, env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  // Start wins and remains parked before requesting the board lock.
  const holder = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval",
    prelude + `import {readSync} from 'node:fs'; withTaskStartLock(location,${JSON.stringify(card.id)},()=>{
      process.stdout.write('held'); readSync(0,Buffer.alloc(1),0,1,null); });`], { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(holder, "exit");
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  const afterIndex = structuredClone(index); delete afterIndex.tasks[card.id];
  const afterBytes = Buffer.from(JSON.stringify(afterIndex, null, 2) + "\n");
  const journal = { root, before: sha256(originalIndex), after: sha256(afterBytes),
    files: [...manifest.cards, ...manifest.pending].map(file => ({ path: file.path.slice(7), sha256: file.sha256 })) };
  try {
    assert.equal(String((await once(holder.stdout, "data"))[0]), "held");
    assert.equal(attempt(other.id), "acquired", "a held task lock must not serialize other starts");
    for (const apply of [false, true]) {
      assert.equal(cli(["recover-test-data"], { manifest, apply }).ok, false);
      assert.deepEqual(readFileSync(indexPath), originalIndex);
      assert.deepEqual(readFileSync(cardPath), originalCard);
      assert.deepEqual(readFileSync(pendingPath), originalPending);
      assert.equal(existsSync(journalPath), false);
    }
    // Both journal phases refuse before touching index, originals, or journal.
    writeJson(journalPath, journal);
    const savedJournal = readFileSync(journalPath);
    for (const bytes of [originalIndex, afterBytes]) {
      writeFileSync(indexPath, bytes);
      assert.equal(cli(["doctor"]).error.code, "BOARD_BUSY");
      assert.deepEqual(readFileSync(indexPath), bytes);
      assert.deepEqual(readFileSync(journalPath), savedJournal);
      assert.deepEqual(readFileSync(cardPath), originalCard);
      assert.deepEqual(readFileSync(pendingPath), originalPending);
    }
  } finally {
    holder.stdin.end("x");
    await exited;
  }
  assert.equal(holder.exitCode, 0);
  // Recovery wins. Attempt another process's start at the exact journal commit
  // and pending unlink boundaries, rather than relying on scheduler timing.
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  let commits = 0, deletions = 0;
  fs.renameSync = (source, target) => {
    if (String(target) === journalPath) { commits++; assert.equal(attempt(), "BOARD_BUSY"); }
    return rename(source, target);
  };
  fs.unlinkSync = path => {
    if (String(path) === cardPath) assert.equal(attempt(), "BOARD_BUSY");
    if (String(path) === pendingPath) { deletions++; assert.equal(attempt(), "BOARD_BUSY"); }
    return unlink(path);
  };
  syncBuiltinESMExports();
  try {
    onBoard(location, store => assert.equal(store.doctor(false).issues.length, 0));
    assert.equal(deletions, 1, "journal continuation must hold the start gate through unlink");
    assert.equal(existsSync(cardPath), false); assert.equal(existsSync(pendingPath), false);
    assert.equal(attempt(), "TASK_NOT_FOUND"); assert.equal(existsSync(pendingPath), false);
    // Restore only this isolated fixture to exercise the initial application.
    writeFileSync(indexPath, originalIndex); writeFileSync(cardPath, originalCard); writeFileSync(pendingPath, originalPending);
    onBoard(location, store => assert.equal(recoverTestData(store, { manifest, apply: true }).dryRun, false));
    assert.equal(commits, 1); assert.equal(deletions, 2);
    assert.equal(existsSync(cardPath), false); assert.equal(existsSync(pendingPath), false);
    assert.equal(attempt(), "TASK_NOT_FOUND"); assert.equal(existsSync(pendingPath), false);
    // A selected card may never have had a pending file (as in incident T-0003).
    writeFileSync(indexPath, originalIndex); writeFileSync(cardPath, originalCard);
    onBoard(location, store => recoverTestData(store, { manifest: { ...manifest, pending: [] }, apply: true }));
    assert.equal(existsSync(pendingPath), false);
    writeFileSync(cardPath, originalCard);
    writeFileSync(journalPath, JSON.stringify({ ...journal, files: journal.files.filter(file => file.path.startsWith("tasks/")) }));
    onBoard(location, store => assert.equal(store.doctor(false).issues.length, 0));
    assert.equal(existsSync(cardPath), false); assert.equal(existsSync(pendingPath), false);
    assert.equal(attempt(), "TASK_NOT_FOUND"); assert.equal(existsSync(pendingPath), false);
  } finally { fs.renameSync = rename; fs.unlinkSync = unlink; syncBuiltinESMExports(); }
});
