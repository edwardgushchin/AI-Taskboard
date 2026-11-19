// Real per-user NSIS installation and restart; deterministic release/provider fixtures.
// Every package/profile/board lives in one disposable system temporary directory.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
assert.equal(process.platform, "win32", "This check installs Windows NSIS packages.");
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const outputOption = process.argv.indexOf("--artifacts");
const pollScenario = process.argv.includes("--poll");
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
        const path = join(artifacts, pollScenario ? "update-poll-report.json" : "update-install-report.json");
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
const newerVersion = "0.1.2-alpha";
const record = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, oldVersion, newVersion, checks: [], packages: [], sourceHashes: {} };
record.sourceHashesLF = {};
record.seams = ["QA-only bootstrap substitutes release HTTP responses and the model provider; real manager registration/callback, IPC, renderer, download/hash verification, helper, shutdown, NSIS and restart run unchanged.",
    "Unique appId/executableName isolate installed product; NSIS PATH hooks and desktop/start-menu shortcuts are disabled in QA only. Process safety hook is retained.",
    "QA packages omit Huggingface and bundled standalone CLI; board CLI calls use the packaged Electron Node runtime. No code signing or live official release download is verified.",
    "Confirmation responses are deterministic through dialog.showMessageBox; the before/after PNGs show the real manager conversation."];
if (pollScenario) {
    record.seams[3] = "The initial poll uses its production 5-second delay. QA advances the recurring interval from 60 minutes to 1 second; update UI actions, installation and restart run unchanged.";
    record.command = "node scripts/check-update-install.mjs --poll --artifacts " + process.argv[outputOption + 1];
}
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

function updateDialogState() {
    const get = id => document.getElementById(id);
    const box = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    };
    const button = get("app-settings");
    const badge = get("app-update-badge");
    const menu = get("settings-menu");
    const updateItem = get("settings-menu-update");
    const checkItem = get("settings-menu-updates");
    const dialog = get("update-dialog");
    const notes = get("update-notes");
    const progress = get("update-progress");
    const confirm = get("update-action");
    return {
        advertised: !badge.hidden,
        menuOpen: menu.matches(":popover-open"),
        menuExpanded: button.getAttribute("aria-expanded") === "true",
        updateItem: updateItem && !updateItem.hidden ? updateItem.textContent : null,
        checkItem: checkItem && !checkItem.hidden ? checkItem.textContent : null,
        focused: document.activeElement.id,
        accessibleName: button.getAttribute("aria-label"),
        open: dialog.open,
        modal: dialog.matches(":modal"),
        viewport: { width: innerWidth, height: innerHeight },
        dialog: box(dialog),
        title: get("update-title").textContent,
        notes: notes.textContent,
        listEntries: notes.querySelectorAll("li").length,
        unsafe: Boolean(notes.querySelector("script, img, iframe") || window.qaReleaseScriptExecuted),
        scroll: { top: notes.scrollTop, height: notes.clientHeight, content: notes.scrollHeight },
        status: get("update-status").textContent,
        progress: progress.hidden ? null : { value: progress.value, max: progress.max },
        action: confirm.hidden ? null : { text: confirm.textContent, box: box(confirm) },
        later: { text: get("update-later").textContent, box: box(get("update-later")) },
        release: get("update-release").href,
    };
}

function updateTriggerStyle() {
    const trigger = document.getElementById("app-settings");
    const badge = trigger.querySelector("#app-update-badge");
    const gear = trigger.querySelector(".icon");
    const style = getComputedStyle(trigger);
    const marker = getComputedStyle(badge);
    const glyph = getComputedStyle(badge, "::before");
    const bounds = trigger.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    const gearBounds = gear.getBoundingClientRect();
    const badgeX = badgeBounds.x + badgeBounds.width / 2;
    const badgeY = badgeBounds.y + badgeBounds.height / 2;
    const hit = document.elementFromPoint(badgeX, badgeY);
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
    };
    return {
        hitArea: [bounds.width, bounds.height],
        hitGearAtBadge: trigger.contains(hit) && !badge.contains(hit),
        decorative: badge.getAttribute("aria-hidden") === "true" && badge.tabIndex === -1 && marker.pointerEvents === "none",
        tabOrder: [trigger.tabIndex, ...Array.from(trigger.querySelectorAll("[tabindex]"), node => node.tabIndex)],
        badgeSize: [badgeBounds.width, badgeBounds.height],
        badgePlacement: [
            badgeX - gearBounds.x - gearBounds.width / 2,
            badgeY - gearBounds.y - gearBounds.height / 2,
        ],
        badgeInsets: [Number.parseFloat(marker.right), Number.parseFloat(marker.bottom)],
        background: rgba(marker.backgroundColor),
        foreground: rgba(glyph.color),
        glyphContent: glyph.content.slice(1, -1),
        glyphFont: glyph.fontFamily,
        glyphSize: glyph.fontSize,
        gearSize: getComputedStyle(gear, "::before").fontSize,
        focused: trigger === document.activeElement,
        focusVisible: trigger.matches(":focus-visible"),
        hovered: trigger.matches(":hover"),
        outline: [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset],
    };
}

function luminance([red, green, blue]) {
    const linear = channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722;
}

function measureProgressFrames(duration) {
    const meter = document.getElementById("update-progress");
    const fill = document.getElementById("update-progress-fill");
    const label = document.getElementById("update-progress-percent");
    const percentFormat = new Intl.NumberFormat(document.documentElement.lang, { style: "percent" });
    const started = performance.now();
    const frames = [];
    return new Promise(resolve => {
        function sample(time) {
            const elapsed = Math.max(0, time - started);
            if (!meter.hidden) {
                const style = getComputedStyle(fill);
                const transform = new DOMMatrixReadOnly(style.transform);
                frames.push({
                    elapsed, native: meter.position, scale: transform.a, translation: transform.e,
                    transition: style.transitionDuration, animation: style.animationName,
                    percent: label.hidden || label.getClientRects().length === 0 ? null : label.textContent,
                    expectedPercent: meter.position < 0 ? null : percentFormat.format(Math.floor(meter.value * 100 / meter.max) / 100),
                });
            }
            if (elapsed >= duration) {
                resolve({ reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, frames });
            } else {
                requestAnimationFrame(sample);
            }
        }
        requestAnimationFrame(sample);
    });
}

function summarizeProgress({ reduced, frames }) {
    const compare = property => {
        const steps = frames.slice(1).map((frame, index) => Math.abs(frame[property] - frames[index][property]));
        return { changes: steps.filter(step => step > 0.00001).length, largestStep: Math.max(0, ...steps) };
    };
    return {
        reduced,
        frames: frames.length,
        visibleDuration: frames.at(-1).elapsed - frames[0].elapsed,
        native: compare("native"),
        scale: compare("scale"),
        translation: compare("translation"),
        transitions: [...new Set(frames.map(frame => frame.transition))],
        animations: [...new Set(frames.map(frame => frame.animation))],
        percentages: [...new Set(frames.map(frame => frame.percent))],
    };
}

async function checkTriggerAppearance(run, capture, setTheme, press, click, state) {
    const appearance = () => run(`(${updateTriggerStyle.toString()})()`);
    record.triggerAppearance = {};
    for (const theme of ["light", "dark"]) {
        await command({ action: "move-pointer-away" });
        await run("document.activeElement.blur()");
        await setTheme(theme);
        const { rail: restRail } = await command({ action: "capture-poll", measureRail: true });
        const rest = await appearance();
        assert.deepEqual(rest.hitArea, [40, 40]);
        assert.ok(rest.hitGearAtBadge && rest.decorative);
        assert.deepEqual(rest.tabOrder, [0]);
        assert.deepEqual(rest.badgeSize, [13, 13]);
        assert.deepEqual(rest.badgeInsets, [6, 6]);
        assert.ok(rest.badgePlacement.every(offset => offset > 0));
        const accent = theme === "light" ? [61, 86, 168, 255] : [64, 89, 174, 255];
        assert.deepEqual(rest.background, accent);
        assert.match(rest.glyphFont, /codicon/i);
        assert.equal(rest.glyphContent, "\uea9a");
        assert.equal(rest.glyphSize, "10px");
        assert.equal(rest.gearSize, "20px");
        const contrast = [luminance(rest.background), luminance(rest.foreground)].sort((a, b) => b - a);
        const contrastRatio = (contrast[0] + 0.05) / (contrast[1] + 0.05);
        assert.ok(contrastRatio >= 3, JSON.stringify(rest));
        assert.ok(!rest.focused && !rest.hovered);
        await command({ action: "hover-trigger" });
        const hover = await appearance();
        assert.ok(hover.hovered && !hover.focusVisible);
        assert.deepEqual(hover.background, rest.background);
        const { rail: hoverRail } = await command({ action: "capture-poll", measureRail: true });
        await command({ action: "move-pointer-away" });
        await press("Shift+Tab", "app-settings");
        assert.equal((await appearance()).focused, false);
        await press("Tab");
        const focus = await appearance();
        assert.ok(focus.focused && focus.focusVisible && !focus.hovered, JSON.stringify(focus));
        assert.deepEqual(focus.outline.slice(0, 2), ["solid", "2px"]);
        const { rail: focusRail } = await command({ action: "capture-poll", measureRail: true });
        for (const rail of [restRail, hoverRail, focusRail]) {
            assert.ok(rail.continuousBorder, JSON.stringify(rail));
            assert.ok(rail.continuousBackground, JSON.stringify(rail));
        }
        assert.deepEqual(hoverRail, restRail);
        assert.deepEqual(focusRail, restRail);
        if (theme === "light") {
            await press("Enter", "app-settings");
        } else {
            await click("app-update-badge");
        }
        const menu = await state();
        assert.ok(menu.menuOpen && menu.menuExpanded && menu.advertised && !menu.open);
        assert.equal(menu.updateItem, "Обновить");
        assert.equal(menu.checkItem, null);
        await capture("trigger", theme);
        await press("Escape");
        assert.equal((await state()).focused, "app-settings");
        record.triggerAppearance[theme] = { rest, hover, focus, contrastRatio, rail: restRail, railStates: ["rest", "hover", "focus"] };
    }
    note("Both themes show the 13px update badge and ordinary settings menu together. The decorative Codicons down arrow uses the theme accent, and the 40px gear is the only tab stop in the control. Enter and a click over the badge open the same menu. The rail stays continuous at rest, on hover and on focus.");
}

async function checkPoll(mode, uninstaller, executable, child, before) {
    const run = (code, second = false) => command({ action: "execute", code, second });
    const state = (second = false) => run(`(${updateDialogState.toString()})()`, second);
    const network = () => command({ action: "network" });
    const click = (id, second = false) => command({ action: "click", elementId: id, second });
    const press = (key, id, second = false) => command({ action: "key", key, elementId: id, second });
    const waitState = (label, predicate, second = false) => until(async () => {
        const answer = await state(second);
        return predicate(answer) && answer;
    }, label, 15000);
    const openMenu = async (second = false, key) => {
        if (key) {
            await press(key, "app-settings", second);
        } else {
            await click("app-settings", second);
        }
        return waitState("settings menu opened", view => view.menuOpen && view.menuExpanded, second);
    };
    const openUpdate = async (second = false, keyboard = false) => {
        const menu = await openMenu(second, keyboard ? "ArrowUp" : undefined);
        assert.equal(menu.updateItem, "Обновить");
        if (keyboard) {
            assert.equal(menu.focused, "settings-menu-update");
            await press("Enter", undefined, second);
        } else {
            await click("settings-menu-update", second);
        }
        return waitState("update dialog opened from settings", view => view.open && !view.menuOpen, second);
    };
    const waitNetwork = (label, predicate) => until(async () => {
        const counters = await network();
        return predicate(counters) && counters;
    }, label, 15000);
    const beginSampling = duration => command({
        action: "sample-progress", code: measureProgressFrames.toString(), duration,
    });
    const readSamples = id => until(() => {
        const sample = readJson(join(control, "progress-frames.json"));
        if (sample?.id !== id) return false;
        assert.ok(!sample.error, JSON.stringify(sample));
        assert.ok(sample.windows.every(result => result.frames.length >= 15));
        return sample.windows;
    }, "progress animation samples in both windows", 15000);
    const setTheme = async theme => {
        await run(`window.taskboard.setTheme(${JSON.stringify(theme)})`);
        await until(() => run(`document.documentElement.dataset.palette === ${JSON.stringify(theme)}`), "selected palette");
        await run("paletteTransition?.finished");
    };
    const capture = async (stateName, theme) => {
        await setTheme(theme);
        if (stateName !== "trigger") {
            await run("document.getElementById('update-notes').scrollTop = 0");
        }
        return command({ action: "capture-poll", name: `update-${stateName}-${theme}.png` });
    };
    const center = view => {
        assert.ok(view.modal);
        assert.ok(Math.abs(view.dialog.x + view.dialog.width / 2 - view.viewport.width / 2) <= 2, JSON.stringify(view.dialog));
        assert.ok(Math.abs(view.dialog.y + view.dialog.height / 2 - view.viewport.height / 2) <= 2, JSON.stringify(view.dialog));
    };

    await waitNetwork("initial production poll", value => value.releases >= 1);
    assert.equal((await state()).advertised, false);
    const initial = await openMenu(false, "ArrowUp");
    assert.equal(initial.focused, "settings-menu-updates");
    assert.match(initial.checkItem, /проверить наличие обновлений/i);
    assert.equal(initial.updateItem, null);
    await press("Enter");
    await until(() => run("document.getElementById('updates-result')?.textContent.includes(" +
        JSON.stringify(oldVersion) + ") && document.getElementById('sheet-body').textContent.includes('У вас последняя версия')"),
        "manual check through settings shows the installed and current version");
    await click("close-sheet");
    await openMenu(false, "ArrowUp");
    const firstPoll = await network();
    mode("normal");
    const offered = await waitState("next poll advertises the new version in the open menu",
        view => view.advertised && view.updateItem === "Обновить");
    assert.equal(offered.open, false);
    assert.ok(offered.menuOpen);
    assert.equal(offered.focused, "settings-menu-update");
    assert.equal(offered.checkItem, null);
    assert.match(offered.accessibleName, new RegExp(newVersion));
    assert.ok((await network()).releases > firstPoll.releases);
    mode("offline");
    const offlineStart = await network();
    await waitNetwork("offline background poll", value => value.releases > offlineStart.releases && !value.activeReleases);
    const offline = await state();
    assert.ok(offline.advertised && offline.menuOpen && !offline.open);
    assert.equal(offline.updateItem, "Обновить");
    mode("current");
    const current = await waitState("current release clears the badge and restores manual check",
        view => !view.advertised && view.checkItem && !view.updateItem);
    assert.ok(current.menuOpen && !current.open);
    assert.equal(current.focused, "settings-menu-updates");
    await press("Escape");
    mode("normal");
    await waitState("available release for settings appearance", view => view.advertised);
    await checkTriggerAppearance(run, capture, setTheme, press, click, state);
    note("With the settings menu open, the first new release replaced manual check with Update and kept focus on the visible row. Offline kept the badge and action. The next current response restored the manual check and its focus.");

    await command({ action: "new-window" });
    assert.equal(await run("window.taskboard.bootstrap().then(frame => Boolean(frame.board))", true), false);
    mode("hold-release");
    const held = await waitNetwork("hold one background request", value => value.activeReleases === 1);
    await command({ action: "manual-checks" });
    // Two scheduled ticks elapse while the in-flight request and both manual checks are held.
    await delay(2100);
    const concurrent = await network();
    assert.equal(concurrent.releases, held.releases);
    assert.equal(concurrent.peakReleases, 1);
    mode("no-notes");
    await waitState("notes-free release reaches second window", view => view.advertised, true);

    // Temporarily remove the support marker from the unique isolated installation.
    const hiddenUninstaller = uninstaller + ".qa-hidden";
    renameSync(uninstaller, hiddenUninstaller);
    try {
        await until(() => run("window.taskboard.updateState().then(state => !state.supported && state.candidate?.notes === '')", true), "manual-only installation state and empty release notes");
        // Wait for the next poll to broadcast the updated support marker to both renderers.
        await delay(1100);
        const manual = await openUpdate(true, true);
        assert.ok(manual.open, JSON.stringify(manual));
        assert.equal(manual.action, null);
        assert.match(manual.notes, /списка изменений/i);
        assert.match(manual.release, new RegExp("/tag/v" + newVersion + "$"));
        center(manual);
        await click("update-later", true);
    } finally {
        renameSync(hiddenUninstaller, uninstaller);
    }
    assert.deepEqual(await until(() => readJson(join(control, "manual-checks.json")), "joined manual checks"), [true, true]);
    note("Two windows and two manual checks shared the held background request. Enter opened the centered dialog in a board-free window. The manual-only client displayed the missing-notes message and release link.");

    mode("normal");
    await openUpdate();
    const listed = await waitState("target release notes", view => view.listEntries === 34 && view.action?.text === "Обновить");
    assert.ok(listed.title.includes(newVersion));
    assert.match(listed.notes, /Фоновая проверка выпусков/);
    assert.doesNotMatch(listed.notes, /Older release only/);
    assert.equal(listed.unsafe, false);
    center(listed);
    assert.equal((await network()).installers, 0);
    assert.equal((await network()).manifests, 0);
    await capture("notes", "light");
    await capture("notes", "dark");
    await command({ action: "resize", width: 800, height: 600 });
    const small = await state();
    center(small);
    assert.deepEqual(small.viewport, { width: 800, height: 600 });
    assert.ok(small.scroll.content > small.scroll.height);
    await run("document.getElementById('update-notes').scrollTop = 10000");
    const scrolled = await state();
    assert.ok(scrolled.scroll.top > 0);
    for (const button of [scrolled.action.box, scrolled.later.box]) {
        assert.ok(button.height > 0 && button.y + button.height <= scrolled.viewport.height);
    }
    record.responsive = { ...scrolled.viewport, modal: scrolled.dialog, notesScroll: scrolled.scroll, buttons: [scrolled.action.box, scrolled.later.box] };
    await click("update-later");
    assert.equal((await state()).open, false);
    assert.equal((await network()).installers, 0);
    assert.equal((await network()).manifests, 0);
    await command({ action: "resize", width: 1280, height: 800 });
    note("The centered dialog rendered the selected version's 34 list items safely. At 800 × 600 only the changes scrolled and both buttons stayed within the viewport. Opening and closing made zero package or manifest requests.");

    await openUpdate(true);
    await waitState("installed update control in second window", view => view.action?.text === "Обновить", true);
    await openUpdate();
    mode("stream");
    const beforeDownload = await network();
    await command({ action: "parallel-downloads" });
    const progress = await waitState("visible partial download", view => view.progress?.value > 0 && view.progress.value < view.progress.max);
    assert.match(progress.status, /загрузк/i);
    const secondProgress = await waitState("shared partial download", view => view.progress?.value > 0, true);
    assert.deepEqual(secondProgress.progress, progress.progress);
    assert.equal((await network()).installers, beforeDownload.installers + 1);
    assert.equal((await network()).manifests, beforeDownload.manifests + 1);

    const offeredVersion = second => run("window.taskboard.updateState().then(state => state.available?.version ?? null)", second);
    const waitForOffer = (version, second = false) => until(async () => {
        return (await offeredVersion(second)) === version;
    }, "latest offer " + version, 15000);
    const assertOriginal = view => {
        assert.ok(view.open);
        assert.equal(view.title, listed.title);
        assert.equal(view.notes, listed.notes);
        assert.equal(view.release, listed.release);
    };

    mode("stream", "newer");
    for (const second of [false, true]) {
        const pinned = await waitState("newer offer during the original download",
            view => view.advertised && view.accessibleName.includes(newerVersion), second);
        assertOriginal(pinned);
        assert.deepEqual(pinned.progress, progress.progress);
    }
    const duringNewerOffer = await network();
    assert.equal(duringNewerOffer.installers, beforeDownload.installers + 1);
    assert.equal(duringNewerOffer.manifests, beforeDownload.manifests + 1);
    mode("stream", "current");
    for (const second of [false, true]) {
        const withdrawn = await waitState("withdrawal hides badge during the original download",
            view => !view.advertised && view.progress?.value > 0, second);
        assertOriginal(withdrawn);
        assert.deepEqual(withdrawn.progress, progress.progress);
    }
    await click("update-later", true);
    const duringWithdrawal = await openMenu(true, "ArrowUp");
    assert.equal(duringWithdrawal.updateItem, "Обновить");
    assert.match(duringWithdrawal.checkItem, /проверить наличие обновлений/i);
    assert.equal(duringWithdrawal.focused, "settings-menu-updates");
    await click("settings-menu-update", true);
    const resumed = await waitState("settings menu resumes the original download",
        view => view.open && view.progress?.value > 0, true);
    assertOriginal(resumed);
    assert.deepEqual(resumed.progress, progress.progress);
    assert.equal((await network()).installers, duringNewerOffer.installers);
    note("A withdrawn offer hid the badge but restored manual check beside the resume action. The second window reopened the in-flight package from settings without a new request.");
    mode("stream", "newer");
    await waitForOffer(newerVersion);
    await capture("progress", "light");
    await capture("progress", "dark");
    await command({ action: "motion", reduced: true, second: true });
    const pacedSample = await beginSampling(2500);
    mode("paced", "newer");
    const pacedWindows = await readSamples(pacedSample);
    const [smooth, reduced] = pacedWindows.map(summarizeProgress);
    assert.equal(smooth.reduced, false);
    assert.equal(reduced.reduced, true);
    assert.ok(smooth.native.changes >= 3, JSON.stringify(smooth));
    assert.ok(smooth.scale.changes > smooth.native.changes, JSON.stringify(smooth));
    assert.ok(smooth.scale.largestStep < smooth.native.largestStep, JSON.stringify(smooth));
    assert.ok(pacedWindows[0].frames.every(frame => frame.scale <= frame.native + 0.00001));
    assert.ok(pacedWindows[0].frames.some(frame => frame.native === 1 && Math.abs(frame.scale - 1) <= 0.00001));
    assert.ok(reduced.native.changes >= 3, JSON.stringify(reduced));
    assert.deepEqual(reduced.transitions, ["0s"]);
    assert.ok(pacedWindows[1].frames.every(frame => Math.abs(frame.scale - frame.native) <= 0.00001));
    assert.ok(pacedWindows.every(result => result.frames.every(frame => frame.percent === frame.expectedPercent)));
    record.determinateMotion = {
        chunkIntervalMs: 250,
        discreteReference: "Before: discrete native progress.position on the same stream. After: computed scaleX of the visual bar.",
        frameCounts: "Changes count frames whose value moved, not the window's overall FPS.",
        smooth,
        reduced,
    };
    note("The paced Windows download moved the visual scale over extra frames with smaller steps than the discrete byte ratio. The scale never exceeded received data. Reduced motion displayed the exact received ratio on every frame.");

    const ready = await waitState("verified package and explicit confirmation", view => view.action?.text === "Обновить и перезапустить");
    assertOriginal(ready);
    assert.equal(child.exitCode, null);
    assert.equal(readJson(join(control, "ready.json")).pid, before.pid);

    mode("normal", "current");
    for (const second of [false, true]) {
        await waitForOffer(null, second);
        const pinned = await waitState("verified confirmation survives a withdrawn release",
            view => !view.advertised && view.action?.text === "Обновить и перезапустить", second);
        assertOriginal(pinned);
        assert.equal(pinned.action?.text, "Обновить и перезапустить");
        assert.equal(pinned.later.text, "Позже");
        assert.match(pinned.status, /проверен/);
    }
    await capture("confirm", "light");
    await capture("confirm", "dark");

    mode("normal", "newer");
    await waitForOffer(newerVersion);
    await click("update-later");
    assert.equal((await state()).open, false);
    assert.equal(child.exitCode, null);
    const next = view => view.open && view.title.includes(newerVersion) && view.action?.text === "Обновить";
    const otherDialog = await waitState("Later switches the second dialog to the latest offer", next, true);
    assert.match(otherDialog.notes, /Следующее предложение/);
    assert.ok(otherDialog.release.endsWith("/tag/v" + newerVersion));
    await openUpdate();
    await waitState("reopening after Later shows the latest offer", next);
    await click("update-later");
    const afterLater = await network();
    assert.equal(afterLater.installers, duringNewerOffer.installers);
    assert.equal(afterLater.manifests, duringNewerOffer.manifests);
    assert.deepEqual(updateCachesFor(executable), []);
    note("Both windows kept the original release, notes and partial progress after a newer version became the offer. With the original release withdrawn after verification, both windows kept its confirmation. Later cleared the cached package and switched the remaining dialog and next opening to the latest offer without downloading it.");
    record.offerChanges = {
        downloading: { pinned: newVersion, offered: newerVersion, installers: duringNewerOffer.installers },
        verified: { pinned: newVersion, offered: null },
        afterLater: { offered: newerVersion, installers: afterLater.installers },
    };

    mode("corrupt-stream");
    await waitState("original package is offered for retry test", view => view.accessibleName.includes(newVersion));
    await openUpdate();
    await click("update-action");
    await waitState("unknown content-length download", view => view.progress !== null);
    await waitState("unknown content-length download in second window", view => view.progress !== null, true);
    const unknownSample = await beginSampling(950);
    const unknownWindows = await readSamples(unknownSample);
    const [moving, still] = unknownWindows.map(summarizeProgress);
    assert.ok(unknownWindows.every(result => result.frames.every(frame => frame.native === -1)));
    assert.deepEqual(moving.percentages, [null]);
    assert.deepEqual(still.percentages, [null]);
    assert.deepEqual(moving.animations, ["update-progress-activity"]);
    assert.ok(moving.translation.changes > 5, JSON.stringify(moving));
    assert.deepEqual(still.animations, ["none"]);
    assert.equal(still.translation.changes, 0);
    record.indeterminateMotion = { moving, still };
    note("With no Content-Length, both accessibility progress elements stayed indeterminate. The normal visual indicator moved, and reduced motion kept it stationary.");
    mode("corrupt");
    await waitState("hash mismatch and retry", view => /SHA-256/.test(view.status) && view.action?.text === "Повторить загрузку");
    await command({ action: "motion", reduced: false, second: true });
    await command({ action: "close-secondary" });
    assert.equal(child.exitCode, null);
    assert.deepEqual(updateCachesFor(executable), []);
    mode("normal");
    await click("update-action");
    await waitState("retry verified", view => view.action?.text === "Обновить и перезапустить");
    assert.equal((await network()).installers, beforeDownload.installers + 3);
    assert.equal(child.exitCode, null);
    mode("normal", "current");
    await waitForOffer(null);
    assertOriginal(await state());
    assert.equal((await state()).action?.text, "Обновить и перезапустить");
    note("Repeated clicks in two open dialogs made one package request and showed the same partial byte count. Later kept the old process alive. A checksum failure left no update cache; retry verified the clean package.");
    record.progress = progress.progress;
    record.network = await network();
}
try {
    mkdirSync(project);
    mkdirSync(profile);
    mkdirSync(control);
    cpSync(join(root, "src"), join(project, "src"), { recursive: true });
    for (const name of [
        "main.ts", "installation-updates.ts", "update-runner.ps1", "updates.ts", "localization.cjs",
        "index.html", "styles.css", "themes.css", "preload.cjs", "renderer.js", "locales/en.json", "locales/ru.json",
        "vendor/codicons/codicon.css",
    ]) {
        const content = readFileSync(join(project, "src/desktop", name));
        record.sourceHashes["src/desktop/" + name] = sha(content);
        record.sourceHashesLF["src/desktop/" + name] = sha(content.toString("utf8").replaceAll("\r\n", "\n"));
    }
    record.sourceHashes["src/desktop/vendor/codicons/codicon.ttf"] =
        sha(readFileSync(join(project, "src/desktop/vendor/codicons/codicon.ttf")));
    record.sourceHashes["build/installer.nsh"] = sha(readFileSync(join(root, "build/installer.nsh")));
    record.sourceHashesLF["build/installer.nsh"] = sha(readFileSync(join(root, "build/installer.nsh"), "utf8").replaceAll("\r\n", "\n"));
    const checkSource = readFileSync(fileURLToPath(import.meta.url));
    record.sourceHashes["scripts/check-update-install.mjs"] = sha(checkSource);
    record.sourceHashesLF["scripts/check-update-install.mjs"] = sha(checkSource.toString("utf8").replaceAll("\r\n", "\n"));
    record.hashRepresentation = "SHA-256 of raw checked-out source bytes, before QA-only bootstrap instrumentation";
    let source = readFileSync(join(project, "src/desktop/main.ts"), "utf8")
        .replace("readTaskRunHistory, replyToBoard, replyToTask", "readTaskRunHistory, replyToTask");
    assert.ok(!source.includes("readTaskRunHistory, replyToBoard, replyToTask"));
    if (pollScenario) {
        const interval = "setInterval(pollUpdates, 60 * 60_000)";
        assert.ok(source.includes(interval), "Expected production hourly update timer");
        source = source.replace(interval, "setInterval(pollUpdates, 1_000)");
    }
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
app.commandLine.appendSwitch('force-device-scale-factor', '1');
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
const network = { releases: 0, manifests: 0, installers: 0, activeReleases: 0, peakReleases: 0 };
const notes = ${JSON.stringify("## Новое в " + newVersion + "\n\n- Фоновая проверка выпусков\n- Прогресс загрузки пакета\n\n" +
    Array.from({ length: 32 }, (_, index) => "- Дополнение к выпуску " + (index + 1)).join("\n") +
    "\n\n<script>window.qaReleaseScriptExecuted = true</script>\n\n![Внешнее изображение](https://invalid.example/pixel.png)")};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
globalThis.fetch = async (url) => {
    const value = fixture();
    const address = String(url);
    if (address.startsWith('https://api.github.com/repos/edwardgushchin/AI-Taskboard/releases?')) {
        network.releases++;
        network.activeReleases++;
        network.peakReleases = Math.max(network.activeReleases, network.peakReleases);
        try {
            while (fixture().mode === 'hold-release') await pause(50);
            if (value.mode === 'offline') throw new TypeError('QA offline');
            const releaseMode = value.release ?? value.mode;
            const releases = [
                { tag_name: 'v${oldVersion}', draft: false, prerelease: true, body: 'Older release only' },
            ];
            if (releaseMode !== 'current') {
                const latest = releaseMode === 'newer' ? '${newerVersion}' : '${newVersion}';
                const body = releaseMode === 'newer' ? '- Следующее предложение' : releaseMode === 'no-notes' ? '' : notes;
                releases.push({ tag_name: 'v' + latest, draft: false, prerelease: true, body });
            }
            return Response.json(releases);
        } finally {
            network.activeReleases--;
        }
    }
    const base = 'https://github.com/edwardgushchin/AI-Taskboard/releases/download/v${newVersion}/';
    assert.ok(address.startsWith(base), 'Unexpected update source: ' + address);
    if (address.endsWith('/SHA256SUMS')) {
        network.manifests++;
        return new Response(value.digest + '  ai-taskboard-${newVersion}-windows-${process.arch}.exe\\n');
    }
    assert.equal(address, base + 'ai-taskboard-${newVersion}-windows-${process.arch}.exe');
    network.installers++;
    if (value.mode === 'download-offline') {
        throw new TypeError('QA download offline');
    }
    let bytes = readFileSync(value.installer);
    if (value.mode === 'corrupt' || value.mode === 'corrupt-stream') {
        bytes = Buffer.concat([bytes, Buffer.from('corrupt')]);
    }
    if (value.mode === 'stream' || value.mode === 'corrupt-stream') {
        let offset = 0;
        const headers = value.mode === 'stream' ? { 'content-length': String(bytes.length) } : {};
        return new Response(new ReadableStream({
            async pull(controller) {
                let size = Math.ceil(bytes.length / 4);
                if (offset > 0) {
                    while (fixture().mode === value.mode) await pause(50);
                    if (fixture().mode === 'paced') {
                        await pause(250);
                        size = Math.ceil(bytes.length / 8);
                    }
                }
                controller.enqueue(bytes.subarray(offset, offset + size));
                offset += size;
                if (offset >= bytes.length) {
                    if (fixture().mode === 'paced') await pause(300);
                    controller.close();
                }
            },
        }), { headers });
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
    let secondary;
    window.setContentSize(1280, 800);
    window.webContents.setBackgroundThrottling(false);
    const evaluate = code => window.webContents.executeJavaScript(code);
    async function measureSettingsRail(screenshot) {
        const bounds = await evaluate('document.getElementById("app-settings").getBoundingClientRect().toJSON()');
        const pixels = screenshot.toBitmap();
        const pitch = screenshot.getSize().width * 4;
        const colorAt = (x, y) => {
            const index = y * pitch + x * 4;
            return pixels.subarray(index, index + 3);
        };
        const borderX = Math.floor(bounds.right) - 1;
        const fromY = Math.floor(bounds.top) - 8;
        const toY = Math.floor(bounds.bottom) - 1;
        const border = colorAt(borderX, fromY);
        const background = colorAt(borderX - 8, fromY);
        let continuousBorder = !border.equals(background);
        for (let y = fromY; y <= toY && continuousBorder; y++) {
            continuousBorder = border.equals(colorAt(borderX, y));
        }
        const sameBackground = [8, borderX - 8].every(x => background.equals(colorAt(x, Math.floor(bounds.top) + 8)));
        return {
            rail: {
                continuousBorder,
                continuousBackground: sameBackground,
                pixels: { border: [...border].reverse(), background: [...background].reverse() },
                borderX, fromY, toY,
            },
        };
    }
    async function input(target, action) {
        const session = target.webContents.debugger;
        session.attach('1.3');
        try {
            await action((method, args) => session.sendCommand('Input.' + method, args));
        } finally {
            session.detach();
        }
    }
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
            const target = command.second ? secondary : window;
            const execute = code => target.webContents.executeJavaScript(code);
            if (command.action === 'ask') {
                result = await evaluate('window.taskboard.boardRequest(' + JSON.stringify(command.text) + ')');
            }
            else if (command.action === 'execute') {
                result = await execute(command.code);
            }
            else if (command.action === 'network') {
                result = network;
            }
            else if (command.action === 'new-window') {
                const loaded = new Promise(resolve => app.once('browser-window-created', (_event, created) => {
                    created.webContents.once('did-finish-load', () => resolve(created));
                }));
                await evaluate('window.taskboard.menuAction("new-window")');
                secondary = await loaded;
                secondary.setContentSize(800, 600);
                secondary.webContents.setBackgroundThrottling(false);
                result = true;
            }
            else if (command.action === 'close-secondary') {
                secondary.destroy();
                secondary = undefined;
                result = true;
            }
            else if (command.action === 'motion') {
                const session = target.webContents.debugger;
                if (command.reduced) session.attach('1.3');
                const features = command.reduced ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [];
                await session.sendCommand('Emulation.setEmulatedMedia', { features });
                if (!command.reduced) session.detach();
                result = true;
            }
            else if (command.action === 'sample-progress') {
                const code = '(' + command.code + ')(' + command.duration + ')';
                void Promise.all([evaluate(code), secondary.webContents.executeJavaScript(code)]).then(
                    windows => write('progress-frames.json', { id: command.id, windows }),
                    error => write('progress-frames.json', { id: command.id, error: error.stack }),
                );
                result = command.id;
            }
            else if (command.action === 'manual-checks') {
                const check = client => client.webContents.executeJavaScript('window.taskboard.checkUpdates()');
                void Promise.all([check(window), check(secondary)]).then(replies => write('manual-checks.json', replies.map(reply => reply.ok)));
                result = true;
            }
            else if (command.action === 'parallel-downloads') {
                const click = client => client.webContents.executeJavaScript(\`(() => {
                    const update = document.getElementById("update-action");
                    update.click();
                    update.click();
                })()\`);
                await Promise.all([click(window), click(secondary)]);
                result = true;
            }
            else if (command.action === 'move-pointer-away') {
                await input(target, send => send('dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 100 }));
                result = true;
            }
            else if (command.action === 'hover-trigger') {
                const trigger = await execute('document.getElementById("app-settings").getBoundingClientRect().toJSON()');
                const x = Math.round(trigger.x + trigger.width / 2);
                const y = Math.round(trigger.y + trigger.height / 2);
                await input(target, send => send('dispatchMouseEvent', { type: 'mouseMoved', x, y }));
                result = true;
            }
            else if (command.action === 'click' || command.action === 'key') {
                target.show();
                target.focus();
                const element = 'document.getElementById(' + JSON.stringify(command.elementId) + ')';
                if (command.action === 'key') {
                    target.webContents.focus();
                    if (command.elementId) {
                        assert.equal(await execute(element + '.focus(); document.activeElement.id'), command.elementId);
                    }
                    const shift = command.key === 'Shift+Tab';
                    const keyName = shift ? 'Tab' : command.key;
                    const virtualCode = { Enter: 13, Tab: 9, ArrowUp: 38, Escape: 27 }[keyName];
                    assert.ok(virtualCode, keyName);
                    const key = {
                        key: keyName, code: keyName, windowsVirtualKeyCode: virtualCode,
                        nativeVirtualKeyCode: virtualCode, modifiers: shift ? 8 : 0,
                    };
                    await input(target, async send => {
                        await send('dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
                        if (keyName === 'Enter') {
                            await send('dispatchKeyEvent', { ...key, type: 'char', text: '\\r' });
                        }
                        await send('dispatchKeyEvent', { ...key, type: 'keyUp' });
                    });
                } else {
                    const area = await execute(element + '.getBoundingClientRect().toJSON()');
                    assert.ok(area.width > 0 && area.height > 0, command.elementId + ' must be visible');
                    const x = Math.round(area.x + area.width / 2);
                    const y = Math.round(area.y + area.height / 2);
                    await input(target, async send => {
                        const pointer = { x, y, button: 'left', clickCount: 1 };
                        await send('dispatchMouseEvent', { ...pointer, type: 'mousePressed' });
                        await send('dispatchMouseEvent', { ...pointer, type: 'mouseReleased' });
                    });
                }
                await wait(75);
                result = true;
            }
            else if (command.action === 'resize') {
                window.setContentSize(command.width, command.height);
                await wait(100);
                result = true;
            }
            else if (command.action === 'capture-poll') {
                await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
                const png = await window.webContents.capturePage();
                assert.deepEqual(png.getSize(), { width: 1280, height: 800 });
                assert.ok(!png.isEmpty());
                if (command.name) writeFileSync(join(artifacts, command.name), png.toPNG());
                result = true;
                if (command.measureRail) result = await measureSettingsRail(png);
            }
            else if (command.action === 'approve-restart') {
                write('reply.json', { id: command.id, result: true });
                await evaluate('document.getElementById("update-action").click()');
                return;
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
                ...(pollScenario ? { compression: "store" } : {}),
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
    writeJson(join(control, "fixture.json"), { mode: pollScenario ? "current" : "normal", installer: nextInstaller, digest: record.packages[1].sha256 });
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
    const mode = (value, release) => writeJson(join(control, "fixture.json"), {
        mode: value, release, installer: nextInstaller, digest: record.packages[1].sha256,
    });
    const ask = async (text) => {
        const result = await command({ action: "ask", text });
        assert.equal(result.ok, true, JSON.stringify(result));
        return readJson(join(control, "tool.json"));
    };
    if (pollScenario) {
        await checkPoll(mode, uninstaller, executable, child, before);
        await command({ action: "approve-restart" });
    } else {
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
    }
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
    if (!pollScenario) await ask("Проверь обновления AI Taskboard после перезапуска");
    const frame = await command({ action: "frame" });
    assert.equal(frame.project, boards[0]);
    for (const board of [boards[1], boards[0]]) {
        const selected = await command({ action: "select", project: board });
        assert.equal(selected.project, board);
        assert.equal(selected.board, board);
    }
    if (!pollScenario) {
        record.captureAfter = await command({ action: "capture", name: "update-after.png" });
    }
    note("The verified package installed and one NSIS update restarted " + newVersion + ".");
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
    writeJson(join(artifacts, pollScenario ? "update-poll-report.json" : "update-install-report.json"), record);
}
process.exit(record.result === "passed" && !record.cleanupError ? 0 : 1);
