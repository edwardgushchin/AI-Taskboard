// Run the desktop review queue against an isolated Git board and a test provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch } = electronCheck(import.meta.url, "reviewer-queue", 60_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const cli = (args, input) => {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input ? ["--stdin"] : []),
  ], { encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
async function waitFor(probe, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  mkdirSync(project);
  const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "Taskboard fixture");
  git("config", "--local", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial state");
  cli(["init"]);
  cli(["settings"], { reviewMode: "reviewer", autoMode: false });
  const task = cli(["create"], { title: "Review a submitted change", criteria: ["Result is present"] });
  const ready = cli(["approve", task.id]);
  const started = cli(["start", task.id], { revision: ready.revision });
  writeFileSync(join(started.worktree, "result.txt"), "Result for review\n");
  cli(["run-log", task.id, "--compact"], { durationMs: 1000, entries: [
    { id: "executor-final", type: "agentMessage", phase: "final_answer", title: "",
      text: "Executor finished.", status: "completed", at: new Date().toISOString() },
  ] });

  app.setPath("userData", join(scratch, "profile"));
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  process.argv.push("--project", project);
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("replyToTask, reviewWithCodex, updateBoardGoal", "replyToTask, updateBoardGoal")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync("const reviewWithCodex = globalThis.reviewQueueProvider;\n" + source,
    { loader: "ts", format: "esm" }).code);
  const calls = [];
  const report = { summary: "Test provider reviewed the submission.", needsHuman: true, findings: [], evidence: ["Result is present."] };
  globalThis.reviewQueueProvider = async (_profile, board, _settings, context, _tools, _call, _signal, _usage, id, publish) => {
    calls.push({ board, id, submission: JSON.parse(context).submitted });
    publish([{ id: "review-preparation", type: "agentMessage", phase: "commentary", title: "",
      text: "Test provider is reviewing.", status: "completed" }]);
    return report;
  };
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  const window = await waitFor(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading() && await win.webContents.executeJavaScript(
      "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)") && win;
  }, "the isolated board");
  assert.deepEqual(calls, []);
  const preview = cli(["preview", task.id, "--compact"]);
  const submitted = cli(["submit", task.id, "--compact"], {
    token: preview.token, message: "fix: supply result for review", summary: "Result saved", checks: ["Read result.txt"],
  });
  assert.equal(submitted.status, "review");
  const id = JSON.stringify(task.id);
  await waitFor(async () => {
    const result = await window.webContents.executeJavaScript(`window.taskboard.reviewerChat(${id})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data[0]?.durationMs !== undefined;
  }, "the queued reviewer attempt");
  await waitFor(() => cli(["show", task.id]).history.some(event =>
    event.action === "review-note" && event.text === report.summary), "the reviewer decision");
  assert.deepEqual(calls, [{ board: project, id: task.id, submission: submitted.git.submission.sha }]);
  console.log(`PASS Electron ${process.versions.electron} ${process.platform}: CLI submit queued one reviewer for ${submitted.git.submission.sha} and recorded its decision`);
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
