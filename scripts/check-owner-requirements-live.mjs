// Opt-in check. Uses the configured Codex account on a disposable Git board.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { configuredCodex } from "../src/desktop/codex.ts";
import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "owner-requirements-live", 600_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "fixture");
const profile = join(scratch, "profile");
const cliEntry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const ownerText = "Сбросы нужно писать под полосой лимитов и нужно перечислить их со сроком экспирации";
const ambiguousText = "Может, переделать список?";
const priorProposal = "Предложение по компактности: убрать список сроков действия, потому что он добавляет три строки в панели.";
const baseline = "Нулевой остаток отображается как «Доступно сбросов: 0».";
const model = "gpt-6.2-sol";

function cli(args, input) {
  const response = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", cliEntry, "--project", project, "--json",
    ...args, ...(input ? ["--stdin"] : []),
  ], { encoding: "utf8", input: input && JSON.stringify(input), windowsHide: true }));
  assert.ok(response.ok, JSON.stringify(response));
  return response.data;
}

async function waitFor(probe, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(500);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  mkdirSync(project);
  mkdirSync(profile);
  app.setPath("userData", profile);
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "Taskboard fixture");
  git("config", "--local", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial state");
  cli(["init"]);
  cli(["settings"], { reviewMode: "human", autoMode: false });
  const card = cli(["create"], plannedDraft({
    title: "Показывать доступные сбросы Codex",
    description: "Показывать количество доступных сбросов в панели лимитов Codex. " + baseline,
    criteria: [baseline],
  }));
  const show = () => cli(["show", card.id]);
  const review = () => cli(["review", card.id, "--compact"]);
  confirmFixtureDraft(project, card.id);
  const ready = cli(["approve", card.id]);
  const { worktree } = cli(["start", card.id], { revision: ready.revision });
  const panel = join(worktree, "provider-limits.js");
  writeFileSync(panel, [
    "export function renderLimits(availableCount, credits) {",
    '  const limitBar = "<progress value=25 max=100></progress>";',
    '  const count = availableCount ? `<p>Доступно сбросов: ${availableCount}</p>` : "";',
    '  const rows = credits.map(credit => `<li>Срок: ${credit.expiresAt}</li>`).join("");',
    "  return `${limitBar}${count}<ul>${rows}</ul>`;",
    "}",
    "",
  ].join("\n"));
  const submit = summary => cli(["submit", card.id, "--compact"], {
    token: cli(["preview", card.id, "--compact"]).token,
    message: "fix: render available reset credits",
    summary,
    checks: ["Список с датами показан при положительном остатке."],
  });
  const first = submit("Панель выводит список доступных сбросов со сроками.");
  const returned = cli(["request-changes", card.id, "--compact"], {
    revision: first.revision, actor: "manager", reviewMode: "human", targetHead: review().targetHead,
    reason: priorProposal,
  });
  cli(["start", card.id], { revision: returned.revision });
  writeFileSync(panel, readFileSync(panel, "utf8") + "// Credit expiration dates are already formatted for display.\n");
  const submitted = submit("Список со сроками показан под полосой лимитов.");
  const snapshot = show().history.findLast(event => event.action === "submit");

  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  const mainUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(mainUrl, "utf8")
    .replace(/\r\n/g, "\n")
    .replaceAll("import.meta.url", JSON.stringify(mainUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, mainUrl).href));
  // A fixture return must not start an executor that would change the observed submission.
  // The dialogue and reviewer use the actual configured Codex providers and normal IPC.
  const executorGuard = "  if (!release) return;\n  return Object.assign((restart:";
  assert.ok(source.includes(executorGuard), "The fixture executor guard needs updating.");
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source.replace(
    executorGuard, "  if (role === 'executor') { release?.(); return; }\n" + executorGuard,
  ), { loader: "ts", format: "esm" }).code);
  require(entry);
  const client = await configuredCodex(profile);
  assert.ok(client, "The configured Codex CLI was not found.");
  const window = await waitFor(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.webContents.isLoading()) return;
    const open = await win.webContents.executeJavaScript("window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)");
    if (open) return win;
  }, "the isolated board", 30_000);
  const send = text => window.webContents.executeJavaScript(
    `window.taskboard.chatSend(${JSON.stringify(card.id)}, ${JSON.stringify({ text, files: [], model, effort: "low" })})`,
  );
  console.log("Codex " + client.version + ": sending precise owner clarification.");
  const precise = await send(ownerText);
  assert.ok(precise.saved && precise.result.ok, JSON.stringify(precise));
  const updated = show();
  assert.equal(updated.status, "review");
  assert.match(updated.description, /срок/i);
  assert.ok(updated.criteria.some(criterion => criterion.includes("Доступно сбросов: 0")));
  assert.ok(updated.criteria.some(criterion => /спис|перечис/i.test(criterion) && /срок/i.test(criterion)));
  assert.deepEqual(updated.history.findLast(event => event.action === "submit"), snapshot);
  const savedChange = updated.history.findLast(event => event.ownerBriefSource);
  assert.equal(updated.history[savedChange.ownerBriefSource - 1].text, ownerText);
  const exactAnswer = updated.history.findLast(event => event.actor === "agent" && event.action === "chat");
  assert.ok(exactAnswer?.text);
  console.log("Codex: sending ambiguous owner question.");
  const ambiguous = await send(ambiguousText);
  assert.ok(ambiguous.saved && ambiguous.result.ok, JSON.stringify(ambiguous));
  const questioned = show();
  assert.ok(questioned.awaitingAnswer, JSON.stringify(questioned.history.at(-1)));
  assert.equal(questioned.description, updated.description);
  assert.deepEqual(questioned.criteria, updated.criteria);
  const ambiguousAnswer = questioned.history.findLast(event => event.actor === "agent" && event.action === "chat");
  assert.ok(ambiguousAnswer?.text.includes("?"));

  console.log("Codex: enabling independent review of the fixture.");
  const settings = cli(["settings"], { reviewMode: "reviewer-human", autoMode: false });
  const outcome = await waitFor(() => {
    const current = show();
    const finding = current.history.findLast(event => event.actor === "reviewer" && event.action === "request-changes");
    const question = current.history.findLast(event => event.actor === "reviewer" && event.expertMessage?.to === "owner");
    if (finding && question) return { current, finding, question };
    if (current.history.some(event => event.actor === "reviewer" && (
      event.action === "review-note" || event.action === "review-approve"
    ))) throw new Error("Unexpected review decision: " + JSON.stringify(current.history.slice(-3)));
  }, "the real reviewer return and owner question", 300_000);
  assert.equal(outcome.current.status, "in_progress");
  assert.match(outcome.finding.text, /нул|\b0\b/i);
  assert.match(outcome.finding.text, /provider-limits\.js/);
  assert.doesNotMatch(outcome.finding.text, /убр(ать|ерите) список|удал(ить|ите) список/i);
  assert.equal(outcome.question.messageKind, "question");
  assert.match(outcome.question.text, /спис|срок/i);
  assert.match(outcome.question.text, /компакт|три строк|3 строк|убрать|удалить/i);
  assert.deepEqual(outcome.current.criteria, questioned.criteria);
  const hashSource = path => {
    const bytes = readFileSync(new URL("../" + path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    return createHash("sha256").update(bytes).digest("hex") + "  " + path;
  };
  const report = [
    "PASS T-0333. Штатный диалог и ревью с живым Codex на изолированной доске.",
    `ОС ${process.platform} ${release()} ${process.arch}, Electron ${process.versions.electron}, Node ${process.versions.node}, Codex CLI ${client.version}.`,
    `Модель диалога ${model} (low), профиль ревьюера ${settings.reviewer.model} (${settings.reviewer.effort}).`,
    "Команда: node scripts/check-owner-requirements-live.mjs --artifacts .tasks/qa",
    "Ответ диалога на точное уточнение: " + exactAnswer.text,
    "Сохранённые критерии: " + JSON.stringify(updated.criteria),
    "Ответ диалога на неоднозначную фразу: " + ambiguousAnswer.text,
    "Неоднозначная фраза оставила описание и критерии без изменений. Снимок постановки сдачи сохранился.",
    "Предыдущее замечание в карточке: " + priorProposal,
    "Подтверждённый дефект, записанный ревьюером: " + outcome.finding.text,
    "Отдельный вопрос владельцу, записанный ревьюером: " + outcome.question.text,
    "Сдача фикстуры: " + submitted.git.submission.sha,
    "Диалог и ревью прошли через штатный Electron IPC. Автозапуск исполнителя отключён только для фикстуры.",
    "SHA-256 исходников UTF-8 после нормализации CRLF в LF:",
    ...[
      "scripts/check-owner-requirements-live.mjs", "scripts/electron-check.mjs",
      "src/cli/acceptance.ts", "src/cli/main.ts", "src/cli/model.ts", "src/cli/tasks.ts",
      "src/desktop/board-actions.ts", "src/desktop/chat-actions.ts", "src/desktop/codex-chat.ts", "src/desktop/main.ts",
    ].map(hashSource),
    "",
  ].join("\n");
  writeFileSync(join(artifacts, "owner-requirement-live.txt"), report);
  console.log(report);
}

run().then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
