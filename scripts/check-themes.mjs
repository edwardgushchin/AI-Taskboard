import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { electronCheck } from "./electron-check.mjs";

const legacy = {
  "github-light": "light", "solarized-light": "light", "github-dark": "dark",
  dracula: "dark", nord: "dark", "one-dark": "dark", "tokyo-night": "dark",
  "catppuccin-mocha": "dark", "solarized-dark": "dark", "gruvbox-dark": "dark",
};
const phases = [[], ["--restart", "dark"], ["--restart", "light"], ["--restart", "system"],
  ...Object.entries(legacy).map(([saved, expected]) => ["--legacy", saved, "--expected", expected])];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { scratch, artifacts } = electronCheck(import.meta.url, "themes", 120_000, phases);
const { app, BrowserWindow, dialog, nativeImage, nativeTheme, screen } = await import("electron");
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const restart = argument("--restart");
const oldTheme = argument("--legacy");
const report = join(artifacts, "themes-check.txt");
const firstPhase = !restart && !oldTheme;
if (firstPhase) {
  writeFileSync(report, "Command: node scripts/check-themes.mjs --artifacts .tasks/qa/T-0230\n");
}
const log = text => {
  console.log(text);
  appendFileSync(report, text + "\n");
};
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const powershell = code => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
  { encoding: "utf8", windowsHide: true }).trim();
const themeKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
let originalWindowsTheme;
let window;
let checks = 0;
const profile = join(scratch, "userData");
mkdirSync(profile, { recursive: true });
for (const name of ["appData", "userData"]) {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  app.setPath(name, path);
}
const profilePath = join(profile, "appearance.json");
if (firstPhase || oldTheme) {
  writeFileSync(profilePath, JSON.stringify({ theme: oldTheme ?? "system", language: "ru", preserved: { text: "Профиль 日本語", n: 7 } }));
}
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.disableHardwareAcceleration();
dialog.showErrorBox = (title, content) => {
  throw new Error(title + ": " + content);
};
const until = async (predicate, message = "condition") => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "Timed out: " + message);
    await wait(15);
  }
};
const windowsTheme = value => {
  powershell(`
    $ErrorActionPreference = 'Stop'
    Set-ItemProperty -LiteralPath ${psQuote(themeKey)} -Name AppsUseLightTheme -Value ${value}
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ThemeBroadcast {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
}
'@
    $result = [UIntPtr]::Zero
    [void][ThemeBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 2000, [ref]$result)
  `);
};

void (async () => {
try {
  if (firstPhase) {
    log("Git base/HEAD: " + execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim());
    log(`Runtime: ${process.platform}/${process.arch}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; Node ${process.versions.node}.`);
    log("Tested source hashes: SHA-256 of UTF-8 text normalized to LF.");
    for (const path of ["src/desktop/main.ts", "src/desktop/preload.cjs", "src/desktop/index.html", "src/desktop/renderer.js",
      "src/desktop/styles.css", "src/desktop/themes.css", "src/desktop/locales/ru.json", "src/desktop/locales/en.json",
      "scripts/check-themes.mjs", "scripts/electron-check.mjs", "tests/theme-settings.test.ts"]) {
      log(createHash("sha256").update(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n")).digest("hex") + "  " + path);
    }
  }
  await import(new URL("../src/desktop/main.ts", import.meta.url));
  await app.whenReady();
  await until(async () => {
    window = BrowserWindow.getAllWindows()[0];
    return window && await window.webContents.executeJavaScript("Boolean(window.taskboard && document.documentElement.dataset.palette)").catch(() => false);
  }, "production renderer bootstrap");
  const evaluate = code => window.webContents.executeJavaScript(code);
  const verify = async (code, message) => {
    assert.equal(await evaluate(code), true, message);
    checks++;
    log("PASS: " + message);
  };
  window.setContentSize(1280, 800);
  window.center();
  window.show();
  window.focus();
  const initialWindow = window.id;
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  window.webContents.debugger.attach("1.3");
  const cdp = (name, args = {}) => window.webContents.debugger.sendCommand(name, args);
  await cdp("Accessibility.enable");
  const accessibility = await cdp("Accessibility.getFullAXTree");
  assert.ok(accessibility.nodes.length > 1);
  if (oldTheme) {
    const expected = argument("--expected");
    await verify(`frame.theme === ${JSON.stringify(expected)} && document.documentElement.dataset.palette === ${JSON.stringify(expected)}`,
      `legacy ${oldTheme} becomes ${expected} in the real application`);
    const saved = JSON.parse(readFileSync(profilePath, "utf8"));
    assert.deepEqual(saved, { theme: expected, language: "ru", preserved: { text: "Профиль 日本語", n: 7 } });
    checks++;
    log("PASS: migrated appearance.json preserves language and unrelated nested fields");
  } else if (restart) {
    await verify(`frame.theme === ${JSON.stringify(restart)}`, `actual process restart restores ${restart}`);
    const next = restart === "dark" ? "light" : "system";
    assert.equal((await evaluate(`api.setTheme(${JSON.stringify(next)})`)).ok, true);
    checks++;
    log("PASS: persisted next selection " + next);
  } else {
    log("Production main.ts, preload, IPC and file-backed preferences are used. No real board or provider calls.");
    log("Browser automation fallback: built-in CDP; agent-browser/Playwright unavailable. CDP Accessibility snapshots collected before/after interaction.");
    await evaluate(`
      settings();
      void 0;
    `);
    await until(() => evaluate("Boolean(byId('theme-select') && !byId('theme-select').disabled)"));
    const choose = async value => {
      await evaluate(`
        byId('theme-select').value = ${JSON.stringify(value)};
        byId('theme-select').dispatchEvent(new Event('change', { bubbles: true }));
        void 0;
      `);
      await until(() => evaluate(`frame.theme === ${JSON.stringify(value)} && !byId('theme-select').disabled`));
      await evaluate("paletteTransition?.finished");
    };
    for (const [language, labels] of [["ru", ["Как в системе", "Светлая", "Тёмная"]], ["en", ["System", "Light", "Dark"]]]) {
      assert.equal((await evaluate(`api.setLanguage(${JSON.stringify(language)})`)).ok, true);
      await until(() => evaluate(`document.documentElement.lang === ${JSON.stringify(language)}`));
      await verify(`JSON.stringify([...byId('theme-select').options].map(option=>option.textContent)) === ${JSON.stringify(JSON.stringify(labels))}`,
        language + " has exactly three localized choices");
    }
    await evaluate("api.setLanguage('ru')");
    await until(() => evaluate("document.documentElement.lang === 'ru'"));
    await choose("system");
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    if (process.platform !== "win32") {
      throw new Error("This run requires Windows for a genuine OS appearance update; use a platform native equivalent on Linux/macOS.");
    }
    originalWindowsTheme = JSON.parse(powershell(`
      $key = Get-ItemProperty -LiteralPath ${psQuote(themeKey)}
      @{
        exists = ($null -ne $key.AppsUseLightTheme)
        value = $key.AppsUseLightTheme
      } | ConvertTo-Json -Compress
    `));
    windowsTheme(1);
    await until(() => evaluate("document.documentElement.dataset.palette === 'light'"), "Windows light appearance");
    await evaluate("paletteTransition?.finished");
    await evaluate(`
      byId('agent-limits').elements.namedItem('executor').value = '17';
      body.scrollTop = 30;
      void 0;
    `);
    const state = await evaluate("({scroll:body.scrollTop, title:byId('sheet-title').textContent, input:byId('agent-limits').elements.namedItem('executor').value})");
    const nativeCapture = async name => {
      await evaluate(`
        body.scrollTop = 0;
        byId('theme-select').focus();
        void 0;
      `);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down", modifiers: ["alt"] });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down", modifiers: ["alt"] });
      await wait(250);
      const bounds = window.getContentBounds();
      const factor = screen.getDisplayMatching(window.getBounds()).scaleFactor;
      const path = join(artifacts, name);
      powershell(`
        Add-Type -AssemblyName System.Drawing
        $image = New-Object System.Drawing.Bitmap(${Math.round(bounds.width * factor)}, ${Math.round(bounds.height * factor)})
        $graphics = [System.Drawing.Graphics]::FromImage($image)
        try {
          $graphics.CopyFromScreen(${Math.round(bounds.x * factor)}, ${Math.round(bounds.y * factor)}, 0, 0, $image.Size)
          $image.Save(${psQuote(path)}, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
          $graphics.Dispose()
          $image.Dispose()
        }
      `);
      const picture = nativeImage.createFromPath(path);
      writeFileSync(path, picture.resize({ width: 1280, height: 800 }).toPNG());
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      log("PNG: " + name + "; native Windows screen crop of 1280x800 content with open unmodified select");
    };
    await nativeCapture("themes-system-light.png");
    await evaluate(`
      body.scrollTop = ${state.scroll};
      void 0;
    `);
    const traceWindowsPalette = async (value, palette) => {
      // Start sampling at the OS event, after the external PowerShell startup delay.
      await evaluate(`
        window.themeTrace = [];
        systemPalette.addEventListener('change', () => {
          const start = performance.now();
          const tick = () => {
            const fresh = getComputedStyle(document.documentElement, '::view-transition-new(root)');
            const old = getComputedStyle(document.documentElement, '::view-transition-old(root)');
            themeTrace.push({
              ms: Math.round(performance.now() - start),
              opacity: Number(fresh.opacity),
              oldOpacity: Number(old.opacity),
            });
            if (performance.now() - start < 450) {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }, { once: true });
        void 0;
      `);
      windowsTheme(value);
      await until(() => evaluate(`document.documentElement.dataset.palette === ${JSON.stringify(palette)}`),
        "Windows " + palette + " appearance");
      await evaluate("paletteTransition?.finished");
      await wait(500);
      const trace = await evaluate("themeTrace");
      const middle = trace.filter(item => item.opacity > 0.01 && item.opacity < 0.99);
      assert.ok(middle.length >= 2, "visible intermediate transition frames");
      assert.ok(middle.every(item => item.oldOpacity === 1), "old snapshot stays opaque behind the new snapshot");
      log("Intermediate frames towards " + palette + ": " + JSON.stringify(middle));
      log("PASS: actual Windows update towards " + palette + " produces " + middle.length +
        " intermediate fade frames over 160ms; old snapshot remains opaque (no transparent flash).");
      checks++;
    };
    await traceWindowsPalette(0, "dark");
    await verify(`body.scrollTop === ${state.scroll} && byId('sheet-title').textContent === ${JSON.stringify(state.title)} && byId('agent-limits').elements.namedItem('executor').value === '17' && sheet.open`,
      "OS change preserves open settings, unsaved field and scroll position");
    assert.equal(window.id, initialWindow);
    await nativeCapture("themes-system-dark.png");
    await traceWindowsPalette(1, "light");
    for (const [explicit, osValue] of [["light", 0], ["dark", 1]]) {
      await choose(explicit);
      windowsTheme(osValue);
      await wait(250);
      await verify(`document.documentElement.dataset.palette === ${JSON.stringify(explicit)} && frame.theme === ${JSON.stringify(explicit)}`,
        "explicit " + explicit + " survives the opposite OS appearance");
    }
    await choose("system");
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await until(() => evaluate("reducedMotion.matches"));
    await evaluate(`
      window.previousTransition = paletteTransition;
      void 0;
    `);
    windowsTheme(0);
    await until(() => evaluate("document.documentElement.dataset.palette === 'dark'"));
    await verify("paletteTransition === previousTransition && document.getAnimations().length === 0", "reduced motion applies OS palette immediately without a transition");
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    // CDP makes the timing deterministic for the mid-transition preference change.
    await evaluate(`
      frame.theme = 'light';
      applyTheme('light');
      paletteTransition.ready;
    `);
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await until(() => evaluate("document.getAnimations().length === 0"));
    await verify("document.documentElement.dataset.palette === 'light'", "enabling reduced motion ends a running fade at the chosen palette");
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await evaluate(`
      frame.theme = 'dark';
      applyTheme('dark');
      frame.theme = 'light';
      applyTheme('light');
      frame.theme = 'dark';
      applyTheme('dark');
      paletteTransition.finished;
    `);
    await verify("document.documentElement.dataset.palette === 'dark'", "rapid changes settle at the latest palette");
    const rejected = await evaluate("api.setTheme('dracula')");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "INVALID_INPUT");
    await choose("light");
    await choose("dark");
    assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).theme, "dark");
    checks++;
    log("PASS: removed preset rejected over real IPC; valid selection recovers and is saved for process restart");
    const after = await cdp("Accessibility.getFullAXTree");
    assert.ok(after.nodes.some(node => node.role?.value === "combobox"));
    log("PASS: CDP accessibility snapshot retains the theme combobox after interaction");
    checks++;
    log("Platform matrix: Windows 11 x64 — production GUI, real AppsUseLightTheme changes and WM_SETTINGCHANGE; Linux/macOS — shared renderer and migration code inspected, native GUI not run here. Packaging is unchanged.");
    log("Scheduled evening behavior uses the same OS nativeTheme update path; no wall-clock overnight schedule was awaited. Reduced motion was driven with CDP, not changed in host accessibility settings.");
  }
  log(`Phase ${oldTheme ?? restart ?? "GUI"}: ${checks} checks passed.`);
} catch (error) {
  process.exitCode = 1;
  log("FAIL: " + error.stack);
  if (window && !window.isDestroyed()) {
    writeFileSync(join(artifacts, "themes-failure.png"), (await window.webContents.capturePage()).toPNG());
  }
} finally {
  if (originalWindowsTheme) {
    windowsTheme(originalWindowsTheme.exists ? originalWindowsTheme.value : 1);
    if (!originalWindowsTheme.exists) {
      powershell(`Remove-ItemProperty -LiteralPath ${psQuote(themeKey)} -Name AppsUseLightTheme`);
    }
    log("Restored original Windows AppsUseLightTheme value.");
  }
  for (const current of BrowserWindow.getAllWindows()) {
    current.destroy();
  }
  app.exit(process.exitCode ?? 0);
}
})();
