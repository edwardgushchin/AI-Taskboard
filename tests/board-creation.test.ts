import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const code = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "pickProject" ||
  node.getText(parsed).startsWith('ipcMain.handle("board:create",')).map(node => node.getText(parsed)).join("\n");

test("board creation uses the type chosen in the app and only the folder picker is native", async () => {
  const calls: unknown[][] = [];
  const handlers = new Map<string, (event: unknown, type: unknown) => Promise<any>>();
  const state = { window: { isDestroyed: () => false }, project: "old" };
  let cancelled = false;
  runInNewContext(stripTypeScriptTypes(code), {
    ipcMain: { handle: (name: string, handler: typeof handlers extends Map<string, infer T> ? T : never) => handlers.set(name, handler) },
    stateOf: () => state, t: (key: string) => key, existsSync: () => true,
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    dialog: {
      showOpenDialog: async () => { calls.push(["folder"]); return { canceled: cancelled, filePaths: ["chosen"] }; },
      showMessageBox: () => assert.fail("The host must not open a native type dialog"),
    },
    openProject: async (_: unknown, path: string, type: unknown) => { calls.push([path, type]); },
  });
  const create = handlers.get("board:create")!;
  for (const type of [undefined, true, "other"]) assert.equal((await create({}, type)).error.code, "INVALID_INPUT");
  assert.equal(calls.length, 0);
  await create({}, "manual"); await create({}, "agent");
  assert.deepEqual(calls, [["folder"], ["chosen", "manual"], ["folder"], ["chosen", "agent"]]);
  cancelled = true; await create({}, "manual");
  assert.deepEqual(calls.at(-1), ["folder"]);
  assert.equal(calls.length, 5);
});
