import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardProjectRulesPrompt, readBoardProjectRules, writeBoardProjectRules } from "../src/cli/board-agents.ts";
import { initializeBoard, locateBoard } from "../src/cli/storage.ts";

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
