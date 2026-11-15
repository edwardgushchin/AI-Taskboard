import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRepository } from "../src/cli/git.ts";
import { locateBoard } from "../src/cli/storage.ts";

test("explicit nested init stays local despite parent Git and unrelated invocation cwd", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "T-0084-location-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const cli = (project: string, command: string, input?: unknown) => {
    const r = spawnSync(process.execPath, [entry, "--project", project, "--json", command, ...(input ? ["--stdin"] : [])],
      { encoding: "utf8", windowsHide: true, input: input ? JSON.stringify(input) : undefined });
    const result = JSON.parse(r.stdout);
    assert.equal(result.ok, true, r.stdout + r.stderr);
    return result.data;
  };
  assert.equal(cli(root, "init").project, root);
  const before = readFileSync(join(root, ".tasks/board.json"));
  const nested = join(root, "Temp", "board"); mkdirSync(nested, { recursive: true });
  // The old entry point used this discovery result without checking the selection.
  assert.equal(discoverRepository(nested)?.root, root);
  assert.equal(cli(nested, "init").project, nested);
  assert.deepEqual(readFileSync(join(root, ".tasks/board.json")), before);
  assert.equal(cli(nested, "list").project, nested);
  const sub = join(nested, "sub"); mkdirSync(sub);
  assert.equal(cli(sub, "list").project, nested);
  const otherSub = join(root, "source"); mkdirSync(otherSub);
  assert.equal(cli(otherSub, "list").project, root);
  const wt = join(root, "linked"); git("worktree", "add", "-b", "linked", wt);
  assert.equal(cli(wt, "init").project, root);
  assert.equal(cli(wt, "list").project, root);
  const wtSub = join(wt, "sub"); mkdirSync(wtSub);
  assert.equal(cli(wtSub, "list").project, root);
  assert.throws(() => locateBoard(join(root, "absent")));
  const gitNested = join(root, "new-git"); mkdirSync(gitNested);
  assert.equal(cli(gitNested, "init", { git: true }).project, gitNested);
  assert.deepEqual(readFileSync(join(root, ".tasks/board.json")), before);
});
