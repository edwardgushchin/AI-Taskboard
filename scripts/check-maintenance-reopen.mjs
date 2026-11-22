// Real Electron scheduler, CLI, renderer and Git; only the provider is replaced.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { withRuntimeLock } from "../src/cli/storage.ts";
import { registerRuntime, runtimeEntries } from "../src/desktop/board-runtime.ts";

const { scratch, artifacts } = electronCheck(import.meta.url, "maintenance-reopen", 180_000,
  [["initial"], ["restart"]]);
const restart = process.argv.at(-1) === "restart";
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const queuePath = join(project, ".tasks", "maintenance.json");
const manifestPath = join(scratch, "fixtures.json");
const callsPath = join(scratch, "calls.json");
const report = join(artifacts, "maintenance-reopen-check.txt");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const lines = [];
const pass = text => {
  lines.push("PASS " + text);
  console.log(lines.at(-1));
};
const readQueue = () => JSON.parse(readFileSync(queuePath, "utf8"));
const readCalls = () => JSON.parse(readFileSync(callsPath, "utf8"));
const count = id => readCalls().filter(call => call === id + ":cleanup").length;
function cli(args, input) {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE,
    ["--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])],
    { cwd: scratch, windowsHide: true, encoding: "utf8", input: input === undefined ? undefined : JSON.stringify(input) }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true, encoding: "utf8" }).trim();
async function waitFor(probe, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error("Timed out: " + label);
}
const ready = window => waitFor(() => !window.webContents.isLoading() &&
  window.webContents.executeJavaScript("window.taskboard?.bootstrap().then(f => Boolean(f.board) && !f.loading)"), "board loaded");
const idle = () => waitFor(() => !runtimeEntries(project).some(entry =>
  entry.task === "manager:background" || entry.role === "reviewer"), "maintenance released shared context and slot");
function due() {
  withRuntimeLock(dirname(queuePath), () => {
    const jobs = readQueue();
    for (const job of jobs) {
      job.retryAt = 0;
      job.cleanupRetryAt = 0;
    }
    writeFileSync(queuePath, JSON.stringify(jobs));
  });
}
async function tick() {
  globalThis.maintenanceTick();
  await delay(1000);
  await idle();
}
function submitted(title) {
  const draft = cli(["create"], plannedDraft({ title }));
  confirmFixtureDraft(project, draft.id);
  cli(["approve", draft.id]);
  const { worktree } = cli(["start", draft.id]);
  writeFileSync(join(worktree, draft.id + ".txt"), "accepted result\n");
  const preview = cli(["preview", draft.id]);
  const task = cli(["submit", draft.id], { token: preview.token, message: "feat: deliver fixture",
    summary: "Fixture result", checks: ["Fixture contents"] });
  return { task, worktree };
}
function accepted(title) {
  const { task, worktree } = submitted(title);
  writeFileSync(join(worktree, "unknown.local"), "unknown user data\n");
  const done = cli(["accept", task.id], { revision: task.revision });
  assert.equal(done.status, "done");
  writeFileSync(join(worktree, "source.txt"), "user edit\n");
  due();
  cli(["maintain"]);
  return { id: task.id, worktree, accepted: readFileSync(join(project, task.id + ".txt"), "utf8") };
}

process.env.GIT_CEILING_DIRECTORIES = scratch;
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
process.argv.push("--project", project);

void (async () => {
  try {
    if (!restart) {
      mkdirSync(project);
      git("init", "--initial-branch=main");
      git("config", "user.name", "Maintenance Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "maintenance.auto", "false");
      writeFileSync(join(project, "source.txt"), "baseline\n");
      writeFileSync(join(project, ".gitignore"), "*.local\n");
      git("add", "source.txt", ".gitignore");
      git("commit", "-m", "chore: fixture baseline");
      cli(["init"]);
      cli(["settings"], { autoMode: false, reviewMode: "human", taskLimits: { reviewer: 1 } });
      const fixtures = { old: accepted("Historical dirty"), fresh: accepted("New dirty"), clean: accepted("Clean control") };
      const jobs = readQueue();
      for (const job of jobs) {
        if (job.task === fixtures.old.id) {
          job.attempts = 59;
          job.repairAttempts = 8;
          delete job.repairFingerprint;
          delete job.claimedFingerprint;
        }
        job.retryAt = 0;
      }
      writeFileSync(queuePath, JSON.stringify(jobs));
      writeFileSync(manifestPath, JSON.stringify(fixtures));
      writeFileSync(callsPath, "[]");
      const modules = dirname(dirname(require.resolve("electron/package.json")));
      symlinkSync(modules, join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    }
    const fixtures = JSON.parse(readFileSync(manifestPath, "utf8"));
    globalThis.maintenanceProvider = async (_profile, cwd, prompt, _images, _action, _tools, instructions, _signal, session) => {
      assert.equal(cwd, project);
      const job = instructions.match(/Assigned job: \{"id":"([^"]+)"/);
      const calls = readCalls();
      calls.push(job ? job[1] : "manager");
      writeFileSync(callsPath, JSON.stringify(calls));
      if (session.messageId) {
        session.onMessage(session.messageId);
      }
      return { text: job ? "Cannot safely remove user files; retained." : "Manager available.", model: "Maintenance test provider" };
    };
    globalThis.maintenanceReviewer = async (_profile, cwd, _model, _prompt, _tools, _call, _signal, _usage, id) => {
      assert.equal(cwd, project);
      assert.ok(runtimeEntries(project).some(entry => entry.role === "reviewer"));
      const calls = readCalls();
      calls.push("review:" + id);
      writeFileSync(callsPath, JSON.stringify(calls));
      return { summary: "Fixture reviewed.", findings: [], evidence: ["Accepted result is present."], needsHuman: false };
    };
    const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8")
      .replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask")
      .replace("replyToTask, reviewWithCodex,", "replyToTask,")
      .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
    const entry = join(scratch, "main-under-test.mjs");
    writeFileSync(entry, transformSync("const replyToBoard = (...args) => globalThis.maintenanceProvider(...args);\n" +
      "const reviewWithCodex = (...args) => globalThis.maintenanceReviewer(...args);\n" + source +
      "\nglobalThis.maintenanceTick = scheduleRecurringTasks;" +
      "\nglobalThis.maintenanceWindow = () => createWindow([" + JSON.stringify(project) + "]).window;",
      { loader: "ts", format: "esm" }).code);
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    require(entry);
    const window = await waitFor(() => BrowserWindow.getAllWindows()[0], "main window");
    await ready(window);
    assert.equal(cli(["settings"]).autoMode, false);
    const mirror = globalThis.maintenanceWindow();
    await ready(mirror);

    if (!restart) {
      await waitFor(() => count(fixtures.fresh.id) === 1 && count(fixtures.clean.id) === 1, "first new repairs");
      await idle();
      assert.equal(count(fixtures.old.id), 0);
      pass("autoMode off; historical dirty launches=0, new dirty launches=1, control dirty launches=1; two Windows Electron windows.");
      due();
      cli(["maintain"]);
      await tick();
      await delay(16_000);
      await idle();
      assert.equal(count(fixtures.old.id), 0);
      assert.equal(count(fixtures.fresh.id), 1);
      pass("Expired saved delays and real periodic watcher: historical=0, new=1; no repeat.");
      mirror.destroy();
      const reopened = globalThis.maintenanceWindow();
      await ready(reopened);
      await tick();
      assert.equal(count(fixtures.fresh.id), 1);
      pass("Reopened second window: new dirty still launches=1.");

      writeFileSync(join(fixtures.fresh.worktree, "changed.txt"), "new cause\n");
      due();
      cli(["maintain"]);
      due();
      await tick();
      await waitFor(() => count(fixtures.fresh.id) === 2, "changed diagnostic evaluated");
      await idle();
      due();
      await tick();
      assert.equal(count(fixtures.fresh.id), 2);
      pass("Changed dirty file list: exactly one new evaluation, new dirty total launches=2; unchanged follow-up adds 0.");

      rmSync(join(fixtures.clean.worktree, "unknown.local"));
      execFileSync("git", ["restore", "--source=HEAD", "--worktree", "--", "source.txt"],
        { cwd: fixtures.clean.worktree, windowsHide: true });
      assert.equal(execFileSync("git", ["status", "--short", "--ignored"],
        { cwd: fixtures.clean.worktree, windowsHide: true, encoding: "utf8" }), "");
      due();
      cli(["maintain"]);
      await waitFor(() => !existsSync(fixtures.clean.worktree) &&
        !readQueue().some(job => job.task === fixtures.clean.id), "clean worktree and queue removed");
      pass("Control became clean: normal maintain removed worktree and queue entry; provider total stayed=1.");

      const attachmentOwner = join(scratch, "attachment-owner");
      mkdirSync(attachmentOwner);
      writeFileSync(join(attachmentOwner, "keep.txt"), "owner data\n");
      const attachmentLink = join(project, ".codex-attachments");
      symlinkSync(attachmentOwner, attachmentLink, process.platform === "win32" ? "junction" : "dir");
      cli(["maintain"]);
      for (let attempt = 1; attempt <= 3; attempt++) {
        due();
        await tick();
        await waitFor(() => readCalls().filter(call => call === "project:attachments").length === attempt, "temporary retry " + attempt);
        await idle();
      }
      due();
      await tick();
      assert.equal(readCalls().filter(call => call === "project:attachments").length, 3);
      // The ordinary successful attachment pass closes the control fault.
      assert.equal(readFileSync(join(attachmentOwner, "keep.txt"), "utf8"), "owner data\n");
      if (process.platform === "win32") {
        rmdirSync(attachmentLink);
      } else {
        unlinkSync(attachmentLink);
      }
      cli(["maintain"]);
      assert.equal(readQueue().some(job => job.id === "project:attachments"), false);
      assert.equal(readFileSync(join(attachmentOwner, "keep.txt"), "utf8"), "owner data\n");
      pass("Temporary fault: launches=3 with persisted release/backoff; fourth attempt excluded, successful maintenance clears fault.");

      cli(["settings"], { reviewMode: "reviewer-human" });
      const review = submitted("Ordinary independent review");
      await waitFor(() => readCalls().includes("review:" + review.task.id), "ordinary reviewer used shared slot");
      await idle();
      assert.equal(cli(["show", review.task.id]).status, "review");
      pass("Ordinary independent reviewer ran through the real scheduler with autoMode off and the one shared reviewer slot.");
    } else {
      due();
      cli(["maintain"]);
      await tick();
      await delay(11_000);
      assert.equal(count(fixtures.old.id), 0);
      assert.equal(count(fixtures.fresh.id), 2);
      pass("Second Electron process, reopened board and two windows: historical total=0, new total=2; unchanged causes add 0.");
    }

    for (const fixture of [fixtures.old, fixtures.fresh]) {
      assert.equal(readFileSync(join(fixture.worktree, "unknown.local"), "utf8"), "unknown user data\n");
      assert.equal(readFileSync(join(fixture.worktree, "source.txt"), "utf8"), "user edit\n");
      assert.equal(cli(["show", fixture.id]).status, "done");
      assert.equal(readFileSync(join(project, fixture.id + ".txt"), "utf8"), fixture.accepted);
      assert.ok(git("rev-parse", "--verify", "refs/heads/ai-taskboard/" + fixture.id));
    }
    await idle();
    const reviewer = registerRuntime(project, { task: "review:fixture", kind: "slot", role: "reviewer" });
    assert.ok(reviewer);
    reviewer();
    const reply = await window.webContents.executeJavaScript("window.taskboard.boardRequest('Check manager availability')");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.data.answer, "Manager available.");
    pass("Unknown bytes, tracked user edits, accepted results/status and needed branches preserved; shared reviewer slot and manager chat available.");
    lines.push(`Runtime: Windows=${process.platform}, arch=${process.arch}, Electron=${process.versions.electron}, Chromium=${process.versions.chrome}.`,
      "Linux/macOS: not run; common queue code uses node:path, node:crypto and existing runtime locks; process/window/packaging behavior unchanged.",
      "Provider calls: " + JSON.stringify(readCalls()), "Final queue: " + JSON.stringify(readQueue()),
      "Command: node scripts/check-maintenance-reopen.mjs --artifacts .tasks/qa", "Source SHA-256 (UTF-8 text, CRLF normalized to LF):");
    for (const path of ["src/cli/maintenance-state.ts", "src/cli/maintenance.ts", "src/cli/worktree.ts", "src/desktop/main.ts",
      "scripts/check-maintenance-reopen.mjs", "scripts/electron-check.mjs", "tests/maintenance-state.test.ts", "docs/explanation/architecture.md"]) {
      const text = readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      lines.push(createHash("sha256").update(text).digest("hex") + "  " + path);
    }
    writeFileSync(report, (restart ? readFileSync(report, "utf8") : "") + lines.join("\n") + "\n");
    app.exit(0);
  } catch (error) {
    console.error(error);
    const queue = existsSync(queuePath) ? readFileSync(queuePath, "utf8") : "not created";
    writeFileSync(report, lines.join("\n") + "\nFAIL " + error.stack + "\nQueue: " + queue + "\n");
    app.exit(1);
  }
})();
