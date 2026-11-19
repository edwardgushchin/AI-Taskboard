import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import localization from "../src/desktop/localization.cjs";
import { readJson, writeJson } from "../src/cli/storage.ts";

const main = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest, true);
const names = new Set(["themes", "theme", "loadTheme", "isTheme"]);
const selected = ast.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) {
    return Boolean(node.name && names.has(node.name.text));
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
  }
  return ts.isExpressionStatement(node) && /^ipcMain.handle\("appearance:(themes|theme)"/.test(node.getText(ast));
});
const code = stripTypeScriptTypes(selected.map(node => node.getText(ast)).join("\n")) +
  "\n({ loadTheme, currentTheme: () => theme })";

function runtime(profile: string, failWrite = false) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const nativeTheme = { themeSource: "system" };
  const state = runInNewContext(code, {
    localization, t: localization.text, readJson, join,
    writeJson: (path: string, data: unknown) => {
      if (failWrite) {
        throw new Error("Profile is read-only");
      }
      writeJson(path, data);
    },
    mkdirSync() {}, stateOf() {},
    app: { getPath: () => profile, getPreferredSystemLanguages: () => ["ru-RU"] },
    nativeTheme,
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) },
    windowStates: new Map(),
    cliFailure: (errorCode: string, message: string) => ({ ok: false, error: { code: errorCode, message } }),
  });
  state.loadTheme();
  return { ...state, handlers, nativeTheme };
}

test("all saved themes reload as the standard palette without losing profile fields", t => {
  const profile = mkdtempSync(join(tmpdir(), "taskboard-theme-migration-"));
  t.after(() => rmSync(profile, { recursive: true }));
  const cases = {
    system: "system", light: "light", dark: "dark",
    "github-light": "light", "solarized-light": "light",
    "github-dark": "dark", dracula: "dark", nord: "dark", "one-dark": "dark",
    "tokyo-night": "dark", "catppuccin-mocha": "dark", "solarized-dark": "dark", "gruvbox-dark": "dark",
  };
  for (const [saved, expected] of Object.entries(cases)) {
    const preference = { theme: saved, language: "ru", other: { label: "Сохранить 日本語", enabled: true } };
    writeJson(join(profile, "appearance.json"), preference);
    const first = runtime(profile);
    assert.equal(first.currentTheme(), expected, saved);
    assert.equal(first.nativeTheme.themeSource, expected, saved);
    assert.deepEqual(readJson(join(profile, "appearance.json")), { ...preference, theme: expected });
    const restarted = runtime(profile);
    assert.equal(restarted.currentTheme(), expected, "reload " + saved);
  }
});

test("theme choices are restricted and write failures keep the active palette", t => {
  const profile = mkdtempSync(join(tmpdir(), "taskboard-theme-write-"));
  t.after(() => rmSync(profile, { recursive: true }));
  writeJson(join(profile, "appearance.json"), { theme: "system", language: "ru" });
  const state = runtime(profile);
  assert.deepEqual(Array.from(state.handlers.get("appearance:themes")!({}), (entry: string[]) => entry[0]),
    ["system", "light", "dark"]);
  const choose = state.handlers.get("appearance:theme")!;
  for (const bad of ["github-dark", "Dark", " dark", "dark\n", "__proto__", "constructor", null, 0, {}]) {
    assert.equal(choose({}, bad).error.code, "INVALID_INPUT");
    assert.equal(state.currentTheme(), "system");
  }
  for (const choice of ["light", "dark", "system"]) {
    assert.equal(choose({}, choice).ok, true);
    assert.equal(runtime(profile).currentTheme(), choice);
  }
  const readonly = runtime(profile, true);
  assert.equal(readonly.handlers.get("appearance:theme")!({}, "dark").error.code, "STORAGE_ERROR");
  assert.equal(readonly.currentTheme(), "system");
  assert.equal(readonly.nativeTheme.themeSource, "system");
  writeJson(join(profile, "appearance.json"), { theme: "dracula", language: "ru", extra: 7 });
  const migrated = runtime(profile, true);
  assert.equal(migrated.currentTheme(), "dark");
  assert.deepEqual(readJson(join(profile, "appearance.json")), { theme: "dracula", language: "ru", extra: 7 });
  writeFileSync(join(profile, "appearance.json"), "{");
  assert.equal(runtime(profile).currentTheme(), "system");
});
