// Exercise the native renderer and the production goal RPC against a fixture App Server.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "long-goal", 70_000, [[], ["--restart"]]);
const { app, BrowserWindow } = await import("electron");
process.on("unhandledRejection", error => {
  console.error(error);
  app.exit(1);
});
const require = createRequire(import.meta.url);
const { transformSync } = require("esbuild");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const binding = join(project, ".tasks", "manager-dialog.json");
const restart = process.argv.includes("--restart");
const thread = "00000000-0000-0000-0000-000000000001";
const original = "Проверь условия длинной цели.\n[Справка для проверки](https://example.com)\n\n" +
  "Проверочный абзац сохраняется целиком.\n".repeat(110) + "Последняя строка исходной цели.";
const revised = original.replace("Проверь условия длинной цели.", "Правка после переоткрытия доски.") +
  "\nСохрани дополнительный результат.";
const fromDialogue = "    " + revised + "\nВключи итеративный режим.\n\n\t  ";
const authorization = "Замени текст цели на: " + fromDialogue;
const wire = join(project, "wire.jsonl");
const denyBinding = join(scratch, "deny-binding-write");

function fixtureProvider() {
  const fs = require("node:fs");
  const readline = require("node:readline");
  const threadId = "00000000-0000-0000-0000-000000000001";
  const state = ".tasks/fixture-app-server.json";
  const goals = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state)) : {};
  const send = message => console.log(JSON.stringify(message));
  const output = (id, result) => send({ id, result });
  const notify = (method, params) => send({ method, params });
  let activeThread;
  const waiting = new Map();
  function callTool(id, name, args) {
    return new Promise(resolve => {
      waiting.set(id, resolve);
      send({ id, method: "item/tool/call", params: {
        threadId: activeThread, callId: id, tool: name, arguments: args,
      } });
    });
  }
  readline.createInterface({ input: process.stdin }).on("line", async line => {
    const { id, method, params, result } = JSON.parse(line);
    if (!method) {
      waiting.get(id)?.(result);
      return;
    }
    if (id === undefined) return;
    if (method === "initialize") {
      output(id, {});
    } else if (method === "model/list") {
      output(id, { data: [{ model: "gpt-6.2-sol", isDefault: true, defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null });
    } else if (method === "config/read") {
      output(id, { config: { model: "gpt-6.2-sol", model_reasoning_effort: "medium" } });
    } else if (method === "thread/start" || method === "thread/resume") {
      activeThread = params.threadId ?? (goals[threadId] ? "00000000-0000-0000-0000-000000000002" : threadId);
      output(id, { thread: { id: activeThread, name: "Fixture" }, model: params.model,
        activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer });
    } else if (method === "thread/goal/get") {
      output(id, { goal: goals[params.threadId] ?? null });
    } else if (method === "thread/goal/set") {
      fs.appendFileSync("wire.jsonl", JSON.stringify(params) + "\n");
      const goal = goals[params.threadId] = { ...goals[params.threadId],
        ...(params.objective !== undefined ? { objective: params.objective } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}) };
      fs.writeFileSync(state, JSON.stringify(goals));
      if (fs.existsSync("disconnect-after-goal-set")) {
        fs.unlinkSync("disconnect-after-goal-set");
        process.stdout.write(JSON.stringify({ id, result: { goal } }) + "\n", () => process.exit(0));
        return;
      }
      output(id, { goal });
    } else if (method === "turn/start") {
      const turn = { id: "fixture-turn", status: "inProgress" };
      output(id, { turn });
      const text = params.input[0].text;
      if (text.startsWith("Замени текст цели на: ")) {
        const read = await callTool("fixture-read", "goal_read", {});
        const data = JSON.parse(read.contentItems[0].text).data;
        const edit = await callTool("fixture-edit", "goal_edit", {
          goalId: data.goalId, expectedObjective: data.goal.objective,
          objective: text.slice("Замени текст цели на: ".length), authorization: text,
        });
        fs.writeFileSync("fixture-tool-result.json", JSON.stringify({ read, edit }));
      }
      const goal = goals[activeThread];
      if (goal) {
        const file = goal.objective.split(String.fromCharCode(96))[1];
        if (file) fs.writeFileSync("fixture-read.md", fs.readFileSync(file));
        goal.status = "paused";
        fs.writeFileSync(state, JSON.stringify(goals));
        notify("thread/goal/updated", { threadId: activeThread, goal });
      }
      notify("item/completed", { threadId: activeThread, turnId: turn.id,
        item: { id: "fixture-answer", type: "agentMessage", phase: "final_answer", text: "Проверка выполнена." } });
      notify("turn/completed", { threadId: activeThread, turn: { ...turn, status: "completed" } });
    } else if (method === "thread/read") {
      output(id, { thread: { id: params.threadId, model: "gpt-6.2-sol" } });
    } else if (method === "thread/items/list") {
      output(id, { data: [], nextCursor: null });
    } else if (method === "command/exec") {
      output(id, { exitCode: 1, stdout: "", stderr: "" });
    } else {
      output(id, {});
    }
  });
}

function instrument(file, substitutions, extra = "") {
  const url = new URL("../src/desktop/" + file + ".ts", import.meta.url);
  let source = readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href));
  for (const [from, to] of substitutions) {
    assert.ok(source.includes(from), from);
    source = source.replace(from, to);
  }
  source = source.replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, url).href));
  const output = join(scratch, file + ".mjs");
  writeFileSync(output, transformSync(source + extra, { loader: "ts", format: "esm" }).code);
  return output;
}

function setup() {
  const provider = join(scratch, "provider.cjs");
  if (!restart) {
    mkdirSync(project);
    mkdirSync(profile);
    writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
    const node = process.env.TASKBOARD_CHECK_NODE;
    const cli = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
    const run = (args, input) => {
      const result = JSON.parse(execFileSync(node, ["--disable-warning=ExperimentalWarning", cli,
        "--project", project, "--json", ...args], { input, windowsHide: true }));
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    run(["init"]);
    run(["settings", "--stdin"], JSON.stringify({ autoMode: false }));
    writeFileSync(provider, "(" + fixtureProvider.toString() + ")();\n");
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  }
  app.setPath("userData", profile);
  app.setPath("appData", join(scratch, "app-data"));
  app.disableHardwareAcceleration();
  app.requestSingleInstanceLock = () => true;
  app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
  process.argv.push("--project", project);
  const command = { path: process.env.TASKBOARD_CHECK_NODE, args: [provider] };
  const chat = instrument("codex-chat", [
    ['import { configuredCodex, executorFullAccess, setTaskExecutorAccess } from "./codex.ts";',
      'import { executorFullAccess, setTaskExecutorAccess } from "./codex.ts";\nconst configuredCodex = async () => (' + JSON.stringify(command) + ");"],
    ['import { openComputerUse } from "./computer-use.ts";', "const openComputerUse = async () => undefined;"],
  ]);
  const failure = `
function writeJson(path, data) {
  if (path === ${JSON.stringify(binding)} && data?.goalChangeId && existsSync(${JSON.stringify(denyBinding)})) {
    throw new Error("Fixture refused the goal binding write");
  }
  return originalWriteJson(path, data);
}
`;
  const main = instrument("main", [
    ['from "./codex-chat.ts";', "from " + JSON.stringify(pathToFileURL(chat).href) + ";"],
    ["withProjectRulesLock, writeJson }", "withProjectRulesLock, writeJson as originalWriteJson }"],
  ], failure);
  require(main);
}

async function until(probe, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for " + label);
}

async function run() {
  setup();
  const window = await until(() => BrowserWindow.getAllWindows()[0], "board window");
  window.setContentSize(1280, 800);
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const api = (method, ...args) => evaluate("window.taskboard." + method + "(" + args.map(arg => JSON.stringify(arg)).join(",") + ")");
  const panel = "document.querySelector('.board-goal')";
  const editor = panel + ".querySelector('textarea')";
  const save = panel + ".querySelector('.board-goal-actions button')";
  const saved = () => JSON.parse(readFileSync(binding, "utf8"));
  async function show(text, name) {
    await until(() => evaluate(panel + " && !" + panel + ".hidden && " + editor + ".value === " + JSON.stringify(text)), name);
    await evaluate(panel + ".open = true");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const capture = await window.webContents.capturePage();
    assert.deepEqual(capture.getSize(), { width: 1280, height: 800 });
    const png = capture.toPNG();
    assert.ok(png.length < 4 * 1024 * 1024);
    writeFileSync(join(artifacts, name), png);
  }
  await until(() => evaluate("!!document.querySelector('#board-draft textarea[name=request]')"), "board composer");
  await evaluate("document.querySelector('#board-draft textarea[name=request]').dispatchEvent(" +
    "new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
  async function postGoal(text) {
    const goalMode = "document.querySelector('#board-draft .draft-menu-actions .draft-menu-item:nth-child(3)')";
    await evaluate("document.querySelector('#board-draft .draft-add').click(); " + goalMode + ".click()");
    await until(() => evaluate(goalMode + ".getAttribute('aria-pressed') === 'true'"), "goal composer mode");
    await evaluate(`{
      const form = document.querySelector('#board-draft');
      const input = form.querySelector('textarea[name=request]');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.querySelector('.chat-send').click();
    }`);
  }
  if (!restart) {
    await postGoal(original);
    try {
      await until(() => existsSync(binding) && saved().goal?.status === "paused", "goal submitted in the composer");
    } catch (error) {
      const detail = await evaluate("document.body.innerText");
      throw new Error("Goal composer did not finish. " + detail.slice(-1200), { cause: error });
    }
    assert.equal(saved().goal.objective, original);
    assert.equal(readFileSync(join(project, "fixture-read.md"), "utf8"), original);
    const request = JSON.parse(readFileSync(wire, "utf8").trim());
    assert.ok(request.objective.length < 4000 && original.length > 4000);
    await show(original, "long-goal.png");
    console.log("PASS Windows Electron displays the whole long objective. The dispatched provider opened the referenced UTF-8 file.");
    return;
  }
  await until(() => evaluate(panel + " && !" + panel + ".hidden"), "goal restored from the previous Electron process");
  assert.equal(await evaluate(editor + ".value"), original);
  const deniedPath = join(project, ".tasks", "manager-goal-" + thread + "-" + hash("sha256", revised) + ".md");
  mkdirSync(deniedPath);
  await evaluate(panel + ".open = true; " + editor + ".value = " + JSON.stringify(revised) + "; " + editor +
    ".dispatchEvent(new Event('input', { bubbles: true })); " + save + ".click();");
  await until(() => evaluate(panel + ".querySelector('.board-goal-error').textContent.includes('Could not save the goal Markdown')"),
    "visible Markdown write failure");
  assert.equal(await evaluate(editor + ".value"), revised);
  assert.equal(saved().goal.objective, original);
  rmdirSync(deniedPath);
  const previousWire = JSON.parse(readFileSync(wire, "utf8").trim()).objective;
  const providerGoal = () => JSON.parse(readFileSync(join(project, ".tasks", "fixture-app-server.json"), "utf8"))[thread];
  const previousFile = join(project, previousWire.split(String.fromCharCode(96))[1]);
  writeFileSync(denyBinding, "");
  await evaluate(save + ".click()");
  await until(() => evaluate(panel + ".querySelector('.board-goal-error').textContent.includes('Fixture refused the goal binding write')"),
    "visible binding write failure");
  assert.equal(providerGoal().objective, previousWire);
  assert.equal(saved().goal.objective, original);
  assert.equal(readFileSync(previousFile, "utf8"), original);
  assert.equal(await evaluate(editor + ".value"), revised);
  unlinkSync(denyBinding);
  await evaluate(save + ".click()");
  await until(() => saved().goal.objective === revised, "edit saved");
  await show(revised, "long-goal-after-reopen.png");
  assert.equal(existsSync(previousFile), false);
  const dialogue = await api("boardRequest", authorization, [], project, false);
  assert.equal(dialogue.ok, true, JSON.stringify(dialogue));
  const tools = JSON.parse(readFileSync(join(project, "fixture-tool-result.json"), "utf8"));
  assert.equal(tools.read.success, true, JSON.stringify(tools.read));
  assert.equal(JSON.parse(tools.read.contentItems[0].text).data.goal.objective, revised);
  assert.equal(tools.edit.success, true, JSON.stringify(tools.edit));
  assert.equal(saved().goal.objective, fromDialogue);
  assert.equal(saved().ownerObjective, fromDialogue);
  assert.equal(saved().ownerIteration.enabled, true);
  assert.equal(await evaluate(editor + ".value"), fromDialogue);
  const literalFile = join(project, providerGoal().objective.split(String.fromCharCode(96))[1]);
  assert.equal(readFileSync(literalFile, "utf8"), fromDialogue);

  const previousGoal = providerGoal();
  const retryText = revised + "\nПроверь повтор после обрыва.";
  writeFileSync(join(project, "disconnect-after-goal-set"), "");
  await postGoal(retryText);
  const failed = "document.querySelector('.board-queued-failed')";
  await until(() => evaluate("!!" + failed), "failed goal displayed in the queue");
  const queue = await api("boardQueue", project, "list");
  assert.equal(queue.ok, true, JSON.stringify(queue));
  assert.equal(queue.data.find(job => job.goal)?.draft, retryText);
  assert.deepEqual(providerGoal(), previousGoal);
  assert.equal(saved().goal.objective, fromDialogue);
  assert.equal(readFileSync(literalFile, "utf8"), fromDialogue);
  await evaluate(failed + ".parentElement.querySelector('button').click()");
  await until(() => saved().goal.objective === retryText && !existsSync(literalFile), "goal retry confirmed");
  assert.equal(readFileSync(join(project, "fixture-read.md"), "utf8"), retryText);
  const paths = ["src/desktop/codex-chat.ts", "src/desktop/goal-objective.ts", "src/desktop/main.ts",
    "src/desktop/renderer.js", "src/desktop/preload.cjs", "scripts/check-long-goal.mjs",
    "scripts/electron-check.mjs", "tests/codex-chat-control.test.ts"];
  writeFileSync(join(artifacts, "long-goal-report.txt"), [
    "Command: node scripts/check-long-goal.mjs --artifacts .tasks/qa",
    "Companion RPC checks: node --test tests/codex-chat-control.test.ts",
    "Electron " + process.versions.electron + ", Windows " + process.arch + "; Node " + process.versions.node,
    "PASS: setup and a separate app process at 1280×800, Chromium sandbox enabled.",
    "PASS: the provider reads the exact long Markdown; the panel shows the same full text.",
    "PASS: the reopened panel restores the objective, saves an edit and shows the edited text.",
    "PASS: Markdown and binding write failures keep the previous goal and the text in the editor. The provider rolls back the refused edit. Retrying saves the revision and removes the previous Markdown.",
    "PASS: goal_read supplies the full prior version. The new binding, Markdown and renderer all match the literal goal_edit, including the first-line indent and trailing whitespace. Iteration authority remains available.",
    "PASS: the App Server exits after acknowledging the new goal. After reconnecting both copies show the previous goal, the source draft stays in the queue, and the retry replaces the previous version.",
    "The provider is a deterministic process speaking App Server JSON-RPC. Linux and macOS GUI runs are outside this report.",
    "Tested worktree bytes (SHA-256):",
    ...paths.map(path => hash("sha256", readFileSync(join(root, path))) + "  " + path), "",
  ].join("\n"));
  console.log("PASS Windows Electron restores the objective after restart and saves edits from the panel and dialogue.");
}

void run().then(async () => {
  await until(() => !runtimeEntries(project).some(entry =>
    entry.task === "manager:context" || entry.task === "manager:dialogue"), "manager writers released");
  app.exit(0);
}, error => {
  console.error(error);
  app.exit(1);
});
