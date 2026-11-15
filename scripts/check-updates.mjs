// Exercise the real renderer/preload/main update API with an isolated application profile.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "updates", 90_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
const { transformSync } = require("esbuild");
for (const path of ["userData", "appData"]) {
  const directory = join(scratch, path);
  mkdirSync(directory);
  app.setPath(path, directory);
}
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
// Let Electron finish loading the entry module before waiting for app.whenReady().
void (async () => {
try {
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8").replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, transformSync(source, { loader: "ts", format: "esm" }).code);
  const loaded = new Promise(resolve => app.once("browser-window-created", (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.webContents.once("did-finish-load", () => resolve(window));
  }));
  require(entry);
  const window = await loaded;
  const check = () => window.webContents.executeJavaScript("window.taskboard.checkUpdates()");
  const live = await check();
  assert.equal(live.ok, true);
  assert.equal(live.data.currentVersion, app.getVersion());
  assert.equal(live.data.status, "empty");
  assert.equal(live.data.sourceUrl, "https://github.com/edwardgushchin/AI-Taskboard/releases");
  writeFileSync(join(artifacts, "updates-ipc-live.json"), JSON.stringify({ checkedAt: new Date().toISOString(), versions: process.versions, live }, null, 2));
  app.getVersion = () => "0.1.0";
  let response = [];
  let offline = false;
  globalThis.fetch = async url => {
    assert.match(String(url), /^https:\/\/api.github.com\/repos\/edwardgushchin\/AI-Taskboard\/releases\?/);
    if (offline) throw new TypeError("Offline");
    return Response.json(response);
  };
  response = [{ tag_name: "v0.2.0", draft: false, prerelease: false }];
  assert.equal((await check()).data.status, "available");
  app.getVersion = () => "0.2.0";
  assert.equal((await check()).data.status, "current");
  app.getVersion = () => "0.3.0-beta.2";
  response = [{ tag_name: "v0.3.0-beta.10", draft: false, prerelease: true }];
  assert.equal((await check()).data.latest.version, "0.3.0-beta.10");
  offline = true;
  assert.equal((await check()).error.code, "UPDATE_CHECK_FAILED");
  offline = false;
  assert.equal((await check()).data.status, "available");
  console.log("Updates preload/main checks passed: live empty repository, application version, available/current/prerelease, network failure and retry");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(process.exitCode ?? 0);
}
})();
