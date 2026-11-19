import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceWorktree } from "../src/cli/fast-forward-worktree.ts";
import { gitEnvironment } from "../src/cli/git.ts";
import { TaskboardError } from "../src/cli/model.ts";

for (const rollback of [false, true]) {
  const outcome = rollback ? "rollback" : "publication";
  test("fast-forward preserves open file descriptors through " + outcome, { skip: process.platform === "win32" }, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), "taskboard-ff-test-"));
    const path = join(root, "tracked");
    const env = { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    let original: number | undefined;
    let installed: number | undefined;
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Taskboard");
      fs.writeFileSync(path, "original\n");
      git("add", "tracked");
      git("commit", "-qm", "Base");
      const head = git("rev-parse", "HEAD");
      fs.writeFileSync(path, "incoming\n");
      git("commit", "-qam", "Target");
      const target = git("rev-parse", "HEAD");
      git("reset", "--hard", head);
      const index = fs.readFileSync(join(root, ".git", "index"));

      original = fs.openSync(path, "a");
      const write = fs.writeFileSync;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
        if (typeof args[0] === "number") {
          assert.equal(fs.readFileSync(path, "utf8"), "incoming\n");
          installed = fs.openSync(path, "a");
          if (rollback) {
            throw Object.assign(new Error("Controlled index write failure"), { code: "EIO" });
          }
        }
        return write(...args);
      });
      syncBuiltinESMExports();
      const advance = advanceWorktree(root, "refs/heads/main", head, target, env, () => ["tracked"]);
      let recoveryDirectory: string;
      if (rollback) {
        recoveryDirectory = await advance.then(
          () => assert.fail("Expected the index write to fail"),
          error => {
            assert.ok(error instanceof TaskboardError);
            assert.equal(error.code, "GIT_WORKTREE_PUBLISH_FAILED");
            return (error.details as { recoveryDirectory: string }).recoveryDirectory;
          },
        );
      } else {
        recoveryDirectory = await advance;
      }
      t.mock.restoreAll();
      syncBuiltinESMExports();

      assert.notEqual(installed, undefined);
      fs.writeSync(original, "late original edit\n");
      fs.writeSync(installed!, "late incoming edit\n");
      const backup = join(recoveryDirectory, "0");
      assert.equal(JSON.parse(fs.readFileSync(join(backup, "path.json"), "utf8")), "tracked");
      assert.equal(fs.readFileSync(join(backup, "before"), "utf8"), "original\nlate original edit\n");
      if (rollback) {
        assert.equal(git("rev-parse", "HEAD"), head);
        assert.deepEqual(fs.readFileSync(join(root, ".git", "index")), index);
        assert.equal(fs.readFileSync(path, "utf8"), "original\nlate original edit\n");
        assert.equal(fs.readFileSync(join(backup, "after"), "utf8"), "incoming\nlate incoming edit\n");
      } else {
        assert.equal(git("rev-parse", "HEAD"), target);
        assert.equal(fs.readFileSync(path, "utf8"), "incoming\nlate incoming edit\n");
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (installed !== undefined) {
        fs.closeSync(installed);
      }
      if (original !== undefined) {
        fs.closeSync(original);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
