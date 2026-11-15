import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sha256, writeJson } from "../src/cli/storage.ts";

test("IPC recovery: exact bytes, dry-run, refusal matrix and preservation", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "T-0084-recovery-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const cli = (command: string, input?: unknown, project = root) => {
    const r = spawnSync(process.execPath, [entry, "--project", project, "--json", command, ...(input ? ["--stdin"] : [])],
      { encoding: "utf8", windowsHide: true, input: input ? JSON.stringify(input) : undefined,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()) } });
    assert.ok(r.stdout, r.stderr); return JSON.parse(r.stdout);
  };
  const initialized = cli("init", { git: true });
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  assert.equal(initialized.data.project, root);
  const indexPath = join(root, ".tasks/board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.nextId = 17; index.unknown = { preserved: true };
  for (const id of ["T-0014", "T-0015", "T-0016"]) {
    copyFileSync(fileURLToPath(new URL(`fixtures/T-0084/${id}.json`, import.meta.url)), join(root, `.tasks/tasks/${id}.json`));
    index.tasks[id] = `tasks/${id}.json`;
  }
  writeJson(indexPath, index);
  const fp = (path: string) => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; };
  const manifest = { schema: 1, incident: "T-0082", targetRoot: root, nextId: 17, boardIndex: fp(".tasks/board.json"),
    cards: Object.keys(index.tasks).map(id => ({ ...fp(`.tasks/tasks/${id}.json`), identity: { id } })), pending: [] as unknown[] };
  const before = readFileSync(indexPath);
  const unchanged = () => { assert.deepEqual(readFileSync(indexPath), before); for (const card of manifest.cards) assert.deepEqual(fp(card.path), { path: card.path, bytes: card.bytes, sha256: card.sha256 }); };
  const refuse = (m: unknown) => { const r = cli("recover-test-data", { manifest: m, apply: true }); assert.equal(r.ok, false, JSON.stringify(r)); unchanged(); };
  assert.equal(cli("recover-test-data", { manifest }).data.dryRun, true); unchanged();
  refuse({ ...manifest, incident: undefined }); // Old profile still forbids usage.
  refuse({ ...manifest, targetRoot: root + "-wrong" });
  refuse({ ...manifest, boardIndex: { ...manifest.boardIndex, sha256: "0".repeat(64) } });
  refuse({ ...manifest, cards: manifest.cards.slice(0, 2) });
  const cardPath = join(root, manifest.cards[0].path), original = readFileSync(cardPath);
  writeFileSync(cardPath, Buffer.concat([original, Buffer.from("\n")]));
  assert.equal(cli("recover-test-data", { manifest, apply: true }).ok, false);
  assert.equal(cli("recover-test-data", { manifest: { ...manifest, cards: [{ ...manifest.cards[0], ...fp(manifest.cards[0].path) }, ...manifest.cards.slice(1)] }, apply: true }).ok, false);
  writeFileSync(cardPath, original); unchanged();
  const pending = join(root, ".tasks/pending/T-0014.start.sqlite"); writeFileSync(pending, "");
  const lockedManifest = { ...manifest, pending: [fp(".tasks/pending/T-0014.start.sqlite")] };
  refuse(manifest);
  const lock = new DatabaseSync(pending); lock.exec("BEGIN IMMEDIATE");
  try { refuse(lockedManifest); } finally { lock.close(); }
  const gate = new DatabaseSync(join(root, ".tasks/.start-gate.sqlite")); gate.exec("BEGIN IMMEDIATE");
  try { refuse(lockedManifest); } finally { gate.close(); }
  // A foreign card in an unknown field prevents even this exact incident profile.
  const other = JSON.parse(original.toString()); other.id = "T-0001"; other.foreignReference = "T-0014";
  writeJson(join(root, ".tasks/tasks/T-0001.json"), other); index.tasks[other.id] = "tasks/T-0001.json"; writeJson(indexPath, index);
  const current = { ...lockedManifest, boardIndex: fp(".tasks/board.json") };
  assert.equal(cli("recover-test-data", { manifest: current, apply: true }).ok, false);
  delete other.foreignReference; writeJson(join(root, ".tasks/tasks/T-0001.json"), other);
  const preserved = readFileSync(join(root, ".tasks/tasks/T-0001.json"));
  const result = cli("recover-test-data", { manifest: current, apply: true }); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.nextId, 17);
  assert.deepEqual(readFileSync(join(root, ".tasks/tasks/T-0001.json")), preserved);
  const after = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.deepEqual(after.unknown, index.unknown); assert.deepEqual(after.settings, index.settings);
  for (const card of manifest.cards) assert.equal(existsSync(join(root, card.path)), false);
  assert.equal(existsSync(pending), false);
  assert.equal(cli("recover-test-data", { manifest: current, apply: true }).ok, false);
});
