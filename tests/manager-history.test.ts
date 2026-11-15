import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJson } from "../src/cli/storage.ts";
import { managerUnread, readManagerHistory, readManagerMessages, saveManagerHistory } from "../src/desktop/manager-history.ts";
import { readReviewReports, saveReviewReports } from "../src/desktop/review-history.ts";
import type { ReviewedSubmission } from "../src/desktop/board-actions.ts";

function fixture(t: import("node:test").TestContext) {
  const project = mkdtempSync(join(tmpdir(), "ai-taskboard-local-history-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  return project;
}

test("manager history preserves steering order and pages through locally saved runs", t => {
  const project = fixture(t);
  const started = Date.now();
  for (let i = 0; i < 21; i++) {
    saveManagerHistory(project, started + i, randomUUID(), { message: { text: String(i), files: [] }, items: [] });
  }
  const run = randomUUID();
  const steer = randomUUID();
  const file = { name: "example.png", url: "data:image/png;base64,AA==" };
  const line = (id: string, text: string) => ({ id, text, title: "", type: "agentMessage", status: "completed" });
  const message = { text: "Исходный запрос", files: [file] };
  saveManagerHistory(project, started + 21, run, { message, items: [] });
  saveManagerHistory(project, started + 21, run, { message, model: "test", items: [
    line("first", "Checking."),
    { id: steer, text: "Уточнение", title: "", type: "userMessage", status: "completed", userMessage: { text: "Уточнение", files: [] } },
    line("last", "Done."),
  ] });
  const recent = readManagerHistory(project)!;
  assert.equal(recent.model, "test");
  assert.deepEqual(recent.turns.slice(-2), [
    { messages: [message], items: [line("first", "Checking.")] },
    { messages: [{ clientId: steer, text: "Уточнение", files: [] }], items: [line("last", "Done.")], durationMs: undefined },
  ]);
  assert.ok(recent.nextCursor);
  const older = readManagerHistory(project, recent.nextCursor)!;
  assert.deepEqual(older.turns.map(turn => turn.messages[0]?.text), ["0", "1"]);
  assert.equal(older.nextCursor, null);
  assert.throws(() => readManagerHistory(project, "local:../project"), /Invalid manager history cursor/);
});

test("only delivered dialogue replies become unread and repeated saves preserve read status", t => {
  const project = fixture(t);
  const other = fixture(t);
  const at = Date.now();
  const id = randomUUID();
  const reply = { id: "first", type: "agentMessage", title: "", text: "Первый ответ.", phase: "final_answer", status: "completed" } as const;
  const run = { lane: "chat", items: [reply] } as const;
  assert.deepEqual(managerUnread(project), []);
  saveManagerHistory(project, at, id, { ...run, items: [{ ...reply, status: "inProgress" }] });
  saveManagerHistory(project, at + 1, randomUUID(), { lane: "work", items: [reply] });
  assert.deepEqual(managerUnread(project), []);
  assert.equal(saveManagerHistory(project, at, id, { ...run, items: [reply] }), true);
  saveManagerHistory(project, at + 2, randomUUID(), { lane: "notice", items: [{ ...reply, id: "second" }] });
  assert.deepEqual(managerUnread(project), ["first", "second"]);
  assert.deepEqual(managerUnread(other), []);
  assert.equal(readManagerMessages(project, ["unknown", "first"]), true);
  assert.equal(saveManagerHistory(project, at, id, { ...run, items: [reply] }), false);
  assert.deepEqual(managerUnread(project), ["second"]);
  assert.deepEqual(JSON.parse(readFileSync(join(project, ".tasks", "manager-unread.json"), "utf8")), ["second"]);
});

test("review reports move into board storage and a cleared board cache supersedes old profile data", t => {
  const project = fixture(t);
  const profile = join(project, "old-profile");
  const other = join(project, "another-profile");
  mkdirSync(join(profile, "review-history"), { recursive: true });
  const report = {
    submitted: "123", description: "Task", criteria: [], artifacts: [], snapshot: "old",
    report: { summary: "Reviewed", findings: [], evidence: [], needsHuman: false },
  } as unknown as ReviewedSubmission;
  const file = createHash("sha256").update(project).digest("hex") + ".json";
  writeJson(join(profile, "review-history", file), [["T-0001", report]]);
  const live = readReviewReports(profile, project);
  assert.equal(live.get("T-0001")?.report.summary, "Reviewed");
  assert.equal(live.get("T-0001")?.snapshot, undefined);
  saveReviewReports(project, live);
  assert.equal(readReviewReports(other, project).get("T-0001")?.report.summary, "Reviewed");
  saveReviewReports(project, new Map());
  assert.equal(readReviewReports(profile, project).size, 0);
});

test("saved automatic review turns stay in the work view without masquerading as user messages", t => {
  const project = fixture(t);
  const at = Date.now();
  const prompt = "AI Taskboard: ревьюер согласовал следующие сдачи. Открой их через task_review. Сдачи: T-0035 (133)";
  const review = { id: "review", type: "agentMessage", title: "", text: "Задача принята.", status: "completed" };
  saveManagerHistory(project, at, randomUUID(), { message: { text: prompt, files: [] }, items: [review] });
  const question = { text: "Что проверил ревьюер?", files: [] };
  saveManagerHistory(project, at + 1, randomUUID(), { lane: "chat", message: question, items: [] });
  saveManagerHistory(project, at + 2, randomUUID(), {
    message: { text: prompt, files: [], clientId: randomUUID() }, items: [],
  });
  const chat = readManagerHistory(project, null, "chat")!.turns;
  assert.deepEqual(chat.map(turn => turn.messages[0]?.text), [question.text, prompt]);
  assert.deepEqual(readManagerHistory(project, null, "work")!.turns.map(turn => ({ messages: turn.messages, items: turn.items })),
    [{ messages: [], items: [review] }]);
});
