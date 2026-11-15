import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createTask, recordRunLog } from "../src/cli/tasks.ts";
import type { RunActivity } from "../src/cli/model.ts";

const source = readFileSync(new URL("../src/desktop/chat.js", import.meta.url), "utf8");
const start = source.indexOf("function readableRunCommand(");
const end = source.indexOf("\nfunction updateChat(", start);
assert.ok(start >= 0 && end > start);

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  hidden = false;
  open = false;
  tag: string;
  text: string;
  className: string;
  constructor(tag: string, text = "", className = "") { this.tag = tag; this.text = text; this.className = className; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => {
      const matches = selector.startsWith(".") ? child.className.split(" ").includes(selector.slice(1)) : child.tag === selector;
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
  contains() { return false; }
}
const { readableRunCommand, renderRunActivity } = runInNewContext(source.slice(0, source.indexOf("const chatDrafts")) + source.slice(start, end) +
  "\n({ readableRunCommand, renderRunActivity })", {
  element: (tag: string, text?: string, className?: string) => new Element(tag, text, className),
  document: { activeElement: { matches: () => false } }, frame: { russian: true }, taskInSheet: undefined,
  icon: () => new Element("svg"),
  language: (_english: string, russian: string) => russian,
  chatText: (text: string) => new Element("div", text),
}) as {
  readableRunCommand: (command: string) => string;
  renderRunActivity: (container: Element, items: RunActivity[]) => void;
};

test("the screenshot command renders readable Russian and Windows paths live and from saved history", () => {
  // Captured commandExecution from the T-0032 log shown in T-0037/image.png.
  const entry: RunActivity = JSON.parse(readFileSync(new URL("fixtures/T-0032-unicode-command.json", import.meta.url), "utf8"));
  const original = JSON.stringify(entry);
  const saved = JSON.parse(JSON.stringify(recordRunLog(createTask("T-0037", { title: "Unicode" }), { entries: [entry] })));
  for (const items of [[entry], saved.history.at(-1).run]) {
    const container = new Element("li");
    renderRunActivity(container, items);
    const command = container.querySelector(".chat-run-command");
    const raw = container.querySelector(".chat-run-original");
    assert.match(command.text, /Обязательная визуальная проверка чата недоступна/);
    assert.match(command.text, /Выполнить node scripts\/check-chat\.mjs --references/);
    assert.ok(!command.text.includes("\\u0432"));
    assert.ok(command.text.includes(String.raw`& 'C:\Program Files\nodejs\node.exe'`));
    assert.ok(command.text.includes(String.raw`'G:\Projects\2026\AI Taskboard\src\cli\main.ts'`));
    const json = command.text.slice(command.text.indexOf("\n") + 1, command.text.indexOf("\n'@"));
    assert.ok(JSON.parse(json).condition.includes(String.raw`"G:\Projects\2026\AI Taskboard\.tasks\attachments\T-0032"`));
    assert.equal(raw.children[0].text, "Исходная команда");
    assert.equal(raw.children[1].text, entry.title);
    assert.equal(container.hidden, false);
    container.children[0].open = true;
    raw.open = true;
    renderRunActivity(container, items);
    assert.equal(container.children[0].open, true);
    assert.equal(container.querySelector(".chat-run-original").open, true);
  }
  assert.equal(JSON.stringify(entry), original);
});

test("command formatting decodes only recognized argv and complete JSON here-strings", () => {
  const script = "@'\n" + String.raw`{"text":"\u041f\u0440\u0438\u0432\u0435\u0442 \ud83d\ude80","literal":"\\u0432","path":"C:\\temp\\new","unc":"\\\\server\\share"}` + "\n'@ | node script.js\n" +
    String.raw`Write-Output '\u0432 C:\temp\new'; node -e 'console.log("\\n")'`;
  const command = JSON.stringify(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`) + " -Command " + JSON.stringify(script);
  const formatted = readableRunCommand(command);
  const json = JSON.parse(formatted.slice(3, formatted.indexOf("\n'@")));
  assert.equal(json.text, "Привет 🚀");
  assert.equal(json.literal, String.raw`\u0432`);
  assert.equal(json.path, String.raw`C:\temp\new`);
  assert.equal(json.unc, String.raw`\\server\share`);
  assert.ok(formatted.endsWith(script.slice(script.indexOf("\n'@"))));
  for (const unchanged of [
    String.raw`Write-Output '\u0432 C:\temp\new'`,
    String.raw`"C:\Program Files\PowerShell\pwsh.exe" -Command "C:\temp\new"`,
    '"node.exe" -Command "\\u0432"',
    command.slice(0, -2),
  ]) assert.equal(readableRunCommand(unchanged), unchanged);
  for (const body of ["@'\n{invalid JSON}\n'@", "@'\n{\"text\":\"\\u0432\"}", String.raw`Write-Output '\u0432'`]) {
    const wrapped = JSON.stringify(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) + " -Command " + JSON.stringify(body);
    assert.equal(readableRunCommand(wrapped), body);
  }
  const container = new Element("li");
  renderRunActivity(container, [{ id: "text", type: "agentMessage", title: "", text: script, status: "completed" }]);
  assert.equal(container.children[0].text, script);
});
