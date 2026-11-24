import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { electronCheck } from "./electron-check.mjs";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { locateBoard, onBoard } from "../src/cli/storage.ts";

const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "task-limits", 60_000,
  [["clean"], ["save-before-open"], ["open-after-save"], ["second-profile"], ["legacy-profile"], ["legacy-after-clean"],
    ["save"], ["restart"], ["stale-legacy-profile"]]);

void (async () => {
  const require = createRequire(import.meta.url);
  const { app, BrowserWindow, dialog } = require("electron");
  const { transformSync } = require("esbuild");
  const phase = process.argv.at(-1);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const appData = process.platform === "darwin" ? join(scratch, "Library", "Application Support") : join(scratch, "app-data");
  const profileName = ["second-profile", "stale-legacy-profile"].includes(phase) ? phase
    : ["save-before-open", "open-after-save"].includes(phase) ? "later-profile" : "AI Taskboard";
  const profile = join(appData, profileName);
  const cliEnv = { ...process.env, GIT_CEILING_DIRECTORIES: scratch, APPDATA: appData, XDG_CONFIG_HOME: appData, HOME: scratch };
  const board = join(scratch, "board");
  const manual = join(scratch, "manual");
  const profileLimits = join(profile, "task-limits.json");
  const runtime = join(board, ".tasks", "runtime.json");
  const report = join(artifacts, "default-task-limits-check.txt");
  const modules = join(scratch, "node_modules");
  const record = line => {
    console.log(line);
    writeFileSync(report, line + "\n", { flag: "a" });
  };
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  app.setPath("userData", profile);
  app.setPath("appData", appData);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("lang", "ru");

  function cli(project, command, input) {
    const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
      "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", project,
      "--json", command, ...(input ? ["--stdin"] : []),
    ], { cwd: scratch, env: cliEnv, encoding: "utf8", windowsHide: true, input: input && JSON.stringify(input) }));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  }
  function notice(expected, selectedProfile) {
    cli(board, "sync-notices", { language: "ru", profile: selectedProfile });
    const { effective } = onBoard(locateBoard(board), ({ index }) => index.managerSettings);
    assert.deepEqual([effective["Лимит задач в работе"], effective["Лимит задач на ревью"]], expected);
  }
  function reservations(executor, reviewer) {
    const pool = createAgentSlots(true);
    const releases = [];
    try {
      for (const [role, count] of Object.entries({ executor, reviewer })) {
        assert.equal(pool.available(board, role), count);
        for (let i = 0; i < count; i++) {
          const release = pool.acquire(board, role, undefined, role + i);
          assert.ok(release);
          releases.push(release);
        }
        assert.equal(pool.available(board, role), 0);
        assert.equal(pool.acquire(board, role, undefined, role + count), undefined);
      }
    } finally {
      for (const release of releases) release();
    }
    assert.equal(pool.available(board, "executor"), executor);
    assert.equal(pool.available(board, "reviewer"), reviewer);
  }
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw Error("UI wait timed out: " + label);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  let chosen = board;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });

  try {
    const entry = join(scratch, "main-under-test.mjs");
    if (phase === "clean") {
      writeFileSync(report, "");
      record(`Task limits — ${process.platform} ${process.arch}, Electron ${process.versions.electron}`);
      mkdirSync(board);
      mkdirSync(manual);
      cli(board, "init", { git: false });
      cli(manual, "init", { boardType: "manual" });
      assert.equal(existsSync(profileLimits), false);
      notice([2, 1]);
      reservations(2, 1);
      record("PASS fresh agent board has 2 execution slots and 1 review slot in CLI notices and shared reservations.");
      cli(board, "settings", { taskLimits: {} });
      notice([3, 2]);
      reservations(3, 2);
      writeFileSync(runtime, JSON.stringify([{ id: "task-defaults", kind: "defaults", owner: 0,
        limits: { executor: 5, manager: 0, reviewer: 1 } }]));
      notice([5, 1]);
      writeFileSync(runtime, JSON.stringify([{ id: "task-defaults", kind: "defaults", owner: 0,
        limits: { executor: 1, manager: 0, reviewer: 1 } }]));
      notice([3, 2]);
      reservations(3, 2);
      const url = new URL("../src/desktop/main.ts", import.meta.url);
      const source = readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href))
        .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, specifier) => "from " + JSON.stringify(new URL(specifier, url).href));
      writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm" }).code);
    } else if (phase === "legacy-profile" || phase === "legacy-after-clean") {
      const legacy = phase === "legacy-profile";
      writeFileSync(profileLimits, JSON.stringify({ executor: 1, manager: 0, reviewer: 1 }));
      utimesSync(profileLimits, 100, 100);
      writeFileSync(runtime, JSON.stringify([{ id: legacy ? "task-defaults" : "task-defaults-v2", kind: "defaults", owner: 0,
        limits: { executor: legacy ? 5 : 3, manager: 0, reviewer: legacy ? 1 : 2 } }]));
      reservations(legacy ? 5 : 3, legacy ? 1 : 2);
      notice([1, 1]);
      notice(legacy ? [5, 1] : [3, 2], join(appData, "unused-profile"));
      notice([1, 1], profile);
    } else if (phase === "save") {
      cli(board, "settings", { taskLimits: { reviewer: 0 } });
    } else if (phase === "stale-legacy-profile") {
      mkdirSync(profile, { recursive: true });
      writeFileSync(profileLimits, JSON.stringify({ executor: 5, manager: 0, reviewer: 1 }));
      utimesSync(profileLimits, 100, 100);
      notice([4, 0], profile);
    }
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), modules,
      process.platform === "win32" ? "junction" : "dir");
    app.on("web-contents-created", (_event, contents) => contents.setBackgroundThrottling(false));
    await import(pathToFileURL(entry).href);
    await wait(() => BrowserWindow.getAllWindows().length > 0, "main window");
    const window = BrowserWindow.getAllWindows()[0];
    const evaluate = code => window.webContents.executeJavaScript(code);
    await wait(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer");
    async function open(project) {
      chosen = project;
      await evaluate("window.taskboard.menuAction('open-project')");
      await wait(() => evaluate("window.taskboard.bootstrap().then(f => !f.loading && Boolean(f.board))"), "board");
    }
    async function showLimits(expected) {
      await evaluate("settings(); void 0");
      const values = () => evaluate("Array.from(document.querySelectorAll('#agent-limits input[type=number]'), input => input.value)");
      await wait(async () => JSON.stringify(await values()) === JSON.stringify(expected.map(String)), "application limits");
    }
    async function boardLimits(expected) {
      await evaluate("boardSettings(); void 0");
      const values = () => evaluate(`["executor", "reviewer"].map(role => {
        const input = document.querySelector('input[name=' + role + 'Limit]');
        return input && [input.value, input.placeholder];
      })`);
      await wait(async () => JSON.stringify(await values()) === JSON.stringify(expected), "board limits");
    }
    async function saveLimits(executor, reviewer) {
      await evaluate(`(() => {
        const form = document.querySelector('#agent-limits');
        form.elements.executor.value = ${executor};
        form.elements.reviewer.value = ${reviewer};
        form.requestSubmit();
      })()`);
      await wait(() => existsSync(profileLimits) &&
        JSON.parse(readFileSync(profileLimits, "utf8")).executor === executor, "saved application limits");
    }

    if (phase === "clean") {
      await showLimits([3, 2]);
      await open(board);
      await boardLimits([["", "3"], ["", "2"]]);
      await showLimits([3, 2]);
      await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(resolve)))");
      const screenshot = await window.webContents.capturePage();
      assert.ok(!screenshot.isEmpty());
      writeFileSync(join(artifacts, "default-task-limits.png"), screenshot.toPNG());
      notice([3, 2]);
      reservations(3, 2);
      await open(manual);
      await evaluate("boardSettings(); void 0");
      assert.equal(await evaluate("document.querySelectorAll('input[name$=Limit]').length"), 0);
      record("PASS clean profile and legacy board cache: implicit 1/1 becomes 3/2 in UI, CLI notices and both slot pools; legacy 5/1 remains readable; manual settings have no task limits.");
    } else if (phase === "save-before-open") {
      assert.equal(await evaluate("window.taskboard.bootstrap().then(f => Boolean(f.board))"), false);
      await showLimits([3, 2]);
      reservations(3, 2);
      await saveLimits(1, 1);
      reservations(3, 2);
      record("PASS app saved 1/1 with no board open; the existing shared cache still contains 3/2.");
    } else if (["legacy-profile", "legacy-after-clean", "second-profile", "open-after-save"].includes(phase)) {
      if (phase === "second-profile") {
        assert.equal(existsSync(profileLimits), false);
        await showLimits([3, 2]);
        notice([1, 1], profile);
        reservations(1, 1);
      } else if (phase === "open-after-save") {
        reservations(3, 2);
        notice([1, 1], profile);
      }
      await open(board);
      await boardLimits([["", "1"], ["", "1"]]);
      await showLimits([1, 1]);
      notice([1, 1], profile);
      reservations(1, 1);
      if (phase === "second-profile") {
        assert.equal(existsSync(profileLimits), false);
        record("PASS second clean Electron profile opens the shared board without replacing 1/1; both pools still deny the next slot.");
      } else if (phase === "open-after-save") {
        record("PASS reopening the app applies explicit 1/1 to the existing 3/2 cache on first board open; CLI and both pools use 1/1.");
      } else {
        const previous = phase === "legacy-profile" ? "legacy 5/1" : "published defaults 3/2";
        record(`PASS explicit legacy profile 1/1 replaces ${previous} in CLI before opening and in both slot pools after opening.`);
      }
    } else {
      await open(board);
      const appLimits = phase === "save" ? [1, 1] : [4, 2];
      await boardLimits([["", String(appLimits[0])], ["0", String(appLimits[1])]]);
      await showLimits(appLimits);
      assert.deepEqual(cli(board, "settings").taskLimits, { reviewer: 0 });
      notice([appLimits[0], 0], profile);
      const pool = createAgentSlots(true);
      assert.equal(pool.available(board, "executor"), appLimits[0]);
      assert.equal(pool.available(board, "reviewer"), Infinity);
      if (phase === "save") {
        await saveLimits(4, 2);
        record("PASS saved board review 0 takes precedence over app review 1 in settings, notices and slot availability.");
      } else if (phase === "restart") {
        record("PASS after application restart: saved app 4/2 and board review 0 persist; inherited work 4 and unlimited review are effective.");
      } else {
        record("PASS older legacy profile 5/1 does not replace the newer explicit 4/2 in CLI, Electron and shared slots.");
      }
    }
    if (keepArtifacts) console.log(report);
    unlinkSync(modules);
    app.quit();
  } catch (error) {
    console.error(error);
    if (existsSync(modules)) unlinkSync(modules);
    app.exit(1);
  }
})();
