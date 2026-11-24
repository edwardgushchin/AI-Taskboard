import localization from "../src/desktop/localization.cjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { addAttachment, addChatMessage, readTask } from "../src/cli/archive.ts";
import { hasDraftConfirmation, type Task, type TaskEvent } from "../src/cli/model.ts";
import { BoardStore, initializeBoard, validateCard } from "../src/cli/storage.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";

const source = readFileSync(new URL("../src/desktop/chat.js", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
const attachmentsStart = renderer.indexOf("    const chatFiles = new Set(task.history.flatMap");
const attachmentsEnd = renderer.indexOf("\n  }", attachmentsStart);
assert.ok(attachmentsStart >= 0 && attachmentsEnd > attachmentsStart);
const settings = { model: "test", effort: "low" };
const request = "актуализируй задачу";

class Element {
  tag: string;
  children: Element[] = [];
  attributes = new Map<string, string>();
  click?: () => Promise<unknown> | unknown;
  get childElementCount() { return this.children.length; }
  hidden = false;
  classList = {
    add: (name: string) => { this.className += " " + name; },
    toggle: (name: string, enabled: boolean) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) names.add(name);
      else names.delete(name);
      this.className = [...names].join(" ");
    },
  };
  dataset: Record<string, string> = {};
  selectedOptions: Element[] = [];
  value = "";
  text: string;
  className: string;
  constructor(tag: string, text = "", className = "") {
    this.tag = tag;
    this.text = typeof text === "function" ? (text as () => string)() : text;
    this.className = className;
  }
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  addEventListener() {}
  matches(selector: string) {
    if (selector === ":popover-open") return false;
    return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Element | undefined { return this.querySelectorAll(selector)[0]; }
  cloneNode() { return new Element("time", this.text, this.className); }
}

function cardAttachments(task: Task) {
  const body = new Element("div");
  const previews: unknown[][] = [];
  runInNewContext(renderer.slice(attachmentsStart, attachmentsEnd), {
    task, body,
    isImageAttachment: (file: { name: string }) => file.name.endsWith(".png"),
    element: (tag: string, text?: string, className?: string) => new Element(tag, text, className),
    button: (text: string, click: Element["click"], className: string) => Object.assign(new Element("button", text, className), { click }),
    icon: () => new Element("i"),
    controlLabelForIcon: (control: Element, label: () => string) => control.setAttribute("aria-label", label()),
    t: (key: string) => localization.text(key, {}, "en"),
    openImagePreview: (...args: unknown[]) => previews.push(args),
    taskAttachmentButton: (id: string, attachment: Task["attachments"][number]) =>
      Object.assign(new Element("button", attachment.name), { dataset: { task: id, file: attachment.file } }),
  });
  return { controls: body.querySelectorAll("button"), previews };
}

function render(task: Task): Element[] {
  const taskChat = runInNewContext(source + "\ntaskChat", {
    IntersectionObserver: class { observe() {} },
    hasDraftConfirmation,
    manualBoard: () => false,
    chatViewport: () => ({
      snapshot: () => ({}),
      update: (change: () => void) => change(),
    }),
    Option: Element,
    frame: { project: "fixture", russian: true }, lanes: [],
    element: (tag: string, text?: string, className?: string) => new Element(tag, text, className),
    button: (text: string, _action: unknown, className: string) => new Element("button", text, className),
    icon: () => new Element("svg"),
    controlLabelForIcon: () => {},
    isImageAttachment: (file: { name: string }) => /\.(png|jpe?g|webp|gif)$/i.test(file.name),
    chatPreviews: { observe: () => {} },
    t: (key: string, parameters = {}) => localization.text(key, parameters, "ru"), localization, bindLocalized: (node: any, property: string, render: () => string, attribute = false) => { const value = render(); if (attribute) node.setAttribute(property, value); else node[property] = value; return value; },
    shortDate: (value: string) => value,
    chatText: (text: string) => new Element("div", text, "chat-text"),
    renderRunActivity: () => {}, renderChatTurn: () => {}, requestAnimationFrame: () => {},
    api: { chatModels: async () => ({ ok: true, data: [] }) },
  }) as (task: Task) => Element;
  return taskChat(task).children.find(child => child.className === "chat-log task-dialogue")!.children;
}

function messages(task: Task) {
  return render(task).filter(row => row.className === "chat-entry").map(row => ({
    actor: row.dataset.actor,
    text: row.children.find(child => child.className === "chat-text")?.text,
  }));
}

function historyFixture(t: TestContext) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "taskboard-chat-history-"));
  t.after(() => {
    assert.equal(dirname(realpathSync(root)), parent);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return initializeBoard({ root, directory: join(root, ".tasks"), repository: null }, store => store);
}

function imageFixture(store: BoardStore) {
  const path = join(store.location.root, "image.png");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

test("one request stays one message through an update, reply, and reopening", t => {
  const store = historyFixture(t);
  let task = store.create(createTask("T-0001", { title: "Discussion" }));
  task = addChatMessage(store, task, { ...settings, text: request });
  const replyTo = task.history.length - 1;
  const original = { actor: "user", text: request };
  assert.deepEqual(messages(task), [original]);
  // task_update records its authorization as the update note by default.
  task = store.save(changeTask(task, "update", { actor: "user", description: "Updated", note: request }));
  const history = JSON.stringify(task.history);
  assert.deepEqual(messages(task), [original]);
  assert.deepEqual(task.history.filter(event => ["create", "update"].includes(event.action)).map(event => event.action),
    ["create", "update"]);
  assert.equal(JSON.stringify(task.history), history);
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Updated the task.", replyTo });
  const expected = [original, { actor: "agent", text: "Updated the task." }];
  assert.deepEqual(messages(task), expected);
  const reopened = readTask(new BoardStore(store.location), task.id);
  assert.deepEqual(reopened.history, task.history);
  assert.equal(reopened.history.find(event => event.action === "update")?.text, request);
  assert.deepEqual(messages(reopened), expected);
});

test("real repeated sends and distinct update notes survive reopening", t => {
  const store = historyFixture(t);
  let task = store.create(createTask("T-0001", { title: "Discussion" }));
  task = addChatMessage(store, task, { ...settings, text: request });
  const firstRequest = task.history.length - 1;
  task = store.save(changeTask(task, "update", { description: "First revision", note: "Use the new reference." }));
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Updated.", replyTo: firstRequest });
  task = addChatMessage(store, task, { ...settings, text: request });
  task = addChatMessage(store, task, { ...settings, text: request });
  const lastRequest = task.history.length - 1;
  task = store.save(changeTask(task, "update", { description: "Second revision", note: request }));
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Updated again.", replyTo: lastRequest });

  const reopened = readTask(new BoardStore(store.location), task.id);
  assert.deepEqual(messages(reopened), [
    { actor: "user", text: request },
    { actor: "agent", text: "Updated." },
    { actor: "user", text: request },
    { actor: "user", text: request },
    { actor: "agent", text: "Updated again." },
  ]);
  assert.deepEqual(reopened.history.filter(event => event.action === "update").map(event => event.text),
    ["Use the new reference.", request]);
});

test("matching update notes and the cancellation reason survive outside the dialogue", t => {
  const store = historyFixture(t);
  let task = store.create(createTask("T-0001", { title: "Discussion" }));
  task = addChatMessage(store, task, { ...settings, text: request });
  const replyTo = task.history.length - 1;
  task = store.save(changeTask(task, "update", { actor: "agent", description: "Agent revision", note: request }));
  task = addChatMessage(store, task, { ...settings, actor: "agent", text: "Reply", replyTo });
  task = store.save(changeTask(task, "update", { actor: "user", description: "Owner revision", note: request }));
  task = store.save(changeTask(task, "cancel", { actor: "user", reason: request }));

  const reopened = readTask(new BoardStore(store.location), task.id);
  assert.equal(reopened.status, "cancelled");
  assert.deepEqual(messages(reopened).map(message => message.text), [request, "Reply"]);
  assert.deepEqual(reopened.history.filter(event => ["update", "cancel"].includes(event.action))
    .map(({ actor, action, text }) => ({ actor, action, text })), [
    { actor: "agent", action: "update", text: request },
    { actor: "user", action: "update", text: request },
    { actor: "user", action: "cancel", text: request },
  ]);
});

test("legacy attachment events expose all four saved welcome PNGs in the card preview", t => {
  const store = historyFixture(t);
  const path = imageFixture(store);
  const names = ["welcome-dark-1384.png", "welcome-dark-500.png", "welcome-light-1384.png", "welcome-light-500.png"];
  let task = store.create(createTask("T-0041", { title: "Welcome" }));
  for (const name of names) {
    task = addAttachment(store, task, { path, name });
  }
  const images = task.attachments;
  const files = images.map(file => file.file);
  // Cards written before attachment events carried IDs only stored the filename.
  for (const event of task.history) {
    if (event.action === "attach") {
      delete event.attachment;
    }
  }
  store.save(task);
  task = readTask(new BoardStore(store.location), task.id);
  store.save(changeTask(task, "update", { description: "Preview the welcome variants." }));

  const reopened = readTask(new BoardStore(store.location), task.id);
  assert.deepEqual(reopened.history.filter(event => event.action === "attach")
    .map(({ text, attachment }) => ({ text, attachment })), names.map(text => ({ text, attachment: undefined })));
  assert.deepEqual(messages(reopened), []);
  const { controls, previews } = cardAttachments(reopened);
  const views = controls.filter(control => control.hasAttribute("aria-label"));
  assert.equal(views.length, 4);
  views.forEach(view => view.click!());
  assert.deepEqual(previews.map(([id, openedImages, index]) => ({
    id,
    images: Array.from(openedImages as Task["attachments"]),
    index,
  })), images.map((_file, index) => ({ id: task.id, images, index })));
  const attachmentControls = controls.filter(control => control.dataset.file);
  assert.deepEqual(attachmentControls.map(control => control.text), names);
  assert.deepEqual(attachmentControls.map(control => control.dataset.file), files);
});

test("the card and dialogue keep saved namesake attachments separate by ID", t => {
  const store = historyFixture(t);
  const path = imageFixture(store);
  let task = store.create(createTask("T-0001", { title: "Attachments" }));
  const legacy: TaskEvent[] = [
    { at: task.createdAt, actor: "user", action: "attach", text: "same.png" },
    { at: task.createdAt, actor: "agent", action: "attach", text: "missing.png" },
    { at: task.createdAt, actor: "agent", action: "attach", text: "same.png" },
  ];
  store.save({ ...task, history: [...task.history, ...legacy] });
  task = readTask(new BoardStore(store.location), task.id);
  task = addChatMessage(store, task, { ...settings, text: "", attachmentSources: [{ path, name: "same.png" }] });
  const first = task.attachments[0].file;
  task = addAttachment(store, task, { path, name: "same.png" });
  const second = task.attachments[1].file;

  const reopened = readTask(new BoardStore(store.location), task.id);
  const rows = render(reopened).filter(row => row.className === "chat-entry");
  assert.deepEqual(reopened.history.filter(event => event.action === "attach")
    .map(({ text, attachment }) => ({ text, attachment })), [
    { text: "same.png", attachment: undefined },
    { text: "missing.png", attachment: undefined },
    { text: "same.png", attachment: undefined },
    { text: "same.png", attachment: second },
  ]);
  const invalidId = { ...legacy[2], attachment: "missing" };
  assert.throws(() => validateCard({ ...reopened, history: [...reopened.history, invalidId] }, reopened.id),
    /Invalid attachment event/);
  assert.deepEqual(rows.map(row => row.children.find(child => child.className === "chat-attachments")!
    .children[0].dataset.file), [first]);
  const { controls, previews } = cardAttachments(reopened);
  assert.deepEqual(controls.filter(control => control.dataset.file).map(control => control.dataset.file), [second]);
  controls.find(control => control.hasAttribute("aria-label"))!.click!();
  assert.deepEqual(Array.from((previews[0] as [string, Task["attachments"], number])[1]), [reopened.attachments[1]]);
});
