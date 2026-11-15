import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { codexThreadPattern, maxAttachmentBytes, TaskboardError, taskIdPattern } from "../src/cli/model.ts";
import type { ChatSettings } from "../src/cli/model.ts";
import { readJson, writeJson } from "../src/cli/storage.ts";
import type { BoardGoal, BoardGoalAction } from "../src/desktop/codex-chat.ts";
import { projectSha256 } from "../src/desktop/project-hash.ts";

const source = (file: string) => readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
const boardSource = stripTypeScriptTypes(source("board-actions.ts").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
const main = ts.createSourceFile("main.ts", source("main.ts"), ts.ScriptTarget.Latest, true);
const handlerSource = stripTypeScriptTypes(main.statements.map(node => node.getText(main)).filter(text =>
  /^(?:function (?:isPastedFile|readBoardThread|boardThreadPath|broadcastBoardChat)\(|const (?:imageExtensions|imageTypes|boardRequests) =|imageTypes\.set\(|ipcMain\.handle\("board:(?:request|stopOrchestrator|goal)",)/.test(text)).join("\n"));
const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const cliFailure = (code: string, message: string) => ({ ok: false, error: { code, message } });

function fixture(t: TestContext) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-orchestrator-test-")));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }));
  const project = join(folder, "project");
  mkdirSync(project);
  const callCli = async (cwd: string, args: string[], input?: unknown) => {
    assert.equal(cwd, project);
    const result = spawnSync(process.execPath, [entry, "--project", cwd, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", input: JSON.stringify(input), windowsHide: true });
    assert.ok(result.stdout, result.stderr);
    return JSON.parse(result.stdout);
  };
  const { boardActions, boardInstructions, boardMcpTools, boardTools } = runInNewContext(
    boardSource + "\n({ boardActions, boardInstructions, boardMcpTools, boardTools })",
    { AbortSignal, callCli, cliFailure, projectSha256, statfs, TaskboardError, taskIdPattern, taskFields: { title: {}, description: {}, criteria: {} },
      delay: () => new Promise<void>(resolve => setImmediate(resolve)) },
  );
  type RunAction = (name: string, args: unknown) => Promise<any>;
  type GoalControl = (action: BoardGoalAction) => Promise<BoardGoal | null>;
  type GoalRequest = { objective?: string; resume?: boolean; accepted: () => void; controls: (control: GoalControl) => void;
    update: (goal: BoardGoal | null) => void; settings?: ChatSettings | null };
  type Reply = (action: RunAction, prompt: string, images: string[], id?: string, context?: any,
    waiting?: (waiting: boolean) => void, signal?: AbortSignal, goal?: GoalRequest) => Promise<{ text: string }>;
  let respond: Reply;
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  const threadId = "00000000-0000-0000-0000-000000000001";
  const binding = join(project, ".tasks", "orchestrator.json");
  const idleGoalActions: BoardGoalAction[] = [];
  const runningTasks = new Set<string>();
  const sender = { isDestroyed: () => true };
  runInNewContext(handlerSource, {
    AbortController, ArrayBuffer, Buffer, Error, basename, extname, join, mkdtemp, rm, writeFile, maxAttachmentBytes, boardActions, boardInstructions, boardTools, callCli,
    existsSync, readJson, writeJson, codexThreadPattern, projectIdentity: (path: string) => path, windowStates: new Map(), boardMcpTools,
    launchingTasks: new Set(), runningTasks, chatRuns: new Map(),
    updateBoardGoal: async (_profile: string, cwd: string, id: string, action: BoardGoalAction) => {
      assert.equal(cwd, project);
      assert.equal(id, threadId);
      idleGoalActions.push(action);
      return null;
    },
    launchTask: async (cwd: string, id: string, review?: { input: unknown }, _newThread?: boolean, revision?: number) => {
      if (review) {
        const revised = await callCli(cwd, ["request-changes", id], review.input);
        if (!revised.ok) return revised;
        revision = revised.data.revision;
      }
      const result = await callCli(cwd, ["start", id], { revision });
      return result.ok ? { ok: true, data: result.data.task } : result;
    },
    tmpdir: () => folder, stateOf: () => ({ board: { project, settings: {} } }), app: { getPath: () => folder }, cliFailure, lang: (english: string) => english,
    beginOperation: () => ({ controller: new AbortController(), finish() {} }),
    ipcMain: { handle: (name: string, callback: (...args: unknown[]) => Promise<any>) => { handlers.set(name, callback); } },
    replyToBoard: async (_profile: string, cwd: string, prompt: string, images: string[], action: RunAction,
      _tools: unknown, _instructions: string, _signal: AbortSignal,
      session: { id?: string; title: string; save: (id: string) => void; attachmentContext?: string; mcpTools: { name: string }[];
        onWaiting: (waiting: boolean) => void; goal?: string; resumeGoal?: boolean; onGoalSet: () => void;
        onGoalControl: (control: GoalControl) => void; onGoal: (goal: BoardGoal | null) => void; settings?: ChatSettings | null }) => {
      assert.equal(cwd, project);
      assert.equal(session.title, "Project manager for project");
      assert.deepEqual(Array.from(session.mcpTools, tool => tool.name), [
        "task_start", "task_approve", "task_wait", "task_review", "task_accept", "task_request_changes", "project_git", "project_disk",
        "project_sha256",
      ]);
      if (!session.id) session.save(threadId);
      return respond(action, prompt, images, session.id, session.attachmentContext && JSON.parse(session.attachmentContext),
        session.onWaiting, _signal, { objective: session.goal, resume: session.resumeGoal, accepted: session.onGoalSet,
          controls: session.onGoalControl, update: session.onGoal, settings: session.settings });
    },
  });
  return {
    folder, threadId, binding, idleGoalActions,
    setRunning: (id: string, running: boolean) => running ? runningTasks.add(project + "\0" + id) : runningTasks.delete(project + "\0" + id),
    cli: (args: string[], input?: unknown) => callCli(project, args, input),
    run: (request: string, reply: Reply, files: unknown[] = [], goal: boolean | "resume" = false) => {
      respond = reply;
      return handlers.get("board:request")!({ sender }, request, files, undefined, goal);
    },
    stop: () => handlers.get("board:stopOrchestrator")!({ sender }),
    goal: (kind: string, objective?: string) => handlers.get("board:goal")!({ sender }, kind, objective),
  };
}

const file = (name: string, type: string, content: string) => ({ name, type, bytes: new TextEncoder().encode(content).buffer });

test("manager reads Git and disk information without modifying the repository", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, "tracked.txt"), "Original\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "-m", "Initial commit");
  const from = git("rev-parse", "HEAD");
  await writeFile(join(project, "tracked.txt"), "Committed edit\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "-m", "Commit for comparison");
  const to = git("rev-parse", "HEAD");
  await writeFile(join(project, "tracked.txt"), "Staged edit\n");
  git("add", "tracked.txt");
  await writeFile(join(project, "tracked.txt"), "Working edit\n");
  await writeFile(join(project, "untracked.txt"), "New file\n");
  await writeFile(join(project, ".gitattributes"), "tracked.txt filter=test diff=test\n");
  git("config", "filter.test.clean", "exit 1");
  git("config", "filter.test.required", "true");
  git("config", "diff.test.textconv", "exit 1");
  const indexPath = join(project, ".git", "index");
  const index = readFileSync(indexPath);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  const reply = await f.run("Проверь Git и свободное место", async (act, _text, _images, thread) => {
    assert.equal(thread, f.threadId);
    const status = await act("project_git", { view: "status" });
    assert.match(status.data.output, /## main[\s\S]*MM tracked\.txt[\s\S]*\?\? untracked\.txt/);
    assert.match(status.data.note, /filters were disabled/);
    assert.match((await act("project_git", { view: "log" })).data.output, /Initial commit/);
    assert.match((await act("project_git", { view: "diff" })).data.output, /\+Working edit/);
    assert.match((await act("project_git", { view: "staged_diff" })).data.output, /\+Staged edit/);
    const commit = await act("project_git", { view: "commit_diff", from, to, paths: ["tracked.txt"] });
    assert.equal(commit.ok, true);
    assert.match(commit.data.output, /\+Committed edit/);
    assert.doesNotMatch(commit.data.output, /Staged edit|Working edit/);
    assert.equal((await act("project_git", { view: "reset" })).error.code, "INVALID_INPUT");
    assert.equal((await act("project_git", { view: "status", path: ".." })).error.code, "INVALID_INPUT");
    const disk = (await act("project_disk", {})).data;
    assert.ok(disk.availableBytes >= 0 && disk.totalBytes > 0 && disk.availableBytes <= disk.totalBytes);
    return { text: "Проверил." };
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(reply.data.changes.length, 0);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(existsSync(indexPath + ".lock"), false);
});

test("manager hashes project files and rejects paths outside the project", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const project = join(f.folder, "project");
  const artifacts = join(project, "artifacts");
  const outside = join(f.folder, "outside");
  mkdirSync(artifacts);
  mkdirSync(outside);
  await writeFile(join(artifacts, "пакет test.bin"), Buffer.from([0, 255, 13, 10, 65]));
  await writeFile(join(outside, "data.bin"), "outside");
  await symlink(outside, join(project, "external"), process.platform === "win32" ? "junction" : "dir");
  const reply = await f.run("Пересчитай SHA-256 пакета", async act => {
    const digest = await act("project_sha256", { path: "artifacts\\пакет test.bin" });
    assert.equal(digest.ok, true, JSON.stringify(digest.error));
    assert.equal(digest.data.path, "artifacts/пакет test.bin");
    assert.equal(digest.data.sha256, "4259d3f5151edfc7205e3e7c3fde341e237968666aad8946dcbcf6a374502c60");
    for (const path of ["../outside/data.bin", "external/data.bin", join(artifacts, "пакет test.bin"), "C:relative.bin"]) {
      assert.equal((await act("project_sha256", { path })).error.code, "INVALID_INPUT");
    }
    for (const path of ["artifacts", "missing.bin"]) {
      assert.equal((await act("project_sha256", { path })).error.code, "FILE_HASH_UNAVAILABLE");
    }
    return { text: digest.data.sha256 };
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(reply.data.changes.length, 0);
});

test("manager launches multiple tasks through the task start path and reports each result", async t => {
  const f = fixture(t);
  const initialized = await f.cli(["init"]);
  assert.equal(initialized.ok, true);
  const { data: first } = await f.cli(["create"], { title: "First", criteria: ["First result"] });
  const { data: second } = await f.cli(["create"], { title: "Second", criteria: ["Second result"] });
  const { data: draft } = await f.cli(["create"], { title: "Draft", criteria: ["Draft result"] });
  const { data: firstReady } = await f.cli(["approve", first.id]);
  const { data: secondReady } = await f.cli(["approve", second.id]);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", join(f.folder, "project"), ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "--allow-empty", "-m", "Initial commit");
  const result = await f.run("Запусти задачи", async (act, _prompt, _images, thread) => {
    assert.equal(thread, f.threadId);
    assert.equal((await act("task_start", { id: first.id })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_start", { id: first.id, revision: first.revision })).error.code, "REVISION_CONFLICT");
    const launches = await Promise.all([
      act("task_start", { id: first.id, revision: firstReady.revision }),
      act("task_start", { id: second.id, revision: secondReady.revision }),
    ]);
    assert.deepEqual(launches.map(result => result.data.status), ["in_progress", "in_progress"]);
    assert.equal((await act("task_start", { id: first.id, revision: firstReady.revision })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_start", { id: draft.id, revision: draft.revision })).error.code, "INVALID_TRANSITION");
    return { text: "Запущены две задачи." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(Array.from(result.data.changes, (change: { id: string; action: string }) => [change.id, change.action]),
    [[first.id, "start"], [second.id, "start"]]);
  assert.deepEqual(readJson(f.binding), { provider: "codex", id: f.threadId });
});

test("a goal delegates a bounded slice, waits for submission, and reviews before local integration", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Taskboard");
  git("config", "user.email", "taskboard@example.invalid");
  git("commit", "--allow-empty", "-m", "chore: initialize");
  const unrelated = (await f.cli(["create"], { title: "Manual task", criteria: ["Manual review"] })).data;
  const objective = "Cover every applicable public API in the project";
  let sliceId = "";
  const result = await f.run(objective, async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.update({ objective, status: "active" });
    assert.equal((await act("task_create", { title: "All coverage", description: objective, criteria: ["100%"] })).error.code, "GOAL_SLICE_REQUIRED");
    assert.equal((await act("task_approve", { id: unrelated.id, revision: unrelated.revision })).error.code, "GOAL_TASK_REQUIRED");
    const slice = (await act("task_create", {
      title: "Cover empty names", description: "Specify the empty-name result in the parser.", criteria: ["Empty names return a validation error."],
    })).data;
    sliceId = slice.id;
    assert.equal((await f.cli(["show", slice.id])).data.goalThreadId, f.threadId);
    const ready = (await act("task_approve", { id: slice.id, revision: slice.revision })).data;
    assert.equal(ready.status, "ready");
    const started = (await act("task_start", { id: slice.id, revision: ready.revision })).data;
    assert.equal(started.status, "in_progress");
    const { git: context } = (await f.cli(["show", slice.id])).data;
    f.setRunning(slice.id, true);
    const wait = act("task_wait", { id: slice.id });
    const submit = async (content: string) => {
      await writeFile(join(context.worktree, "parser.txt"), content);
      const { token } = (await f.cli(["preview", slice.id])).data;
      const response = await f.cli(["submit", slice.id], { token, message: "feat: cover empty names", summary: "Parser result", checks: ["Parser fixture passed"] });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      return response.data;
    };
    const first = await submit("Empty name: ignored\n");
    assert.equal((await act("task_request_changes", { id: slice.id, revision: first.revision, reason: "Return a validation error." })).error.code, "CHAT_BUSY");
    f.setRunning(slice.id, false);
    const waited = (await wait).data;
    assert.equal(waited.status, "review");
    assert.equal(waited.running, false);
    assert.equal((await act("task_accept", { id: slice.id, revision: first.revision, targetHead: "unreviewed", evidence: ["Checked parser.txt."] })).error.code, "REVIEW_REQUIRED");
    assert.match((await act("task_review", { id: slice.id })).data.diff, /\+Empty name: ignored/);
    const retry = await act("task_request_changes", { id: slice.id, revision: first.revision, reason: "Return a validation error for empty names." });
    assert.equal(retry.data.status, "in_progress");
    await submit("Empty name: validation error\n");
    return { text: "One slice sent for review." };
  }, [], true);
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result.data?.error));
  const ordinary = await f.run("Review the submission", async act => {
    const show = (await act("task_show", { id: sliceId })).data;
    const slice = { id: sliceId, revision: show.revision };
    const review = (await act("task_review", { id: slice.id })).data;
    assert.match(review.diff, /\+Empty name: validation error/);
    assert.equal(review.result.checks[0], "Parser fixture passed");
    assert.equal(review.revision, slice.revision);
    const target = { ...slice, targetHead: review.targetHead };
    assert.equal((await act("task_accept", { ...target, evidence: [] })).error.code, "VERIFICATION_REQUIRED");
    const accepted = await act("task_accept", { ...target, evidence: ["The submitted parser fixture explicitly returns a validation error for empty names."] });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.equal(accepted.data.status, "done");
    return { text: "One slice integrated." };
  });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.error ?? ordinary.data?.error));
  assert.equal(ordinary.data.answer, "One slice integrated.");
  assert.equal(readFileSync(join(project, "parser.txt"), "utf8").trim(), "Empty name: validation error");
  const saved = (await f.cli(["show", sliceId])).data;
  assert.equal(saved.history.findLast((event: { action: string }) => event.action === "accept").actor, "manager");
});

test("manager reviews and accepts an independently verified result without Git changes", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "--allow-empty", "-m", "Initial commit");
  const head = git("rev-parse", "HEAD");
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: task } = await f.cli(["create"], { title: "Check local data", criteria: ["Obsolete folder is absent."] });
  assert.equal((await f.cli(["approve", task.id])).ok, true);
  assert.equal((await f.cli(["start", task.id])).ok, true);
  const { data: preview } = await f.cli(["preview", task.id]);
  assert.equal((await f.cli(["submit", task.id], {
    token: preview.token, noChanges: true, summary: "Obsolete folder is absent", checks: ["Checked the project directory"],
  })).ok, true);
  const result = await f.run("Review the local result", async act => {
    const review = (await act("task_review", { id: task.id })).data;
    assert.equal(review.noChanges, true);
    assert.equal(review.targetHead, null);
    assert.deepEqual(review.result.checks, ["Checked the project directory"]);
    assert.equal(existsSync(join(project, "obsolete")), false);
    const accepted = await act("task_accept", {
      id: task.id, revision: review.revision, targetHead: review.targetHead, evidence: ["Verified that obsolete/ is absent."],
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.equal(accepted.data.status, "done");
    return { text: "Accepted." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result.data?.error));
  assert.equal(git("rev-parse", "HEAD"), head);
});

test("cancelling a waiting request keeps the board thread and releases its temporary attachments", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  const ready = Promise.withResolvers<void>();
  const pending = f.run("Read this", async (_act, _text, _images, id, _context, waiting, signal) => {
    assert.equal(id, f.threadId);
    waiting!(true);
    const stopped = new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    ready.resolve();
    return stopped;
  }, [file("notes.txt", "text/plain", "notes")]);
  await Promise.race([ready.promise, pending.then(result => assert.fail(JSON.stringify(result)))]);
  assert.equal((await f.stop()).ok, true);
  assert.equal((await pending).error.code, "BOARD_WAIT_CANCELLED");
  assert.equal((await f.stop()).error.code, "CHAT_NOT_RUNNING");
  assert.deepEqual(readdirSync(f.folder), ["project"]);
  assert.deepEqual(readJson(f.binding), { provider: "codex", id: f.threadId });
});

test("orchestrator discusses a board, remembers the turn, and cancels the original task through the CLI", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const created = await f.cli(["create"], { title: "Fix card preview", criteria: ["Corners match"] });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const task = created.data;
  await f.cli(["approve", task.id]);
  const first = await f.run("Что на доске?", async (act, prompt) => {
    assert.equal(prompt, "Что на доске?");
    const list = await act("board_list", {});
    assert.equal(list.data.tasks[0].id, task.id);
    return { text: "В очереди задача на исправление превью." };
  });
  assert.equal(first.data.changes.length, 0);
  assert.deepEqual(readJson(f.binding), { provider: "codex", id: f.threadId });
  const second = await f.run("Эта задача не актуальна", async (act, prompt, _images, id) => {
    assert.equal(id, f.threadId);
    assert.equal(prompt, "Эта задача не актуальна");
    const current = (await act("task_show", { id: task.id })).data;
    const args = { id: current.id, revision: current.revision, reason: "Задача не актуальна" };
    assert.equal((await act("task_cancel", { ...args, revision: 1 })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_cancel", args)).ok, true);
    return { text: "Задача отменена." };
  });
  assert.equal(second.data.changes[0].action, "cancel");
  assert.equal(second.data.changes[0].id, task.id);
  const board = (await f.cli(["list"])).data;
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].status, "cancelled");
  assert.equal(board.tasks[0].history.at(-1).actor, "manager");
});

test("the project manager can revise an approved task and resolve its blocker from a discussion", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: task } = await f.cli(["create"], { title: "Group task chats", criteria: ["Use the original integration"] });
  const { data: ready } = await f.cli(["approve", task.id]);
  const { data: blocked } = await f.cli(["block", task.id], {
    revision: ready.revision, allowUnstarted: true, reason: "Original integration is unavailable", condition: "Use a supported integration",
  });
  const result = await f.run("Достаточно, чтобы у чатов задач была общая папка, в том числе на телефоне.", async (act, prompt) => {
    assert.equal(prompt, "Достаточно, чтобы у чатов задач была общая папка, в том числе на телефоне.");
    const { data: current } = await act("task_show", { id: task.id });
    const criteria = ["Task chats appear in a shared project folder on desktop and mobile"];
    const update = { id: current.id, revision: current.revision, criteria, note: "Keep the required outcome and allow any supported integration" };
    assert.equal((await act("task_update", { ...update, revision: ready.revision })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_update", { ...update, criteria: [] })).error.code, "CRITERIA_REQUIRED");
    const revised = await act("task_update", update);
    assert.equal(revised.ok, true, JSON.stringify(revised.error));
    assert.equal(revised.data.status, "blocked");
    assert.equal((await act("task_unblock", {
      id: task.id, revision: revised.data.revision, reason: "The task no longer requires the unavailable integration",
    })).ok, true);
    return { text: "Уточнил критерии и снял блокировку." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(Array.from(result.data.changes, (change: { action: string }) => change.action), ["update", "unblock"]);
  const board = (await f.cli(["list"])).data;
  assert.equal(board.tasks.length, 1);
  const updated = board.tasks[0];
  assert.equal(updated.id, task.id);
  assert.equal(updated.status, "ready");
  assert.equal(updated.revision, blocked.revision + 2);
  assert.deepEqual(updated.criteria, ["Task chats appear in a shared project folder on desktop and mobile"]);
  assert.deepEqual(updated.history.slice(-2).map((event: { actor: string }) => event.actor), ["manager", "manager"]);
});

test("orchestrator preserves selected attachments, restores blocked drafts, and reports changes after a failed reply", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const files = [file("image.png", "image/png", "first"), file("notes.txt", "text/plain", "notes"), file("image.png", "", "second")];
  const created = await f.run("", async (act, prompt, images, _id, context) => {
    assert.equal(prompt, "See attachments.");
    assert.deepEqual(context.attachments, [
      { id: 1, name: "image.png", image: true, imageIndex: 1 }, { id: 2, name: "notes.txt", image: false },
      { id: 3, name: "image.png", image: true, imageIndex: 2 },
    ]);
    assert.deepEqual(Array.from(images, image => Buffer.from(image.split(",")[1], "base64").toString()), ["first", "second"]);
    assert.equal((await act("task_create", { title: "Draft", attachmentIds: [4] })).error.code, "INVALID_INPUT");
    const draft = await act("task_create", { title: "Draft", attachmentIds: [1, 2, 3] });
    assert.equal(draft.ok, true);
    throw new Error("Provider failed after creation");
  }, files);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.match(created.data.error, /Provider failed after creation/);
  const id = created.data.changes[0].id;
  const blocked = await f.run("Пока заблокируй её", async (act, _prompt, _images, thread) => {
    assert.equal(thread, f.threadId);
    const draft = (await act("task_show", { id })).data;
    assert.equal(draft.attachments.length, 3);
    assert.equal((await act("task_block", { id, revision: draft.revision, reason: "No layout", condition: "Get layout" })).data.status, "blocked");
    return { text: "Заблокирована." };
  });
  const unblocked = await f.run("Макет готов, разблокируй", async act => {
    const result = await act("task_unblock", { id, revision: blocked.data.changes[0].revision, reason: "Layout is ready" });
    assert.equal(result.data.status, "draft");
    return { text: "Черновик разблокирован." };
  });
  assert.equal(unblocked.data.changes[0].status, "draft");
  const draft = (await f.cli(["show", id])).data;
  assert.equal(draft.blocked, undefined);
  assert.equal(draft.git, undefined);
  assert.deepEqual(readdirSync(f.folder), ["project"]);
});

test("an unsuccessful reply keeps the board unchanged and allows resending the attachments", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const files = [file("REF.JPEG", "", "jpeg"), file("clip", "image/png", "png"), file("ref.webp", "", "webp"), file("ref.gif", "", "gif")];
  const failed = await f.run("Посмотри вложения", async (_act, _prompt, images) => {
    assert.deepEqual(Array.from(images, image => image.split(/[/:;]/)[2]), ["jpeg", "png", "webp", "gif"]);
    throw new Error("Unable to decode image");
  }, files);
  assert.equal(failed.error.code, "CODEX_BOARD_REQUEST_FAILED");
  assert.match(failed.error.message, /Unable to decode image/);
  assert.deepEqual((await f.cli(["list"])).data.tasks, []);
  assert.deepEqual(readdirSync(f.folder), ["project"]);
  const retry = await f.run("Посмотри вложения", async (_act, prompt, images, id) => {
    assert.equal(id, f.threadId);
    assert.equal(prompt, "Посмотри вложения");
    assert.equal(images.length, 4);
    return { text: "Посмотрел." };
  }, files);
  assert.equal(retry.data.answer, "Посмотрел.");
});

test("a connection failure after goal acceptance preserves the request in the existing chat", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const objective = "Keep the board up to date";
  const fail = async () => { throw new Error("Codex did not respond in time."); };
  const notAccepted = await f.run(objective, fail, [], true);
  assert.equal(notAccepted.error.code, "CODEX_BOARD_REQUEST_FAILED");

  const accepted = await f.run(objective, async (_act, _prompt, _images, id, _context, _waiting, _signal, goal) => {
    assert.equal(id, f.threadId);
    assert.equal(goal?.objective, objective);
    goal?.accepted();
    return fail();
  }, [], true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.id, f.threadId);
  assert.match(accepted.data.error, /goal is saved.*\n.*\nCodex did not respond/s);
  assert.deepEqual(readJson(f.binding), { provider: "codex", id: f.threadId });
  assert.deepEqual(readdirSync(f.folder), ["project"]);
});

test("a damaged binding reports an error before opening another chat", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  writeJson(f.binding, { provider: "codex", id: "invalid" });
  let called = false;
  const result = await f.run("Что на доске?", async () => {
    called = true;
    return { text: "unexpected" };
  });
  assert.equal(result.error.code, "CODEX_BOARD_REQUEST_FAILED");
  assert.equal(called, false);
  assert.deepEqual(readJson(f.binding), { provider: "codex", id: "invalid" });
});

test("goal actions use the running chat connection and resume requires an existing binding", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.run("", async () => assert.fail("Must not start another chat"), [], "resume")).ok, false);
  assert.equal((await f.goal("edit", "  ")).ok, false);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  const settings = { model: "test-manager", effort: "high" };
  assert.equal((await f.cli(["settings"], { manager: settings })).ok, true);
  const connected = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const resume = f.run("", async (_act, prompt, _images, id, _context, _waiting, _signal, goal) => {
    assert.equal(id, f.threadId);
    assert.equal(prompt, "");
    assert.ok(goal?.resume);
    assert.deepEqual(goal.settings, settings);
    goal.controls(async action => {
      assert.equal(action.kind, "pause");
      return { objective: "Saved objective", status: "paused" };
    });
    connected.resolve();
    await done.promise;
    return { text: "Paused." };
  }, [], "resume");
  await Promise.race([connected.promise, resume.then(result => assert.fail(JSON.stringify(result)))]);
  try {
    const paused = await f.goal("pause");
    assert.equal(paused.data.status, "paused");
    assert.equal(f.idleGoalActions.length, 0);
  } finally {
    done.resolve();
    await resume;
  }
  assert.equal((await f.goal("clear")).data, null);
  assert.equal(f.idleGoalActions[0]?.kind, "clear");
});

test("two windows sharing a board cannot start separate orchestrator chats", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = f.run("First question", async () => {
    ready.resolve();
    await release.promise;
    return { text: "First answer" };
  });
  try {
    await ready.promise;
    const second = await f.run("Second question", async () => { throw new Error("A concurrent turn started"); });
    assert.equal(second.error.code, "BOARD_REQUEST_IN_PROGRESS");
  } finally {
    release.resolve();
    assert.equal((await first).data.id, f.threadId);
  }
});

test("the manager can read the open queue without closed or archived cards", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: archived } = await f.cli(["create"], { title: "Archived work" });
  assert.equal((await f.cli(["cancel", archived.id], { reason: "Obsolete" })).ok, true);
  assert.equal((await f.cli(["settings"], { archiveAfterDays: 0 })).ok, true);
  assert.equal((await f.cli(["archive", "sweep"])).ok, true);

  const { data: closed } = await f.cli(["create"], { title: "Closed work" });
  assert.equal((await f.cli(["cancel", closed.id], { reason: "Obsolete" })).ok, true);
  const { data: open } = await f.cli(["create"], { title: "Open work", tags: ["Runtime"] });
  const result = await f.run("Show the open queue", async act => {
    assert.equal((await act("board_list", { activeOnly: "true" })).error.code, "INVALID_INPUT");
    const full = (await act("board_list", {})).data;
    const active = (await act("board_list", { activeOnly: true })).data;
    const fullTasks = Array.from<{ id: string }>(full.tasks);
    assert.deepEqual(fullTasks.map(task => task.id), [closed.id, open.id]);
    assert.deepEqual(Array.from<{ id: string }>(full.archived).map(task => task.id), [archived.id]);
    assert.deepEqual(Array.from(active.tasks), fullTasks.filter(task => task.id === open.id));
    assert.equal(active.archived.length, 0);
    assert.deepEqual(Array.from(active.tags), Array.from(full.tags));
    return { text: "Open queue read." };
  });
  assert.equal(result.data?.answer, "Open queue read.", JSON.stringify(result.error ?? result.data?.error));
});
