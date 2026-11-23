import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readReviewerChat, readReviewerChatPage, withReviewerChat } from "../src/desktop/reviewer-chat.ts";

test("reviewer chat displays the active attempt and retains every success and failure after it ends", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = await mkdtemp(join(tmpdir(), "taskboard-reviewer-chat-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, ".tasks"));
  const task = "T-0042";
  const item = { id: "message", type: "agentMessage", text: "Checking the submitted changes.",
    title: "", status: "completed" };
  assert.deepEqual(readReviewerChat(project, task), []);
  let updates = 0;
  await withReviewerChat(project, task, () => updates++, async publish => {
    assert.equal(readReviewerChat(project, task)[0]?.durationMs, undefined);
    for (let index = 0; index < 50; index++) publish([{ ...item, text: String(index) }]);
    publish([item]);
    assert.equal(updates, 1, "a burst only schedules one update");
    t.mock.timers.tick(100);
    assert.equal(updates, 2);
    assert.deepEqual(readReviewerChat(project, task)[0]?.items, [item]);
    assert.deepEqual(readReviewerChat(project, "T-0043"), []);
  });
  assert.equal(updates, 3);
  assert.ok(Number.isInteger(readReviewerChat(project, task)[0]?.durationMs));
  assert.deepEqual(readReviewerChat(project, task)[0]?.items, [item]);
  for (let index = 0; index < 9; index++) {
    await withReviewerChat(project, task, () => {}, async () => {});
  }
  await assert.rejects(withReviewerChat(project, task, () => {}, async () => { throw new Error("Provider disconnected"); }),
    /Provider disconnected/);
  const history = readReviewerChat(project, task);
  assert.equal(history.length, 11);
  const latest = readReviewerChatPage(project, task);
  assert.equal(latest.attempts.length, 10);
  assert.ok(latest.before);
  const older = readReviewerChatPage(project, task, latest.before);
  assert.deepEqual(older.attempts.map(attempt => attempt.items), [[item]]);
  assert.equal(older.before, undefined);
  assert.ok(older.attempts[0]?.finishedAt);
  assert.equal(history.at(-1)?.error, "Provider disconnected");
});
