import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  assert.deepEqual(JSON.parse(readFileSync(join(project, ".tasks", "manager-unread.json"), "utf8")).unread, ["second"]);
});

test("legacy provider conversations page local notices without duplicating mirrored chat runs", t => {
  const project = fixture(t);
  const at = Date.now();
  for (let i = 0; i < 25; i++) saveManagerHistory(project, at + i, randomUUID(), {
    lane: i % 2 ? "notice" : "chat", items: [{ id: String(i), type: "agentMessage", title: "", text: String(i), status: "completed" }],
  });
  const notices = readManagerHistory(project, null, "chat", true)!;
  assert.equal(notices.turns.length, 12);
  assert.ok(notices.turns.every(turn => turn.lane === "notice"));
  assert.deepEqual(notices.turns.map(turn => turn.items[0]!.text), Array.from({ length: 12 }, (_, i) => String(2 * i + 1)));
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


test("message timestamps survive saved streaming updates, reopening and older pages", t => {
  const project = fixture(t);
  const at = "2026-11-14T21:59:00.000Z";
  const id = randomUUID();
  const message = { text: "Request", files: [], at };
  const item = { id: "answer", type: "agentMessage", title: "", text: "Part", status: "inProgress", at };
  saveManagerHistory(project, 1, id, { message, items: [item] });
  saveManagerHistory(project, 1, id, { message, items: [{ ...item, text: "Done", status: "completed" }] });
  for (let i = 0; i < 21; i++) saveManagerHistory(project, 2 + i, randomUUID(), {
    message: { text: "Legacy", files: [] }, items: [],
  });
  const recent = readManagerHistory(project)!;
  assert.equal(recent.turns.at(-1)!.messages[0]!.at, undefined);
  const older = readManagerHistory(project, recent.nextCursor)!;
  assert.equal(older.turns[0]!.messages[0]!.at, at);
  assert.equal(older.turns[0]!.items[0]!.at, at);
  assert.equal(older.turns[0]!.items[0]!.text, "Done");
  assert.deepEqual(readManagerHistory(project, recent.nextCursor), older);
});


test("failed unread persistence retries without losing a concurrent arrival", t => {
  const project = fixture(t);
  const reply = (id: string) => ({ id, type: "agentMessage", title: "", text: "Fixture", phase: "final_answer", status: "completed" } as const);
  saveManagerHistory(project, 1, randomUUID(), { lane: "chat", items: [reply("seen")] });
  const path = join(project, ".tasks", "manager-unread.json");
  const backup = path + ".backup";
  renameSync(path, backup);
  mkdirSync(path);
  assert.throws(() => readManagerMessages(project, ["seen"]));
  assert.deepEqual(managerUnread(project), ["seen"]);
  rmSync(path, { recursive: true });
  renameSync(backup, path);
  saveManagerHistory(project, 2, randomUUID(), { lane: "notice", items: [reply("arrival")] });
  assert.equal(readManagerMessages(project, ["seen"]), true);
  assert.deepEqual(managerUnread(project), ["arrival"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).unread, ["arrival"]);
});

test("read position covers unloaded pages, late delivery and restart but preserves newer replies", t => {
  const project = fixture(t);
  const other = fixture(t);
  const reply = (id: string) => ({ id, type: "agentMessage", title: "", text: id, phase: "final_answer", status: "completed" } as const);
  const run = randomUUID();
  for (let i = 1; i <= 25; i++) saveManagerHistory(project, i, randomUUID(), { lane: "chat", items: [reply(String(i))] });
  saveManagerHistory(project, 26, run, { lane: "chat", items: [reply("seen"), reply("newer")] });
  saveManagerHistory(other, 1, randomUUID(), { lane: "chat", items: [reply("other")] });
  assert.ok(readManagerHistory(project)!.nextCursor);
  assert.equal(readManagerMessages(project, ["unknown"]), false);
  assert.equal(managerUnread(project).length, 27);
  readManagerMessages(project, ["seen"]);
  assert.deepEqual(managerUnread(project), ["newer"]);
  saveManagerHistory(project, 100, randomUUID(), { lane: "notice", items: [{ ...reply("late-old"), at: new Date(10).toISOString() }] });
  saveManagerHistory(project, 26, run, { lane: "chat", items: [reply("seen"), reply("newer"), reply("arrival")] });
  readManagerMessages(project, ["1"]);
  assert.deepEqual(managerUnread(project), ["newer", "arrival"]);
  assert.deepEqual(managerUnread(other), ["other"]);
  const module = new URL("../src/desktop/manager-history.ts", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {managerUnread, saveManagerHistory} from ${JSON.stringify(module)}; const project = ${JSON.stringify(project)};
     saveManagerHistory(project, 0, ${JSON.stringify(randomUUID())}, {lane:'notice',items:[${JSON.stringify(reply("late-after-restart"))}]});
     console.log(JSON.stringify(managerUnread(project)));`], { encoding: "utf8", windowsHide: true });
  assert.deepEqual(JSON.parse(result), ["newer", "arrival"]);
  readManagerMessages(project, ["arrival"]);
  assert.deepEqual(managerUnread(project), []);
  assert.equal(readManagerMessages(project, ["seen"]), false);
});

test("legacy unread arrays migrate when a later reply is read", t => {
  const project = fixture(t);
  writeJson(join(project, ".tasks", "manager-unread.json"), ["legacy"]);
  const reply = (id: string) => ({ id, type: "agentMessage", title: "", text: id, phase: "final_answer", status: "completed" } as const);
  saveManagerHistory(project, 1, randomUUID(), { lane: "notice", items: [reply("legacy")] });
  saveManagerHistory(project, 2, randomUUID(), { lane: "chat", items: [reply("later")] });
  readManagerMessages(project, ["later"]);
  const saved = JSON.parse(readFileSync(join(project, ".tasks", "manager-unread.json"), "utf8"));
  assert.deepEqual(saved.unread, []);
  assert.equal(saved.through.at, 2);
});
