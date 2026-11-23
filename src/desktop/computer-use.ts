import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join } from "node:path";
import type { BrowserWindow } from "electron";
import type { Browser, Page } from "playwright-core";
import type { Task } from "../cli/model.ts";
import { openBoardMcp } from "./board-mcp.ts";
import { cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";

export const computerUseServer = "ai_taskboard_browser";
export const computerUseUnavailable = "Taskboard Computer Use and Browser Use require the local Windows desktop app.";
export const computerUseSupported = () => process.platform === "win32" && Boolean(process.versions.electron);

const demo = "app://computer-use/demo";
const site = "app://computer-use/test-site";
const chrome = "app://computer-use/chrome";
const chromeMissing = {
  url: chrome,
  code: "CHROME_NOT_INSTALLED",
  reason: "Google Chrome Stable was not found in the Windows installation directories.",
};
export const computerUseSurfaces: Record<string, string[]> = {
  computer_use: [demo, chrome],
  browser_use: [demo, site],
};

function chromeStablePath() {
  if (process.platform !== "win32") return;
  const { LOCALAPPDATA, ProgramFiles, HOMEDRIVE } = process.env;
  const roots = [
    LOCALAPPDATA,
    ProgramFiles,
    process.env["ProgramFiles(x86)"],
    HOMEDRIVE && HOMEDRIVE + "\\Program Files",
    HOMEDRIVE && HOMEDRIVE + "\\Program Files (x86)",
  ];
  for (const root of roots) {
    if (!root || !isAbsolute(root)) continue;
    const executable = join(root, "Google", "Chrome", "Application", "chrome.exe");
    try {
      if (statSync(executable, { throwIfNoEntry: false })?.isFile()) return executable;
    } catch {
      // Try the other installation directories if this one is inaccessible.
    }
  }
}

export function computerUseSurfaceStatus(tool: string) {
  const surfaces = computerUseSurfaces[tool];
  if (!surfaces) return;
  if (tool === "computer_use" && !chromeStablePath()) {
    return { surfaces: [demo], unavailableSurfaces: [chromeMissing] };
  }
  return { surfaces };
}
const width = 1280;
const height = 800;
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>AI Taskboard browser demo</title>
<style>
  body { font: 24px system-ui; margin: 0; background: #eef2fa; color: #172540; }
  main { max-width: 720px; margin: 112px auto; background: white; border-radius: 16px; padding: 48px; }
  h1 { margin: 0 0 24px; font-size: 40px; }
  label { display: flex; align-items: center; gap: 12px; width: max-content; cursor: pointer; }
  input { width: 28px; height: 28px; accent-color: #155bb4; }
  .complete, input:checked ~ .pending { display: none; }
  input:checked ~ .complete { display: inline; color: #15623c; }
</style>
<main><h1>AI Taskboard browser demo</h1><label><input id="confirmation" type="checkbox" aria-label="Confirm completion">
<span class="pending">Pending</span><span class="complete">Confirmed</span></label></main></html>`;
const page = "data:text/html;charset=utf-8," + encodeURIComponent(html);
const testHtml = html.replaceAll("AI Taskboard browser demo", "AI Taskboard test site");

async function openTestSite() {
  const path = "/" + randomUUID();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== path) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
    }).end(testHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin + path,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

const openUrl = (name: string) => ({
  type: "string",
  description: "Required for open. Choose " + computerUseSurfaces[name].join(" or ") + ".",
});
const tools = [
  { name: "computer_use", description: `Open the isolated Google Chrome test window (${chrome}) or ${demo}, capture a 1280×800 PNG, or click viewport coordinates.`,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["open", "screenshot", "click"] }, url: openUrl("computer_use"),
      x: { type: "integer", description: "Required for click." }, y: { type: "integer", description: "Required for click." },
    }, required: ["action"], additionalProperties: false } },
  { name: "browser_use", description: `Open the isolated HTTP test site (${site}) or ${demo}, read the title and checkbox state, or click the confirmation checkbox.`,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["open", "read", "click_confirmation"] }, url: openUrl("browser_use"),
    }, required: ["action"], additionalProperties: false } },
];

export async function openComputerUse(
  enabled: boolean,
  grants?: NonNullable<Task["toolGrants"]>,
  signal?: AbortSignal,
) {
  const exposed = grants ? tools.filter(tool => grants.some(grant => grant.server === computerUseServer && grant.tool === tool.name)) : tools;
  if (!enabled || !computerUseSupported() || !exposed.length) return;
  const windows = new Map<string, { window: BrowserWindow; release: () => void }>();
  let testSite: Awaited<ReturnType<typeof openTestSite>> | undefined;
  let chromeBrowser: Browser | undefined;
  let chromePage: Page | undefined;
  const targets = new Map<string, string>();
  let closed = false;
  let active: Promise<CliReply> | undefined;
  const perform = async (name: string, args: unknown, requestSignal: AbortSignal): Promise<CliReply> => {
    const input = args as { action?: unknown; url?: unknown; x?: number; y?: number } | null;
    const allowed = computerUseSurfaces[name];
    if (input?.action === "open" && (typeof input.url !== "string" || !allowed.includes(input.url))) {
      return cliFailure("BROWSER_SCOPE", "Allowed surfaces: " + allowed.join(", ") + ".");
    }
    if (typeof input?.action !== "string" ||
        !["open", ...(name === "computer_use" ? ["screenshot", "click"] : ["read", "click_confirmation"])].includes(input.action)) {
      return cliFailure("INVALID_INPUT", "Choose an action supported by this tool.");
    }
    const { x, y } = input;
    if (input.action === "click" && (typeof x !== "number" || typeof y !== "number" ||
        !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height)) {
      return cliFailure("INVALID_INPUT", "Click coordinates must be inside the 1280×800 viewport.");
    }
    if (closed || requestSignal.aborted) return cliFailure("BROWSER_STOPPED", "The browser session has stopped.");
    const target = input.action === "open" ? input.url as string : targets.get(name);
    try {
      if (target === chrome) {
        if (input.action === "open") {
          if (!chromePage || chromePage.isClosed()) {
            const executablePath = chromeStablePath();
            if (!executablePath) return cliFailure(chromeMissing.code, chromeMissing.reason);
            testSite ??= await openTestSite();
            await chromeBrowser?.close();
            const { chromium } = await import("playwright-core");
            if (closed || requestSignal.aborted) return cliFailure("BROWSER_STOPPED", "The browser session has stopped.");
            chromeBrowser = await chromium.launch({
              channel: "chrome",
              executablePath,
              headless: false,
              chromiumSandbox: true,
              proxy: { server: new URL(testSite.url).origin, bypass: "127.0.0.1" },
              timeout: 10_000,
            });
            const context = await chromeBrowser.newContext({
              viewport: { width, height },
              serviceWorkers: "block",
              acceptDownloads: false,
            });
            context.setDefaultTimeout(5000);
            const fixtureUrl = testSite.url;
            await context.route("**/*", route => route.request().url() === fixtureUrl ? route.continue() : route.abort());
            chromePage = await context.newPage();
            context.on("page", opened => {
              if (opened !== chromePage) {
                void opened.close().catch(() => {});
              }
            });
          }
          if (chromePage.url() !== testSite!.url) {
            await chromePage.goto(testSite!.url, { waitUntil: "domcontentloaded", timeout: 5000 });
          }
          targets.set(name, chrome);
          return { ok: true, data: { url: chrome, browser: "Google Chrome", width, height } };
        }
        if (!chromePage || chromePage.isClosed() || chromePage.url() !== testSite?.url) {
          return cliFailure("BROWSER_NOT_OPEN", `Open ${chrome} first.`);
        }
        if (input.action === "screenshot") {
          const image = await chromePage.screenshot({ scale: "css", timeout: 5000 });
          if (chromePage.url() !== testSite?.url) {
            return cliFailure("BROWSER_SCOPE", "The Chrome tab left the test site.");
          }
          return { ok: true, data: { url: chrome, width, height, pngBase64: image.toString("base64") } };
        }
        await chromePage.mouse.click(x!, y!);
        return { ok: true, data: { url: chrome, clicked: true } };
      }
      if (input.action === "open") {
        if (target === site) testSite ??= await openTestSite();
        const address = target === site ? testSite!.url : page;
        let entry = windows.get(address);
        if (!entry || entry.window.isDestroyed()) {
          const electron = await import("electron");
          if (closed || requestSignal.aborted) return cliFailure("BROWSER_STOPPED", "The browser session has stopped.");
          entry?.release();
          const partition = electron.session.fromPartition("taskboard-browser-" + randomUUID(), { cache: false });
          partition.webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: details.resourceType !== "mainFrame" || details.url !== address });
          });
          partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
          partition.setPermissionCheckHandler(() => false);
          const window = new electron.BrowserWindow({
            width,
            height,
            useContentSize: true,
            show: false,
            webPreferences: {
              session: partition,
              offscreen: true,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
            },
          });
          const contents = window.webContents;
          contents.setWindowOpenHandler(() => ({ action: "deny" }));
          contents.on("will-navigate", event => event.preventDefault());
          contents.on("will-redirect", event => event.preventDefault());
          contents.on("will-attach-webview", event => event.preventDefault());
          const denyDownload = (event: Electron.Event) => event.preventDefault();
          partition.on("will-download", denyDownload);
          const release = () => {
            partition.webRequest.onBeforeRequest(null);
            partition.setPermissionRequestHandler(null);
            partition.setPermissionCheckHandler(null);
            partition.removeListener("will-download", denyDownload);
          };
          entry = { window, release };
          windows.set(address, entry);
        }
        if (entry.window.webContents.getURL() !== address) {
          await entry.window.loadURL(address);
        }
        targets.set(name, target!);
        return { ok: true, data: { url: target, ...(target === site ? { address } : {}), width, height } };
      }
      // The original demo can be opened with one tool and used with the other.
      const surface = target ?? (windows.has(page) ? demo : undefined);
      const address = surface === site ? testSite?.url : surface === demo ? page : undefined;
      const window = address ? windows.get(address)?.window : undefined;
      if (!window || window.isDestroyed() || window.webContents.getURL() !== address) {
        return cliFailure("BROWSER_NOT_OPEN", "Open a supported surface first.");
      }
      const contents = window.webContents;
      if (input.action === "screenshot") {
        const image = await contents.capturePage();
        if (image.isEmpty()) return cliFailure("BROWSER_CAPTURE_FAILED", "Chromium returned an empty screenshot.");
        return { ok: true, data: { url: demo, width, height, pngBase64: image.resize({ width, height }).toPNG().toString("base64") } };
      }
      if (input.action === "read") {
        const state = await contents.executeJavaScript(`({ title: document.title, label: "Confirm completion",
          checked: document.querySelector("#confirmation").checked,
          status: document.querySelector("#confirmation").checked ? "Confirmed" : "Pending" })`);
        return { ok: true, data: { url: surface, ...state } };
      }
      if (input.action === "click_confirmation") {
        await contents.executeJavaScript('document.querySelector("#confirmation").click()');
      } else {
        for (const type of ["mouseDown", "mouseUp"] as const) {
          contents.sendInputEvent({ type, button: "left", clickCount: 1, x: x!, y: y! });
        }
      }
      return { ok: true, data: { url: surface, clicked: true } };
    } catch {
      if (closed || requestSignal.aborted) return cliFailure("BROWSER_STOPPED", "The browser session has stopped.");
      if (target === chrome) {
        if (!chromeStablePath()) {
          return cliFailure(chromeMissing.code, chromeMissing.reason);
        }
        return cliFailure("CHROME_FAILED", "The isolated Google Chrome window could not complete the action. Check desktop access and Chrome automation policy.");
      }
      return cliFailure("BROWSER_FAILED", "The isolated browser could not complete the action. Open the surface again or restart the session.");
    }
  };
  const connection = await openBoardMcp(exposed, async (name, args, requestSignal) => {
    if (active) return cliFailure("BROWSER_BUSY", "Wait for the current browser action to finish.");
    active = perform(name, args, requestSignal);
    try {
      return await active;
    } finally {
      active = undefined;
    }
  }, 25, computerUseServer);
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    closed = true;
    signal?.removeEventListener("abort", abort);
    const disconnected = connection.close();
    for (const { window } of windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    try {
      await active;
    } finally {
      for (const { release } of windows.values()) release();
      windows.clear();
      await Promise.all([chromeBrowser?.close(), testSite?.close(), disconnected]);
      chromeBrowser = undefined;
      chromePage = undefined;
      testSite = undefined;
    }
  })();
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { ...connection, close };
}
