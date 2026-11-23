import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { readBoardProjectRules } from "../src/cli/board-agents.ts";

const live = process.argv.includes("--live");
const { scratch } = electronCheck(import.meta.url, "project-rules-manager", live ? 300_000 : 90_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
const project = join(scratch, "board");
const other = join(scratch, "other");
const isolated = join(scratch, "isolated");
const cli = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const requests = [
  "Перенеси инструкции из старого файла в правила проекта",
  "Хочу привести агентс к шаблону доски и сохранить мои правила",
];
const question = "Как работает перенос инструкций из старого файла в правила проекта?";
const original = "- Проверяйте [справку](./guide.md).\r\n- Сохраняйте порядок.\r\n";
const agentsFile = board => join(board, "AGENTS.md");
const backgroundPrompt = "Inspect pending board activity.";

process.env.GIT_CEILING_DIRECTORIES = scratch;
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
process.argv.push("--project", project);

async function waitFor(probe) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Board window did not become ready.");
}

async function check() {
  for (const board of [project, other, isolated]) {
    mkdirSync(board);
    const initialized = execFileSync(process.env.TASKBOARD_CHECK_NODE, [
      cli, "--project", board, "--json", "init",
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(JSON.parse(initialized).ok, true);
    if (live) {
      execFileSync(process.env.TASKBOARD_CHECK_NODE, [
        cli, "--project", board, "--json", "settings", "--stdin",
      ], { input: JSON.stringify({ manager: { provider: "codex", model: "gpt-6.2-sol", effort: "low" } }), windowsHide: true });
    }
    writeFileSync(agentsFile(board), original);
  }

  if (!live) {
    globalThis.fixtureRulesManager = async (_profile, cwd, prompt, _images, action, _tools, _instructions, _signal, session) => {
      assert.ok([project, other].includes(cwd));
      if (prompt === backgroundPrompt) {
        assert.ok(!session.mcpTools.some(tool => tool.name === "board_import_project_rules"));
        const denied = await action("board_import_project_rules", { authorization: prompt });
        assert.equal(denied.error.code, "USER_DIRECTION_REQUIRED");
        return { text: "Background inspection complete.", model: "Fixture manager" };
      }
      assert.ok(session.mcpTools.some(tool => tool.name === "board_import_project_rules"));
      if (!session.id) session.save(randomUUID());
      if (prompt === question) return { text: "По явной просьбе менеджер переносит правила.", model: "Fixture manager" };
      assert.ok(requests.includes(prompt));
      const rejected = await action("board_import_project_rules", { authorization: question });
      assert.equal(rejected.error.code, "USER_DIRECTION_REQUIRED");
      const result = await action("board_import_project_rules", { authorization: prompt });
      assert.equal(result.ok, true, JSON.stringify(result));
      const { changed, imported } = result.data;
      const text = changed ? "Импортировано правил: " + imported : "Правила уже перенесены.";
      return { text, model: "Fixture manager" };
    };
  }
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const manager = live ? source : "const replyToBoard = (...args) => globalThis.fixtureRulesManager(...args);\n" +
    source.replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask");
  const entry = join(scratch, "main-under-test.mjs");
  const injected = manager + `
    globalThis.openRulesWindow = project => createWindow([project]).window;
    globalThis.runRulesBackground = (sender, project, prompt) => {
      const tab = windowStates.get(sender.id)?.tabs.find(tab => tab.project === project);
      return runBoardRequest(sender, tab?.board, prompt, [], false, false, undefined, undefined, undefined, true);
    };
  `;
  writeFileSync(entry, transformSync(injected, { loader: "ts", format: "esm" }).code);
  require(entry);

  const ready = window => waitFor(() => !window.webContents.isLoading() && window.webContents.executeJavaScript(
    "window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)"));
  const window = await waitFor(() => BrowserWindow.getAllWindows()[0]);
  const second = globalThis.openRulesWindow(other);
  await Promise.all([ready(window), ready(second)]);
  const ask = async (window, message) => {
    const reply = await window.webContents.executeJavaScript(
      "window.taskboard.boardRequest(" + JSON.stringify(message) + ")");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(reply.data.answer);
    return reply.data.answer;
  };

  assert.equal(readFileSync(agentsFile(project), "utf8"), original);
  if (!live) {
    const background = await globalThis.runRulesBackground(window.webContents, project, backgroundPrompt);
    assert.equal(background.ok, true, JSON.stringify(background));
    assert.equal(readFileSync(agentsFile(project), "utf8"), original);
    console.log("Background turn cannot call migration and leaves AGENTS.md unchanged.");
  }
  const explanation = await ask(window, question);
  assert.equal(readFileSync(agentsFile(project), "utf8"), original);
  console.log("Question left AGENTS.md unchanged:", explanation);
  for (const [index, board] of [project, other].entries()) {
    const boardWindow = index === 0 ? window : second;
    const request = requests[index];
    const first = await ask(boardWindow, request);
    const migrated = readFileSync(agentsFile(board), "utf8");
    assert.match(migrated, /AI Taskboard workflow/);
    assert.ok(migrated.includes(original));
    assert.equal(readBoardProjectRules(board).rules.length, 2);
    const repeat = await ask(boardWindow, request);
    assert.equal(readFileSync(agentsFile(board), "utf8"), migrated);
    if (board === project) assert.equal(readFileSync(agentsFile(other), "utf8"), original);
    assert.equal(readFileSync(agentsFile(isolated), "utf8"), original);
    console.log(request, "-", first, "| Repeat:", repeat);
  }
  console.log("Provider:", live ? "live" : "deterministic fixture", "| Electron", process.versions.electron);
  second.destroy();
  window.destroy();
}

void check().then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
