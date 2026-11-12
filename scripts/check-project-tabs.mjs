import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const directory = join(root, ".tasks", "qa", "project-tabs");
  mkdirSync(directory, { recursive: true });
  const artifacts = mkdtempSync(join(directory, "run-"));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const stage of ["open", "restore"]) {
    const result = spawnSync(require("electron"), [script, stage, artifacts], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 90_000,
      env: environment,
    });
    process.stdout.write(result.stdout ?? "");
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      throw result.error ?? new Error("Project tab checks failed: " + result.status);
    }
  }
  console.log("Project tab artifacts: " + artifacts);
} else void (async () => {
  const { app, BrowserWindow, dialog } = require("electron");
  const { transformSync } = require("esbuild");
  const [, , stage, artifacts] = process.argv;
  const profile = join(artifacts, "profile");
  const appData = join(artifacts, "app-data");
  mkdirSync(profile, { recursive: true });
  mkdirSync(appData, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("appData", appData);
  // The QA profile may run alongside the user's application on Windows.
  app.requestSingleInstanceLock = () => true;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("lang", "ru");
  const first = join(artifacts, "first", "Project");
  const second = join(artifacts, "second", "Project");
  const unavailable = join(artifacts, "unavailable");
  const cli = (project, args, input) => JSON.parse(execFileSync(process.execPath, [
    "--disable-warning=ExperimentalWarning", join(root, "src", "cli", "main.ts"),
    "--project", project, "--json", ...args, ...(input === undefined ? [] : ["--stdin"]),
  ], { cwd: project, encoding: "utf8", windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, input: input === undefined ? undefined : JSON.stringify(input) }));
  const chosen = [];
  const warnings = [];
  let response = 0;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen.shift()] });
  dialog.showMessageBox = async (_window, options) => { warnings.push(options); return { response }; };
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks++; };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out: " + message);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  try {
    if (stage === "open") {
      for (const [project, title] of [[first, "First project task"], [second, "Second project task"]]) {
        mkdirSync(project, { recursive: true });
        assert.equal(cli(project, ["init"], { git: true }).ok, true);
        assert.equal(cli(project, ["create"], { title }).ok, true);
      }
    }
    // Run the main process unchanged, with one private hook for simulating a long operation.
    // Relative imports and import.meta keep their source locations after TypeScript stripping.
    const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
    const code = transformSync(source, { loader: "ts", format: "esm" }).code;
    const entry = join(artifacts, "main-under-test.mjs");
    writeFileSync(entry, code + "\nglobalThis.tabTest = { beginOperation, windowStates };\n");
    require(entry);
    await waitFor(() => BrowserWindow.getAllWindows().length === 1, "initial window");
    const window = BrowserWindow.getAllWindows()[0];
    const errors = [];
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    const evaluate = code => window.webContents.executeJavaScript(code);
    const frame = () => evaluate("window.taskboard.bootstrap()");
    await waitFor(() => evaluate("Boolean(window.taskboard && document.querySelector('#app-menu button'))"), "renderer startup");
    const open = async path => {
      chosen.push(path);
      await evaluate("window.taskboard.menuAction('open-project')");
      await waitFor(async () => !(await frame()).loading, "project loading");
    };
    const select = async path => evaluate("window.taskboard.selectTab(" + JSON.stringify(path) + ")");
    if (stage === "open") {
      await open(first);
      await open(second);
      check((await frame()).tabs.length === 2, "opening two folders adds two tabs");
      check((await frame()).board.tasks[0].title === "Second project task", "active board uses its own T-0001");
      check(await evaluate("[...document.querySelectorAll('.project-tab-name')].every(item => item.textContent === 'Project')"), "tab names match folder names");
      check(await evaluate("[...document.querySelectorAll('.project-tab-detail')].map(item => item.textContent).join(',') === 'first,second'"), "same names have parent paths");
      await select(first);
      check(await evaluate("document.querySelector('.task-card strong').textContent === 'First project task'"), "switching tabs renders the matching task");
      await open(process.platform === "win32" ? first.toUpperCase() : first);
      check((await frame()).tabs.length === 2, "case aliases do not create duplicate tabs");
      const alias = join(artifacts, "linked-project");
      symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
      await open(alias);
      check((await frame()).tabs.length === 2, "folder links select the existing tab");
      const git = (...args) => execFileSync("git", args, { cwd: first, encoding: "utf8", windowsHide: true });
      git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "--no-gpg-sign", "-m", "Initial");
      const worktree = join(artifacts, "worktree");
      git("worktree", "add", "-b", "other", worktree);
      await open(worktree);
      check((await frame()).tabs.length === 2 && (await frame()).project === first, "linked worktree selects its canonical board");
      cli(second, ["update", "T-0001"], { title: "Second project updated" });
      await new Promise(resolve => setTimeout(resolve, 700));
      check((await frame()).board.tasks[0].title === "First project task", "background watcher cannot replace active board");
      await select(second);
      await waitFor(async () => (await frame()).board.tasks[0].title === "Second project updated", "background update");
      check(true, "background tab receives fresh data");
      await evaluate("document.querySelector('.task-card').click()");
      await waitFor(() => evaluate("document.querySelector('#sheet').open"), "task sheet");
      await select(first);
      check(await evaluate("!document.querySelector('#sheet').open"), "switching projects closes the previous task sheet");
      await evaluate("document.querySelector('.app-menu-trigger').click(); [...document.querySelectorAll('.app-menu-item')].find(item => /Open recent|Открыть последнее/.test(item.textContent)).click()");
      check(await evaluate("!document.querySelector('.app-menu-submenu').hidden && document.querySelectorAll('.app-menu-submenu button').length === 2"), "File menu has a recent project submenu");
      await evaluate("document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
      await evaluate("window.taskboard.menuAction('new-window')");
      await waitFor(() => BrowserWindow.getAllWindows().length === 2, "second window");
      const other = BrowserWindow.getAllWindows().find(item => item !== window);
      await waitFor(() => other.webContents.executeJavaScript("Boolean(window.taskboard)"), "second renderer");
      chosen.push(first);
      await other.webContents.executeJavaScript("window.taskboard.open()");
      check((await other.webContents.executeJavaScript("window.taskboard.bootstrap()")).tabs.length === 1,
        "another window may open the same board independently");
      other.close();
      await waitFor(() => BrowserWindow.getAllWindows().length === 1, "second window closing");
      cli(first, ["update", "T-0001"], { title: "First project updated" });
      await waitFor(async () => (await frame()).board.tasks[0].title === "First project updated", "remaining subscription");
      check(true, "closing one window preserves the other window's board watcher");
      const operation = globalThis.tabTest.beginOperation(first);
      let interrupted = false;
      operation.controller.signal.addEventListener("abort", () => { interrupted = true; setTimeout(operation.finish, 10); }, { once: true });
      await select(second);
      check(!interrupted, "switching preserves a background operation");
      await evaluate("window.taskboard.menuAction('quit')");
      await waitFor(() => warnings.length > 0, "quit confirmation");
      check(!interrupted && !window.isDestroyed(), "canceling quit preserves running operations and windows");
      await evaluate("window.taskboard.closeTab(" + JSON.stringify(first) + ")");
      check(!interrupted && (await frame()).tabs.length === 2, "canceling close keeps the running project");
      check(warnings[0].defaultId === 0 && warnings[0].cancelId === 0, "warning defaults to cancellation");
      response = 1;
      await evaluate("window.taskboard.closeTab(" + JSON.stringify(first) + ")");
      check(interrupted && (await frame()).tabs.length === 1, "confirmed close interrupts and waits for completion");
      await open(first);
      await select(second);
      await evaluate("window.taskboard.setTheme('dark')");
      await waitFor(() => evaluate("document.querySelectorAll('.project-tab').length === 2"), "tab rendering");
      writeFileSync(join(artifacts, "project-tabs-dark.png"), (await window.webContents.capturePage()).toPNG());
      window.setSize(760, 700);
      await evaluate("window.taskboard.setTheme('light')");
      await new Promise(resolve => setTimeout(resolve, 150));
      writeFileSync(join(artifacts, "project-tabs-light-narrow.png"), (await window.webContents.capturePage()).toPNG());
      await open(unavailable);
      check((await frame()).error.code === "PROJECT_UNAVAILABLE" && (await frame()).tabs.length === 3, "missing folder retains a closable error tab");
      await select(second);
      const saved = JSON.parse(readFileSync(join(profile, "project-tabs.json"), "utf8"));
      check(saved[0].projects.join("|") === [second, first, unavailable].join("|") && saved[0].active === second, "session persists tab order and active project");
    } else {
      await waitFor(async () => {
        const snapshot = await frame();
        return snapshot.tabs.length === 3 && snapshot.project === second && Boolean(snapshot.board);
      }, "restored projects");
      check((await frame()).tabs.map(tab => tab.path).join("|") === [second, first, unavailable].join("|"), "relaunch restores tab order");
      check((await frame()).project === second, "relaunch restores the active project");
      check((await frame()).runningTasks.length === 0, "relaunch does not restart agents");
      await select(unavailable);
      check((await frame()).error.code === "PROJECT_UNAVAILABLE", "unavailable restored project shows its own error");
      await evaluate("window.taskboard.closeTab(" + JSON.stringify(unavailable) + ")");
      await select(second);
      await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))");
      await waitFor(async () => (await frame()).project === first, "keyboard tab switch");
      check(await evaluate("document.activeElement.getAttribute('aria-selected') === 'true'"), "keyboard switch focuses selected tab");
      for (const path of [second, first]) await evaluate("window.taskboard.closeTab(" + JSON.stringify(path) + ")");
      check(await evaluate("!document.querySelector('#welcome').hidden && document.querySelector('#project-tabs').hidden"), "closing the last tab returns to project selection");
    }
    check(!errors.length, "renderer has no console errors: " + errors.join("\n"));
    console.log("Project tabs " + stage + " checks passed: " + checks);
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
})();
