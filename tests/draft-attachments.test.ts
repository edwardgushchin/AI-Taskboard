import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { object, priorities, maxAttachmentBytes } from "../src/cli/model.ts";
import { readJson, writeJson } from "../src/cli/storage.ts";

// Run the actual IPC handler and composer with a local CLI double; no Electron or model calls.
function declarations(file: string, names: string[], handler = false) {
  const source = readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return stripTypeScriptTypes(parsed.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return node.name && names.includes(node.name.text);
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.includes(declaration.name.text));
    return handler && ts.isExpressionStatement(node) &&
      (node.getText(parsed).startsWith('ipcMain.handle("board:draft",') || node.getText(parsed).startsWith("imageTypes.set("));
  }).map(node => node.getText(parsed).replace(/^export /, "")).join("\n"));
}
const composerSource = declarations("codex.ts", ["invoke", "composeDraft", "stringList", "draftFields"]);
const handlerSource = declarations("main.ts", ["isPastedFile", "imageExtensions", "imageTypes"], true);

function fixture(t: TestContext) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-draft-test-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const capture = join(folder, "capture.json");
  const stub = join(folder, "codex.cjs");
  const draft = { title: "Align card text", description: "Draft", criteria: [], questions: [], tags: [], priority: "normal", subtasks: [] };
  writeFileSync(stub, [
    'const fs = require("node:fs");',
    'const [capture, outcome, ...args] = process.argv.slice(2);',
    'const prompt = fs.readFileSync(0, "utf8");',
    'const paths = args.flatMap((arg, i) => arg === "--image" ? [args[i + 1]] : []);',
    'fs.writeFileSync(capture, JSON.stringify({ args, prompt, images: paths.map(path => ({ path, base64: fs.readFileSync(path).toString("base64") })) }));',
    'if (outcome === "fail") { console.error("Unable to decode image #2 image.png"); process.exit(1); }',
    'fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], ' + JSON.stringify(JSON.stringify(draft)) + ');',
  ].join("\n"));
  const options = { outcome: "success" };
  const runtime = runInNewContext(composerSource + "\ncomposeDraft", {
    Error, join, priorities, object, readJson, writeJson, mkdtempSync, rmSync,
    tmpdir: () => folder, run: promisify(execFile),
    configuredCodex: async () => ({ path: process.execPath, args: [stub, capture, options.outcome] }),
  });
  const state = { board: { project: "board", tags: [{ name: "UI" }] }, drafting: false };
  const saved: { project: string; args: string[]; input: Record<string, unknown>; contents: string[]; paths: string[] }[] = [];
  let handler: (...args: unknown[]) => Promise<any>;
  runInNewContext(handlerSource, {
    ArrayBuffer, Buffer, Error, extname, join, mkdtemp, rm, writeFile, maxAttachmentBytes,
    tmpdir: () => folder, stateOf: () => state, app: { getPath: () => folder }, composeDraft: runtime,
    lang: (english: string) => english,
    cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    ipcMain: { handle: (_name: string, callback: typeof handler) => { handler = callback; } },
    callCli: async (project: string, args: string[], input: Record<string, unknown>) => {
      const sources = input.attachmentSources as { path: string }[];
      saved.push({ project, args: Array.from(args), input, paths: sources.map(file => file.path),
        contents: Array.from(sources, file => readFileSync(file.path).toString("base64")) });
      return { ok: true, data: input };
    },
  });
  return { folder, saved, state, options, draft,
    run: (request: string, files: unknown[]) => handler!({}, request, files),
    capture: () => JSON.parse(readFileSync(capture, "utf8")),
  };
}
const file = (name: string, type: string, content: string) => ({ name, type, bytes: new TextEncoder().encode(content).buffer });

test("drafts send both same-named images and all file metadata, preserving bytes for creation", async t => {
  const f = fixture(t);
  const files = [file("image.png", "image/png", "first"), file("notes.txt", "text/plain", "notes"), file("image.png", "", "second")];
  assert.equal((await f.run("Align the text shown in the screenshots", files)).ok, true);
  const captured = f.capture();
  const context = JSON.parse(captured.prompt.trim().split("\n").at(-1));
  assert.deepEqual(context.attachments, [
    { id: 1, name: "image.png", image: true, imageIndex: 1 },
    { id: 2, name: "notes.txt", image: false },
    { id: 3, name: "image.png", image: true, imageIndex: 2 },
  ]);
  assert.deepEqual(context.availableTags, ["UI"]);
  assert.equal(context.request, "Align the text shown in the screenshots");
  assert.equal(captured.images.length, 2);
  assert.notEqual(captured.images[0].path, captured.images[1].path);
  assert.deepEqual(captured.images.map((image: { base64: string }) => image.base64), ["Zmlyc3Q=", "c2Vjb25k"]);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.saved[0].args, ["create"]);
  assert.equal(f.saved[0].project, "board");
  assert.deepEqual(f.saved[0].contents, ["Zmlyc3Q=", "bm90ZXM=", "c2Vjb25k"]);
  assert.equal(f.saved[0].input.actor, "agent");
  assert.equal(f.saved[0].input.title, f.draft.title);
  assert.ok(f.saved[0].paths.every(path => !existsSync(path)), "temporary originals are cleaned after creation");
  assert.deepEqual(readdirSync(f.folder).sort(), ["capture.json", "codex.cjs"]);
  assert.equal(f.state.drafting, false);
});

test("image-only requests recognize supported extensions and MIME without relying on names", async t => {
  const f = fixture(t);
  const files = [file("SCREENSHOT.JPEG", "", "jpeg"), file("ref.webp", "application/octet-stream", "webp"),
    file("ref.gif", "", "gif"), file("clipboard", "image/png", "png"), file("notes.bin", "", "notes")];
  assert.equal((await f.run("", files)).ok, true);
  assert.equal(f.capture().images.length, 4);
  assert.equal(f.saved[0].contents.length, 5);
});

test("image transport failures report the reason, save no draft and allow retry with the same files", async t => {
  const f = fixture(t);
  f.options.outcome = "fail";
  const files = [file("image.png", "image/png", "first"), file("image.png", "image/png", "invalid")];
  const result = await f.run("Inspect both screenshots", files);
  assert.equal(result.error.code, "CODEX_DRAFT_FAILED");
  assert.match(result.error.message, /Unable to decode image #2 image\.png/);
  assert.equal(f.saved.length, 0);
  assert.equal(f.state.drafting, false);
  assert.deepEqual(readdirSync(f.folder).sort(), ["capture.json", "codex.cjs"]);
  f.options.outcome = "success";
  assert.equal((await f.run("Inspect both screenshots", files)).ok, true);
  assert.equal(f.saved.length, 1);
});

test("text and name-only files remain usable without image arguments", async t => {
  const f = fixture(t);
  assert.equal((await f.run("Update docs", [file("notes.txt", "text/plain", "notes")])).ok, true);
  assert.equal(f.capture().images.length, 0);
  assert.equal((await f.run("Update docs", [])).ok, true);
  assert.equal(f.saved.length, 2);
});
