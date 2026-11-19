import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "activity-scroll", 60_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.disableHardwareAcceleration();

const read = path => readFileSync(new URL("../src/desktop/" + path, import.meta.url), "utf8");
const results = [];
void app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark";
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    useContentSize: true,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const page = window.webContents;
  const evaluate = code => page.executeJavaScript(code);
  const footer = read("index.html").match(/<footer class="status-bar">[\s\S]*?<\/footer>/)[0];
  const iconFont = readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url));
  const icons = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + iconFont.toString("base64"));
  const renderer = read("renderer.js").match(/function renderActiveAgents\(\) \{[\s\S]*?\n\}/)[0];
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><header></header><main></main>' + footer,
  ));
  await page.insertCSS(read("themes.css") + "\n" + icons + "\n" + read("styles.css"));
  await evaluate(`
    ${localizationFixture()}
    ${renderer}
    const byId = id => document.getElementById(id);
    const t = window.taskboardLocalization.text;
    const frame = { board: {} };
    const panel = byId("agent-activity");
    const indicator = byId("status-agents");
    const scroller = panel.querySelector(".agent-activity-scroll");
    function renderFixture(boardCount, operationCount) {
      frame.activeAgents = {
        total: boardCount * operationCount,
        details: Array.from({ length: boardCount }, (_, board) => ({
          name: "Доска " + (board + 1),
          executor: { used: 2, limit: 2 },
          reviewer: { used: 1, limit: 2 },
          managerBusy: false,
          operations: Array.from({ length: operationCount }, (_, operation) => ({
            role: "executor",
            kind: "execution",
            task: "T-" + String(board * operationCount + operation + 1).padStart(4, "0"),
          })),
        })),
      };
      renderActiveAgents();
    }
    function measure() {
      const outer = panel.getBoundingClientRect();
      const inner = scroller.getBoundingClientRect();
      const trigger = indicator.getBoundingClientRect();
      const last = [...scroller.querySelectorAll("li")].at(-1);
      const lastRect = last?.getBoundingClientRect();
      return {
        size: [innerWidth, innerHeight],
        scale: devicePixelRatio,
        open: panel.matches(":popover-open"),
        focused: document.activeElement === scroller,
        restored: document.activeElement === indicator,
        top: scroller.scrollTop,
        max: scroller.scrollHeight - scroller.clientHeight,
        scrollbar: scroller.offsetWidth - scroller.clientWidth,
        insets: [inner.top - outer.top, outer.right - inner.right, outer.bottom - inner.bottom],
        anchored: Math.abs(outer.bottom + 8 - trigger.top) < 1 &&
          Math.abs(outer.right - trigger.right) < 1,
        fits: outer.top >= 0 && outer.left >= 0 && outer.right <= innerWidth &&
          outer.bottom <= innerHeight && scroller.scrollWidth === scroller.clientWidth,
        last: last?.textContent,
        lastVisible: !!lastRect && lastRect.top >= inner.top && lastRect.bottom <= inner.bottom,
        wheel: { x: Math.round(inner.left + 70), y: Math.round(inner.top + 80) },
      };
    }
  `);
  window.focus();
  page.focus();
  page.setZoomFactor(1);
  page.debugger.attach("1.3");
  const cdp = (method, args) => page.debugger.sendCommand(method, args);
  const settle = () => delay(260);
  const measure = () => evaluate("measure()");
  const key = async (key, code, windowsVirtualKeyCode, text) => {
    const input = { key, code, windowsVirtualKeyCode };
    await cdp("Input.dispatchKeyEvent", { ...input, type: "keyDown", text });
    await cdp("Input.dispatchKeyEvent", { ...input, type: "keyUp" });
    await settle();
  };
  await evaluate("renderFixture(4, 18); indicator.focus(); document.fonts.ready.then(() => true)");
  await key(" ", "Space", 32);
  for (const [width, height] of [[1280, 800], [900, 540]]) {
    window.setContentSize(width, height);
    await key("Home", "Home", 36);
    const top = await measure();
    assert.deepEqual(top.size, [width, height]);
    assert.equal(top.scale, 1);
    assert.ok(top.open && top.focused && top.fits && top.anchored, JSON.stringify(top));
    assert.ok(top.scrollbar > 0 && top.top === 0 && top.max > 0, JSON.stringify(top));
    assert.ok(top.insets.every(inset => inset >= 16), JSON.stringify(top));
    if (width === 1280) {
      writeFileSync(join(artifacts, "activity-top.png"), (await page.capturePage()).toPNG());
    }
    for (let step = 0; step < 15; step++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...top.wheel, deltaX: 0, deltaY: 240 });
    }
    await settle();
    const wheel = await measure();
    assert.ok(wheel.top === wheel.max && wheel.lastVisible, JSON.stringify(wheel));
    await key("Home", "Home", 36);
    assert.equal((await measure()).top, 0);
    await key("End", "End", 35);
    const bottom = await measure();
    assert.ok(bottom.top === bottom.max && bottom.lastVisible, JSON.stringify(bottom));
    assert.match(bottom.last, /T-0072$/);
    assert.deepEqual(bottom.insets, top.insets);
    results.push(
      `- ${width}×${height} CSS-пикселей, DPR ${top.scale}. Полоса шириной ${top.scrollbar} px, ` +
      `отступы сверху, справа и снизу ${top.insets.join("/")} px. Колесо и End дошли до ${bottom.top}/${bottom.max} px. ` +
      `Последняя строка «${bottom.last}» полностью видна.`,
    );
    if (width === 900) {
      writeFileSync(join(artifacts, "activity-bottom-low.png"), (await page.capturePage()).toPNG());
    }
    await key("Escape", "Escape", 27);
    const closed = await measure();
    assert.ok(!closed.open && closed.restored, JSON.stringify(closed));
    await evaluate("renderFixture(1, 1)");
    await key("Enter", "Enter", 13, "\r");
    const short = await measure();
    assert.ok(short.open && short.focused && short.anchored && short.fits && short.lastVisible, JSON.stringify(short));
    assert.equal(short.max, 0);
    assert.equal(short.scrollbar, 0);
    await key("Escape", "Escape", 27);
    await evaluate("renderFixture(4, 18)");
    await key(" ", "Space", 32);
  }
  const sources = [
    "src/desktop/index.html", "src/desktop/styles.css", "src/desktop/themes.css",
    "src/desktop/renderer.js", "src/desktop/localization.cjs", "src/desktop/locales/ru.json",
    "src/desktop/vendor/codicons/codicon.css", "scripts/check-activity-scroll.mjs", "scripts/electron-check.mjs",
  ];
  const hashes = sources.map(path => {
    const source = readFileSync(new URL("../" + path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
    return `- ${createHash("sha256").update(source).digest("hex")}  ${path}`;
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", windowsHide: true,
  }).trim();
  writeFileSync(join(artifacts, "activity-scroll-check.md"), [
    "# Проверка прокрутки панели «Активность по доскам»", "",
    `Windows Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}. Zoom 100%.`,
    "Изолированное окно с исходной строкой состояния и функцией renderActiveAgents. Данные четырёх досок и 72 операций заданы фикстурой.", "",
    ...results,
    "- Space и Enter открыли панель и передали фокус прокручиваемой области. Escape закрыл панель и вернул фокус кнопке.",
    "- В обоих размерах короткий список целиком виден, ширина полосы и диапазон прокрутки равны нулю.", "",
    "Команда", "", "```powershell", "node scripts/check-activity-scroll.mjs --artifacts .tasks/qa", "```", "",
    `Git HEAD рабочего дерева: ${head}. SHA-256 проверенных исходников, UTF-8 с LF:`, "",
    ...hashes, "",
  ].join("\n"));
  console.log(results.join("\n"));
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
