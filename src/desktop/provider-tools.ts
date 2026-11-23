import { TaskboardError } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";
import { callCli, cliFailure } from "./cli.ts";
import { computerUseServer, computerUseSurfaces, computerUseSurfaceStatus, computerUseUnavailable } from "./computer-use.ts";

export type ProviderRequest = <T>(method: string, params: object) => Promise<T>;
type ServerConfig = { enabled?: boolean; required?: boolean; enabled_tools?: string[]; disabled_tools?: string[];
  command?: string; url?: string; tools?: Record<string, { enabled?: boolean }> };
type ServerStatus = { name: string; tools: Record<string, unknown>; toolsError?: string | null; authStatus?: string };
export interface ProviderTool {
  kind: "mcp" | "app"; server: string; tool: string; available: boolean; assignable: boolean; reason?: string;
  surfaces?: string[];
  unavailableSurfaces?: { url: string; code: string; reason: string }[];
}

async function pages<T>(request: ProviderRequest, method: string, params: object): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await request<{ data: T[]; nextCursor?: string | null }>(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error("Unsupported provider response");
    result.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Repeated provider cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

export async function providerTools(request: ProviderRequest, threadId: string, cwd: string, browserConnected = false) {
  // Config can contain credentials. It stays in memory and is never included in a tool reply.
  const { config } = await request<{ config: { mcp_servers?: Record<string, ServerConfig> } }>("config/read", { cwd, includeLayers: false });
  const servers = config.mcp_servers ?? {};
  const statuses = await pages<ServerStatus>(request, "mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" });
  const tools: ProviderTool[] = [];
  for (const status of statuses) {
    if (status.name === "ai_taskboard" || (status.name === computerUseServer && !browserConnected)) continue;
    const settings = servers[status.name];
    const names = Object.keys(status.tools ?? {});
    for (const tool of names.length ? names : [""]) {
      const available = Boolean(tool) && !status.toolsError && status.authStatus !== "notLoggedIn" && settings?.enabled !== false &&
        (!settings?.enabled_tools || settings.enabled_tools.includes(tool)) && !settings?.disabled_tools?.includes(tool) &&
        settings?.tools?.[tool]?.enabled !== false;
      const assignable = available && Boolean(settings?.command || settings?.url);
      tools.push({ kind: "mcp", server: status.name, tool, available, assignable,
        ...(status.name === computerUseServer ? computerUseSurfaceStatus(tool) : undefined),
        ...(!available ? { reason: status.authStatus === "notLoggedIn" ? "Provider authorization is required. Sign in through the provider settings and retry discovery." :
          status.toolsError ? "Provider MCP startup or authorization failed. Check provider settings; raw diagnostics are withheld to protect credentials." :
          tool ? "Disabled by provider configuration or policy." : "Provider advertised no callable tools for this server." } :
          !assignable ? { reason: "This plugin has no task-scoped MCP transport in the effective provider configuration." } : {}) });
    }
  }
  if (!browserConnected) {
    for (const [tool, surfaces] of Object.entries(computerUseSurfaces)) {
      tools.push({ kind: "mcp", server: computerUseServer, tool, available: false, assignable: false,
        reason: computerUseUnavailable, surfaces });
    }
  }
  let appsReason: string | undefined;
  try {
    const apps = await pages<{ id: string; isAccessible?: boolean; isEnabled?: boolean }>(request, "app/list", { threadId });
    for (const app of apps) tools.push({ kind: "app", server: app.id, tool: "", available: app.isAccessible === true && app.isEnabled === true,
      assignable: false, reason: "Task-scoped app assignment is not supported by this client. Manager access follows the provider account and policy." });
  } catch {
    appsReason = "App discovery is unavailable in this provider version, account or policy.";
  }
  return { tools, appsReason, builtins: "Built-in tools are supplied by the provider and governed by its permission profile. App Server does not expose a complete built-in tool catalog for assignment." };
}

export function providerActions(project: string, request: ProviderRequest, threadId: string, browserConnected = false) {
  return async (name: string, args: unknown) => {
    try {
      if (name === "task_tool_revoke") {
        const input = args as Record<string, unknown>;
        if (typeof input?.id !== "string") return cliFailure("INVALID_INPUT", "Supply the task ID and current revision.");
        return callCli(project, ["tool-revoke", input.id, "--compact"], { revision: input.revision, server: input.server, tool: input.tool });
      }
      const catalog = await providerTools(request, threadId, project, browserConnected);
      if (name === "provider_tools") return { ok: true as const, data: catalog };
      const input = args as Record<string, unknown> | null;
      if (input?.server === computerUseServer && !browserConnected) return cliFailure("TOOL_UNAVAILABLE", computerUseUnavailable);
      const selected = catalog.tools.find(tool => tool.kind === "mcp" && tool.server === input?.server && tool.tool === input?.tool);
      if (!selected?.assignable) return cliFailure("TOOL_UNAVAILABLE", selected?.reason ?? "Tool was not discovered for this provider session. Use provider_tools; no assignment was saved.");
      if (typeof input?.id !== "string") return cliFailure("INVALID_INPUT", "Supply the task ID and current revision.");
      const reply = await callCli<object>(project, ["tool-grant", input.id, "--compact"],
        { revision: input.revision, server: selected.server, tool: selected.tool });
      if (!reply.ok || !selected.surfaces) return reply;
      return {
        ok: true as const,
        data: {
          ...reply.data,
          server: selected.server,
          tool: selected.tool,
          surfaces: selected.surfaces,
          unavailableSurfaces: selected.unavailableSurfaces,
        },
      };
    } catch {
      return cliFailure("PROVIDER_TOOLS_UNAVAILABLE", "Provider discovery failed or is unsupported. Check the connected version, account and policy. No assignment was saved.");
    }
  };
}

export async function executorToolConfig(request: ProviderRequest, cwd: string, grants: Task["toolGrants"], browserConnected = false) {
  const { config } = await request<{ config: { mcp_servers?: Record<string, ServerConfig> } }>("config/read", { cwd, includeLayers: false })
    .catch(() => { throw new TaskboardError("PROVIDER_TOOLS_UNAVAILABLE", "Provider tool configuration could not be read. Check the connected version, account and policy."); });
  const servers = config?.mcp_servers;
  if (!servers?.ai_taskboard) throw new TaskboardError("PROVIDER_TOOLS_UNAVAILABLE", "Provider did not report the local board MCP configuration.");
  const selected: Record<string, ServerConfig> = Object.assign(Object.create(null), { ai_taskboard: servers.ai_taskboard });
  for (const [name, settings] of Object.entries(servers)) {
    if (name !== "ai_taskboard") selected[name] = { ...settings, enabled: false, required: false };
  }
  for (const grant of grants ?? []) {
    const original = servers[grant.server];
    if (grant.server === computerUseServer && !browserConnected) {
      throw new TaskboardError("TOOL_UNAVAILABLE", computerUseUnavailable + " Check the assigned tool and relaunch the task.");
    }
    if (!original || (!original.command && !original.url)) {
      throw new TaskboardError("TOOL_UNAVAILABLE", `${grant.server}/${grant.tool} is unavailable because its MCP transport is missing.`);
    }
    if (original.enabled === false || original.enabled_tools && !original.enabled_tools.includes(grant.tool) ||
        original.disabled_tools?.includes(grant.tool) ||
        original.tools?.[grant.tool]?.enabled === false) {
      throw new TaskboardError("TOOL_UNAVAILABLE", `Provider configuration does not allow ${grant.server}/${grant.tool}. Ask the manager to review the assignment.`);
    }
    const prior = selected[grant.server];
    selected[grant.server] = { ...original, enabled: true, required: false,
      enabled_tools: [...new Set([...(prior.enabled ? prior.enabled_tools ?? [] : []), grant.tool])] };
  }
  // config/read serializes optional fields as null. Passing them back as TOML
  // overrides turns them into empty strings in some App Server versions.
  const withoutNulls = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutNulls) :
    value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => [key, withoutNulls(entry)])) : value;
  return { mcp_servers: withoutNulls(selected) as Record<string, ServerConfig>, features: { apps: false } };
}

export async function verifyExecutorTools(request: ProviderRequest, threadId: string, grants: Task["toolGrants"], requiredBoardTools: string[] = []) {
  const rows = await pages<ServerStatus>(request, "mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" })
    .catch(() => { throw new TaskboardError("PROVIDER_TOOLS_UNAVAILABLE", "Provider tool discovery is unsupported or failed. No tool access was confirmed."); });
  const board = rows.find(row => row.name === "ai_taskboard" && !row.toolsError && Object.keys(row.tools).length);
  if (!board) {
    throw new TaskboardError("PROVIDER_TOOLS_UNAVAILABLE", "Local board tools did not initialize.");
  }
  if (requiredBoardTools.some(name => !Object.hasOwn(board.tools, name))) throw new TaskboardError("PROVIDER_TOOLS_UNAVAILABLE", "Required recurring executor tools did not initialize.");
  for (const grant of grants ?? []) {
    const row = rows.find(entry => entry.name === grant.server);
    if (row?.authStatus === "notLoggedIn") {
      throw new TaskboardError("TOOL_UNAVAILABLE", `Provider authorization is required for ${grant.server}/${grant.tool}.`);
    }
    if (!row || row.toolsError || !Object.hasOwn(row.tools, grant.tool)) {
      throw new TaskboardError("TOOL_UNAVAILABLE", `Provider discovery did not confirm ${grant.server}/${grant.tool} at launch. No tool access was confirmed.`);
    }
  }
  return Object.keys(board.tools);
}
