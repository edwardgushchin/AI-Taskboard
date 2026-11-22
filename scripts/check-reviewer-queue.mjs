import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Run the desktop review queue against an isolated Git board and a test provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const checks = ["push-review", "push-accept", "approval", "advanced-target", "human", "note",
  "busy-approval", "busy-return", "busy-target", "busy-revision", "busy-mode", "busy-reopen",
  "busy-failure", "busy-failure-observed", "busy-failure-reopen", "owner-requirements"];
const requested = process.argv.find(arg => arg.startsWith("--scenario="))?.slice("--scenario=".length);
if (requested && !checks.includes(requested)) throw new Error("Unknown review queue scenario: " + requested);
const { scratch, artifacts } = electronCheck(import.meta.url, "reviewer-queue", 120_000,
  (requested ? [requested] : checks).map(name => [name]));
const scenario = process.argv.at(-1);
const ownerScenario = scenario === "owner-requirements";
const busyScenario = scenario.startsWith("busy-");
const failureScenario = scenario.startsWith("busy-failure");
const reopensBoard = scenario === "busy-reopen" || scenario === "busy-failure-reopen";
const decisionCommand = scenario === "busy-return" ? "request-changes" : "review-approve";
const racedCommand = { "push-review": "review", "push-accept": "accept" }[scenario];
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
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
async function waitFor(probe, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
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
  const remote = join(scratch, scenario + ".git");
  const remoteHead = () => git("--git-dir=" + remote, "rev-parse", "refs/heads/main");
  if (racedCommand) {
    git("init", "--bare", remote);
    git("remote", "add", "origin", remote);
    git("push", "--set-upstream", "origin", "main");
    git("commit", "--allow-empty", "-m", "Commit to push");
  }
  cli(["init"]);
  cli(["settings"], {
    reviewMode: ownerScenario ? "reviewer-human" : "reviewer",
    autoMode: !ownerScenario && !busyScenario && scenario !== "note",
  });
  const initialCriterion = ownerScenario ? "Панель показывает количество доступных сбросов, включая ноль." : "Result is present";
  const task = cli(["create"], plannedDraft({ title: "Review a submitted change", criteria: [initialCriterion] }));
  confirmFixtureDraft(project, task.id);
  const ready = cli(["approve", task.id]);
  const started = cli(["start", task.id], { revision: ready.revision });
  writeFileSync(join(started.worktree, "result.txt"), ownerScenario ? "Доступно сбросов: 2\n" : "Result for review\n");
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
    findings: scenario === "busy-return" ? ["The result needs a corrected heading."] : [],
    evidence: ["Result is present."],
  };
  const initialHead = head();
  const preapprove = racedCommand || scenario === "advanced-target" || scenario === "human";
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
  // Leave a second submission for the dispatcher to process after the first
  // changes. It uses a different file so it can integrate independently.
  let independent;
  if (racedCommand) {
    const card = cli(["create"], plannedDraft({ title: "Independent submission", criteria: ["Result is present"] }));
    confirmFixtureDraft(project, card.id);
    const ready = cli(["approve", card.id]);
    const started = cli(["start", card.id], { revision: ready.revision });
    writeFileSync(join(started.worktree, "independent.txt"), "Independent result\n");
    const preview = cli(["preview", card.id, "--compact"]);
    independent = cli(["submit", card.id, "--compact"], {
      token: preview.token, message: "fix: supply independent result", summary: "Result saved", checks: ["Read independent.txt"],
    });
    cli(["review-approve", card.id, "--compact"], {
      targetHead: initialHead, revision: independent.revision, summary: report.summary, evidence: report.evidence,
    });
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
  let source = readFileSync(sourceUrl, "utf8")
    .replace("replyToTask, reviewWithCodex, updateBoardGoal", "replyToTask, updateBoardGoal")
    .replace("import { callCli,", "import { callCli as realCallCli,")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  if (ownerScenario) {
    source = source
      .replace("replyToTask, updateBoardGoal", "updateBoardGoal")
      .replace("missingCodexThread, startCodexRun", "missingCodexThread")
      .replace("codexStatus, configuredCodex,", "codexStatus,");
    source += `
const configuredCodex = async () => ({});
const replyToTask = globalThis.ownerDiscussionProvider;
const startCodexRun = globalThis.ownerExecutorProvider;
`;
  }
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(`const reviewWithCodex = globalThis.reviewQueueProvider;
const callCli = (...args) => globalThis.reviewQueueCli(realCallCli, ...args);
` + source + `
globalThis.openReviewTestWindow = projects => createWindow(projects).window;
globalThis.reviewPendingInWatch = (project, id) =>
  subscriptions.get(project)?.board.tasks.find(task => task.id === id)?.reviewPending;
`,
    { loader: "ts", format: "esm" }).code);
  const raceReleased = Promise.withResolvers();
  const autoErrors = [];
  let raceResult, pushResult;
  let held = false;
  let busy = busyScenario;
  const decisions = [];
  const startedReviews = [];
  const pendingFile = join(project, ".tasks", "review-history.json");
  const pendingDecision = () => existsSync(pendingFile) &&
    new Map(JSON.parse(readFileSync(pendingFile, "utf8"))).get(task.id)?.pendingDecision;
  const interruptGitOperation = () => writeFileSync(join(project, ".tasks", "pending", task.id + ".json"), "{}");
  globalThis.reviewQueueCli = async (call, board, args, input, options) => {
    if (scenario === "busy-return" && board === project && args[0] === "start" && args[1] === task.id) {
      // Verify the saved return and queue without starting an external executor.
      return { ok: false, error: { code: "EXECUTOR_LIMIT", message: "Test executor slot is occupied." } };
    }
    const race = !held && board === project && args[0] === racedCommand && args[1] === task.id;
    if (race) {
      held = true;
      await raceReleased.promise;
    }
    if (busyScenario && board === project && args[0] === decisionCommand && args[1] === task.id) {
      assert.equal(options?.retryBusy, false);
      const attempt = {
        at: performance.now(), revision: input.revision, targetHead: input.targetHead, modeVersion: input.reviewModeVersion,
      };
      decisions.push(attempt);
      let result;
      if (busy) {
        if (scenario === "busy-failure-observed" && decisions.length === 1) {
          interruptGitOperation();
          await waitFor(() => globalThis.reviewPendingInWatch(project, task.id), "the open board to see the Git operation");
        }
        if (scenario === "busy-approval" && decisions.length === 1) {
          const lock = new DatabaseSync(join(project, ".tasks", ".lock.sqlite"));
          lock.exec("BEGIN IMMEDIATE");
          try {
            result = await call(board, args, input, options);
            assert.equal(result.error?.code, "BOARD_BUSY");
          } finally {
            lock.close();
          }
        } else {
          result = { ok: false, error: { code: "BOARD_BUSY", message: "Test board is temporarily busy." } };
        }
      } else {
        if (scenario === "busy-failure") {
          interruptGitOperation();
        } else if (failureScenario) {
          assert.equal(globalThis.reviewPendingInWatch(project, task.id), true);
          attempt.operationVisible = true;
        }
        result = await call(board, args, input, options);
      }
      attempt.code = result.ok ? "OK" : result.error.code;
      attempt.message = result.error?.message;
      attempt.completed = performance.now();
      return result;
    }
    const result = await call(board, args, input, options);
    if (race) raceResult = result;
    if (board === project && args[0] === "git" && args[1] === "push") pushResult = result;
    return result;
  };
  const calls = [];
  const ownerMessage = "Сбросы нужно писать под полосой лимитов и нужно перечислить их со сроком экспирации";
  const ownerCriterion = "Под полосой лимитов есть список сбросов со сроком каждого.";
  const zeroDefect = "При нулевом остатке пропадает счётчик.";
  const listDefect = "В сдаче пропал обязательный список сбросов со сроками.";
  const ownerQuestion = "Список требуется постановкой, но занимает три строки. Владелец, хотите удалить его из требований?";
  const reviewInputs = [];
  const executorInputs = [];
  const releaseClarifiedReview = Promise.withResolvers();
  let clarificationReview;
  const activeCriteria = [initialCriterion, ownerCriterion];
  const assertBrief = ({ description, criteria }) => {
    assert.ok(description.includes(ownerMessage));
    assert.deepEqual(criteria, activeCriteria);
  };
  if (ownerScenario) {
    globalThis.ownerDiscussionProvider = async (_profile, _project, _settings, prompt, _images, _update, call) => {
      const { latestUserMessage } = JSON.parse(prompt);
      if (latestUserMessage.text === "Может, переделать список?") {
        return { text: "Что именно нужно изменить в списке?", awaitingAnswer: true };
      }
      assert.equal(latestUserMessage.text, ownerMessage);
      const updated = await call("task_update", {
        authorization: ownerMessage, description: task.description + "\n\n" + ownerMessage, criteria: activeCriteria,
      });
      assert.ok(updated.ok, JSON.stringify(updated));
      assert.equal(updated.data.status, "review");
      const clarified = show();
      assertBrief(clarified);
      assert.deepEqual(clarified.history.find(event => event.action === "submit").submissionBrief.criteria, [initialCriterion]);
      return { text: "Уточнение сохранено.", awaitingAnswer: false };
    };
    globalThis.ownerExecutorProvider = async (_client, board, cwd, input, _activity, _usage, _signal, beforeTurn) => {
      assert.equal(board, project);
      assertBrief(input);
      const index = executorInputs.length;
      assert.equal(input.feedback, [listDefect, zeroDefect, listDefect][index]);
      executorInputs.push(input.feedback);
      const threadId = input.codexThreadId ?? "20000000-0000-0000-0000-000000000001";
      const queued = await beforeTurn(threadId, index === 0);
      queued?.accepted("fixture-turn-" + index);
      const results = [
        "Доступно сбросов: 2\nСрок: 2026-12-01\nСрок: 2026-12-02\n",
        "Доступно сбросов: 0\n",
        "Доступно сбросов: 0\nСрок: 2026-12-01\n",
      ];
      const completion = delay(100).then(() => {
        writeFileSync(join(cwd, "result.txt"), results[index]);
        submit();
      });
      return { threadId, completion, interrupt: async () => {} };
    };
  }
  globalThis.reviewQueueProvider = async (_profile, board, _settings, context, _tools, _call, _signal, _usage, id, publish) => {
    if (ownerScenario) {
      const input = JSON.parse(context);
      if (!input.feedback) {
        if (input.criteria.length === 1) {
          assert.deepEqual(input.criteria, [initialCriterion]);
          assert.match(git("show", input.submitted + ":result.txt"), /Доступно сбросов: 2/);
          return {
            summary: "Счётчик подтверждён.",
            needsHuman: false,
            findings: [],
            evidence: ["Сдача показывает счётчик."],
          };
        }
        assertBrief(input);
        clarificationReview ??= input;
        await releaseClarifiedReview.promise;
        assert.doesNotMatch(git("show", input.submitted + ":result.txt"), /Срок:/);
        return {
          summary: "Проверена исходная сдача по уточнённой постановке.",
          needsHuman: false,
          findings: [listDefect],
          evidence: ["Сдача показывает счётчик.", null],
        };
      }
      assertBrief(input);
      const result = git("show", input.submitted + ":result.txt");
      const findings = [];
      const hasZero = result.includes("Доступно сбросов: 0");
      const hasList = result.includes("Срок:");
      if (!hasZero) findings.push(zeroDefect);
      if (!hasList) findings.push(listDefect);
      if (!input.candidateReview) reviewInputs.push({ feedback: input.feedback, hasZero, hasList, findings });
      return {
        summary: "Проверены счётчик и список сбросов.",
        needsHuman: false,
        findings,
        evidence: [hasZero ? "Нулевой счётчик есть." : null, hasList ? "Сроки сбросов есть." : null],
        ownerQuestion: hasList ? ownerQuestion : null,
      };
    }
    const { submitted: submission, targetHead, revision, reviewModeVersion, candidateReview } = JSON.parse(context);
    if (!candidateReview) startedReviews.push({ revision, targetHead, reviewModeVersion });
    calls.push({ board, id, submission, targetHead });
    assert.equal(cli(["show", id]).status, "review");
    assert.equal(head(), targetHead);
    publish([{ id: "review-preparation", type: "agentMessage", phase: "commentary", title: "",
      text: "Test provider is reviewing.", status: "completed" }]);
    return report;
  };
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  app.on("browser-window-created", (_event, { webContents }) => {
    const send = webContents.send.bind(webContents);
    webContents.send = (channel, ...args) => {
      if (channel === "chat:update" && args[0]?.type === "orchestrator-review-error" && args[0].error) {
        autoErrors.push(args[0].error);
      }
      return send(channel, ...args);
    };
  });
  require(entry);
  const window = await waitFor(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading() && await win.webContents.executeJavaScript(
      "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)") && win;
  }, "the isolated board");
  if (ownerScenario) {
    const inspect = () => cli(["review", task.id, "--compact"]);
    const send = text => window.webContents.executeJavaScript(
      `window.taskboard.chatSend(${JSON.stringify(task.id)}, ${JSON.stringify({ text, files: [], model: "fixture", effort: "low" })})`);
    const unclear = await send("Может, переделать список?");
    assert.ok(unclear.saved && unclear.result.ok, JSON.stringify(unclear));
    assert.ok(show().awaitingAnswer);
    assert.deepEqual(show().criteria, [initialCriterion]);
    const initial = submit();
    const approved = await waitFor(() => {
      const review = inspect();
      return review.awaitingHumanAcceptance && review;
    }, "approval under the initial brief");
    assert.equal(approved.submitted, initial.git.submission.sha);
    const correction = await send(ownerMessage);
    assert.ok(correction.saved && correction.result.ok, JSON.stringify(correction));
    const updatedReview = inspect();
    assert.equal(updatedReview.submitted, approved.submitted);
    assert.ok(updatedReview.revision > approved.revision);
    assert.equal(updatedReview.reviewerApproval, undefined);
    assert.equal(updatedReview.awaitingHumanAcceptance, false);
    assert.equal(show().history.filter(event => event.action === "request-changes").length, 0);
    const prematureAcceptance = await window.webContents.executeJavaScript(
      `window.taskboard.command("accept", ${JSON.stringify(task.id)}, ${JSON.stringify({
        revision: updatedReview.revision, targetHead: updatedReview.targetHead, reviewModeVersion: updatedReview.reviewModeVersion,
      })})`);
    assert.equal(prematureAcceptance.error.code, "REVIEW_REQUIRED");
    await waitFor(() => clarificationReview, "automatic re-review after clarification");
    assert.ok(clarificationReview.revision > approved.revision);
    // The review can start before the agent's acknowledgement is added to history.
    assert.ok(clarificationReview.revision <= updatedReview.revision);
    assert.equal(clarificationReview.submitted, approved.submitted);
    assertBrief(clarificationReview);
    releaseClarifiedReview.resolve();
    const waiting = await waitFor(() => {
      if (reviewInputs.length !== 3) return;
      const review = inspect();
      return review.awaitingHumanAcceptance && review;
    }, "approval of the repaired submission", 60_000).catch(error => {
      const card = show();
      console.error(JSON.stringify({
        status: card.status, executorInputs, reviewInputs, autoErrors, blocked: card.blocked,
        events: card.history.map(event => event.action),
      }));
      throw error;
    });
    assert.deepEqual(executorInputs, [listDefect, zeroDefect, listDefect]);
    assert.deepEqual(reviewInputs, [
      { feedback: listDefect, hasZero: false, hasList: true, findings: [zeroDefect] },
      { feedback: zeroDefect, hasZero: true, hasList: false, findings: [listDefect] },
      { feedback: listDefect, hasZero: true, hasList: true, findings: [] },
    ]);
    const reviewed = show();
    const submissions = reviewed.history.filter(event => event.action === "submit");
    assert.equal(submissions.length, 4);
    const approvals = reviewed.history.filter(event => event.action === "review-approve");
    assert.ok(approvals.some(event => event.reviewApproval.revision === approved.revision));
    assert.equal(approvals.at(-1).reviewApproval.revision, waiting.revision);
    assert.deepEqual(submissions[0].submissionBrief.criteria, [initialCriterion]);
    assert.deepEqual(submissions.slice(1).map(event => event.submissionBrief.criteria), [activeCriteria, activeCriteria, activeCriteria]);
    assert.equal(git("show", initial.git.submission.sha + ":result.txt"), "Доступно сбросов: 2");
    const proposal = reviewed.history.findLast(event => event.expertMessage?.to === "owner");
    assert.equal(proposal?.text, ownerQuestion);
    assert.equal(proposal.messageKind, "question");
    assert.equal(head(), initialHead);
    let response = 0;
    let confirmationCount = 0;
    dialog.showMessageBox = async () => {
      confirmationCount++;
      return { response };
    };
    const acceptInput = {
      revision: waiting.revision, targetHead: waiting.targetHead, reviewModeVersion: waiting.reviewModeVersion,
      message: "fix: integrate expiration list",
    };
    const accept = () => window.webContents.executeJavaScript(
      `window.taskboard.command("accept", ${JSON.stringify(task.id)}, ${JSON.stringify(acceptInput)})`);
    assert.equal((await accept()).error.code, "ACCEPTANCE_CANCELLED");
    assert.equal(show().status, "review");
    response = 1;
    assert.equal((await accept()).data.status, "done");
    assert.equal(confirmationCount, 2);
    assert.equal(show().history.filter(event => event.action === "accept").length, 1);
    assert.match(git("show", "HEAD:result.txt"), /Срок: 2026-12-01/);
    assert.deepEqual(autoErrors, []);
    const paths = [
      "scripts/check-reviewer-queue.mjs", "scripts/electron-check.mjs",
      "src/cli/acceptance.ts", "src/cli/expert-team.ts", "src/cli/main.ts", "src/cli/model.ts", "src/cli/tasks.ts",
      "src/desktop/board-actions.ts", "src/desktop/chat-actions.ts", "src/desktop/codex-chat.ts",
      "src/desktop/codex-run.ts", "src/desktop/main.ts",
    ];
    const sourceHash = path => {
      const bytes = readFileSync(new URL("../" + path, import.meta.url), "utf8");
      return createHash("sha256").update(bytes.replace(/\r\n/g, "\n"), "utf8").digest("hex");
    };
    const report = [
      "PASS T-0333. Изолированный Git-проект и Windows Electron с тестовыми провайдерами.",
      `ОС ${process.platform} ${release()} ${process.arch}; Electron ${process.versions.electron}, Node ${process.versions.node}.`,
      "Команда: node scripts/check-reviewer-queue.mjs --scenario=owner-requirements --artifacts .tasks/qa",
      "Неоднозначная фраза открыла вопрос и сохранила критерии. Первая сдача получила одобрение. Точное уточнение T-0319 обновило описание и критерии, сняло одобрение и заблокировало ручную приёмку.",
      "Диалог не вызывал возврат. Автоматическое ревью получило ту же сдачу и новые критерии и вернуло отсутствие списка как дефект.",
      "Три запуска исполнителя и три последующих ревью получили уточнение в постановке и отдельное замечание.",
      "Подтверждённый дефект нулевого счётчика вернул сдачу. Контрольная сдача с нулевым счётчиком без списка вернулась с дефектом списка.",
      "История всех четырёх сдач и снимок постановки первой сохранены. Восстановленная сдача одобрена при открытом вопросе владельцу.",
      "Ручная приёмка через IPC Electron проверена с заглушкой кнопок нативного диалога: отмена сохранила ревью, подтверждение интегрировало результат.",
      "Linux и macOS не запускались. Содержимое панели заменено текстовой фикстурой. Живые модели не вызывались.",
      "SHA-256 исходников, UTF-8 с переводами строк LF после нормализации CRLF:",
      ...paths.map(path => sourceHash(path) + "  " + path),
    ].join("\n") + "\n";
    writeFileSync(join(artifacts, "owner-requirement-approval-check.txt"), report);
    console.log(report);
    return;
  }
  if (busyScenario) {
    const frameReady = win => !win.webContents.isLoading() && win.webContents.executeJavaScript(
      "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)");
    let checkWindow = window;
    if (scenario === "busy-approval") {
      const second = globalThis.openReviewTestWindow([project]);
      await waitFor(() => frameReady(second), "the second window");
    }
    submitted = submit();
    await waitFor(() => decisions[0]?.code === "BOARD_BUSY" && pendingDecision(), "the stored decision");
    assert.equal(startedReviews.length, 1);
    assert.deepEqual(autoErrors.filter(Boolean), []);

    if (scenario === "busy-approval" || scenario === "busy-return") {
      await waitFor(() => decisions[1]?.code === "BOARD_BUSY", "a second blocked write");
      assert.ok(decisions[1].at - decisions[0].completed >= 995, "the next write must wait at least one second");
      assert.equal(show().status, "review");
    } else if (scenario === "busy-target") {
      git("commit", "--allow-empty", "-m", "Advance the target during the deferred write");
    } else if (scenario === "busy-revision") {
      const revised = cli(["update", task.id, "--compact"], {
        title: "Updated review fixture", revision: submitted.revision, preserveStatus: true,
      });
      assert.equal(revised.status, "review");
      assert.notEqual(revised.revision, submitted.revision);
    } else if (scenario === "busy-mode") {
      cli(["settings"], { reviewMode: "human" });
      await waitFor(() => !pendingDecision(), "discarding the decision in manual review mode");
      assert.equal(startedReviews.length, 1);
      assert.equal(decisions.length, 1);
      assert.equal(show().history.filter(event => event.action === decisionCommand).length, 0);
      cli(["settings"], { reviewMode: "reviewer" });
    } else if (reopensBoard) {
      globalThis.openReviewTestWindow([]);
      window.close();
      await waitFor(() => window.isDestroyed(), "the original board window to close");
      const attemptsWhileClosed = decisions.length;
      await delay(1300);
      assert.equal(decisions.length, attemptsWhileClosed);
      assert.ok(pendingDecision());
      if (failureScenario) {
        interruptGitOperation();
        busy = false;
      }
      checkWindow = globalThis.openReviewTestWindow([project]);
      await waitFor(() => frameReady(checkWindow), "the reopened board");
    }
    busy = false;
    if (failureScenario) {
      const cause = await waitFor(() => decisions.find(attempt => attempt.code && attempt.code !== "BOARD_BUSY"), "the terminal CLI error");
      assert.equal(cause.code, "PENDING_OPERATION");
      await waitFor(() => autoErrors.some(error => error?.includes(cause.message)), "the reported cause");
      await waitFor(() => checkWindow.webContents.executeJavaScript(`document.body.innerText.includes(
        ${JSON.stringify(cause.message)})`), "the cause visible in the renderer");
      if (scenario !== "busy-failure") assert.equal(cause.operationVisible, true);
      if (scenario === "busy-failure-reopen") {
        checkWindow.setContentSize(1280, 800);
        checkWindow.webContents.setZoomFactor(1);
        await waitFor(() => checkWindow.webContents.executeJavaScript(
          "innerWidth === 1280 && innerHeight === 800"), "the failure screenshot viewport");
        writeFileSync(join(artifacts, "review-busy-failure.png"), (await checkWindow.webContents.capturePage()).toPNG());
      }
      await delay(1600);
      assert.equal(decisions.at(-1), cause);
      assert.equal(calls.length, 1);
      assert.equal(autoErrors.length, 1);
      assert.equal(show().history.filter(event => event.action === decisionCommand).length, 0);
      assert.equal(pendingDecision(), undefined);
    } else {
      const action = decisionCommand;
      const finished = await waitFor(() => {
        const card = show();
        return card.history.some(event => event.action === action) && card;
      }, action);
      const events = finished.history.filter(event => event.action === action);
      assert.equal(events.length, 1);
      const stale = ["busy-target", "busy-revision", "busy-mode"].includes(scenario);
      assert.equal(startedReviews.length, stale ? 2 : 1);
      if (scenario === "busy-mode") assert.notEqual(decisions[0].modeVersion, events[0].reviewApproval.reviewModeVersion);
      if (action === "review-approve") {
        assert.equal(events[0].reviewApproval.targetHead, head());
        assert.equal(events[0].reviewApproval.revision, finished.revision);
      } else {
        assert.equal(events[0].text, report.findings[0]);
        assert.equal(finished.status, "in_progress");
        assert.equal(finished.reviewReturn, finished.revision);
      }
      await waitFor(() => decisions.some(attempt => attempt.code === "OK"), "the completed decision command");
      assert.equal(decisions.filter(attempt => attempt.code === "OK").length, 1);
      assert.deepEqual(autoErrors.filter(Boolean), []);
      if (scenario === "busy-reopen") {
        const attemptsAfterSave = decisions.length;
        await delay(1300);
        assert.equal(decisions.length, attemptsAfterSave);
        assert.equal(pendingDecision(), undefined);
      }
      if (scenario === "busy-approval") {
        const windows = BrowserWindow.getAllWindows();
        assert.equal(windows.length, 2);
        for (const win of windows) {
          await waitFor(() => win.webContents.executeJavaScript(`window.taskboard.bootstrap().then(frame =>
            frame.board?.tasks.some(task => task.id === ${JSON.stringify(task.id)} && task.reviewApproved))`), "approval in both windows");
        }
        checkWindow.setContentSize(1280, 800);
        checkWindow.webContents.setZoomFactor(1);
        await delay(350);
        const view = await checkWindow.webContents.executeJavaScript("({ width: innerWidth, height: innerHeight, text: document.body.innerText })");
        assert.deepEqual([view.width, view.height], [1280, 800]);
        assert.match(view.text, /Review a submitted change/);
        assert.doesNotMatch(view.text, /Авторевью прервалось|Automatic review was interrupted/i);
        writeFileSync(join(artifacts, "review-busy-recovery.png"), (await checkWindow.webContents.capturePage()).toPNG());
      }
    }
    console.log(JSON.stringify({ scenario, startedReviews, decisions, errors: autoErrors.filter(Boolean) }));
    return;
  }
  if (racedCommand) {
    await waitFor(() => held, "queued " + racedCommand);
    const evaluate = code => window.webContents.executeJavaScript(code);
    const push = async () => {
      pushResult = undefined;
      await waitFor(() => evaluate(`(() => {
        const button = document.querySelector('#status-tracking');
        if (!button || button.hidden || button.disabled) return false;
        button.click();
        return true;
      })()`), "enabled Push button");
      return waitFor(() => pushResult, "push response");
    };
    const beforePush = remoteHead();
    assert.notEqual(beforePush, initialHead);
    assert.equal(show().status, "review");
    assert.equal((await push()).ok, true);
    assert.equal(remoteHead(), initialHead);
    assert.equal(head(), initialHead);
    assert.equal(show().status, "review");
    if (scenario === "push-accept") {
      writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      // Pushing an already current ref skips server-side hooks. Move the
      // fixture's remote ref back to its starting point to exercise rejection.
      git("--git-dir=" + remote, "update-ref", "refs/heads/main", beforePush, initialHead);
      const rejected = await push();
      assert.equal(rejected.error?.code, "GIT_PUSH_FAILED");
      assert.equal(remoteHead(), beforePush);
      assert.equal(head(), initialHead);
      await waitFor(() => evaluate("!document.querySelector('#notice').hidden"), "visible push error");
      assert.match(await evaluate("document.querySelector('#notice').textContent"), /Pushing commits|Отправка коммитов/i);
      console.log(JSON.stringify({ pushRejected: rejected.error.code, remoteHead: remoteHead() }));
    }
    const revision = show().revision;
    const changed = racedCommand === "review" ? cli(["return-to-draft", task.id], { revision }) :
      cli(["accept", task.id], { revision, targetHead: initialHead, actor: "manager", reviewMode: "reviewer", autoMode: true });
    assert.equal(changed.status, racedCommand === "review" ? "draft" : "done");
    const integrationHead = head();
    raceReleased.resolve();
    await waitFor(() => raceResult, "raced " + racedCommand + " response");
    assert.equal(raceResult.error?.code, racedCommand === "review" ? "INVALID_TRANSITION" : "REVIEW_REQUIRED");
    const done = await waitFor(() => {
      const card = cli(["show", independent.id]);
      return card.status === "done" && card;
    }, "independent integration");
    const checked = show();
    assert.equal(checked.status, changed.status);
    const firstAccepts = checked.history.filter(event => event.action === "accept").length;
    assert.equal(firstAccepts, racedCommand === "review" ? 0 : 1);
    assert.equal(done.history.filter(event => event.action === "accept").length, 1);
    assert.equal(git("rev-list", "--count", "--first-parent", integrationHead + "..HEAD"), "1");
    console.log(JSON.stringify({ scenario, pushed: initialHead, localHeadAtPush: initialHead, rejected: racedCommand,
      code: raceResult.error.code, details: raceResult.error.details, statusAtRejection: changed.status,
      firstAccepts, independent: done.status, independentIntegrations: 1, autoErrors }));
    assert.deepEqual(autoErrors, []);
    if (scenario === "push-review") {
      await waitFor(() => evaluate(`window.taskboard.bootstrap().then(f =>
        f.board?.tasks.some(t => t.id === ${JSON.stringify(task.id)} && t.status === 'draft') &&
        f.board?.tasks.some(t => t.id === ${JSON.stringify(independent.id)} && t.status === 'done'))`), "updated cards");
      await delay(450); // Let the cards settle into their new columns.
      writeFileSync(join(artifacts, "push-during-review.png"), (await window.webContents.capturePage()).toPNG());
    }
    return;
  }
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
