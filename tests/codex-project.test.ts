import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { test } from "node:test";
import { codexProject } from "../src/desktop/codex-project.ts";

test("the provider project is selected by a board path on any result page", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "taskboard-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const other = join(root, "unrelated");
  mkdirSync(other);
  const equivalent = (process.platform === "win32" ? root.toUpperCase() : root) + sep;
  const request = async <Result>(method: string, params: object): Promise<Result> => {
    assert.equal(method, "project/list");
    if (!("cursor" in params) || !params.cursor) {
      return { data: [{ id: "wrong", name: basename(root), roots: [{ path: other }] }], nextCursor: "next" } as Result;
    }
    assert.equal(params.cursor, "next");
    return { data: [{ id: "match", name: "Another name", roots: [{ path: other }, { path: equivalent }] }], nextCursor: null } as Result;
  };
  assert.equal(await codexProject(request, root), "match");
});

test("creation registers the root once and uses a stable key for simultaneous launches", async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "taskboard-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const created = new Map<unknown, { id: string; roots: { path: string }[] }>();
  const request = async <Result>(method: string, params: object): Promise<Result> => {
    if (method === "project/list") return { data: [...created.values()], nextCursor: null } as Result;
    assert.equal(method, "project/create");
    assert.ok("idempotencyKey" in params);
    assert.ok("roots" in params);
    assert.deepEqual(params.roots, [{ path: root }]);
    let project = created.get(params.idempotencyKey);
    if (!project) {
      project = { id: String(created.size + 1), roots: [{ path: root }] };
      created.set(params.idempotencyKey, project);
    }
    return { project } as Result;
  };
  assert.deepEqual(await Promise.all([codexProject(request, root), codexProject(request, root + sep)]), ["1", "1"]);
  assert.equal(await codexProject(request, root), "1");
  assert.equal(created.size, 1);
});
