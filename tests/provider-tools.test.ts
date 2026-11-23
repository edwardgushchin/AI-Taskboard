import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/cli/model.ts";
import { createTask } from "../src/cli/tasks.ts";
import { grantTaskTool, requestTaskTool } from "../src/cli/task-tools.ts";
import { managerInbox } from "../src/cli/task-messages.ts";
import { executorToolConfig, providerActions, providerTools, verifyExecutorTools } from "../src/desktop/provider-tools.ts";
import type { ProviderRequest } from "../src/desktop/provider-tools.ts";
import { computerUseServer } from "../src/desktop/computer-use.ts";
import { callCli } from "../src/desktop/cli.ts";
import { confirmFixtureDraft, plannedDraft } from "./fixtures/planned-draft.ts";

test("tool requests reach the manager and grants are task-scoped, revisioned and restart-only", () => {
  const first = { ...createTask("T-0001", { title: "First" }), status: "in_progress" as const };
  const second = { ...createTask("T-0002", { title: "Second" }), status: "in_progress" as const };
  const requested = requestTaskTool(first, { server: "docs", tool: "read", reason: "Read the API documentation" });
  assert.equal(managerInbox([requested])[0]?.kind, "question");
  assert.equal(managerInbox([requested])[0]?.id, first.id);
  const granted = grantTaskTool(requested, { revision: first.revision, server: "docs", tool: "read" });
  assert.deepEqual(granted.toolGrants, [{ server: "docs", tool: "read" }]);
  assert.equal(second.toolGrants, undefined);
  assert.equal(granted.revision, first.revision + 1);
  assert.match(granted.history.at(-1)!.text!, /Restart.*no hot connection/);
  assert.throws(() => grantTaskTool(granted, { revision: first.revision, server: "docs", tool: "write" }));
  assert.equal(grantTaskTool(granted, { revision: granted.revision, server: "docs", tool: "read" }), granted);
});

test("provider discovery paginates, distinguishes policy and plugin limits and withholds credentials", async () => {
  const request: ProviderRequest = async <T>(method: string, params: object) => {
    const cursor = (params as { cursor?: string }).cursor;
    return (method === "config/read" ? { config: { mcp_servers: { docs: { url: "https://secret.invalid/?token=SECRET", disabled_tools: ["write"] } } } } :
      method === "app/list" ? { data: [{ id: "app", isAccessible: false, isEnabled: true }] } :
        cursor ? { data: [{ name: "failed", tools: {}, toolsError: "https://host?token=SECRET" }] } :
          { data: [{ name: "docs", tools: { read: {}, write: {} } }, { name: "plugin", tools: { run: {} } },
            { name: "login", tools: { read: {} }, authStatus: "notLoggedIn" }], nextCursor: "next" }) as T;
  };
  const result = await providerTools(request, "thread", ".");
  assert.equal(result.tools.find(t => t.tool === "read")?.assignable, true);
  assert.equal(result.tools.find(t => t.tool === "write")?.available, false);
  assert.equal(result.tools.find(t => t.server === "plugin")?.assignable, false);
  assert.equal(result.tools.find(t => t.server === "app")?.available, false);
  assert.match(result.tools.find(t => t.server === "login")?.reason ?? "", /authorization is required/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|secret.invalid/);
  const actions = providerActions(".", request, "thread");
  assert.equal((await actions("task_tool_grant", { server: "docs", tool: "write", id: "T-0001", revision: 1 })).ok, false);
  const denied: ProviderRequest = async () => { throw new Error("token=SECRET"); };
  const error = await providerActions(".", denied, "thread")("provider_tools", {});
  assert.equal(error.ok, false);
  assert.doesNotMatch(JSON.stringify(error), /SECRET/);
});

test("executor configuration limits external tools, preserves board and policy, and rejects stale grants", async () => {
  const source = { ai_taskboard: { url: "http://board" }, docs: { url: "https://docs", tools: { read: { approval_mode: "ask" } } }, other: { command: "other", required: true } };
  const request: ProviderRequest = async <T>() => ({ config: { mcp_servers: source } }) as T;
  const granted = await executorToolConfig(request, ".", [{ server: "docs", tool: "read" }]);
  assert.deepEqual(granted.mcp_servers.docs.enabled_tools, ["read"]);
  assert.deepEqual(granted.mcp_servers.docs.tools, source.docs.tools);
  assert.equal(granted.mcp_servers.other.enabled, false);
  assert.deepEqual(granted.mcp_servers.ai_taskboard, source.ai_taskboard);
  assert.equal(source.other.required, true);
  assert.equal((await executorToolConfig(request, ".", [])).mcp_servers.docs.enabled, false);
  const nullable: ProviderRequest = async <T>() => ({ config: { mcp_servers: { ...source,
    docs: { ...source.docs, tool_timeout_sec: null, env: null, enabled_tools: null } } } }) as T;
  const roundtrip = await executorToolConfig(nullable, ".", [{ server: "docs", tool: "read" }]);
  assert.equal(Object.hasOwn(roundtrip.mcp_servers.docs, "tool_timeout_sec"), false);
  assert.equal(Object.hasOwn(roundtrip.mcp_servers.docs, "env"), false);
  await assert.rejects(executorToolConfig(request, ".", [{ server: "missing", tool: "read" }]), /MCP transport is missing/);
  const policy: ProviderRequest = async <T>() => ({ config: { mcp_servers: { ...source, docs: { ...source.docs, disabled_tools: ["read"] } } } }) as T;
  await assert.rejects(executorToolConfig(policy, ".", [{ server: "docs", tool: "read" }]), /Provider configuration does not allow docs\/read/);
  const failed: ProviderRequest = async <T>() => ({ data: [{ name: "ai_taskboard", tools: { worklog_record: {} } }, { name: "docs", tools: {}, toolsError: "secret" }] }) as T;
  await assert.rejects(verifyExecutorTools(failed, "thread", [{ server: "docs", tool: "read" }]), /Provider discovery did not confirm docs\/read/);
  const rejected: ProviderRequest = async () => { throw new Error("https://host/?token=SECRET"); };
  await assert.rejects(executorToolConfig(rejected, ".", []), error =>
    error instanceof Error && !error.message.includes("SECRET") && /configuration could not be read/.test(error.message));
  await assert.rejects(verifyExecutorTools(rejected, "thread", []), error =>
    error instanceof Error && !error.message.includes("SECRET") && /No tool access was confirmed/.test(error.message));
  const revoked = grantTaskTool({ ...createTask("T-0003", { title: "Revocation" }), status: "ready", toolGrants: [{ server: "docs", tool: "read" }] },
    { revision: 1, server: "docs", tool: "read" }, true);
  assert.deepEqual(revoked.toolGrants, []);
});

test("recurring launch verifies the scoped child tool", async () => {
  const request: ProviderRequest = async <T>() => ({ data: [{ name: "ai_taskboard", tools: { worklog_record: {} } }] }) as T;
  await assert.rejects(verifyExecutorTools(request, "thread", [], ["task_spawn_child"]), /recurring executor tools/);
  const available: ProviderRequest = async <T>() => ({ data: [{ name: "ai_taskboard", tools: { task_spawn_child: {} } }] }) as T;
  assert.deepEqual(await verifyExecutorTools(available, "thread", [], ["task_spawn_child"]), ["task_spawn_child"]);
});

test("the Taskboard browser only accepts grants for an app-owned connection", async () => {
  const grant = { server: computerUseServer, tool: "browser_use" };
  const request: ProviderRequest = async <T>(method: string) => (method === "config/read"
    ? { config: { mcp_servers: { ai_taskboard: { url: "http://board" }, [computerUseServer]: { url: "http://browser" } } } }
    : method === "app/list" ? { data: [] }
    : { data: [{ name: computerUseServer, tools: { computer_use: {}, browser_use: {} } }] }) as T;
  const unavailable = (await providerTools(request, "thread", ".")).tools;
  assert.equal(unavailable.length, 2);
  assert.ok(unavailable.every(tool => !tool.available && !tool.assignable && tool.reason?.includes("Windows")));
  assert.ok((await providerTools(request, "thread", ".", true)).tools.every(tool => tool.assignable));
  const reply = await providerActions(".", request, "thread")("task_tool_grant", { id: "T-0001", revision: 1, ...grant });
  assert.ok(!reply.ok && reply.error.code === "TOOL_UNAVAILABLE" && reply.error.message.includes("Windows"));
  await assert.rejects(executorToolConfig(request, ".", [grant]), /local Windows desktop app/);
  assert.deepEqual((await executorToolConfig(request, ".", [grant], true)).mcp_servers[computerUseServer].enabled_tools, ["browser_use"]);
  assert.equal((await executorToolConfig(request, ".", [])).mcp_servers[computerUseServer].enabled, false);
});

test("Windows discovery and grant report a missing Chrome surface and keep the demo available", {
  skip: process.platform !== "win32",
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-chrome-discovery-"));
  t.after(() => rmSync(root, { recursive: true, maxRetries: 5 }));
  const paths = ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "HOMEDRIVE"];
  for (const key of paths) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
    process.env[key] = root;
  }

  const request: ProviderRequest = async <T>(method: string) => {
    if (method === "config/read") {
      return { config: { mcp_servers: { [computerUseServer]: { url: "http://browser" } } } } as T;
    }
    if (method === "app/list") return { data: [] } as T;
    return { data: [{ name: computerUseServer, tools: { computer_use: {}, browser_use: {} } }] } as T;
  };
  const actions = providerActions(root, request, "thread", true);
  const catalog = async () => {
    const result = await providerTools(request, "thread", root, true);
    const row = result.tools.find(tool => tool.tool === "computer_use");
    assert.ok(row?.assignable);
    return row;
  };
  const missing = await catalog();
  assert.deepEqual(missing.surfaces, ["app://computer-use/demo"]);
  assert.deepEqual(missing.unavailableSurfaces?.map(surface => [surface.url, surface.code]), [
    ["app://computer-use/chrome", "CHROME_NOT_INSTALLED"],
  ]);

  assert.ok((await callCli(root, ["init"], { git: true })).ok);
  const draft = await callCli<Task>(root, ["create"], plannedDraft({
    title: "Assign Computer Use",
    criteria: ["Demo remains available"],
    workingDirectory: root,
  }));
  assert.ok(draft.ok);
  confirmFixtureDraft(root, draft.data.id);
  const ready = await callCli<Task>(root, ["approve", draft.data.id], { revision: draft.data.revision });
  assert.ok(ready.ok);
  const granted = await actions("task_tool_grant", {
    id: ready.data.id,
    revision: ready.data.revision,
    server: computerUseServer,
    tool: "computer_use",
  });
  assert.ok(granted.ok);
  assert.match(JSON.stringify(granted.data), /CHROME_NOT_INSTALLED/);
  assert.match(JSON.stringify(granted.data), /"restartRequired":true/);
  const saved = await callCli<Task>(root, ["show", ready.data.id]);
  assert.ok(saved.ok);
  assert.deepEqual(saved.data.toolGrants, [{ server: computerUseServer, tool: "computer_use" }]);

  const installation = join(root, "Google", "Chrome", "Application");
  mkdirSync(installation, { recursive: true });
  writeFileSync(join(installation, "chrome.exe"), "");
  const available = await catalog();
  assert.ok(available.surfaces?.includes("app://computer-use/chrome"));
  assert.equal(available.unavailableSurfaces, undefined);
});
