import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { addChatMessage, readTask } from "../src/cli/archive.ts";
import { TaskboardError } from "../src/cli/model.ts";
import { BoardStore, initializeBoard, validateCard } from "../src/cli/storage.ts";
import { createTask } from "../src/cli/tasks.ts";

const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8");
const start = source.indexOf("export function replyToTask(");
const end = source.indexOf("\nexport async function requestExecutorAccess", start);
assert.ok(start >= 0 && end > start);

function providerResult(result: object, initial = false, onActivity?: (items: any[]) => void) {
  let options: any;
  const replyToTask = runInNewContext(stripTypeScriptTypes(source.slice(start, end).replace("export ", "")) + "\nreplyToTask", {
    boardWorklog: () => ({}),
    readBoardSettings: () => ({}),
    locateBoard: () => ({}),
    boardAgentInstructions: (_role: string, instructions: string) => instructions,
    manualContext: () => "",
    chatTools: [],
    executorExpertTools: [],
    worklogTool: {},
    githubReadTool: {},
    reviewModeInstruction: "",
    withBoardMcp: (_tools: unknown, _action: unknown, run: Function) => run({}, {}),
    reply: async (...args: any[]) => {
      options = args.at(-1);
      return result;
    },
  });
  const pending = replyToTask("profile", "project", {}, "{}", [], () => {}, () => {}, "scratch", 1024,
    undefined, undefined, undefined, "T-0001", onActivity, initial ? "initial" : undefined);
  return { pending, options: () => options };
}

test("both discussion modes return explicit question state without parsing punctuation", async () => {
  for (const questions of ["Which format and destination?", ""]) {
    const f = providerResult({ text: JSON.stringify({ questions }), commentary: ["hidden"] }, true);
    const result = await f.pending;
    assert.equal(result.text, questions);
    assert.equal(result.awaitingAnswer, Boolean(questions));
    assert.deepEqual([...result.commentary], []);
  }
  for (const [text, awaitingAnswer] of [
    ["Which format?", true], ["Destination still needs clarification.", true],
    ["Ready. Questions? Optional help is available.", false], ["All received.", false],
    ["The remaining question is no longer needed.", false],
  ] as const) {
    const f = providerResult({ text: JSON.stringify({ text, awaitingAnswer }), attachmentSources: [{ name: "result.png" }] });
    const result = await f.pending;
    assert.equal(result.text, text);
    assert.equal(result.awaitingAnswer, awaitingAnswer);
    assert.equal(result.attachmentSources[0].name, "result.png");
    assert.ok(f.options().finalAnswerSchema.required.includes("awaitingAnswer"));
  }
});

test("discussion streaming decodes JSON strings and saves the first reply timestamp", async () => {
  const at = "2026-11-19T12:34:56.789Z";
  let visible: any[] = [];
  const text = 'Принято: "узкое окно".\nПуть C:\\temp\\new, цвет #FFFFFF.';
  const encoded = JSON.stringify({ text, awaitingAnswer: false });
  const f = providerResult({ text: encoded }, false, items => { visible = items; });
  const publish = (value: string) => f.options().onActivity([
    { id: "reply", type: "agentMessage", phase: "final_answer", text: value, at, status: "inProgress" },
  ]);
  for (let length = 1; length <= encoded.length; length++) {
    publish(encoded.slice(0, length));
    assert.ok(text.startsWith(visible[0].text), JSON.stringify(visible[0].text));
    assert.equal(visible[0].at, at);
  }
  assert.equal(visible[0].text, text);
  publish(String.raw`{"text":"Уже видно\u04`);
  assert.equal(visible[0].text, "Уже видно");
  publish(String.raw`{"awaitingAnswer":false,"text":"Уже видно\u0434"}`);
  assert.equal(visible[0].text, "Уже виднод");
  const result = await f.pending;
  assert.equal(result.at, at);
  assert.equal(result.text, text);
});

test("agent reply timestamps reject malformed input before saving and accept a corrected value", t => {
  const root = mkdtempSync(join(tmpdir(), "task-chat-time-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  const settings = { model: "fixture", effort: "low" };
  let task = store.create(createTask("T-0001", { title: "Timestamp" }));
  task = addChatMessage(store, task, { ...settings, text: "Answer" });
  const pending = { ...settings, actor: "agent", text: "Received.", replyTo: task.history.length - 1 };
  const at = "2026-11-19T12:34:56.789Z";
  for (const value of [null, 123, "", "2026-02-30T12:34:56.789Z", at + "junk", " " + at, "2026-11-19"]) {
    assert.throws(() => addChatMessage(store, task, { ...pending, at: value }), (error: unknown) =>
      error instanceof TaskboardError && error.code === "INVALID_INPUT");
    assert.equal(readTask(store, task.id).history.length, task.history.length);
  }
  assert.throws(() => addChatMessage(store, task, { ...settings, text: "User", at }), /Only an agent/);
  task = addChatMessage(store, task, { ...pending, at });
  assert.equal(readTask(new BoardStore(location), task.id).history.at(-1)!.at, at);
});

test("invalid or interrupted provider results cannot silently close a question", async () => {
  for (const value of [undefined, "false", 0, null]) {
    await assert.rejects(providerResult({ text: JSON.stringify({ text: "Reply", awaitingAnswer: value }) }).pending,
      /invalid task discussion result/);
  }
  const result = await providerResult({ interrupted: true }).pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.awaitingAnswer, undefined);
});

test("question state persists with replies, survives reads and partial answers, and is isolated per task", t => {
  const root = mkdtempSync(join(tmpdir(), "task-question-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  let task = store.create(createTask("T-0001", { title: "Question" }));
  const neighbor = store.create(createTask("T-0002", { title: "Old question", questions: ["An old question?"] }));
  task = store.save({ ...task, draftDiscussion: { phase: "running" } });
  const settings = { model: "fixture", effort: "low" };
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Format? Destination?",
    draftDiscussion: true, revision: task.revision, awaitingAnswer: true });
  assert.equal(task.awaitingAnswer, true);
  assert.equal(readTask(new BoardStore(location), task.id).awaitingAnswer, true);
  assert.equal(readTask(store, neighbor.id).awaitingAnswer, undefined);
  for (const [text, awaitingAnswer] of [["Destination still needed?", true], ["Received both answers.", false]] as const) {
    task = addChatMessage(store, task, { ...settings, text: "Answer" });
    assert.equal(task.awaitingAnswer, true, "user sends do not clear state");
    task = addChatMessage(store, task, { ...settings, actor: "agent", text, awaitingAnswer, replyTo: task.history.length - 1 });
    assert.equal(readTask(new BoardStore(location), task.id).awaitingAnswer, awaitingAnswer);
  }
  // A legacy reply and a plain question mark do not retroactively mark a card.
  let old = addChatMessage(store, neighbor, { ...settings, text: "Explain" });
  old = addChatMessage(store, old, { ...settings, actor: "agent", text: "Old question?", replyTo: old.history.length - 1 });
  assert.equal(old.awaitingAnswer, undefined);
});

test("state validation and stale reply protection preserve the last saved state", t => {
  const root = mkdtempSync(join(tmpdir(), "task-question-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const store = initializeBoard({ root, directory: join(root, ".tasks"), repository: null }, store => store);
  let task = store.create({ ...createTask("T-0001", { title: "Question" }), awaitingAnswer: true });
  const settings = { model: "fixture", effort: "low" };
  task = addChatMessage(store, task, { ...settings, text: "Answer" });
  for (const value of ["false", 0, null, {}]) {
    assert.throws(() => addChatMessage(store, task, { ...settings, actor: "agent", text: "Reply",
      replyTo: task.history.length - 1, awaitingAnswer: value }), (error: unknown) =>
      error instanceof TaskboardError && error.code === "INVALID_INPUT");
  }
  assert.throws(() => addChatMessage(store, task, { ...settings, text: "Clear it", awaitingAnswer: false }), /Only an agent/);
  assert.throws(() => addChatMessage(store, task, { ...settings, actor: "agent", text: "Stale", replyTo: 0,
    awaitingAnswer: false }), (error: unknown) => error instanceof TaskboardError && error.code === "CHAT_CHANGED");
  assert.equal(readTask(store, task.id).awaitingAnswer, true);
  assert.throws(() => validateCard({ ...task, awaitingAnswer: "false" }, task.id), /Invalid card/);
  // Correcting a rejected value succeeds on the same pending user turn.
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "The question is no longer needed.",
    replyTo: task.history.length - 1, awaitingAnswer: false });
  assert.equal(task.awaitingAnswer, false);
});
