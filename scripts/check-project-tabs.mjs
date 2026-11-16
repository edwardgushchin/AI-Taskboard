import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const artifacts = mkdtempSync(join(tmpdir(), "taskboard-tabs-"));
  const outputIndex = process.argv.indexOf("--artifacts");
  const output = outputIndex < 0 ? undefined : resolve(process.argv[outputIndex + 1]);
  const environment = { ...process.env };
  if (process.argv.includes("--reorder-only")) environment.TASKBOARD_TAB_REORDER_ONLY = "1";
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
  symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(artifacts, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const stage of ["open", "restore"]) {
    const result = spawnSync(require("electron"), [script, stage, artifacts], {
      cwd: artifacts, encoding: "utf8", windowsHide: true, timeout: 90_000,
      env: environment,
    });
    process.stdout.write(result.stdout ?? "");
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      throw result.error ?? new Error("Project tab checks failed: " + result.status);
    }
  }
  if (output) {
    mkdirSync(output, { recursive: true });
    for (const name of ["project-tabs-reordered.png", "project-tabs-drop.png"])
      copyFileSync(join(artifacts, name), join(output, name));
    console.log("Project tab screenshots: " + output);
  }
  } finally {
    rmSync(artifacts, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log("Temporary profile removed: " + artifacts);
  }
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
    app.on("web-contents-created", (_event, contents) => {
      contents.setBackgroundThrottling(false);
      contents.on("dom-ready", () => void contents.executeJavaScript(`
        window.startupView = { welcomeSeen: false, loadingSeen: false };
        const sampleStartup = () => {
          window.startupView.welcomeSeen ||= !document.querySelector('#welcome').hidden;
          window.startupView.loadingSeen ||= document.querySelector('#app-content').getAttribute('aria-busy') === 'true';
        };
        sampleStartup();
        window.startupObserver = new MutationObserver(sampleStartup);
        window.startupObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-busy'] });
        void 0;
      `));
    });
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
    const checkAppearance = async theme => {
      await evaluate("window.taskboard.setTheme(" + JSON.stringify(theme) + ")");
      await evaluate("document.querySelector('.app-menu-trigger').click()");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const menuPosition = await evaluate(`(() => {
        const menu = document.querySelector('.app-menu-group > .app-menu-popup');
        const trigger = document.querySelector('.app-menu-trigger').getBoundingClientRect();
        const popup = menu.getBoundingClientRect();
        const tabs = document.querySelector('#project-tabs').getBoundingClientRect();
        const point = document.elementFromPoint(popup.left + 12, tabs.top + tabs.height / 2);
        return { gap: popup.top - trigger.bottom, aboveTabs: menu.contains(point) };
      })()`);
      writeFileSync(join(artifacts, "project-tabs-menu-" + theme + ".png"), (await window.webContents.capturePage()).toPNG());
      check(menuPosition.gap >= 0 && menuPosition.gap <= 4, "File menu is anchored directly below its trigger in " + theme);
      check(menuPosition.aboveTabs, "File menu paints above the project tabs in " + theme);
      await evaluate("document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
      const hover = async selector => {
        const point = await evaluate(`(() => {
          const tab = document.querySelector('.project-tab:has([aria-selected="false"])');
          const target = tab.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: Math.round(target.left + target.width / 2), y: Math.round(target.top + target.height / 2) };
        })()`);
        window.webContents.sendInputEvent({ type: "mouseMove", ...point });
        await new Promise(resolve => setTimeout(resolve, 200));
        return evaluate(`(() => {
          const tab = document.querySelector('.project-tab:has([aria-selected="false"])');
          return { hovered: tab.matches(':hover'), background: getComputedStyle(tab).backgroundColor,
            label: getComputedStyle(tab.querySelector('.project-tab-button')).backgroundColor,
            close: getComputedStyle(tab.querySelector('.project-tab-close')).backgroundColor };
        })()`);
      };
      const label = await hover(".project-tab-button");
      check(label.hovered && label.background !== "rgba(0, 0, 0, 0)" && label.label === "rgba(0, 0, 0, 0)" &&
        label.close === "rgba(0, 0, 0, 0)", "hover highlights the entire tab including the close area in " + theme);
      const close = await hover(".project-tab-close");
      check(close.hovered && close.background === label.background && close.close === "rgba(0, 0, 0, 0)",
        "moving to the close button retains the full tab highlight in " + theme);
      writeFileSync(join(artifacts, "project-tabs-hover-" + theme + ".png"), (await window.webContents.capturePage()).toPNG());
      window.webContents.sendInputEvent({ type: "mouseMove", x: 500, y: 400 });
    };
    if (stage === "open") {
      await open(first);
      await open(second);
      check((await frame()).tabs.length === 2, "opening two folders adds two tabs");
      check((await frame()).board.tasks[0].title === "Second project task", "active board uses its own T-0001");
      check(await evaluate("[...document.querySelectorAll('.project-tab-name')].every(item => item.textContent === 'Project')"), "tab names match folder names");
      check(await evaluate("[...document.querySelectorAll('.project-tab-detail')].map(item => item.textContent).join(',') === 'first,second'"), "same names have parent paths");
      await select(first);
      check(await evaluate("document.querySelector('.task-card strong').textContent === 'First project task'"), "switching tabs renders the matching task");
      await evaluate("showTask('T-0001')");
      await evaluate("[...document.querySelectorAll('#sheet-body button')].find(button => button.textContent === 'Доступ исполнителя…').click()");
      check(await evaluate("document.querySelector('select[name=mode]').value === 'auto'"), "executor access defaults to auto-review");
      await evaluate(`(() => {
        const mode = document.querySelector('select[name=mode]');
        mode.value = 'full';
        mode.form.requestSubmit();
      })()`);
      await waitFor(() => evaluate("document.querySelector('#sheet-body').textContent.includes('Режим запуска: полный доступ')"), "full access label");
      check((await evaluate("window.taskboard.command('show','T-0001')")).data.executorFullAccess, "full access is saved from the task settings");
      await evaluate("document.querySelector('dialog[open]').close()");
      await select(second);
      check(!(await evaluate("window.taskboard.command('show','T-0001')")).data.executorFullAccess,
        "a task with the same ID in another project uses its own access");
      await select(first);
      if (!process.env.TASKBOARD_TAB_REORDER_ONLY) await checkAppearance("dark");
      window.setSize(760, 700);
      if (!process.env.TASKBOARD_TAB_REORDER_ONLY) await checkAppearance("light");
      window.setSize(1380, 900);
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
      await evaluate("window.taskboard.reorderTab(" + JSON.stringify(first) + ", " + JSON.stringify(second) + ", true)");
      check(!interrupted && (await frame()).project === second, "reordering preserves the background operation and active project");
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
      await waitFor(() => evaluate("document.querySelector('.project-tab:has([aria-selected=true])')?.dataset.project === " + JSON.stringify(second)), "selected tab rendered before drag");
      const order = async expected => {
        await waitFor(() => evaluate("[...document.querySelectorAll('.project-tab')].map(tab => tab.dataset.project).join('|') === " + JSON.stringify(expected.join("|"))), "reordered DOM");
        check((await frame()).tabs.map(tab => tab.path).join("|") === expected.join("|"), "main process and rendered order agree");
        check((await frame()).project === second, "reordering preserves the active project");
      };
      const drag = async (source, target, after, cancel = false) => {
        await evaluate(`(() => {
          const tabs = [...document.querySelectorAll('.project-tab')];
          const source = tabs.find(tab => tab.dataset.project === ${JSON.stringify(source)}).querySelector('.project-tab-button');
          const target = tabs.find(tab => tab.dataset.project === ${JSON.stringify(target)});
          const transfer = new DataTransfer();
          const rect = target.getBoundingClientRect();
          const options = { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: ${after} ? rect.bottom - 2 : rect.top + 2 };
          source.dispatchEvent(new DragEvent('dragstart', options));
          target.dispatchEvent(new DragEvent('dragover', options));
          window.cancelTestDrag = () => source.dispatchEvent(new DragEvent('dragend', options));
          ${cancel ? "" : "target.dispatchEvent(new DragEvent('drop', options)); window.cancelTestDrag();"}
        })()`);
      };
      await drag(unavailable, second, false, true);
      check(await evaluate("Boolean(document.querySelector('.drop-before'))"), "drag shows the insertion marker");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      writeFileSync(join(artifacts, "project-tabs-drop.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate("window.cancelTestDrag()");
      await order([second, first, unavailable]);
      check(await evaluate("!document.querySelector('.drop-before, .drop-after')"), "canceled drag removes insertion marker");
      await drag(unavailable, second, false);
      await order([unavailable, second, first]);
      await drag(second, first, true);
      await order([unavailable, first, second]);
      await drag(second, second, true);
      await order([unavailable, first, second]);
      await evaluate("window.taskboard.reorderTab('unknown-project', " + JSON.stringify(first) + ", false)");
      await evaluate("window.taskboard.reorderTab(" + JSON.stringify(first) + ", 'unknown-project', false)");
      await order([unavailable, first, second]);
      // Files from outside the tab strip must not move or open a project.
      await evaluate("document.querySelector('.project-tab').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))");
      await order([unavailable, first, second]);
      await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))");
      await order([unavailable, second, first]);
      await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }))");
      await order([unavailable, first, second]);
      writeFileSync(join(artifacts, "project-tabs-reordered.png"), (await window.webContents.capturePage()).toPNG());
      const saved = JSON.parse(readFileSync(join(profile, "project-tabs.json"), "utf8"));
      check(saved[0].projects.join("|") === [unavailable, first, second].join("|") && saved[0].active === second, "session persists tab order and active project");
    } else {
      await waitFor(async () => {
        const snapshot = await frame();
        return snapshot.tabs.length === 3 && snapshot.project === second && Boolean(snapshot.board);
      }, "restored projects");
      check(await evaluate("window.startupView.loadingSeen && !window.startupView.welcomeSeen"), "restoring a saved session reports aria-busy without exposing the welcome screen");
      check(await evaluate("document.querySelector('#welcome').hidden && !document.querySelector('#loading') && document.querySelector('#app-content').getAttribute('aria-busy') === 'false'"), "the active restored board clears aria-busy without a loading label");
      await evaluate("window.startupObserver.disconnect()");
      check((await frame()).tabs.map(tab => tab.path).join("|") === [unavailable, first, second].join("|"), "relaunch restores tab order");
      check((await frame()).project === second, "relaunch restores the active project");
      check((await frame()).runningTasks.length === 0, "relaunch does not restart agents");
      await select(unavailable);
      check((await frame()).error.code === "PROJECT_UNAVAILABLE", "unavailable restored project shows its own error");
      await evaluate("window.taskboard.closeTab(" + JSON.stringify(unavailable) + ")");
      await select(second);
      await evaluate("document.querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))");
      await waitFor(async () => (await frame()).project === first, "keyboard tab switch");
      check(await evaluate("document.activeElement.getAttribute('aria-selected') === 'true'"), "keyboard switch focuses selected tab");
      check((await evaluate("window.taskboard.command('show','T-0001')")).data.executorFullAccess, "the executor access setting survives relaunch");
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
