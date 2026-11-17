import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, unlinkSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { boardWorklog } from "../src/desktop/board-worklog.ts";
import { migrateWorklog, removeMigratedWorklog } from "../src/cli/worklog-migration.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "taskboard-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".tasks"));
  writeFileSync(join(root, ".tasks", "board.json"), JSON.stringify({ settings: { boardType: "manual" } }));
  return root;
}
function read(root: string) {
  return globSync(".tasks/worklog/*/*/*.md", { cwd: root }).map(file => readFileSync(join(root, file), "utf8")).join("");
}
const legacy = (id: string, text: string) => `# Codex Worklog — 2026-11-12\n\n## 2026-11-12 19:48 +03:00 — ${text}\n\n<!-- codex-worklog-session:old turn:old -->\n\nOriginal content\n\n<!-- codex-worklog-entry:${id} -->\n`;

test("migration preserves bytes of blocks, current entries and sources; repeat and conflict", t => {
  const root = fixture(t);
  const source = join(root, ".dev-diary");
  mkdirSync(join(source, "2026", "11"), { recursive: true });
  const path = join(source, "2026", "11", "2026-11-12.md");
  const text = legacy("a".repeat(24), "Old result");
  writeFileSync(path, text);
  const first = migrateWorklog(root);
  assert.equal(first[0]?.added, 1);
  assert.equal(read(root), text);
  assert.equal(migrateWorklog(root)[0]?.added, 0);
  assert.equal(readFileSync(path, "utf8"), text);
  const previous = read(root);
  writeFileSync(path, text.replace("Original content", "Conflicting content"));
  assert.throws(() => migrateWorklog(root), /WORKLOG_ID_CONFLICT/);
  assert.equal(read(root), previous);
  assert.match(readFileSync(path, "utf8"), /Conflicting content/);
  assert.throws(() => removeMigratedWorklog(root, source), /WORKLOG_ID_CONFLICT/);
  assert.match(readFileSync(path, "utf8"), /Conflicting content/);
  writeFileSync(path, text);
  writeFileSync(join(source, "unknown.txt"), "keep unknown data");
  removeMigratedWorklog(root, source);
  assert.equal(readFileSync(join(source, "unknown.txt"), "utf8"), "keep unknown data");
  assert.equal(read(root), previous);
});

test("operation facts survive interruption, missing card, restart and delivery failures without raw data", async t => {
  const root = fixture(t);
  const log = boardWorklog(root, "executor", "T-0042");
  log.start("thread", "turn");
  const event = { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
    id: "failed-command", type: "commandExecution", status: "completed", exitCode: 7,
    command: "secret-command", aggregatedOutput: "secret-output",
  } } };
  log.observe(event, "thread"); log.observe(event, "thread");
  log.finish();
  const text = read(root);
  assert.equal(text.match(/exitCode=7/g)?.length, 1);
  assert.match(text, /interrupted or disconnected/);
  assert.doesNotMatch(text, /secret-command|secret-output/);
  // There never was a physical card: its identity remains a label.
  assert.match(text, /executor T-0042/);
  const reopened = boardWorklog(root, "executor", "T-0042");
  reopened.start("thread", "turn"); reopened.observe(event, "thread");
  assert.equal(read(root), text);
  const changed = structuredClone(event); changed.params.item.exitCode = 8;
  assert.throws(() => reopened.observe(changed, "thread"), /Conflicting Worklog event identity/);
  assert.equal(read(root), text);
  assert.equal(readdirSync(join(root, ".tasks", "pending")).filter(file => file.endsWith(".json")).length, 1);

  const blocked = fixture(t);
  writeFileSync(join(blocked, ".tasks", "worklog"), "unavailable");
  const failed = boardWorklog(blocked, "manager"); failed.start("manager", "failed");
  assert.throws(() => failed.fact("operation", "operation completed; outcome observed"));
  assert.equal(readdirSync(join(blocked, ".tasks", "pending")).filter(file => file.endsWith(".json")).length, 1);
  unlinkSync(join(blocked, ".tasks", "worklog"));
  boardWorklog(blocked, "reviewer").start("next", "next");
  assert.match(read(blocked), /operation completed/);
  assert.equal(readdirSync(join(blocked, ".tasks", "pending")).filter(file => file.endsWith(".json")).length, 0);
});

test("parallel role processes append to one project journal", async t => {
  const root = fixture(t);
  const module = new URL("../src/desktop/board-worklog.ts", import.meta.url).href;
  await Promise.all(["manager", "executor", "reviewer"].map(role => new Promise<void>((resolve, reject) => {
    const code = `import {boardWorklog} from ${JSON.stringify(module)}; const log=boardWorklog(${JSON.stringify(root)},${JSON.stringify(role)}); log.start(${JSON.stringify(role)},'parallel'); log.fact('check','completed');`;
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { windowsHide: true });
    let error = ""; child.stderr.on("data", chunk => error += chunk);
    child.on("error", reject); child.on("exit", status => status === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(read(root).match(/codex-worklog-entry:/g)?.length, 3);
  for (const role of ["manager", "executor", "reviewer"]) assert.match(read(root), new RegExp("ai-taskboard-role:" + role));
});
