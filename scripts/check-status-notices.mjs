import { confirmFixtureDraft, plannedDraft } from "../tests/fixtures/planned-draft.ts";
// Exercise the production main process, watch, CLI, history and renderer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";
const { scratch, artifacts } = electronCheck(import.meta.url, "status-notices", 90_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog } = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), "junction");
mkdirSync(join(scratch, "profile"));
app.setPath("userData", join(scratch, "profile"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("lang", "ru");
const chosen = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen.shift()] });
const cli = (project, args, input) => {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"),
    "--project", project, "--json", ...args, ...(input === undefined ? [] : ["--stdin"])], {
    encoding: "utf8", windowsHide: true, input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
};
const waitFor = async predicate => {
  const until = Date.now() + 20000;
  while (!await predicate()) {
    assert.ok(Date.now() < until, "Timed out waiting for production UI");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
void (async () => { try {
  const first = join(scratch, "first"), second = join(scratch, "second");
  for (const project of [first, second]) {
    mkdirSync(project);
    cli(project, ["init"], { git: true });
    const draft = cli(project, ["create"], plannedDraft({
      title: "Проверка доступа к серверу", criteria: ["Доступ проверен"], workingDirectory: project,
    }));
    confirmFixtureDraft(project, draft.id);
  }
  // A legacy conversation must show notices without launching its provider.
  writeFileSync(join(first, ".tasks/orchestrator.json"), JSON.stringify({ provider: "codex", id: randomUUID() }));
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const legacyCursors = [];
  globalThis.statusTestLegacy = async cursor => {
    legacyCursors.push(cursor);
    return { turns: [], nextCursor: cursor === null ? "older" : null };
  };
  // Stub only the external history reader; exercise production cursor routing.
  const source = readFileSync(sourceUrl, "utf8")
    .replace('await readBoardHistory(app.getPath("userData"), project, thread.id, historyCursor)', 'await globalThis.statusTestLegacy(historyCursor)')
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main.mjs");
  writeFileSync(entry, require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code);
  require(entry);
  await waitFor(() => BrowserWindow.getAllWindows().length);
  const window = BrowserWindow.getAllWindows()[0];
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(code + ": " + error.message); });
  window.webContents.on("console-message", details => console.error(details.message));
  await waitFor(() => evaluate("!!window.taskboard"));
  const open = async project => {
    chosen.push(project);
    await evaluate("window.taskboard.menuAction('open-project')");
    await waitFor(async () => (await evaluate("window.taskboard.bootstrap()")).board?.project === project);
  };
  await open(first);
  // UI transition, then CLI/agent transitions with a closed dialogue in a background tab.
  await evaluate("window.taskboard.command('approve', 'T-0001')");
  await open(second);
  cli(first, ["start", "T-0001"]);
  cli(first, ["block", "T-0001"], { reason: "нужен доступ к серверу", condition: "доступ выдан" });
  await waitFor(() => {
    const path = join(first, ".tasks/manager-chat");
    try { return require("node:fs").readdirSync(path).length === 3; } catch { return false; }
  });
  assert.equal(require("node:fs").existsSync(join(second, ".tasks/manager-chat")), false);
  await evaluate(`window.taskboard.selectTab(${JSON.stringify(first)})`);
  await waitFor(async () => (await evaluate("window.taskboard.bootstrap()")).managerUnread?.length === 3);
  await evaluate("document.querySelector('#board-composer .board-draft-field').click()");
  await waitFor(() => evaluate("[...document.querySelectorAll('.board-manager-message')].some(e => e.textContent.includes('заблокирована: нужен доступ к серверу'))"));
  await evaluate("Promise.all(document.querySelector('#board-composer').getAnimations({subtree:true}).map(a=>a.finished)).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
  assert.ok(await evaluate("document.querySelector('.board-manager-message').getBoundingClientRect().height > 0"));
  writeFileSync(join(artifacts, "status-notice.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate("window.taskboard.menuAction('new-window')");
  await waitFor(() => BrowserWindow.getAllWindows().length === 2);
  const other = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
  await waitFor(() => other.webContents.executeJavaScript("!!window.taskboard"));
  chosen.push(first);
  await other.webContents.executeJavaScript("window.taskboard.menuAction('open-project')");
  await waitFor(async () => (await other.webContents.executeJavaScript("window.taskboard.bootstrap()")).board?.project === first);
  cli(first, ["resume", "T-0001"], { reason: "доступ выдан" });
  await waitFor(() => require("node:fs").readdirSync(join(first, ".tasks/manager-chat")).length === 4);
  assert.equal((await other.webContents.executeJavaScript(`window.taskboard.boardHistory(${JSON.stringify(first)})`)).data.turns.length, 4);
  const older = await other.webContents.executeJavaScript(`window.taskboard.boardHistory(${JSON.stringify(first)}, 'provider:')`);
  assert.equal(older.data.nextCursor, "provider:older");
  const oldest = await other.webContents.executeJavaScript(`window.taskboard.boardHistory(${JSON.stringify(first)}, 'provider:older')`);
  assert.equal(oldest.data.nextCursor, null);
  assert.deepEqual(legacyCursors.slice(-2), [null, "older"]);
  console.log("Production UI/CLI/agent transitions, closed dialogue, background tab, board isolation and message bubble: passed");
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(process.exitCode ?? 0);
} })();
