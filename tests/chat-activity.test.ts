import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { RunActivity } from "../src/cli/model.ts";

const source = readFileSync(new URL("../src/desktop/chat.js", import.meta.url), "utf8");
const action = (id: string, type = "commandExecution", status = "completed", title = "git status", text = "output"): RunActivity =>
  ({ id, type, status, title, text });

// Verify renderer state and content independently of Chromium layout (scripts/check-chat.mjs).
function fixture(russian = true) {
  const document: { activeElement?: Node } = {};
  class Node {
    tag: string;
    className: string;
    children: Node[] = [];
    parent?: Node;
    dataset: Record<string, string> = {};
    open = false;
    hidden = false;
    value = "";
    constructor(tag: string, text = "", className = "") { this.tag = tag; this.value = text; this.className = className; }
    get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
    set innerText(text: string) { this.value = text; }
    append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes: Node[]) { this.children.forEach(child => { child.parent = undefined; }); this.children = []; this.append(...nodes); }
    matches(selector: string) { return selector.startsWith(".") ? this.className.split(" ").includes(selector.slice(1)) : this.tag === selector; }
    querySelectorAll(selector: string): Node[] {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
    closest(selector: string): Node | undefined { return this.matches(selector) ? this : this.parent?.closest(selector); }
    contains(node?: Node): boolean { return node === this || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    addEventListener() {}
  }
  const frame = { russian };
  const render = runInNewContext(source + ";renderRunActivity", {
    window: {}, document, frame,
    language: (english: string, translated: string) => frame.russian ? translated : english,
    element: (tag: string, text?: string, className?: string) => new Node(tag, text, className),
    icon: (name: string) => new Node("svg", name),
    IntersectionObserver: class {},
  }) as (container: Node, items: RunActivity[], completed?: boolean, durationMs?: number) => void;
  const container = new Node("li");
  const row = (id: string) => container.querySelectorAll("details").find(node => node.dataset.item === "item:" + id)!;
  return { render: (items: RunActivity[], completed = false, durationMs?: number) => render(container, items, completed, durationMs), container, document, row, frame };
}

test("activity groups consecutive operations without hiding messages, reasoning or errors", () => {
  const view = fixture();
  view.render([
    action("a"), action("b", "fileChange"), action("message", "agentMessage", "completed", "", "Agent explanation"),
    action("image", "imageView"), action("search", "webSearch"),
    action("reason", "reasoning"), action("single"), action("error", "error", "failed", "", "Connection lost"),
    action("last"), action("truncated", "truncated"),
  ]);
  const groups = view.container.querySelectorAll(".chat-run-group");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].open, false);
  assert.match(groups[0].querySelector("summary")!.textContent, /2 действия.*1 команда.*1 изменение файлов/);
  assert.equal(view.container.children[1].textContent, "Agent explanation");
  assert.equal(view.container.children[3], view.row("reason"));
  assert.equal(view.container.children[4], view.row("single"));
  assert.equal(view.container.children[5].textContent, "Connection lost");
  assert.match(view.container.children.at(-1)!.textContent, /Ранние события/);
  assert.match(view.row("image").querySelector("summary")!.textContent, /images.*Просмотр изображения/);
});

test("long commands and unsafe tool output remain complete only in disclosure details", () => {
  const view = fixture();
  const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ' + "Get-Content ".repeat(500);
  const output = "<script>alert(1)</script>\n".repeat(100);
  view.render([action("long", "commandExecution", "completed", command, output)]);
  const row = view.row("long");
  assert.equal(row.open, false);
  assert.equal(row.querySelector(".chat-run-command")!.textContent, command);
  assert.equal(row.querySelector(".chat-run-output")!.textContent, output);
  assert.ok(row.querySelector("summary")!.textContent.length < 240);
  assert.ok(!row.querySelector("summary")!.textContent.includes("pwsh.exe"));
  assert.equal(row.querySelectorAll("script").length, 0);
});

test("stream updates retain disclosures and keyboard focus including newly formed groups", () => {
  const view = fixture();
  const items = [action("a"), action("b")];
  view.render(items.slice(0, 1));
  view.row("a").open = true;
  view.row("a").querySelector("summary")!.focus();
  view.render(items);
  assert.equal(view.container.children[0].open, true);
  assert.equal(view.row("a").open, true);
  assert.equal(view.document.activeElement, view.row("a").querySelector("summary"));
  view.container.children[0].open = false;
  view.render([{ ...items[0], text: "new output" }, items[1]]);
  assert.equal(view.container.children[0].open, false);
  assert.equal(view.row("a").open, true);
  assert.equal(view.row("a").querySelector(".chat-run-output")!.textContent, "new output");
  view.render([]);
  assert.equal(view.container.hidden, true);
  assert.equal(view.container.children.length, 0);
});

test("failed and running operations remain visible in collapsed mixed groups", () => {
  const view = fixture();
  view.render([action("failed", "commandExecution", "failed"), action("running", "mcpToolCall", "inProgress")]);
  const group = view.container.children[0];
  assert.equal(group.open, false);
  assert.equal(group.dataset.state, "failed");
  assert.match(group.querySelector("summary")!.textContent, /Ошибок: 1.*Выполняется: 1/);
  assert.equal(view.row("failed").dataset.state, "failed");
  assert.equal(view.row("running").dataset.state, "running");
});

test("unknown tools, empty output, image tool calls and both languages have usable labels", () => {
  const view = fixture(false);
  view.render([action("unknown", "futureTool", "completed", "inspect", "")]);
  assert.match(view.row("unknown").querySelector("summary")!.textContent, /Used tool.*inspect/);
  assert.equal(view.row("unknown").querySelector(".chat-run-output")!.textContent, "No output.");
  view.render([action("image", "mcpToolCall", "completed", "functions / view_image"), action("b")]);
  assert.match(view.container.children[0].querySelector("summary")!.textContent, /2 actions.*1 image view/);
  assert.match(view.row("image").querySelector("summary")!.textContent, /Viewed image/);
  view.frame.russian = true;
  view.render(Array.from({ length: 5 }, (_, index) => action(String(index))));
  assert.match(view.container.children[0].querySelector("summary")!.textContent, /5 действий.*5 команд/);
});

test("completed work folds the whole chronology and keeps every final answer visible", () => {
  const view = fixture();
  const items: RunActivity[] = [
    { ...action("note", "agentMessage", "completed", "", "Checking files"), phase: "commentary" },
    action("command"),
    { ...action("answer", "agentMessage", "completed", "", "Final answer"), phase: "final_answer" },
    { ...action("answer-2", "agentMessage", "completed", "", "More results"), phase: "final_answer" },
  ];
  view.render(items);
  assert.equal(view.container.querySelectorAll(".chat-work").length, 0, "live chronology is visible");
  view.render(items, true, 433_000);
  const work = view.container.querySelector(".chat-work")!;
  assert.equal(work.open, false);
  assert.match(work.querySelector("summary")!.textContent, /Выполнено за 7 мин 13 с/);
  assert.ok(work.textContent.includes("Checking files"));
  assert.ok(!work.textContent.includes("Final answer"));
  assert.equal(view.container.children[1].textContent, "Final answer");
  assert.equal(view.container.children[2].textContent, "More results");
  work.open = true;
  view.row("command").open = true;
  view.render(items, true, 433_000);
  assert.equal(view.container.querySelector(".chat-work")!.open, true);
  assert.equal(view.row("command").open, true);
});

test("older logs, commentary-only replies and errors retain readable completed histories", () => {
  const view = fixture(false);
  view.render([action("command"), action("answer", "agentMessage", "completed", "", "Legacy answer")], true);
  assert.match(view.container.querySelector(".chat-work")!.querySelector("summary")!.textContent, /Completed/);
  assert.equal(view.container.children[1].textContent, "Legacy answer");
  view.render([
    { ...action("note", "agentMessage", "completed", "", "Still checking"), phase: "commentary" },
    action("error", "error", "failed", "", "Disconnected"),
  ], true, 0);
  const work = view.container.querySelector(".chat-work")!;
  assert.equal(view.container.querySelectorAll(".chat-run-final").length, 0);
  assert.match(work.querySelector("summary")!.textContent, /Completed in 0s.*Failed: 1/);
  assert.equal(work.querySelector(".chat-run-error")!.textContent, "Disconnected");
});
