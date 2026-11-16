// Opt-in live check of native tools through the production manager launch path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replyToBoard } from "../src/desktop/codex-chat.ts";
import { boardInstructions } from "../src/desktop/board-actions.ts";

const root = mkdtempSync(join(tmpdir(), "T-0087-manager-read-"));
const tool = { name: "audit_result", description: "Record observations from native read tools for this verification fixture.",
  inputSchema: { type: "object", properties: {
    content: { type: "string" }, sha256: { type: "string" },
    freeBytes: { type: "number" }, totalBytes: { type: "number" }, missing: { type: "boolean" },
    listed: { type: "boolean" },
  }, required: ["content", "sha256", "freeBytes", "totalBytes", "missing", "listed"], additionalProperties: false } };
let id: string | undefined;
const results = [];
try {
  execFileSync(process.execPath, [fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)),
    "--project", root, "--json", "init"], { encoding: "utf8", windowsHide: true });
  for (const mode of ["new", "resumed"]) {
    const content = `native ${mode} read\n`;
    writeFileSync(join(root, "sample.txt"), content);
    const expectedHash = createHash("sha256").update(content).digest("hex");
    let observation: any;
    const activity = new Set<string>();
    const reply = await replyToBoard(root, root,
      "Verify native read capabilities in this fixture. Use provider shell/read tools to read sample.txt, list this directory, " +
      "check absent.txt is absent, get SHA-256 of sample.txt, " +
      "and free/total bytes on this directory's volume. Call audit_result once with the exact observations. " +
      "Inspect only the current temporary fixture, never other projects or directories. " +
      "Do not use any other MCP tools or modify files. This is verification only; no board or goal work is needed. Finish after recording.",
      [], async (name, args) => {
        assert.equal(name, "audit_result"); observation = args;
        return { ok: true, data: { recorded: true } };
      }, [], boardInstructions, AbortSignal.timeout(240_000), {
        id, title: "T-0087 native read verification", save: value => { id = value; },
        onActivity: items => { for (const item of items) activity.add(item.type); },
        onControl() {}, onWaiting() {}, mcpTools: [tool],
      });
    assert.ok(observation, JSON.stringify(reply));
    assert.equal(observation.content, content);
    assert.equal(observation.sha256.toLowerCase(), expectedHash);
    assert.ok(observation.freeBytes > 0 && observation.totalBytes >= observation.freeBytes);
    assert.equal(observation.missing, true);
    assert.equal(observation.listed, true);
    assert.ok(id);
    results.push({ mode, passed: true, sha256: expectedHash, activityTypes: [...activity] });
  }
  console.log(JSON.stringify({ profile: "ai-taskboard-manager", launch: "production replyToBoard; new and resumed session", results }));
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  assert.equal(existsSync(root), false);
}
