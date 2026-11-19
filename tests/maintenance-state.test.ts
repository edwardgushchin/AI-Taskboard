import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { TaskboardError } from "../src/cli/model.ts";
import type { BoardStore } from "../src/cli/storage.ts";
import { claimMaintenance, maintenanceFailure, maintenanceQueue, maintenanceSuccess, releaseMaintenance } from "../src/cli/maintenance-state.ts";
import type { MaintenanceJob } from "../src/cli/maintenance-state.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-maintenance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = { location: { directory } } as BoardStore;
  const path = join(directory, "maintenance.json");
  const read = (): MaintenanceJob[] => JSON.parse(readFileSync(path, "utf8"));
  const due = () => {
    const jobs = read();
    for (const job of jobs) {
      job.retryAt = 0;
    }
    writeFileSync(path, JSON.stringify(jobs));
  };
  return { store, path, read, due };
}

const dirty = (changes = ["? unknown.txt"]) => new TaskboardError("DIRTY_WORKTREE", "Local changes remain.",
  { path: "managed/T-0001", changes });
const id = "T-0001:cleanup";

test("old repeated dirty faults stay excluded after reopen, expiry and stale claims", t => {
  const f = fixture(t);
  for (const old of [{ attempts: 59 }, { attempts: 1, repairAttempts: 2 }]) {
    writeFileSync(f.path, JSON.stringify([{ id, task: "T-0001", operation: "cleanup",
      error: { code: "DIRTY_WORKTREE", message: "Local changes remain.", details: dirty().details },
      retryAt: 0, ...old }]));
    assert.deepEqual(maintenanceQueue(f.store), []);
    const saved = f.read();
    assert.ok(saved[0].repairFingerprint);
    assert.deepEqual(maintenanceQueue(f.store), []);
    assert.equal(claimMaintenance(f.store, id, process.pid), false);
    maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
    f.due();
    assert.deepEqual(maintenanceQueue(f.store), []);
  }
});

test("new dirty fault allows one finished repair per diagnostic, not per cleanup probe", t => {
  const f = fixture(t);
  maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
  maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
  f.due();
  assert.equal(maintenanceQueue(f.store).length, 1);
  assert.equal(claimMaintenance(f.store, id, process.pid), true);
  assert.equal(claimMaintenance(f.store, id, process.pid), false);
  releaseMaintenance(f.store, id, process.pid + 1);
  assert.equal(f.read()[0].owner, process.pid);
  releaseMaintenance(f.store, id, process.pid);
  f.due();
  assert.deepEqual(maintenanceQueue(f.store), []);
  assert.equal(claimMaintenance(f.store, id, process.pid), false);
  maintenanceFailure(f.store, "cleanup", dirty(["? other.txt"]), "T-0001");
  f.due();
  assert.equal(maintenanceQueue(f.store).length, 1);
  assert.equal(claimMaintenance(f.store, id, process.pid), true);
  releaseMaintenance(f.store, id, process.pid);
  f.due();
  assert.deepEqual(maintenanceQueue(f.store), []);
  maintenanceSuccess(f.store, "cleanup", "T-0001");
  assert.deepEqual(f.read(), []);
});

test("a changed diagnostic during repair retains its own opportunity and key order is irrelevant", t => {
  const f = fixture(t);
  maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
  f.due();
  assert.equal(claimMaintenance(f.store, id, process.pid), true);
  maintenanceFailure(f.store, "cleanup", dirty(["? changed.txt"]), "T-0001");
  releaseMaintenance(f.store, id, process.pid);
  assert.equal(f.read()[0].repairAttempts, 0);
  f.due();
  assert.equal(claimMaintenance(f.store, id, process.pid), true);
  releaseMaintenance(f.store, id, process.pid);
  maintenanceFailure(f.store, "cleanup", new TaskboardError("DIRTY_WORKTREE", "Local changes remain.",
    { changes: ["? changed.txt"], path: "managed/T-0001" }), "T-0001");
  f.due();
  assert.deepEqual(maintenanceQueue(f.store), []);
});

test("temporary faults back off, allow three repairs and reset after a reason change", t => {
  const f = fixture(t);
  maintenanceFailure(f.store, "cleanup", new TaskboardError("WORKTREE_ACCESS_DENIED", "Busy"), "T-0001");
  assert.deepEqual(maintenanceQueue(f.store), []);
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.due();
    assert.equal(claimMaintenance(f.store, id, process.pid), true);
    releaseMaintenance(f.store, id, process.pid);
    assert.equal(f.read()[0].repairAttempts, attempt);
    assert.ok(f.read()[0].retryAt > Date.now());
  }
  f.due();
  assert.equal(claimMaintenance(f.store, id, process.pid), false);
  maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
  f.due();
  assert.equal(maintenanceQueue(f.store).length, 1);
});

test("malformed persisted repair state is rejected before use and valid correction recovers", t => {
  const f = fixture(t);
  maintenanceFailure(f.store, "cleanup", dirty(), "T-0001");
  const valid = f.read();
  const invalid = [
    { repairAttempts: "1x" },
    { repairAttempts: "1e0" },
    { repairAttempts: -1 },
    { repairAttempts: 1.5 },
    { repairFingerprint: "a".repeat(63) + "g" },
    { claimedFingerprint: 1 },
  ];
  for (const fields of invalid) {
    writeFileSync(f.path, JSON.stringify([{ ...valid[0], ...fields }]));
    assert.throws(() => maintenanceQueue(f.store), { code: "CORRUPT_STORAGE" });
  }
  writeFileSync(f.path, JSON.stringify([{ ...valid[0], repairAttempts: 0, retryAt: 0 }]));
  assert.equal(maintenanceQueue(f.store).length, 1);
});
