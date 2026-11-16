import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["createWindow", "loadProject", "openProject", "activateTab", "closeTab"]);
const lifecycle = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
  .map(node => node.getText(parsed)).join("\n");

function fixture(projects = ["slow", "active", "broken"], selected = "active") {
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<any>>>();
  const frames: { project?: string; loading?: boolean; restoring: boolean; error?: any; board?: any; tabs: string[] }[] = [];
  const bound = new Set<any>();
  const windowStates = new Map();
  class Window {
    webContents = { id: 1, setWindowOpenHandler() {}, on() {} };
    on() {} once() {} isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
  }
  const api = runInNewContext(stripTypeScriptTypes(lifecycle).replaceAll("import.meta.url", '"file:///app/main.ts"') + "\n({ createWindow, activateTab, closeTab, openProject })", {
    URL,
    BrowserWindow: Window, windowStates, customTitleBar: false, html: "app", fileURLToPath: (v: any) => v,
    projectPath: (v: string) => v, projectIdentity: (v: string) => v, existsSync: () => true,
    callCli: (project: string) => { const request = Promise.withResolvers<any>(); requests.set(project, request); return request.promise; },
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }), lang: (v: string) => v,
    bind: (tab: any, board: any) => { tab.board = board; tab.project = board.project; bound.add(tab); },
    unbind: (tab: any) => bound.delete(tab), confirmProjectClose: async () => true, saveSession() {},
    send: (tab: any) => { const owner = windowStates.get(tab.window.webContents.id); frames.push({
      project: owner.active.project, loading: owner.active.loading, restoring: owner.restoring,
      error: owner.active.error, board: owner.active.board, tabs: Array.from(owner.tabs, (t: any) => t.project),
    }); },
  });
  const state = api.createWindow(projects, selected);
  const finish = async (project: string, ok = true) => {
    requests.get(project)!.resolve(ok ? { ok, data: { project, tasks: [], tags: [] } } : { ok, error: { code: "PROJECT_UNAVAILABLE" } });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { api, state, requests, frames, bound, finish };
}

test("startup selects saved tab before bootstrap and loads all boards independently", async () => {
  const f = fixture();
  assert.equal(f.state.active.project, "active");
  assert.deepEqual(Array.from(f.state.tabs, (t: any) => t.project), ["slow", "active", "broken"]);
  await Promise.resolve();
  assert.equal(f.requests.size, 3);
  await f.finish("active");
  assert.equal(f.frames.at(-1)!.loading, false);
  assert.equal(f.frames.at(-1)!.restoring, false);
  assert.equal(f.frames.at(-1)!.board.project, "active");
  await f.finish("broken", false);
  assert.equal(f.frames.at(-1)!.error, undefined);
  await f.finish("slow");
  await f.state.ready;
  assert.ok(f.frames.every(frame => frame.project === "active"));
  assert.equal(f.bound.size, 2);
  assert.equal(f.state.tabs[2].error.code, "PROJECT_UNAVAILABLE");
  f.api.activateTab(f.state, f.state.tabs[2]);
  assert.equal(f.frames.at(-1)!.error.code, "PROJECT_UNAVAILABLE");
});

for (const action of ["switch", "close-background", "close-active"]) {
  test(`user ${action} wins over late restoration`, async () => {
    const f = fixture();
    await Promise.resolve();
    if (action === "switch") f.api.activateTab(f.state, f.state.tabs[0]);
    else await f.api.closeTab(f.state, f.state.tabs[action === "close-active" ? 1 : 0]);
    const chosen = f.state.active;
    await f.finish("active"); await f.finish("broken", false); await f.finish("slow");
    await f.state.ready;
    assert.equal(f.state.active, chosen);
    assert.equal(f.state.tabs.length, action === "switch" ? 3 : 2);
    assert.equal(f.bound.size, action === "switch" ? 2 : 1);
  });
}

for (const first of ["active", "slow"]) {
  test(`unavailable saved selection falls back regardless of completion order: ${first}`, async () => {
    const f = fixture(["slow", "active"], "active");
    await Promise.resolve();
    await f.finish(first, first !== "active");
    await f.finish(first === "active" ? "slow" : "active", first === "active");
    await f.state.ready;
    assert.equal(f.state.active.project, "slow");
    assert.equal(f.state.tabs.length, 2);
  });
}

test("explicit selection of failed startup tab prevents late fallback", async () => {
  const f = fixture(["slow", "active"]);
  await Promise.resolve(); await f.finish("active", false);
  f.api.activateTab(f.state, f.state.active);
  await f.finish("slow"); await f.state.ready;
  assert.equal(f.state.active.project, "active");
});

test("empty session shows welcome without a CLI request; all unavailable tabs stay open", async () => {
  const empty = fixture([]); await empty.state.ready;
  assert.equal(empty.state.active.project, undefined);
  assert.equal(empty.state.restoring, false);
  assert.equal(empty.requests.size, 0);
  const f = fixture(["slow", "active"]); await Promise.resolve();
  await f.finish("active", false); await f.finish("slow", false); await f.state.ready;
  assert.equal(f.state.active.project, "active");
  assert.equal(f.state.tabs.length, 2);
});
