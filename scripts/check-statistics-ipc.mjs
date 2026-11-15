// Exercise the real preload/main/CLI statistics API with an isolated application profile.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "statistics-ipc", 90_000);
process.env.GIT_CEILING_DIRECTORIES = scratch;
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const { transformSync } = require("esbuild");
for (const path of ["userData", "appData"]) {
  const directory = join(scratch, path);
  mkdirSync(directory);
  app.setPath(path, directory);
}
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
// Let Electron finish loading the entry module before waiting for app.whenReady().
void (async () => {
try {
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm" }).code);
  const loaded = new Promise(resolve => app.once("browser-window-created", (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.webContents.once("did-finish-load", () => resolve(window));
  }));
  require(entry);
  const window = await loaded;
  const project = join(scratch, "board");
  mkdirSync(project);
  let selectedProject = project;
  const cli = (args, input) => JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE,
    ["--disable-warning=ExperimentalWarning", require("node:url").fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", selectedProject, "--json", ...args, ...(input ? ["--stdin"] : [])],
    { input: input ? JSON.stringify(input) : undefined, encoding: "utf8", windowsHide: true }));
  const initialized = cli(["init"]);
  assert.equal(initialized.ok, true);
  assert.equal(initialized.data.project, project);
  const task = cli(["create"], {title: "IPC statistics"}).data;
  const record = {threadId: "test", turnId: "test", model: "future-model", incomplete: false,
    totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, cacheWriteInputTokens: 5, reasoningOutputTokens: 10};
  assert.equal(cli(["token-usage", task.id], {id: "test", sequence: 1, role: "executor", records: [record]}).ok, true);
  assert.equal(cli(["cancel", task.id], {reason: "Fixture", actor: "user"}).ok, true);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  await window.webContents.executeJavaScript("window.taskboard.open()");
  const result = await window.webContents.executeJavaScript("window.taskboard.command('project-usage')");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data, cli(["project-usage"]).data);
  assert.equal(result.data.total, 120);
  assert.equal(result.data.byRole.executor[0].cachedInputTokens, 50);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await evaluate(predicate)) {
      if (Date.now() > deadline) throw new Error("Timed out: " + predicate);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await evaluate("document.getElementById('app-settings').click(); document.getElementById('settings-menu-statistics').click(); void 0");
  await waitFor("document.getElementById('project-statistics')?.textContent.includes('120')");
  assert.equal(cli(["token-usage", task.id], {id: "test", sequence: 2, role: "executor", records: [{...record, totalTokens: 240, inputTokens: 200, outputTokens: 40}]}).ok, true);
  assert.equal(cli(["manager-usage"], {id: "00000000-0000-0000-0000-000000000001", sequence: 1, records: [record]}).ok, true);
  await waitFor("document.getElementById('project-statistics')?.textContent.includes('360')");
  const updated = await evaluate("window.taskboard.command('project-usage')");
  assert.equal(updated.data.total, 360);
  assert.equal(updated.data.byRole.manager[0].totalTokens, 120);
  const second = join(scratch, "second");
  mkdirSync(second);
  selectedProject = second;
  const initializedSecond = cli(["init"]);
  assert.equal(initializedSecond.ok, true);
  assert.equal(initializedSecond.data.project, second);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] });
  await evaluate("window.taskboard.open()");
  await waitFor("!document.getElementById('sheet').open");
  await evaluate("document.getElementById('app-settings').click(); document.getElementById('settings-menu-statistics').click(); void 0");
  const empty = await evaluate("window.taskboard.command('project-usage')");
  assert.equal(empty.data.total, null);
  assert.equal(empty.data.tasks, 0);
  await waitFor("document.getElementById('project-statistics')?.textContent.includes('0 / 0')");
  writeFileSync(join(artifacts, "statistics-ipc.json"), JSON.stringify({ versions: process.versions, result, updated, empty,
    checks: ["exact canonical roots before fixture writes", "real gear menu", "saved task and manager reports refresh visible statistics", "switch to second empty project closes sheet and isolates totals"] }, null, 2));
  console.log("Statistics real preload/main/CLI check passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(process.exitCode ?? 0);
}
})();
