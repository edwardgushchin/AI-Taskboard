// Real per-user NSIS installation and restart; deterministic release/provider fixtures.
// Every package/profile/board lives in one disposable system temporary directory.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
assert.equal(process.platform, "win32", "This check installs Windows NSIS packages.");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const outputOption = process.argv.indexOf("--artifacts");
assert.ok(outputOption >= 0, "Supply --artifacts with a review directory.");
const artifacts = resolve(process.argv[outputOption + 1]);
mkdirSync(artifacts, { recursive: true });
if (!process.env.TASKBOARD_UPDATE_QA_SCRATCH) {
    const directory = mkdtempSync(join(tmpdir(), "taskboard-update-install-"));
    let status = 1;
    try {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
            cwd: root, stdio: "inherit", windowsHide: true, timeout: 600000,
            env: { ...process.env, TASKBOARD_UPDATE_QA_SCRATCH: directory },
        });
        if (child.error) {
            console.error(child.error);
        }
        status = child.status ?? 1;
    }
    finally {
        // Native packaging helpers can retain directory handles until their Node owner exits.
        assert.equal(dirname(directory), resolve(tmpdir()));
        const cleanup = spawnSync(process.execPath, ["--input-type=module", "-e",
            'import { rm } from "node:fs/promises"; await rm(process.argv[1], { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });',
            directory], { cwd: tmpdir(), windowsHide: true, stdio: "inherit" });
        assert.equal(cleanup.status, 0, "Temporary QA directory cleanup failed");
        assert.equal(existsSync(directory), false);
        const path = join(artifacts, "update-install-report.json");
        if (existsSync(path)) {
            const report = JSON.parse(readFileSync(path, "utf8"));
            report.cleanupScratchRemoved = true;
            writeFileSync(path, JSON.stringify(report, null, 2));
        }
        console.log("Isolated NSIS QA cleaned: " + directory);
    }
    process.exit(status);
}
const scratch = process.env.TASKBOARD_UPDATE_QA_SCRATCH;
assert.equal(dirname(scratch), resolve(tmpdir()));
const project = join(scratch, "source");
const installDirectory = join(scratch, "Installed client with spaces");
const profile = join(scratch, "Profile with spaces");
const control = join(scratch, "control");
const productExecutable = "AI Taskboard QA " + randomUUID().slice(0, 8);
const oldVersion = "0.1.0-alpha";
const newVersion = "0.1.1-alpha";
const record = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, oldVersion, newVersion, checks: [], packages: [], sourceHashes: {} };
record.sourceHashesLF = {};
record.seams = ["QA-only bootstrap substitutes release HTTP responses and the model provider; real manager registration/callback, IPC, renderer, download/hash verification, helper, shutdown, NSIS and restart run unchanged.",
    "Unique appId/executableName isolate installed product; NSIS PATH hooks and desktop/start-menu shortcuts are disabled in QA only. Process safety hook is retained.",
    "QA packages omit Huggingface and bundled standalone CLI; board CLI calls use the packaged Electron Node runtime. No code signing or live official release download is verified.",
    "Confirmation responses are deterministic through dialog.showMessageBox; the before/after PNGs show the real manager conversation."];
record.testedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
record.gitStatusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
let child;
let childLogs = "";
let installed = false;
let seq = 0;
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
async function until(probe, label, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await probe();
        if (result) {
            return result;
        }
        await delay(100);
    }
    throw new Error("Timed out: " + label);
}
function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
function updateCachesFor(executable) {
    return readdirSync(tmpdir(), { withFileTypes: true }).flatMap(entry => {
        if (!entry.isDirectory() || !/^ai-taskboard-update-[a-zA-Z0-9]+$/.test(entry.name)) {
            return [];
        }
        const path = join(tmpdir(), entry.name);
        return readJson(join(path, "update.json"))?.executable === executable ? [path] : [];
    });
}
async function command(input) {
    const id = ++seq;
    writeJson(join(control, "command.json"), { id, ...input });
    const response = await until(() => {
        const reply = readJson(join(control, "reply.json"));
        return reply?.id === id && reply;
    }, input.action + " " + (input.text ?? ""), 90000);
    assert.ok(!response.error, JSON.stringify(response));
    return response.result;
}
const cli = (directory, args, input) => {
    const result = JSON.parse(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning",
        join(root, "src/cli/main.ts"), "--project", directory, "--json", ...args,
        ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", windowsHide: true,
        input: input === undefined ? undefined : JSON.stringify(input), env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
};
const note = text => {
    record.checks.push(text);
    console.log(text);
};
try {
    mkdirSync(project);
    mkdirSync(profile);
    mkdirSync(control);
    cpSync(join(root, "src"), join(project, "src"), { recursive: true });
    for (const name of ["main.ts", "installation-updates.ts", "update-runner.ps1", "updates.ts", "localization.cjs"]) {
        const content = readFileSync(join(project, "src/desktop", name));
        record.sourceHashes["src/desktop/" + name] = sha(content);
        record.sourceHashesLF["src/desktop/" + name] = sha(content.toString("utf8").replaceAll("\r\n", "\n"));
    }
    record.sourceHashes["build/installer.nsh"] = sha(readFileSync(join(root, "build/installer.nsh")));
    record.sourceHashesLF["build/installer.nsh"] = sha(readFileSync(join(root, "build/installer.nsh"), "utf8").replaceAll("\r\n", "\n"));
    record.hashRepresentation = "SHA-256 of raw checked-out source bytes, before QA-only bootstrap instrumentation";
    const source = readFileSync(join(project, "src/desktop/main.ts"), "utf8")
        .replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask");
    assert.ok(!source.includes("readTaskRunHistory, replyToBoard, replyToTask"));
    writeFileSync(join(project, "src/desktop/main.ts"), "const replyToBoard = (...args) => globalThis.qaManager(...args);\n" + source +
        "\nglobalThis.qaBeginOperation = project => beginOperation(project, 'QA held operation');\n");
    const installerInclude = readFileSync(join(root, "build/installer.nsh"), "utf8")
        .replace(/!ifdef BUILD_UNINSTALLER[\s\S]*?!endif/, "")
        .replace(/!macro customInstall\b[\s\S]*?!macroend/, "!macro customInstall\n!macroend")
        .replace(/!macro customUnInstall\b[\s\S]*?!macroend/, "!macro customUnInstall\n!macroend");
    writeFileSync(join(project, "installer.nsh"), installerInclude);
    const qaModules = ["semver", "markdown-it", "fflate", "prismjs", "argparse", "entities", "linkify-it", "mdurl", "punycode.js", "uc.micro"];
    const modulesRoot = dirname(dirname(require.resolve("electron/package.json")));
    for (const name of qaModules) {
        const path = join(modulesRoot, name);
        cpSync(path, join(project, "node_modules", name), { recursive: true });
    }
    const boards = [join(scratch, "Board one with spaces"), join(scratch, "Board two with spaces")];
    for (const board of boards) {
        mkdirSync(board);
        cli(board, ["init"], { git: false });
        cli(board, ["settings"], { reviewMode: "human", autoMode: false });
    }
    writeJson(join(profile, "appearance.json"), { theme: "dark", language: "ru" });
    writeJson(join(profile, "project-tabs.json"), [{ projects: boards, active: boards[0] }]);
    writeFileSync(join(profile, "profile-marker.txt"), "Profile survives NSIS update — Профиль сохранён\n");
    const markerHash = sha(readFileSync(join(profile, "profile-marker.txt")));
    const bootstrap = `import assert from 'node:assert/strict';
import { app, BrowserWindow, dialog } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackProvider, trackActiveRun } from './src/desktop/active-runs.ts';
import { registerRuntime, runtimeEntries } from './src/desktop/board-runtime.ts';
const control = ${JSON.stringify(control)};
const artifacts = ${JSON.stringify(artifacts)};
assert.equal(app.getPath('userData'), ${JSON.stringify(profile)}, 'Profile must be forwarded by the actual launch/restart arguments');
mkdirSync(${JSON.stringify(join(scratch, "appData"))}, { recursive: true });
app.setPath('appData', ${JSON.stringify(join(scratch, "appData"))});
app.disableHardwareAcceleration();
const write = (name, value) => writeFileSync(join(control, name), JSON.stringify(value));
process.on('uncaughtException', error => {
    write('fatal.json', { error: error.stack });
    app.exit(1);
});
process.on('unhandledRejection', error => {
    write('fatal.json', { error: error?.stack ?? String(error) });
    app.exit(1);
});
const fixture = () => JSON.parse(readFileSync(join(control, 'fixture.json'), 'utf8'));
let finishPreparedReply;
let decideClose;
globalThis.fetch = async (url) => {
    const value = fixture();
    const address = String(url);
    if (value.mode === 'offline') {
        throw new TypeError('QA offline');
    }
    if (address.startsWith('https://api.github.com/repos/edwardgushchin/AI-Taskboard/releases?')) {
        return Response.json([{ tag_name: 'v${newVersion}', draft: false, prerelease: true }]);
    }
    const base = 'https://github.com/edwardgushchin/AI-Taskboard/releases/download/v${newVersion}/';
    assert.ok(address.startsWith(base), 'Unexpected update source: ' + address);
    if (address.endsWith('/SHA256SUMS')) {
        return new Response(value.digest + '  ai-taskboard-${newVersion}-windows-${process.arch}.exe\\n');
    }
    assert.equal(address, base + 'ai-taskboard-${newVersion}-windows-${process.arch}.exe');
    if (value.mode === 'download-offline') {
        throw new TypeError('QA download offline');
    }
    let bytes = readFileSync(value.installer);
    if (value.mode === 'corrupt') {
        bytes = Buffer.concat([bytes, Buffer.from('corrupt')]);
    }
    return new Response(bytes);
};
dialog.showMessageBox = async (...args) => {
    const options = args.at(-1);
    write('dialog.json', { version: app.getVersion(), message: options.message, buttons: options.buttons });
    if (options.type === 'warning' && fixture().holdClose) {
        write('close-warning.json', { message: options.message, buttons: options.buttons });
        return new Promise(resolve => {
            decideClose = response => {
                decideClose = undefined;
                resolve({ response, checkboxChecked: false });
            };
        });
    }
    return { response: fixture().mode === 'cancel' ? 0 : 1, checkboxChecked: false };
};
dialog.showErrorBox = (title, content) => write('fatal.json', { title, content });
globalThis.qaManager = async (_profile, project, prompt, _images, action, _tools, _instructions, _signal, session) => {
    const provider = trackProvider(project, process.pid);
    const active = trackActiveRun(project, 'manager');
    try {
        const entries = runtimeEntries(project);
        const writer = entries.find(entry => entry.task === 'manager:dialogue' && entry.owner === process.pid);
        assert.ok(writer, 'The ordinary manager must use the real manager:dialogue writer');
        const owned = entries.filter(entry => entry.parent === writer.id && entry.owner === process.pid);
        assert.ok(owned.some(entry => entry.kind === 'provider'));
        assert.ok(owned.some(entry => entry.kind === 'turn'));
        const thread = '11111111-1111-4111-8111-111111111111';
        session.save(thread);
        if (session.messageId) {
            session.onMessage(session.messageId);
        }
        const tool = prompt.startsWith('Установи') ? 'app_install_update' : 'app_check_updates';
        assert.ok(session.mcpTools.some(value => value.name === tool));
        const result = await action(tool, tool === 'app_check_updates' ? {} : { version: '${newVersion}' });
        let duplicate;
        if (result.ok && tool === 'app_install_update') {
            duplicate = await action(tool, { version: '${newVersion}' });
        }
        write('tool.json', { tool, result, duplicate, version: app.getVersion() });
        if (result.ok && tool === 'app_install_update' && fixture().holdReply) {
            write('prepared-reply.json', { result, version: app.getVersion() });
            await new Promise(resolve => {
                finishPreparedReply = resolve;
            });
            finishPreparedReply = undefined;
        }
        let text;
        if (!result.ok) {
            text = result.error.code + ': ' + result.error.message;
        } else if (tool === 'app_check_updates') {
            text = 'Текущая версия ' + result.data.currentVersion + '. Найдена версия ' + result.data.latest?.version + '. Установка: ' + result.data.installation + '.';
        } else {
            text = 'Пакет ' + result.data.version + ' проверен. Перезапуск после ответа.';
        }
        return { text, model: 'Deterministic update QA provider' };
    }
    finally {
        active();
        provider();
    }
};
// Let Electron finish the entry module before waiting for app readiness.
void (async () => {
    await import('./src/desktop/main.ts');
    let last = 0;
    let operation;
    let goal;
    let goalProvider;
    let goalTurn;
    try {
        last = JSON.parse(readFileSync(join(control, 'reply.json'), 'utf8')).id ?? 0;
    }
    catch {
    }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await app.whenReady();
    while (!BrowserWindow.getAllWindows()[0]) {
        await wait(50);
    }
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1280, 800);
    window.webContents.setBackgroundThrottling(false);
    const evaluate = code => window.webContents.executeJavaScript(code);
    while (!await evaluate('window.taskboard?.bootstrap().then(frame => Boolean(frame.board) && !frame.loading)').catch(() => false)) {
        await wait(50);
    }
    await evaluate('window.taskboard.setLanguage("ru")');
    write('ready.json', { version: app.getVersion(), pid: process.pid, electron: process.versions.electron, chromium: process.versions.chrome,
        profile: app.getPath('userData'), executable: process.execPath, frame: await evaluate('window.taskboard.bootstrap()') });
    setInterval(() => {
        let command;
        try {
            command = JSON.parse(readFileSync(join(control, 'command.json'), 'utf8'));
        }
        catch {
            return;
        }
        if (command.id <= last) {
            return;
        }
        last = command.id;
        void (async () => {
            let result;
            if (command.action === 'ask') {
                result = await evaluate('window.taskboard.boardRequest(' + JSON.stringify(command.text) + ')');
            }
            else if (command.action === 'begin-held-install') {
                void evaluate('window.taskboard.boardRequest(' + JSON.stringify(command.text) + ')')
                    .then(reply => write('held-reply-result.json', { reply }))
                    .catch(error => write('held-reply-result.json', { error: error.stack }));
                result = true;
            }
            else if (command.action === 'release-prepared-reply') {
                assert.ok(finishPreparedReply, 'The prepared manager reply must still be held');
                finishPreparedReply();
                result = true;
            }
            else if (command.action === 'close-window') {
                window.close();
                result = true;
            }
            else if (command.action === 'cancel-close') {
                assert.ok(decideClose, 'The close warning must still be held');
                decideClose(0);
                result = true;
            }
            else if (command.action === 'hold') {
                operation = globalThis.qaBeginOperation(${JSON.stringify(boards[1])});
                result = true;
            }
            else if (command.action === 'release') {
                operation?.finish();
                operation = undefined;
                result = true;
            }
            else if (command.action === 'hold-goal') {
                goal = registerRuntime(${JSON.stringify(boards[0])}, {
                    kind: 'task', task: 'manager:context', role: 'manager',
                    state: { id: 'qa-concurrent-goal', lane: 'work', goalRunning: true },
                });
                assert.ok(goal, 'The concurrent goal lease must be acquired');
                goalProvider = goal.run(() => trackProvider(${JSON.stringify(boards[0])}, process.pid));
                goalTurn = goal.run(() => trackActiveRun(${JSON.stringify(boards[0])}, 'manager'));
                result = runtimeEntries(${JSON.stringify(boards[0])}).filter(entry => entry.task === 'manager:context' || entry.parent)
                    .map(entry => ({ id: entry.id, task: entry.task, kind: entry.kind, parent: entry.parent }));
            }
            else if (command.action === 'goal-state') {
                result = runtimeEntries(${JSON.stringify(boards[0])}).filter(entry => entry.task === 'manager:context' || entry.parent)
                    .map(entry => ({ id: entry.id, task: entry.task, kind: entry.kind, parent: entry.parent }));
            }
            else if (command.action === 'release-goal') {
                goalTurn();
                goalProvider();
                goal();
                goal = undefined;
                goalProvider = undefined;
                goalTurn = undefined;
                result = true;
            }
            else if (command.action === 'capture') {
                window.show();
                await evaluate('document.querySelector("#board-draft textarea[name=request]").focus()');
                const open = await evaluate('document.querySelector("#board-draft").hasAttribute("data-open")');
                if (!open) {
                    await evaluate('document.querySelector("#board-draft textarea[name=request]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
                }
                let visible = false;
                for (let attempt = 0; attempt < 100 && !visible; attempt++) {
                    visible = await evaluate('document.querySelector("#board-draft").hasAttribute("data-open") && document.querySelector("#board-chat").textContent.includes(' + JSON.stringify('Текущая версия ' + app.getVersion()) + ')');
                    if (!visible) {
                        await wait(50);
                    }
                }
                assert.equal(visible, true, 'Manager version result must be visible before capture');
                await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
                const expected = 'Текущая версия ' + app.getVersion();
                await evaluate(\`(() => {
                    const entries = [...document.querySelectorAll("#board-chat .board-manager-message")];
                    const entry = entries.findLast(node => node.textContent.includes(\${JSON.stringify(expected)}));
                    entry.scrollIntoView({ block: "center", behavior: "instant" });
                })()\`);
                await wait(100);
                const state = await evaluate(\`(() => {
                    const entries = [...document.querySelectorAll("#board-chat .board-manager-message")];
                    const entry = entries.findLast(node => node.textContent.includes(\${JSON.stringify(expected)}));
                    const box = entry.getBoundingClientRect();
                    const log = entry.closest(".board-chat-log").getBoundingClientRect();
                    return {
                        text: entry.textContent,
                        visible: box.top >= log.top && box.bottom <= log.bottom,
                        top: box.top,
                        bottom: box.bottom,
                    };
                })()\`);
                assert.equal(state.visible, true, 'Current version message must fit inside the visible dialogue viewport');
                const png = await window.webContents.capturePage();
                assert.deepEqual(png.getSize(), { width: 1280, height: 800 });
                writeFileSync(join(artifacts, command.name), png.toPNG());
                result = { version: app.getVersion(), ...state };
            }
            else if (command.action === 'frame') {
                result = await evaluate('window.taskboard.bootstrap()');
            }
            else if (command.action === 'select') {
                await evaluate('window.taskboard.selectTab(' + JSON.stringify(command.project) + ')');
                let frame;
                do {
                    frame = await evaluate('window.taskboard.bootstrap()');
                    await wait(50);
                } while (frame.project !== command.project || frame.loading);
                assert.ok(frame.board && !frame.error);
                result = { project: frame.project, board: frame.board.project };
            }
            else if (command.action === 'quit') {
                write('reply.json', { id: command.id, result: true });
                app.quit();
                return;
            }
            else {
                throw Error('Unknown command');
            }
            write('reply.json', { id: command.id, result });
        })().catch(error => write('reply.json', { id: command.id, error: error.stack }));
    }, 100);
})().catch(error => {
    write('fatal.json', { error: error.stack });
    app.exit(1);
});
`;
    writeFileSync(join(project, "qa-main.mjs"), bootstrap);
    const dependencies = Object.fromEntries(qaModules.map(name => [name, JSON.parse(readFileSync(join(modulesRoot, name, "package.json"))).version]));
    for (const version of [oldVersion, newVersion]) {
        const output = join(scratch, "package-" + version);
        writeJson(join(project, "package.json"), { name: "ai-taskboard-update-qa", version, private: true, type: "module", main: "qa-main.mjs",
            description: "Isolated Windows NSIS update QA", author: "QA", dependencies });
        const buildOptions = { projectDir: project, publish: "never",
            config: { appId: "org.aitaskboard.updateqa." + productExecutable.slice(-8), productName: "AI Taskboard",
                executableName: productExecutable, directories: { output }, electronVersion: require("electron/package.json").version,
                electronDist: dirname(require("electron")), files: ["src/**/*", "qa-main.mjs"], npmRebuild: false,
                win: { signExecutable: false }, nsis: { oneClick: false, perMachine: false, allowElevation: false,
                    createDesktopShortcut: false, createStartMenuShortcut: false, allowToChangeInstallationDirectory: true,
                    include: join(project, "installer.nsh") },
                artifactName: `ai-taskboard-${version}-windows-${process.arch}.exe` } };
        const buildScript = join(scratch, "build-qa.mjs");
        writeFileSync(buildScript, `import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(import.meta.url)});
const { build, Platform, Arch } = require('electron-builder');
const options = ${JSON.stringify(buildOptions)};
try {
    await build({ ...options, targets: Platform.WINDOWS.createTarget('nsis', Arch[process.arch]) });
    process.exit(0);
}
catch (error) {
    console.error(error);
    process.exit(1);
}
`);
        execFileSync(process.execPath, [buildScript], { cwd: root, windowsHide: true, stdio: "inherit", timeout: 300000 });
        const installer = join(output, `ai-taskboard-${version}-windows-${process.arch}.exe`);
        record.packages.push({ version, sha256: sha(readFileSync(installer)), bytes: readFileSync(installer).length });
    }
    const firstInstaller = join(scratch, "package-" + oldVersion, `ai-taskboard-${oldVersion}-windows-${process.arch}.exe`);
    const nextInstaller = join(scratch, "package-" + newVersion, `ai-taskboard-${newVersion}-windows-${process.arch}.exe`);
    writeJson(join(control, "fixture.json"), { mode: "normal", installer: nextInstaller, digest: record.packages[1].sha256 });
    execFileSync(firstInstaller, ["/S", "/currentuser", "/D=" + installDirectory], { windowsHide: true, timeout: 90000 });
    installed = true;
    const uninstaller = join(installDirectory, "Uninstall " + productExecutable + ".exe");
    assert.ok(existsSync(uninstaller));
    const executable = join(installDirectory, productExecutable + ".exe");
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, ["--user-data-dir=" + profile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: environment });
    child.stdout.on("data", data => {
        childLogs += data;
    });
    child.stderr.on("data", data => {
        childLogs += data;
    });
    const before = await until(() => {
        const fatal = readJson(join(control, "fatal.json"));
        if (fatal) {
            throw new Error("Installed startup: " + JSON.stringify(fatal));
        }
        if (child.exitCode !== null) {
            throw new Error("Installed client exited " + child.exitCode + ": " + childLogs);
        }
        return readJson(join(control, "ready.json"));
    }, "installed old version ready");
    assert.equal(before.version, oldVersion);
    record.electron = before.electron;
    record.chromium = before.chromium;
    note("Installed NSIS " + oldVersion + " started with an isolated profile and two boards; paths contain spaces.");
    const mode = value => writeJson(join(control, "fixture.json"), { mode: value, installer: nextInstaller, digest: record.packages[1].sha256 });
    const ask = async (text) => {
        const result = await command({ action: "ask", text });
        assert.equal(result.ok, true, JSON.stringify(result));
        return readJson(join(control, "tool.json"));
    };
    const checked = await ask("Проверь обновления AI Taskboard");
    assert.equal(checked.result.data.currentVersion, oldVersion);
    assert.equal(checked.result.data.latest.version, newVersion);
    assert.equal(checked.result.data.installation, "windows-nsis");
    for (const [value, expected] of [["offline", "UPDATE_CHECK_FAILED"], ["normal", null]]) {
        mode(value);
        const tool = await ask("Проверь обновления AI Taskboard");
        assert.equal(tool.result.ok ? null : tool.result.error.code, expected);
    }
    note("Manager release check: current/found versions, network failure and successful retry.");
    await command({ action: "hold" });
    let tool = await ask("Установи AI Taskboard " + newVersion);
    assert.equal(tool.result.error.code, "UPDATE_APP_BUSY");
    await command({ action: "release" });
    note("Busy operation rejected installation and remained available to finish normally.");
    record.concurrentGoalBefore = await command({ action: "hold-goal" });
    tool = await ask("Установи AI Taskboard " + newVersion);
    assert.equal(tool.result.error.code, "UPDATE_APP_BUSY");
    record.concurrentGoalAfter = await command({ action: "goal-state" });
    assert.deepEqual(record.concurrentGoalAfter, record.concurrentGoalBefore);
    await command({ action: "release-goal" });
    note("Concurrent manager:context goal and its provider/turn leases blocked installation without being interrupted; the ordinary manager used manager:dialogue.");
    for (const [value, expected] of [["cancel", "UPDATE_CANCELLED"], ["corrupt", "UPDATE_INSTALL_FAILED"], ["download-offline", "UPDATE_INSTALL_FAILED"]]) {
        mode(value);
        tool = await ask("Установи AI Taskboard " + newVersion);
        assert.equal(tool.result.error.code, expected);
        assert.equal(readJson(join(control, "ready.json")).version, oldVersion);
        assert.equal(child.exitCode, null);
        note(value + ": installer did not run; original client remains alive.");
    }
    mode("normal");
    await ask("Проверь обновления AI Taskboard");
    writeJson(join(control, "fixture.json"), {
        mode: "normal", installer: nextInstaller, digest: record.packages[1].sha256,
        holdReply: true, holdClose: true,
    });
    await command({ action: "begin-held-install", text: "Установи AI Taskboard " + newVersion });
    const preparedReply = await until(() => readJson(join(control, "prepared-reply.json")), "prepared reply held");
    assert.equal(preparedReply.result.ok, true);
    assert.equal(preparedReply.result.data.version, newVersion);
    const preparedCaches = updateCachesFor(executable);
    assert.equal(preparedCaches.length, 1, "Exactly one verified update cache must exist before closing");
    await command({ action: "close-window" });
    const closeWarning = await until(() => readJson(join(control, "close-warning.json")), "close warning held");
    assert.equal(closeWarning.buttons.length, 2);
    await command({ action: "release-prepared-reply" });
    const heldResult = await until(() => readJson(join(control, "held-reply-result.json")), "prepared manager reply completed");
    assert.ok(!heldResult.error, JSON.stringify(heldResult));
    assert.equal(heldResult.reply.ok, true, JSON.stringify(heldResult));
    // The cache removal proves that before-quit vetoed the update while state.closing was still true.
    await until(() => preparedCaches.every(path => !existsSync(path)), "prepared cache removed while close warning remains open");
    await command({ action: "cancel-close" });
    assert.equal(child.exitCode, null, "Cancelled close must leave the old process running");
    assert.equal(readJson(join(control, "ready.json")).pid, before.pid);
    mode("normal");
    const afterCancelledClose = await ask("Проверь обновления AI Taskboard после отмены закрытия");
    assert.equal(afterCancelledClose.result.ok, true);
    assert.equal(afterCancelledClose.result.data.currentVersion, oldVersion);
    record.cancelledClose = {
        preparedVersion: preparedReply.result.data.version,
        warning: closeWarning.message,
        oldProcessId: before.pid,
        cacheCountBefore: preparedCaches.length,
        cacheRemoved: true,
        cacheRemovedWhileWarningOpen: true,
        newDialogueCurrentVersion: afterCancelledClose.result.data.currentVersion,
    };
    note("A close warning held the window while the prepared manager reply finished; before-quit removed its update cache before the warning was cancelled. The old process accepted a new dialogue and then retried installation successfully.");
    record.captureBefore = await command({ action: "capture", name: "update-before.png" });
    tool = await ask("Установи AI Taskboard " + newVersion);
    assert.equal(tool.result.ok, true, JSON.stringify(tool));
    assert.equal(tool.duplicate.error.code, "UPDATE_IN_PROGRESS");
    const installingSince = Date.now() - 1000;
    const after = await until(() => {
        const errorFile = join(tmpdir(), "ai-taskboard-update-error.txt");
        if (existsSync(errorFile) && statSync(errorFile).mtimeMs >= installingSince) {
            record.helperError = readFileSync(errorFile, "utf8");
            rmSync(errorFile);
            throw new Error("Update helper: " + record.helperError);
        }
        const value = readJson(join(control, "ready.json"));
        return value?.version === newVersion && value;
    }, "updated client restart", 150000);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.profile, profile);
    assert.equal(sha(readFileSync(join(profile, "profile-marker.txt"))), markerHash);
    const tabs = JSON.parse(readFileSync(join(profile, "project-tabs.json"), "utf8"));
    assert.deepEqual(tabs[0].projects, boards);
    await ask("Проверь обновления AI Taskboard после перезапуска");
    const frame = await command({ action: "frame" });
    assert.equal(frame.project, boards[0]);
    for (const board of [boards[1], boards[0]]) {
        const selected = await command({ action: "select", project: board });
        assert.equal(selected.project, board);
        assert.equal(selected.board, board);
    }
    record.captureAfter = await command({ action: "capture", name: "update-after.png" });
    note("Verified official fixture package SHA-256; repeated command returned UPDATE_IN_PROGRESS; one NSIS update restarted " + newVersion + ".");
    assert.equal(JSON.parse(readFileSync(join(profile, "appearance.json"), "utf8")).language, "ru");
    assert.equal(JSON.parse(readFileSync(join(profile, "appearance.json"), "utf8")).theme, "dark");
    note("Profile marker bytes and both saved open boards survived; new process opened the original active board. Russian/dark rendering was checked; the bootstrap selects Russian on each launch.");
    record.profileMarkerSha256 = markerHash;
    record.before = { version: before.version, pid: before.pid };
    record.after = { version: after.version, pid: after.pid };
    await command({ action: "quit" });
    await until(() => {
        try {
            process.kill(after.pid, 0);
            return false;
        }
        catch {
            return true;
        }
    }, "updated client exit");
    record.result = "passed";
}
catch (error) {
    record.result = "failed";
    record.error = error.stack;
    record.fatal = readJson(join(control, "fatal.json"));
    record.childLogs = childLogs;
    console.error(error);
    process.exitCode = 1;
}
finally {
    try {
        const ready = readJson(join(control, "ready.json"));
        if (ready?.pid) {
            try {
                process.kill(ready.pid);
            }
            catch {
            }
        }
        if (child && child.exitCode === null) {
            child.kill();
        }
        if (installed) {
            await delay(800);
            execFileSync(join(installDirectory, "Uninstall " + productExecutable + ".exe"), ["/S", "/currentuser"], { windowsHide: true, timeout: 90000 });
        }
    }
    catch (error) {
        record.cleanupError = String(error);
        process.exitCode = 1;
    }
    try {
        const executable = join(installDirectory, productExecutable + ".exe");
        const remainingCaches = updateCachesFor(executable);
        for (const directory of remainingCaches) {
            assert.equal(dirname(directory), resolve(tmpdir()));
            rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        }
        assert.deepEqual(updateCachesFor(executable), []);
        record.updateCachesCleanedOnExit = remainingCaches.length;
    }
    catch (error) {
        record.cleanupError = [record.cleanupError, String(error)].filter(Boolean).join("\n");
        process.exitCode = 1;
    }
    record.gitStatusAfter = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    writeJson(join(artifacts, "update-install-report.json"), record);
}
process.exit(record.result === "passed" && !record.cleanupError ? 0 : 1);
