import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyAcceptance } from "../src/cli/acceptance.ts";
import { readTask, sweepArchives } from "../src/cli/archive.ts";
import { record } from "../src/cli/model.ts";
import { initializeBoard, locateBoard, onBoard } from "../src/cli/storage.ts";
import { createTask } from "../src/cli/tasks.ts";
import { registerRuntime } from "../src/desktop/board-runtime.ts";
import { archiveAcceptedCodexChats, rememberTaskCodexThread } from "../src/desktop/codex-task-archive.ts";

test("acceptance archives dedicated Codex threads after their writers release the card", async t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-codex-archive-")));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const location = locateBoard(project, true);
  assert.equal(location.root, project);
  const service = randomUUID();
  const reviewer = randomUUID();
  const unrelated = randomUUID();
  const { id, oldId } = initializeBoard(location, store => {
    const card = store.create(createTask(store.allocateId(), { title: "Archive after acceptance" }));
    const old = createTask(store.allocateId(), { title: "Previously accepted" });
    const accepted = store.create(record({ ...old, codexThreadId: unrelated }, "accept", "user", "done"));
    return { id: card.id, oldId: accepted.id };
  });
  rememberTaskCodexThread(project, id, service);
  rememberTaskCodexThread(project, id, reviewer);
  rememberTaskCodexThread(project, id, service);
  assert.throws(() => rememberTaskCodexThread(project, id, " " + unrelated));

  const calls: string[] = [];
  let fail = true;
  const run = (cardId = id) => archiveAcceptedCodexChats(project, project, cardId, async (_profile, _project, threadId) => {
    calls.push(threadId);
    if (fail && threadId === service) throw new Error("Simulated Codex failure");
    return true;
  });
  const card = () => onBoard(location, store => readTask(store, id));
  const move = (action: string, status: "review" | "blocked" | "in_progress") => onBoard(location, store =>
    store.save(record(store.card(id), action, "agent", status)));
  move("submit", "review");
  await run();
  move("request-changes", "in_progress");
  await run();
  move("pause", "blocked");
  await run();
  await run(oldId);
  assert.deepEqual(calls, []);

  const done = onBoard(location, store => {
    const review = record({
      ...store.card(id), workingDirectory: project, codexThreadId: unrelated,
      result: { summary: "Checked", checks: [], limitations: [], noChanges: { head: null } },
    }, "submit", "agent", "review");
    return applyAcceptance(store, review, { revision: review.revision });
  });
  assert.equal(done.status, "done");
  assert.deepEqual(done.codexArchivePending, [service, reviewer]);

  const nested = join(project, "no-board");
  mkdirSync(nested);
  await archiveAcceptedCodexChats(project, nested, id, async (_profile, _project, threadId) => {
    calls.push(threadId);
    return true;
  });
  assert.deepEqual(calls, []);

  const release = registerRuntime(project, { kind: "slot", role: "reviewer", task: "review:" + id });
  assert.ok(release);
  try {
    await run();
    assert.deepEqual(calls, []);
  } finally {
    release();
  }
  await run();
  assert.deepEqual(calls, [service, reviewer]);
  assert.deepEqual(card().codexArchivePending, [service]);
  assert.equal(card().revision, done.revision);

  onBoard(location, store => {
    store.index.settings.archiveAfterDays = 0;
    store.saveIndex();
    sweepArchives(store, new Date(Date.now() + 86_400_000));
    assert.ok(store.index.archive[id]);
  });
  fail = false;
  await run();
  await run();
  assert.deepEqual(calls, [service, reviewer, service]);
  assert.equal(card().codexArchivePending, undefined);
  assert.equal(card().codexThreadId, unrelated);
  assert.deepEqual(card().history, done.history);
  assert.equal(card().result?.summary, "Checked");
});
