import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { nextScheduledRun } from "../src/cli/model.ts";
import { locateBoard } from "../src/cli/storage.ts";
import { maxWorklogPartBytes } from "../src/cli/worklog-files.ts";
import type { Task } from "../src/cli/model.ts";
import { boardToolContent } from "../src/desktop/board-mcp.ts";
import { taskChatActions } from "../src/desktop/chat-actions.ts";
import { registerRuntime, runtimeEntries, runtimeTransaction } from "../src/desktop/board-runtime.ts";

const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const env = {
  ...process.env,
  GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: TestContext, repository = false): string {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "ai-taskboard-test-"));
  t.after(() => {
    if (!existsSync(root)) return;
    assert.equal(dirname(realpathSync(root)), parent);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  if (repository) {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Taskboard Tests");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "maintenance.auto", "false");
    writeFileSync(join(root, ".gitignore"), "*.local\n");
    writeFileSync(join(root, "source.txt"), "baseline\n");
    git(root, "add", ".gitignore", "source.txt");
    git(root, "commit", "-m", "chore: initialize test repository");
  }
  return root;
}

function commandArgs(root: string, args: string[], input?: unknown): string[] {
  return ["--disable-warning=ExperimentalWarning", entry, "--project", root, "--json", ...args,
    ...(input === undefined ? [] : ["--stdin"])];
}

function cli(root: string, args: string[], input?: unknown, expectedCode?: string) {
  const result = spawnSync(process.execPath, commandArgs(root, args, input), {
    env, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true,
  });
  assert.ok(result.stdout, result.stderr);
  const payload = JSON.parse(result.stdout);
  if (expectedCode) {
    assert.equal(result.status, 1, result.stdout);
    assert.equal(payload.error?.code, expectedCode, result.stdout);
    return payload.error;
  }
  assert.equal(result.status, 0, result.stdout);
  assert.equal(payload.ok, true);
  return payload.data;
}

test("repository Git menu lists commit metadata and changes only the main worktree", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const base = git(root, "rev-parse", "HEAD");
  git(root, "branch", "feature");
  git(root, "tag", "light");
  git(root, "tag", "-a", "release", "-m", "Release tag message");
  const snapshot = () => cli(root, ["git", "refs"]);
  const current = () => ({ head: snapshot().head, branch: snapshot().branch });
  const initial = snapshot();
  assert.deepEqual(initial.refs.map((ref: { name: string }) => ref.name).sort(), ["feature", "light", "main", "release"]);
  for (const ref of initial.refs) {
    assert.equal(ref.sha, base);
    assert.equal(ref.author, "Taskboard Tests");
    assert.equal(ref.subject, "chore: initialize test repository");
    assert.ok(Number.isFinite(Date.parse(ref.date)));
  }
  assert.equal(cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/feature" }).branch, "feature");
  cli(root, ["git", "create"], { ...current(), name: "from-tag", ref: "refs/tags/release" });
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  cli(root, ["git", "create"], { ...current(), name: "new-branch" });
  cli(root, ["git", "detach"], { ...current(), ref: "refs/heads/main" });
  assert.equal(snapshot().branch, undefined);
  assert.equal(snapshot().head, base);
  cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/main" });
  cli(root, ["git", "switch"], { ...current(), ref: "refs/tags/light" });
  assert.equal(snapshot().branch, undefined);
  cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/main" });

  const task = cli(root, ["create"], { title: "Active task", criteria: ["Checked"] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  cli(worktree, ["git", "switch"], { ...current(), ref: "refs/heads/feature" });
  assert.equal(git(root, "branch", "--show-current"), "feature");
  assert.equal(git(worktree, "branch", "--show-current"), "ai-taskboard/" + task.id);
  cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/ai-taskboard/" + task.id }, "GIT_FAILED");
  assert.equal(git(worktree, "rev-parse", "HEAD"), base);
});

test("Git commit diff reads pinned revisions and literal paths in bounded pages", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const from = git(root, "rev-parse", "HEAD");
  const selected = "literal[1].txt";
  writeFileSync(join(root, selected), "Unicode " + "😀".repeat(10_000) + "\n");
  writeFileSync(join(root, "literal1.txt"), "Unselected committed change\n");
  git(root, "add", "--all");
  git(root, "commit", "-m", "test: add committed content");
  const to = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, selected), "Working tree edit\n");
  const args = { view: "commit_diff", from, to, paths: [selected] };
  const first = cli(root, ["git", "inspect"], args);
  assert.equal(first.truncated, true);
  assert.ok(first.nextOffset <= 16_000);
  assert.notEqual(first.output.at(-1)?.charCodeAt(0) ?? 0, 0xd83d);
  const last = cli(root, ["git", "inspect"], { ...args, offset: first.nextOffset });
  assert.equal(last.truncated, false);
  assert.equal(last.nextOffset, undefined);
  const output = first.output + last.output;
  assert.ok(output.includes("Unicode " + "😀".repeat(10_000)));
  assert.doesNotMatch(output, /Unselected committed change|Working tree edit/);
  cli(root, ["git", "inspect"], { ...args, from: "HEAD" }, "INVALID_INPUT");
  cli(root, ["git", "inspect"], { ...args, paths: ["../outside"] }, "INVALID_INPUT");
  cli(root, ["git", "inspect"], { ...args, offset: output.length + 1 }, "INVALID_INPUT");
});

test("review diff by line reads the hunk containing that line in the newer commit", t => {
  const root = fixture(t, true);
  const lines = Array.from({ length: 40 }, (_, index) => "line " + (index + 1));
  writeFileSync(join(root, "source.txt"), lines.join("\n") + "\n");
  const large = (prefix: string) => Array.from({ length: 210 }, (_, index) =>
    `${prefix} row ${index + 1} ${prefix.repeat(90)}\n`).join("");
  writeFileSync(join(root, "large.txt"), large("old"));
  git(root, "add", "source.txt", "large.txt");
  git(root, "commit", "-m", "test: create a multi-hunk source fixture");
  const targetHead = git(root, "rev-parse", "HEAD");
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Edit separated lines", criteria: ["Both changes are recorded"] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  lines.splice(2, 1, "first change");
  lines.splice(29, 1, "second change");
  writeFileSync(join(worktree, "source.txt"), lines.join("\n") + "\n");
  writeFileSync(join(worktree, "large.txt"), large("new").trimEnd());
  const preview = cli(root, ["preview", task.id]);
  const submitted = cli(root, ["submit", task.id], {
    token: preview.token, message: "test: edit separated lines", summary: "Edited lines", checks: ["Inspected diff"],
  });
  const input = { revision: submitted.revision, targetHead, paths: ["source.txt"], contextLines: 0 };
  const focused = cli(root, ["review", task.id], { ...input, line: 30 });
  assert.match(focused.diff, /\n@@ -30 \+30 @@/);
  assert.match(focused.diff, /\n\+second change\n/);
  assert.doesNotMatch(focused.diff, /first change/);
  assert.equal(cli(root, ["review", task.id], { ...input, line: 15 }).diff, "");
  assert.match(cli(root, ["review", task.id], input).diff, /\n\+first change\n/);
  const narrow = cli(root, ["review", task.id], { ...input, line: 30, lineRadius: 0 });
  assert.match(narrow.diff, /\n@@ -30,1 \+30,1 @@[^\n]*\n-line 30\n\+second change\n/);
  const window = { ...input, paths: ["large.txt"], line: 210 };
  const full = cli(root, ["review", task.id], window);
  assert.ok(full.nextOffset);
  assert.doesNotMatch(full.diff, /new row 210 /);
  const nearby = cli(root, ["review", task.id], { ...window, lineRadius: 2 });
  assert.match(nearby.diff, /\n@@ -210,0 \+208,3 @@/);
  assert.match(nearby.diff, /\n\+new row 210 .*\n\\ No newline at end of file\n/);
  assert.doesNotMatch(nearby.diff, /new row 207 /);
  assert.equal(nearby.nextOffset, undefined);
  cli(root, ["review", task.id], { ...input, line: 0 }, "INVALID_INPUT");
  cli(root, ["review", task.id], { ...input, lineRadius: 2 }, "INVALID_INPUT");
  cli(root, ["review", task.id], { ...input, line: 30, lineRadius: 101 }, "INVALID_INPUT");
  cli(root, ["review", task.id], { ...input, line: 30, paths: ["source.txt", "other.txt"] }, "INVALID_INPUT");
});

test("repository Git menu preserves conflicting edits and rejects invalid or stale actions", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const initial = cli(root, ["git", "refs"]);
  const current = () => {
    const { head, branch } = cli(root, ["git", "refs"]);
    return { head, branch };
  };
  git(root, "switch", "-c", "different");
  writeFileSync(join(root, "source.txt"), "different\n");
  git(root, "commit", "-am", "feat: different content");
  git(root, "switch", "main");
  writeFileSync(join(root, "source.txt"), "local edits\n");
  cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/different" }, "GIT_FAILED");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "local edits\n");
  assert.equal(git(root, "branch", "--show-current"), "main");
  cli(root, ["git", "create"], { ...current(), name: "--discard-changes" }, "INVALID_INPUT");
  cli(root, ["git", "create"], { ...current(), name: "bad name" }, "INVALID_INPUT");
  cli(root, ["git", "switch"], { ...current(), ref: "--discard-changes" }, "INVALID_INPUT");
  cli(root, ["git", "switch"], { ...current(), ref: "refs/heads/missing" }, "GIT_COMMIT_REQUIRED");
  cli(root, ["git", "create"], { ...current(), name: "main" }, "GIT_FAILED");
  cli(root, ["git", "create"], { head: "stale", branch: "main", name: "stale" }, "STALE_REPOSITORY");
  cli(root, ["git", "create"], { ...initial, branch: "other", name: "stale" }, "STALE_REPOSITORY");
  writeFileSync(join(root, ".git", "MERGE_HEAD"), initial.head + "\n");
  cli(root, ["git", "create"], { ...current(), name: "during-merge" }, "GIT_OPERATION_IN_PROGRESS");

  const plain = fixture(t);
  cli(plain, ["init"]);
  cli(plain, ["git", "refs"], undefined, "GIT_REQUIRED");
  const empty = fixture(t);
  git(empty, "init", "-b", "main");
  cli(empty, ["init"]);
  assert.deepEqual(cli(empty, ["git", "refs"]), { branch: "main", refs: [] });
  const created = cli(empty, ["git", "create"], { branch: "main", name: "first" });
  assert.equal(created.branch, "first");
  cli(empty, ["git", "detach"], { branch: "first" }, "GIT_COMMIT_REQUIRED");
});

test("GitHub publication validates input, preserves partial results and pins push arguments", async t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  let mode = "";
  const calls: { command: string; args: string[] }[] = [];
  const remote = "https://github.com/owner/repository.git";
  const fake = Object.assign(() => {}, { [promisify.custom]: async (command: string, args: string[], options: { cwd: string }) => {
    assert.equal(options.cwd, root);
    calls.push({ command, args });
    if (args[0] === "auth" && ["missing", "auth-failed"].includes(mode)) {
      throw Object.assign(new Error("Authentication failed"), { code: mode === "missing" ? "ENOENT" : 1 });
    }
    if (args[0] === "repo") {
      if (mode === "create-failed") throw Object.assign(new Error("Create failed"), { stderr: "Connection failed" });
      if (mode === "move-head") git(root, "switch", "other");
      git(root, "remote", "add", "origin", remote);
    }
    if (command === "git" && mode === "push-failed") throw Object.assign(new Error("Push failed"), { stderr: "Push rejected https://test-user:test-password@example.invalid/repo" });
    if (command === "git") {
      git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "refs/heads/main"));
      if (mode === "upstream-failed") writeFileSync(join(root, ".git", "config.lock"), "");
    }
    return { stdout: "", stderr: "" };
  } });
  const original = childProcess.execFile;
  childProcess.execFile = fake as unknown as typeof original;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  const { publishRepository } = await import(new URL("../src/cli/repository.ts", import.meta.url).href);
  const { locateBoard } = await import("../src/cli/storage.ts");
  const location = locateBoard(root);
  const snapshot = cli(root, ["git", "refs"]);
  const input = { head: snapshot.head, branch: snapshot.branch, name: "owner/repository", visibility: "private" };
  const publish = async (nextMode: string, fields: Record<string, unknown>, code?: string) => {
    mode = nextMode;
    if (code) await assert.rejects(publishRepository(location, fields), (error: any) => {
      assert.equal(error.code, code);
      if (nextMode === "push-failed") {
        assert.match(error.details.output, /Push rejected/);
        assert.doesNotMatch(error.details.output, /test-user|test-password/);
      }
      return true;
    });
    else assert.equal((await publishRepository(location, fields)).remote, remote);
  };
  await publish("", { ...input, name: "--public" }, "INVALID_INPUT");
  await publish("", { ...input, visibility: "internal" }, "INVALID_INPUT");
  await publish("", { ...input, head: "stale" }, "STALE_REPOSITORY");
  await publish("missing", input, "GITHUB_UNAVAILABLE");
  await publish("auth-failed", input, "GITHUB_UNAVAILABLE");
  assert.equal(git(root, "remote"), "");
  await publish("create-failed", input, "GITHUB_PUBLISH_FAILED");
  await publish("push-failed", input, "GITHUB_PUSH_FAILED");
  assert.equal(git(root, "remote", "get-url", "origin"), remote);
  await publish("", input, "REMOTE_EXISTS");
  git(root, "remote", "remove", "origin");
  try { await publish("upstream-failed", input, "GIT_UPSTREAM_FAILED"); }
  finally { rmSync(join(root, ".git", "config.lock")); }
  assert.equal(git(root, "remote", "get-url", "origin"), remote);
  assert.equal(spawnSync("git", ["config", "--get", "branch.main.remote"], { cwd: root, env }).status, 1);
  git(root, "remote", "remove", "origin");
  git(root, "switch", "-c", "other");
  writeFileSync(join(root, "other.txt"), "other branch\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-m", "feat: other branch");
  git(root, "switch", "main");
  await publish("move-head", input);
  assert.equal(git(root, "branch", "--show-current"), "other");
  assert.deepEqual(calls.findLast(call => call.command === "gh" && call.args[0] === "repo")?.args, [
    "repo", "create", "owner/repository", "--private", "--source", root, "--remote", "origin",
  ]);
  assert.equal(git(root, "config", "branch.main.remote"), "origin");
  assert.equal(git(root, "config", "branch.main.merge"), "refs/heads/main");
  assert.equal(spawnSync("git", ["config", "--get", "branch.other.remote"], {cwd: root, env}).status, 1);
  assert.deepEqual(calls.at(-1), { command: "git", args: ["push", "--porcelain", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", input.head + ":refs/heads/main"] });
});

test("GitHub milestones can be listed, assigned and cleared on local tasks", t => {
  const root = fixture(t, true);
  const tools = fixture(t);
  const executable = join(tools, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "");
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Prepare the release" });
  cli(root, ["milestones"], undefined, "GITHUB_REMOTE_REQUIRED");
  git(root, "remote", "add", "origin", "git@github.com:Owner/Example.git");
  const mock = `
    import cp from 'node:child_process';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    let requests = 0;
    cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (cmd, args) => {
      assert.equal(cmd, ${JSON.stringify(executable)});
      assert.equal(++requests, 1);
      assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
      const open = { number: 5, title: 'Версия 1.0', state: 'open', due_on: '2026-11-20T00:00:00Z' };
      const closed = { number: 3, title: 'Earlier release', state: 'closed' };
      switch (args.at(-1)) {
        case 'repos/owner/example/milestones?state=all&per_page=100':
          assert.deepEqual(args.slice(3, -1), ['--paginate', '--slurp']);
          return { stdout: JSON.stringify([[open], [closed]]) };
        case 'repos/owner/example/milestones/5':
          return { stdout: JSON.stringify(open) };
        default: throw new Error('Unknown milestone');
      }
    } });
    syncBuiltinESMExports();
  `;
  const call = (args: string[], input?: unknown) => {
    const result = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock),
      ...commandArgs(root, args, input)], {
      env: { ...env, PATH: tools + delimiter + process.env.PATH }, encoding: "utf8",
      input: input === undefined ? undefined : JSON.stringify(input), windowsHide: true,
    });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(call(["milestones"]).data, { repository: "owner/example", milestones: [
    { number: 5, title: "Версия 1.0", state: "open", due_on: "2026-11-20T00:00:00Z" },
    { number: 3, title: "Earlier release", state: "closed", due_on: null },
  ] });
  const select = (number: number, revision = task.revision, repository = "owner/example") =>
    call(["milestone", task.id], { revision, milestone: { repository, number } });
  assert.equal(select(5, task.revision, "other/example").error.code, "GITHUB_REMOTE_REQUIRED");
  assert.equal(select(8).error.code, "GITHUB_MILESTONES_FAILED");
  const saved = select(5).data;
  assert.equal(saved.status, "draft");
  const milestone = { repository: "owner/example", number: 5, title: "Версия 1.0" };
  assert.deepEqual(cli(root, ["show", task.id]).milestone, milestone);
  assert.deepEqual(cli(root, ["list", "--compact"]).tasks[0].milestone, milestone);
  assert.equal(select(5).error.code, "REVISION_CONFLICT");
  const toArchive = cli(root, ["create"], { title: "An obsolete release task" });
  const closed = cli(root, ["cancel", toArchive.id], { revision: toArchive.revision, reason: "Obsolete" });
  const another = cli(root, ["create"], { title: "Prepare release notes" });
  const selection = { repository: "owner/example", number: 5 };
  const batch = call(["milestone-batch"], { tasks: [task, closed, another].map(({ id, revision }) => ({ id, revision })),
    milestone: selection, actor: "manager" });
  assert.equal(batch.ok, true, JSON.stringify(batch.error));
  assert.deepEqual(batch.data.milestone, milestone);
  assert.deepEqual(batch.data.tasks.map((item: { ok: boolean }) => item.ok), [false, true, true]);
  assert.equal(batch.data.tasks[0].error.code, "REVISION_CONFLICT");
  const updated = cli(root, ["show", toArchive.id]);
  assert.equal(updated.closedAt, closed.closedAt);
  assert.equal(updated.status, "cancelled");
  assert.equal(updated.history.at(-1).actor, "manager");
  const same = call(["milestone-batch"], { tasks: [{ id: another.id, revision: another.revision + 1 }],
    milestone: selection, actor: "manager" }).data.tasks[0].data;
  assert.equal(same.changed, false);
  assert.equal(same.revision, another.revision + 1);
  cli(root, ["settings"], { archiveAfterDays: 0 });
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, [toArchive.id]);
  assert.deepEqual(cli(root, ["show", toArchive.id]).milestone, milestone);
  assert.deepEqual(cli(root, ["list", "--compact"]).archived[0].milestone, milestone);
  assert.deepEqual(cli(root, ["show", another.id]).milestone, milestone);
  git(root, "remote", "remove", "origin");
  cli(root, ["milestone", task.id], { revision: saved.revision, milestone: null });
  assert.equal(cli(root, ["show", task.id]).milestone, undefined);
});

test("GitHub read uses fixed host requests and distinguishes credentials from repository access", t => {
  const project = fixture(t, true);
  const tools = fixture(t);
  const executable = join(tools, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "");
  writeFileSync(join(project, process.platform === "win32" ? "gh.exe" : "gh"), "");
  cli(project, ["init"]);
  git(project, "remote", "add", "origin", "git@github.com:Owner/Example.git");
  const worktree = join(tools, "linked");
  git(project, "worktree", "add", "-b", "linked", worktree);
  const mock = `
    import cp from 'node:child_process';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    import { promisify } from 'node:util';
    const mode = process.env.TASKBOARD_TEST_GITHUB;
    let checkedIdentity = false;
    cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (cmd, args, options) => {
      assert.equal(cmd, ${JSON.stringify(executable)});
      assert.equal(options.cwd, homedir());
      assert.equal(options.env.GH_CONFIG_DIR, join(homedir(), 'gh-test-profile'));
      assert.equal(options.env.GH_PROMPT_DISABLED, '1');
      assert.equal(options.env.GH_DEBUG, undefined);
      const fail = stderr => { throw Object.assign(new Error('fixture-output'), { stderr, stdout: 'fixture-output' }); };
      if (args[0] === 'auth') {
        assert.equal(checkedIdentity, true);
        assert.ok(args.includes('--json') && !args.includes('--show-token'));
        assert.ok(!mode.startsWith('override'));
        const source = ['keyring', 'unconfigured'].includes(mode) ? '' : 'keyring';
        return { stdout: JSON.stringify([{ configured: mode !== 'unconfigured', tokenSource: source }]) };
      }
      if (args[0] === 'run') {
        assert.deepEqual(args, ['run', 'view', '43816168554', '--repo', 'github.com/owner/example', '--log-failed']);
        if (mode === 'hidden') fail('gh: Not Found (HTTP 404)');
        return { stdout: 'token=fixture-output\\n' + 'x'.repeat(16_000) };
      }
      assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
      assert.equal(args.length, 4);
      if (args[3] === 'user') {
        checkedIdentity = true;
        if (['keyring', 'expired', 'override', 'override-legacy', 'unconfigured', 'hidden-and-unauthorized'].includes(mode)) {
          if (mode === 'override') assert.equal(options.env.GH_TOKEN, 'fixture-output');
          if (mode === 'override-legacy') assert.equal(options.env.GITHUB_TOKEN, 'fixture-output');
          fail('gh: Bad credentials (HTTP 401)');
        }
        return { stdout: JSON.stringify({ login: 'test-user', unrelated: 'fixture-output' }) };
      }
      assert.equal(args[3], 'repos/owner/example');
      if (['hidden', 'hidden-and-unauthorized'].includes(mode)) fail('gh: Not Found (HTTP 404)');
      if (mode === 'scope') fail('gh: Resource not accessible by personal access token (HTTP 403)');
      return { stdout: JSON.stringify({ full_name: 'Owner/Example', default_branch: 'main', private: true, unrelated: 'fixture-output' }) };
    } });
    syncBuiltinESMExports();
  `;
  const read = (input: unknown, mode = "success", selected = project) => {
    const child = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock),
      ...commandArgs(selected, ["github-read"], input)], {
      env: { ...env, PATH: [project, tools, process.env.PATH].join(delimiter), GH_CONFIG_DIR: "gh-test-profile",
        GH_DEBUG: "api", GH_TOKEN: mode === "override" ? "fixture-output" : "",
        GITHUB_TOKEN: mode === "override-legacy" ? "fixture-output" : "",
        TASKBOARD_TEST_GITHUB: mode },
      input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
    });
    assert.ok(child.stdout, child.stderr);
    assert.doesNotMatch(child.stdout, /fixture-output/);
    return JSON.parse(child.stdout);
  };
  assert.deepEqual(read({ view: "account" }).data, { login: "test-user" });
  assert.deepEqual(read({ view: "repository" }, "success", worktree).data,
    { repository: "Owner/Example", defaultBranch: "main", private: true });
  assert.equal(read({ view: "repository", endpoint: "user/emails" }).error.code, "INVALID_INPUT");
  const runId = 43816168554;
  const latest = read({ view: "run-failed-log", runId }, "success", worktree).data;
  assert.deepEqual(latest, { repository: "owner/example", runId, log: "x".repeat(16_000), nextBefore: 17 });
  assert.deepEqual(read({ view: "run-failed-log", runId, before: latest.nextBefore }).data,
    { repository: "owner/example", runId, log: "token=[redacted]\n" });
  assert.equal(read({ view: "run-failed-log", runId, repository: "other/repo" }).error.code, "INVALID_INPUT");
  assert.equal(read({ view: "run-failed-log", runId: "--help" }).error.code, "INVALID_INPUT");
  assert.equal(read({ view: "run-failed-log", runId }, "hidden").error.code, "GITHUB_RESOURCE_ACCESS");
  assert.equal(read({ view: "account" }, "keyring").error.code, "GITHUB_AUTH_STORAGE");
  assert.equal(read({ view: "account" }, "unconfigured").error.code, "GITHUB_AUTH_REQUIRED");
  assert.equal(read({ view: "account" }, "expired").error.code, "GITHUB_AUTH_REJECTED");
  assert.equal(read({ view: "account" }, "override").error.code, "GITHUB_AUTH_OVERRIDE");
  const legacy = read({ view: "account" }, "override-legacy");
  assert.equal(legacy.error.code, "GITHUB_AUTH_OVERRIDE");
  assert.match(legacy.error.message, /^GITHUB_TOKEN /);
  assert.equal(read({ view: "repository" }, "scope").error.code, "GITHUB_AUTH_SCOPE");
  assert.equal(read({ view: "repository" }, "hidden").error.code, "GITHUB_RESOURCE_ACCESS");
  assert.equal(read({ view: "repository" }, "hidden-and-unauthorized").error.code, "GITHUB_AUTH_REJECTED");
});

test("GitHub milestone deadline is pinned to origin and verified after writing", t => {
  const root = fixture(t, true);
  const tools = fixture(t);
  const executable = join(tools, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "");
  cli(root, ["init"]);
  git(root, "remote", "add", "origin", "git@github.com:Owner/Example.git");
  const mock = `
    import cp from 'node:child_process';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    const mode = process.env.TASKBOARD_TEST_MILESTONE;
    const milestone = { number: 1, title: 'Existing', state: 'closed', due_on: null };
    if (mode === 'same') milestone.due_on = '2026-11-20T00:00:00Z';
    const base = ['api', '--hostname', 'github.com'];
    const endpoint = 'repos/owner/example/milestones/1';
    let reads = 0;
    let writes = 0;
    cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (cmd, args) => {
      assert.equal(cmd, ${JSON.stringify(executable)});
      assert.ok(!['invalid', 'wrong-origin'].includes(mode));
      if (args.includes('PATCH')) {
        assert.deepEqual(args, [...base, '--method', 'PATCH', '-f', 'due_on=2026-11-20T00:00:00Z', endpoint]);
        writes++;
        assert.equal(reads, 1);
        if (mode === 'denied') {
          throw Object.assign(new Error('fixture-only'), { stderr: 'gh: Resource not accessible by personal access token (HTTP 403)' });
        }
        if (mode !== 'unverified') milestone.due_on = '2026-11-20T00:00:00Z';
        return { stdout: '{}' };
      }
      assert.deepEqual(args, [...base, endpoint]);
      reads++;
      return { stdout: JSON.stringify(milestone) };
    } });
    process.on('exit', () => {
      if (mode === 'same') assert.deepEqual([reads, writes], [1, 0]);
      if (['success', 'unverified'].includes(mode)) assert.deepEqual([reads, writes], [2, 1]);
      if (mode === 'denied') assert.deepEqual([reads, writes], [1, 1]);
      if (['invalid', 'wrong-origin'].includes(mode)) assert.deepEqual([reads, writes], [0, 0]);
    });
    syncBuiltinESMExports();
  `;
  const input = { repository: "OWNER/Example", number: 1, dueDate: "2026-11-20" };
  const run = (mode: string, args = input) => {
    const result = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock),
      ...commandArgs(root, ["github-milestone-due"], args)], {
      env: { ...env, PATH: tools + delimiter + process.env.PATH, TASKBOARD_TEST_MILESTONE: mode },
      input: JSON.stringify(args), encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /fixture-only/);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run("success").data, { repository: "owner/example", number: 1, title: "Existing", state: "closed",
    dueDate: "2026-11-20", url: "https://github.com/owner/example/milestone/1", changed: true });
  assert.equal(run("same").data.changed, false);
  assert.equal(run("unverified").error.code, "GITHUB_MILESTONE_VERIFY_FAILED");
  assert.equal(run("denied").error.code, "GITHUB_AUTH_SCOPE");
  assert.equal(run("wrong-origin", { ...input, repository: "Other/Example" }).error.code, "GITHUB_REMOTE_REQUIRED");
  assert.equal(run("invalid", { ...input, dueDate: "2026-02-29" }).error.code, "INVALID_INPUT");
});

test("GitHub milestone creation is retryable and both deadlines can be read separately", t => {
  const root = fixture(t, true);
  const tools = fixture(t);
  const executable = join(tools, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(executable, "");
  cli(root, ["init"]);
  git(root, "remote", "add", "origin", "git@github.com:Owner/Example.git");
  const state = join(tools, "milestones.json");
  writeFileSync(state, JSON.stringify([{ number: 1, title: "First", state: "open", due_on: "2026-11-20T00:00:00Z" }]));
  const mock = `
    import cp from 'node:child_process';
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    const mode = process.env.TASKBOARD_TEST_MILESTONE;
    const path = ${JSON.stringify(state)};
    const base = ['api', '--hostname', 'github.com'];
    const endpoint = 'repos/owner/example/milestones';
    cp.execFile = Object.assign(() => {}, { [promisify.custom]: async (cmd, args) => {
      assert.equal(cmd, ${JSON.stringify(executable)});
      assert.deepEqual(args.slice(0, 3), base);
      const milestones = JSON.parse(readFileSync(path, 'utf8'));
      if (args.includes('POST')) {
        assert.ok(mode === 'create' || mode === 'race');
        assert.deepEqual(args, [...base, '--method', 'POST', '-f', 'title=Next', '-f', 'due_on=2026-11-27T00:00:00Z', endpoint]);
        assert.ok(!milestones.some(row => row.title === 'Next'));
        const next = { number: 2, title: 'Next', state: 'open', due_on: '2026-11-27T00:00:00Z' };
        writeFileSync(path, JSON.stringify([...milestones, next]));
        if (mode === 'race') throw Object.assign(new Error('fixture-only'), { stderr: 'gh: Validation Failed (HTTP 422)' });
        return { stdout: JSON.stringify({ number: next.number }) };
      }
      if (args.includes('--paginate')) {
        assert.deepEqual(args, [...base, '--paginate', '--slurp', endpoint + '?state=all&per_page=100']);
        return { stdout: JSON.stringify([milestones]) };
      }
      assert.equal(args.length, 4);
      const selected = milestones.find(row => args[3] === endpoint + '/' + row.number);
      assert.ok(selected);
      return { stdout: JSON.stringify(selected) };
    } });
    syncBuiltinESMExports();
  `;
  const run = (command: string, args: unknown, mode = "read") => {
    const result = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(mock),
      ...commandArgs(root, [command], args)], {
      env: { ...env, PATH: tools + delimiter + process.env.PATH, TASKBOARD_TEST_MILESTONE: mode },
      input: JSON.stringify(args), encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /fixture-only/);
    return JSON.parse(result.stdout);
  };
  const input = { repository: "owner/example", title: "Next", dueDate: "2026-11-27" };
  const first = readFileSync(state, "utf8");
  const created = run("github-milestone-create", input, "create");
  assert.deepEqual(created.data, { repository: "owner/example", number: 2, title: "Next", state: "open",
    dueDate: "2026-11-27", url: "https://github.com/owner/example/milestone/2", created: true });
  assert.deepEqual(run("github-milestone-create", { ...input, dueDate: "2026-12-01" }).data,
    { ...created.data, created: false });
  assert.equal(run("github-read", { view: "milestone", number: 1 }).data.dueDate, "2026-11-20");
  assert.equal(run("github-read", { view: "milestone", number: 2 }).data.dueDate, "2026-11-27");
  assert.equal(run("github-milestone-create", { ...input, repository: "other/repo" }).error.code, "GITHUB_REMOTE_REQUIRED");
  writeFileSync(state, first);
  assert.deepEqual(run("github-milestone-create", input, "race").data, { ...created.data, created: false });
});

test("dependencies prevent worktree creation until every dependency is completed", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const fields = { criteria: ["Verified"] };
  const first = cli(root, ["create"], { ...fields, title: "First" });
  const second = cli(root, ["create"], { ...fields, title: "Second" });
  const task = cli(root, ["create"], {
    ...fields, title: "Dependent", dependencies: [first.id, second.id],
    execution: { model: "test-model", effort: "high" },
  });
  cli(root, ["update", first.id], { dependencies: [task.id] }, "DEPENDENCY_CYCLE");
  cli(root, ["update", task.id], { dependencies: ["T-9999"] }, "TASK_NOT_FOUND");
  cli(root, ["approve", task.id]);
  const manual = cli(root, ["block", task.id], {
    allowUnstarted: true, actor: "manager", reason: "Waiting for acceptance", condition: "Accept the prerequisites",
  });
  const unblock = { actor: "manager", revision: manual.revision, reason: "Track the prerequisites on the board" };
  cli(root, ["unblock", task.id], { ...unblock, dependencies: [task.id] }, "DEPENDENCY_CYCLE");
  assert.deepEqual(cli(root, ["show", task.id]).blocked, manual.blocked);
  const waiting = cli(root, ["unblock", task.id], { ...unblock, dependencies: [first.id, second.id] });
  assert.equal(waiting.status, "ready");
  assert.equal(waiting.blocked, undefined);
  const blocked = () => cli(root, ["start", task.id], undefined, "DEPENDENCIES_INCOMPLETE").details.dependencies;
  assert.deepEqual(blocked(), [first.id, second.id]);
  const summary = cli(root, ["list", "--compact"]).tasks.find((entry: { id: string }) => entry.id === task.id);
  assert.deepEqual(summary.unfinishedDependencies, [first.id, second.id]);
  assert.equal(cli(root, ["show", task.id]).status, "ready");
  assert.ok(!existsSync(join(root, ".worktrees", task.id)));

  function complete(dependency: string, file: string) {
    cli(root, ["approve", dependency]);
    const { worktree } = cli(root, ["start", dependency]);
    writeFileSync(join(worktree, file), "dependency\n");
    const preview = cli(root, ["preview", dependency]);
    cli(root, ["submit", dependency], { token: preview.token, message: "feat: complete dependency", summary: "Complete", checks: ["Checked"] });
    const review = cli(root, ["review", dependency]);
    cli(root, ["accept", dependency], { revision: review.revision, targetHead: review.targetHead, message: review.message });
  }
  complete(first.id, "first.txt");
  assert.deepEqual(blocked(), [second.id]);
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  assert.deepEqual(blocked(), [second.id]);
  complete(second.id, "second.txt");
  assert.deepEqual(cli(root, ["show", task.id]).unfinishedDependencies, []);
  const started = cli(root, ["start", task.id]);
  assert.equal(started.task.status, "in_progress");
  assert.deepEqual(started.task.execution, { model: "test-model", effort: "high" });
  assert.ok(existsSync(started.worktree));
});

test("cancelled dependencies keep an existing-directory task ready and unavailable, including after archival", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const dependency = cli(root, ["create"], { title: "Cancelled prerequisite", criteria: ["Verified"] });
  cli(root, ["cancel", dependency.id], { reason: "No longer planned" });
  const task = cli(root, ["create"], {
    title: "Waiting task", criteria: ["Verified"], workingDirectory: root, dependencies: [dependency.id],
  });
  const ready = cli(root, ["approve", task.id]);
  for (const archived of [false, true]) {
    if (archived) {
      cli(root, ["settings"], { archiveAfterDays: 0 });
      cli(root, ["archive", "sweep"]);
    }
    for (const input of [undefined, { revision: ready.revision }]) {
      const error = cli(root, ["start", task.id], input, "DEPENDENCIES_INCOMPLETE");
      assert.deepEqual(error.details.dependencies, [dependency.id]);
    }
    const current = cli(root, ["show", task.id]);
    assert.equal(current.status, "ready");
    assert.equal(current.revision, ready.revision);
    assert.equal(current.blocked, undefined);
    assert.deepEqual(current.unfinishedDependencies, [dependency.id]);
  }
});

test("manual start respects the next scheduled time for both worktrees and existing directories", t => {
  for (const existingDirectory of [false, true]) {
    const root = fixture(t, true);
    cli(root, ["init"]);
    const task = cli(root, ["create"], {
      title: "Scheduled task", criteria: ["Verified"], schedule: { everyMinutes: 60 },
      ...(existingDirectory ? { workingDirectory: root } : {}),
    });
    const ready = cli(root, ["approve", task.id]);
    cli(root, ["start", task.id], { revision: ready.revision }, "INVALID_TRANSITION");
    assert.equal(cli(root, ["show", task.id]).status, "ready");
    assert.ok(!existsSync(join(root, ".worktrees", task.id)));
    ready.schedule.nextAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(join(root, ".tasks", "tasks", task.id + ".json"), JSON.stringify(ready));
    const started = cli(root, ["start", task.id], { revision: ready.revision });
    assert.equal(started.task.status, "in_progress");
    const continued = cli(root, ["start", task.id]);
    assert.equal(continued.task.revision, started.task.revision);
    assert.equal(continued.worktree ?? continued.cwd, started.worktree ?? started.cwd);
  }
});

test("automatic settings and task deadlines survive CLI restarts and guard start and acceptance", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  cli(root, ["settings"], { autoMode: "true" }, "INVALID_INPUT");
  const task = cli(root, ["create"], { title: "External result", criteria: ["Verified"], workingDirectory: root, dueDate: "2026-11-20" });
  assert.equal(cli(root, ["list", "--compact"]).tasks[0].dueDate, "2026-11-20");
  for (const dueDate of ["2026-02-30", "tomorrow", 123]) cli(root, ["update", task.id], { dueDate }, "INVALID_INPUT");
  cli(root, ["update", task.id], { dueDate: null });
  assert.equal(cli(root, ["show", task.id]).dueDate, undefined);
  cli(root, ["update", task.id], { dueDate: "2028-02-29" });
  const ready = cli(root, ["approve", task.id]);
  cli(root, ["start", task.id], { revision: ready.revision, autoMode: true }, "AUTO_MODE_DISABLED");
  cli(root, ["settings"], { autoMode: true, reviewMode: "human" });
  assert.equal(cli(root, ["settings"]).autoMode, true);
  cli(root, ["start", task.id], { revision: ready.revision, autoMode: true });
  const preview = cli(root, ["preview", task.id]);
  const submitted = cli(root, ["submit", task.id], { token: preview.token, noChanges: true, summary: "Verified external result", checks: ["Checked"] });
  const input = { revision: submitted.revision, targetHead: null, actor: "manager", reviewMode: "reviewer", autoMode: true };
  cli(root, ["accept", task.id], input, "AUTO_REVIEW_DISABLED");
  cli(root, ["settings"], { reviewMode: "reviewer" });
  cli(root, ["accept", task.id], input, "REVIEW_REQUIRED");
  cli(root, ["review-approve", task.id], { revision: submitted.revision, targetHead: null, summary: "Verified", evidence: ["External result checked"] });
  cli(root, ["settings"], { autoMode: false });
  cli(root, ["accept", task.id], input, "AUTO_MODE_DISABLED");
  assert.equal(cli(root, ["show", task.id]).status, "review");
  cli(root, ["settings"], { autoMode: true });
  assert.equal(cli(root, ["accept", task.id], input).status, "done");
});

test("automatic integration reports conflicts once and repaired submissions require the selected acceptance again", t => {
  for (const reviewMode of ["human", "reviewer"]) {
    const root = fixture(t, true);
    const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "task version\n"));
    cli(root, ["settings"], { autoMode: true, reviewMode });
    writeFileSync(join(root, "source.txt"), "target version\n");
    git(root, "commit", "-am", "fix: update target");
    const head = git(root, "rev-parse", "HEAD");
    const approval = { revision: task.revision, targetHead: head, summary: "Verified", evidence: ["Checked task result"] };
    if (reviewMode === "reviewer") cli(root, ["review-approve", task.id], approval);
    const accept = { revision: task.revision, targetHead: head,
      ...(reviewMode === "reviewer" ? { autoMode: true, actor: "manager", reviewMode } : {}) };
    for (let attempt = 0; attempt < 2; attempt++) cli(root, ["accept", task.id], accept, "MERGE_CONFLICT");
    const notices = cli(root, ["manager-inbox"]).filter((entry: any) => entry.id === task.id && entry.kind === "question");
    assert.equal(notices.length, 1); assert.match(notices[0].text, /MERGE_CONFLICT/);
    assert.equal(cli(root, ["show", task.id]).status, "review");
    const dependent = cli(root, ["create"], { title: "After integration", criteria: ["Verified"], dependencies: [task.id] });
    cli(root, ["approve", dependent.id]);
    cli(root, ["start", dependent.id], undefined, "DEPENDENCIES_INCOMPLETE");
    const reopened = cli(root, ["start", task.id], { revision: task.revision, resolveConflicts: true });
    assert.equal(reopened.worktree, worktree);
    assert.equal(cli(root, ["show", task.id, "--compact"], { launchDetails: true }).mergeRepair, true);
    assert.equal(cli(root, ["list", "--compact"]).tasks.find((entry: { id: string }) => entry.id === task.id).mergeRepair, true);
    assert.throws(() => git(worktree, "merge", "--no-edit", head));
    writeFileSync(join(worktree, "source.txt"), "target version\ntask version\n");
    git(worktree, "add", "source.txt"); git(worktree, "commit", "-m", "fix: resolve integration conflict\n\nTask: " + task.id);
    const preview = cli(worktree, ["preview", task.id]);
    const repaired = cli(worktree, ["submit", task.id], { token: preview.token, message: preview.commitMessage ?? "fix: combine task and target",
      summary: "Combined", checks: ["Checked combined result"] });
    assert.equal(cli(root, ["show", task.id, "--compact"], { launchDetails: true }).mergeRepair, undefined);
    const repairedInput = { ...accept, revision: repaired.revision };
    if (reviewMode === "reviewer") {
      cli(root, ["accept", task.id], repairedInput, "REVIEW_REQUIRED");
      cli(root, ["review-approve", task.id], { ...approval, revision: repaired.revision });
    } else assert.equal(cli(root, ["show", task.id]).status, "review");
    assert.equal(cli(root, ["accept", task.id], repairedInput).status, "done");
    assert.deepEqual(cli(root, ["show", dependent.id]).unfinishedDependencies, []);
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "target version\ntask version\n");
  }
});

test("linked attachments survive chat, restart and archive without copying large sources", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const path = join(root, "large.bin");
  writeFileSync(path, "selected part");
  truncateSync(path, 80 * 1024 * 1024);
  const task = cli(root, ["create"], { title: "Links", attachmentSources: [{ path, link: true }, { path, link: true }] });
  assert.equal(task.attachments.length, 2);
  assert.ok(task.attachments.every((file: Task["attachments"][number]) => file.bytes === 80 * 1024 * 1024 && file.link));
  for (const file of task.attachments) {
    assert.ok(!existsSync(join(root, ".tasks", "attachments", task.id, file.file)));
    const read = cli(root, ["attachment", "read", task.id], { file: file.file });
    assert.equal(read.path, realpathSync(path));
    assert.equal(read.base64, undefined);
  }
  const sent = cli(root, ["chat", task.id], { model: "fixture", effort: "medium", text: "Read part",
    attachmentSources: [{ path, link: true }] });
  assert.equal(cli(root, ["show", task.id]).attachments.length, 3);
  writeFileSync(path, "updated", { flag: "r+" });
  cli(root, ["attachment", "read", task.id], { file: sent.attachments[2].file }, "ATTACHMENT_CHANGED");
  renameSync(path, path + ".moved");
  cli(root, ["attachment", "read", task.id], { file: sent.attachments[2].file }, "ATTACHMENT_UNAVAILABLE");
  renameSync(path + ".moved", path);
  truncateSync(path, 81 * 1024 * 1024);
  cli(root, ["attachment", "read", task.id], { file: sent.attachments[2].file }, "ATTACHMENT_CHANGED");
  assert.equal(cli(root, ["show", task.id]).attachments.length, 3);
  rmSync(path);
  cli(root, ["attachment", "read", task.id], { file: sent.attachments[0].file }, "ATTACHMENT_UNAVAILABLE");
  const survivor = join(root, "keep.txt");
  writeFileSync(survivor, "keep source");
  const mixed = cli(root, ["chat", task.id], { model: "fixture", effort: "medium", text: "Mixed sources",
    attachmentSources: [{ path: survivor, link: true }, { path: survivor }] });
  const copied = mixed.attachments.at(-1);
  assert.equal(cli(root, ["attachment", "read", task.id], { file: copied.file }).base64,
    Buffer.from("keep source").toString("base64"));
  cli(root, ["cancel", task.id], { reason: "Archive links" });
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  assert.equal(cli(root, ["show", task.id]).attachments.length, 5);
  assert.ok(existsSync(survivor));
  assert.equal(cli(root, ["attachment", "read", task.id], { file: mixed.attachments.at(-2).file }).path, realpathSync(survivor));
  assert.equal(cli(root, ["attachment", "read", task.id], { file: copied.file }).base64,
    Buffer.from("keep source").toString("base64"));
});

test("linked attachment snapshots preserve verified bytes and reject stale sources", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const source = join(root, "source.txt");
  const destination = join(root, "snapshot.txt");
  const original = Buffer.concat([Buffer.alloc(64 * 1024, 1), Buffer.alloc(256, 2)]);
  writeFileSync(source, original);
  const task = cli(root, ["create"], { title: "Draft", attachmentSources: [{ path: source, link: true }] });
  const args = ["attachment", "read", task.id];
  const file = task.attachments[0].file;
  cli(root, args, { file, destination }, "ATTACHMENT_LINK");
  assert.equal(cli(root, args, { file, destination, snapshot: true }).path, destination);
  assert.deepEqual(readFileSync(destination), original);
  cli(root, args, { file, destination, snapshot: true }, "IO_ERROR");
  writeFileSync(source, "changed");
  assert.deepEqual(readFileSync(destination), original);
  const rejected = join(root, "rejected.txt");
  cli(root, args, { file, destination: rejected, snapshot: true }, "ATTACHMENT_CHANGED");
  assert.equal(existsSync(rejected), false);
  rmSync(source);
  cli(root, args, { file, destination: rejected, snapshot: true }, "ATTACHMENT_UNAVAILABLE");
  assert.equal(existsSync(rejected), false);
});

test("create saves attachments with the draft and rejects incomplete batches", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const path = join(root, "screenshot.png");
  const bytes = Buffer.from([0, 255, 1]);
  writeFileSync(path, bytes);
  const source = { path, name: "Скриншот.png" };
  cli(root, ["create"], { title: "Draft", attachmentSources: [source, { path: root }] }, "INVALID_INPUT");
  assert.deepEqual(cli(root, ["list"]).tasks, []);
  assert.ok(!existsSync(join(root, ".tasks", "attachments", "T-0001")));

  const task = cli(root, ["create"], { title: "Draft", attachmentSources: [source, source] });
  assert.equal(task.id, "T-0001");
  assert.equal(task.status, "draft");
  assert.equal(task.attachments.length, 2);
  assert.notEqual(task.attachments[0].file, task.attachments[1].file);
  for (const attachment of task.attachments) {
    assert.equal(attachment.name, source.name);
    assert.equal(cli(root, ["attachment", "read", task.id], { file: attachment.file }).base64, bytes.toString("base64"));
  }
});

test("a card cover stores the selected image and rejects invalid attachments and stale revisions", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const path = join(root, "attachment");
  writeFileSync(path, "attachment contents");
  const task = cli(root, ["create"], { title: "Cover", attachmentSources: [
    { path, name: "notes.txt" }, { path, name: "first.png" }, { path, name: "second.JPEG" },
  ] });
  const [notes, first, second] = task.attachments;
  assert.equal(task.coverAttachment, undefined);
  cli(root, ["attachment", "cover", task.id], { file: notes.file, revision: task.revision }, "INVALID_INPUT");
  cli(root, ["attachment", "cover", task.id], { file: "missing", revision: task.revision }, "INVALID_INPUT");
  const chosen = cli(root, ["attachment", "cover", task.id], { file: second.file, revision: task.revision });
  assert.equal(chosen.coverAttachment, second.file);
  assert.equal(cli(root, ["list"]).tasks[0].coverAttachment, second.file);
  cli(root, ["attachment", "cover", task.id], { file: second.file, revision: task.revision }, "REVISION_CONFLICT");
  const closed = cli(root, ["cancel", task.id], { reason: "No longer needed" });
  const updated = cli(root, ["attachment", "cover", task.id], { file: first.file, revision: closed.revision });
  assert.equal(updated.coverAttachment, first.file);
  assert.equal(updated.status, "cancelled");
  assert.equal(updated.closedAt, closed.closedAt);
});

test("board settings can be read while an unrelated command holds the board lock", async t => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = fixture(t);
  cli(root, ["init"]);
  const settings = cli(root, ["settings"], { reviewMode: "reviewer" });
  const lock = new DatabaseSync(join(root, ".tasks", ".lock.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    const read = spawnSync(process.execPath, commandArgs(root, ["settings"]), {
      env, encoding: "utf8", windowsHide: true, timeout: 7_000,
    });
    assert.ifError(read.error);
    assert.equal(read.status, 0, read.stdout + read.stderr);
    assert.deepEqual(JSON.parse(read.stdout).data, settings);
  } finally {
    lock.close();
  }
});

test("board agent defaults apply to new and unset roles while explicit choices keep priority", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const roles = {
    manager: { provider: "codex", model: "gpt-6.2-sol", effort: "medium" },
    executor: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
    reviewer: { provider: "codex", model: "gpt-6.1-terra", effort: "high" },
  };
  assert.deepEqual(cli(root, ["settings"]), {
    boardType: "agent", archiveAfterDays: 90, integrationMode: "merge", reviewMode: "reviewer", ...roles,
  });
  const path = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(path, "utf8"));
  index.settings = { archiveAfterDays: 90, integrationMode: "merge", manager: null,
    reviewer: { model: "gpt-6.1-sol", effort: "xhigh" } };
  writeFileSync(path, JSON.stringify(index));
  assert.deepEqual(cli(root, ["settings"]), { ...index.settings, executor: roles.executor });
  assert.deepEqual(cli(root, ["list"]).settings, { ...index.settings, executor: roles.executor });
});

test("normal commands enforce task state, criteria, and revisions", t => {
  const root = fixture(t);
  git(root, "init", "-b", "main");
  cli(root, ["list"], undefined, "BOARD_NOT_FOUND");
  cli(root, ["init"]);
  let task = cli(root, ["create"], { title: "Build CSV export" });
  assert.equal(task.id, "T-0001");
  cli(root, ["start", task.id], undefined, "INVALID_TRANSITION");
  cli(root, ["approve", task.id], { revision: task.revision }, "CRITERIA_REQUIRED");
  task = cli(root, ["update", task.id], { criteria: ["A CSV file can be downloaded."], revision: task.revision });
  cli(root, ["approve", task.id], { revision: 1 }, "REVISION_CONFLICT");
  task = cli(root, ["approve", task.id], { revision: task.revision });
  assert.equal(task.status, "ready");
  cli(root, ["return-to-draft", task.id], { revision: task.revision - 1 }, "REVISION_CONFLICT");
  task = cli(root, ["return-to-draft", task.id], { revision: task.revision });
  assert.equal(cli(root, ["show", task.id]).status, "draft");
  assert.equal(task.history.at(-1).from, "ready");
  assert.deepEqual(cli(root, ["return-to-draft", task.id], { revision: task.revision }), task);
  cli(root, ["approve", task.id], { actor: "manager", revision: task.revision }, "USER_APPROVAL_REQUIRED");
  task = cli(root, ["approve", task.id], { revision: task.revision });
  cli(root, ["update", task.id], { criteria: ["Download XLSX."] }, "USER_REQUIREMENTS_REQUIRED");
  task = cli(root, ["update", task.id], { criteria: ["Download XLSX."], actor: "user", note: "Use XLSX" });
  assert.equal(task.status, "ready");
  assert.equal(cli(root, ["list"]).tasks.length, 1);
});

test("return to draft preserves the card and invalidates queued and late lifecycle operations", async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const restore = (task: Task) => {
    const draft = cli(root, ["return-to-draft", task.id], { revision: task.revision });
    assert.equal(draft.status, "draft");
    assert.equal(draft.id, task.id);
    assert.equal(draft.createdAt, task.createdAt);
    assert.equal(draft.closedAt, undefined);
    assert.equal(draft.blocked, undefined);
    assert.equal(draft.acceptanceRepair, undefined);
    assert.deepEqual(draft.history.slice(0, -1), task.history);
    for (const key of ["description", "criteria", "subtasks", "attachments", "dependencies", "result", "git"] as const) {
      assert.deepEqual(draft[key], task[key], key);
    }
    return draft;
  };
  const create = () => cli(root, ["create"], { title: "Fixture", description: "Keep this brief", criteria: ["Confirmed"], workingDirectory: root });
  const approve = (task: Task) => cli(root, ["approve", task.id], { revision: task.revision });
  const start = (task: Task) => cli(root, ["start", task.id], { revision: task.revision }).task;
  const submit = (task: Task) => {
    const { token } = cli(root, ["preview", task.id]);
    return cli(root, ["submit", task.id], { token, noChanges: true, summary: "Test result", checks: ["Evidence"] });
  };
  restore(approve(create()));
  const running = start(approve(create()));
  runtimeTransaction(root, entries => entries.push({ id: "queue:" + running.id, owner: 0, kind: "queue",
    task: running.id, revision: running.revision }));
  const release = registerRuntime(root, { kind: "slot", role: "executor", task: running.id })!;
  try {
    cli(root, ["return-to-draft", running.id], { revision: running.revision }, "CHAT_BUSY");
    assert.deepEqual(cli(root, ["show", running.id]).history, running.history);
  } finally { release(); }
  const { token } = cli(root, ["preview", running.id]);
  restore(running);
  assert.ok(!runtimeEntries(root).some(entry => entry.task === running.id));
  cli(root, ["start", running.id], { revision: running.revision }, "INVALID_TRANSITION");
  cli(root, ["submit", running.id], { token, noChanges: true, summary: "Late", checks: ["Late"] }, "INVALID_TRANSITION");
  const blocked = start(approve(create()));
  restore(cli(root, ["block", blocked.id], { reason: "Fixture", condition: "Retry" }));
  const review = submit(start(approve(create())));
  restore(review);
  cli(root, ["accept", review.id], { actor: "user", revision: review.revision, message: "Late acceptance" }, "INVALID_TRANSITION");
  const cancelledReview = submit(start(approve(create())));
  const cancelled = cli(root, ["cancel", cancelledReview.id], { reason: "Fixture" });
  assert.deepEqual(cancelled.result, cancelledReview.result);
  restore(cancelled);
  const doneReview = submit(start(approve(create())));
  const done = cli(root, ["accept", doneReview.id], { actor: "user", revision: doneReview.revision });
  cli(root, ["return-to-draft", done.id], { revision: done.revision }, "INVALID_TRANSITION");
  assert.deepEqual(cli(root, ["show", done.id]).history, done.history);
  const file = join(root, "archive-evidence.txt");
  writeFileSync(file, "Keep archived bytes\n");
  const attached = cli(root, ["attachment", "add", create().id], { path: file });
  const archived = cli(root, ["cancel", approve(attached).id], { reason: "Archive fixture" });
  cli(root, ["settings"], { archiveAfterDays: 0 });
  assert.ok(cli(root, ["archive", "sweep"]).archived.includes(archived.id));
  restore(archived);
  assert.ok(cli(root, ["list"]).tasks.some((task: Task) => task.id === archived.id));
  const destination = join(root, "restored-evidence.txt");
  cli(root, ["attachment", "read", archived.id], { file: attached.attachments[0].file, destination });
  assert.equal(readFileSync(destination, "utf8"), "Keep archived bytes\n");
  const run = async (task: Task, command: string, input: object) => {
    const child = spawn(process.execPath, commandArgs(root, [command, task.id], input), { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stdin.end(JSON.stringify(input));
    await once(child, "close");
    return JSON.parse(output);
  };
  const racingReady = approve(create());
  const racingWork = start(approve(create()));
  const racingReview = submit(start(approve(create())));
  for (const [task, action, args, winnerState] of [
    [racingReady, "start", { revision: racingReady.revision }, "in_progress"],
    [racingWork, "submit", { token: cli(root, ["preview", racingWork.id]).token, noChanges: true, summary: "Racing", checks: ["Evidence"] }, "review"],
    [racingReview, "accept", { actor: "user", revision: racingReview.revision }, "done"],
  ] as const) {
    const [returned, competing] = await Promise.all([run(task, "return-to-draft", { revision: task.revision }), run(task, action, args)]);
    assert.notEqual(returned.ok, competing.ok, JSON.stringify({ returned, competing }));
    assert.equal(cli(root, ["show", task.id]).status, returned.ok ? "draft" : winnerState);
  }
});

test("task chat records a clarification once, with its sources and lifecycle intact", async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const draft: Task = cli(root, ["create"], {
    title: "Границы колонок", description: "Проверить раскладку доски.", criteria: ["Колонки помещаются в окно."],
    questions: ["На какой ширине?"],
  });
  const { id: otherId } = cli(root, ["create"], { title: "Другая карточка" });
  const other = cli(root, ["show", otherId]);
  const request = { model: "fixture-model", effort: "medium" };
  const clarification = "Карточки выходят за границу собственной колонки.";
  const description = draft.description + "\n\n" + clarification;
  const show = () => cli(root, ["show", draft.id]) as Task;
  const send = (text: string, sources?: { path: string }[]) => {
    cli(root, ["chat", draft.id], { ...request, text, attachmentSources: sources });
    return show();
  };
  let refreshes = 0;
  const action = (card: Task) => taskChatActions(root, card, card.history.findLast(event =>
    event.action === "chat" && event.actor === "user")?.text ?? "", () => refreshes++);

  const source = join(root, "layout.txt");
  writeFileSync(source, "The right card edge is outside its own column.");
  const sent = send(clarification, [{ path: source }]);
  const update = { authorization: clarification, description };
  const edit = action(sent);
  assert.deepEqual(await edit("task_update", { ...update, id: other.id }), {
    ok: false, error: { code: "INVALID_INPUT", message: "Use the parameters defined for this task action." },
  });
  const first = await edit("task_update", update);
  assert.ok(first.ok && first.data.changed);
  const edited = show();
  assert.deepEqual({ ...edited, description: sent.description, history: sent.history,
    revision: sent.revision, updatedAt: sent.updatedAt }, sent);
  assert.equal(edited.description, description);
  assert.deepEqual(edited.history.slice(0, -1), sent.history);
  assert.equal(edited.history.at(-1)?.text, clarification);
  assert.equal(edited.attachments.length, 1);
  assert.deepEqual(edited.history.at(-2)?.chat?.files, edited.attachments.map(file => file.file));

  cli(root, ["chat", draft.id], { ...request, actor: "agent", replyTo: sent.history.length - 1,
    text: "Уточнение добавлено в описание." });
  const repeated = send(clarification);
  const second = await action(repeated)("task_update", update);
  assert.ok(second.ok && !second.data.changed);
  assert.deepEqual(show(), repeated);
  assert.equal(refreshes, 1);

  const continued = send("Это видно на ширине окна 1024 px.");
  const latestText = continued.history.at(-1)!.text;
  const criteria = [...draft.criteria, latestText!];
  const oldQuote = await action(continued)("task_update", update);
  assert.ok(!oldQuote.ok && oldQuote.error.code === "USER_DIRECTION_REQUIRED");
  cli(root, ["update", draft.id], { revision: continued.revision, questions: [] });
  const concurrent = show();
  const stale = await action(continued)("task_update", { authorization: latestText, criteria });
  assert.ok(!stale.ok && stale.error.code === "REVISION_CONFLICT");
  assert.deepEqual(show(), concurrent);
  const saved = await action(show())("task_update", { authorization: latestText, criteria });
  assert.ok(saved.ok && saved.data.changed);
  assert.deepEqual(show().criteria, criteria);
  assert.equal(show().status, "draft");
  assert.equal(show().history.some(event => event.action === "start"), false);
  assert.deepEqual(cli(root, ["show", other.id]), other);

  cli(root, ["approve", draft.id]);
  cli(root, ["start", draft.id]);
  const token = cli(root, ["preview", draft.id]).token;
  cli(root, ["submit", draft.id], { token, noChanges: true, summary: "Layout checked", checks: ["Checked"] });
  for (const status of ["review", "done"]) {
    const card = send("Уточнение после сдачи.");
    assert.equal(card.status, status);
    const locked = await action(card)("task_update", { authorization: card.history.at(-1)!.text, description: "Другие условия" });
    assert.ok(!locked.ok && locked.error.code === "REQUIREMENTS_LOCKED");
    assert.deepEqual(show(), card);
    if (status === "review") cli(root, ["accept", draft.id], { revision: card.revision });
  }
  assert.equal(refreshes, 2);
});

test("task chat stores messages and attachments together and archives the conversation", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Discuss export", questions: ["Which format?"] });
  const path = join(root, "sample.txt");
  const contents = "example attachment\n";
  writeFileSync(path, contents);
  const settings = { model: "fixture-model", effort: "medium" };
  const message = { ...settings, text: "Use this example.", attachmentSources: [{ path }] };
  cli(root, ["chat", task.id], { ...message, attachmentSources: [{ path }, { path: root }] }, "INVALID_INPUT");
  assert.equal(cli(root, ["show", task.id]).revision, task.revision);
  assert.ok(!existsSync(join(root, ".tasks", "attachments", task.id)));

  const sent = cli(root, ["chat", task.id], message);
  const file = sent.attachments[0].file;
  assert.deepEqual(sent.history[0], task.history[0]);
  assert.deepEqual(sent.history.at(-1).chat, { ...settings, files: [file] });
  const reply = { ...settings, actor: "agent", text: "Who should receive the export?", usage: { used: 32, limit: 256 },
    commentary: ["I have checked the export settings."], durationMs: 12_000,
    run: [{ id: "summary", type: "reasoning", title: "", text: "Checked the current export settings", status: "completed" }] };
  cli(root, ["chat", task.id], { ...reply, replyTo: 0 }, "CHAT_CHANGED");
  cli(root, ["chat", task.id], { ...reply, durationMs: -1, replyTo: sent.history.length - 1 }, "INVALID_INPUT");
  cli(root, ["chat", task.id], { ...reply, run: [{ ...reply.run[0], at: "invalid" }], replyTo: sent.history.length - 1 }, "INVALID_INPUT");
  const answered = cli(root, ["chat", task.id], { ...reply, replyTo: sent.history.length - 1 });
  assert.deepEqual(answered.history.at(-1).chat.usage, reply.usage);
  assert.deepEqual(answered.history.at(-1).chat.commentary, reply.commentary);
  assert.equal(answered.history.at(-1).durationMs, reply.durationMs);
  assert.deepEqual(answered.history.at(-1).run, reply.run);
  cli(root, ["chat", task.id], { ...reply, replyTo: sent.history.length - 1 }, "CHAT_CHANGED");
  const entries = [{ id: "final", type: "agentMessage", phase: "final_answer", title: "", text: "Saved result", status: "completed" }];
  cli(root, ["run-log", task.id], { entries, durationMs: -1 }, "INVALID_INPUT");
  cli(root, ["run-log", task.id], { entries: [{ ...entries[0], phase: "unknown" }] }, "INVALID_INPUT");
  const loggedReceipt = cli(root, ["run-log", task.id, "--compact"], { entries, durationMs: 433_000 });
  assert.equal(loggedReceipt.id, task.id);
  assert.equal(loggedReceipt.history, undefined);
  const logged = cli(root, ["show", task.id]);
  assert.equal(loggedReceipt.runLogSequence, logged.history.length);
  assert.deepEqual(logged.history.at(-1).run, entries);
  const compact = cli(root, ["list", "--compact"]).tasks.find((entry: { id: string }) => entry.id === task.id);
  assert.equal(compact.revision, logged.revision);
  assert.equal(compact.historyLength, logged.history.length);
  assert.equal(compact.history, undefined);
  assert.deepEqual(cli(root, ["list"]).tasks.find((entry: { id: string }) => entry.id === task.id).history.at(-1).run, entries);
  assert.equal(logged.history.at(-1).durationMs, 433_000);

  const closing = cli(root, ["chat", task.id], { ...settings, text: "Cancel this task." });
  cli(root, ["cancel", task.id], { reason: "Archive the conversation" });
  let closed = cli(root, ["chat", task.id], { ...reply, text: "The task was cancelled.", replyTo: closing.history.length - 1 });
  assert.equal(closed.status, "cancelled");
  cli(root, ["chat", task.id], { ...reply, replyTo: closing.history.length - 1 }, "CHAT_CHANGED");
  const discussion = cli(root, ["chat", task.id], { ...settings, text: "Discuss the cancelled card." });
  assert.equal(discussion.status, "cancelled");
  closed = cli(root, ["chat", task.id], { ...reply, replyTo: discussion.history.length - 1 });
  cli(root, ["settings"], { archiveAfterDays: 0 });
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, [task.id]);
  assert.deepEqual(cli(root, ["show", task.id]).history, closed.history);
  assert.equal(cli(root, ["attachment", "read", task.id], { file }).base64, Buffer.from(contents).toString("base64"));
});

test("creating a board can initialize Git in the selected folder without changing its parent", t => {
  const parent = fixture(t, true);
  const selected = join(parent, "Selected board");
  mkdirSync(selected);
  const created = cli(selected, ["init"], { git: true });
  assert.equal(created.project, realpathSync(selected));
  assert.ok(existsSync(join(selected, ".git")));
  assert.ok(existsSync(join(selected, ".tasks", "board.json")));
  assert.ok(!existsSync(join(parent, ".tasks")));
  const task = cli(selected, ["create"], { title: "Keep this task" });
  assert.equal(cli(selected, ["init"], { git: true }).tasks[0].id, task.id);
  assert.equal(git(selected, "status", "--porcelain"), "");
});

test("doctor restores an unindexed task with its tags and numbering does not reuse it", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Recover me", tags: ["Orphan"] });
  const indexPath = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  delete index.tasks[task.id];
  index.tags = [];
  index.nextId = 1;
  writeFileSync(indexPath, JSON.stringify(index));
  assert.equal(cli(root, ["create"], { title: "Next task" }).id, "T-0002");
  assert.deepEqual(cli(root, ["doctor"], { repair: true }).recovered, [task.id]);
  assert.equal(cli(root, ["show", task.id]).title, "Recover me");
  const snapshot = cli(root, ["list", "--tag", "orphan"]);
  assert.deepEqual(snapshot.tasks, [task]);
  assert.equal(snapshot.tags[0].name, "Orphan");
});

test("the board tag catalog migrates older tasks and shares names and colors across cards", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const active = cli(root, ["create"], { title: "Active task", tags: ["Интерфейс"] });
  const archived = cli(root, ["create"], { title: "Old task", tags: ["Отчёты"] });
  cli(root, ["cancel", archived.id], { reason: "Archive fixture" });
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  const indexPath = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  delete index.tags;
  delete index.archive[archived.id].tags;
  const missingCatalog = JSON.stringify(index);
  writeFileSync(indexPath, missingCatalog);

  const snapshot = cli(root, ["list", "--tag", " ИНТЕРФЕЙС "]);
  assert.deepEqual(snapshot.tags.map((tag: { name: string }) => tag.name), ["Интерфейс", "Отчёты"]);
  assert.ok(snapshot.tags.every((tag: { color: string }) => /^#[0-9A-F]{6}$/.test(tag.color)));
  assert.deepEqual(snapshot.tasks, [active]);
  const matches = cli(root, ["list", "--archived", "--tag", "ОТЧЁТЫ"]).archived;
  assert.deepEqual(matches.map((task: { id: string }) => task.id), [archived.id]);
  assert.deepEqual(matches[0].tags, ["Отчёты"]);
  assert.equal(readFileSync(indexPath, "utf8"), missingCatalog);

  const name = "Ошибки";
  assert.deepEqual(cli(root, ["tag", "ensure"], { name, color: "#86cfad" }), { name, color: "#86CFAD" });
  assert.deepEqual(cli(root, ["tag", "ensure"], { name: "ОШИБКИ", color: "#F196B2" }), { name, color: "#86CFAD" });
  cli(root, ["tag", "set"], { name, color: "green" }, "INVALID_INPUT");
  const updated = cli(root, ["update", active.id], { tags: [" ошибки ", "ОШИБКИ"], revision: active.revision });
  assert.deepEqual(updated.tags, [name]);
  cli(root, ["update", active.id], { tags: ["Stale tag"], revision: active.revision }, "REVISION_CONFLICT");
  cli(root, ["tag", "set"], { name: "ошибки", color: "#91B6F9" });
  assert.deepEqual(cli(root, ["show", active.id]), { ...updated, artifacts: [] });
  cli(root, ["update", active.id], { tags: [], revision: updated.revision });
  const empty = cli(root, ["list", "--tag", name]);
  assert.deepEqual(empty.tasks, []);
  assert.ok(empty.tags.some((tag: { name: string; color: string }) => tag.name === name && tag.color === "#91B6F9"));
  assert.ok(!empty.tags.some((tag: { name: string }) => tag.name === "Stale tag"));
  assert.deepEqual(cli(root, ["tag", "set"], { name, color: "#12ab34" }), { name, color: "#12AB34" });
  assert.equal(cli(root, ["list"]).tags.find((tag: { name: string }) => tag.name === name).color, "#12AB34");
  cli(root, ["tag", "set"], { name, color: "#12AB34FF" }, "INVALID_INPUT");
  const closed = cli(root, ["cancel", active.id], { reason: "No longer needed" });
  const retagged = cli(root, ["tag", "assign", active.id], { tags: [name], revision: closed.revision });
  assert.equal(retagged.status, "cancelled");
  assert.equal(retagged.closedAt, closed.closedAt);
  assert.deepEqual(retagged.tags, [name]);
  cli(root, ["tag", "assign", active.id], { tags: [], revision: closed.revision }, "REVISION_CONFLICT");

  const legacyIndex = JSON.parse(readFileSync(indexPath, "utf8"));
  legacyIndex.tags = [
    { name: "Интерфейс", color: "blue" },
    { name: "Отчёты", color: "pink" },
    { name, color: "green", customColor: "#12ab34" },
  ];
  const legacyCatalog = JSON.stringify(legacyIndex);
  writeFileSync(indexPath, legacyCatalog);
  const migrated = [
    { name: "Интерфейс", color: "#91B6F9" },
    { name: "Отчёты", color: "#F196B2" },
    { name, color: "#12AB34" },
  ];
  assert.deepEqual(cli(root, ["list"]).tags, migrated);
  assert.deepEqual(cli(root, ["list", "--compact"]).tags, migrated);
  assert.equal(readFileSync(indexPath, "utf8"), legacyCatalog);
  cli(root, ["tag", "set"], { name, color: "#12AB34" });
  assert.deepEqual(JSON.parse(readFileSync(indexPath, "utf8")).tags, migrated);
});

for (const legacyRoot of [".taskboard-worktrees", ".tasks/worktrees"]) test("worktree migration preserves files, isolates siblings and supports cleanup: " + legacyRoot, t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const legacy = cli(root, ["create"], { title: "Already started", criteria: ["Keep local files."] });
  const next = cli(root, ["create"], { title: "Start in Elevated", criteria: ["Create a worktree."] });
  cli(root, ["approve", legacy.id]);
  cli(root, ["approve", next.id]);
  const initial = cli(root, ["start", legacy.id]).worktree;
  const old = join(root, legacyRoot, legacy.id);
  mkdirSync(dirname(old), { recursive: true });
  git(root, "worktree", "move", initial, old);
  writeFileSync(join(old, "source.txt"), "staged\n");
  git(old, "add", "source.txt");
  writeFileSync(join(old, "notes.local"), "unsaved notes\n");
  const before = git(old, "status", "--porcelain", "--ignored");
  cli(root, ["pause", legacy.id]);

  const other = cli(root, ["start", next.id], { isolatedWorktree: true });
  const target = join(root, ".worktrees", legacy.id);
  mkdirSync(target);
  cli(root, ["start", legacy.id], { isolatedWorktree: true }, "WORKTREE_COLLISION");
  assert.equal(cli(root, ["show", legacy.id]).status, "ready");
  assert.equal(git(old, "status", "--porcelain", "--ignored"), before);
  rmdirSync(target);

  const moved = cli(root, ["start", legacy.id], { isolatedWorktree: true });
  assert.equal(moved.worktree, realpathSync(target));
  assert.equal(other.worktree, realpathSync(join(root, ".worktrees", next.id)));
  assert.ok(!existsSync(old));
  assert.equal(cli(moved.worktree, ["show", legacy.id]).git.worktree, moved.worktree);
  assert.equal(cli(root, ["start", legacy.id]).worktree, moved.worktree);
  assert.equal(git(moved.worktree, "status", "--porcelain", "--ignored"), before);
  assert.equal(readFileSync(join(moved.worktree, "notes.local"), "utf8"), "unsaved notes\n");
  assert.equal(git(root, "status", "--porcelain"), "");

  cli(root, ["cancel", next.id], { reason: "Check cleanup" });
  assert.equal(cli(root, ["cleanup", next.id]).removed, false);
  assert.ok(!existsSync(other.worktree));
  assert.ok(existsSync(moved.worktree));
});

test("migration waits for a live provider and retries after it releases the worktree", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const card = cli(root, ["create"], { title: "Protect a live provider", criteria: ["Keep its working directory."] });
  cli(root, ["approve", card.id]);
  const started = cli(root, ["start", card.id]);
  const legacy = join(root, ".taskboard-worktrees", card.id);
  mkdirSync(dirname(legacy));
  git(root, "worktree", "move", started.worktree, legacy);
  const runtime = join(root, ".tasks", "runtime.json");
  writeFileSync(runtime, JSON.stringify([{ kind: "provider", task: card.id, pid: process.pid }]));
  assert.equal(cli(root, ["start", card.id]).worktree, realpathSync(legacy));
  assert.ok(existsSync(legacy));
  writeFileSync(runtime, "[]");
  assert.equal(cli(root, ["start", card.id]).worktree, realpathSync(join(root, ".worktrees", card.id)));
  assert.ok(!existsSync(legacy));
});

test("linked worktrees share the board and cleanup preserves local files and the branch", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Change source", criteria: ["Source changes."] });
  cli(root, ["approve", task.id]);
  const started = cli(root, ["start", task.id]);
  const initialStart = cli(root, ["metrics", task.id]).starts[0];
  assert.deepEqual(initialStart, { at: started.task.history.at(-1).at, ...started.task.history.at(-1).startTiming });
  assert.ok(Number.isSafeInteger(initialStart.lockWaitMs) && initialStart.lockWaitMs >= 0);
  assert.ok(Number.isSafeInteger(initialStart.gitWorktreeAddMs) && initialStart.gitWorktreeAddMs >= 0);
  assert.ok(initialStart.prepareMs >= initialStart.gitWorktreeAddMs);
  let worktree = started.worktree;
  assert.equal(realpathSync(worktree), realpathSync(join(root, ".worktrees", task.id)));
  assert.equal(cli(worktree, ["show", task.id]).status, "in_progress");
  assert.equal(cli(worktree, ["start", task.id]).worktree, worktree);
  assert.equal(cli(root, ["metrics", task.id]).starts.length, 1);
  assert.equal(git(root, "status", "--porcelain"), "");
  const progress = cli(worktree, ["progress", task.id, "--compact"], { summary: "Started", nextStep: "Edit the source" });
  assert.equal(progress.summary, "Started");
  assert.equal(progress.nextStep, "Edit the source");
  assert.equal(progress.status, "in_progress");
  assert.equal(progress.history, undefined);
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
  const paused = cli(root, ["pause", task.id, "--compact"]);
  assert.equal(paused.status, "ready");
  assert.equal(paused.history, undefined);
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
  const blocked = cli(worktree, ["block", task.id, "--compact"], { reason: "Missing input", condition: "Receive input" });
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.blocked, { reason: "Missing input", condition: "Receive input" });
  assert.equal(blocked.history, undefined);
  const resumed = cli(worktree, ["resume", task.id, "--compact"], { reason: "Received input" });
  assert.equal(resumed.status, "in_progress");
  assert.equal(resumed.history, undefined);
  const stored = cli(worktree, ["show", task.id]);
  assert.equal(stored.revision, resumed.revision);
  assert.equal(stored.history.at(-1).text, "Received input");
  const moved = join(root, ".worktrees", "moved task worktree");
  git(root, "worktree", "move", worktree, moved);
  worktree = realpathSync(moved);
  assert.equal(cli(root, ["show", task.id]).git.worktree, worktree);
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
  writeFileSync(join(worktree, "notes.local"), "Local notes");
  cli(root, ["cancel", task.id], { reason: "No longer needed" });
  cli(root, ["cleanup", task.id], undefined, "DIRTY_WORKTREE");
  assert.ok(existsSync(join(worktree, "notes.local")));
  rmSync(join(worktree, "notes.local"));
  assert.equal(cli(root, ["cleanup", task.id]).removed, true);
  assert.ok(!existsSync(worktree));
  mkdirSync(started.worktree);
  assert.equal(cli(root, ["show", task.id]).git.worktree, undefined);
  assert.equal(git(root, "rev-parse", started.task.git.branch), started.task.git.base);
});

test("starting on a branch without commits creates an empty base and preserves the index", t => {
  const root = fixture(t);
  cli(root, ["init"], { git: true });
  git(root, "config", "user.useConfigOnly", "true");
  const branch = git(root, "symbolic-ref", "HEAD");
  writeFileSync(join(root, "staged.txt"), "staged contents\n");
  writeFileSync(join(root, "local.txt"), "local contents\n");
  git(root, "add", "staged.txt");
  const before = git(root, "status", "--porcelain");
  const draft = cli(root, ["create"], { title: "Start task", criteria: ["Task has its own worktree."] });
  const ready = cli(root, ["approve", draft.id]);
  cli(root, ["start", ready.id], { target: "missing" }, "TARGET_HAS_NO_COMMIT");
  assert.equal(git(root, "for-each-ref"), "");

  const { task, worktree } = cli(root, ["start", ready.id], { target: branch });
  assert.equal(task.status, "in_progress");
  assert.equal(task.git.target, branch);
  assert.equal(git(root, "rev-parse", "HEAD"), task.git.base);
  assert.equal(git(worktree, "rev-parse", "HEAD"), task.git.base);
  assert.equal(git(root, "ls-tree", "-r", "HEAD"), "");
  assert.equal(git(root, "status", "--porcelain"), before);
  assert.equal(git(root, "show", ":staged.txt"), "staged contents");
  assert.equal(readFileSync(join(root, "local.txt"), "utf8"), "local contents\n");
  assert.equal(cli(root, ["start", ready.id]).worktree, worktree);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
});

test("failed start without a branch or worktree keeps the ready task editable", t => {
  const root = fixture(t, true);
  git(root, "branch", "ai-taskboard");
  cli(root, ["init"]);
  const draft = cli(root, ["create"], { title: "Start task", criteria: ["Task has its own worktree."] });
  const ready = cli(root, ["approve", draft.id]);
  cli(root, ["start", ready.id], undefined, "GIT_FAILED");
  assert.equal(cli(root, ["show", ready.id]).status, "ready");
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + ready.id), "");
  assert.ok(!existsSync(join(root, ".tasks", "worktrees", ready.id)));
  assert.equal(cli(root, ["cancel", ready.id], { reason: "The task is no longer needed" }).status, "cancelled");
  assert.ok(!existsSync(join(root, ".tasks", "pending", ready.id + ".json")));
});

test("a new worktree checkout releases the board while its own start remains reserved", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const ready = (title: string) => cli(root, ["approve", cli(root, ["create"], {
    title, criteria: ["The worktree was created."],
  }).id]);
  const task = ready("Slow checkout");
  const other = ready("Independent checkout");
  const pending = join(root, ".tasks", "pending", task.id + ".json");
  const startLock = join(root, ".tasks", "pending", task.id + ".start.sqlite");
  const preload = `
    import assert from "node:assert/strict";
    import child from "node:child_process";
    import { existsSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const spawnSync = child.spawnSync;
    const run = (args, input) => JSON.parse(spawnSync(process.execPath, args, {
      input: JSON.stringify(input), encoding: "utf8", windowsHide: true, timeout: 10000,
    }).stdout);
    child.spawnSync = (command, args, options) => {
      const gitArgs = args?.[0] === "-c" ? args.slice(2) : args;
      if (command === "git" && gitArgs[0] === "worktree" && gitArgs[1] === "add") {
        assert.ok(existsSync(${JSON.stringify(pending)}));
        const lock = new DatabaseSync(${JSON.stringify(startLock)});
        try { assert.throws(() => lock.exec("BEGIN IMMEDIATE"), { errcode: 5 }); }
        finally { lock.close(); }
        const cancelled = run(${JSON.stringify(commandArgs(root, ["cancel", task.id], {}))}, { reason: "Concurrent cancellation" });
        assert.equal(cancelled.error?.code, "PENDING_OPERATION");
        const sent = run(${JSON.stringify(commandArgs(root, ["manager-message", task.id], {}))}, { text: "Arrived during checkout" });
        assert.equal(sent.ok, true, JSON.stringify(sent));
        const independent = run(${JSON.stringify(commandArgs(root, ["start", other.id]))});
        assert.equal(independent.data?.task.status, "in_progress", JSON.stringify(independent));
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["start", task.id]),
  ], { env, encoding: "utf8", windowsHide: true, timeout: 40_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const started = JSON.parse(result.stdout).data;
  assert.equal(started.task.status, "in_progress");
  assert.ok(started.task.history.some((event: { action: string; text?: string }) =>
    event.action === "coordination" && event.text === "Arrived during checkout"));
  assert.equal(cli(root, ["start", task.id]).worktree, started.worktree);
  assert.equal(cli(root, ["metrics", task.id]).starts.length, 1);
  assert.ok(!existsSync(pending));
});

test("new worktrees use the Windows checkout default and honor an explicit Git setting", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  for (const configured of [false, true]) {
    if (configured) git(root, "config", "--local", "checkout.workers", "1");
    const draft = cli(root, ["create"], { title: "Verify checkout options", criteria: ["Worktree ready"] });
    const ready = cli(root, ["approve", draft.id]);
    const trace = join(root, ".tasks", ready.id + "-checkout.jsonl");
    const started = spawnSync(process.execPath, commandArgs(root, ["start", ready.id]), {
      env: { ...env, GIT_TRACE2_EVENT: trace }, encoding: "utf8", windowsHide: true,
    });
    assert.ifError(started.error);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const worktree = JSON.parse(started.stdout).data.worktree;
    const events = readFileSync(trace, "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { event: string; argv?: string[] });
    const checkout = events.find(event => event.event === "start" &&
      event.argv?.includes("worktree") && event.argv.includes("add"));
    assert.ok(checkout?.argv);
    assert.equal(checkout.argv.includes("checkout.workers=4"),
      process.platform === "win32" && availableParallelism() >= 4 && !configured);
    assert.equal(git(worktree, "status", "--porcelain"), "");
  }
  assert.equal(git(root, "config", "--get", "checkout.workers"), "1");
});

test("parallel processes receive unique task IDs and share one catalog entry per tag", async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const tasks = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const input = { title: "Parallel " + index, tags: [index % 2 ? "Shared" : "SHARED", "Tag " + index] };
    const child = spawn(process.execPath, commandArgs(root, ["create"], input), {
      env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    child.stdin.end(JSON.stringify(input));
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, out || err);
    return JSON.parse(out).data;
  }));
  assert.equal(new Set(tasks.map(task => task.id)).size, 8);
  assert.equal(new Set(tasks.map(task => task.tags[0])).size, 1);
  const snapshot = cli(root, ["list", "--tag", "shared"]);
  assert.equal(snapshot.tasks.length, 8);
  assert.equal(snapshot.tags.length, 9);
});

test("schedule pause persists across CLI processes, rejects stale automatic starts and survives manual completion", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  cli(root, ["settings"], { autoMode: true });
  for (const rule of [{ everyMinutes: 60 }, { time: "09:00" }, { time: "09:00", weekday: 1 },
    { time: "09:00", dayOfMonth: 31 }, { time: "09:00", dayOfMonth: 29, month: 2 }]) {
    const created = cli(root, ["create"], { title: "Recurring", criteria: ["Checked"], schedule: rule, workingDirectory: root });
    let task = cli(root, ["approve", created.id]);
    task.schedule.nextAt = "2000-01-01T00:00:00.000Z";
    const path = join(root, ".tasks", "tasks", task.id + ".json");
    writeFileSync(path, JSON.stringify(task));
    const paused = cli(root, ["update", task.id], { revision: task.revision, schedulePaused: true });
    assert.deepEqual(paused.schedule, { ...task.schedule, paused: true });
    assert.equal(cli(root, ["list", "--compact"]).tasks.find((entry: Task) => entry.id === task.id).schedule.paused, true);
    cli(root, ["start", task.id], { revision: paused.revision, scheduled: true }, "INVALID_TRANSITION");
    cli(root, ["start", task.id], { revision: paused.revision, autoMode: true }, "INVALID_TRANSITION");
    cli(root, ["update", task.id], { revision: task.revision, schedulePaused: false }, "REVISION_CONFLICT");
    const started = cli(root, ["start", task.id], { revision: paused.revision }).task;
    assert.equal(started.schedule.paused, true);
    const changed = cli(root, ["update", task.id], { revision: started.revision, schedulePaused: false });
    const runningPaused = cli(root, ["update", task.id], { revision: changed.revision, schedulePaused: true });
    assert.equal(runningPaused.status, "in_progress");
    const completed = cli(root, ["progress", task.id], { summary: "Pass finished", nextStep: "Wait" });
    assert.equal(completed.status, "ready");
    assert.equal(completed.schedule.paused, true);
    const resumed = cli(root, ["update", task.id], { revision: completed.revision, schedulePaused: false });
    assert.equal(resumed.schedule.paused, false);
    assert.ok(Date.parse(resumed.schedule.nextAt) > Date.now());
    const expectedNext = nextScheduledRun(rule, new Date(resumed.updatedAt));
    assert.ok(Math.abs(Date.parse(resumed.schedule.nextAt) - Date.parse(expectedNext)) < 100);
    assert.deepEqual({ ...resumed.schedule, nextAt: expectedNext }, { ...rule, paused: false, nextAt: expectedNext });
    cli(root, ["start", task.id], { revision: resumed.revision, scheduled: true }, "INVALID_TRANSITION");
    cli(root, ["start", task.id], { revision: resumed.revision }, "INVALID_TRANSITION");
    cli(root, ["update", task.id], { schedulePaused: "true" }, "INVALID_INPUT");
  }
  const plain = cli(root, ["create"], { title: "Plain" });
  cli(root, ["update", plain.id], { schedulePaused: true }, "INVALID_INPUT");
  const dependent = cli(root, ["create"], { title: "Dependent", criteria: ["Checked"], schedule: { everyMinutes: 60 }, dependencies: [plain.id], workingDirectory: root });
  cli(root, ["approve", dependent.id]);
  const paused = cli(root, ["update", dependent.id], { schedulePaused: true });
  cli(root, ["start", dependent.id], { revision: paused.revision }, "DEPENDENCIES_INCOMPLETE");
  const changed = cli(root, ["update", dependent.id], { schedule: { time: "10:00" } });
  assert.equal(changed.schedule.paused, true);
  assert.deepEqual(changed.dependencies, [plain.id]);
});

test("concurrent scheduler start and pause serialize on the board lock", async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  for (const schedule of [{ everyMinutes: 1 }, { time: "09:00" }]) {
    const created = cli(root, ["create"], { title: "Race", criteria: ["Checked"], schedule, workingDirectory: root });
    const task = cli(root, ["approve", created.id]);
    task.schedule.nextAt = "2000-01-01T00:00:00Z";
    writeFileSync(join(root, ".tasks/tasks", task.id + ".json"), JSON.stringify(task));
    const run = async (args: string[], input: object) => {
      const child = spawn(process.execPath, commandArgs(root, args, input), { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stdin.end(JSON.stringify(input));
      await once(child, "close");
      return JSON.parse(output);
    };
    const [start, pause] = await Promise.all([
      run(["start", task.id], { revision: task.revision, scheduled: true }),
      run(["update", task.id], { revision: task.revision, schedulePaused: true }),
    ]);
    assert.ok(start.ok || pause.ok);
    if (pause.ok) assert.equal(start.ok, false);
    else {
      assert.equal(pause.error.code, "REVISION_CONFLICT");
      const current = cli(root, ["show", task.id]);
      cli(root, ["update", task.id], { revision: current.revision, schedulePaused: true });
    }
    const current = cli(root, ["show", task.id]);
    assert.equal(current.schedule.paused, true);
    assert.equal(current.status, start.ok ? "in_progress" : "ready");
    cli(root, ["start", task.id], { revision: current.revision, scheduled: true }, "INVALID_TRANSITION");
  }
});

test("a recurring card starts only when due and approved and keeps its history for the next pass", t => {
  const monday = new Date(2026, 10, 16, 9);
  assert.equal(nextScheduledRun({ time: "09:00" }, monday), new Date(2026, 10, 17, 9).toISOString());
  assert.equal(nextScheduledRun({ time: "09:00", weekday: 1 }, monday), new Date(2026, 10, 23, 9).toISOString());
  assert.equal(nextScheduledRun({ everyMinutes: 90 }, monday), new Date(2026, 10, 16, 10, 30).toISOString());
  assert.equal(nextScheduledRun({ everyMinutes: 30 }, new Date(2026, 10, 16, 10, 1), monday.toISOString()), new Date(2026, 10, 16, 10, 30).toISOString());
  const monthly = { time: "09:00", dayOfMonth: 31 };
  assert.equal(nextScheduledRun(monthly, new Date(2027, 0, 30)), new Date(2027, 0, 31, 9).toISOString());
  assert.equal(nextScheduledRun(monthly, new Date(2027, 0, 31, 9)), new Date(2027, 1, 28, 9).toISOString());
  assert.equal(nextScheduledRun(monthly, new Date(2027, 1, 28, 9)), new Date(2027, 2, 31, 9).toISOString());
  assert.equal(nextScheduledRun(monthly, new Date(2027, 11, 31, 9)), new Date(2028, 0, 31, 9).toISOString());
  const yearly = { time: "09:00", dayOfMonth: 29, month: 2 };
  assert.equal(nextScheduledRun(yearly, new Date(2026, 11, 1)), new Date(2027, 1, 28, 9).toISOString());
  assert.equal(nextScheduledRun(yearly, new Date(2027, 1, 28, 9)), new Date(2028, 1, 29, 9).toISOString());
  const root = fixture(t, true);
  assert.equal(cli(root, ["init"]).project.toLowerCase(), root.toLowerCase());
  const schedule = { time: "09:00", weekday: 1 };
  const task = cli(root, ["create"], { title: "Run the weekly check", criteria: ["Report the check result."], workingDirectory: root, schedule });
  cli(root, ["start", task.id], { revision: task.revision, scheduled: true }, "INVALID_TRANSITION");
  const ready = cli(root, ["approve", task.id]);
  cli(root, ["start", task.id], { revision: ready.revision, scheduled: true }, "INVALID_TRANSITION");
  cli(root, ["update", task.id], { schedule: { time: "25:00" } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { time: "09:00", weekday: 7 } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { everyMinutes: 0 } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { everyMinutes: 60, time: "09:00" } }, "INVALID_INPUT");
  const file = join(root, ".tasks", "tasks", task.id + ".json");
  ready.schedule.nextAt = new Date(2000, 0, 1).toISOString();
  writeFileSync(file, JSON.stringify(ready));
  assert.deepEqual(cli(root, ["list", "--compact"]).tasks[0].schedule, ready.schedule);
  const started = cli(root, ["start", task.id, "--compact"], { revision: ready.revision, scheduled: true, launchDetails: true }).task;
  assert.equal(started.status, "in_progress");
  assert.deepEqual(started.schedule, ready.schedule);
  cli(root, ["start", task.id], { revision: ready.revision, scheduled: true }, "REVISION_CONFLICT");
  cli(root, ["submit", task.id], {}, "INVALID_TRANSITION");
  const completed: Task = cli(root, ["progress", task.id], { summary: "The check passed." });
  assert.equal(completed.status, "ready");
  assert.equal(completed.summary, "The check passed.");
  assert.deepEqual(completed.schedule, { ...schedule, nextAt: nextScheduledRun(schedule, new Date(completed.updatedAt)) });
  assert.deepEqual(completed.history.map(event => event.action), ["create", "approve", "start", "progress"]);
  cli(root, ["start", task.id], { revision: completed.revision, scheduled: true }, "INVALID_TRANSITION");
  const interval: Task = cli(root, ["update", task.id], { schedule: { everyMinutes: 180 } });
  assert.equal(interval.schedule?.everyMinutes, 180);
  assert.equal(cli(root, ["show", task.id]).schedule.nextAt, interval.schedule.nextAt);
  cli(root, ["update", task.id], { schedule: { ...monthly, dayOfMonth: 32 } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { ...yearly, dayOfMonth: 30 } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { ...yearly, month: 13 } }, "INVALID_INPUT");
  cli(root, ["update", task.id], { schedule: { ...monthly, weekday: 1 } }, "INVALID_INPUT");
  for (const calendar of [monthly, yearly]) {
    const saved: Task = cli(root, ["update", task.id], { schedule: calendar });
    assert.deepEqual(cli(root, ["list", "--compact"]).tasks[0].schedule, saved.schedule);
    assert.deepEqual(saved.schedule, { ...calendar, nextAt: nextScheduledRun(calendar, new Date(saved.updatedAt)) });
  }
  assert.equal(cli(root, ["update", task.id], { schedule: null }).schedule, undefined);
});

test("watch streams compact cards and sees new messages without a revision change", { timeout: 45000 }, async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const indexPath = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const legacyTag = { name: "Existing", color: "green", customColor: "#12ab34" };
  const legacyIndex = JSON.stringify({ ...index, tags: [legacyTag] });
  writeFileSync(indexPath, legacyIndex);
  const child = spawn(process.execPath, commandArgs(root, ["watch", "--compact"]), {
    env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const closed = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  t.signal.addEventListener("abort", () => child.kill(), { once: true });
  const lines = reader[Symbol.asyncIterator]();
  const frame = async () => {
    const { value } = await lines.next();
    assert.ok(typeof value === "string", "watch exited before sending a snapshot");
    return JSON.parse(value);
  };
  try {
    const initial = (await frame()).data;
    assert.deepEqual(initial.tasks, []);
    const hexTag = { name: legacyTag.name, color: "#12AB34" };
    assert.deepEqual(initial.tags, [hexTag]);
    assert.equal(readFileSync(indexPath, "utf8"), legacyIndex);
    const name = "Общая доска";
    assert.equal(cli(root, ["settings"], { name: "  " + name + "  " }).name, name);
    assert.equal((await frame()).data.settings.name, name);
    cli(root, ["settings"], { name: 42 }, "INVALID_INPUT");
    cli(root, ["settings"], { name: "two\nlines" }, "INVALID_INPUT");
    assert.equal(cli(root, ["list", "--compact"]).settings.name, name);
    cli(root, ["settings"], { name: "   " });
    assert.deepEqual((await frame()).data.settings, initial.settings);
    assert.equal(initial.settings.showCardPreviews, undefined);
    assert.equal(initial.settings.taskLimits, undefined);
    const taskLimits = { executor: 0, reviewer: 2 };
    cli(root, ["settings"], { taskLimits });
    assert.deepEqual((await frame()).data.settings.taskLimits, taskLimits);
    for (const invalid of [{ executor: -1 }, { manager: 1.5 }, { reviewer: "2" }, { unknown: 1 }, null]) {
      cli(root, ["settings"], { taskLimits: invalid }, "INVALID_INPUT");
    }
    assert.deepEqual(cli(root, ["list"]).settings.taskLimits, taskLimits);
    cli(root, ["settings"], { taskLimits: {} });
    assert.equal((await frame()).data.settings.taskLimits, undefined);
    cli(root, ["settings"], { showCardPreviews: false });
    assert.deepEqual((await frame()).data.settings, { ...initial.settings, showCardPreviews: false });
    cli(root, ["settings"], { showCardPreviews: "false" }, "INVALID_INPUT");
    assert.equal(cli(root, ["list"]).settings.showCardPreviews, false);
    cli(root, ["settings"], { showCardPreviews: true });
    assert.equal((await frame()).data.settings.showCardPreviews, true);
    const manager = { model: "test-manager", effort: "high" };
    cli(root, ["settings"], { manager });
    assert.deepEqual((await frame()).data.settings.manager, manager);
    cli(root, ["settings"], { manager: { ...manager, effort: "bad effort" } }, "INVALID_INPUT");
    assert.deepEqual(cli(root, ["list"]).settings.manager, manager);
    cli(root, ["settings"], { manager: null });
    assert.equal((await frame()).data.settings.manager, null);
    const task = cli(root, ["create"], { title: "Visible to watcher", criteria: ["Git is available."] });
    assert.equal((await frame()).data.tasks[0].id, task.id);
    const tag = cli(root, ["tag", "ensure"], { name: "Watched", color: "#F196B2" });
    assert.deepEqual((await frame()).data.tags, [hexTag, tag]);
    const recolored = cli(root, ["tag", "set"], { name: tag.name, color: "#91B6F9" });
    assert.deepEqual((await frame()).data.tags, [hexTag, recolored]);
    const ready = cli(root, ["approve", task.id]);
    assert.equal((await frame()).data.tasks[0].status, "ready");
    cli(root, ["start", task.id], { revision: ready.revision - 1 }, "REVISION_CONFLICT");
    assert.ok(!existsSync(join(root, ".git")));
    const started = cli(root, ["start", task.id]);
    let updated = (await frame()).data;
    while (updated.tasks[0].status === "ready") updated = (await frame()).data;
    assert.equal(updated.tasks[0].status, "in_progress");
    assert.equal(updated.gitInfo.head, started.task.git.base);
    assert.equal(updated.gitInfo.branch, git(root, "branch", "--show-current"));
    assert.equal(cli(started.worktree, ["show", task.id]).git.worktree, started.worktree);
    cli(root, ["run-log", task.id], { entries: [{ id: "check", type: "commandExecution",
      title: "Verification", text: "x".repeat(50_000), status: "completed" }] });
    const inputPath = join(root, "сообщение.json");
    const question = "Какое решение выбрать?";
    writeFileSync(inputPath, JSON.stringify({ kind: "question", text: question }));
    cli(root, ["message", task.id, "--input-file", inputPath]);
    let messaged;
    do { messaged = (await frame()).data; }
    while (messaged.managerInbox[0]?.text !== question);
    assert.equal(messaged.tasks[0].revision, updated.tasks[0].revision);
    assert.equal(messaged.tasks[0].historyLength, updated.tasks[0].historyLength + 2);
    assert.equal(messaged.tasks[0].history, undefined);
    assert.ok(JSON.stringify(messaged).length < 5000);
    assert.equal(cli(root, ["show", task.id]).history.findLast((event: { action: string }) => event.action === "run-log").run[0].text.length, 50_000);
    const compact = cli(root, ["show", task.id, "--compact"]);
    assert.equal(compact.historyLength, messaged.tasks[0].historyLength);
    assert.equal(compact.history, undefined);
    const externalBranch = "external-branch";
    git(root, "switch", "-c", externalBranch);
    git(root, "config", "user.name", "Updated Git Author");
    git(root, "-c", "user.email=watch@example.invalid", "commit", "--allow-empty", "-m", "chore: advance HEAD externally");
    const externalHead = git(root, "rev-parse", "HEAD");
    let external;
    do { external = await frame(); }
    while (external.data?.gitInfo.head !== externalHead || external.data.gitInfo.user !== "Updated Git Author");
    assert.equal(external.data.gitInfo.branch, externalBranch);
    assert.equal(external.data.tasks[0].revision, compact.revision);
  } finally {
    reader.close();
    child.kill();
    await closed;
  }
});

test("Git publication state and safe push are independent of tracking counts", async t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const { boardGitInfo } = await import(new URL("../src/cli/repository.ts?git-info", import.meta.url).href);
  const info = () => boardGitInfo(locateBoard(root));
  const head = git(root, "rev-parse", "HEAD");
  assert.deepEqual(info().remotes, []);
  assert.equal(boardGitInfo({ ...locateBoard(root), root: join(root, "missing") }).gitError, true);
  const remote = fixture(t);
  git(remote, "init", "--bare");
  git(root, "remote", "add", "origin", remote);
  assert.equal(info().githubRepository, undefined);
  assert.equal(info().tracking, undefined);
  assert.deepEqual(info().pushTarget, { remote: "origin", remoteRef: "refs/heads/main" });
  cli(root, ["git", "push"], { branch: "main", head });
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), head);
  assert.equal(info().upstream, "refs/heads/main");
  assert.equal(git(root, "config", "branch.main.remote"), "origin");
  git(root, "branch", "--set-upstream-to", "origin/main");
  assert.deepEqual(info().tracking, { ahead: 0, behind: 0 });
  git(root, "commit", "--allow-empty", "-m", "Local advance");
  assert.deepEqual(info().tracking, { ahead: 1, behind: 0 });
  cli(root, ["git", "push"], { branch: "main", head }, "STALE_REPOSITORY");
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  assert.equal(info().trackingError, true);
  assert.ok(info().pushTarget);
  git(root, "config", "--unset", "branch.main.merge");
  assert.equal(info().pushError, "destination");
  cli(root, ["git", "push"], { branch: "main", head: git(root, "rev-parse", "HEAD") }, "GIT_REMOTE_REQUIRED");
  git(root, "remote", "set-url", "origin", "https://github.com/example/published.git");
  assert.equal(info().githubRepository, "example/published");
  cli(root, ["git", "publish"], { branch: "main", head: git(root, "rev-parse", "HEAD"), name: "duplicate", visibility: "private" }, "REMOTE_EXISTS");
  git(root, "switch", "--detach");
  assert.equal(info().branch, undefined);
  assert.equal(info().pushTarget, undefined);
  git(root, "switch", "--orphan", "unborn");
  assert.equal(info().branch, "unborn");
  assert.equal(info().head, undefined);
  assert.equal(info().pushTarget, undefined);
});

test("watch reports Git tracking counts when only the upstream reference moves", { timeout: 20000 }, async t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const base = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--allow-empty", "-m", "Local change");
  const head = git(root, "rev-parse", "HEAD");
  const remoteCommit = git(root, "commit-tree", "HEAD^{tree}", "-p", base, "-m", "First upstream change");
  const remoteTip = git(root, "commit-tree", "HEAD^{tree}", "-p", remoteCommit, "-m", "Second upstream change");
  const upstream = "refs/remotes/upstream/main";
  git(root, "remote", "add", "upstream", ".");
  git(root, "update-ref", upstream, remoteTip);
  git(root, "branch", "--set-upstream-to", "upstream/main");

  const child = spawn(process.execPath, commandArgs(root, ["watch", "--compact"]), {
    env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const closed = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  t.signal.addEventListener("abort", () => child.kill(), { once: true });
  const lines = reader[Symbol.asyncIterator]();
  const gitInfo = async () => {
    const { value } = await lines.next();
    assert.ok(value, "watch exited before sending a snapshot");
    const result = JSON.parse(value);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.gitInfo.head, head);
    return result.data.gitInfo;
  };
  try {
    assert.deepEqual((await gitInfo()).tracking, { ahead: 1, behind: 2 });
    git(root, "update-ref", upstream, head);
    assert.deepEqual((await gitInfo()).tracking, { ahead: 0, behind: 0 });
    git(root, "update-ref", "-d", upstream);
    const missing = await gitInfo();
    assert.equal(missing.tracking, undefined);
    assert.equal(missing.trackingError, true);
    assert.ok(missing.pushTarget);
    git(root, "branch", "--unset-upstream");
    const untracked = await gitInfo();
    assert.equal(untracked.upstream, undefined);
    assert.equal(untracked.pushError, "destination");
    git(root, "remote", "add", "origin", "https://github.com/example/published.git");
    const published = await gitInfo();
    assert.equal(published.githubRepository, "example/published");
    assert.equal(published.pushTarget.remote, "origin");
    git(root, "remote", "remove", "origin");
    assert.equal((await gitInfo()).githubRepository, undefined);
  } finally {
    reader.close();
    child.kill();
    await closed;
  }
});

test("submission commits the confirmed snapshot and rejects changed or incomplete inputs", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Update source", criteria: ["Source is updated."] });
  cli(root, ["approve", task.id]);
  const { worktree, task: started } = cli(root, ["start", task.id, "--compact"]);
  assert.equal(started.status, "in_progress");
  assert.equal(started.git.worktree, worktree);
  assert.equal(started.history, undefined);
  writeFileSync(join(worktree, "source.txt"), "first attempt\n");
  writeFileSync(join(worktree, "new [report].csv"), "id\n42\n");
  writeFileSync(join(worktree, "ignored.local"), "keep local");
  const original = cli(worktree, ["preview", task.id]);
  assert.deepEqual(original.paths, ["new [report].csv", "source.txt"]);
  const compact = cli(worktree, ["preview", task.id, "--compact"]);
  assert.equal(compact.diff, undefined);
  assert.deepEqual(compact.paths, original.paths);
  assert.equal(compact.token, original.token);
  assert.equal(compact.targetHead, original.targetHead);
  const page = { token: compact.token, paths: ["new [report].csv"] };
  const selected = cli(worktree, ["preview", task.id], page);
  assert.match(selected.diff, /\+42/);
  assert.doesNotMatch(selected.diff, /source\.txt/);
  cli(worktree, ["preview", task.id], { ...page, paths: ["ignored.local"] }, "INVALID_INPUT");
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), "");
  writeFileSync(join(worktree, "source.txt"), "new content for the same path\n");
  cli(worktree, ["preview", task.id], page, "STALE_SNAPSHOT");
  const input = { token: original.token, message: "feat: update the source", summary: "Updated source",
    checks: ["Build — passed; no errors\nCommand: dotnet build -c Release"] };
  cli(worktree, ["submit", task.id], input, "STALE_SNAPSHOT");
  assert.equal(cli(root, ["show", task.id]).status, "in_progress");
  const current = cli(worktree, ["preview", task.id]);
  cli(worktree, ["submit", task.id], { ...input, token: current.token, message: "changes" }, "INVALID_COMMIT_MESSAGE");
  const submitted = cli(worktree, ["submit", task.id, "--compact"], { ...input, token: current.token });
  assert.equal(submitted.status, "review");
  assert.equal(submitted.history, undefined);
  assert.equal(submitted.tokenUsage, undefined);
  assert.deepEqual(cli(root, ["review", task.id]).result, submitted.result);
  assert.equal(git(worktree, "rev-parse", "HEAD"), submitted.git.submission.sha);
  assert.equal(git(worktree, "log", "-1", "--format=%B"), "feat: update the source\n\nTask: " + task.id);
  assert.ok(!existsSync(join(root, "new [report].csv")));
  assert.equal(git(worktree, "ls-files", "--", "ignored.local"), "");
  const requirements = { actor: "user", criteria: ["Review the updated source and CSV."], note: "Add CSV to acceptance" };
  cli(root, ["update", task.id], { ...requirements, revision: submitted.revision, preserveStatus: true }, "STATUS_CHANGE_REQUIRED");
  const unchanged = cli(root, ["show", task.id]);
  assert.equal(unchanged.status, "review");
  assert.equal(unchanged.revision, submitted.revision);
  assert.deepEqual(unchanged.criteria, task.criteria);
  const edited = cli(root, ["update", task.id], { title: "Review source", revision: submitted.revision, preserveStatus: true });
  assert.equal(edited.title, "Review source");
  assert.equal(edited.status, "review");
  const launchState = cli(root, ["show", task.id, "--compact"], { launchDetails: true });
  assert.equal(launchState.revision, edited.revision);
  assert.equal(launchState.history, undefined);
  cli(root, ["settings"], { reviewMode: "human" });
  const returned = cli(root, ["request-changes", task.id, "--compact"], {
    revision: edited.revision, reason: "Verify the CSV header", actor: "manager", launchDetails: true,
    reviewMode: "human", targetHead: cli(root, ["review", task.id]).targetHead,
  });
  assert.equal(returned.status, "in_progress");
  assert.equal(returned.history, undefined);
  const launched = cli(root, ["start", task.id, "--compact"], { revision: returned.revision, launchDetails: true });
  assert.equal(launched.worktree, worktree);
  assert.deepEqual(launched.task.criteria, task.criteria);
  assert.equal(launched.task.feedback, "Verify the CSV header");
  assert.equal(launched.task.history, undefined);
  assert.equal(launched.task.tokenUsage, undefined);
  const again = cli(worktree, ["preview", task.id, "--compact"]);
  cli(worktree, ["submit", task.id, "--compact"], { ...input, token: again.token, message: again.commitMessage });
  const updated = cli(root, ["update", task.id], requirements);
  assert.equal(updated.status, "ready");
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
});

test("submission preview pages reconstruct a long diff for an existing commit", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Add long report", criteria: ["Report is visible."] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  const path = "long.txt";
  writeFileSync(join(worktree, path), "😀".repeat(9_000) + "\n");
  git(worktree, "add", path);
  git(worktree, "commit", "-m", "docs: add long report", "-m", "Task: " + task.id);
  const full = cli(worktree, ["preview", task.id]);
  const request = { token: full.token, paths: [path] };
  const first = cli(worktree, ["preview", task.id], request);
  assert.ok(first.nextOffset <= 16_000);
  const last = cli(worktree, ["preview", task.id], { ...request, offset: first.nextOffset });
  assert.equal(first.diff + last.diff, full.diff);
  assert.equal(last.nextOffset, undefined);
  assert.equal(cli(worktree, ["preview", task.id, "--compact"]).commitMessage, full.commitMessage);

  const preload = `
    import child from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const spawnSync = child.spawnSync;
    child.spawnSync = (command, args, options) => {
      if (command === "git" && args[0] === "write-tree") {
        const lock = new DatabaseSync(${JSON.stringify(join(root, ".tasks", ".lock.sqlite"))});
        try { lock.exec("BEGIN IMMEDIATE"); }
        finally { lock.close(); }
        if (process.env.TASKBOARD_TEST_EDIT_DURING_PREVIEW) {
          const update = spawnSync(process.execPath, ${JSON.stringify(commandArgs(root, ["update", task.id], {}))}, {
            input: JSON.stringify({ title: "Updated during preview" }), encoding: "utf8", windowsHide: true,
          });
          if (update.status !== 0) throw new Error(update.stdout + update.stderr);
        }
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `;
  const args = ["--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(worktree, ["preview", task.id, "--compact"])];
  const available = spawnSync(process.execPath, args, { env, encoding: "utf8", windowsHide: true });
  assert.equal(available.status, 0, available.stdout + available.stderr);
  assert.equal(JSON.parse(available.stdout).data.token, full.token);
  const changed = spawnSync(process.execPath, args, {
    env: { ...env, TASKBOARD_TEST_EDIT_DURING_PREVIEW: "1" }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.equal(JSON.parse(changed.stdout).error.code, "REVISION_CONFLICT");
});

test("maintenance migrates idle legacy worktrees and repeatedly removes only project legacy attachments", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  git(root, "branch", "side");
  const card = cli(root, ["create"], { title: "Idle migration", criteria: ["Keep the index"] });
  cli(root, ["approve", card.id]);
  const started = cli(root, ["start", card.id], { target: "side" });
  const integration = join(root, ".tasks", "worktrees", ".accept-" + card.id);
  mkdirSync(dirname(integration), { recursive: true });
  git(root, "worktree", "add", integration, "side");
  writeFileSync(join(integration, "kept.local"), "integration data");
  cli(root, ["pause", card.id]);
  const legacy = join(root, ".taskboard-worktrees", card.id);
  mkdirSync(dirname(legacy));
  git(root, "worktree", "move", started.worktree, legacy);
  writeFileSync(join(legacy, "source.txt"), "staged\n"); git(legacy, "add", "source.txt");
  writeFileSync(join(legacy, "notes.local"), "preserved\n");
  const before = git(legacy, "status", "--porcelain", "--ignored");
  const ownAttachment = join(root, ".tasks", "attachments", "owned.txt");
  writeFileSync(ownAttachment, "board attachment");
  for (let pass = 0; pass < 2; pass++) {
    mkdirSync(join(root, ".codex-attachments"));
    writeFileSync(join(root, ".codex-attachments", "legacy.jpg"), "legacy");
    cli(root, ["maintain"]);
    assert.ok(!existsSync(join(root, ".codex-attachments")));
    assert.equal(readFileSync(ownAttachment, "utf8"), "board attachment");
  }
  const current = cli(root, ["show", card.id]);
  assert.equal(current.status, "ready");
  assert.equal(readFileSync(join(root, ".worktrees", ".accept-" + card.id, "kept.local"), "utf8"), "integration data");
  assert.equal(current.git.worktree, realpathSync(join(root, ".worktrees", card.id)));
  assert.equal(git(current.git.worktree, "status", "--porcelain", "--ignored"), before);
  assert.ok(!existsSync(join(root, ".taskboard-worktrees")));
  assert.ok(!existsSync(join(root, ".tasks", "worktrees")));
  const outside = fixture(t);
  writeFileSync(join(outside, "keep"), "outside");
  symlinkSync(outside, join(root, ".codex-attachments"), process.platform === "win32" ? "junction" : "dir");
  cli(root, ["maintain"]);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "outside");
  assert.ok(JSON.parse(readFileSync(join(root, ".tasks", "maintenance.json"), "utf8")).some((job: { operation: string }) => job.operation === "attachments"));
});

test("cancelled task maintenance preserves staged and untracked edits in the existing saved-changes mechanism", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const card = cli(root, ["create"], { title: "Cancelled local edits", criteria: ["Keep edits"] });
  cli(root, ["approve", card.id]);
  const { worktree } = cli(root, ["start", card.id]);
  writeFileSync(join(worktree, "source.txt"), "staged change\n"); git(worktree, "add", "source.txt");
  writeFileSync(join(worktree, "user.txt"), "untracked user data\n");
  cli(root, ["cancel", card.id], { reason: "No longer needed" });
  assert.ok(!existsSync(worktree));
  const closed = cli(root, ["show", card.id]);
  assert.equal(closed.status, "cancelled");
  assert.match(closed.savedChanges.sha, /^[0-9a-f]{40}$/);
  const restored = cli(root, ["restore-changes", card.id], { revision: closed.revision, destination: "worktree" });
  assert.equal(readFileSync(join(restored.path, "source.txt"), "utf8"), "staged change\n");
  assert.equal(readFileSync(join(restored.path, "user.txt"), "utf8"), "untracked user data\n");
  assert.equal(git(restored.path, "diff", "--cached", "--name-only"), "source.txt");
  const legacy = join(root, ".tasks", "worktrees", restored.path.split(/[\\/]/).at(-1)!);
  mkdirSync(dirname(legacy), { recursive: true });
  git(root, "worktree", "move", restored.path, legacy);
  const backupPath = join(root, ".tasks", "pending", card.id + ".json.saved");
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  backup.restored.path = legacy; writeFileSync(backupPath, JSON.stringify(backup));
  git(root, "worktree", "lock", legacy);
  cli(root, ["maintain"]);
  assert.ok(existsSync(legacy));
  git(root, "worktree", "unlock", legacy);
  cli(root, ["maintain"]);
  const recovered = cli(root, ["restore-changes", card.id], { revision: closed.revision, destination: "worktree" });
  assert.equal(recovered.path, restored.path);
  assert.equal(readFileSync(join(recovered.path, "user.txt"), "utf8"), "untracked user data\n");
  assert.equal(git(recovered.path, "diff", "--cached", "--name-only"), "source.txt");
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".tasks", "maintenance.json"), "utf8")), []);
});

test("T-0138 cleanup retains QA and unknown files, queues dependency repair and closes its internal fault after retry", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "result\n"));
  const exclude = join(root, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/node_modules/\n");
  mkdirSync(join(worktree, "node_modules", "fixture-dependency"), { recursive: true });
  writeFileSync(join(worktree, "node_modules", "fixture-dependency", "index.js"), "export default 1;\n");
  mkdirSync(join(worktree, ".tasks", "qa"), { recursive: true });
  writeFileSync(join(worktree, ".tasks", "qa", "required.png"), "review evidence");
  writeFileSync(join(worktree, "unknown.local"), "user data");
  const done = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done"); assert.equal(done.cleanupWarning, undefined);
  const fault = join(root, ".tasks", "maintenance.json");
  assert.equal(JSON.parse(readFileSync(fault, "utf8")).filter((job: { operation: string }) => job.operation === "cleanup").length, 1);
  const artifact = cli(root, ["show", task.id]).artifacts.find((item: { source: string }) => item.source === ".tasks/qa/required.png");
  assert.equal(readFileSync(artifact.file, "utf8"), "review evidence");
  const readCleanupFacts = () => globSync(".tasks/worklog/*/*/*.md", { cwd: root })
    .flatMap(path => readFileSync(join(root, path), "utf8").match(/^  - worktree cleanup:.*$/gm) ?? []);
  const originalJobs = JSON.parse(readFileSync(fault, "utf8"));
  const cleanup = originalJobs.find((job: { operation: string }) => job.operation === "cleanup");
  const beforeRetry = readCleanupFacts();
  assert.match(beforeRetry.at(-1)!, /failed; resources retained for retry/);
  cli(root, ["maintain"]); cli(root, ["maintain"]);
  assert.deepEqual(JSON.parse(readFileSync(fault, "utf8")), originalJobs);
  assert.deepEqual(readCleanupFacts(), beforeRetry);
  cleanup.cleanupRetryAt = 0;
  writeFileSync(fault, JSON.stringify(originalJobs));
  cli(root, ["maintain"]);
  const afterRetry = JSON.parse(readFileSync(fault, "utf8"));
  assert.equal(afterRetry.length, 1);
  assert.equal(afterRetry[0].attempts, cleanup.attempts + 1);
  assert.ok(afterRetry[0].cleanupRetryAt > Date.now());
  assert.deepEqual(readCleanupFacts().slice(beforeRetry.length), [
    "  - worktree cleanup: started; outcome unknown",
    "  - worktree cleanup: failed; resources retained for retry",
  ]);
  assert.equal(readFileSync(join(worktree, "unknown.local"), "utf8"), "user data");
  // The diagnostic agent removes only independently reproduced dependency bytes.
  assert.equal(readFileSync(join(worktree, "node_modules", "fixture-dependency", "index.js"), "utf8"), "export default 1;\n");
  rmSync(join(worktree, "node_modules"), { recursive: true });
  cli(root, ["cleanup", task.id], undefined, "DIRTY_WORKTREE");
  cli(root, ["cleanup", task.id], { artifacts: ["unknown.local"] });
  assert.ok(!existsSync(worktree));
  assert.deepEqual(JSON.parse(readFileSync(fault, "utf8")), []);
  assert.equal(cli(root, ["show", task.id]).status, "done");
  assert.equal(readFileSync(artifact.file, "utf8"), "review evidence");
});

function submitFixture(root: string, edit: (worktree: string) => void, target?: string) {
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Deliver result", criteria: ["Result is delivered."] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id], target ? { target } : undefined);
  edit(worktree);
  const { token } = cli(worktree, ["preview", task.id]);
  const reviewed = cli(worktree, ["submit", task.id], {
    token, message: "feat: deliver result", summary: "Delivered", checks: ["Read the result"],
  });
  return { task: reviewed, worktree };
}

test("review return transfers link feedback to the same Git worktree", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "# T-0096\n"));
  cli(root, ["settings"], { reviewMode: "human" });
  const before = cli(root, ["chat", task.id], { text: "Решетка должна быть частью гиперссылки", model: "test", effort: "low" });
  const review = cli(root, ["review", task.id], { compact: true, includeReviewerSettings: true });
  const reason = "Включить решётку и номер задачи в одну гиперссылку с общим подчёркиванием при наведении и фокусе.";
  const decision = { reason, actor: "manager", revision: review.revision, targetHead: review.targetHead, reviewMode: review.settings.reviewMode };
  cli(root, ["accept", task.id], decision, "AUTO_REVIEW_DISABLED");
  const fromDiscussion = { ...decision, actor: "discussion" };
  const returned = cli(root, ["request-changes", task.id], fromDiscussion);
  cli(root, ["request-changes", task.id], fromDiscussion, "REVISION_CONFLICT");
  assert.equal(returned.status, "in_progress");
  assert.deepEqual(returned.history.slice(0, -1), before.history);
  assert.equal(returned.history.at(-1).text, reason);
  const { discussionReturn } = returned;
  assert.equal(discussionReturn, returned.revision);
  const posted = cli(root, ["chat", task.id], { text: "Возвращено", model: "test", effort: "low" });
  const start = { discussionReturn, revision: returned.revision, launchDetails: true };
  cli(root, ["start", task.id, "--compact"], start, "REVISION_CONFLICT");
  assert.equal(cli(root, ["show", task.id]).discussionReturn, discussionReturn);
  const started = cli(root, ["start", task.id, "--compact"], { ...start, revision: posted.revision });
  cli(root, ["start", task.id, "--compact"], { ...start, revision: started.task.revision }, "INVALID_TRANSITION");
  assert.equal(started.task.id, task.id);
  assert.equal(started.worktree, worktree);
  assert.equal(started.task.feedback, reason);
});

test("discussion return does not decide the manager's independent review", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  cli(root, ["settings"], { reviewMode: "manager", autoMode: false });
  const { id } = cli(root, ["create"], { title: "Correct link", criteria: ["One link"], workingDirectory: root, expertTeam: {
    review: { lead: "qa-engineer", reason: "Independent verification", stages: [{
      key: "verify", expertId: "qa-engineer", title: "Verify", criteria: ["Checked"], outputs: ["Decision"],
    }] },
  } });
  cli(root, ["approve", id]);
  cli(root, ["start", id]);
  const { token } = cli(root, ["preview", id]);
  const submitted = cli(root, ["submit", id], { token, noChanges: true, summary: "Submitted", checks: ["Checked"] });
  const decision = { revision: submitted.revision, targetHead: null, reviewMode: "manager", reason: "Include the # in the link" };
  cli(root, ["request-changes", id], { ...decision, actor: "manager" }, "EXPERT_STAGES_INCOMPLETE");
  const returned = cli(root, ["request-changes", id], { ...decision, actor: "discussion" });
  assert.equal(returned.status, "in_progress");
  assert.equal(returned.discussionReturn, returned.revision);
  assert.equal(returned.history.at(-1).actor, "agent");
});

test("a full daily Worklog allows start, submit and accept", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = year + "-" + month + "-" + String(now.getDate()).padStart(2, "0");
  const folder = join(root, ".tasks", "worklog", year, month);
  mkdirSync(folder, { recursive: true });
  const header = "# Codex Worklog — " + day + "\n";
  const full = Buffer.concat([Buffer.from(header), Buffer.alloc(maxWorklogPartBytes - Buffer.byteLength(header), 10)]);
  const original = join(folder, day + ".md");
  writeFileSync(original, full);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "result\n"));
  const done = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done");
  assert.ok(readFileSync(original).equals(full));
  const next = globSync("*.part-2.md", { cwd: folder });
  assert.equal(next.length, 1);
  assert.match(readFileSync(join(folder, next[0]!), "utf8"), /start: started[\s\S]*submit: started[\s\S]*accept: started/);
});

test("acceptance publishes completion and releases the board before worktree cleanup", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const checked = join(root, ".git", "cleanup-locks-checked");
  const preload = `
    import assert from "node:assert/strict";
    import child from "node:child_process";
    import { readFileSync, writeFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const spawnSync = child.spawnSync;
    child.spawnSync = (command, args, options) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
        const card = JSON.parse(readFileSync(${JSON.stringify(join(root, ".tasks", "tasks", task.id + ".json"))}, "utf8"));
        assert.equal(card.status, "done");
        const board = new DatabaseSync(${JSON.stringify(join(root, ".tasks", ".lock.sqlite"))});
        try { board.exec("BEGIN IMMEDIATE"); }
        finally { board.close(); }
        const taskLock = new DatabaseSync(${JSON.stringify(join(root, ".tasks", "pending", task.id + ".start.sqlite"))});
        try { assert.throws(() => taskLock.exec("BEGIN IMMEDIATE"), { errcode: 5 }); }
        finally { taskLock.close(); }
        writeFileSync(${JSON.stringify(checked)}, "");
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `;
  const input = { revision: task.revision };
  const result = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["accept", task.id], input),
  ], { env, encoding: "utf8", input: JSON.stringify(input), windowsHide: true, timeout: 40_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const accepted = JSON.parse(result.stdout).data;
  assert.equal(accepted.status, "done");
  assert.equal(accepted.cleanupWarning, undefined);
  assert.ok(existsSync(checked));
  assert.ok(!existsSync(worktree));
});

test("acceptance releases the board while Git automatic maintenance is still running", { timeout: 90_000 }, async t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  git(root, "repack", "-d");
  writeFileSync(join(root, "source.txt"), "new base\n");
  git(root, "commit", "-am", "chore: advance target");
  git(root, "repack", "-d");
  git(root, "config", "gc.autoPackLimit", "1");
  git(root, "config", "maintenance.autoDetach", "false");
  git(root, "config", "gc.autoDetach", "false");
  git(root, "config", "maintenance.auto", "true");
  const gitDir = join(root, ".git");
  const started = join(gitDir, "maintenance-started");
  const release = join(gitDir, "maintenance-release");
  const trace = join(gitDir, "maintenance-trace.jsonl");
  writeFileSync(join(gitDir, "hooks", "pre-auto-gc"), [
    "#!/bin/sh",
    "touch .git/maintenance-started",
    "for i in $(seq 450); do",
    "  if test -f .git/maintenance-release; then break; fi",
    "  sleep 0.05",
    "done",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  const waitFor = async (predicate: () => boolean, message: string) => {
    const deadline = Date.now() + 25_000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(predicate(), message);
  };
  const finished = () => {
    if (!existsSync(trace)) return false;
    const events = readFileSync(trace, "utf8").trimEnd().split("\n");
    const launch = events.find(line => line.includes('"event":"start"') && line.includes('"maintenance","run","--auto"'));
    if (!launch) return false;
    const { sid } = JSON.parse(launch);
    return events.some(line => line.includes('"event":"atexit"') && line.includes('"sid":' + JSON.stringify(sid)));
  };
  try {
    const input = { revision: task.revision };
    const result = spawnSync(process.execPath, commandArgs(root, ["accept", task.id], input), {
      env: { ...env, GIT_TRACE2_EVENT: trace }, encoding: "utf8", input: JSON.stringify(input), windowsHide: true, timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).data.status, "done");
    await waitFor(() => existsSync(started), "Git did not start automatic maintenance");
    const otherTask = cli(root, ["create"], { title: "Write while maintenance is running" });
    assert.equal(otherTask.status, "draft");
    assert.equal(finished(), false);
  } finally {
    writeFileSync(release, "");
    if (existsSync(started)) await waitFor(finished, "Git did not finish automatic maintenance");
  }
});

test("an existing working directory supports start, resume, review and acceptance without a task branch", t => {
  const root = fixture(t, true);
  const cwd = fixture(t);
  const head = git(root, "rev-parse", "HEAD");
  cli(root, ["init"]);
  cli(root, ["create"], { title: "Invalid path", workingDirectory: "relative" }, "INVALID_INPUT");
  const executor = { provider: "codex", model: "board-executor", effort: "low" };
  cli(root, ["settings"], { executor });
  const task = cli(root, ["create"], { title: "Check external files", criteria: ["A report was saved."], workingDirectory: cwd });
  cli(root, ["approve", task.id]);
  const started = cli(root, ["start", task.id, "--compact"], { launchDetails: true });
  assert.equal(started.cwd, cwd);
  assert.equal(started.task.workingDirectory, cwd);
  assert.deepEqual(started.task.execution, executor);
  assert.equal(started.worktree, undefined);
  assert.equal(started.task.git, undefined);
  const old = cli(root, ["preview", task.id]);
  cli(root, ["progress", task.id], { summary: "Checked files", nextStep: "Save the report" });
  cli(root, ["update", task.id], { workingDirectory: root }, "INVALID_TRANSITION");
  assert.equal(cli(root, ["start", task.id]).cwd, cwd);
  const result = { noChanges: true, summary: "Saved the report", checks: ["Report exists in the requested directory"] };
  cli(root, ["submit", task.id], { ...result, token: old.token }, "STALE_SNAPSHOT");
  writeFileSync(join(cwd, "report.txt"), "Verified\n");
  const preview = cli(root, ["preview", task.id]);
  assert.deepEqual(preview.paths, []);
  cli(root, ["submit", task.id], { ...result, token: preview.token, artifacts: ["report.txt"] });
  const review = cli(root, ["review", task.id], { compact: true });
  assert.equal(review.noChanges, true);
  assert.equal(review.targetHead, null);
  assert.equal(review.stale, false);
  assert.equal(review.artifacts[0].source, "report.txt");
  const done = cli(root, ["accept", task.id], { revision: review.revision });
  assert.equal(done.status, "done");
  assert.equal(done.git, undefined);
  assert.equal(done.cleanupWarning, undefined);
  assert.equal(readFileSync(join(cwd, "report.txt"), "utf8"), "Verified\n");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/*"), "");
});

test("completed work outside Git can be submitted and accepted without a commit", t => {
  const root = fixture(t, true);
  const head = git(root, "rev-parse", "HEAD");
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Remove local data", criteria: ["The old local file is absent."] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  const local = join(root, "old.local");
  writeFileSync(local, "old data");
  rmSync(local);
  const { token } = cli(worktree, ["preview", task.id]);
  const input = { token, noChanges: true, summary: "Removed the old local file", checks: ["Verified old.local is absent"] };
  cli(worktree, ["submit", task.id], { ...input, checks: [] }, "CHECKS_REQUIRED");

  const source = join(worktree, "source.txt");
  writeFileSync(source, "unexpected change\n");
  cli(worktree, ["submit", task.id], input, "STALE_SNAPSHOT");
  const dirty = cli(worktree, ["preview", task.id]);
  cli(worktree, ["submit", task.id], { ...input, token: dirty.token }, "CHANGES_PRESENT");
  writeFileSync(source, "baseline\n");

  cli(worktree, ["block", task.id], { reason: "Old CLI required changes", condition: "Support submission outside Git" });
  cli(worktree, ["resume", task.id], { reason: "Submission outside Git is supported" });
  const resumed = cli(worktree, ["preview", task.id]);
  const submitted = cli(worktree, ["submit", task.id], { ...input, token: resumed.token });
  assert.equal(submitted.status, "review");
  assert.equal(submitted.git.submission, undefined);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  const review = cli(root, ["review", task.id]);
  assert.equal(review.noChanges, true);
  assert.equal(review.targetHead, null);
  assert.equal(review.stale, false);
  assert.deepEqual(review.result.checks, input.checks);

  const log = join(worktree, "debug.log");
  writeFileSync(log, "local verification output\n");
  assert.equal(cli(root, ["review", task.id]).stale, false);
  writeFileSync(source, "modified after submission\n");
  assert.equal(cli(root, ["review", task.id]).stale, true);
  cli(root, ["accept", task.id], { revision: review.revision }, "STALE_SUBMISSION");
  writeFileSync(source, "baseline\n");
  cli(root, ["accept", task.id], { revision: review.revision - 1 }, "REVISION_CONFLICT");
  const done = cli(root, ["accept", task.id], { revision: review.revision });
  assert.equal(done.status, "done");
  assert.equal(done.cleanupWarning, undefined);
  assert.equal(readFileSync(log, "utf8"), "local verification output\n");
  assert.equal(done.git.accepted, undefined);
  assert.equal(Object.hasOwn(done, "acceptedTreeMatchesSubmission"), false);
  assert.equal(Object.hasOwn(cli(root, ["show", task.id, "--compact"]), "acceptedTreeMatchesSubmission"), false);
  const metrics = cli(root, ["metrics", task.id]);
  assert.equal(metrics.completedAt, done.closedAt);
  assert.equal(metrics.cycleMs, Date.parse(done.closedAt) - Date.parse(task.createdAt));
  assert.equal(metrics.submissions, 1);
  assert.equal(metrics.returns, 0);
  rmSync(log);
  const retried = cli(root, ["accept", task.id], { revision: review.revision });
  assert.equal(retried.cleanupWarning, undefined);
  assert.equal(retried.revision, done.revision);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
});

test("interrupted start and submit recover the existing worktree and commit", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const draft = cli(root, ["create"], { title: "Recover a task", criteria: ["A result is delivered."] });
  const ready = cli(root, ["approve", draft.id]);
  const pending = join(root, ".tasks", "pending", ready.id + ".json");
  let worktree = join(root, ".tasks", "worktrees", ready.id);
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(pending, JSON.stringify({ action: "start", revision: ready.revision, target: "refs/heads/main", base }));
  git(root, "worktree", "add", "-b", "ai-taskboard/" + ready.id, worktree, base);
  cli(root, ["cancel", ready.id], { reason: "Check that partial Git state is preserved" }, "PENDING_OPERATION");

  const started = cli(root, ["start", ready.id]);
  const recoveredStart = cli(root, ["metrics", ready.id]).starts[0];
  assert.ok(Number.isSafeInteger(recoveredStart.prepareMs) && recoveredStart.prepareMs >= 0);
  assert.equal(recoveredStart.gitWorktreeAddMs, undefined);
  assert.ok(!existsSync(worktree));
  worktree = join(root, ".worktrees", ready.id);
  assert.equal(started.worktree, realpathSync(worktree));
  assert.equal(started.task.status, "in_progress");
  assert.ok(!existsSync(pending));
  const resultFile = join(worktree, "result.txt");
  writeFileSync(resultFile, "delivered\n");
  const snapshot = cli(worktree, ["preview", ready.id]);
  const message = "feat: deliver result\n\nTask: " + ready.id;
  const result = { summary: "Delivered", checks: [], limitations: [] };
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  cli(worktree, ["submit", ready.id], { ...result, token: snapshot.token, message }, "GIT_FAILED");
  assert.equal(cli(root, ["show", ready.id]).status, "in_progress");
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(readFileSync(resultFile, "utf8"), "delivered\n");
  assert.ok(!existsSync(pending));
  rmSync(hook);

  const intent = JSON.stringify({ action: "submit", revision: started.task.revision, snapshot, message, result });
  writeFileSync(pending, intent);
  git(worktree, "add", "result.txt");
  git(worktree, "commit", "--cleanup=verbatim", "-m", message);
  const sha = git(worktree, "rev-parse", "HEAD");
  const submitted = cli(worktree, ["submit", ready.id]);
  assert.equal(submitted.status, "review");
  assert.equal(submitted.git.submission.sha, sha);
  assert.ok(!existsSync(pending));
  writeFileSync(pending, intent);
  assert.equal(cli(worktree, ["submit", ready.id]).revision, submitted.revision);
  assert.ok(!existsSync(pending));
});

test("an executor can resume its own unfinished rebase in the registered worktree", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const card = cli(root, ["create"], { title: "Resume a rebase", criteria: ["Resolve the source change."] });
  cli(root, ["approve", card.id]);
  const { task, worktree } = cli(root, ["start", card.id]);
  git(worktree, "switch", "--detach");
  cli(root, ["start", card.id], { revision: task.revision }, "WORKTREE_MISSING");
  git(worktree, "switch", task.git.branch.slice("refs/heads/".length));
  writeFileSync(join(worktree, "source.txt"), "task version\n");
  git(worktree, "commit", "-am", "fix: update task source");
  writeFileSync(join(root, "source.txt"), "target version\n");
  git(root, "commit", "-am", "fix: update target source");
  assert.throws(() => git(worktree, "rebase", "main"), /CONFLICT|could not apply/);

  const status = git(worktree, "status", "--porcelain");
  assert.match(status, /^UU source\.txt$/);
  const resumed = cli(root, ["start", card.id, "--compact"], { revision: task.revision, launchDetails: true });
  assert.equal(resumed.worktree, worktree);
  assert.equal(resumed.task.revision, task.revision);
  assert.equal(cli(root, ["show", card.id]).git.worktree, worktree);
  cli(root, ["preview", card.id], undefined, "GIT_OPERATION_IN_PROGRESS");
  assert.equal(git(worktree, "status", "--porcelain"), status);

  // Git finished the move, but the task still records the legacy location.
  const relocated = join(root, ".worktrees", card.id);
  const legacyPath = join(root, ".taskboard-worktrees", card.id);
  mkdirSync(dirname(legacyPath), { recursive: true });
  git(root, "worktree", "move", worktree, legacyPath);
  const cardPath = join(root, ".tasks", "tasks", card.id + ".json");
  const savedCard = JSON.parse(readFileSync(cardPath, "utf8"));
  savedCard.git.worktree = legacyPath;
  writeFileSync(cardPath, JSON.stringify(savedCard));
  git(root, "worktree", "move", legacyPath, relocated);
  const recovered = cli(root, ["start", card.id, "--compact"], { revision: task.revision, isolatedWorktree: true, launchDetails: true });
  assert.equal(recovered.worktree, realpathSync(relocated));
  assert.equal(recovered.task.git.worktree, recovered.worktree);
  assert.equal(git(relocated, "status", "--porcelain"), status);
  git(relocated, "rebase", "--abort");
});

test("resubmission verifies the actual Conventional Commit after an external rebase", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  git(root, "commit", "--allow-empty", "-m", "chore: advance target");
  git(worktree, "rebase", "main");
  const head = git(worktree, "rev-parse", "HEAD");
  assert.notEqual(head, task.git.submission.sha);
  assert.equal(cli(root, ["review", task.id]).stale, true);
  cli(root, ["accept", task.id], { revision: task.revision }, "STALE_SUBMISSION");
  const returned = cli(root, ["request-changes", task.id], { reason: "Review the rebased result" });
  assert.equal(returned.status, "in_progress");
  assert.equal(returned.history.at(-1).text, "Review the rebased result");
  const restarted = cli(root, ["start", task.id], { revision: returned.revision });
  assert.equal(restarted.worktree, worktree);
  assert.equal(restarted.task.git.branch, task.git.branch);
  assert.equal(restarted.task.status, "in_progress");

  const preview = cli(worktree, ["preview", task.id]);
  assert.deepEqual(preview.paths, ["result.txt"]);
  assert.match(preview.diff, /\+delivered/);
  assert.equal(preview.commitMessage, task.git.submission.message);
  const input = { token: preview.token, message: preview.commitMessage, summary: "Rebased", checks: [] };
  cli(worktree, ["submit", task.id], { ...input, message: "fix: different message" }, "INVALID_COMMIT_MESSAGE");
  assert.equal(cli(root, ["show", task.id]).status, "in_progress");
  const submitted = cli(worktree, ["submit", task.id], input);
  assert.equal(submitted.status, "review");
  assert.equal(submitted.git.submission.sha, head);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(cli(root, ["accept", task.id], { revision: submitted.revision }).status, "done");
});

const crashpadOutput = "[1116/134653.421:ERROR:third_party\\crashpad\\crashpad\\util\\win\\registration_protocol_win.cc:108] CreateFile: Access is denied. (0x5)\r\n";

test("review and acceptance preserve a local file that became untracked after submission", t => {
  const root = fixture(t, true);
  const exclude = join(root, ".git", "info", "exclude");
  let original = "";
  const log = "debug.log";
  const { task, worktree } = submitFixture(root, path => {
    original = readFileSync(exclude, "utf8");
    writeFileSync(exclude, original + "\n/" + log + "\n");
    writeFileSync(join(path, log), crashpadOutput + "local verification output\n");
    writeFileSync(join(path, "result.txt"), "verified result\n");
  });
  writeFileSync(exclude, original);
  assert.equal(git(root, "status", "--porcelain"), "");
  cli(root, ["settings"], { reviewMode: "reviewer" });

  const review = cli(root, ["review", task.id]);
  assert.equal(review.stale, false);
  assert.deepEqual(review.paths, ["result.txt"]);
  const [queued] = cli(root, ["review-queue"]);
  assert.equal(queued.status, "clean");
  cli(root, ["review-approve", task.id], { revision: task.revision, targetHead: review.targetHead,
    summary: "Reviewed the submitted result.", evidence: task.criteria.map(() => "Verified result.txt.") });
  const done = cli(root, ["accept", task.id], { revision: task.revision, targetHead: review.targetHead });
  assert.equal(done.status, "done");
  assert.equal(done.cleanupWarning, undefined);
  assert.equal(readFileSync(join(root, "result.txt"), "utf8"), "verified result\n");
  assert.equal(existsSync(join(root, log)), false);
  assert.equal(readFileSync(join(worktree, log), "utf8"), crashpadOutput + "local verification output\n");
  assert.deepEqual(cli(root, ["cleanup-status", task.id]).entries, ["?? " + log]);
});

test("accept creates a merge commit and protects the source and ignored files", t => {
  const root = fixture(t, true);
  const initial = git(root, "rev-parse", "HEAD");
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "protected.txt"),
    "delivered\n" + "Дополнение к сдаче\n".repeat(1000)));
  const review = cli(root, ["review", task.id]);
  assert.deepEqual(review.paths, ["protected.txt"]);
  assert.match(review.diff, /\+delivered/);
  assert.equal(review.targetHead, initial);
  const compact = cli(root, ["review", task.id], { compact: true });
  assert.equal(compact.diff, undefined);
  assert.deepEqual(compact.criteria, task.criteria);
  assert.deepEqual(compact.paths, review.paths);
  assert.equal(compact.mergeBase, initial);
  assert.deepEqual(compact.targetOverlaps, []);
  const diffInput = { revision: compact.revision, targetHead: compact.targetHead, paths: compact.paths };
  const logged = cli(root, ["run-log", task.id], { entries: [{ id: "saved", type: "agentMessage", title: "",
    text: "The executor finished.", status: "completed" }] });
  assert.equal(logged.revision, compact.revision);
  assert.equal(logged.history.at(-1).action, "run-log");
  const firstPage = cli(root, ["review", task.id], diffInput);
  assert.equal(firstPage.nextOffset, 16_000);
  const secondPage = cli(root, ["review", task.id], { ...diffInput, offset: firstPage.nextOffset });
  assert.equal(firstPage.diff + secondPage.diff, review.diff);
  assert.equal(secondPage.nextOffset, undefined);
  cli(root, ["review", task.id], { ...diffInput, paths: ["*.txt"] }, "INVALID_INPUT");
  cli(root, ["review", task.id], { ...diffInput, targetHead: task.git.submission.sha }, "TARGET_CHANGED");
  cli(root, ["review", task.id], { ...diffInput, revision: compact.revision - 1 }, "REVISION_CONFLICT");
  cli(root, ["accept", task.id], undefined, "INVALID_INPUT");
  cli(root, ["accept", task.id], { revision: task.revision - 1 }, "REVISION_CONFLICT");
  cli(root, ["accept", task.id], { revision: task.revision, targetHead: task.git.submission.sha }, "TARGET_CHANGED");
  cli(root, ["settings"], { reviewMode: "reviewer" });
  const decision = { revision: task.revision, targetHead: initial, summary: "Reviewed.",
    evidence: task.criteria.map(() => "Checked the submitted change.") };
  cli(root, ["review-approve", task.id], { ...decision, revision: task.revision - 1 }, "REVISION_CONFLICT");
  cli(root, ["review-approve", task.id], { ...decision, targetHead: task.git.submission.sha }, "TARGET_CHANGED");
  writeFileSync(join(worktree, "unsubmitted.txt"), "new edit");
  git(worktree, "add", "--", "unsubmitted.txt");
  assert.equal(cli(root, ["review", task.id]).stale, true);
  cli(root, ["review-approve", task.id], decision, "STALE_SUBMISSION");
  cli(root, ["accept", task.id], { revision: task.revision }, "STALE_SUBMISSION");
  git(worktree, "reset", "--", "unsubmitted.txt");
  rmSync(join(worktree, "unsubmitted.txt"));
  const approved = cli(root, ["review-approve", task.id], decision);
  assert.equal(approved.revision, task.revision);
  assert.equal(approved.history.at(-1).reviewApproval.targetHead, initial);

  const exclude = join(root, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/protected.txt\n");
  writeFileSync(join(root, "protected.txt"), "keep this local file\n");
  assert.equal(git(root, "status", "--porcelain"), "");
  cli(root, ["accept", task.id], { revision: task.revision }, "PROTECTED_PATH_COLLISION");
  assert.equal(readFileSync(join(root, "protected.txt"), "utf8"), "keep this local file\n");
  assert.equal(git(root, "rev-parse", "HEAD"), initial);
  assert.equal(cli(root, ["show", task.id]).status, "review");
  rmSync(join(root, "protected.txt"));

  const done = cli(root, ["accept", task.id], { revision: task.revision, targetHead: review.targetHead });
  assert.equal(done.status, "done");
  assert.equal(done.git.accepted, git(root, "rev-parse", "HEAD"));
  assert.equal(done.acceptedTreeMatchesSubmission, true);
  assert.equal(git(root, "show", "-s", "--format=%P"), initial + " " + task.git.submission.sha);
  assert.equal(git(root, "show", "-s", "--format=%B"), "feat: deliver result\n\nTask: " + task.id);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.equal(git(root, "rev-parse", "HEAD^2"), task.git.submission.sha);
  const retried = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(retried.git.accepted, done.git.accepted);
  assert.equal(retried.acceptedTreeMatchesSubmission, true);
});

test("review pages can omit unchanged context without losing edits", t => {
  const root = fixture(t, true);
  const source = "before\noriginal\nafter\n";
  writeFileSync(join(root, "source.txt"), source);
  git(root, "commit", "-am", "test: add diff context");
  const { task } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), source.replace("original", "changed")));
  writeFileSync(join(root, "target-only.txt"), "Independent target edit\n");
  git(root, "add", "target-only.txt");
  git(root, "commit", "-m", "test: advance target after submission");
  const review = cli(root, ["review", task.id], { compact: true });
  assert.equal(review.merge.status, "clean");
  const input = { revision: review.revision, targetHead: review.targetHead, paths: ["source.txt"] };
  assert.match(cli(root, ["review", task.id], input).diff, /\n before\n-original\n\+changed\n after/);
  const narrow = cli(root, ["review", task.id], { ...input, contextLines: 0 });
  assert.match(narrow.diff, /\n-original\n\+changed\n/);
  assert.doesNotMatch(narrow.diff, /\n (before|after)\n/);
  assert.equal(narrow.nextOffset, undefined);
  cli(root, ["review", task.id], { ...input, contextLines: 101 }, "INVALID_INPUT");

  // Acquire the lock from a separate SQLite connection during Git inspection.
  const lockPath = join(root, ".tasks", ".lock.sqlite");
  const preload = `
    import child from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const spawnSync = child.spawnSync;
    child.spawnSync = (command, args, options) => {
      if (command === "git" && (args.includes("--literal-pathspecs") || ["merge-base", "merge-tree"].includes(args[0]))) {
        const lock = new DatabaseSync(${JSON.stringify(lockPath)});
        try { lock.exec("BEGIN IMMEDIATE"); }
        finally { lock.close(); }
        process.stderr.write((args.includes("--literal-pathspecs") ? "diff" : args[0]) + " runs outside board lock\\n");
        if (args[0] === "merge-tree" && process.env.TASKBOARD_TEST_CHANGE_DURING_REVIEW === "1") {
          const updated = spawnSync(process.execPath, ${JSON.stringify(commandArgs(root, ["comment", task.id], { text: "Changed during inspection." }))}, {
            input: '{"text":"Changed during inspection."}', encoding: "utf8", windowsHide: true,
          });
          if (updated.status !== 0) throw new Error(updated.stdout + updated.stderr);
        }
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `;
  const result = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["review", task.id], input),
  ], { env, encoding: "utf8", input: JSON.stringify(input), windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /diff runs outside board lock/);
  assert.match(JSON.parse(result.stdout).data.diff, /\+changed/);
  const summaryInput = { compact: true, includeReviewerSettings: true };
  const summary = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["review", task.id], summaryInput),
  ], { env, encoding: "utf8", input: JSON.stringify(summaryInput), windowsHide: true });
  assert.equal(summary.status, 0, summary.stdout + summary.stderr);
  assert.match(summary.stderr, /merge-base runs outside board lock/);
  assert.match(summary.stderr, /merge-tree runs outside board lock/);
  assert.deepEqual(JSON.parse(summary.stdout).data, { ...review, settings: {
    reviewMode: "reviewer", reviewer: cli(root, ["settings"]).reviewer,
  } });

  const full = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["review", task.id]),
  ], { env, encoding: "utf8", windowsHide: true });
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.match(full.stderr, /merge-base runs outside board lock/);
  assert.match(full.stderr, /merge-tree runs outside board lock/);
  const data = JSON.parse(full.stdout).data;
  assert.equal(data.revision, review.revision);
  assert.equal(data.targetHead, review.targetHead);
  assert.equal(data.merge.status, "clean");
  assert.match(data.diff, /\+changed/);

  const changed = spawnSync(process.execPath, [
    "--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["review", task.id]),
  ], { env: { ...env, TASKBOARD_TEST_CHANGE_DURING_REVIEW: "1" }, encoding: "utf8", windowsHide: true });
  assert.equal(JSON.parse(changed.stdout).error?.code, "REVISION_CONFLICT", changed.stdout + changed.stderr);
});

test("accepted task cleanup removes legacy attachments, saves QA and refuses to delete a changed branch", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const exclude = join(root, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/.codex-attachments/\n");
  const sibling = join(worktree, ".codex-attachments", "another-session");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "old.png"), "legacy attachment");
  const ignored = join(worktree, "keep.local");
  writeFileSync(ignored, "keep this file");
  mkdirSync(join(worktree, ".tasks", "qa"), { recursive: true });
  writeFileSync(join(worktree, ".tasks", "qa", "report.txt"), "keep this report");
  const done = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done");
  assert.equal(done.cleanupWarning, undefined);
  assert.equal(readFileSync(ignored, "utf8"), "keep this file");
  assert.ok(!existsSync(join(worktree, ".codex-attachments")));
  const retainedQa = cli(root, ["show", task.id]).artifacts.find((item: { source: string }) => item.source === ".tasks/qa/report.txt");
  assert.equal(readFileSync(retainedQa.file, "utf8"), "keep this report");
  assert.equal(git(root, "rev-parse", task.git.branch), task.git.submission.sha);

  git(worktree, "commit", "--allow-empty", "-m", "chore: save further work");
  const extra = git(worktree, "rev-parse", "HEAD");
  cli(root, ["cleanup", task.id], undefined, "TASK_BRANCH_CHANGED");
  assert.equal(git(worktree, "rev-parse", "HEAD"), extra);
  git(worktree, "reset", "--hard", task.git.submission.sha);
  rmSync(ignored);
  assert.equal(cli(root, ["cleanup", task.id]).branchRemoved, true);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.equal(existsSync(worktree), false);
  assert.ok(existsSync(join(root, ".tasks", "artifacts")));
  assert.equal(cli(root, ["cleanup", task.id]).removed, false);
});

test("required stage artifacts are pinned to the submitted snapshot and available in review", { timeout: 90_000 }, t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const stage = {
    key: "verify", expertId: "qa-engineer", title: "Verify the visible result",
    criteria: ["Inspect the screen and exercise the action."], outputs: ["Screen", "Scenario"],
    artifactOutputs: { Screen: "png", Scenario: "text" },
  };
  const task = cli(root, ["create"], { title: "Verify the screen", criteria: stage.criteria, expertTeam: {
    work: { lead: "qa-engineer", reason: "Verify the screen and the action from the same version.", stages: [stage] },
  } });
  cli(root, ["approve", task.id]);
  const { task: active, worktree } = cli(root, ["start", task.id]);
  const args = { revision: active.revision, key: stage.key, phase: "work", actor: "agent" };
  cli(root, ["expert-stage", task.id], { ...args, state: "running" });
  const record = { ...args, state: "done", result: "Checked", outputs: { Screen: "screen.local", Scenario: "scenario.local" } };
  cli(root, ["expert-stage", task.id], { ...record, outputs: { ...record.outputs, Screen: "../screen.png" } }, "INVALID_ARTIFACT_PATH");
  cli(root, ["expert-stage", task.id], { ...record, outputs: { ...record.outputs, Screen: "scenario.local" } }, "ARTIFACT_OUTPUT_CONFLICT");
  cli(root, ["expert-stage", task.id], record);
  writeFileSync(join(worktree, "source.txt"), "Visible change\n");
  const preview = () => cli(root, ["preview", task.id]);
  cli(root, ["preview", task.id], undefined, "ARTIFACT_NOT_FOUND");
  writeFileSync(join(worktree, "screen.local"), "Renamed text");
  cli(root, ["preview", task.id], undefined, "ARTIFACT_NOT_PNG");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  writeFileSync(join(worktree, "screen.local"), png);
  writeFileSync(join(worktree, "scenario.local"), "Action produced the expected state");
  const stale = preview();
  writeFileSync(join(worktree, "scenario.local"), "Action still passes after rechecking");
  const submission = { token: stale.token, message: "feat: change visible result", summary: "Verified UI", checks: ["Action passed"] };
  cli(root, ["submit", task.id], submission, "STALE_SNAPSHOT");
  const fresh = preview();
  writeFileSync(join(worktree, "source.txt"), "More visible changes\n");
  cli(root, ["submit", task.id], { ...submission, token: fresh.token }, "STALE_SNAPSHOT");
  const expected = preview();
  const submitted = cli(root, ["submit", task.id], { ...submission, token: expected.token });
  const review = cli(root, ["review", task.id]);
  assert.equal(review.submitted, submitted.git.submission.sha);
  assert.deepEqual(review.result.artifactEvidence, expected.artifactEvidence);
  const [screen, scenario] = review.result.artifactEvidence;
  const reply = (file: { source: string; sha256: string; kind: string }) => cli(root, ["review-artifact", task.id], {
    revision: review.revision, source: file.source, sha256: file.sha256, format: file.kind,
  });
  const image = reply(screen);
  assert.deepEqual(Buffer.from(image.pngBase64, "base64"), png);
  assert.equal(image.width, 1);
  const content = boardToolContent("task_review_artifact", { ok: true, data: image });
  assert.equal(content.pngBase64, png.toString("base64"));
  assert.equal(JSON.parse(content.text).data.pngBase64, undefined);
  assert.equal(reply(scenario).text, "Action still passes after rechecking");
  assert.equal(cli(root, ["accept", task.id], { revision: review.revision, targetHead: review.targetHead }).status, "done");
  const metrics = cli(root, ["metrics", task.id]);
  assert.ok(metrics.readyToAcceptanceMs >= 0 && metrics.readyToAcceptanceMs <= metrics.cycleMs);
  assert.equal(metrics.acceptedOnFirstSubmission, true);
});

test("confirmed findings can be reused from another card after archiving the source", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const source = cli(root, ["create"], { title: "Diagnose a Windows failure" });
  const input = { finding: {
    symptom: "Electron exits with 0x80000003", environment: "Windows with MXC",
    cause: "CreateWindowStationW returns ERROR_ACCESS_DENIED",
    verification: "Repeat the same probe inside and outside MXC.",
  } };
  cli(root, ["findings", source.id], { ...input, actor: "agent" }, "INVALID_TRANSITION");
  const saved = cli(root, ["findings", source.id], input);
  assert.equal(saved.revision, source.revision);
  assert.deepEqual(cli(root, ["findings", source.id], input), saved);
  cli(root, ["cancel", source.id], { reason: "Archive the diagnostic card" });
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  const next = cli(root, ["create"], { title: "Verify another Electron launch" });
  assert.deepEqual(cli(root, ["findings", next.id], { query: "electron  MXC", actor: "agent" }), [saved]);
  assert.deepEqual(cli(root, ["findings"], { query: "linux MXC" }), []);
});

test("artifact retention is bounded until cleanup and changed or unknown originals stay put", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const draft = cli(root, ["create"], { title: "Preserve reports", criteria: ["Report is saved."] });
  cli(root, ["approve", draft.id]);
  const started = cli(root, ["start", draft.id]);
  const { worktree } = started;
  const report = join(worktree, "report.local");
  const buildDirectory = join(worktree, "build.local");
  const packageFile = join(buildDirectory, "package.bin");
  const unknown = join(worktree, "unknown.local");
  writeFileSync(join(worktree, "result.txt"), "result\n");
  const reportText = "a".repeat(15_999) + "🙂\nПроверка пройдена";
  writeFileSync(report, reportText);
  mkdirSync(buildDirectory);
  writeFileSync(packageFile, "checked build");
  writeFileSync(unknown, "keep this");
  symlinkSync(root, join(worktree, "outside.local"), process.platform === "win32" ? "junction" : "dir");
  const preview = cli(root, ["preview", draft.id]);
  const submission = { token: preview.token, message: "feat: add result", summary: "Delivered", checks: ["Verified"] };
  const tooLarge = join(worktree, "too-large.local");
  writeFileSync(tooLarge, "");
  truncateSync(tooLarge, 64 * 1024 * 1024 + 1);
  cli(root, ["submit", draft.id], { ...submission, artifacts: ["too-large.local"] }, "ARTIFACT_LIMIT");
  assert.equal(existsSync(join(root, ".tasks", "artifacts")), false);
  rmSync(tooLarge);
  cli(root, ["submit", draft.id], { ...submission, artifacts: ["../source.txt"] }, "INVALID_ARTIFACT_PATH");
  cli(root, ["submit", draft.id], { ...submission, artifacts: ["outside.local/source.txt"] }, "INVALID_STORAGE_PATH");
  rmSync(join(worktree, "outside.local"));
  cli(root, ["submit", draft.id], { ...submission, artifacts: ["build.local/"] }, "ARTIFACT_DIRECTORY");
  const entries = Array.from({ length: 64 }, (_, index) => "extra-" + index + ".local");
  for (const name of entries) writeFileSync(join(worktree, name), "");
  cli(root, ["submit", draft.id], { ...submission, artifacts: [...entries, "report.local"] }, "ARTIFACT_LIMIT");
  assert.equal(existsSync(join(root, ".tasks", "artifacts")), false);
  for (const name of entries) rmSync(join(worktree, name));
  const submitted = cli(root, ["submit", draft.id], { ...submission, artifacts: ["report.local", "build.local/package.bin"] });
  assert.equal(existsSync(report), true);
  const reviewing = cli(root, ["show", draft.id]);
  assert.equal(reviewing.artifacts.length, 2);
  const savedReport = reviewing.artifacts.find((artifact: { source: string }) => artifact.source === "report.local");
  assert.equal(readFileSync(savedReport.file, "utf8"), reportText);
  const material = { revision: submitted.revision, source: savedReport.source, sha256: savedReport.sha256 };
  const preload = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const { openSync, readSync } = fs;
    const lockPath = ${JSON.stringify(join(root, ".tasks", ".lock.sqlite"))};
    let descriptor;
    fs.openSync = (path, ...args) => {
      const opened = openSync(path, ...args);
      if (path === ${JSON.stringify(savedReport.file)}) {
        descriptor = opened;
        const lock = new DatabaseSync(lockPath);
        try { assert.throws(() => lock.exec("BEGIN IMMEDIATE"), /locked/); }
        finally { lock.close(); }
      }
      return opened;
    };
    fs.readSync = (fd, ...args) => {
      if (fd === descriptor) {
        const lock = new DatabaseSync(lockPath);
        try { lock.exec("BEGIN IMMEDIATE"); }
        finally { lock.close(); }
        process.stderr.write("Read artifact outside board lock\\n");
      }
      return readSync(fd, ...args);
    };
    syncBuiltinESMExports();
  `;
  const read = spawnSync(process.execPath, ["--import=data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    ...commandArgs(root, ["review-artifact", draft.id], material)],
  { env, encoding: "utf8", input: JSON.stringify(material), windowsHide: true });
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.match(read.stderr, /Read artifact outside board lock/);
  const first = JSON.parse(read.stdout).data;
  assert.equal(first.nextOffset, 15_999);
  const last = cli(root, ["review-artifact", draft.id], { ...material, offset: first.nextOffset });
  assert.equal(first.text + last.text, reportText);
  assert.equal(last.nextOffset, undefined);
  cli(root, ["review-artifact", draft.id], { ...material, offset: 16_000 }, "INVALID_INPUT");
  cli(root, ["review-artifact", draft.id], { ...material, source: "../source.txt" }, "ARTIFACT_NOT_FOUND");
  cli(root, ["review-artifact", draft.id], { ...material, revision: submitted.revision - 1 }, "REVISION_CONFLICT");
  writeFileSync(savedReport.file, "tampered");
  cli(root, ["review-artifact", draft.id], material, "ARTIFACT_CHANGED");
  writeFileSync(savedReport.file, reportText);
  writeFileSync(packageFile, "new build");
  const accepted = cli(root, ["accept", draft.id], { revision: submitted.revision });
  assert.equal(accepted.status, "done");
  assert.equal(accepted.cleanupWarning, undefined);
  assert.equal(existsSync(savedReport.file), true);
  assert.equal(existsSync(report), false);
  assert.equal(readFileSync(packageFile, "utf8"), "new build");
  assert.equal(readFileSync(unknown, "utf8"), "keep this");
  const status = cli(root, ["cleanup-status", draft.id]);
  assert.equal(status.pending, true);
  assert.equal(status.reason, "DIRTY_WORKTREE");
  assert.deepEqual(status.entries, ["!! build.local/", "!! unknown.local"]);
  cli(root, ["cleanup", draft.id], { artifacts: ["report.local", "removed.local/report.txt", "build.local/package.bin"] }, "DIRTY_WORKTREE");
  assert.equal(existsSync(packageFile), false);
  assert.equal(readFileSync(unknown, "utf8"), "keep this");
  const cleaned = cli(root, ["cleanup", draft.id], { artifacts: ["unknown.local"] });
  assert.equal(cleaned.branchRemoved, true);
  assert.equal(existsSync(worktree), false);
  assert.equal(cli(root, ["cleanup-status", draft.id]).pending, false);
  const final = cli(root, ["show", draft.id]);
  assert.equal(final.status, "done");
  assert.ok(final.artifacts.length >= 3);
  assert.deepEqual(final.result.checks, []);
  assert.equal(existsSync(savedReport.file), true);
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  assert.equal(cli(root, ["list"], undefined).archived.some((task: { id: string }) => task.id === draft.id), true);
  assert.deepEqual(cli(root, ["show", draft.id]).artifacts, final.artifacts);
});

test("accept discards Crashpad and temporary worktree attachments and preserves the project diary and task attachments", t => {
  const root = fixture(t, true);
  const exclude = join(root, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/.dev-diary/\n/.codex-attachments/\n");
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  writeFileSync(join(worktree, "debug.log"), crashpadOutput + crashpadOutput);
  const diary = join(".dev-diary", "2026", "11");
  const qa = join(".tasks", "qa");
  const projectDiary = join(root, diary, "2026-11-12.md");
  mkdirSync(dirname(projectDiary), { recursive: true });
  writeFileSync(projectDiary, "Project diary\n");
  mkdirSync(join(worktree, diary), { recursive: true });
  mkdirSync(join(worktree, qa), { recursive: true });
  writeFileSync(join(worktree, diary, "2026-11-12.md"), "# Codex Worklog — 2026-11-12\n\n## 2026-11-12 19:48 +03:00 — Task diary\n\n<!-- codex-worklog-entry:aaaaaaaaaaaaaaaaaaaaaaaa -->\n");
  writeFileSync(join(worktree, qa, "check.log"), "Temporary check output\n");
  const stagedAttachments = join(worktree, ".codex-attachments", task.id);
  mkdirSync(stagedAttachments, { recursive: true });
  writeFileSync(join(stagedAttachments, "startup-error.txt"), "Earlier startup failure\n");
  const report = join(stagedAttachments, "results.bin");
  const bytes = Buffer.from([0, 255, 128]);
  writeFileSync(report, bytes);
  if (process.platform === "win32") chmodSync(report, 0o444);
  symlinkSync(dirname(projectDiary), join(worktree, qa, "linked-diary"), process.platform === "win32" ? "junction" : "dir");
  const attached = cli(root, ["chat", task.id], {
    text: "Keep the QA result.", model: "fixture-model", effort: "medium", attachmentSources: [{ path: report }],
  });

  const done = cli(root, ["accept", task.id], { revision: attached.revision });
  assert.equal(done.status, "done");
  assert.equal(done.cleanupWarning, undefined);
  assert.equal(existsSync(worktree), false, existsSync(join(root, ".tasks", "maintenance.json")) ? readFileSync(join(root, ".tasks", "maintenance.json"), "utf8") : "");
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.ok(existsSync(join(root, ".tasks", "artifacts")));
  assert.equal(readFileSync(projectDiary, "utf8"), "Project diary\n");
  assert.match(readFileSync(join(root, ".tasks", "worklog", "2026", "11", "2026-11-12.md"), "utf8"), /Task diary/);
  const file = done.attachments[0].file;
  assert.equal(cli(root, ["attachment", "read", task.id], { file }).base64, bytes.toString("base64"));
});

test("Windows cleanup recovers a worktree left unregistered by a directory lock", {
  skip: process.platform !== "win32",
  timeout: 90_000,
}, async t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const holder = spawn(process.execPath, ["-e", "console.log('ready'); process.stdin.resume()"], {
    cwd: worktree, windowsHide: true,
  });
  const closed = once(holder, "close");
  try {
    await once(holder.stdout, "data");
    const done = cli(root, ["accept", task.id], { revision: task.revision });
    assert.equal(done.status, "done");
    assert.equal(done.cleanupWarning, undefined);
    assert.equal(existsSync(worktree), true);
    assert.ok(!git(root, "worktree", "list", "--porcelain").includes(task.git.branch));
    assert.equal(cli(root, ["show", task.id]).cleanupAvailable, true);
    cli(root, ["cleanup", task.id], undefined, "WORKTREE_ACCESS_DENIED");
    assert.equal(git(root, "rev-parse", task.git.branch), task.git.submission.sha);
  } finally {
    holder.stdin.end();
    await closed;
  }

  const local = join(worktree, "keep.local");
  writeFileSync(local, "local data");
  cli(root, ["cleanup", task.id], undefined, "DIRTY_WORKTREE");
  assert.equal(readFileSync(local, "utf8"), "local data");
  assert.equal(git(root, "rev-parse", task.git.branch), task.git.submission.sha);
  const watcher = spawn(process.execPath, commandArgs(root, ["watch"]), {
    env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const watcherClosed = once(watcher, "close");
  const reader = createInterface({ input: watcher.stdout });
  const lines = reader[Symbol.asyncIterator]();
  const nextFrame = async () => {
    const { value } = await lines.next();
    assert.equal(typeof value, "string", "watch exited before sending a snapshot");
    return JSON.parse(value!);
  };
  t.signal.addEventListener("abort", () => watcher.kill(), { once: true });
  try {
    const initial = await nextFrame();
    assert.equal(initial.ok, true);
    assert.deepEqual(initial.data.cleanedTasks, []);
    assert.equal(readFileSync(local, "utf8"), "local data");
    rmSync(local);
    const updated = await nextFrame();
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.data.cleanedTasks, [task.id]);
  } finally {
    reader.close();
    watcher.kill();
    await watcherClosed;
  }
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.equal(cli(root, ["show", task.id]).cleanupAvailable, false);
});

test("Windows can accept and clean up while the host process runs in the board root", {
  skip: process.platform !== "win32",
}, async t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const holder = spawn(process.execPath, ["-e", "console.log('ready'); process.stdin.resume()"], {
    cwd: root, windowsHide: true,
  });
  const closed = once(holder, "close");
  try {
    await once(holder.stdout, "data");
    const done = cli(root, ["accept", task.id], { revision: task.revision });
    assert.equal(done.status, "done");
    assert.equal(done.cleanupWarning, undefined);
    assert.equal(existsSync(worktree), false);
    assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  } finally {
    holder.stdin.end();
    await closed;
  }
});

test("accept saves confirmed local edits and restores them in the target", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  cli(root, ["settings"], { integrationMode: "squash" });
  writeFileSync(join(root, "source.txt"), "staged\n");
  git(root, "add", "source.txt");
  writeFileSync(join(root, "source.txt"), "working\n");
  writeFileSync(join(root, "new file.txt"), "untracked\n");
  writeFileSync(join(root, "secret.local"), "ignored\n");
  const first = cli(root, ["review", task.id]);
  assert.deepEqual(first.localChanges.paths, ["source.txt", "new file.txt"]);
  assert.deepEqual(first.localChanges.overlaps, []);
  writeFileSync(join(root, "additional.txt"), "appeared after review\n");
  const input = { revision: task.revision, targetHead: first.targetHead, saveLocalChanges: first.localChanges.token };
  cli(root, ["accept", task.id], input, "LOCAL_CHANGES_CHANGED");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "working\n");
  assert.equal(readFileSync(join(root, "additional.txt"), "utf8"), "appeared after review\n");
  const review = cli(root, ["review", task.id]);
  const done = cli(root, ["accept", task.id], { ...input, saveLocalChanges: review.localChanges.token });
  assert.equal(done.status, "done");
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(root, "secret.local"), "utf8"), "ignored\n");
  const ref = git(root, "for-each-ref", "--format=%(refname)", "refs/ai-taskboard/saved/" + task.id);
  const sha = git(root, "rev-parse", ref);
  assert.equal(cli(root, ["show", task.id]).savedChanges.sha, sha);
  git(root, "stash", "drop");
  const restored = cli(root, ["restore-changes", task.id], { revision: done.revision, destination: "target" });
  assert.equal(restored.destination, "target");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "working\n");
  assert.equal(git(root, "show", ":source.txt"), "staged");
  assert.equal(readFileSync(join(root, "new file.txt"), "utf8"), "untracked\n");
  assert.equal(readFileSync(join(root, "additional.txt"), "utf8"), "appeared after review\n");
  assert.equal(git(root, "show", "HEAD:source.txt"), "baseline");
  assert.equal(git(root, "rev-parse", ref), sha);
  assert.deepEqual(cli(root, ["restore-changes", task.id], { revision: done.revision, destination: "target" }), restored);
});

test("restore checks conflicts away from the target and can recover in a separate worktree", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "task change\n"));
  writeFileSync(join(root, "source.txt"), "local change\n");
  writeFileSync(join(root, "new.txt"), "keep me\n");
  const review = cli(root, ["review", task.id]);
  assert.deepEqual(review.localChanges.overlaps, ["source.txt"]);
  const done = cli(root, ["accept", task.id], {
    revision: task.revision, targetHead: review.targetHead, saveLocalChanges: review.localChanges.token,
  });
  assert.equal(done.status, "done");
  const target = { revision: done.revision, destination: "target" };
  const error = cli(root, ["restore-changes", task.id], target, "RESTORE_CONFLICT");
  assert.deepEqual(error.details.paths, ["source.txt"]);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(git(root, "rev-parse", "HEAD"), done.git.accepted);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8").trim(), "task change");
  assert.ok(!existsSync(join(root, "new.txt")));
  assert.doesNotMatch(git(root, "worktree", "list", "--porcelain"), /\.restore-check-/);
  const recovery = cli(root, ["restore-changes", task.id], { ...target, destination: "worktree" });
  assert.equal(git(recovery.path, "rev-parse", "HEAD"), review.targetHead);
  assert.equal(readFileSync(join(recovery.path, "source.txt"), "utf8"), "local change\n");
  assert.equal(readFileSync(join(recovery.path, "new.txt"), "utf8"), "keep me\n");
  assert.deepEqual(cli(root, ["show", task.id]).savedChanges.restored, recovery);
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a failed acceptance keeps the saved edits recoverable", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  writeFileSync(join(root, "source.txt"), "local changes\n");
  const review = cli(root, ["review", task.id]);
  const hooks = join(root, ".git", "hooks");
  writeFileSync(join(hooks, "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  cli(root, ["accept", task.id], {
    revision: task.revision, targetHead: review.targetHead, saveLocalChanges: review.localChanges.token,
  }, "GIT_FAILED");
  assert.equal(git(root, "rev-parse", "HEAD"), review.targetHead);
  const pending = cli(root, ["show", task.id]);
  assert.equal(pending.status, "review");
  const ref = git(root, "for-each-ref", "--format=%(refname)", "refs/ai-taskboard/saved/" + task.id);
  assert.equal(pending.savedChanges.sha, git(root, "rev-parse", ref));
  git(root, "update-ref", "-d", ref);
  assert.equal(cli(root, ["show", task.id]).savedChanges.sha, pending.savedChanges.sha);
  const restored = cli(root, ["restore-changes", task.id], { revision: task.revision, destination: "worktree" });
  assert.equal(readFileSync(join(restored.path, "source.txt"), "utf8"), "local changes\n");
});

test("ordinary acceptance leaves disjoint edits and new files in place", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  cli(root, ["settings"], { integrationMode: "squash" });
  writeFileSync(join(root, "source.txt"), "local\n");
  writeFileSync(join(root, "launch.json"), "untracked\n");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  cli(root, ["accept", task.id], { revision: task.revision }, "GIT_FAILED");
  rmSync(hook);
  const done = cli(root, ["accept", task.id]);
  assert.equal(done.status, "done");
  assert.equal(git(root, "show", "HEAD:result.txt"), "delivered");
  assert.equal(git(root, "show", "HEAD:source.txt"), "baseline");
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "local\n");
  assert.equal(readFileSync(join(root, "launch.json"), "utf8"), "untracked\n");
  assert.equal(git(root, "stash", "list"), "");
});

test("ordinary acceptance reapplies compatible edits including the index", t => {
  const root = fixture(t, true);
  const original = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const write = (path: string, lines: string[]) => writeFileSync(join(path, "source.txt"), lines.join("\n") + "\n");
  write(root, original);
  git(root, "add", "source.txt");
  git(root, "commit", "-m", "chore: extend fixture");
  const delivered = ["task change", ...original.slice(1)];
  const { task } = submitFixture(root, path => write(path, delivered));
  const staged = [...original.slice(0, -1), "staged local change"];
  write(root, staged);
  git(root, "add", "source.txt");
  write(root, [...staged, "unstaged local change"]);
  writeFileSync(join(root, "launch.json"), "untracked\n");
  const done = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done");
  assert.equal(done.localChangesWarning, undefined);
  assert.equal(git(root, "show", "HEAD:source.txt"), delivered.join("\n"));
  const restoredIndex = [delivered[0], ...staged.slice(1)];
  assert.equal(git(root, "show", ":source.txt"), restoredIndex.join("\n"));
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), [...restoredIndex, "unstaged local change"].join("\n") + "\n");
  assert.equal(readFileSync(join(root, "launch.json"), "utf8"), "untracked\n");
  assert.equal(cli(root, ["show", task.id]).savedChanges.restored.destination, "target");
});

test("ordinary acceptance reports local conflicts before changing the target", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => {
    writeFileSync(join(path, "source.txt"), "task change\n");
    writeFileSync(join(path, "new.txt"), "task file\n");
  });
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "source.txt"), "local change\n");
  const input = { revision: task.revision };
  const conflict = cli(root, ["accept", task.id], input, "LOCAL_CHANGES_CONFLICT");
  assert.deepEqual(conflict.details.paths, ["source.txt"]);
  writeFileSync(join(root, "new.txt"), "untracked\n");
  const collision = cli(root, ["accept", task.id], input, "LOCAL_CHANGES_CONFLICT");
  assert.deepEqual(collision.details.paths, ["new.txt"]);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "local change\n");
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "untracked\n");
  assert.equal(git(root, "stash", "list"), "");
  assert.equal(cli(root, ["show", task.id]).status, "review");
});

test("squash accepts into a local branch that was not checked out", t => {
  const root = fixture(t, true);
  const initial = git(root, "rev-parse", "HEAD");
  git(root, "branch", "release");
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"), "release");
  cli(root, ["settings"], { integrationMode: "squash" });
  const done = cli(root, ["accept", task.id], {
    revision: task.revision, message: "feat: release the result",
  });
  assert.equal(done.status, "done");
  assert.equal(git(root, "rev-parse", "HEAD"), initial);
  assert.equal(git(root, "rev-parse", "release"), done.git.accepted);
  assert.equal(git(root, "show", "-s", "--format=%P", "release"), initial);
  assert.equal(git(root, "show", "-s", "--format=%B", "release"), "feat: release the result\n\nTask: " + task.id);
  assert.equal(git(root, "show", "release:result.txt"), "delivered");
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  const ref = "refs/ai-taskboard/submissions/" + task.id + "/" + task.git.submission.sha;
  assert.equal(git(root, "rev-parse", ref), task.git.submission.sha);
  git(root, "switch", "release");
  assert.equal(git(root, "rev-parse", "HEAD"), done.git.accepted);
});

test("accept preserves local files created in the temporary target checkout", t => {
  const root = fixture(t, true);
  git(root, "branch", "release");
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"), "release");
  cli(root, ["settings"], { integrationMode: "squash" });
  writeFileSync(join(root, ".git", "hooks", "post-commit"), "#!/bin/sh\nprintf 'keep me' > notes.local\n", { mode: 0o755 });
  assert.equal(cli(root, ["accept", task.id], { revision: task.revision }).status, "done");
  const target = join(root, ".worktrees", ".accept-" + task.id);
  assert.equal(readFileSync(join(target, "notes.local"), "utf8"), "keep me");
  assert.equal(git(target, "branch", "--show-current"), "release");
});

test("submission checks for conflicts against changes accepted after preview", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Edit source", criteria: ["Source is updated."] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  const source = join(worktree, "source.txt");
  writeFileSync(source, "task version\n");
  const preview = cli(worktree, ["preview", task.id]);
  writeFileSync(join(root, "source.txt"), "target version\n");
  git(root, "commit", "-am", "fix: edit target independently");
  const targetHead = git(root, "rev-parse", "HEAD");
  const input = { token: preview.token, message: "fix: update source", summary: "Updated", checks: [] };
  const conflict = cli(worktree, ["submit", task.id], input, "MERGE_CONFLICT");
  assert.deepEqual(conflict.details, { paths: ["source.txt"], targetHead });
  assert.deepEqual(cli(worktree, ["preview", task.id], undefined, "MERGE_CONFLICT").details, conflict.details);
  assert.equal(cli(root, ["show", task.id]).status, "in_progress");
  assert.equal(git(worktree, "rev-parse", "HEAD"), preview.head);
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(readFileSync(source, "utf8"), "task version\n");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("accept reports conflicts and an agent can reopen and resubmit the task", t => {
  const root = fixture(t, true);
  const base = git(root, "rev-parse", "HEAD");
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "task version\n"));
  const resolve = { revision: task.revision, resolveConflicts: true };
  cli(root, ["start", task.id], resolve, "NO_MERGE_CONFLICT");
  writeFileSync(join(root, "target-only.txt"), "target-only version\n");
  git(root, "add", "target-only.txt");
  git(root, "commit", "-m", "fix: add a separate target file");
  const cleanObjects = git(root, "count-objects", "-v");
  assert.deepEqual(cli(root, ["review", task.id]).merge, { status: "clean" });
  assert.equal(git(root, "count-objects", "-v"), cleanObjects);

  writeFileSync(join(root, "source.txt"), "target version\n");
  git(root, "commit", "-am", "fix: edit target independently");
  const head = git(root, "rev-parse", "HEAD");
  const objects = git(root, "count-objects", "-v");
  const review = cli(root, ["review", task.id], { compact: true });
  assert.equal(review.targetHead, head);
  assert.equal(review.mergeBase, base);
  assert.deepEqual(review.targetOverlaps, ["source.txt"]);
  assert.deepEqual(review.merge, { status: "conflict", paths: ["source.txt"] });
  assert.deepEqual(cli(root, ["review", task.id]).merge, review.merge);
  const [queued] = cli(root, ["review-queue"]);
  assert.deepEqual(queued, {
    id: task.id, title: task.title, revision: task.revision, target: "refs/heads/main", targetHead: head,
    submittedAt: task.history.findLast((event: { action: string }) => event.action === "submit").at,
    summary: task.result.summary, ...review.merge,
  });
  assert.equal(git(root, "count-objects", "-v"), objects);
  git(root, "config", "merge.custom.driver", "exit 1");
  assert.deepEqual(cli(root, ["review", task.id], { compact: true }).merge, { status: "unchecked" });
  git(root, "config", "--unset", "merge.custom.driver");
  const conflict = cli(root, ["accept", task.id], { revision: task.revision }, "MERGE_CONFLICT");
  assert.deepEqual(conflict.details, { paths: ["source.txt"], targetHead: head });
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(cli(root, ["show", task.id]).status, "review");

  const reopened = cli(root, ["start", task.id], resolve);
  assert.equal(reopened.worktree, worktree);
  assert.equal(reopened.task.status, "in_progress");
  assert.equal(reopened.task.history.at(-1).actor, "agent");
  assert.equal(reopened.targetHead, head);
  assert.equal(git(worktree, "rev-parse", "HEAD"), task.git.submission.sha);
  assert.throws(() => git(worktree, "rebase", reopened.targetHead));
  writeFileSync(join(worktree, "source.txt"), "target version\ntask version\n");
  git(worktree, "add", "source.txt");
  git(worktree, "-c", "core.editor=true", "rebase", "--continue");
  const preview = cli(worktree, ["preview", task.id]);
  const resubmitted = cli(worktree, ["submit", task.id], {
    revision: reopened.task.revision, token: preview.token, message: preview.commitMessage, summary: "Combined", checks: [],
  });
  assert.notEqual(resubmitted.git.submission.sha, task.git.submission.sha);
  assert.equal(resubmitted.status, "review");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  cli(root, ["accept", task.id], { revision: resubmitted.revision, targetHead: head });
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "target version\ntask version\n");
  assert.deepEqual(cli(root, ["review-queue"]), []);
});

test("accept retries a prepared squash with a staged rename after a hook refusal", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => {
    const original = join(path, "source.txt");
    writeFileSync(join(path, "renamed.txt"), readFileSync(original));
    rmSync(original);
  });
  cli(root, ["settings"], { integrationMode: "squash" });
  const head = git(root, "rev-parse", "HEAD");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  cli(root, ["accept", task.id], { revision: task.revision }, "GIT_FAILED");
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  assert.match(git(root, "status", "--porcelain=v2", "--renames"), /^2 R\. /m);
  assert.equal(cli(root, ["show", task.id]).status, "review");

  rmSync(hook);
  writeFileSync(join(root, "renamed.txt"), "unsaved follow-up\n");
  cli(root, ["accept", task.id], undefined, "DIRTY_TARGET");
  assert.equal(readFileSync(join(root, "renamed.txt"), "utf8"), "unsaved follow-up\n");
  git(root, "restore", "--", "renamed.txt");
  const done = cli(root, ["accept", task.id]);
  assert.equal(done.status, "done");
  assert.equal(git(root, "rev-parse", "HEAD"), done.git.accepted);
  assert.equal(git(root, "show", "-s", "--format=%P"), head);
  assert.match(git(root, "show", "-s", "--format=%B"), /Task: T-0001$/);
});

test("external acceptance requires the selected commit to integrate the task", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  git(root, "merge", "--ff-only", task.git.submission.sha);
  git(root, "commit", "--allow-empty", "-m", task.git.submission.message);
  const head = git(root, "rev-parse", "HEAD");
  cli(root, ["accept", task.id], { revision: task.revision, commit: head }, "ACCEPTANCE_MISMATCH");
  assert.equal(cli(root, ["show", task.id]).status, "review");
  assert.equal(git(root, "rev-parse", "HEAD"), head);

  git(root, "reset", "--hard", task.git.base);
  writeFileSync(join(root, "target-only.txt"), "Independent target edit\n");
  git(root, "add", "target-only.txt");
  git(root, "commit", "-m", "test: advance target before the external squash");
  git(root, "merge", "--squash", task.git.submission.sha);
  git(root, "commit", "-m", task.git.submission.message);
  const squash = git(root, "rev-parse", "HEAD");
  const accepted = cli(root, ["accept", task.id], { revision: task.revision, commit: squash });
  assert.equal(accepted.status, "done");
  assert.equal(accepted.git.accepted, squash);
  assert.equal(accepted.acceptedTreeMatchesSubmission, false);
  assert.equal(cli(root, ["show", task.id, "--compact"]).acceptedTreeMatchesSubmission, false);
});

test("accept recovers an interrupted merge even after the target advanced", t => {
  const root = fixture(t, true);
  const { task } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const parent = git(root, "rev-parse", "HEAD");
  const submitted = task.git.submission.sha;
  const message = task.git.submission.message;
  const tree = git(root, "merge-tree", "--write-tree", "--no-messages", parent, submitted);
  const pending = join(root, ".tasks", "pending", task.id + ".json");
  writeFileSync(pending, JSON.stringify({
    action: "accept", revision: task.revision, target: "refs/heads/main", parent, submitted, tree, mode: "merge", message,
  }));
  git(root, "merge", "--no-ff", "-m", message, submitted);
  const accepted = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "target-only.txt"), "A later target change\n");
  git(root, "add", "target-only.txt");
  git(root, "commit", "-m", "chore: advance target");
  const advanced = git(root, "rev-parse", "HEAD");
  const recovered = cli(root, ["accept", task.id]);
  assert.equal(recovered.status, "done");
  assert.equal(recovered.git.accepted, accepted);
  assert.equal(cli(root, ["show", task.id, "--compact"]).acceptedTreeMatchesSubmission, true);
  assert.equal(git(root, "rev-parse", "HEAD"), advanced);
  assert.ok(!existsSync(pending));
});

test("sweep archives only due tasks and reads gzip and ZIP by their original IDs", t => {
  const root = fixture(t);
  const inputFile = join(root, "attachment.bin");
  const bytes = Buffer.from([0, 1, 2, 128, 255]);
  writeFileSync(inputFile, bytes);
  cli(root, ["init"]);
  const plain = cli(root, ["create"], { title: "Text only" });
  const zipped = cli(root, ["create"], { title: "With attachment" });
  const attached = cli(root, ["attachment", "add", zipped.id], { path: inputFile, revision: zipped.revision });
  const attachment = attached.attachments[0];
  assert.equal(attachment.name, "attachment.bin");
  assert.equal(attachment.bytes, bytes.length);
  assert.equal(cli(root, ["attachment", "read", zipped.id], { file: attachment.file }).base64, bytes.toString("base64"));
  cli(root, ["cancel", plain.id], { reason: "Complete archive fixture" });
  cli(root, ["cancel", zipped.id], { reason: "Complete archive fixture" });
  const active = cli(root, ["create"], { title: "Still active" });
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, []);
  cli(root, ["settings"], { archiveAfterDays: null });
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, []);
  cli(root, ["settings"], { archiveAfterDays: 0 });
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, [plain.id, zipped.id]);
  assert.deepEqual(cli(root, ["list"]).tasks.map((entry: { id: string }) => entry.id), [active.id]);
  assert.deepEqual(cli(root, ["list", "--archived"]).archived.map((entry: { path: string }) => entry.path), [
    "archive/" + plain.id + ".json.gz", "archive/" + zipped.id + ".zip",
  ]);
  assert.equal(cli(root, ["show", plain.id]).title, plain.title);
  assert.equal(cli(root, ["show", zipped.id]).history.at(-1).action, "cancel");
  const archived = cli(root, ["show", zipped.id]);
  assert.equal(cli(root, ["list", "--archived"]).archived.find((entry: { id: string }) => entry.id === zipped.id).updatedAt, archived.updatedAt);
  const gzip = cli(root, ["show", plain.id]);
  const zipPath = join(root, ".tasks", "archive", zipped.id + ".zip");
  const originalZip = readFileSync(zipPath);
  const edited = cli(root, ["update", zipped.id], {
    tags: ["Проверено"], revision: archived.revision, actor: "manager", note: "Classify the task",
  });
  assert.equal(edited.status, "cancelled");
  assert.equal(edited.closedAt, archived.closedAt);
  assert.equal(edited.revision, archived.revision + 1);
  assert.deepEqual(edited.history.slice(0, -1), archived.history);
  assert.equal(edited.history.at(-1).actor, "manager");
  assert.equal(edited.history.at(-1).text, "Classify the task");
  assert.deepEqual(cli(root, ["show", zipped.id]).tags, ["Проверено"]);
  assert.equal(cli(root, ["show", zipped.id]).revision, edited.revision);
  assert.deepEqual(cli(root, ["list", "--archived", "--tag", "проверено"]).archived.map((entry: { id: string }) => entry.id), [zipped.id]);
  assert.equal(cli(root, ["list", "--archived", "--tag", "проверено"]).archived[0].updatedAt, edited.updatedAt);
  cli(root, ["tag", "assign", zipped.id], { tags: [], revision: archived.revision }, "REVISION_CONFLICT");
  cli(root, ["tag", "assign", zipped.id], { tags: [], revision: edited.revision });
  assert.deepEqual(cli(root, ["show", zipped.id]).tags, []);
  assert.deepEqual(cli(root, ["list", "--archived", "--tag", "проверено"]).archived, []);
  cli(root, ["tag", "assign", plain.id], { tags: ["Обычный архив"], revision: gzip.revision });
  assert.deepEqual(cli(root, ["show", plain.id]).tags, ["Обычный архив"]);
  assert.deepEqual(readFileSync(zipPath), originalZip);
  assert.ok(!existsSync(join(root, ".tasks", "tasks", plain.id + ".json")));
  assert.ok(!existsSync(join(root, ".tasks", "attachments", zipped.id)));
  const destination = join(root, "restored.bin");
  assert.equal(cli(root, ["attachment", "read", zipped.id], { file: attachment.file, destination }).path, destination);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(cli(root, ["create"], { title: "Next" }).id, "T-0004");
});

test("doctor recovers archive cleanup after an index switch and preserves changed originals", t => {
  const root = fixture(t);
  cli(root, ["init"]);
  cli(root, ["settings"], { archiveAfterDays: 0 });
  const task = cli(root, ["create"], { title: "Recover archive" });
  const inputFile = join(root, "reference.txt");
  const data = "Read me\n";
  writeFileSync(inputFile, data);
  const attached = cli(root, ["attachment", "add", task.id], { path: inputFile });
  const attachment = attached.attachments[0];
  cli(root, ["cancel", task.id], { reason: "Test recovery" });
  const card = join(root, ".tasks", "tasks", task.id + ".json");
  const original = readFileSync(card);
  const folder = join(root, ".tasks", "attachments", task.id);
  assert.deepEqual(cli(root, ["archive", "sweep"]).archived, [task.id]);
  writeFileSync(card, original);
  mkdirSync(folder);
  const local = join(folder, attachment.file);
  writeFileSync(local, "Local edit\n");
  const blocked = cli(root, ["doctor"], { repair: true });
  assert.deepEqual(blocked.cleanedArchives, []);
  assert.ok(blocked.issues.some((issue: { id: string }) => issue.id === task.id));
  assert.equal(readFileSync(local, "utf8"), "Local edit\n");
  assert.ok(existsSync(card));
  writeFileSync(local, data);
  const repaired = cli(root, ["doctor"], { repair: true });
  assert.deepEqual(repaired.cleanedArchives, [task.id]);
  assert.deepEqual(repaired.issues, []);
  assert.ok(!existsSync(card));
  assert.ok(!existsSync(folder));
  assert.equal(cli(root, ["show", task.id]).status, "cancelled");
});


test("user acceptance repairs remain review and continue only after checked submission", t => {
  for (const outcome of ["accept", "cancel", "advance", "fail", "return-queued", "return-running"]) {
    const root = fixture(t, true);
    const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "task version\n"));
    cli(root, ["settings"], { autoMode: false, reviewMode: "human", reviewer: { provider: "codex", model: "review-model", effort: "high" } });
    writeFileSync(join(root, "source.txt"), "target version\n");
    git(root, "commit", "-am", "fix: update target");
    const head = git(root, "rev-parse", "HEAD");
    const input = { actor: "user", revision: task.revision, targetHead: head, message: "fix: integrate checked result" };
    const queued = cli(root, ["accept", task.id], input);
    assert.equal(queued.status, "review"); assert.equal(queued.acceptanceRepair.phase, "queued");
    const repeated = cli(root, ["accept", task.id], { ...input, revision: queued.revision });
    assert.equal(repeated.revision, queued.revision);
    const returnRepair = (current: Task) => {
      writeFileSync(join(worktree, "uncommitted.txt"), "Do not discard");
      const branchHead = git(worktree, "rev-parse", "HEAD");
      const draft = cli(root, ["return-to-draft", task.id], { revision: current.revision });
      assert.equal(draft.status, "draft");
      assert.equal(draft.acceptanceRepair, undefined);
      assert.deepEqual(draft.result, current.result);
      assert.equal(git(worktree, "rev-parse", "HEAD"), branchHead);
      assert.equal(readFileSync(join(worktree, "uncommitted.txt"), "utf8"), "Do not discard");
      cli(root, ["accept", task.id], { ...input, continueRepair: true, revision: draft.revision }, "REPAIR_CANCELLED");
      assert.equal(git(root, "rev-parse", "HEAD"), head);
    };
    if (outcome === "return-queued") { returnRepair(queued); continue; }
    const run = cli(root, ["start", task.id, "--compact"], { revision: queued.revision, resolveConflicts: true, launchDetails: true });
    assert.equal(run.worktree, worktree); assert.equal(run.task.status, "review");
    assert.equal(run.task.execution.model, "review-model");
    const running = cli(root, ["show", task.id]);
    if (outcome === "return-running") { returnRepair(running); continue; }
    cli(root, ["start", task.id], { revision: running.revision, resolveConflicts: true }, "REPAIR_UNFINISHED");
    if (outcome === "fail") {
      const failed = cli(root, ["block", task.id], { reason: "Required check failed", condition: "Fix check" });
      assert.equal(failed.status, "review");
      assert.equal(cli(root, ["show", task.id]).acceptanceRepair.phase, "failed");
      assert.ok(cli(root, ["manager-inbox"]).some((item: any) => item.kind === "question"));
      continue;
    }
    assert.throws(() => git(worktree, "merge", "--no-edit", head));
    writeFileSync(join(worktree, "source.txt"), "combined\n");
    git(worktree, "add", "source.txt"); git(worktree, "commit", "-m", "fix: combine versions\n\nTask: " + task.id);
    const preview = cli(root, ["preview", task.id]);
    const submit = { token: preview.token, message: preview.commitMessage, summary: "Combined", checks: ["Required checks passed"] };
    cli(root, ["submit", task.id], { ...submit, limitations: ["Failed test"] }, "CHECKS_REQUIRED");
    const checked = cli(root, ["submit", task.id], submit);
    const current = cli(root, ["show", task.id]);
    assert.equal(current.status, "review"); assert.equal(current.acceptanceRepair.phase, "checking");
    if (outcome === "cancel") {
      const cancelled = cli(root, ["accept", task.id], { actor: "user", revision: checked.revision, cancelRepair: true });
      cli(root, ["accept", task.id], { actor: "user", revision: cancelled.revision, continueRepair: true, targetHead: head }, "REPAIR_CANCELLED");
      assert.equal(cli(root, ["show", task.id]).status, "review");
    } else if (outcome === "advance") {
      writeFileSync(join(root, "other.txt"), "new target\n"); git(root, "add", "other.txt"); git(root, "commit", "-m", "fix: advance target");
      const next = cli(root, ["accept", task.id], { actor: "user", revision: checked.revision, continueRepair: true, targetHead: git(root, "rev-parse", "HEAD") });
      assert.equal(next.status, "review"); assert.equal(next.acceptanceRepair.phase, "queued");
      const second = cli(root, ["start", task.id], { revision: next.revision, resolveConflicts: true });
      assert.equal(second.worktree, worktree); assert.equal(second.task.acceptanceRepair.attempts, 2);
      git(worktree, "merge", "--no-commit", "--no-ff", git(root, "rev-parse", "HEAD"));
      git(worktree, "commit", "-m", "fix: check advanced target\n\nTask: " + task.id);
      const fresh = cli(root, ["preview", task.id]);
      const again = cli(root, ["submit", task.id], { ...submit, token: fresh.token, message: fresh.commitMessage });
      writeFileSync(join(root, "third.txt"), "changed again\n"); git(root, "add", "third.txt"); git(root, "commit", "-m", "fix: advance again");
      const stopped = cli(root, ["accept", task.id], { actor: "user", revision: again.revision, continueRepair: true, targetHead: git(root, "rev-parse", "HEAD") });
      assert.equal(stopped.status, "review"); assert.equal(stopped.acceptanceRepair.phase, "failed");
      assert.ok(cli(root, ["manager-inbox"]).some((item: any) => item.kind === "question"));
    } else {
      const accepted = cli(root, ["accept", task.id], { actor: "user", revision: checked.revision, continueRepair: true, targetHead: head });
      assert.equal(accepted.status, "done"); assert.equal(accepted.acceptanceRepair, undefined);
      assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "combined\n");
    }
  }
});

test("recurring child work deduplicates local and external occurrences and recovers creation", async t => {
  const root = fixture(t); cli(root, ["init"]);
  const p = cli(root, ["create"], { title: "Local and issue checks", criteria: ["Inspect sources"], schedule: { everyMinutes: 5 }, workingDirectory: root });
  let parent = cli(root, ["approve", p.id], { revision: p.revision });
  const parentPath = join(root, ".tasks", "tasks", p.id + ".json");
  const due = JSON.parse(readFileSync(parentPath, "utf8")); due.schedule.nextAt = "2020-01-01T00:00:00Z";
  writeFileSync(parentPath, JSON.stringify(due));
  cli(root, ["start", p.id], { revision: parent.revision });
  const localResult = join(root, "check-result.json");
  writeFileSync(localResult, JSON.stringify({ check: "local:check:file:event1", error: "Local check found a failure" }));
  const finding = JSON.parse(readFileSync(localResult, "utf8"));
  const brief = { title: "Repair finding", description: "Fix the observed problem", criteria: ["Check succeeds"], basis: finding.error, key: finding.check };
  cli(root, ["spawn-child", p.id], { ...brief, criteria: [] }, "INVALID_INPUT");
  const first = cli(root, ["spawn-child", p.id], brief);
  assert.equal(first.status, "ready"); assert.equal(first.launchRequested, true);
  assert.equal(first.origin.parent, p.id); assert.deepEqual(first.dependencies, undefined);
  const repeat = cli(root, ["spawn-child", p.id], brief); assert.equal(repeat.id, first.id);
  // A saved card with an interrupted index write must be recovered, not duplicated.
  const indexPath = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")); delete index.tasks[first.id];
  writeFileSync(indexPath, JSON.stringify(index));
  assert.equal(cli(root, ["spawn-child", p.id], brief).id, first.id);
  assert.ok(cli(root, ["list"]).tasks.some((task: any) => task.id === first.id));
  const beforeReadFailure = cli(root, ["list"]).tasks.length;
  assert.throws(() => JSON.parse("temporarily unavailable"));
  assert.equal(cli(root, ["list"]).tasks.length, beforeReadFailure);
  const issue = JSON.parse('{"repository":"org/repo","number":42,"title":"Repair an Issue"}');
  const external = { ...brief, key: "issue:" + issue.repository + ":" + issue.number, basis: issue.title };
  const replies = await Promise.all(Array.from({ length: 3 }, () => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs(root, ["spawn-child", p.id], external), { env, windowsHide: true });
    let output = ""; child.stdout.on("data", data => output += data); child.on("error", reject);
    child.on("close", code => { try { assert.equal(code, 0, output); resolve(JSON.parse(output).data); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(external));
  })));
  assert.equal(new Set(replies.map(reply => reply.id)).size, 1);
  assert.notEqual(replies[0].id, first.id);
  const next = cli(root, ["spawn-child", p.id], { ...brief, key: "local:check:file:event2" }); assert.notEqual(next.id, first.id);
  cli(root, ["spawn-child", p.id], { ...brief, key: "bad", dependencies: [p.id] }, "INVALID_INPUT");
  const intermediate = cli(root, ["create"], { title: "Wait for parent", criteria: ["Ready"], dependencies: [p.id] });
  cli(root, ["spawn-child", p.id], { ...brief, key: "transitive", dependencies: [intermediate.id] }, "INVALID_INPUT");
  const match = cli(root, ["spawn-child", p.id], { ...brief, key: "semantic", existingId: first.id });
  assert.equal(match.id, first.id);
  assert.equal(cli(root, ["spawn-child", p.id], { ...brief, key: "semantic" }).id, first.id);
  const compactChild = cli(root, ["list", "--compact"]).tasks.find((task: any) => task.id === first.id);
  assert.equal(compactChild.origin.key, brief.key); assert.equal(compactChild.launchRequested, true);
  const firstPath = join(root, ".tasks", "tasks", first.id + ".json");
  const finished = JSON.parse(readFileSync(firstPath, "utf8")); finished.status = "done"; finished.closedAt = "2020-01-01T00:00:00Z";
  writeFileSync(firstPath, JSON.stringify(finished));
  assert.equal(cli(root, ["spawn-child", p.id], brief).id, first.id);
  cli(root, ["settings"], { archiveAfterDays: 0 }); cli(root, ["archive", "sweep"]);
  assert.equal(cli(root, ["spawn-child", p.id], brief).id, first.id);
  const linkedParent = cli(root, ["show", p.id]);
  assert.equal(linkedParent.childWork[0].id, first.id);
  assert.equal(linkedParent.childWork[0].basis, brief.basis);
  const ordinary = cli(root, ["create"], { title: "Ordinary", criteria: ["Done"], workingDirectory: root });
  const approved = cli(root, ["approve", ordinary.id], { revision: ordinary.revision });
  cli(root, ["start", ordinary.id], { revision: approved.revision });
  cli(root, ["spawn-child", ordinary.id], brief, "INVALID_TRANSITION");
  parent = cli(root, ["show", p.id]);
  const parentFile = JSON.parse(readFileSync(parentPath, "utf8")); parentFile.schedule.paused = true;
  writeFileSync(parentPath, JSON.stringify(parentFile));
  cli(root, ["progress", p.id], { summary: "Checked sources", nextStep: "Repeat checks", revision: parent.revision });
  const completed = cli(root, ["show", p.id]); assert.equal(completed.status, "ready"); assert.ok(completed.schedule.nextAt); assert.equal(completed.schedule.paused, true);
  cli(root, ["spawn-child", p.id], brief, "INVALID_TRANSITION");
});

test("recurring children use independent Git worktrees and ordinary review modes", t => {
  const root = fixture(t, true); cli(root, ["init"]);
  const created = cli(root, ["create"], { title: "Inspect local results", criteria: ["Record pass"], schedule: { everyMinutes: 5 }, workingDirectory: root });
  const approved = cli(root, ["approve", created.id], { revision: created.revision });
  const parentPath = join(root, ".tasks", "tasks", created.id + ".json");
  const saved = JSON.parse(readFileSync(parentPath, "utf8")); saved.schedule.nextAt = "2020-01-01T00:00:00Z";
  writeFileSync(parentPath, JSON.stringify(saved)); cli(root, ["start", created.id], { revision: approved.revision });
  const directories = new Set<string>();
  for (const mode of ["human", "reviewer"]) {
    cli(root, ["settings"], { reviewMode: mode, autoMode: false });
    const child = cli(root, ["spawn-child", created.id], { key: mode, basis: "Local finding " + mode, title: "Repair " + mode, description: "Fix local finding", criteria: ["Finding resolved"] });
    const started = cli(root, ["start", child.id], { revision: child.revision });
    assert.ok(started.worktree); assert.notEqual(started.worktree, root); directories.add(started.worktree);
    const current = cli(root, ["show", child.id]);
    const repeat = cli(root, ["start", child.id], { revision: current.revision });
    assert.equal(repeat.worktree, started.worktree);
    const preview = cli(root, ["preview", child.id, "--compact"]);
    const submitted = cli(root, ["submit", child.id, "--compact"], { token: preview.token, noChanges: true, summary: "Verified existing fix", checks: ["Local finding resolved"] });
    assert.equal(submitted.status, "review");
    const detail = cli(root, ["show", child.id]); assert.equal(detail.origin.parent, created.id);
    if (mode === "human") cli(root, ["accept", child.id], { revision: submitted.revision, actor: "manager", reviewMode: "human", targetHead: git(root, "rev-parse", "HEAD") }, "AUTO_REVIEW_DISABLED");
  }
  assert.equal(directories.size, 2);
  assert.equal(cli(root, ["show", created.id]).status, "in_progress");
});


test("canonical journal survives cancellation, worktree cleanup, archival and physical card deletion", async t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const card = cli(root, ["create"], { title: "Preserve interrupted journal", criteria: ["History survives"] });
  cli(root, ["approve", card.id]);
  const { worktree } = cli(root, ["start", card.id]);
  const { boardWorklog } = await import("../src/desktop/board-worklog.ts");
  const log = boardWorklog(worktree, "executor", card.id);
  log.start("interrupted", "before-cancel");
  log.fact("edit", "fileChange: completed; final report not submitted");
  log.finish();
  const read = () => globSync(".tasks/worklog/*/*/*.md", { cwd: root }).map(file => readFileSync(join(root, file), "utf8")).join("");
  assert.deepEqual(cli(root, ["worklog-migrate"]), []);
  const before = read();
  assert.match(before, /fileChange: completed/);
  assert.equal(existsSync(join(worktree, ".dev-diary")), false);
  const journal = join(root, ".tasks", "worklog");
  const heldJournal = join(root, ".tasks", "held-journal");
  renameSync(journal, heldJournal); writeFileSync(journal, "blocked storage");
  cli(root, ["cancel", card.id], { reason: "Test storage failure" }, "INVALID_STORAGE_PATH");
  assert.equal(cli(root, ["show", card.id]).status, "in_progress");
  assert.equal(existsSync(worktree), true);
  rmSync(journal); renameSync(heldJournal, journal);
  cli(root, ["cancel", card.id], { reason: "Test interruption before final report" });
  assert.equal(existsSync(worktree), false);
  assert.ok(read().includes(before.trim()));
  const afterCancel = read();
  cli(root, ["maintain"]); cli(root, ["maintain"]);
  assert.equal(read(), afterCancel, "a retained cancelled branch with no worktree adds no cleanup audit");
  cli(root, ["settings"], { archiveAfterDays: 0 });
  cli(root, ["archive", "sweep"]);
  assert.equal(existsSync(join(root, ".tasks", "tasks", card.id + ".json")), false);
  const indexPath = join(root, ".tasks", "board.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const archive = join(root, ".tasks", index.archive[card.id].path);
  rmSync(archive); delete index.archive[card.id]; writeFileSync(indexPath, JSON.stringify(index));
  const afterDelete = boardWorklog(root, "reviewer", card.id);
  afterDelete.start("reviewer", "deleted-card"); afterDelete.fact("review", "card absent; earlier operations remain available");
  assert.match(read(), /fileChange: completed/);
  assert.match(read(), /card absent/);
});
