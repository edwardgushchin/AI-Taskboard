import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "reviewer-restart", 60_000,
  [["--write-review"], ["--read-review"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const writing = process.argv.includes("--write-review");
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const id = "T-0001";
app.setPath("appData", scratch);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
process.argv.push("--project", project);

async function seed() {
  const { initializeBoard, locateBoard } = require("../src/cli/storage.ts");
  const { changeTask, createTask, recordRunLog } = require("../src/cli/tasks.ts");
  const { record } = require("../src/cli/model.ts");
  const { readReviewerChat, withReviewerChat } = require("../src/desktop/reviewer-chat.ts");
  mkdirSync(project);
  mkdirSync(profile);
  writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
  const store = initializeBoard(locateBoard(project, true), store => store);
  let card = store.create(createTask(id, { title: "Review after restart", criteria: ["Review history survives restart"] }));
  card = record(card, "submit", "agent", "review", "Submission before review");
  for (const [number, action, summary] of [[1, "review-note", "Need a human decision."], [2, "review-approve", "Review approved."]]) {
    const items = [];
    if (number === 1) {
      items.push({ id: "summary-1", type: "reasoning", title: "", text: "Provider summary for attempt one.", status: "completed" });
    }
    items.push({ id: "tool-" + number, type: "dynamicToolCall", title: "task_review_diff " + number, text: "[]", status: "completed" });
    items.push({ id: "result-" + number, type: "agentMessage", phase: "final_answer", title: "", status: "completed",
      text: JSON.stringify({ summary, findings: [], evidence: ["Evidence for attempt " + number] }) });
    await withReviewerChat(project, id, () => {}, async publish => publish(items));
    if (number === 1) {
      const submissionAt = card.history.at(-1).at;
      card = recordRunLog(card, { durationMs: 38000, entries: [
        { id: "executor-final", type: "agentMessage", phase: "final_answer", title: "", status: "completed",
          at: submissionAt, text: "Executor response saved during review." },
      ] });
      const reviewAt = readReviewerChat(project, id)[0].at;
      card.history.at(-1).at = new Date(Date.parse(reviewAt) + 1).toISOString();
    }
    card = record(card, action, "reviewer", "review", summary);
    store.save(card);
  }
  const reason = "Fix the finding from the saved report.";
  card = record(card, "submit", "agent", "review");
  await withReviewerChat(project, id, () => {}, async publish => publish([
    { id: "result-3", type: "agentMessage", phase: "final_answer", title: "", status: "completed",
      text: JSON.stringify({ summary: "Changes requested.", findings: [reason] }) },
  ]));
  store.save(changeTask(card, "request-changes", { actor: "reviewer", reason }));
  let fallback = store.create(createTask("T-0002", { title: "Decision without journal" }));
  fallback = record(fallback, "submit", "agent", "review");
  store.save(record(fallback, "review-note", "reviewer", "review", "Decision from the card history."));
  let returned = store.create(createTask("T-0003", { title: "Return without journal" }));
  returned = record(returned, "submit", "agent", "review");
  store.save(changeTask(returned, "request-changes", {
    actor: "reviewer", reason: "[P1] Criterion 1: Repair the missing evaluation.",
  }));
  writeFileSync(join(scratch, "first-pid"), String(process.pid));
}

async function run() {
  if (writing) await seed();
  else assert.notEqual(process.pid, Number(readFileSync(join(scratch, "first-pid"), "utf8")));
  require("../src/desktop/main.ts");
  let window;
  async function waitFor(probe) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await delay(50);
    }
    throw new Error("Timed out waiting for the app or review feed");
  }
  await waitFor(async () => {
    [window] = BrowserWindow.getAllWindows();
    return window && !window.webContents.isLoading() && await window.webContents.executeJavaScript(
      `typeof frame !== 'undefined' && frame.project === ${JSON.stringify(project)} && Boolean(frame.board)`);
  });
  window.webContents.setBackgroundThrottling(false);
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate(`showTask(${JSON.stringify(id)})`);
  await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click()`);
  const rows = await waitFor(() => evaluate(`(() => {
    const feed = document.querySelector('#task-chat-work');
    const starts = [...feed.querySelectorAll('[data-chat-anchor^="review:"][data-chat-anchor*=":0:"]')];
    if (starts.length !== 3) return null;
    const attempts = [...feed.querySelectorAll('.chat-run[data-actor="reviewer"]')];
    return {
      text: feed.innerText,
      starts: starts.map(row => row.querySelector('time').dateTime),
      attempts: attempts.map(row => [...row.children].map(node => node.dataset.item?.split(':').at(-1))),
      summaryVisible: feed.querySelector('[data-item$=":summary-1"] pre')?.checkVisibility() ?? false
    };
  })()`));
  assert.deepEqual(rows.starts, [...rows.starts].sort());
  assert.equal(rows.summaryVisible, true);
  assert.deepEqual(rows.attempts, [
    ["summary-1", "tool-1", "result-1"], ["tool-2", "result-2"], ["result-3"],
  ]);
  assert.match(rows.text, /Executor response saved during review/);
  assert.equal(await evaluate("Boolean(document.querySelector('#task-review-history'))"), false);
  for (const text of ["Provider summary for attempt one.", "task_review_diff 1", "task_review_diff 2",
    "Need a human decision.", "Review approved.", "Evidence for attempt 1", "Evidence for attempt 2",
    "Fix the finding from the saved report."]) {
    assert.equal(rows.text.split(text).length - 1, 1, text);
  }
  if (!writing && keepArtifacts) {
    await window.webContents.capturePage();
    await delay(200);
    writeFileSync(join(artifacts, "review-after-restart.png"), (await window.webContents.capturePage()).toPNG());
  }
  await evaluate(`sheet.close(); showTask("T-0002")`);
  await evaluate(`document.querySelector("[aria-controls=task-chat-work]").click()`);
  assert.deepEqual(await evaluate(`api.reviewerChat("T-0002")`), { ok: true, data: { attempts: [], boundaries: [] } });
  assert.match(await evaluate(`document.querySelector('#task-chat-work').innerText`), /Decision from the card history/);
  await evaluate(`sheet.close(); showTask("T-0003")`);
  assert.deepEqual(await evaluate(`api.reviewerChat("T-0003")`), { ok: true, data: { attempts: [], boundaries: [] } });
  assert.match(await evaluate(`document.querySelector('#task-chat-dialogue').innerText`), /Repair the missing evaluation/);
  await evaluate(`document.querySelector("[aria-controls=task-chat-work]").click()`);
  const fallbackReason = await evaluate(`document.querySelector('#task-chat-work').innerText`);
  assert.match(fallbackReason, /Возврат на доработку/);
  assert.equal(fallbackReason.split("Repair the missing evaluation.").length - 1, 1);
  if (!writing && keepArtifacts) {
    await window.webContents.capturePage();
    await delay(200);
    writeFileSync(join(artifacts, "review-return-without-journal.png"), (await window.webContents.capturePage()).toPNG());
  }
  console.log(`PASS Electron ${process.versions.electron}, ${process.platform}, PID ${process.pid} (${writing ? "initial process" : "restarted process"}): three ordered attempts, one copy per decision, note and return available without a journal`);
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
