import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boardProjectRulesPrompt, migrateBoardProjectRules, readBoardProjectRules, writeBoardProjectRules } from "../src/cli/board-agents.ts";
import { initializeBoard, locateBoard, withProjectRulesLock } from "../src/cli/storage.ts";

test("initialization preserves CRLF Markdown and groups nested content with its rule", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-import-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const first = [
    "- Проверяйте [справку](docs/guide.md).",
    "  - Вложенное пояснение.",
    "",
    "  ```sh",
    "  npm test",
    "  ```",
  ].join("\r\n");
  const second = "- Сохраняйте исходные формулировки.\r\n";
  const original = first + "\r\n" + second;
  const file = join(root, "AGENTS.md");
  writeFileSync(file, original);
  const location = locateBoard(root, true, false, true);
  const command = [
    fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)),
    "--project", root, "--json", "init", "--stdin",
  ];
  const init = () => JSON.parse(execFileSync(process.execPath, command, {
    input: JSON.stringify({ boardType: "manual" }), encoding: "utf8", windowsHide: true,
  }));
  assert.equal(init().ok, true);
  const imported = readBoardProjectRules(root);
  assert.equal(imported.text, original.replaceAll("\r\n", "\n"));
  assert.deepEqual(imported.rules.map(rule => rule.text), [first.replaceAll("\r\n", "\n"), second.replaceAll("\r\n", "\n")]);
  const published = readFileSync(file, "utf8");
  assert.ok(published.includes(original));
  assert.equal(published.replaceAll("\r\n", "").includes("\n"), false);

  // Simulate a process interrupted after publishing AGENTS.md and before publishing board.json.
  unlinkSync(join(location.directory, "board.json"));
  initializeBoard(location, () => {}, "manual");
  assert.equal(readFileSync(file, "utf8"), published);
  assert.deepEqual(readBoardProjectRules(root), imported);
});

test("an unreadable AGENTS.md leaves initialization retryable", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-invalid-agents-"));
  t.after(() => rmSync(root, { recursive: true }));
  const location = locateBoard(root, true, false, true);
  const file = join(root, "AGENTS.md");
  const invalid = Buffer.from([0xC3, 0x28]);
  writeFileSync(file, invalid);
  const init = () => initializeBoard(location, () => {}, "manual");
  assert.throws(init, { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  assert.deepEqual(readFileSync(file), invalid);
  writeFileSync(file, "Valid Markdown\n");
  init();
  assert.equal(readBoardProjectRules(root).text, "Valid Markdown\n");
});

test("examples containing literal markers and unfinished Markdown survive import", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-literal-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const source = [
    "# Markdown example", "", "```md",
    "<!-- ai-taskboard:project-rules:start -->",
    "<!-- ai-taskboard:workflow:end -->", "",
  ].join("\n");
  writeFileSync(join(root, "AGENTS.md"), source);
  const location = locateBoard(root, true, false, true);
  initializeBoard(location, () => {}, "manual");
  assert.equal(readBoardProjectRules(root).text, source);
  const repeat = withProjectRulesLock(location, () => migrateBoardProjectRules(root));
  assert.equal(repeat.changed, false);
});

test("saves ordered rules and keeps a disabled rule out of the file and role context", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-save-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const location = locateBoard(root, true, false, true);
  initializeBoard(location, () => {}, "manual");
  const opened = readBoardProjectRules(root);
  const file = join(root, "AGENTS.md");
  assert.match(readFileSync(file, "utf8"), /AI Taskboard workflow/);
  assert.deepEqual(opened.rules, []);
  const rules = [
    { text: "Second", enabled: true },
    { text: "Disabled", enabled: false },
    { text: "First", enabled: true },
  ];
  const save = (revision: string, entries: typeof rules) =>
    withProjectRulesLock(location, () => writeBoardProjectRules(root, { revision, rules: entries }));
  const saved = save(opened.revision, rules);
  assert.deepEqual(readBoardProjectRules(root), saved);
  assert.equal(saved.text, "Second\n\nFirst");
  assert.doesNotMatch(readFileSync(file, "utf8"), /Disabled/);
  assert.match(boardProjectRulesPrompt(root), /Second\n\nFirst/);
  assert.doesNotMatch(boardProjectRulesPrompt(root), /Disabled/);
  assert.throws(() => save(opened.revision, []), { code: "PROJECT_RULES_CONFLICT", details: saved });

  const enabled = save(saved.revision, rules.map(rule => ({ ...rule, enabled: true })));
  assert.equal(enabled.text, "Second\n\nDisabled\n\nFirst");
  assert.equal(save(enabled.revision, rules.filter(rule => rule.enabled)).text, "Second\n\nFirst");
});

test("opening a board does not migrate it and a failed import can be retried", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-retry-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const location = locateBoard(root, true, false, true);
  initializeBoard(location, () => {}, "manual");
  const file = join(root, "AGENTS.md");
  const managed = readFileSync(file, "utf8").replace("## Project rules\n", "## Project rules\n\nManaged text\n");
  const source = "Manual before\n\n" + managed + "\nManual after\n";
  writeFileSync(file, source);
  initializeBoard(location, () => {}, "manual");
  assert.equal(readFileSync(file, "utf8"), source);

  const sidecar = join(location.directory, "project-rules.json");
  mkdirSync(sidecar);
  const migrate = () => withProjectRulesLock(location, () => migrateBoardProjectRules(root));
  assert.throws(migrate, { code: "INVALID_STORAGE_PATH" });
  assert.equal(readFileSync(file, "utf8"), source);
  rmdirSync(sidecar);
  const imported = migrate();
  assert.equal(imported.imported, 2);
  assert.equal(imported.text, "Manual before\n\nManaged text\n\nManual after");
  assert.equal(migrate().changed, false);
  assert.equal(readBoardProjectRules(root).revision, imported.revision);
});

test("migration detects an external edit before replacing AGENTS.md", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-conflict-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const location = locateBoard(root, true, false, true);
  initializeBoard(location, () => {}, "manual");
  const file = join(root, "AGENTS.md");
  const original = "- Keep this rule.\n";
  const external = original + "- Keep the external change.\n";
  writeFileSync(file, original);
  const rename = renameSync;
  const intercepted = t.mock.method(fs, "renameSync", (...[from, to]: Parameters<typeof renameSync>) => {
    rename(from, to);
    if (to === join(location.directory, "project-rules.json")) writeFileSync(file, external);
  });
  syncBuiltinESMExports();
  const migrate = () => withProjectRulesLock(location, () => migrateBoardProjectRules(root));
  try {
    assert.throws(migrate, { code: "PROJECT_RULES_CONFLICT" });
    assert.equal(readFileSync(file, "utf8"), external);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(migrate().text, external);
});

test("explicit migration detaches one board from a shared AGENTS.md", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-shared-rules-"));
  t.after(() => rmSync(root, { recursive: true }));
  const target = join(root, "shared.md");
  const source = "- Shared instruction\n- Second instruction\n";
  writeFileSync(target, source);
  const left = join(root, "left");
  const right = join(root, "right");
  for (const board of [left, right]) {
    mkdirSync(board);
    initializeBoard(locateBoard(board, true, false, true), () => {}, "manual");
    const entry = join(board, "AGENTS.md");
    unlinkSync(entry);
    try {
      symlinkSync(target, entry, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows account cannot create a native file symlink.");
        return;
      }
      throw error;
    }
  }
  const rightBefore = readBoardProjectRules(right);
  const migrate = () => withProjectRulesLock(locateBoard(left), () => migrateBoardProjectRules(left));
  assert.equal(migrate().imported, 2);
  assert.ok(lstatSync(join(left, "AGENTS.md")).isFile());
  assert.match(readFileSync(join(left, "AGENTS.md"), "utf8"), /AI Taskboard workflow/);
  assert.equal(readBoardProjectRules(left).text, source);
  assert.equal(readlinkSync(join(right, "AGENTS.md")), target);
  assert.equal(readFileSync(target, "utf8"), source);
  assert.deepEqual(readBoardProjectRules(right), rightBefore);
  assert.equal(migrate().changed, false);
});

test("board initialization and saves preserve a linked AGENTS.md and its target's manual text", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-linked-rules-"));
  t.after(() => rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 100 }));

  const link = join(root, "AGENTS.md");
  const targetName = "project instructions.md";
  const target = join(root, targetName);
  const manual = "\uFEFF# Manual notes\r\n\r\nKeep this Markdown.\r\n";
  writeFileSync(target, manual);
  try {
    symlinkSync(targetName, link, "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows account cannot create a native file symlink.");
      return;
    }
    throw error;
  }

  assert.equal(boardProjectRulesPrompt(root), "");
  initializeBoard(locateBoard(root, true, false, true), () => {}, "manual");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), targetName);
  assert.match(readFileSync(target, "utf8"), /AI Taskboard workflow/);

  const opened = readBoardProjectRules(root);
  const saved = writeBoardProjectRules(root, { text: "### Current linked rules", revision: opened.revision });
  assert.deepEqual(readBoardProjectRules(root), saved);
  assert.match(boardProjectRulesPrompt(root), /Current linked rules/);
  assert.equal(readlinkSync(link), targetName);
  const original = readFileSync(target, "utf8");
  assert.ok(original.startsWith(manual));

  const replacementName = "second instructions.md";
  const replacement = join(root, replacementName);
  writeFileSync(replacement, original);
  unlinkSync(link);
  symlinkSync(replacementName, link, "file");
  const latest = readBoardProjectRules(root);
  assert.notEqual(latest.revision, saved.revision);
  assert.throws(
    () => writeBoardProjectRules(root, { text: "Stale draft", revision: saved.revision }),
    { code: "PROJECT_RULES_CONFLICT", details: latest },
  );
  assert.equal(readFileSync(replacement, "utf8"), original);

  writeBoardProjectRules(root, { text: "", revision: latest.revision });
  assert.equal(readBoardProjectRules(root).text, "");
  assert.doesNotMatch(boardProjectRulesPrompt(root), /Current linked rules/);
  assert.equal(readFileSync(target, "utf8"), original);
  assert.ok(readFileSync(replacement, "utf8").startsWith(manual));
  assert.equal(readlinkSync(link), replacementName);
});
