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
        onBoardBudgetChanged: () => {},
      };
      ${localizationFixture()}
      ${read("provider-limits.js")}
      window.popup = document.querySelector("#provider-limits");
      window.button = document.querySelector("#status-limits");
      window.query = selector => popup.querySelector(selector);
      window.limitsContrast = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        const paint = color => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const rgba = context.getImageData(0, 0, 1, 1).data;
          const [red, green, blue] = Array.from(rgba.slice(0, 3), value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        paint(getComputedStyle(button.parentElement).backgroundColor);
        const background = paint(getComputedStyle(button).backgroundColor);
        const foreground = paint(getComputedStyle(button.querySelector("span")).color);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      };
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
    const checkContrast = async (theme, hovered) => {
      assert.equal(await evaluate('button.matches(":hover")'), hovered);
      const ratio = await evaluate("limitsContrast()");
      const description = `${theme}: ${hovered ? "hover" : "rest"} contrast ${ratio.toFixed(2)}:1`;
      assert.ok(ratio >= 4.5, description + ", expected at least 4.5:1");
      results.push(description);
      console.log("PASS " + description);
    };

    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      await mouse("mouseMoved", { x: 200, y: 100 });
      for (const remaining of [1, 10, 11, 19]) {
        await set([{ ...codex, windows: [{ ...weekly, remaining }] }]);
        const low = remaining <= 10;
        for (const hovered of [false, true]) {
          await mouse("mouseMoved", hovered ? position : { x: 200, y: 100 });
          await settle();
          if (remaining === 1) {
            await checkContrast(theme, hovered);
          }
          await check(`(() => {
            const expected = document.createElement("span");
            expected.style.color = ${low} ? "color-mix(in srgb, var(--accent) 40%, var(--text))" : "inherit";
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

    await set([{ ...codex, windows: [{ ...weekly, remaining: 1 }] }]);
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.palette = ${JSON.stringify(theme)}`);
      for (const hovered of [false, true]) {
        await mouse("mouseMoved", hovered ? position : { x: 200, y: 100 });
        await settle();
        await checkContrast(theme, hovered);
      }
    }
    await evaluate("delete document.documentElement.dataset.palette");
    await mouse("mouseMoved", { x: 200, y: 100 });
    await set([codex]);

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

    win.setContentSize(1280, 900);
    nativeTheme.themeSource = "dark";
    const dailyReset = weekly.resetsAt - 18 * 3_600_000;
    const resetFixture = {
      ...codex,
      observedAt: Date.now(),
      windows: [{ ...codex.windows[0], resetsAt: dailyReset }, weekly],
    };
    const resetCreditExpirations = [weekly.resetsAt + 86_400_000, weekly.resetsAt + 172_800_000, null];
    for (const [count, filename] of [[4, "positive"], [0, "zero"]]) {
      await set([{ ...resetFixture, availableResetCount: count, resetCreditExpirations }]);
      await check(`(() => {
        const counters = popup.querySelectorAll("section > .limits-reset-count");
        const dates = [...popup.querySelectorAll(".limits-window > .limits-reset")];
        const items = [...popup.querySelectorAll(".limits-reset-credits > li")];
        const expectedItems = ${count} ? ${JSON.stringify(resetCreditExpirations)}.map(time =>
          time === null ? "Срок действия не указан" :
            "Действует до " + new Date(time).toLocaleString(taskboardLocalization.locale)
        ) : [];
        const expectedDates = [${dailyReset}, ${weekly.resetsAt}].map(time =>
          taskboardLocalization.text("limits.reset", {
            time: new Date(time).toLocaleString(taskboardLocalization.locale),
          })
        );
        return innerWidth === 1280 && innerHeight === 900 && popup.matches(":popover-open") &&
          counters.length === 1 && counters[0].textContent === "Доступно сбросов: ${count}" &&
          dates.length === 2 && dates.every((row, index) => row.textContent === expectedDates[index]) &&
          [...popup.querySelectorAll(".limits-window")].every(window =>
            window.getBoundingClientRect().bottom <= counters[0].getBoundingClientRect().top
          ) &&
          items.length === expectedItems.length && items.every((item, index) =>
            item.textContent === expectedItems[index] &&
            item.getBoundingClientRect().top >= counters[0].getBoundingClientRect().bottom
          ) &&
          !query("button, a, input");
      })()`, `1280×900: one reset count (${count}) below both quota windows, window dates, and credit expirations`);
      const area = await evaluate(`(() => {
        const rect = popup.getBoundingClientRect();
        const x = Math.max(0, Math.floor(rect.left) - 8);
        const y = Math.max(0, Math.floor(rect.top) - 8);
        return { x, y, width: Math.min(innerWidth, Math.ceil(rect.right) + 8) - x, height: innerHeight - y };
      })()`);
      await evaluate("document.fonts.ready.then(() => true)");
      writeFileSync(join(artifacts, `codex-resets-${filename}.png`), (await page.capturePage(area)).toPNG());
    }
    await set([{ ...resetFixture, resetCreditExpirations }]);
    await check('!query(".limits-reset-count, .limits-reset-credits") && popup.querySelectorAll(".limits-reset").length === 2',
      "An absent count hides credit details and keeps both window dates");
    for (const count of ["5e1", "3x", null, -1, 1.5]) {
      await set([{ ...resetFixture, availableResetCount: count, resetCreditExpirations }]);
      await check('!query(".limits-reset-count, .limits-reset-credits")', `Malformed count is hidden: ${JSON.stringify(count)}`);
    }
    await set([{ ...resetFixture, availableResetCount: 3 }]);
    await check('query(".limits-reset-count").textContent === "Доступно сбросов: 3" && !query(".limits-reset-credits")',
      "Without a list, the valid count appears by itself");
    const alternateExpiration = weekly.resetsAt + 259_200_000;
    await set([{
      ...resetFixture,
      availableResetCount: 2,
      resetCreditExpirations: [Date.now() - 1000, alternateExpiration],
    }]);
    await check(`query(".limits-reset-count").textContent === "Доступно сбросов: 2" &&
      query(".limits-reset-credits > li:only-child")?.textContent ===
        "Действует до " + new Date(${alternateExpiration}).toLocaleString(taskboardLocalization.locale)`,
    "Replacing the response removes earlier and already expired rows without changing the reported count");
    await set([{ ...resetFixture, availableResetCount: 4, resetCreditExpirations }]);
    await evaluate('taskboardLocalization.select("en"); renderProviderLimits()');
    await check(`query(".limits-reset-count").textContent === "Available resets: 4" &&
      query(".limits-reset-credits > li").textContent ===
        "Expires " + new Date(${resetCreditExpirations[0]}).toLocaleString(taskboardLocalization.locale) &&
      query(".limits-reset-credits > li:last-child").textContent === "Expiration not provided"`,
    "Restored data shows the original count and dates in English");
    await evaluate('taskboardLocalization.select("ru"); renderProviderLimits()');
    await check(`query(".limits-reset-count").textContent === "Доступно сбросов: 4" &&
      query(".limits-reset-credits > li").textContent ===
        "Действует до " + new Date(${resetCreditExpirations[0]}).toLocaleString(taskboardLocalization.locale) &&
      query(".limits-reset-credits > li:last-child").textContent === "Срок действия не указан"`,
    "Restoring Russian restores the count, caption and date format");

    await set([{ ...codex, observedAt: Date.now() - 181_000, availableResetCount: 4, resetCreditExpirations }]);
    await check(`popup.textContent.includes(taskboardLocalization.text("limits.stale")) && !query("meter") &&
      !query(".limits-reset-count, .limits-reset-credits") && button.textContent.includes("?")`, "Old observations show only the stale state");
    await set([{ ...codex, windows: [{ ...weekly, resetsAt: Date.now() - 1 }] }]);
    await check('popup.textContent.includes(taskboardLocalization.text("limits.stale")) && !query("meter")',
      "An elapsed reset also shows the stale state");
    for (const state of ["unknown", "auth", "error"]) {
      await set([{ provider: "Codex", state, windows: [] }]);
      await check(`popup.textContent.includes(taskboardLocalization.text("limits.${state}")) &&
        !query("meter") && !query(".limits-plan") && !query(".limits-reset-count") &&
        button.textContent.includes("?")`, `Unavailable state: ${state}`);
    }
    for (const state of ["no_windows", "unsupported"]) {
      await set([{ provider: "Codex", state, windows: [] }]);
      await check('Boolean(query("section > header:only-child")) && button.textContent.includes("?")',
        `Unavailable quota windows have no replacement message: ${state}`);
    }
    await set([{ ...resetFixture, state: "no_windows", windows: [], availableResetCount: 3 }]);
    await check('query("section > p:only-of-type")?.textContent === "Доступно сбросов: 3" && !query("meter")',
      "A confirmed count can be shown when quota windows are absent");
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
      "Command: node scripts/check-provider-limits.mjs --artifacts .tasks/qa/codex-resets-expiry",
      "Production markup, styles and renderer with fixture responses at the providerLimits boundary.",
      "Codex reset screenshots show the panel and status bar cropped from a 1280×900 content viewport.",
      "The renderer check covers the counter transition and recovery. Account identity, shared main-process reads and RPC methods are verified separately.",
      "Accent screenshots show the lower-left crop of the 1280×800 Electron viewport with keyboard focus.",
      "SHA-256 of the tested files as read from the checkout (raw bytes):",
      ...["index.html", "themes.css", "styles.css", "provider-limits.js", "localization.cjs",
        "locales/en.json", "locales/ru.json",
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
    writeFileSync(join(artifacts, "codex-resets-check.txt"), report + "\n");
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
