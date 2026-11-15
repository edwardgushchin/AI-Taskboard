import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectIdentity, projectLabels, savedWindows } from "../src/desktop/project-tabs.ts";

test("project tabs distinguish folder names and restore only valid unique paths", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-tabs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, "first", "Project");
  const second = join(root, "second", "Project");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const alias = join(root, "alias");
  symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(projectIdentity(first), projectIdentity(alias));
  assert.notEqual(projectIdentity(first), projectIdentity(second));
  if (process.platform === "win32") assert.equal(projectIdentity(first), projectIdentity(first.toUpperCase()));
  assert.deepEqual(projectLabels([{ path: first }, { path: second }]), [
    { path: first, name: "Project", detail: "first" }, { path: second, name: "Project", detail: "second" },
  ]);
  assert.deepEqual(savedWindows([
    { projects: [first, alias, second, "relative", null, first + "\0"], active: second },
    { projects: [second], active: "missing" }, { projects: [] }, null, {},
  ]), [
    { projects: [first, second], active: second },
    { projects: [second], active: second }, { projects: [], active: undefined },
  ]);
  assert.deepEqual(savedWindows({ projects: [first] }), []);
  const nested = join(root, "other", "first", "Project");
  assert.equal(projectLabels([{ path: first }, { path: nested }])[0].detail, join(root, "first"));
  assert.deepEqual(projectLabels([{ path: first, name: "  Выпуск  " }, { path: second, name: " " }]), [
    { path: first, name: "Выпуск", detail: "" }, { path: second, name: "Project", detail: "" },
  ]);
  const sibling = join(root, "first", "Other");
  assert.deepEqual(projectLabels([{ path: first }, { path: sibling, name: "Project" }]), [
    { path: first, name: "Project", detail: first }, { path: sibling, name: "Project", detail: sibling },
  ]);
});
