import assert from "node:assert/strict";
import cp, { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { locateBoard } from "../src/cli/storage.ts";

test("push completion tracks the source and preserves concurrent user changes", async t => {
  const temporary = mkdtempSync(join(tmpdir(), "taskboard-upstream-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const original = cp.execFile;
  const realExecute = promisify(original);
  let afterPush: (root: string) => void = () => {};
  cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (command: string, args: string[], options: any) => {
    const result = await realExecute(command, args, options);
    if (command === "git" && args[0] === "push") afterPush(options.cwd);
    return result;
  } }) as unknown as typeof cp.execFile;
  syncBuiltinESMExports();
  t.after(() => { cp.execFile = original; syncBuiltinESMExports(); });
  const { pushRepositoryBranch } = await import(new URL("../src/cli/repository.ts?upstream-races", import.meta.url).href);
  let sequence = 0;
  const fixture = () => {
    const root = join(temporary, "repo-" + sequence++);
    const remote = root + "-remote";
    mkdirSync(root); mkdirSync(remote);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Tests"); git(root, "config", "user.email", "test@example.invalid");
    git(root, "commit", "--allow-empty", "-m", "initial");
    git(remote, "init", "--bare"); git(root, "remote", "add", "origin", remote);
    const cli = new URL("../src/cli/main.ts", import.meta.url);
    const init = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", fileURLToPath(cli), "--project", root, "--json", "init"], { env, encoding: "utf8", windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const head = git(root, "rev-parse", "HEAD");
    return { root, remote, head, push: () => pushRepositoryBranch(locateBoard(root), { branch: "main", head }) };
  };
  await t.test("switching checkout cannot configure the other branch", async () => {
    const f = fixture();
    git(f.root, "branch", "other");
    afterPush = root => { git(root, "switch", "other"); };
    await f.push();
    assert.equal(git(f.root, "branch", "--show-current"), "other");
    assert.equal(git(f.root, "config", "branch.main.merge"), "refs/heads/main");
    assert.equal(spawnSync("git", ["config", "--get", "branch.other.remote"], { cwd: f.root, env }).status, 1);
    assert.match(git(f.root, "ls-remote", "origin", "refs/heads/main"), new RegExp(f.head));
  });
  await t.test("conflicting upstream written during push is preserved", async () => {
    const f = fixture();
    afterPush = root => { git(root, "config", "branch.main.remote", "elsewhere"); git(root, "config", "branch.main.merge", "refs/heads/custom"); };
    await assert.rejects(f.push(), (error: any) => error.code === "GIT_UPSTREAM_FAILED" && error.details.pushed === true);
    assert.equal(git(f.root, "config", "branch.main.remote"), "elsewhere");
    assert.equal(git(f.root, "config", "branch.main.merge"), "refs/heads/custom");
  });
  await t.test("a changed source tip does not enter the pinned push", async () => {
    const f = fixture();
    afterPush = root => { git(root, "commit", "--allow-empty", "-m", "concurrent commit"); };
    await assert.rejects(f.push(), { code: "GIT_UPSTREAM_FAILED" });
    assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), f.head);
    assert.notEqual(git(f.root, "rev-parse", "HEAD"), f.head);
    assert.equal(spawnSync("git", ["config", "--get", "branch.main.remote"], { cwd: f.root, env }).status, 1);
  });
  await t.test("remote URL changes do not configure a new destination", async () => {
    const f = fixture();
    afterPush = root => { git(root, "remote", "set-url", "origin", "https://example.invalid/other"); };
    await assert.rejects(f.push(), { code: "GIT_UPSTREAM_FAILED" });
    assert.equal(spawnSync("git", ["config", "--get", "branch.main.remote"], { cwd: f.root, env }).status, 1);
    assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), f.head);
  });
  await t.test("configuration lock reports push success separately", async () => {
    const f = fixture();
    afterPush = root => writeFileSync(join(root, ".git", "config.lock"), "");
    try { await assert.rejects(f.push(), (error: any) => error.code === "GIT_UPSTREAM_FAILED" && error.details.pushed); }
    finally { rmSync(join(f.root, ".git", "config.lock")); }
    assert.equal(git(f.remote, "rev-parse", "refs/heads/main"), f.head);
    assert.equal(spawnSync("git", ["config", "--get", "branch.main.remote"], { cwd: f.root, env }).status, 1);
  });
  await t.test("failed push leaves upstream absent", async () => {
    const f = fixture();
    afterPush = () => {};
    git(f.root, "push", "origin", f.head + ":refs/heads/main");
    const remoteTip = git(f.root, "commit-tree", "HEAD^{tree}", "-p", f.head, "-m", "server advance");
    git(f.root, "push", "origin", remoteTip + ":refs/heads/main");
    await assert.rejects(f.push(), { code: "GIT_PUSH_FAILED" });
    assert.equal(spawnSync("git", ["config", "--get", "branch.main.remote"], { cwd: f.root, env }).status, 1);
  });
  await t.test("custom remote branch is preserved on repeated push", async () => {
    const f = fixture();
    afterPush = () => {};
    git(f.root, "config", "branch.main.remote", "origin"); git(f.root, "config", "branch.main.merge", "refs/heads/integration");
    await f.push(); await f.push();
    assert.equal(git(f.remote, "rev-parse", "refs/heads/integration"), f.head);
    assert.equal(git(f.root, "config", "branch.main.merge"), "refs/heads/integration");
  });
  await t.test("renamed fetch cache tracks the actual destination", async () => {
    const f = fixture();
    afterPush = () => {};
    git(f.root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/cache/*");
    await f.push();
    assert.equal(git(f.root, "config", "branch.main.remote"), "origin");
    assert.equal(git(f.root, "config", "branch.main.merge"), "refs/heads/main");
    assert.equal(git(f.root, "rev-parse", "main@{upstream}"), f.head);
  });
});
