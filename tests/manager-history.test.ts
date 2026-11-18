import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { writeJson } from "../src/cli/storage.ts";
import { statusNotice } from "../src/cli/task-messages.ts";
import type { Task } from "../src/cli/model.ts";
import { managerChatItems, managerUnread, managerWorkItems, readManagerDialogue, readManagerHistory, readManagerMessages, saveManagerHistory } from "../src/desktop/manager-history.ts";
import { readReviewReports, saveReviewReports } from "../src/desktop/review-history.ts";
import type { ReviewedSubmission } from "../src/desktop/board-actions.ts";

function fixture(t: import("node:test").TestContext) {
  const project = mkdtempSync(join(tmpdir(), "ai-taskboard-local-history-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  return project;
}

test("paused work history can have several empty filtered pages before saved work", t => {
  const project = fixture(t);
  const at = Date.now();
  saveManagerHistory(project, at, randomUUID(), { lane: "work", items: [
    { id: "saved-work", type: "agentMessage", title: "", text: "Saved work", status: "completed" },
  ] });
  for (let i = 1; i <= 41; i++) saveManagerHistory(project, at + i, randomUUID(), {
    lane: "chat", message: { text: "Dialogue", files: [] }, items: [],
  });
  const first = readManagerHistory(project, null, "work")!;
  assert.equal(first.turns.length, 0);
  assert.ok(first.nextCursor);
  const second = readManagerHistory(project, first.nextCursor, "work")!;
  assert.equal(second.turns.length, 0);
  assert.ok(second.nextCursor);
  const last = readManagerHistory(project, second.nextCursor, "work")!;
  assert.deepEqual(last.turns.flatMap(turn => turn.items.map(item => item.id)), ["saved-work"]);
  assert.equal(last.nextCursor, null);
  assert.ok(!readManagerHistory(project, null, "chat")!.turns.some(turn => turn.items.some(item => item.id === "saved-work")));
});

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

for (const pausedGoal of [false, true]) test(`dialogue reload preserves saved replies ${pausedGoal ? "with the paused legacy goal" : "without a goal"}`, async t => {
  const project = fixture(t);
  const start = Date.now();
  const at = (offset: number) => new Date(start + offset).toISOString();
  const answer = (id: string, text: string, offset: number) => ({
    id, text, at: at(offset), title: "", type: "agentMessage", status: "completed", phase: "final_answer" as const,
  });
  const chat = (id: string, offset: number, text: string) => ({
    lane: "chat" as const, message: { clientId: id, text: id, files: [], at: at(offset) },
    items: text ? [answer(id + "-answer", text, offset + 30)] : [],
  });
  for (let i = 0; i < 22; i++) saveManagerHistory(project, start + i, randomUUID(), chat(`prior-${i}`, i, "Previous reply"));
  const run = randomUUID();
  saveManagerHistory(project, start + 100, run, chat("question", 100, ""));
  const duringStream = await readManagerDialogue(project, null);
  assert.equal(duringStream?.turns.at(-1)?.messages[0]?.text, "question");
  assert.deepEqual(duringStream?.turns.at(-1)?.items, []);
  for (let i = 101; i < 125; i++) saveManagerHistory(project, start + i, randomUUID(), {
    lane: "notice", items: [answer(`notice-${i}`, "Status changed", i)],
  });
  saveManagerHistory(project, start + 100, run, chat("question", 100, "Full streamed answer"));
  let providerCalls = 0;
  const readLegacy = pausedGoal ? async () => {
    providerCalls++;
    return { goal: undefined, model: undefined, nextCursor: null, turns: [{
      messages: [{ text: "Legacy question", at: at(-10), files: [] }],
      items: [answer("legacy", "Legacy reply", -5), answer("question-answer", "Full streamed answer", 130)],
      durationMs: undefined,
    }] };
  } : undefined;
  const first = await readManagerDialogue(project, null, readLegacy);
  assert.equal(providerCalls, 0);
  assert.deepEqual(first?.turns.flatMap(turn => turn.messages.map(message => message.text)).slice(-2), ["prior-21", "question"]);
  assert.equal(first?.turns.find(turn => turn.messages[0]?.text === "question")?.items[0]?.text, "Full streamed answer");
  assert.equal(first?.turns.filter(turn => turn.lane === "notice").length, 0);
  assert.deepEqual(await readManagerDialogue(project, null, readLegacy), first);
  const pages = [first!];
  while (pages[0]?.nextCursor) pages.unshift((await readManagerDialogue(project, pages[0].nextCursor, readLegacy))!);
  const turns = pages.flatMap(page => page.turns);
  const questions = turns.flatMap(turn => turn.messages.map(message => message.text));
  assert.deepEqual(questions, [...(pausedGoal ? ["Legacy question"] : []), ...Array.from({ length: 22 }, (_, i) => `prior-${i}`), "question"]);
  const ids = turns.flatMap(turn => turn.items.map(item => item.id));
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, 23 + Number(pausedGoal));
});

test("the newest question with a 4 MiB image stays on the first page after status notices", async t => {
  const project = fixture(t);
  const start = Date.now();
  const image = { name: "image.png", url: "data:image/png;base64," + Buffer.alloc(4 * 1024 * 1024).toString("base64") };
  const item = (id: string) => ({ id, type: "agentMessage", title: "", status: "completed", phase: "final_answer" as const, text: id });
  for (const [offset, id] of ["prior", "latest"].entries()) {
    saveManagerHistory(project, start + offset, randomUUID(), {
      lane: "chat", message: { text: id, files: [image] }, items: [item(id + "-answer")],
    });
  }
  saveManagerHistory(project, start + 2, randomUUID(), { lane: "notice", items: [item("notice")] });
  const first = (await readManagerDialogue(project, null))!;
  assert.deepEqual(first.turns.flatMap(turn => turn.items.map(item => item.id)), ["latest-answer"]);
  assert.deepEqual(first.turns[0]?.messages[0]?.files, [image]);
  assert.deepEqual((await readManagerDialogue(project, first.nextCursor))?.turns.map(turn => turn.messages[0]?.text), ["prior"]);
  assert.deepEqual(await readManagerDialogue(project, null), first);
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
  const statusId = randomUUID();
  const text = "T-0042 «Работа» — отменена.";
  saveManagerHistory(project, at + 2, statusId, { lane: "notice", items: [{ ...reply, id: statusId, text }] });
  assert.deepEqual(managerUnread(project), ["first"]);
  const unreadPath = join(project, ".tasks", "manager-unread.json");
  writeJson(unreadPath, ["first", statusId]);
  assert.deepEqual(managerUnread(project), ["first"]);
  saveManagerHistory(project, at + 3, randomUUID(), {
    lane: "notice", goalId: randomUUID(), items: [{ ...reply, id: "second", text }],
  });
  assert.deepEqual(managerUnread(project), ["first", "second"]);
  assert.deepEqual(managerUnread(other), []);
  assert.equal(readManagerMessages(project, ["unknown", "first"]), true);
  assert.equal(saveManagerHistory(project, at, id, { ...run, items: [reply] }), false);
  assert.deepEqual(managerUnread(project), ["second"]);
  assert.deepEqual(readManagerHistory(project, null, "chat")!.turns.flatMap(turn => turn.items.map(item => item.id)), ["first", "second"]);
  assert.deepEqual(readManagerHistory(project, null, "work")!.turns.flatMap(turn => turn.items.map(item => item.id)), ["first", statusId]);
});

test("work history identifies older status notices with multiline card titles", t => {
  const project = fixture(t);
  const start = Date.now();
  const notices = ["", "\n", "\r\n", "\r"].map((separator, index) => {
    const title = "First" + separator + "Second";
    const task = { id: "T-0042", title } as Task;
    const at = new Date(start + index).toISOString();
    const text = statusNotice(task, { action: "cancel", actor: "manager", from: "ready", to: "cancelled", at }, index % 2 ? "ru" : "en");
    assert.ok(text?.includes(title));
    const item = { id: randomUUID(), text: text!, at, title: "", type: "agentMessage", status: "completed", phase: "final_answer" as const };
    saveManagerHistory(project, start + index, item.id, { lane: "notice", items: [item] });
    return item;
  });
  const reply = { ...notices[1]!, id: randomUUID() };
  saveManagerHistory(project, start + notices.length, randomUUID(), { lane: "chat", items: [reply] });
  assert.deepEqual(readManagerHistory(project, null, "work")!.turns.flatMap(turn => turn.items),
    notices.map(item => ({ ...item, statusTransition: { task: "T-0042", status: "cancelled" } })));
  assert.deepEqual(readManagerHistory(project, null, "chat")!.turns.flatMap(turn => turn.items), [reply]);
  assert.deepEqual(managerUnread(project), [reply.id]);
});

test("work pages interleaved notices and chat runs without losing or duplicating notices", t => {
  const project = fixture(t);
  const at = Date.now();
  for (let i = 0; i < 25; i++) saveManagerHistory(project, at + i, randomUUID(), {
    lane: i % 2 ? "notice" : "chat", items: [{ id: String(i), type: "agentMessage", title: "", text: String(i), status: "completed" }],
  });
  const recent = readManagerHistory(project, null, "work")!;
  const older = readManagerHistory(project, recent.nextCursor!, "work")!;
  assert.equal(older.nextCursor, null);
  assert.deepEqual([...older.turns, ...recent.turns].map(turn => turn.items[0]!.text), Array.from({ length: 12 }, (_, i) => String(i * 2 + 1)));
});

test("live and saved service operations use their Board tool identity before any result arrives", t => {
  const project = fixture(t);
  const call = (id: string, type: string, title: string) => ({ id, type, title, text: "", status: "inProgress" });
  const work = [
    call("cancel", "mcpToolCall", "ai_taskboard / task_cancel"),
    call("block", "dynamicToolCall", "task_block"),
    call("team", "mcpToolCall", "ai_taskboard / team_message"),
  ];
  const chat = [
    call("other", "mcpToolCall", "other / task_cancel"),
    { ...call("reply", "agentMessage", ""), text: "T-0042 отменена.", status: "completed" },
  ];
  const items = [...work, ...chat];
  assert.deepEqual(managerChatItems(items), chat);
  assert.deepEqual(managerWorkItems(items), work);
  saveManagerHistory(project, Date.now(), randomUUID(), { lane: "chat", items });
  assert.deepEqual(readManagerHistory(project, null, "chat")!.turns[0]!.items, chat);
  assert.deepEqual(readManagerHistory(project, null, "work")!.turns[0]!.items, work);
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
  saveManagerHistory(project, 2, randomUUID(), { lane: "notice", goalId: randomUUID(), items: [reply("arrival")] });
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
  saveManagerHistory(project, 100, randomUUID(), { lane: "notice", goalId: randomUUID(), items: [{ ...reply("late-old"), at: new Date(10).toISOString() }] });
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
  saveManagerHistory(project, 1, randomUUID(), { lane: "notice", goalId: randomUUID(), items: [reply("legacy")] });
  saveManagerHistory(project, 2, randomUUID(), { lane: "chat", items: [reply("later")] });
  readManagerMessages(project, ["later"]);
  const saved = JSON.parse(readFileSync(join(project, ".tasks", "manager-unread.json"), "utf8"));
  assert.deepEqual(saved.unread, []);
  assert.equal(saved.through.at, 2);
});
