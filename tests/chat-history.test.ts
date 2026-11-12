import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { addChatMessage, readTask } from "../src/cli/archive.ts";
import type { Task, TaskEvent } from "../src/cli/model.ts";
import { BoardStore, initializeBoard } from "../src/cli/storage.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";

const source = readFileSync(new URL("../src/desktop/chat.js", import.meta.url), "utf8");
const start = source.indexOf("function chatEventLabel(");
assert.ok(start >= 0);
const settings = { model: "test", effort: "low" };
const request = "актуализируй задачу";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  selectedOptions: Element[] = [];
  value = "";
  text: string;
  className: string;
  constructor(_tag: string, text = "", className = "") { this.text = text; this.className = className; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll(): Element[] { return []; }
  cloneNode() { return new Element("time", this.text, this.className); }
}

function render(task: Task): Element[] {
  const taskChat = runInNewContext(source.slice(start) + "\ntaskChat", {
    chatDrafts: new Map(), chatCatalog: undefined, Option: Element,
    frame: { project: "fixture", russian: true }, lanes: [],
    element: (tag: string, text?: string, className?: string) => new Element(tag, text, className),
    button: (text: string, _action: unknown, className: string) => new Element("button", text, className),
    icon: () => new Element("svg"),
    language: (_english: string, russian: string) => russian,
    shortDate: (value: string) => value,
    chatText: (text: string) => new Element("div", text, "chat-text"),
    renderRunActivity: () => {}, renderChatTurn: () => {}, requestAnimationFrame: () => {},
    api: { chatModels: async () => ({ ok: true, data: [] }) },
  }) as (task: Task) => Element;
  return taskChat(task).children.find(child => child.className === "chat-log")!.children;
}

function messages(task: Task) {
  return render(task).filter(row => row.className === "chat-entry").map(row => ({
    actor: row.dataset.actor,
    text: row.children.find(child => child.className === "chat-text")?.text,
  }));
}

test("one request stays one message through an update, reply, and reopening", t => {
  const parent = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const root = mkdtempSync(join(parent, ".chat-history-test-"));
  t.after(() => {
    assert.equal(dirname(realpathSync(root)), parent);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const store = initializeBoard({ root, directory: join(root, ".tasks"), repository: null }, store => store);
  let task = store.create(createTask("T-0001", { title: "Discussion" }));
  task = addChatMessage(store, task, { ...settings, text: request });
  const replyTo = task.history.length - 1;
  const original = { actor: "user", text: request };
  assert.deepEqual(messages(task), [original]);
  // task_update records its authorization as the update note by default.
  task = store.save(changeTask(task, "update", { actor: "user", description: "Updated", note: request }));
  const history = JSON.stringify(task.history);
  assert.deepEqual(messages(task), [original]);
  assert.equal(render(task).filter(row => row.className === "chat-entry chat-event").length, 2);
  assert.equal(JSON.stringify(task.history), history);
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Updated the task.", replyTo });
  const expected = [original, { actor: "agent", text: "Updated the task." }];
  assert.deepEqual(messages(task), expected);
  const reopened = readTask(new BoardStore(store.location), task.id);
  assert.deepEqual(reopened.history, task.history);
  assert.equal(reopened.history.find(event => event.action === "update")?.text, request);
  assert.deepEqual(messages(reopened), expected);
});

test("real repeated sends and distinct update notes remain visible", () => {
  const task = createTask("T-0001", { title: "Discussion" });
  const at = task.createdAt;
  const chat = (actor: "user" | "agent", text: string): TaskEvent => ({ at, actor, action: "chat", text, chat: settings });
  task.history.push(
    chat("user", request),
    { at, actor: "user", action: "update", text: "Use the new reference." },
    chat("agent", "Updated."),
    chat("user", request),
    chat("user", request),
    { at, actor: "user", action: "update", text: request },
    chat("agent", "Updated again."),
  );
  assert.deepEqual(messages(task), [
    { actor: "user", text: request },
    { actor: "user", text: "Use the new reference." },
    { actor: "agent", text: "Updated." },
    { actor: "user", text: request },
    { actor: "user", text: request },
    { actor: "agent", text: "Updated again." },
  ]);
});

test("matching text in other events or outside the pending user turn is preserved", () => {
  const task = createTask("T-0001", { title: "Discussion" });
  const at = task.createdAt;
  task.history.push(
    { at, actor: "user", action: "chat", text: request, chat: settings },
    { at, actor: "agent", action: "update", text: request },
    { at, actor: "user", action: "cancel", text: request },
    { at, actor: "agent", action: "chat", text: "Reply", chat: settings },
    { at, actor: "user", action: "update", text: request },
  );
  assert.deepEqual(messages(task).map(message => message.text), [request, request, request, "Reply", request]);
});
