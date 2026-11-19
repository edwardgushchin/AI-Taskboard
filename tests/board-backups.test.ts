import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWithAttachments, readAttachment, readTask, sweepArchives } from "../src/cli/archive.ts";
import { BoardStore, initializeBoard, locateBoard, withLock } from "../src/cli/storage.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";
import { BackupService } from "../src/desktop/backup-service.ts";
import { backupHour, backupLifetime, createBackup, restoreBackup, verifyBackup } from "../src/desktop/board-backups.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "taskboard-backups-"));
  t.after(() => rmSync(root, { recursive: true }));
  const project = join(root, "demo board");
  const profile = join(root, "profile");
  const parent = join(root, "restore here");
  for (const path of [project, profile, parent]) mkdirSync(path);
  const location = locateBoard(project, true);
  const store = initializeBoard(location, store => store);
  return { project, profile, parent, store };
}

test("manual and hourly generations, expiry, interrupted staging and a failed write", async t => {
  const { project, profile } = fixture(t);
  const start = Date.now();
  let now = start;
  const service = new BackupService(profile, () => now);
  await service.create(project);
  const [manual] = service.status(project).backups;
  service.automatic(project, true);
  now += backupHour - 1;
  await service.tick();
  assert.equal(service.status(project).backups.length, 1);
  now++;
  await service.tick();
  now += backupHour;
  await service.tick();
  const status = service.status(project);
  assert.equal(status.backups.length, 3);
  assert.equal(status.lastSuccess, now);
  assert.deepEqual(status.backups.map(backup => backup.createdAt), [now, start + backupHour, start]);

  renameSync(service.root, service.root + "-saved");
  writeFileSync(service.root, "occupied");
  await assert.rejects(service.create(project));
  assert.ok(service.status(project).error);
  assert.equal(service.status(project).lastSuccess, now);
  rmSync(service.root);
  renameSync(service.root + "-saved", service.root);
  const interrupted = join(service.root, ".creating-ABC123");
  mkdirSync(interrupted);
  assert.deepEqual(await service.verify(manual.id), manual);
  service.automatic(project, false);
  now = start + backupLifetime - 1;
  await service.tick();
  assert.ok(existsSync(join(service.root, manual.id)));
  assert.equal(existsSync(interrupted), false);
  now++;
  await service.tick();
  assert.equal(existsSync(join(service.root, manual.id)), false);
  assert.equal(service.status(project).backups.length, 2);
});

test("copy defers under writer locks and restores only verified board data", t => {
  const { project, profile, parent, store } = fixture(t);
  const { directory: data } = store.location;
  const root = join(profile, "board-backups");
  const journal = join(data, "worklog");
  mkdirSync(journal);
  writeFileSync(join(journal, "entry.md"), "local journal");
  writeFileSync(join(data, "review-history.json"), "[]");
  const source = join(project, "source.txt");
  writeFileSync(source, "uploaded bytes");
  const attachments = [{ path: source }, { path: source, link: true }];
  const active = createWithAttachments(store, createTask("T-0001", { title: "Active" }), attachments);
  const archived = createWithAttachments(store, createTask("T-0002", { title: "Archive" }), attachments);
  store.save(changeTask(archived, "cancel", { reason: "Archive" }));
  store.index.settings.name = "Preserved title";
  store.index.settings.archiveAfterDays = 0;
  store.index.settings.autoMode = true;
  store.saveIndex();
  assert.deepEqual(sweepArchives(store).archived, [archived.id]);
  const now = Date.now();
  const saved = createBackup(root, project, now);
  for (const lock of [data, journal]) {
    withLock(lock, () => {
      assert.throws(() => createBackup(root, project, now), { code: "BOARD_BUSY" });
    });
  }
  assert.throws(() => createBackup(join(project, "nested"), project, now), /outside the project/);
  assert.equal(existsSync(join(root, saved.id, "source.txt")), false);
  assert.equal(existsSync(join(root, saved.id, ".tasks", "pending")), false);

  const damaged = createBackup(root, project, now + 1);
  writeFileSync(join(root, damaged.id, ".tasks", "worklog", "entry.md"), "corrupt");
  assert.throws(() => restoreBackup(root, damaged.id, parent, now + 1), /integrity check failed/);
  assert.equal(existsSync(join(parent, "AI-Taskboard-" + damaged.id)), false);
  renameSync(data, data + "-original");
  const destination = restoreBackup(root, saved.id, parent, now + 1);
  assert.throws(() => restoreBackup(root, saved.id, parent, now + 1), /already exists/);
  const restored = new BoardStore(locateBoard(destination));
  assert.equal(restored.index.settings.autoMode, false);
  assert.equal(restored.index.settings.name, "Preserved title");
  assert.equal(readTask(restored, archived.id).title, archived.title);
  assert.equal(readFileSync(join(restored.location.directory, "worklog", "entry.md"), "utf8"), "local journal");
  assert.equal(readFileSync(join(restored.location.directory, "review-history.json"), "utf8"), "[]");
  for (const task of [active, archived]) {
    const [uploaded, linked] = readTask(restored, task.id).attachments;
    assert.deepEqual(linked.link, task.attachments[1].link);
    const attachment = readAttachment(restored, task.id, { file: uploaded.file });
    assert.ok("base64" in attachment);
    assert.equal(Buffer.from(attachment.base64, "base64").toString(), "uploaded bytes");
  }
  assert.deepEqual(verifyBackup(root, saved.id, now + 1), saved);
  assert.equal(existsSync(data + "-original"), true);
});
