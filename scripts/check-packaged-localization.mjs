import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "packaged-language", 120_000);
const { app, BrowserWindow, dialog } = await import("electron");
const index = process.argv.indexOf("--app");
assert.ok(index >= 0, "Supply --app with the built resources/app.asar path");
const archive = resolve(process.argv[index + 1]);
for (const key of ["userData", "appData"]) {
  const directory = join(scratch, key); mkdirSync(directory); app.setPath(key, directory);
}
app.disableHardwareAcceleration();
dialog.showErrorBox = (title, content) => { console.error(title + ": " + content); app.exit(1); };
let checks = 0;
const until = async predicate => {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, "Packaged app did not become ready"); await new Promise(r => setTimeout(r, 50)); }
};
void (async () => {
try {
  const localization = createRequire(import.meta.url)(join(archive, "src/desktop/localization.cjs"));
  assert.equal(Object.keys(localization.catalogs).length, 10); checks++;
  console.log("Importing packaged main");
  await import(pathToFileURL(join(archive, "src/desktop/main.ts")).href);
  console.log("Waiting for packaged windows");
  await app.whenReady();
  await until(async () => {
    const window = BrowserWindow.getAllWindows()[0];
    return window && await window.webContents.executeJavaScript("Boolean(window.taskboard && document.querySelector('#welcome') && !document.querySelector('#welcome').hidden)").catch(() => false);
  });
  const first = BrowserWindow.getAllWindows()[0];
  first.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
  const evaluate = code => first.webContents.executeJavaScript(code);
  await evaluate("api.menuAction('new-window')");
  await until(() => BrowserWindow.getAllWindows().length === 2);
  const second = BrowserWindow.getAllWindows().find(window => window !== first);
  await until(() => second.webContents.executeJavaScript("Boolean(window.taskboard)").catch(() => false));
  for (const locale of Object.keys(localization.names)) {
    const result = await evaluate(`api.setLanguage('${locale}')`);
    assert.equal(result.ok, true);
    await until(async () => await second.webContents.executeJavaScript("document.documentElement.lang") === locale);
    assert.equal(await evaluate("document.documentElement.lang"), locale); checks++;
    await evaluate("settings(); void 0");
    assert.equal(await evaluate("document.querySelector('#sheet-title').textContent"), localization.text("ui.application_settings_b131bcd2", {}, locale)); checks++;
    assert.equal(await evaluate("document.querySelector('#language-select').options.length"), 11); checks++;
    await evaluate("sheet.close(); void 0");
  }
  const result = await evaluate("api.setLanguage('system')");
  assert.equal(result.ok, true);
  assert.equal(result.data.preference, "system"); checks++;
  writeFileSync(join(artifacts, "packaged-result.json"), JSON.stringify({ checks, electron: process.versions.electron,
    catalogs: Object.keys(localization.catalogs), keys: Object.keys(localization.catalogs.en).length,
    profile: "isolated system temporary directory", runtime: "built app.asar main, HTML, preload, IPC and two windows in Electron" }, null, 2));
  console.log("Packaged localization checks passed: " + checks);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(process.exitCode ?? 0); }

})();
