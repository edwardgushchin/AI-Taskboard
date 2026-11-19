import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createWithAttachments, readAttachment, readTask, sweepArchives } from "../src/cli/archive.ts";
import { BoardStore, initializeBoard, locateBoard, withLock } from "../src/cli/storage.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";
import { BackupService } from "../src/desktop/backup-service.ts";
import { backupHour, backupLifetime, createBackup, restoreBackup, verifyBackup } from "../src/desktop/board-backups.ts";
import { managerUnread, readManagerHistory, saveManagerHistory } from "../src/desktop/manager-history.ts";

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

test("a failed settings write leaves a due hourly backup retryable and shows the last success", async t => {
  const { project, profile } = fixture(t);
  const previous = Date.now();
  let now = previous;
  const service = new BackupService(profile, () => now);
  await service.create(project);
  service.automatic(project, true);
  now += backupHour;
  renameSync(service.preferences, service.preferences + "-saved");
  mkdirSync(service.preferences);

  await service.tick();
  assert.match(service.status(project).error ?? "", /Expected a regular file.*board-backup-settings\.json/);
  assert.equal(service.status(project).lastSuccess, previous);
  assert.equal(service.status(project).nextAutomatic, now);
  assert.equal(service.status(project).backups.length, 1);

  // A manual snapshot is still usable when only the preference file is blocked.
  await assert.rejects(service.create(project), /board-backup-settings\.json/);
  assert.equal(service.status(project).lastSuccess, now);
  assert.equal(service.status(project).backups.length, 2);
  fs.rmdirSync(service.preferences);
  renameSync(service.preferences + "-saved", service.preferences);
  now++;
  await service.tick();
  assert.equal(service.status(project).error, undefined);
  assert.equal(service.status(project).lastSuccess, now);
  assert.equal(service.status(project).nextAutomatic, now + backupHour);
  assert.equal(service.status(project).backups.length, 3);
});

test("a snapshot defers between the unread marker and the manager reply write", t => {
  const { project, profile, parent, store } = fixture(t);
  const root = join(profile, "board-backups");
  const now = Date.now();
  const runId = randomUUID();
  const unread = join(store.location.directory, "manager-unread.json");
  const runPath = join(store.location.directory, "manager-chat", now + "-" + runId + ".json");
  const rename = fs.renameSync;
  const attempts = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    rename(from, to);
    if (to === unread) {
      assert.equal(existsSync(runPath), false);
      assert.throws(() => createBackup(root, project, now), { code: "BOARD_BUSY" });
    }
  });
  syncBuiltinESMExports();
  try {
    assert.equal(saveManagerHistory(project, now, runId, {
      lane: "chat",
      items: [{ id: "reply", type: "agentMessage", phase: "final_answer", status: "completed", title: "", text: "Hello" }],
    }), true);
    assert.equal(attempts.mock.calls.filter(call => call.arguments[1] === unread).length, 1);
  } finally {
    attempts.mock.restore();
    syncBuiltinESMExports();
  }
  const saved = createBackup(root, project, now);
  const restored = restoreBackup(root, saved.id, parent, now);
  assert.deepEqual(managerUnread(restored), ["reply"]);
  assert.equal(readManagerHistory(restored, null, "chat")?.turns[0]?.items[0]?.text, "Hello");
});

test("restoring retains cards and pauses automatic work in external directories", t => {
  const { project, profile, parent, store } = fixture(t);
  const now = Date.now();
  const root = join(profile, "board-backups");
  const schedule = { everyMinutes: 10, nextAt: new Date(now - 1).toISOString() };
  for (const [index, phase] of (["queued", "running", "failed"] as const).entries()) {
    const draftDiscussion = phase === "failed" ? { phase, reason: "Previous failure" } : { phase };
    store.create({ ...createTask("T-000" + (index + 1), { title: phase }), draftDiscussion });
  }
  store.create({
    ...createTask("T-0004", { title: "Returned from discussion" }),
    status: "in_progress",
    discussionReturn: 1,
    workingDirectory: profile,
  });
  store.create({
    ...createTask("T-0005", { title: "Due schedule" }),
    status: "ready",
    schedule,
    workingDirectory: profile,
  });
  const saved = createBackup(root, project, now);
  const restored = new BoardStore(locateBoard(restoreBackup(root, saved.id, parent, now)));
  assert.equal(restored.card("T-0001").draftDiscussion, undefined);
  assert.equal(restored.card("T-0002").draftDiscussion, undefined);
  assert.deepEqual(restored.card("T-0003").draftDiscussion, store.card("T-0003").draftDiscussion);
  assert.equal(restored.card("T-0004").status, "in_progress");
  assert.equal(restored.card("T-0004").discussionReturn, undefined);
  assert.equal(restored.card("T-0005").status, "ready");
  assert.deepEqual(restored.card("T-0005").schedule, { ...schedule, paused: true });
  assert.deepEqual(restored.card("T-0005").workingDirectory, store.card("T-0005").workingDirectory);
  assert.equal(store.card("T-0004").discussionReturn, 1);
  assert.deepEqual(store.card("T-0005").schedule, schedule);
  assert.deepEqual(verifyBackup(root, saved.id, now), saved);
});
