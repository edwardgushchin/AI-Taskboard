import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { advanceWorktree } from "../src/cli/fast-forward-worktree.ts";
import { gitEnvironment } from "../src/cli/git.ts";
import { TaskboardError } from "../src/cli/model.ts";

const otherVolume = process.env.TASKBOARD_TEST_OTHER_VOLUME;
for (const [separateVolume, rollback] of [[false, false], [false, true], [true, false], [true, true]] as const) {
  const outcome = rollback ? "rollback" : "publication";
  const layout = separateVolume ? "split volumes" : "one volume";
  const skip = process.platform === "win32" || (separateVolume && !otherVolume);
  test("fast-forward preserves open file descriptors through " + outcome + " on " + layout, { skip }, async t => {
    const root = fs.mkdtempSync(join(tmpdir(), "taskboard-ff-test-"));
    const socket = createServer();
    const path = join(root, "tracked");
    const env = { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    let original: number | undefined;
    let installed: number | undefined;
    let external: string | undefined;
    try {
      let gitDir = join(root, ".git");
      if (separateVolume) {
        external = fs.mkdtempSync(join(otherVolume!, "taskboard-ff-test-"));
        assert.notEqual(fs.statSync(external, { bigint: true }).dev, fs.statSync(root, { bigint: true }).dev,
          "The split-volume fixture must use different devices");
        gitDir = join(external, "git");
        git("init", "-q", "-b", "main", "--separate-git-dir", gitDir);
      } else {
        git("init", "-q", "-b", "main");
      }
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Taskboard");
      fs.writeFileSync(join(root, ".gitattributes"), "tracked filter=fixture\n");
      fs.writeFileSync(join(root, ".gitignore"), "/ignored/\n");
      fs.mkdirSync(join(root, "tools"));
      fs.writeFileSync(join(root, "tools", "smudge.sh"), "test -r tools/smudge.sh || exit 1\ncat\n");
      fs.writeFileSync(path, "original\n");
      git("add", ".");
      git("commit", "-qm", "Base");
      const head = git("rev-parse", "HEAD");
      fs.writeFileSync(path, "incoming\n");
      git("commit", "-qam", "Target");
      const target = git("rev-parse", "HEAD");
      git("reset", "--hard", head);
      git("config", "filter.fixture.clean", "cat");
      git("config", "filter.fixture.smudge", "sh tools/smudge.sh");
      git("config", "filter.fixture.required", "true");
      const ignored = join(root, "ignored");
      const fifo = join(ignored, "pipe");
      const socketPath = join(ignored, "sock");
      fs.mkdirSync(ignored);
      execFileSync("mkfifo", [fifo]);
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });
      assert.equal(git("--no-optional-locks", "status", "--porcelain"), "");
      const index = fs.readFileSync(join(gitDir, "index"));

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
      const expectedParent = separateVolume ? join(root, ".tasks") : gitDir;
      assert.equal(fs.realpathSync(join(recoveryDirectory, "..")), fs.realpathSync(expectedParent));
      assert.equal(fs.statSync(recoveryDirectory, { bigint: true }).dev, fs.statSync(root, { bigint: true }).dev);
      assert.ok(fs.lstatSync(fifo).isFIFO());
      assert.ok(fs.lstatSync(socketPath).isSocket());
      assert.equal(git("--no-optional-locks", "status", "--porcelain"), "");
      fs.writeSync(original, "late original edit\n");
      fs.writeSync(installed!, "late incoming edit\n");
      const backup = join(recoveryDirectory, "0");
      assert.equal(JSON.parse(fs.readFileSync(join(backup, "path.json"), "utf8")), "tracked");
      assert.equal(fs.readFileSync(join(backup, "before"), "utf8"), "original\nlate original edit\n");
      if (rollback) {
        assert.equal(git("rev-parse", "HEAD"), head);
        assert.deepEqual(fs.readFileSync(join(gitDir, "index")), index);
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
      if (socket.listening) {
        await new Promise<void>(resolve => socket.close(() => resolve()));
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (external) {
        fs.rmSync(external, { recursive: true, force: true });
      }
    }
  });
}
