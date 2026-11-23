import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { locateBoard, onBoard } from "../src/cli/storage.ts";

const { scratch, artifacts } = electronCheck(import.meta.url, "card-review-mode", 240_000,
  [["auto-on"], ["auto-off"], ["restart"]]);
const phase = process.argv.at(-1);
const autoMode = phase === "auto-on";
const project = join(scratch, phase === "restart" ? "auto-off" : phase);
const reportFile = join(artifacts, "card-review-mode-check.txt");
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { transformSync } = require("esbuild");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function runCommand(command, args, input) {
  const result = spawnSync(command, args, { cwd: project, encoding: "utf8", input, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function reply(args, input) {
  const result = runCommand(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input ? ["--stdin"] : []),
  ], input && JSON.stringify(input));
  return JSON.parse(result.stdout);
}

function cli(args, input) {
  const result = reply(args, input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

function git(...args) {
  const result = runCommand("git", args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const show = id => cli(["show", id]);
const review = id => cli(["review", id, "--compact"]);
const action = "task_set_review_mode";
const evidence = ["The submitted file contains the result."];
const log = text => { console.log(text); appendFileSync(reportFile, text + "\n"); };

async function waitFor(probe, label) {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(250);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  if (autoMode) {
    const paths = [
      "scripts/check-card-review-mode.mjs",
      "src/desktop/chat-actions.ts",
      "src/desktop/chat.js",
      "src/desktop/codex-chat.ts",
      "src/desktop/locales/en.json",
      "src/desktop/locales/ru.json",
      "src/desktop/main.ts",
      "src/desktop/preload.cjs",
      "src/desktop/renderer.js",
    ];
    const hashes = paths.map(path => {
      const source = readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      return createHash("sha256").update(source).digest("hex") + "  " + path;
    });
    const base = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", windowsHide: true,
    });
    assert.equal(base.status, 0, base.stderr);
    writeFileSync(reportFile, [
      "Command: node scripts/check-card-review-mode.mjs --artifacts .tasks/qa",
      "Tested worktree HEAD: " + base.stdout.trim(),
      "SHA-256 (UTF-8 with LF line endings):",
      ...hashes,
      "",
    ].join("\n"));
  }
  log(`${phase}: Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}`);
  if (phase !== "restart") {
    mkdirSync(project);
    git("init", "--initial-branch=main");
    git("config", "user.name", "Taskboard fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "Initial state");
    cli(["init"]);
    cli(["settings"], { reviewMode: "reviewer", autoMode });
    onBoard(locateBoard(project), store => {
      store.index.nextId = 319;
      store.saveIndex();
    });
  }
  const create = title => cli(["create"], plannedDraft({ title, criteria: evidence })).id;
  const hybrid = phase === "restart" ? "T-0319" : create("Personal acceptance");
  const normal = phase === "restart" ? "T-0320" : create("Inherited review");
  assert.equal(hybrid, "T-0319");
  if (phase !== "restart") {
    for (const id of [hybrid, normal]) {
      confirmFixtureDraft(project, id);
      const ready = cli(["approve", id]);
      const started = cli(["start", id], { revision: ready.revision });
      writeFileSync(join(started.worktree, id + ".txt"), id + "\n");
    }
  }
  function submit(id) {
    const { token } = cli(["preview", id, "--compact"]);
    cli(["submit", id], { token, message: "fix: add " + id, summary: "Saved", checks: evidence });
  }

  const release = Promise.withResolvers();
  const resumeNormal = Promise.withResolvers();
  let held, raced;
  let pausedAcceptance, retryRejection, retryCount = 0;
  const observed = [];
  const receipts = [];
  const replies = new Map();
  const changeReviewMode = (call, input) => waitFor(async () => {
    const result = await call(action, input);
    return (result.ok || result.error.code !== "BOARD_BUSY") && result;
  }, "the review mode tool result");
  const queueAdds = [];
  let attachmentGate;
  ipcMain.handle("fixture:prepare-attachment", async (_event, name) => {
    if (name !== "delayed.txt" || !attachmentGate) return;
    const gate = attachmentGate;
    attachmentGate = undefined;
    gate.started.resolve();
    await gate.release.promise;
  });
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel !== "board:queue") return handle(channel, listener);
    return handle(channel, async (event, ...args) => {
      const [, action, , draft, , , questionId] = args;
      const result = await listener(event, ...args);
      if (action === "add" && result.ok) queueAdds.push({ id: result.data, draft, questionId });
      return result;
    });
  };
  globalThis.fixtureCli = async (call, board, args, input) => {
    if (autoMode && !held && args[0] === "accept" && args[1] === hybrid && input?.autoMode) {
      held = input;
      await release.promise;
      return raced = await call(board, args, input);
    }
    if (autoMode && args[0] === "accept" && args[1] === normal && input?.autoMode) {
      retryCount++;
      if (retryCount === 1) {
        pausedAcceptance = input;
        await resumeNormal.promise;
        return retryRejection = await call(board, args, input);
      }
      assert.deepEqual(input, pausedAcceptance);
    }
    const result = await call(board, args, input);
    if (args[1] === hybrid && ["review", "review-approve", "accept"].includes(args[0])) {
      observed.push([args[0], result.ok ? result.data.revision : result.error.code]);
    }
    return result;
  };
  globalThis.fixtureReview = async () => ({ summary: "Fixture reviewer approved.", needsHuman: false, findings: [], evidence });
  globalThis.fixtureManager = async (_profile, _project, prompt, _images, call, _tools, _instructions, _signal, session) => {
    let text = prompt;
    const approvalNotice = prompt.startsWith("Process the recorded reviewer approvals for the assigned cards");
    if (session.separateTurn || approvalNotice) {
      assert.ok(!session.mcpTools.some(tool => tool.name === action));
      if (!autoMode && approvalNotice && prompt.includes(normal)) {
        const id = normal;
        const snapshot = await call("task_review", { id });
        assert.ok(snapshot.ok, JSON.stringify(snapshot));
        const { revision, targetHead } = snapshot.data;
        const accepted = await call("task_accept", { id, revision, targetHead });
        assert.ok(accepted.ok, JSON.stringify(accepted));
      }
      text = "Processed reviewer approval.";
    } else {
      assert.ok(session.mcpTools.some(tool => tool.name === action));
      const input = replies.get(prompt);
      if (typeof input === "string") {
        text = input;
      } else {
        const receipt = await changeReviewMode(call, input);
        receipts.push(receipt);
        text = receipt.ok ? "Provider draft without the saved mode." : JSON.stringify(receipt);
      }
    }
    return { text };
  };
  globalThis.fixtureDiscussion = async (_profile, _project, _settings, prompt, _images, _update, call) => {
    const authorization = JSON.parse(prompt).latestUserMessage.text;
    const before = show(hybrid).revision;
    const receipt = await changeReviewMode(call, { ...replies.get(authorization), authorization });
    if (!receipt.ok) assert.equal(show(hybrid).revision, before);
    receipts.push(receipt);
    return { text: receipt.ok ? "Provider draft without the saved mode." : JSON.stringify(receipt) };
  };

  const profile = join(scratch, "profile-" + phase);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
  app.setPath("userData", profile);
  app.setPath("appData", join(scratch, "app-data-" + phase));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  process.argv.push("--project", project);
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const preload = join(scratch, "preload-under-test-" + phase + ".cjs");
  writeFileSync(preload, readFileSync(new URL("./preload.cjs", sourceUrl), "utf8")
    .replace("filePayload: async file => {",
      'filePayload: async file => { await ipcRenderer.invoke("fixture:prepare-attachment", file.name);'));
  const source = readFileSync(sourceUrl, "utf8")
    .replace("replyToBoard, replyToTask, reviewWithCodex,", "")
    .replace("import { callCli,", "import { callCli as realCallCli,")
    .replace('fileURLToPath(new URL("./preload.cjs", import.meta.url))', JSON.stringify(preload))
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test-" + phase + ".mjs");
  // The test launches the production main and renderer with provider responses supplied locally.
  const nativeElectronPath = require.resolve("electron/package.json");
  const modulesPath = join(scratch, "node_modules");
  if (autoMode) symlinkSync(dirname(dirname(nativeElectronPath)), modulesPath, "junction");
  writeFileSync(entry, transformSync(`const { fixtureManager: replyToBoard, fixtureDiscussion: replyToTask, fixtureReview: reviewWithCodex } = globalThis;
const callCli = (...args) => globalThis.fixtureCli(realCallCli, ...args);
` + source + "\n globalThis.fixtureWindow = createWindow;", { loader: "ts", format: "esm" }).code);
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  require(entry);
  const bootstrap = window => window.webContents.executeJavaScript("window.taskboard.bootstrap()");
  const window = await waitFor(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.webContents.isLoading() && (await bootstrap(win)).board && win;
  }, "the fixture board");
  if (phase === "restart") {
    const { board } = await bootstrap(window);
    assert.equal(board.tasks.find(card => card.id === hybrid)?.reviewModeOverride.mode, "reviewer-human");
    assert.equal(board.tasks.find(card => card.id === normal)?.reviewModeOverride, undefined);
    log("PASS: a new Electron process loaded the persisted assignment and inheritance.");
    return;
  }

  const evaluate = (win, method, args) => win.webContents.executeJavaScript(
    `window.taskboard[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const managerRequest = async prompt => {
    const result = await evaluate(window, "boardRequest", [prompt, [], project, false, false]);
    assert.ok(result.ok && !result.data.error, JSON.stringify(result));
    return result.data;
  };
  const manager = async (prompt, input) => {
    replies.set(prompt, input);
    const previousReceipts = receipts.length;
    const result = await managerRequest(prompt);
    if (typeof input !== "string") {
      assert.equal(receipts.length, previousReceipts + 1, JSON.stringify(result));
    }
    return { ...receipts.at(-1), answer: result.answer, items: result.items };
  };
  const discussion = async (text, input) => {
    replies.set(text, input);
    const result = await evaluate(window, "chatSend", [hybrid, { text, files: [], model: "fixture", effort: "low" }]);
    assert.ok(result.saved && result.result.ok, JSON.stringify(result));
    return receipts.at(-1);
  };
  assert.equal((await discussion("Use reviewer-human for " + normal, { mode: "reviewer-human" })).error.code, "USER_DIRECTION_REQUIRED");
  const rejected = [
    [hybrid + " currently uses reviewer mode.", "reviewer-human"],
    ["Set " + hybrid + " to reviewer-human or manager", "reviewer-human"],
    ["Set " + hybrid + " to reviewer-human", "manager"],
    ["Set " + hybrid + " to reviewer-human", null],
  ];
  for (const [prompt, mode] of rejected) {
    const before = show(hybrid).revision;
    assert.equal((await manager(prompt, { id: hybrid, mode, revision: before, authorization: prompt })).error.code, "USER_DIRECTION_REQUIRED");
    assert.equal(show(hybrid).revision, before);
    assert.equal((await discussion(prompt, { mode })).error.code, "USER_DIRECTION_REQUIRED");
  }
  assert.equal((await discussion("Установи режим «Ревью + человек» для этой карточки", { mode: "reviewer-human" })).data.inherited, false);
  const original = "поставь карточке 319 только ревью, без человеческой приемки";
  const managerInput = (authorization, mode, revision = show(hybrid).revision) => ({ id: hybrid, mode, revision, authorization });
  const originalReceipt = await manager(original, managerInput(original, "reviewer"));
  assert.ok(originalReceipt.ok, JSON.stringify(originalReceipt));
  assert.equal(originalReceipt.data.reviewMode, "reviewer");
  assert.equal(originalReceipt.answer, "Для T-0319 сохранён режим «Ревьюер».");
  assert.equal(originalReceipt.items.filter(item => item.type === "agentMessage").at(-1).text, originalReceipt.answer);
  const mixed = "Назначь T-0319 режим «Ревью + человек»";
  assert.equal((await manager(mixed, managerInput(mixed, "reviewer-human"))).data.reviewMode, "reviewer-human");
  const scoped = "Поставь только ревью, без человеческой приёмки";
  assert.equal((await discussion(scoped, { mode: "reviewer-human" })).error.code, "USER_DIRECTION_REQUIRED");
  assert.equal((await discussion(scoped, { mode: "reviewer" })).data.reviewMode, "reviewer");
  assert.equal(show(hybrid).history.filter(event => event.chat).at(-1).text, "Для T-0319 сохранён режим «Ревьюер».");
  const pendingMode = "Поставь карточке 319 режим";
  const beforeQuestion = receipts.length;
  const modeQuestion = await managerRequest(pendingMode);
  assert.equal(modeQuestion.answer, "Какой режим ревью выбрать?");
  assert.deepEqual(modeQuestion.items.filter(item => item.type === "agentMessage").map(item => item.text), [modeQuestion.answer]);
  const questionFromCard = await evaluate(window, "chatSend", [hybrid, {
    text: "Поставь режим", files: [], model: "fixture", effort: "low",
  }]);
  assert.ok(questionFromCard.saved && questionFromCard.result.ok, JSON.stringify(questionFromCard));
  assert.equal(show(hybrid).history.filter(event => event.chat).at(-1).text, modeQuestion.answer);
  assert.equal(receipts.length, beforeQuestion);
  const visibleQuestion = () => window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll(".board-chat-log:not(.board-work) .chat-run-final"))
      .filter(node => node.checkVisibility({ visibilityProperty: true }) && node.firstElementChild.textContent.trim() === "Какой карточке?")
      .at(-1)?.dataset.messageId
  `);
  const questionGeometry = (id, scrollTo) => window.webContents.executeJavaScript(`
    (() => {
      const log = document.querySelector(".board-chat-log:not(.board-work)");
      const question = Array.from(log.querySelectorAll(".chat-run-final"))
        .find(node => node.dataset.messageId === ${JSON.stringify(id)});
      if (!question) return null;
      if (${JSON.stringify(scrollTo)} === "start") log.scrollTo({ top: 0, behavior: "instant" });
      if (${JSON.stringify(scrollTo)} === "end") log.scrollTo({ top: log.scrollHeight, behavior: "instant" });
      const viewport = log.getBoundingClientRect();
      const bounds = question.getBoundingClientRect();
      return {
        displayed: question.checkVisibility({ visibilityProperty: true }),
        below: bounds.top >= viewport.bottom,
        fullyInside: bounds.height > 0 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      };
    })()
  `);
  const askForCard = async () => {
    const previous = await visibleQuestion();
    const result = await managerRequest(scoped);
    assert.equal(result.answer, "Какой карточке?");
    assert.equal(result.items.filter(item => item.type === "agentMessage").length, 1);
    await window.webContents.executeJavaScript("document.querySelector('#board-draft').invalidateHistory()");
    return waitFor(async () => {
      const current = await visibleQuestion();
      return current && current !== previous && current;
    }, "the card question rendered in the manager chat").catch(async error => {
      const state = await window.webContents.executeJavaScript(`
        ({
          open: document.querySelector("#board-draft").hasAttribute("data-open"),
          lastReplies: Array.from(document.querySelectorAll(".board-chat-log:not(.board-work) .chat-run-final"))
            .slice(-4).map(node => ({ text: node.firstElementChild.textContent, visible: node.checkVisibility() })),
        })
      `);
      throw new Error(error.message + ": " + JSON.stringify(state));
    });
  };
  assert.equal((await manager(mixed, managerInput(mixed, "reviewer-human"))).data.reviewMode, "reviewer-human");
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('#board-draft textarea'))"), "manager composer");
  await window.webContents.executeJavaScript(`
    document.querySelector("#board-draft:not([data-pinned]) .board-chat-pin")?.click()
  `);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(document.querySelector('#board-draft[data-pinned]'))"),
    "the manager chat to stay open");
  const submitForm = (text, attach = false) => window.webContents.executeJavaScript(`
    (() => {
      const form = document.querySelector("#board-draft");
      if (${attach}) {
        const files = new DataTransfer();
        files.items.add(new File(["QA"], "delayed.txt", { type: "text/plain" }));
        const picker = form.querySelector("input[type=file]");
        picker.files = files.files;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const input = form.querySelector("textarea[name=request]");
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  const waitForQueue = () => waitFor(async () => {
    const result = await evaluate(window, "boardQueue", [project, "list"]);
    assert.ok(result.ok, JSON.stringify(result));
    return !result.data.length && !(await bootstrap(window)).managerBusy;
  }, "the ordinary queue to drain");
  const waitForAdd = previous => waitFor(() => queueAdds[previous], "the form to write its queued message");
  const beforePremature = show(hybrid).revision;
  assert.equal(await visibleQuestion(), undefined);
  replies.set("319", managerInput("319", "reviewer", beforePremature));
  const gate = { started: Promise.withResolvers(), release: Promise.withResolvers() };
  attachmentGate = gate;
  let firstQuestion;
  const beforeAdd = queueAdds.length;
  try {
    await submitForm("319", true);
    await waitFor(() => Promise.race([gate.started.promise.then(() => true), delay(50, false)]), "attachment preparation to pause");
    assert.equal(queueAdds.length, beforeAdd);
    firstQuestion = await askForCard();
    assert.equal(queueAdds.length, beforeAdd);
  } finally {
    gate.release.resolve();
  }
  const premature = await waitForAdd(beforeAdd);
  assert.equal(premature.draft, "319");
  assert.equal(premature.questionId, undefined);
  await waitForQueue();
  const queuedTurn = async clientId => {
    const result = await evaluate(window, "boardHistory", [project, null, "chat"]);
    assert.ok(result.ok, JSON.stringify(result));
    return result.data.turns.find(turn => turn.messages.some(message => message.clientId === clientId));
  };
  assert.equal(receipts.at(-1).error.code, "USER_DIRECTION_REQUIRED");
  assert.equal(show(hybrid).revision, beforePremature);
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer-human");
  const clippedQuestion = await askForCard();
  const clipped = await questionGeometry(clippedQuestion, "start");
  assert.deepEqual(clipped, { displayed: true, below: true, fullyInside: false });
  const beforeClipped = show(hybrid).revision;
  const clippedOffset = queueAdds.length;
  replies.set("319", managerInput("319", "reviewer", beforeClipped));
  await submitForm("319");
  const clippedAnswer = await waitForAdd(clippedOffset);
  await waitForQueue();
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer-human");
  assert.equal(show(hybrid).revision, beforeClipped);
  assert.equal(clippedAnswer.questionId, undefined);
  assert.equal(receipts.at(-1).error?.code, "USER_DIRECTION_REQUIRED");
  const sendNumber = async input => {
    const question = await askForCard();
    await waitFor(async () => (await questionGeometry(question, "end"))?.fullyInside,
      "the complete question inside the chat viewport");
    const offset = queueAdds.length;
    replies.set("319", input);
    await submitForm("319");
    const queued = await waitForAdd(offset);
    assert.equal(queued.questionId, question);
    await waitForQueue();
    return queued.id;
  };
  assert.ok(firstQuestion);
  const afterQuestion = await sendNumber(managerInput("319", "reviewer"));
  assert.deepEqual((await queuedTurn(afterQuestion)).items.filter(item => item.type === "agentMessage").map(item => item.text),
    ["Для T-0319 сохранён режим «Ревьюер»."]);
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer");
  log("PASS: a question below the scroll viewport was present in the DOM but supplied no authorization. The early reply left the revision and reviewer-human mode unchanged. A fresh reply after scrolling to the question set reviewer mode.");
  assert.equal((await manager(mixed, managerInput(mixed, "reviewer-human"))).data.reviewMode, "reviewer-human");
  await sendNumber(managerInput("319", "reviewer", show(hybrid).revision - 1));
  assert.equal(receipts.at(-1).error.code, "REVISION_CONFLICT");
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer-human");
  await askForCard();
  assert.equal((await manager("319x", managerInput("319x", "reviewer"))).error.code, "USER_DIRECTION_REQUIRED");
  assert.equal((await manager("319", managerInput("319", "reviewer"))).error.code, "USER_DIRECTION_REQUIRED");
  await sendNumber(managerInput("319", "reviewer"));
  const receipt = receipts.at(-1);
  assert.equal(receipt.data.reviewMode, "reviewer");
  assert.equal(receipt.data.revision, show(hybrid).revision);
  await manager("Покажи карточку 319", "Какой карточке?");
  assert.equal((await manager("319", managerInput("319", "human"))).error.code, "USER_DIRECTION_REQUIRED");
  for (const invalid of ["Поставь карточке 319x только ревью", "«" + original + "»", "Поставь карточке 3e2 только ревью"]) {
    assert.equal((await manager(invalid, managerInput(invalid, "reviewer"))).error.code, "USER_DIRECTION_REQUIRED");
  }
  assert.equal((await manager(original, managerInput(mixed, "reviewer"))).error.code, "USER_DIRECTION_REQUIRED");
  log("PASS: the form submitted 319 before a question appeared and wrote it only after the question appeared. The card and revision stayed unchanged. The form accepted a fresh reply after the question was visible. Both chats used one application-generated mode question and confirmed the saved mode.");
  log("PASS: the original 319 request, accented negation, full ID, current card and adjacent card-number clarification saved the exact review mode. Wrong mode, stale revision, invalid number, quote, forged question and authorization mismatch were rejected.");
  assert.equal((await discussion("Верни наследование режима доски", { mode: null })).data.inherited, true);
  const ambiguous = "Use reviewer-human for " + hybrid + " or " + normal;
  assert.equal((await manager(ambiguous, { id: hybrid, mode: "reviewer-human", revision: show(hybrid).revision, authorization: ambiguous })).error.code,
    "USER_DIRECTION_REQUIRED");
  submit(hybrid);
  const approved = await waitFor(() => {
    const snapshot = review(hybrid);
    return snapshot.reviewerApproval && snapshot;
  }, "the original approval");
  if (autoMode) await waitFor(() => held, "the automatic acceptance request").catch(async error => {
    const { board, runningTasks, reviewingTasks } = await bootstrap(window);
    console.error(JSON.stringify({ error: error.message, autoMode: board.settings.autoMode, runningTasks, reviewingTasks,
      card: board.tasks.find(task => task.id === hybrid), observed }));
    throw error;
  });
  const history = show(hybrid).history;
  const authorization = "Назначь " + hybrid + " режим «Ревью + человек»";
  assert.equal((await manager(authorization, { id: hybrid, mode: "reviewer-human", revision: approved.revision, authorization })).data.reviewMode,
    "reviewer-human");
  if (autoMode) {
    release.resolve();
    await waitFor(() => raced, "the stale automatic accept to return");
  } else {
    raced = reply(["accept", hybrid], { actor: "manager", reviewMode: "reviewer",
      reviewModeVersion: approved.reviewModeVersion, revision: approved.revision, targetHead: approved.targetHead });
  }
  assert.equal(raced.error.code, "REVIEW_MODE_CHANGED");
  assert.deepEqual(show(hybrid).history.slice(0, history.length), history);
  log("PASS: both chats rejected mentions, ambiguity, a different mode and an unrequested reset without changing the revision. Assignment, inheritance and stale acceptance (" + raced.error.code + ") verified.");

  const second = globalThis.fixtureWindow([project]).window;
  await waitFor(async () => !second.webContents.isLoading() && (await bootstrap(second)).board, "the second board window");
  submit(normal);
  if (autoMode) {
    await waitFor(() => pausedAcceptance, "the inherited card's first acceptance request");
    cli(["settings"], { autoMode: false });
    resumeNormal.resolve();
    const rejection = await waitFor(() => retryRejection, "the temporary acceptance rejection");
    assert.equal(rejection.error.code, "AUTO_MODE_DISABLED");
    assert.equal(show(normal).status, "review");
    assert.equal(show(normal).revision, pausedAcceptance.revision);
    cli(["settings"], { autoMode: true });
  }
  await waitFor(() => show(normal).status === "done", "the inherited card to integrate");
  if (autoMode) {
    assert.equal(retryCount, 2);
    log("PASS: AUTO_MODE_DISABLED released the attempt. Re-enabling auto mode integrated the same approved revision exactly once.");
  }
  const waiting = await waitFor(() => {
    const snapshot = review(hybrid);
    return snapshot.awaitingHumanAcceptance && snapshot;
  }, "approval for personal acceptance");
  const marker = `/Awaiting human acceptance|Ожидает приёмки человеком/i.test(document.body.innerText)`;
  for (const win of [window, second]) {
    await waitFor(() => win.webContents.executeJavaScript(marker), "the visible personal acceptance marker");
  }
  if (autoMode) {
    second.focus();
    await second.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    await delay(350);
    writeFileSync(join(artifacts, "card-review-mode.png"), (await second.webContents.capturePage()).toPNG());
  }
  assert.equal(reply(["accept", hybrid], { actor: "user", revision: waiting.revision, targetHead: waiting.targetHead,
    reviewModeVersion: waiting.reviewModeVersion }).error.code, "HUMAN_ACCEPTANCE_REQUIRED");
  let decision = 0;
  dialog.showMessageBox = async () => ({ response: decision });
  const accept = () => evaluate(window, "command", ["accept", hybrid, {
    revision: waiting.revision, targetHead: waiting.targetHead, reviewModeVersion: waiting.reviewModeVersion, message: "fix: integrate personal card",
  }]);
  assert.equal((await accept()).error.code, "ACCEPTANCE_CANCELLED");
  assert.equal(show(hybrid).status, "review");
  decision = 1;
  assert.equal((await accept()).data.status, "done");
  assert.equal((await accept()).data.status, "done");
  for (const id of [hybrid, normal]) assert.equal(show(id).history.filter(event => event.action === "accept").length, 1);
  assert.equal(git("rev-list", "--count", "--first-parent", "HEAD"), "3");
  cli(["settings"], { reviewMode: "human" });
  assert.equal(show(hybrid).reviewModeOverride.mode, "reviewer-human");
  log("PASS: both windows agreed, inherited card integrated automatically, personal card waited for the desktop dialog, exactly two integrations.");
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
