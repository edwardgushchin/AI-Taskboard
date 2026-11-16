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

test("language IPC persists alongside theme, broadcasts to every window and survives preference reload", t => {
  const profile = mkdtempSync(join(tmpdir(), "taskboard-language-settings-"));
  t.after(() => { localization.select("en"); rmSync(profile, { recursive: true }); });
  const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["themes", "theme", "loadTheme", "isTheme"]);
  const selected = ast.statements.filter(node =>
    ts.isFunctionDeclaration(node) ? Boolean(node.name && names.has(node.name.text)) :
    ts.isVariableStatement(node) ? node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text)) :
    ts.isExpressionStatement(node) && /^ipcMain.handle\("appearance:(theme|language)"/.test(node.getText(ast)));
  const handlers = new Map<string, (event: unknown, value: unknown) => any>();
  const sent: string[] = [];
  const first = { project: "one", draft: "unsent 日本語" }, second = { project: "two", queue: ["queued"] };
  const runtime = runInNewContext(stripTypeScriptTypes(selected.map(node => node.getText(ast)).join("\n")) + "\n({loadTheme})", {
    localization, t: localization.text, readJson, writeJson, join,
    mkdirSync() {}, stateOf() {}, app: { getPath: () => profile, getPreferredSystemLanguages: () => ["ja-JP", "en-US"] },
    nativeTheme: {}, ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
    windowStates: new Map([[1, { active: first, window: { isDestroyed: () => false, webContents: { send: () => {} } } }],
      [2, { active: second, window: { isDestroyed: () => false, webContents: { send: () => {} } } }]]),
    send: (active: {project: string}) => sent.push(active.project),
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
  });
  const language = handlers.get("appearance:language")!, theme = handlers.get("appearance:theme")!;
  assert.equal(language({}, "pl").ok, true);
  assert.equal(localization.locale, "pl");
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(first.draft, "unsent 日本語"); assert.deepEqual(second.queue, ["queued"]);
  assert.equal(theme({}, "dark").ok, true);
  assert.deepEqual(readJson(join(profile, "appearance.json")), { theme: "dark", language: "pl" });
  localization.select("en"); runtime.loadTheme();
  assert.equal(localization.locale, "pl");
  assert.equal(language({}, "system").ok, true);
  assert.equal(localization.locale, "ja");
  localization.select("en"); runtime.loadTheme();
  assert.equal(localization.locale, "ja");
  assert.equal(language({}, "invalid").error.code, "INVALID_INPUT");
  assert.equal(localization.locale, "ja");
  writeFileSync(join(profile, "appearance.json"), '{"theme":"light","language":"unknown"}');
  runtime.loadTheme();
  assert.equal(localization.locale, "ja");
});
