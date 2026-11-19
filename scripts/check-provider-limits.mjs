// Run with Node.js. Use --artifacts <directory> to retain screenshots and a report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "provider-limits", 60_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const read = name => readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8");
const results = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 600, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const page = win.webContents;
  const evaluate = code => page.executeJavaScript(code);
  const settle = () => delay(100);
  const check = async (expression, description) => {
    assert.equal(await evaluate(expression), true, description);
    results.push(description);
    console.log("PASS " + description);
  };
  const key = async (key, code, windowsVirtualKeyCode, text) => {
    const input = { key, code, windowsVirtualKeyCode };
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { ...input, type: "keyDown", text });
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { ...input, type: "keyUp" });
    await settle();
  };

  try {
    const markup = read("index.html").match(/    <button id="status-limits"[^\n]+\n    <section id="provider-limits"[^\n]+/)[0];
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><footer class="status-bar">' + markup + "</footer></html>",
    ));
    const codicons = readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url)).toString("base64");
    const iconStyles = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + codicons);
    await page.insertCSS(read("themes.css") + "\n" + iconStyles + "\n" + read("styles.css") +
      "\n.status-bar { position: fixed; inset: auto 0 0; }");
    await evaluate(`
      window.fixture = [];
      window.taskboard = {
        providerLimits: async () => window.fixture,
        onProviderLimitsChanged: callback => { window.refreshFixture = callback; },
      };
      ${localizationFixture()}
      ${read("provider-limits.js")}
      window.popup = document.querySelector("#provider-limits");
      window.button = document.querySelector("#status-limits");
      window.query = selector => popup.querySelector(selector);
      void 0;
    `);

    const weekly = { name: "codex", remaining: 19, durationMins: 10080, resetsAt: Date.now() + 86_400_000 };
    const codex = {
      provider: "Codex", plan: "plus", state: "ready", observedAt: Date.now(),
      windows: [{ name: "Codex", remaining: 83, durationMins: 300 }, weekly],
    };
    const second = {
      provider: "Second", state: "ready", observedAt: Date.now(),
      windows: [{ ...weekly, name: "LongModelName".repeat(4), remaining: 9 }],
    };
    const set = async providers => {
      await evaluate(`window.fixture = ${JSON.stringify(providers)}; refreshFixture(); void 0;`);
      await settle();
    };
    await set([codex]);
    page.debugger.attach();
    win.setContentSize(1280, 800);
    const position = await evaluate(`(() => {
      const rect = button.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    const mouse = (type, point, extra = {}) =>
      page.debugger.sendCommand("Input.dispatchMouseEvent", { type, ...point, ...extra });

    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await mouse("mouseMoved", { x: 200, y: 100 });
      for (const remaining of [1, 10, 11, 19]) {
        await set([{ ...codex, windows: [{ ...weekly, remaining }] }]);
        const low = remaining <= 10;
        for (const hovered of [false, true]) {
          await mouse("mouseMoved", hovered ? position : { x: 200, y: 100 });
          await settle();
          await check(`(() => {
            const expected = document.createElement("span");
            expected.style.color = ${low} ? "var(--accent)" : "inherit";
            button.parentElement.append(expected);
            const color = getComputedStyle(expected).color;
            expected.remove();
            const warning = taskboardLocalization.text("limits.low");
            const label = button.getAttribute("aria-label");
            return matchMedia("(prefers-color-scheme: ${theme})").matches &&
              innerWidth === 1280 && innerHeight === 800 &&
              button.matches(":hover") === ${hovered} &&
              button.textContent === "Лимиты ${remaining}%" &&
              button.classList.contains("quota-low") === ${low} &&
              label === button.title && label.includes("${remaining}%") && label.includes(warning) === ${low} &&
              [button, ...button.children].every(element => {
                const style = getComputedStyle(element);
                return style.color === color && style.textDecorationLine === "none";
              });
          })()`, `${theme}: ${remaining}%, ${hovered ? "hover" : "rest"}, color, no underline and accessible label`);
        }
      }

      await mouse("mouseMoved", { x: 200, y: 100 });
      await set([{ ...codex, windows: [{ ...weekly, remaining: 1 }] }]);
      await evaluate("button.blur()");
      await key("Tab", "Tab", 9);
      await check(`document.activeElement === button && button.matches(":focus-visible") &&
        getComputedStyle(button).outlineStyle === "solid" && getComputedStyle(button).outlineWidth === "2px"`,
      `${theme}: Tab shows the focus outline at 1%`);
      await evaluate("document.fonts.ready.then(() => true)");
      const screenshot = await page.capturePage({ x: 0, y: 750, width: 320, height: 50 });
      writeFileSync(join(artifacts, `limits-accent-${theme}.png`), screenshot.toPNG());
      await key("Enter", "Enter", 13, "\r");
      await check('popup.matches(":popover-open") && button.getAttribute("aria-expanded") === "true" && document.activeElement === popup',
        `${theme}: Enter opens the panel and moves focus inside`);
      await key("Escape", "Escape", 27);
      await check('!popup.matches(":popover-open") && document.activeElement === button',
        `${theme}: Escape closes the panel and returns focus`);
      await set([codex]);
      await mouse("mousePressed", position, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", position, { button: "left", clickCount: 1 });
      await settle();
      await check('popup.matches(":popover-open") && button.getAttribute("aria-expanded") === "true"',
        `${theme}: click opens the panel at 19%`);
      await key("Escape", "Escape", 27);
    }

    await evaluate("button.focus()");
    await key("Enter", "Enter", 13, "\r");
    await check('popup.matches(":popover-open") && button.getAttribute("aria-expanded") === "true" && document.activeElement === popup',
      "Enter opens the panel and moves focus inside");

    for (const [theme, width, capture] of [["dark", 900, true], ["dark", 340], ["light", 900], ["light", 340, true]]) {
      nativeTheme.themeSource = theme;
      win.setContentSize(width, 600);
      const multiple = width === 340;
      await set(multiple ? [codex, second] : [codex]);
      await check(`matchMedia("(prefers-color-scheme: ${theme})").matches &&
        query("h3").textContent === "Лимиты Codex" && query(".limits-plan").textContent === "Plus" &&
        popup.querySelectorAll(".limits-plan").length === 1 &&
        getComputedStyle(popup).borderTopLeftRadius === "16px"`, `${theme}: rounded card and known plan`);
      await check(`(() => {
        const weekly = popup.querySelectorAll(".limits-window")[1];
        const [label, value] = weekly.querySelector(".limits-row").children;
        const meter = weekly.querySelector("meter");
        return label.textContent === "Неделя" && value.textContent.replace(/\\s/g, "") === "19%" &&
          label.getBoundingClientRect().right < value.getBoundingClientRect().left &&
          meter.value / meter.max === 0.19 && meter.getAttribute("aria-valuetext").includes("19%") &&
          weekly.querySelector(".limits-reset").textContent.includes("Сброс") &&
          !popup.querySelector(".limits-window").querySelector(".limits-reset");
      })()`, `${theme}: 19% remaining, split row, reset only when reported`);
      await check(`(() => {
        const rect = popup.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 &&
          popup.scrollWidth === popup.clientWidth && popup.querySelectorAll(".limits-window").length === ${multiple ? 3 : 2};
      })()`, `${theme}: ${width}px, all windows fit without horizontal scrolling`);
      if (multiple) {
        await check(`query("section + section h3").textContent === "Лимиты Second" && !query("section + section .limits-plan") &&
          button.textContent.includes("9%") && button.classList.contains("quota-low")`,
          `${theme}: second provider without a plan, long bucket name and low-quota status`);
      }
      if (capture) {
        const area = await evaluate(`(() => {
          const rect = popup.getBoundingClientRect();
          const x = Math.max(0, Math.floor(rect.left) - 8);
          const y = Math.max(0, Math.floor(rect.top) - 8);
          return { x, y, width: Math.min(innerWidth, Math.ceil(rect.right) + 8) - x, height: innerHeight - y };
        })()`);
        writeFileSync(join(artifacts, `provider-limits-${theme}.png`), (await page.capturePage(area)).toPNG());
      }
      await set([{ ...codex, plan: undefined }]);
      await check('!query(".limits-plan") && button.textContent.includes("19%")',
        `${theme}: ${width}px, unknown Codex plan is hidden`);
    }

    await set([{ ...codex, observedAt: Date.now() - 181_000 }]);
    await check(`popup.textContent.includes(taskboardLocalization.text("limits.stale")) && !query("meter") &&
      button.textContent.includes("?")`, "Old observations show the stale state");
    await set([{ ...codex, windows: [{ ...weekly, resetsAt: Date.now() - 1 }] }]);
    await check('popup.textContent.includes(taskboardLocalization.text("limits.stale")) && !query("meter")',
      "An elapsed reset also shows the stale state");
    for (const state of ["unknown", "no_windows", "unsupported", "auth", "error"]) {
      await set([{ provider: "Codex", state, windows: [] }]);
      await check(`popup.textContent.includes(taskboardLocalization.text("limits.${state}")) &&
        !query("meter") && !query(".limits-plan") && button.textContent.includes("?")`, `Unavailable state: ${state}`);
    }
    await set([]);
    await check('Boolean(query(".limits-overview")) && !query("section") && button.textContent.includes("?")',
      "No connected providers shows the summary");
    await key("Escape", "Escape", 27);
    await check('!popup.matches(":popover-open") && button.getAttribute("aria-expanded") === "false" && document.activeElement === button',
      "Escape closes the panel and returns focus");
    await key(" ", "Space", 32, " ");
    await check('popup.matches(":popover-open")', "Space reopens the panel from the status button");
    await evaluate("button.click()");
    await settle();
    await check('!popup.matches(":popover-open")', "The status button closes the open panel");
    const report = [
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, ${process.platform} ${process.arch}`,
      "Command: node scripts/check-provider-limits.mjs --artifacts .tasks/qa",
      "Production markup, styles and renderer with fixture responses at the providerLimits boundary.",
      "Accent screenshots show the lower-left crop of the 1280×800 Electron viewport with keyboard focus.",
      "SHA-256 of the tested files as read from the checkout (raw bytes):",
      ...["index.html", "themes.css", "styles.css", "provider-limits.js", "localization.cjs",
        "vendor/codicons/codicon.css", "vendor/codicons/codicon.ttf"].map(name => {
        const bytes = readFileSync(new URL("../src/desktop/" + name, import.meta.url));
        return `${createHash("sha256").update(bytes).digest("hex")}  src/desktop/${name}`;
      }),
      ...["check-provider-limits.mjs", "electron-check.mjs"].map(name => {
        const bytes = readFileSync(new URL(name, import.meta.url));
        return `${createHash("sha256").update(bytes).digest("hex")}  scripts/${name}`;
      }),
      ...results.map(result => "PASS " + result),
    ].join("\n");
    writeFileSync(join(artifacts, "provider-limits-check.txt"), report + "\n");
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
