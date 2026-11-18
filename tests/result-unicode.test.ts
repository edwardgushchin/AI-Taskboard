import { plannedDraft } from "./fixtures/planned-draft.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { callCli } from "../src/desktop/cli.ts";
import { executorResultTool, recordExecutorResult } from "../src/desktop/executor-results.ts";
import { openBoardMcp } from "../src/desktop/board-mcp.ts";
import { readManagerHistory, syncTaskStatusNotices } from "../src/desktop/manager-history.ts";
import type { Task } from "../src/cli/model.ts";

const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const sample = String.raw`Результат: ёж, English; «готово» — да? C:\Проект\file.ts /tmp/путь abc1234 ??? literal \u041F`;
const outcome = { summary: sample, checks: [sample + " checks"], limitations: [sample + " limits"] };
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

async function fixture(t: import("node:test").TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-unicode-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.equal(existsSync(root), false);
  });
  async function cli<T = any>(args: string[], input?: unknown): Promise<T> {
    const reply = await callCli<T>(root, args, input);
    assert.ok(reply.ok, JSON.stringify(reply));
    return reply.data;
  }
  await cli(["init"]);
  const task = await cli<Task>(["create"], plannedDraft({ title: "Unicode fixture", criteria: ["Exact text"], workingDirectory: root }));
  await cli(["approve", task.id]);
  await cli(["start", task.id]);
  syncTaskStatusNotices(root);
  return { root, id: task.id, cli };
}

function shellJson(shell: string, root: string, args: string[], input: unknown, mode: "default" | "utf8" | "file") {
  const path = join(root, "ввод.json");
  writeFileSync(path, JSON.stringify(input), "utf8");
  const command = "& " + [process.execPath, "--disable-warning=ExperimentalWarning", entry, "--project", root, "--json", ...args,
    ...(mode === "file" ? ["--input-file", path] : ["--stdin"])].map(quote).join(" ");
  const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
    (mode === "utf8" ? '$OutputEncoding = [Text.UTF8Encoding]::new($false); ' : "") +
    (mode === "file" ? command : `Get-Content -LiteralPath ${quote(path)} -Raw -Encoding UTF8 | ${command}`);
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const reply = JSON.parse(result.stdout);
  assert.ok(reply.ok, result.stdout);
  return reply.data;
}

async function verifySaved(f: Awaited<ReturnType<typeof fixture>>, expected = outcome) {
  const saved = await f.cli<Task>(["show", f.id]);
  assert.equal(saved.result?.summary, expected.summary);
  assert.deepEqual(saved.result?.checks, expected.checks);
  assert.deepEqual(saved.result?.limitations, expected.limitations);
  assert.equal(saved.history.at(-1)?.text, expected.summary);
  syncTaskStatusNotices(f.root);
  const history = readManagerHistory(f.root)!;
  assert.ok(history.turns.flatMap(turn => turn.items).some(item => item.text?.includes(expected.summary)));
  // Reload the actual persisted dialogue in a fresh process, not a memory cache.
  const reader = join(f.root, "read-history.mjs");
  writeFileSync(reader, `import { readManagerHistory } from ${JSON.stringify(new URL("../src/desktop/manager-history.ts", import.meta.url).href)}; console.log(JSON.stringify(readManagerHistory(process.argv[2])));`);
  const reload = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", reader, f.root], { encoding: "utf8", windowsHide: true });
  assert.equal(reload.status, 0, reload.stderr);
  assert.deepEqual(JSON.parse(reload.stdout), JSON.parse(JSON.stringify(history)));
  assert.equal(syncTaskStatusNotices(f.root), false, "no duplicate delivery after reload");
}

test("Windows PowerShell 5.1 loses Cyrillic before CLI; persisted source and notices already contain '?'", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const preview = await f.cli(["preview", f.id]);
  shellJson(shell, f.root, ["submit", f.id], { token: preview.token, noChanges: true, ...outcome }, "default");
  const saved = await f.cli<Task>(["show", f.id]);
  assert.notEqual(saved.result?.summary, sample);
  assert.match(saved.result!.summary, /\?{3,}/);
  assert.doesNotMatch(saved.result!.summary, /\p{Script=Cyrillic}/u);
  assert.ok(saved.result!.summary.includes("English"));
  assert.ok(saved.result!.summary.includes(String.raw`\u041F`));
  await verifySaved(f, { summary: saved.result!.summary, checks: saved.result!.checks, limitations: saved.result!.limitations! });
});

for (const shell of process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : []) {
  for (const mode of ["utf8", "file", ...(shell === "pwsh.exe" ? ["default"] as const : [])] as const) {
    test(`${shell} ${mode}: progress, message and submission survive process, card, notice and dialogue reload`, async t => {
      const f = await fixture(t);
      shellJson(shell, f.root, ["progress", f.id], { summary: sample, nextStep: sample }, mode);
      const progressed = await f.cli<Task>(["show", f.id]);
      assert.equal(progressed.summary, sample);
      assert.equal(progressed.nextStep, sample);
      shellJson(shell, f.root, ["message", f.id], { text: sample }, mode);
      assert.equal((await f.cli(["manager-inbox"])).at(-1).text, sample);
      const preview = await f.cli(["preview", f.id]);
      shellJson(shell, f.root, ["submit", f.id], { token: preview.token, noChanges: true, ...outcome }, mode);
      await verifySaved(f);
    });
  }
}

test("executor MCP uses direct UTF-8 spawn, scopes writes and keeps CLI validation", async t => {
  const f = await fixture(t);
  const mcp = await openBoardMcp([executorResultTool], (_name, args) => recordExecutorResult(f.root, f.id, args));
  t.after(() => mcp.close());
  const url = mcp.config.match(/http[^" ]+/)![0];
  async function record(action: string, input: unknown, ok = true) {
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + Object.values(mcp.env)[0] },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: executorResultTool.name, arguments: { action, input } } }) });
    const payload = await response.json() as any;
    const reply = JSON.parse(payload.result.content[0].text);
    assert.equal(reply.ok, ok, JSON.stringify(reply));
    return reply;
  }
  const old = await f.cli(["preview", f.id]);
  await record("progress", { summary: sample, nextStep: sample, id: "T-9999" });
  assert.equal((await f.cli<Task>(["show", f.id])).summary, sample);
  await record("message", { text: sample });
  await record("message", { text: "??? ????? ???" });
  assert.equal((await f.cli(["manager-inbox"])).at(-1).text, "??? ????? ???");
  assert.equal((await record("submit", { token: old.token, noChanges: true, ...outcome }, false)).error.code, "STALE_SNAPSHOT");
  await record("accept", {}, false);
  await record("message", { text: "x".repeat(4001) }, false);
  const preview = await f.cli(["preview", f.id]);
  await record("submit", { token: preview.token, noChanges: true, ...outcome });
  await verifySaved(f);
});

test("direct spawn preserves block reason and resume condition", async t => {
  const f = await fixture(t);
  const reply = await recordExecutorResult(f.root, f.id, { action: "block", input: { reason: sample, condition: sample } });
  assert.ok(reply.ok, JSON.stringify(reply));
  const saved = await f.cli<Task>(["show", f.id]);
  assert.equal(saved.blocked?.reason, sample);
  assert.equal(saved.blocked?.condition, sample);
  syncTaskStatusNotices(f.root);
  assert.ok(readManagerHistory(f.root)!.turns.flatMap(turn => turn.items).some(item => item.text?.includes(sample)));
});
