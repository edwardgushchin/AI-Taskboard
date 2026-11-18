// Run the desktop review queue against an isolated Git board and a test provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch } = electronCheck(import.meta.url, "reviewer-queue", 120_000,
  [["approval"], ["advanced-target"], ["human"], ["note"]]);
const scenario = process.argv.at(-1);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, scenario);
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  mkdirSync(project);
  const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true, encoding: "utf8" }).trim();
  const head = () => git("rev-parse", "HEAD");
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "Taskboard fixture");
  git("config", "--local", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial state");
  cli(["init"]);
  cli(["settings"], { reviewMode: "reviewer", autoMode: scenario !== "note" });
  const task = cli(["create"], { title: "Review a submitted change", criteria: ["Result is present"] });
  const ready = cli(["approve", task.id]);
  const started = cli(["start", task.id], { revision: ready.revision });
  writeFileSync(join(started.worktree, "result.txt"), "Result for review\n");
  cli(["run-log", task.id, "--compact"], { durationMs: 1000, entries: [
    { id: "executor-final", type: "agentMessage", phase: "final_answer", title: "",
      text: "Executor finished.", status: "completed", at: new Date().toISOString() },
  ] });

  const submit = () => {
    const preview = cli(["preview", task.id, "--compact"]);
    const submitted = cli(["submit", task.id, "--compact"], {
      token: preview.token, message: "fix: supply result for review", summary: "Result saved", checks: ["Read result.txt"],
    });
    assert.equal(submitted.status, "review");
    return submitted;
  };
  const show = () => cli(["show", task.id]);
  const report = {
    summary: "Test provider reviewed the submission.", needsHuman: scenario === "note",
    findings: [], evidence: ["Result is present."],
  };
  const initialHead = head();
  const preapprove = scenario === "advanced-target" || scenario === "human";
  let submitted;
  if (preapprove) {
    submitted = submit();
    cli(["review-approve", task.id, "--compact"], {
      targetHead: initialHead, revision: submitted.revision, summary: report.summary, evidence: report.evidence,
    });
    if (scenario === "advanced-target") git("commit", "--allow-empty", "-m", "Advance the target");
    const dispatcher = cli(["review", task.id, "--compact"]);
    const json = cli(["review", task.id], { compact: true });
    const full = cli(["review", task.id]);
    console.log(JSON.stringify({ scenario, dispatcherHead: dispatcher.targetHead,
      dispatcherApproval: dispatcher.reviewerApproval ?? null, jsonApproval: json.reviewerApproval ?? null }));
    assert.equal(json.reviewerApproval.targetHead, initialHead);
    assert.equal(full.targetHead, head());
    assert.match(full.diff, /\+Result for review/);
    assert.equal(full.reviewerApproval, undefined);
    assert.deepEqual(dispatcher, json);
    if (scenario === "human") cli(["settings"], { reviewMode: "human" });
  }
  const integrationBase = head();

  app.setPath("userData", join(scratch, "profile-" + scenario));
  app.setPath("appData", join(scratch, "app-data-" + scenario));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  process.argv.push("--project", project);
  const modules = join(scratch, "node_modules");
  if (!existsSync(modules)) symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), modules, "junction");
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("replyToTask, reviewWithCodex, updateBoardGoal", "replyToTask, updateBoardGoal")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync("const reviewWithCodex = globalThis.reviewQueueProvider;\n" + source,
    { loader: "ts", format: "esm" }).code);
  const calls = [];
  globalThis.reviewQueueProvider = async (_profile, board, _settings, context, _tools, _call, _signal, _usage, id, publish) => {
    const { submitted: submission, targetHead } = JSON.parse(context);
    calls.push({ board, id, submission, targetHead });
    assert.equal(show().status, "review");
    assert.equal(head(), integrationBase);
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
  if (!preapprove) {
    assert.deepEqual(calls, []);
    submitted = submit();
  }
  const expectedCalls = [{ board: project, id: task.id, submission: submitted.git.submission.sha, targetHead: integrationBase }];
  if (scenario === "human") {
    await delay(2500);
    assert.deepEqual(calls, []);
    assert.equal(show().status, "review");
    assert.equal(head(), integrationBase);
    console.log("PASS human review: approved submission stayed in review with an unchanged target");
    return;
  }
  if (scenario !== "note") {
    const done = await waitFor(() => {
      const card = show();
      return card.status === "done" && card;
    }, "automatic integration").catch(error => {
      const card = show();
      if (card.status === "review") {
        const dispatcher = cli(["review", task.id, "--compact"]);
        const json = cli(["review", task.id], { compact: true });
        console.error(JSON.stringify({ scenario, status: card.status, head: head(), calls,
          dispatcherHead: dispatcher.targetHead, dispatcherApproval: dispatcher.reviewerApproval ?? null,
          jsonApproval: json.reviewerApproval ?? null }));
      }
      throw error;
    });
    const approvals = done.history.filter(event => event.action === "review-approve").map(event => event.reviewApproval.targetHead);
    assert.deepEqual(approvals, preapprove ? [initialHead, integrationBase] : [integrationBase]);
    assert.deepEqual(calls, expectedCalls);
    assert.equal(git("rev-list", "--count", "--first-parent", integrationBase + "..HEAD"), "1");
    assert.equal(git("rev-parse", "HEAD^1", "HEAD^2"), integrationBase + "\n" + submitted.git.submission.sha);
    assert.equal(git("show", "HEAD:result.txt"), "Result for review");
    console.log(JSON.stringify({ scenario, status: done.status, reviewerRuns: calls.length,
      approvals, integration: head(), integrationCommits: 1 }));
    return;
  }
  const id = JSON.stringify(task.id);
  await waitFor(async () => {
    const result = await window.webContents.executeJavaScript(`window.taskboard.reviewerChat(${id})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data[0]?.durationMs !== undefined;
  }, "the queued reviewer attempt");
  await waitFor(() => cli(["show", task.id]).history.some(event =>
    event.action === "review-note" && event.text === report.summary), "the reviewer decision");
  assert.deepEqual(calls, expectedCalls);
  console.log(`PASS Electron ${process.versions.electron} ${process.platform}: CLI submit queued one reviewer for ${submitted.git.submission.sha} and recorded its decision`);
}

console.log(`Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}: ${scenario}`);
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
