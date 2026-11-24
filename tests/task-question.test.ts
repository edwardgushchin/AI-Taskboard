import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { addChatMessage, readTask } from "../src/cli/archive.ts";
import { sendTeamMessage, teamInbox } from "../src/cli/expert-team.ts";
import { TaskboardError } from "../src/cli/model.ts";
import { BoardStore, initializeBoard, validateCard } from "../src/cli/storage.ts";
import { acknowledgeTaskMessages, managerInbox, sendTaskMessage, taskQuestionAudience, taskQuestionState } from "../src/cli/task-messages.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";

const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8");
const start = source.indexOf("export function replyToTask(");
const end = source.indexOf("\nexport async function requestExecutorAccess", start);
assert.ok(start >= 0 && end > start);

test("draft manager replies are linked, persisted once, and survive a concurrent discussion", t => {
  const root = mkdtempSync(join(tmpdir(), "draft-manager-reply-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  const id = "T-0001";
  const read = () => readTask(store, id);
  store.create({
    ...createTask(id, { title: "Publication format" }),
    draftDiscussion: { phase: "running" },
    awaitingAnswer: true,
  });

  const ask = (to: string, text: string) => sendTeamMessage(store, id, id, { to, text, kind: "question" });
  const format = ask("manager", "Which format is used?");
  const owner = ask("owner", "Who signs off?");
  assert.deepEqual(managerInbox([read()]).filter(mail => mail.draftQuestion).map(mail => mail.sequence), [format.sequence]);

  const answer = { to: id, text: "Use CSV.", replyTo: format.sequence };
  for (const replyTo of [String(format.sequence), "2x", "0x2", null, 0]) {
    assert.throws(() => sendTeamMessage(store, id, "manager", { ...answer, replyTo }), { code: "INVALID_INPUT" });
  }
  assert.equal(read().draftDiscussion?.managerReply, undefined);
  sendTeamMessage(store, id, "manager", { ...answer, to: "team" });
  assert.equal(read().draftDiscussion?.managerReply, undefined);
  const first = sendTeamMessage(store, id, "manager", answer);
  assert.deepEqual(sendTeamMessage(store, id, "manager", answer), first);
  assert.deepEqual(readTask(new BoardStore(location), id).draftDiscussion, { phase: "running", managerReply: first.sequence });
  assert.equal(managerInbox([read()]).some(mail => mail.sequence === format.sequence), false);
  assert.equal(managerInbox([read()]).some(mail => mail.sequence === owner.sequence), true);

  const finish = (text: string, awaitingAnswer: boolean, managerReply?: number) => addChatMessage(store, read(), {
    model: "fixture", effort: "low", actor: "agent", draftDiscussion: true,
    revision: read().revision, text, awaitingAnswer, managerReply,
  });
  assert.deepEqual(finish("Waiting for clarifications.", true).draftDiscussion, { phase: "queued", managerReply: first.sequence });
  store.save({ ...read(), draftDiscussion: { phase: "running", managerReply: first.sequence } });
  const delimiter = ask("manager", "Which delimiter?");
  const second = sendTeamMessage(store, id, "manager", { to: id, replyTo: delimiter.sequence, text: "Use comma." });
  const partial = finish("The owner still needs to confirm who signs off.", true, first.sequence);
  assert.equal(partial.draftManagerReplyThrough, first.sequence);
  assert.deepEqual(partial.draftDiscussion, { phase: "queued", managerReply: second.sequence });

  store.save({ ...read(), draftDiscussion: { phase: "running", managerReply: second.sequence } });
  assert.throws(() => finish("Duplicate response.", false, first.sequence), { code: "CHAT_CHANGED" });
  assert.throws(() => finish("Unlinked response.", false, delimiter.sequence), { code: "CHAT_CHANGED" });
  sendTeamMessage(store, id, "owner", { to: id, replyTo: owner.sequence, text: "The owner signs off." });
  const ready = finish("The draft is ready for approval.", false, second.sequence);
  assert.equal(ready.status, "draft");
  assert.equal(ready.awaitingAnswer, false);
  assert.equal(ready.draftConfirmed, true);
  assert.equal(ready.draftManagerReplyThrough, second.sequence);
  assert.equal(ready.draftDiscussion, undefined);
});

test("saved owner and manager questions resolve independently", t => {
  const root = mkdtempSync(join(tmpdir(), "task-question-audience-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  const id = "T-0001";
  const read = () => readTask(new BoardStore(location), id);
  const audience = () => taskQuestionAudience(read());
  store.create({
    ...createTask(id, { title: "Publication format", criteria: ["Publish the report."] }),
    awaitingAnswer: true,
    draftDiscussion: { phase: "running" },
  });
  assert.equal(audience(), "owner");

  const question = sendTeamMessage(store, id, id, { to: "manager", kind: "question", text: "Which format?" });
  assert.equal(audience(), "manager");
  assert.throws(() => changeTask(read(), "approve", {}), { code: "TASK_AWAITING_ANSWER" });
  sendTeamMessage(store, id, "manager", { to: id, text: "Checking the format." });
  assert.equal(audience(), "manager");
  const answer = sendTeamMessage(store, id, "manager", { to: id, text: "Use CSV.", replyTo: question.sequence });
  assert.equal(audience(), "manager");

  const input = {
    actor: "agent", model: "fixture", effort: "low", draftDiscussion: true, revision: read().revision,
    text: "Who signs off on the CSV?", awaitingAnswer: true, managerReply: answer.sequence,
  };
  for (const invalid of ["true", 1, null]) {
    assert.throws(() => addChatMessage(store, read(), { ...input, awaitingOwnerAnswer: invalid }), { code: "INVALID_INPUT" });
  }
  addChatMessage(store, read(), { ...input, awaitingOwnerAnswer: true });
  assert.equal(audience(), "owner");

  const destination = sendTeamMessage(store, id, id, { to: "manager", kind: "question", text: "Which destination?" });
  assert.equal(audience(), "owner");
  assert.equal(taskQuestionAudience({ ...read(), status: "cancelled" }), undefined);
  const destinationReply = sendTeamMessage(store, id, "manager", { to: id, text: "Use the shared folder.", replyTo: destination.sequence });
  store.save({ ...read(), draftDiscussion: { phase: "running", managerReply: destinationReply.sequence } });
  addChatMessage(store, read(), {
    actor: "agent", model: "fixture", effort: "low", draftDiscussion: true,
    revision: read().revision, managerReply: destinationReply.sequence,
    text: "Both clarifications are complete.", awaitingAnswer: false, awaitingOwnerAnswer: false,
  });
  assert.equal(audience(), undefined);
  assert.equal(read().draftConfirmed, true);
  assert.equal(changeTask(read(), "approve", {}).status, "ready");
});

test("an active task waits only for explicitly linked manager answers", () => {
  const task = { ...createTask("T-0001", { title: "Report" }), status: "in_progress" as const };
  const update = sendTaskMessage(task, { text: "Do we have a format? I will check." }, "agent");
  assert.equal(taskQuestionAudience(update), undefined);

  const question = sendTaskMessage(update, { kind: "question", text: "Which format?" }, "agent");
  assert.equal(taskQuestionAudience(question), "manager");
  const unrelated = sendTaskMessage(question, { text: "I have an update." }, "manager");
  assert.equal(taskQuestionAudience(unrelated), "manager");

  const answer = sendTaskMessage(unrelated, { text: "Use CSV.", replyTo: question.history.length }, "manager");
  assert.equal(taskQuestionAudience(answer), undefined);
});

test("team questions use the saved recipient and close only on a linked reply from that recipient", t => {
  const root = mkdtempSync(join(tmpdir(), "task-team-question-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  const id = "T-0001";
  const read = () => readTask(new BoardStore(location), id);
  const audience = () => taskQuestionAudience(read());
  store.create({ ...createTask(id, { title: "Report" }), status: "review" });
  const ask = (sender: string, to: string, text: string) =>
    sendTeamMessage(store, id, sender, { kind: "question", to, text });

  const owner = ask(id, "owner", "Who should receive the report?");
  const manager = ask("reviewer", "manager", "Which format is approved?");
  const secondManager = ask(id, "manager", "Where should we publish it?");
  assert.equal(audience(), "owner");

  sendTeamMessage(store, id, "manager", { to: id, replyTo: owner.sequence, text: "The team." });
  sendTeamMessage(store, id, "owner", { to: "reviewer", replyTo: owner.sequence, text: "The team." });
  sendTeamMessage(store, id, "owner", { to: id, text: "Thanks." });
  sendTeamMessage(store, id, "owner", { kind: "question", to: id, replyTo: owner.sequence, text: "Which report?" });
  assert.equal(audience(), "owner");
  assert.deepEqual(taskQuestionState(read()).openOwnerQuestionSequences, [owner.sequence]);
  assert.deepEqual(taskQuestionState({ ...read(), status: "cancelled" }).openOwnerQuestionSequences, []);

  sendTeamMessage(store, id, "owner", { to: id, replyTo: owner.sequence, text: "The team." });
  assert.equal(audience(), "manager");
  assert.deepEqual(taskQuestionState(read()).openOwnerQuestionSequences, []);
  sendTeamMessage(store, id, "manager", { to: id, replyTo: secondManager.sequence, text: "Use the shared folder." });
  assert.equal(audience(), "manager");
  sendTeamMessage(store, id, "manager", { to: "reviewer", replyTo: manager.sequence, text: "Use CSV." });
  assert.equal(audience(), undefined);
});

test("manager inbox keeps read team questions replyable and delivers one linked answer to each sender", t => {
  const root = mkdtempSync(join(tmpdir(), "active-manager-reply-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const location = { root, directory: join(root, ".tasks"), repository: null };
  const store = initializeBoard(location, store => store);
  const id = "T-0001";
  const read = () => readTask(new BoardStore(location), id);
  store.create({ ...createTask(id, { title: "Report" }), status: "in_progress" });
  const executor = sendTeamMessage(store, id, id, { to: "manager", kind: "question", text: "May I use the fixture?" });
  const reviewer = sendTeamMessage(store, id, "reviewer", { to: "manager", kind: "question", text: "Which result is required?" });
  store.save(sendTaskMessage(read(), { text: "You have access." }, "manager"));
  store.save(acknowledgeTaskMessages(read(), { through: reviewer.sequence }));

  const questions = () => managerInbox([read()]).map(entry => entry.sequence);
  assert.deepEqual(questions(), [executor.sequence, reviewer.sequence]);
  assert.equal(taskQuestionAudience(read()), "manager");
  assert.throws(() => sendTaskMessage(read(), { replyTo: executor.sequence, text: "Yes." }, "manager"), {
    code: "INVALID_INPUT",
    message: `Use team_message with id ${id}, to ${id}, and replyTo ${executor.sequence}.`,
  });
  const answer = { to: id, replyTo: executor.sequence, text: "Yes." };
  for (const replyTo of [String(executor.sequence), "2x", "0x2", null, 0]) {
    assert.throws(() => sendTeamMessage(store, id, "manager", { ...answer, replyTo }), { code: "INVALID_INPUT" });
  }
  assert.throws(() => sendTeamMessage(store, id, "manager", { ...answer, to: "reviewer" }), { code: "INVALID_INPUT" });
  assert.throws(() => sendTeamMessage(store, id, "manager", { ...answer, kind: "question" }), { code: "INVALID_INPUT" });
  assert.deepEqual(questions(), [executor.sequence, reviewer.sequence]);

  const saved = sendTeamMessage(store, id, "manager", answer);
  const reopened = new BoardStore(location);
  assert.deepEqual(sendTeamMessage(reopened, id, "manager", answer), saved);
  const executorMail = teamInbox(reopened, id, id, reviewer.sequence).messages;
  assert.equal(executorMail.length, 1);
  assert.equal(executorMail[0].replyTo, executor.sequence);
  assert.equal(executorMail[0].text, answer.text);
  assert.deepEqual(questions(), [reviewer.sequence]);
  assert.equal(taskQuestionAudience(read()), "manager");

  sendTeamMessage(reopened, id, "manager", { to: "reviewer", replyTo: reviewer.sequence, text: "The CSV." });
  const reviewerMail = teamInbox(reopened, id, "reviewer", saved.sequence).messages;
  assert.equal(reviewerMail.length, 1);
  assert.equal(reviewerMail[0].replyTo, reviewer.sequence);
  assert.deepEqual(questions(), []);
  assert.equal(taskQuestionAudience(read()), undefined);
});

function providerResult(result: object, mode?: "initial" | "handoff", onActivity?: (items: any[]) => void, draft = false, prompt = "{}") {
  let options: any;
  let tools: { name: string }[] = [];
  const replyToTask = runInNewContext(stripTypeScriptTypes(source.slice(start, end).replace("export ", "")) + "\nreplyToTask", {
    boardWorklog: () => ({}),
    readBoardSettings: () => ({}),
    locateBoard: () => ({}),
    boardAgentInstructions: (_role: string, instructions: string) => instructions,
    manualContext: () => "",
    chatTools: [],
    executorExpertTools: ["team_inbox", "team_message", "expert_stage", "expert_list"].map(name => ({ name })),
    worklogTool: {},
    githubReadTool: {},
    reviewModeInstruction: "",
    withBoardMcp: (available: typeof tools, _action: unknown, run: Function) => {
      tools = available;
      return run({}, {});
    },
    reply: async (...args: any[]) => {
      options = args.at(-1);
      return result;
    },
  });
  const pending = replyToTask("profile", "project", {}, prompt, [], () => {}, () => {}, "scratch", 1024,
    undefined, undefined, undefined, "T-0001", onActivity, mode, false, false, draft);
  return { pending, options: () => options, tools: () => tools.map(tool => tool.name).filter(Boolean) };
}

test("T-0140 question reconciliation uses the same rules in auto review and draft dialogue", async () => {
  const connectedRule = "При отказе обновления подключённого устройства сохрани прежнюю раскладку.";
  const deferredRule = "При отказе первого применения отложенной раскладки удали её из настроек.";
  const question = "При отказе первого применения отложенной раскладки удалить её или повторить попытку?";
  for (const mode of ["initial", undefined] as const) {
    for (const answerSource of ["description", "criteria", "subtasks", "history", undefined] as const) {
      const gap = answerSource === undefined;
      const task = {
        id: "T-0140",
        status: "draft",
        description: answerSource === "description" ? connectedRule + " " + deferredRule : connectedRule,
        criteria: answerSource === "criteria" ? [deferredRule] : [],
        subtasks: answerSource === "subtasks" ? [{ title: deferredRule, done: false }] : [],
        awaitingAnswer: mode === undefined,
      };
      const history = [
        ...(mode === undefined ? [{ actor: "agent", action: "chat", text: question }] : []),
        ...(answerSource === "history" ? [{ actor: "user", action: "chat", text: deferredRule }] : []),
      ];
      const latestUserMessage = mode === undefined ? { text: "Это уже в задаче." } : undefined;
      const prompt = JSON.stringify({ task, history, latestUserMessage });
      const questionText = gap ? connectedRule + " " + question : "";
      const output = mode === "initial"
        ? { questions: questionText }
        : { text: questionText || "Уточнение снято. Задача готова к утверждению.", awaitingAnswer: gap, confirmsDraft: !gap };
      const fixture = providerResult({ text: JSON.stringify(output) }, mode, undefined, true, prompt);

      const result = await fixture.pending;
      assert.equal(result.awaitingAnswer, gap);
      assert.equal(result.text.includes(question), gap);
      assert.match(fixture.options().instructions, /current description, acceptance criteria, subtasks, and relevant answers/);
      assert.match(fixture.options().instructions, /reread the current brief/);
      assert.match(fixture.options().instructions, /only resolves another when the brief makes it applicable/);
    }
  }
});

test("both discussion modes return explicit question state without parsing punctuation", async () => {
  for (const questions of ["Which format and destination?", ""]) {
    const awaitingOwnerAnswer = Boolean(questions);
    const f = providerResult({ text: JSON.stringify({ questions, awaitingOwnerAnswer }), commentary: ["hidden"] }, "initial");
    const result = await f.pending;
    assert.equal(result.text, questions);
    assert.equal(result.awaitingAnswer, awaitingOwnerAnswer);
    assert.equal(result.awaitingOwnerAnswer, awaitingOwnerAnswer);
    assert.deepEqual([...result.commentary], []);
  }
  for (const [text, awaitingAnswer] of [
    ["Which format?", true], ["Destination still needs clarification.", true],
    ["Ready. Questions? Optional help is available.", false], ["All received.", false],
    ["The remaining question is no longer needed.", false],
  ] as const) {
    const f = providerResult({
      text: JSON.stringify({ text, awaitingAnswer, awaitingOwnerAnswer: awaitingAnswer }),
      attachmentSources: [{ name: "result.png" }],
    });
    const result = await f.pending;
    assert.equal(result.text, text);
    assert.equal(result.awaitingAnswer, awaitingAnswer);
    assert.equal(result.awaitingOwnerAnswer, awaitingAnswer);
    assert.equal(result.attachmentSources[0].name, "result.png");
    assert.ok(f.options().finalAnswerSchema.required.includes("awaitingOwnerAnswer"));
  }
  const manager = providerResult({ text: '{"text":"Waiting for the manager.","awaitingAnswer":true,"awaitingOwnerAnswer":false}' });
  assert.equal((await manager.pending).awaitingOwnerAnswer, false);
});

test("draft dialogue requires explicit confirmation independently of open questions", async () => {
  const response = { text: "Hello!", awaitingAnswer: false };
  for (const variant of [response, { ...response, confirmsDraft: "true" },
    { ...response, awaitingAnswer: true, confirmsDraft: true }]) {
    const malformed = providerResult({ text: JSON.stringify(variant) }, undefined, undefined, true);
    await assert.rejects(malformed.pending, /invalid task discussion result/);
  }

  const neutral = providerResult({ text: JSON.stringify({ ...response, confirmsDraft: false }) }, undefined, undefined, true);
  assert.equal((await neutral.pending).confirmsDraft, false);
  assert.ok(neutral.options().finalAnswerSchema.required.includes("confirmsDraft"));
  const confirmed = providerResult({
    text: JSON.stringify({ text: "The draft is ready for approval.", awaitingAnswer: false, confirmsDraft: true }),
  }, undefined, undefined, true);
  assert.equal((await confirmed.pending).confirmsDraft, true);
});

test("automatic discussion modes can use team mail and require a concrete handoff reply", async () => {
  const initial = providerResult({ text: '{"questions":""}' }, "initial");
  const handoff = providerResult({ text: '{"text":"Ready for approval.","awaitingAnswer":false}' }, "handoff");
  await initial.pending;
  assert.equal((await handoff.pending).awaitingAnswer, false);
  for (const session of [initial, handoff]) {
    assert.deepEqual(Array.from(session.tools()), ["team_inbox", "team_message"]);
    assert.equal(session.options().tools.length, 0);
  }
  await assert.rejects(providerResult({ text: '{"text":" ","awaitingAnswer":true}' }, "handoff").pending,
    /invalid task discussion result/);
});

test("discussion streaming decodes JSON strings and saves the first reply timestamp", async () => {
  const at = "2026-11-19T12:34:56.789Z";
  let visible: any[] = [];
  const text = 'Принято: "узкое окно".\nПуть C:\\temp\\new, цвет #FFFFFF.';
  const encoded = JSON.stringify({ text, awaitingAnswer: false });
  const f = providerResult({ text: encoded }, undefined, items => { visible = items; });
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
  for (const questions of [undefined, null, 0, {}, []]) {
    await assert.rejects(providerResult({ text: JSON.stringify({ questions }) }, "initial").pending,
      /invalid draft discussion result/);
  }
  for (const value of [undefined, "false", 0, null]) {
    await assert.rejects(providerResult({ text: JSON.stringify({ text: "Reply", awaitingAnswer: value }) }).pending,
      /invalid task discussion result/);
  }
  const result = await providerResult({ interrupted: true }).pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.awaitingAnswer, undefined);
  const initial = await providerResult({ interrupted: true }, "initial").pending;
  assert.equal(initial.interrupted, true);
  assert.equal(initial.text, undefined);
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
    task = addChatMessage(store, task, {
      ...settings, actor: "agent", text, awaitingAnswer, replyTo: task.history.length - 1, revision: task.revision,
    });
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
    replyTo: task.history.length - 1, revision: task.revision, awaitingAnswer: false });
  assert.equal(task.awaitingAnswer, false);
});

test("an active draft reply can finish once while newer messages wait for limits", t => {
  const root = mkdtempSync(join(tmpdir(), "draft-limit-queue-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const settings = { model: "test", effort: "low" };
  const store = initializeBoard({ root, directory: join(root, ".tasks"), repository: null }, store => store);
  let task = store.create(createTask("T-0001", { title: "Discussion" }));
  task = addChatMessage(store, task, { ...settings, text: "First" });
  const active = task.history.length - 1;
  const revision = task.revision;
  task = addChatMessage(store, task, { ...settings, text: "Second", waitForLimit: true });
  task = addChatMessage(store, task, { ...settings, text: "Third", waitForLimit: true });
  const pending = [active + 1, active + 2];
  const answer = {
    ...settings,
    actor: "agent",
    text: "Answer to first",
    replyTo: active,
    revision,
    awaitingAnswer: false,
  };
  assert.deepEqual(task.pendingLimitChat, pending);
  assert.throws(() => addChatMessage(store, task, { ...answer, revision: revision - 1 }), { code: "REVISION_CONFLICT" });
  task = addChatMessage(store, task, answer);
  assert.deepEqual(task.pendingLimitChat, pending);
  assert.throws(() => addChatMessage(store, task, answer), { code: "CHAT_CHANGED" });
  task = addChatMessage(store, task, { ...answer, revision: task.revision, replyTo: pending[0], text: "Answer to second" });
  assert.deepEqual(task.pendingLimitChat, pending.slice(1));
  assert.equal(task.history.filter(event => event.chat && event.actor === "agent").length, 2);
});
