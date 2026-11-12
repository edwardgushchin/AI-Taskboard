import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRecentBoards, rememberRecentBoard } from "../src/desktop/recent-boards.ts";

test("recent boards are shared by profiles and survive reopening", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-recent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "profile-1");
  const second = join(root, "profile-2");
  const appData = join(root, "user");
  const older = join(root, "Board old");
  const newest = join(root, "Board new");
  mkdirSync(first);
  writeFileSync(join(first, "recent-boards.json"), JSON.stringify([older, "relative", older]));
  assert.deepEqual(readRecentBoards(appData, first), [older]);
  assert.deepEqual(rememberRecentBoard(appData, first, newest), [newest, older]);
  assert.deepEqual(readRecentBoards(appData, second), [newest, older]);
  assert.deepEqual(rememberRecentBoard(appData, second, older), [older, newest]);
  assert.deepEqual(readRecentBoards(appData, first), [older, newest]);
});
