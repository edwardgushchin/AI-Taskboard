import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { RunActivity } from "../src/cli/model.ts";

const source = ["source-files.cjs", "markdown.js", "chat.js"].map(name =>
  readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8")).join("\n");
const action = (id: string, type = "commandExecution", status = "completed", title = "git status", text = "output"): RunActivity =>
  ({ id, type, status, title, text });

// Verify renderer state and content independently of Chromium layout (scripts/check-chat.mjs).
function fixture(russian = true) {
  class Node {
    tag: string;
    className: string;
    children: Node[] = [];
    parent?: Node;
    dataset: Record<string, string> = {};
    open = false;
    hidden = false;
    value = "";
    click?: () => unknown;
    constructor(tag: string, text = "", className = "") { this.tag = tag; this.value = text; this.className = className; }
    get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
    classList = { add: (name: string) => { this.className += " " + name; } };
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
    setAttribute() {}
  }
  const document = { activeElement: new Node("body") };
  const frame = { russian };
  const previews: unknown[][] = [];
  const reads: string[] = [];
  const saves: string[] = [];
  const openedTasks: string[] = [];
  const { renderRunActivity, boardWaitStatus } = runInNewContext(source + ";({ renderRunActivity, boardWaitStatus })", {
    window: {}, document, frame, taskInSheet: undefined,
    language: (english: string, translated: string) => frame.russian ? translated : english,
    element: (tag: string, text?: string, className?: string) => new Node(tag, text, className),
    icon: (name: string) => new Node("svg", name),
    button: (text: string, click: () => unknown, className: string) => Object.assign(new Node("button", text, className), { click }),
    openImagePreview: (...args: unknown[]) => previews.push(args),
    showTask: (id: string) => openedTasks.push(id),
    api: { runImagePreview: (_id: string, path: string) => reads.push(path), saveRunImage: (_id: string, path: string) => saves.push(path) },
    IntersectionObserver: class { observe() {} },
  }) as {
    renderRunActivity: (container: Node, items: RunActivity[], completed?: boolean, durationMs?: number, taskId?: string) => void;
    boardWaitStatus: (item?: RunActivity) => string | undefined;
  };
  const container = new Node("li");
  const row = (id: string) => container.querySelectorAll("details").find(node => node.dataset.item === "item:" + id)!;
  return { render: (items: RunActivity[], completed = false, durationMs?: number) => renderRunActivity(container, items, completed, durationMs, "T-0042"), boardWaitStatus, container, document, row, frame, previews, reads, saves, openedTasks };
}

test("only the running Taskboard wait has a board status", () => {
  const { boardWaitStatus, frame } = fixture();
  const waiting = action("wait", "mcpToolCall", "inProgress", "ai_taskboard / task_wait");
  assert.equal(boardWaitStatus(waiting), "Жду обновления на доске…");
  frame.russian = false;
  assert.equal(boardWaitStatus(waiting), "Waiting for a board update…");
  assert.equal(boardWaitStatus({ ...waiting, status: "completed" }), undefined);
  assert.equal(boardWaitStatus({ ...waiting, title: "other / task_wait" }), undefined);
  assert.equal(boardWaitStatus(undefined), undefined);
});

test("a reviewer return appears in the manager chat with its findings", () => {
  const view = fixture();
  const notice = { id: "T-0027", sequence: 44, kind: "request-changes", actor: "reviewer", text: "Уточни правила записи." };
  view.render(["inbox", "wait"].map(id => ({
    ...action(id, "mcpToolCall"), messages: [notice], messagesOnly: true,
  })));
  const entries = view.container.querySelectorAll(".chat-coordination");
  assert.equal(entries.length, 1);
  assert.match(entries[0].querySelector(".chat-coordination-header").textContent, /Ревьюер → Менеджер/);
  assert.equal(entries[0].querySelector(".chat-review-status").textContent, "Возврат на доработку");
  assert.match(entries[0].textContent, /Уточни правила записи\./);
  entries[0].querySelector("button").click?.();
  assert.deepEqual(view.openedTasks, ["T-0027"]);
});

test("confirmed task transitions and comments remain in the timeline when work details are collapsed", () => {
  const view = fixture();
  const items = [
    action("before", "agentMessage", "completed", "", "Проверю задачу"),
    { ...action("unblock", "dynamicToolCall", "completed", "task_unblock"),
      taskChanges: [{ id: "T-0002", title: "Удалить старый taskboard", action: "unblock" }] },
    action("review", "mcpToolCall", "completed", "ai_taskboard / task_review"),
    action("git", "mcpToolCall", "completed", "ai_taskboard / project_git"),
    { ...action("accept", "mcpToolCall", "completed", "ai_taskboard / task_accept"),
      taskChanges: [{ id: "T-0002", title: "Удалить старый taskboard", action: "accept" }] },
    { ...action("start", "mcpToolCall", "completed", "ai_taskboard / task_start"),
      taskChanges: [{ id: "T-0003", title: "Следующая задача", action: "start" }] },
    { ...action("comment", "mcpToolCall", "completed", "ai_taskboard / task_comment"),
      taskChanges: [{ id: "T-0035", title: "Упорядочить нативные DLL", action: "comment" }] },
    action("wait", "mcpToolCall", "completed", "ai_taskboard / task_wait"),
    { ...action("final", "agentMessage", "completed", "", "Задача закрыта"), phase: "final_answer" as const },
  ];
  view.render(items);
  const group = view.container.querySelector(".chat-run-group");
  assert.equal(view.container.children[2], group);
  assert.equal(group.querySelectorAll(".chat-run-item").length, 2);
  assert.equal(view.row("unblock").parent, view.container);
  assert.equal(view.row("accept").parent, view.container);
  assert.equal(view.row("start").parent, view.container);
  assert.equal(view.row("comment").parent, view.container);
  assert.match(view.row("unblock").querySelector("summary").textContent, /Задача разблокирована T-0002/);
  assert.match(view.row("accept").querySelector("summary").textContent, /Задача принята T-0002/);
  view.row("accept").open = true;
  const link = view.row("accept").querySelector("button");
  link.focus();
  link.click!();
  assert.deepEqual(view.openedTasks, ["T-0002"]);
  view.render(items);
  assert.equal(view.document.activeElement, view.row("accept").querySelector("button"));
  view.render(items, true);
  assert.ok(view.row("review").closest(".chat-work"));
  assert.equal(view.container.children[3], view.row("accept"));
  assert.equal(view.container.children[4], view.row("start"));
  const comment = view.container.children[5];
  assert.equal(comment, view.row("comment"));
  assert.match(comment.querySelector("summary").textContent, /Комментарий добавлен T-0035/);
  assert.equal(comment.open, false);
  assert.equal(view.row("wait").closest(".chat-work")?.open, false);
  assert.equal(view.container.children.at(-1)?.textContent, "Задача закрыта");
});

test("tool audit reasons never become separate messages during streaming or replay", () => {
  const view = fixture();
  const reason = "Те же исправления уже включены в T-0007.";
  const cancellation = { ...action("cancel", "mcpToolCall", "completed", "ai_taskboard / task_cancel"),
    taskChanges: [{ id: "T-0009", title: "Форматирование", action: "cancel", reason }] };
  for (const completed of [false, true]) {
    view.render([action("read", "mcpToolCall"), cancellation, action("ack", "mcpToolCall")], completed);
    const row = view.row("cancel");
    assert.equal(row.parent, view.container);
    assert.equal(row.open, false);
    assert.match(row.querySelector("summary").textContent, /Задача отменена T-0009/);
    assert.ok(!view.container.querySelectorAll(".chat-text").some(node => node.textContent === reason));
  }
});

test("saved and live image views replace service JSON with clickable previews of every image", () => {
  const view = fixture(false);
  const items = ["C:\\project\\first.png", "second.png"].map((path, index) =>
    action(String(index), "imageView", "completed", "", JSON.stringify({ path, startedAtMs: 1 })));
  for (const completed of [false, true]) {
    view.render(items, completed);
    assert.equal(view.container.querySelectorAll(".chat-run-images").length, 2);
    assert.equal(view.container.querySelectorAll("pre").length, 0);
    assert.ok(!view.container.textContent.includes("startedAtMs"));
    assert.equal(view.row("0").open, true);
    const tile = view.row("1").querySelector("button")!;
    assert.equal(tile.dataset.path, "second.png");
    tile.click!();
    const [task, files, index, , source] = view.previews.at(-1)! as [string, { file: string }[], number, unknown, { preview: Function; save: Function }];
    assert.equal(task, "T-0042");
    assert.equal(files.length, 2);
    assert.equal(index, 1);
    source.preview(files[0]); source.save(files[1]);
    assert.equal(view.reads.at(-1), "C:\\project\\first.png");
    assert.equal(view.saves.at(-1), "second.png");
  }
  view.row("0").open = false;
  const retainedTile = view.row("0").querySelector("button");
  retainedTile!.focus();
  view.render(items);
  assert.equal(view.row("0").open, false);
  assert.equal(view.row("0").querySelector("button"), retainedTile, "stream updates retain loaded image tiles");
  assert.equal(view.document.activeElement, retainedTile, "stream updates retain focus on image buttons");
  view.render([...items, action("new", "imageView", "completed", "", '{"path":"third.png"}')]);
  retainedTile!.click!();
  assert.equal((view.previews.at(-1)![1] as unknown[]).length, 3, "retained tiles navigate the latest set of images");
  view.render([action("bad", "imageView", "failed", "", "File not found"), action("old", "imageView", "completed", "", "unsupported output")]);
  assert.equal(view.container.querySelectorAll(".chat-run-images").length, 0);
  assert.equal(view.row("bad").querySelector("pre")!.textContent, "File not found");
});

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

test("empty reasoning summaries stay hidden until there is text to show", () => {
  const view = fixture();
  const empty = action("reason", "reasoning", "inProgress", "", "");
  view.render([empty]);
  assert.equal(view.container.hidden, true);
  view.render([{ ...empty, text: "Сводка от провайдера" }]);
  assert.equal(view.container.hidden, false);
  assert.equal(view.row("reason").querySelector(".chat-run-output")!.textContent, "Сводка от провайдера");
  view.render([
    { ...empty, status: "completed", text: " \n " },
    { ...action("answer", "agentMessage", "completed", "", "Ответ менеджера"), phase: "final_answer" },
  ], true);
  assert.equal(view.container.querySelectorAll("details").length, 0);
  assert.equal(view.container.textContent, "Ответ менеджера");
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
