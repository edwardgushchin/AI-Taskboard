import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const env = {
  ...process.env,
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
  const blocked = () => cli(root, ["start", task.id], undefined, "DEPENDENCIES_INCOMPLETE").details.dependencies;
  assert.deepEqual(blocked(), [first.id, second.id]);
  assert.equal(cli(root, ["show", task.id]).status, "ready");
  assert.ok(!existsSync(join(root, ".tasks", "worktrees", task.id)));

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

test("normal commands enforce task state, criteria, and revisions", t => {
  const root = fixture(t);
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
  cli(root, ["update", task.id], { criteria: ["Download XLSX."] }, "USER_REQUIREMENTS_REQUIRED");
  task = cli(root, ["update", task.id], { criteria: ["Download XLSX."], actor: "user", note: "Use XLSX" });
  assert.equal(task.status, "ready");
  cli(root, ["start", task.id], undefined, "GIT_REQUIRED");
  assert.equal(cli(root, ["list"]).tasks.length, 1);
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
  writeFileSync(indexPath, JSON.stringify(index));

  const snapshot = cli(root, ["list", "--tag", " ИНТЕРФЕЙС "]);
  assert.deepEqual(snapshot.tags.map((tag: { name: string }) => tag.name), ["Интерфейс", "Отчёты"]);
  assert.deepEqual(snapshot.tasks, [active]);
  const matches = cli(root, ["list", "--archived", "--tag", "ОТЧЁТЫ"]).archived;
  assert.deepEqual(matches.map((task: { id: string }) => task.id), [archived.id]);
  assert.deepEqual(matches[0].tags, ["Отчёты"]);

  const name = "Ошибки";
  assert.deepEqual(cli(root, ["tag", "ensure"], { name, color: "green" }), { name, color: "green" });
  assert.deepEqual(cli(root, ["tag", "ensure"], { name: "ОШИБКИ", color: "pink" }), { name, color: "green" });
  cli(root, ["tag", "set"], { name, color: "invalid" }, "INVALID_INPUT");
  const updated = cli(root, ["update", active.id], { tags: [" ошибки ", "ОШИБКИ"], revision: active.revision });
  assert.deepEqual(updated.tags, [name]);
  cli(root, ["update", active.id], { tags: ["Stale tag"], revision: active.revision }, "REVISION_CONFLICT");
  cli(root, ["tag", "set"], { name: "ошибки", color: "blue" });
  assert.deepEqual(cli(root, ["show", active.id]), updated);
  cli(root, ["update", active.id], { tags: [], revision: updated.revision });
  const empty = cli(root, ["list", "--tag", name]);
  assert.deepEqual(empty.tasks, []);
  assert.ok(empty.tags.some((tag: { name: string; color: string }) => tag.name === name && tag.color === "blue"));
  assert.ok(!empty.tags.some((tag: { name: string }) => tag.name === "Stale tag"));
});

test("linked worktrees share the board and cleanup preserves local files and the branch", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Change source", criteria: ["Source changes."] });
  cli(root, ["approve", task.id]);
  const started = cli(root, ["start", task.id]);
  let worktree = started.worktree;
  assert.equal(realpathSync(worktree), realpathSync(join(root, ".tasks", "worktrees", task.id)));
  assert.equal(cli(worktree, ["show", task.id]).status, "in_progress");
  assert.equal(cli(worktree, ["start", task.id]).worktree, worktree);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(cli(worktree, ["progress", task.id], { summary: "Started", nextStep: "Edit the source" }).nextStep,
    "Edit the source");
  cli(worktree, ["block", task.id], { reason: "Missing input", condition: "Receive input" });
  assert.equal(cli(worktree, ["resume", task.id], { reason: "Received input" }).status, "in_progress");
  const moved = join(root, ".tasks", "worktrees", "moved task worktree");
  git(root, "worktree", "move", worktree, moved);
  worktree = realpathSync(moved);
  assert.equal(cli(root, ["show", task.id]).git.worktree, worktree);
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
  cli(root, ["cancel", task.id], { reason: "No longer needed" });
  writeFileSync(join(worktree, "notes.local"), "Local notes");
  cli(root, ["cleanup", task.id], undefined, "DIRTY_WORKTREE");
  assert.ok(existsSync(join(worktree, "notes.local")));
  rmSync(join(worktree, "notes.local"));
  assert.equal(cli(root, ["cleanup", task.id]).removed, true);
  assert.ok(!existsSync(worktree));
  mkdirSync(started.worktree);
  assert.equal(cli(root, ["show", task.id]).git.worktree, undefined);
  assert.equal(git(root, "rev-parse", started.task.git.branch), started.task.git.base);
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

test("watch streams the initial board and updates from another process", { timeout: 10000 }, async t => {
  const root = fixture(t);
  cli(root, ["init"]);
  const child = spawn(process.execPath, commandArgs(root, ["watch"]), {
    env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  const closed = once(child, "close");
  const reader = createInterface({ input: child.stdout });
  t.after(async () => {
    reader.close();
    child.kill();
    await closed;
  });
  const lines = reader[Symbol.asyncIterator]();
  const frame = async () => {
    const { value } = await lines.next();
    assert.ok(typeof value === "string", "watch exited before sending a snapshot");
    return JSON.parse(value);
  };
  assert.deepEqual((await frame()).data.tasks, []);
  const task = cli(root, ["create"], { title: "Visible to watcher" });
  assert.equal((await frame()).data.tasks[0].id, task.id);
  const tag = cli(root, ["tag", "ensure"], { name: "Watched", color: "pink" });
  assert.deepEqual((await frame()).data.tags, [tag]);
  const recolored = cli(root, ["tag", "set"], { name: tag.name, color: "blue" });
  assert.deepEqual((await frame()).data.tags, [recolored]);
});

test("submission commits the confirmed snapshot and rejects changed or incomplete inputs", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const task = cli(root, ["create"], { title: "Update source", criteria: ["Source is updated."] });
  cli(root, ["approve", task.id]);
  const { worktree } = cli(root, ["start", task.id]);
  writeFileSync(join(worktree, "source.txt"), "first attempt\n");
  writeFileSync(join(worktree, "new [report].csv"), "id\n42\n");
  writeFileSync(join(worktree, "ignored.local"), "keep local");
  const original = cli(worktree, ["preview", task.id]);
  assert.deepEqual(original.paths, ["new [report].csv", "source.txt"]);
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), "");
  writeFileSync(join(worktree, "source.txt"), "new content for the same path\n");
  const input = { token: original.token, message: "feat: update the source", summary: "Updated source", checks: [] };
  cli(worktree, ["submit", task.id], input, "STALE_SNAPSHOT");
  assert.equal(cli(root, ["show", task.id]).status, "in_progress");
  const current = cli(worktree, ["preview", task.id]);
  cli(worktree, ["submit", task.id], { ...input, token: current.token, message: "changes" }, "INVALID_COMMIT_MESSAGE");
  const submitted = cli(worktree, ["submit", task.id], { ...input, token: current.token });
  assert.equal(submitted.status, "review");
  assert.equal(git(worktree, "rev-parse", "HEAD"), submitted.git.submission.sha);
  assert.equal(git(worktree, "log", "-1", "--format=%B"), "feat: update the source\n\nTask: " + task.id);
  assert.ok(!existsSync(join(root, "new [report].csv")));
  assert.equal(git(worktree, "ls-files", "--", "ignored.local"), "");
  const updated = cli(root, ["update", task.id], {
    actor: "user", criteria: ["Review the updated source and CSV."], note: "Add CSV to acceptance",
  });
  assert.equal(updated.status, "in_progress");
  assert.equal(cli(root, ["start", task.id]).worktree, worktree);
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

test("interrupted start and submit recover the existing worktree and commit", t => {
  const root = fixture(t, true);
  cli(root, ["init"]);
  const draft = cli(root, ["create"], { title: "Recover a task", criteria: ["A result is delivered."] });
  const ready = cli(root, ["approve", draft.id]);
  const pending = join(root, ".tasks", "pending", ready.id + ".json");
  const worktree = join(root, ".tasks", "worktrees", ready.id);
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(pending, JSON.stringify({ action: "start", revision: ready.revision, target: "refs/heads/main", base }));
  git(root, "worktree", "add", "-b", "ai-taskboard/" + ready.id, worktree, base);
  cli(root, ["cancel", ready.id], { reason: "Check that partial Git state is preserved" }, "PENDING_OPERATION");

  const started = cli(root, ["start", ready.id]);
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

test("resubmission verifies the actual Conventional Commit after an external rebase", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  git(root, "commit", "--allow-empty", "-m", "chore: advance target");
  git(worktree, "rebase", "main");
  const head = git(worktree, "rev-parse", "HEAD");
  assert.notEqual(head, task.git.submission.sha);
  assert.equal(cli(root, ["review", task.id]).stale, true);
  cli(root, ["accept", task.id], { revision: task.revision }, "STALE_SUBMISSION");
  cli(root, ["request-changes", task.id], { reason: "Review the rebased result" });

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

test("accept creates a merge commit and protects the source and ignored files", t => {
  const root = fixture(t, true);
  const initial = git(root, "rev-parse", "HEAD");
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "protected.txt"), "delivered\n"));
  const review = cli(root, ["review", task.id]);
  assert.deepEqual(review.paths, ["protected.txt"]);
  assert.match(review.diff, /\+delivered/);
  assert.equal(review.targetHead, initial);
  cli(root, ["accept", task.id], undefined, "INVALID_INPUT");
  cli(root, ["accept", task.id], { revision: task.revision - 1 }, "REVISION_CONFLICT");
  cli(root, ["accept", task.id], { revision: task.revision, targetHead: task.git.submission.sha }, "TARGET_CHANGED");
  writeFileSync(join(worktree, "unsubmitted.txt"), "new edit");
  assert.equal(cli(root, ["review", task.id]).stale, true);
  cli(root, ["accept", task.id], { revision: task.revision }, "STALE_SUBMISSION");
  rmSync(join(worktree, "unsubmitted.txt"));

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
  assert.equal(git(root, "show", "-s", "--format=%P"), initial + " " + task.git.submission.sha);
  assert.equal(git(root, "show", "-s", "--format=%B"), "feat: deliver result\n\nTask: " + task.id);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(root, "branch", "--list", "ai-taskboard/" + task.id), "");
  assert.equal(git(root, "rev-parse", "HEAD^2"), task.git.submission.sha);
  assert.equal(cli(root, ["accept", task.id], { revision: task.revision }).git.accepted, done.git.accepted);
});

test("accepted task cleanup preserves local files and refuses to delete a changed branch", t => {
  const root = fixture(t, true);
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "result.txt"), "delivered\n"));
  const exclude = join(root, ".git", "info", "exclude");
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "\n/ignored.local\n");
  const ignored = join(worktree, "ignored.local");
  writeFileSync(ignored, "keep this file");
  const done = cli(root, ["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done");
  assert.equal(done.cleanupWarning.code, "DIRTY_WORKTREE");
  assert.equal(readFileSync(ignored, "utf8"), "keep this file");
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
  assert.equal(cli(root, ["cleanup", task.id]).removed, false);
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
  const target = join(root, ".tasks", "worktrees", ".accept-" + task.id);
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
  const { task, worktree } = submitFixture(root, path => writeFileSync(join(path, "source.txt"), "task version\n"));
  const resolve = { revision: task.revision, resolveConflicts: true };
  cli(root, ["start", task.id], resolve, "NO_MERGE_CONFLICT");
  writeFileSync(join(root, "source.txt"), "target version\n");
  git(root, "add", "source.txt");
  git(root, "commit", "-m", "fix: edit target independently");
  const head = git(root, "rev-parse", "HEAD");
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
  git(root, "merge", "--squash", task.git.submission.sha);
  git(root, "commit", "-m", task.git.submission.message);
  const squash = git(root, "rev-parse", "HEAD");
  const accepted = cli(root, ["accept", task.id], { revision: task.revision, commit: squash });
  assert.equal(accepted.status, "done");
  assert.equal(accepted.git.accepted, squash);
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
  git(root, "commit", "--allow-empty", "-m", "chore: advance target");
  const advanced = git(root, "rev-parse", "HEAD");
  const recovered = cli(root, ["accept", task.id]);
  assert.equal(recovered.status, "done");
  assert.equal(recovered.git.accepted, accepted);
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
