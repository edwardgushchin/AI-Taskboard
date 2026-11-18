import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { Task } from "../cli/model.ts";
import { openBoardMcp } from "./board-mcp.ts";
import { cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";

export const computerUseServer = "ai_taskboard_browser";
export const computerUseUnavailable = "Taskboard Computer Use and Browser Use require the local Windows desktop app.";
export const computerUseSupported = () => process.platform === "win32" && Boolean(process.versions.electron);

const demo = "app://computer-use/demo";
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

const urlProperty = { type: "string", description: `Required for open. Pass ${demo}.` };
const tools = [
  { name: "computer_use", description: `Open ${demo}, capture a 1280×800 PNG, or click viewport coordinates in the isolated demo.`,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["open", "screenshot", "click"] }, url: urlProperty,
      x: { type: "integer", description: "Required for click." }, y: { type: "integer", description: "Required for click." },
    }, required: ["action"], additionalProperties: false } },
  { name: "browser_use", description: `Open ${demo}, read its title and checkbox state, or click the confirmation checkbox by its label.`,
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["open", "read", "click_confirmation"] }, url: urlProperty,
    }, required: ["action"], additionalProperties: false } },
];

export async function openComputerUse(
  enabled: boolean,
  grants?: NonNullable<Task["toolGrants"]>,
  signal?: AbortSignal,
) {
  const exposed = grants ? tools.filter(tool => grants.some(grant => grant.server === computerUseServer && grant.tool === tool.name)) : tools;
  if (!enabled || !computerUseSupported() || !exposed.length) return;
  let window: BrowserWindow | undefined;
  let closed = false;
  let busy = false;
  const closeWindow = () => {
    closed = true;
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
  };
  const call = async (name: string, args: unknown, requestSignal: AbortSignal): Promise<CliReply> => {
    const input = args as { action?: unknown; url?: unknown; x?: number; y?: number } | null;
    if (input?.action === "open" && input.url !== demo) return cliFailure("BROWSER_SCOPE", `Only ${demo} is permitted.`);
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
    if (busy) return cliFailure("BROWSER_BUSY", "Wait for the current browser action to finish.");
    busy = true;
    try {
      if (input.action === "open") {
        if (!window || window.isDestroyed()) {
          const electron = await import("electron");
          if (closed || requestSignal.aborted) return cliFailure("BROWSER_STOPPED", "The browser session has stopped.");
          const partition = electron.session.fromPartition("taskboard-browser-" + randomUUID());
          partition.webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: details.resourceType !== "mainFrame" || details.url !== page });
          });
          partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
          partition.setPermissionCheckHandler(() => false);
          window = new electron.BrowserWindow({ width, height, useContentSize: true, show: false,
            webPreferences: { session: partition, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
              backgroundThrottling: false } });
          const contents = window.webContents;
          contents.setWindowOpenHandler(() => ({ action: "deny" }));
          contents.on("will-navigate", event => event.preventDefault());
          contents.on("will-redirect", event => event.preventDefault());
          contents.on("will-attach-webview", event => event.preventDefault());
          partition.on("will-download", event => event.preventDefault());
        }
        await window.loadURL(page);
        return { ok: true, data: { url: demo, width, height } };
      }
      if (!window || window.isDestroyed() || window.webContents.getURL() !== page) {
        return cliFailure("BROWSER_NOT_OPEN", `Open ${demo} first.`);
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
        return { ok: true, data: { url: demo, ...state } };
      }
      if (input.action === "click_confirmation") {
        await contents.executeJavaScript('document.querySelector("#confirmation").click()');
      } else {
        for (const type of ["mouseDown", "mouseUp"] as const) {
          contents.sendInputEvent({ type, button: "left", clickCount: 1, x: x!, y: y! });
        }
      }
      return { ok: true, data: { url: demo, clicked: true } };
    } catch {
      return cliFailure("BROWSER_FAILED", "The isolated browser could not complete the action. Open the demo again or restart the session.");
    } finally {
      busy = false;
    }
  };
  const connection = await openBoardMcp(exposed, call, 25, computerUseServer);
  signal?.addEventListener("abort", closeWindow, { once: true });
  if (signal?.aborted) closeWindow();
  return { ...connection, close: async () => {
    signal?.removeEventListener("abort", closeWindow);
    try { closeWindow(); } finally { await connection.close(); }
  } };
}
