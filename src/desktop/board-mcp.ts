import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CliReply } from "./cli.ts";

export interface BoardMcpTool {
  name: string;
  description: string;
  inputSchema: object;
}

export function boardToolContent(name: string, reply: CliReply) {
  if (name === "task_review_artifact" && reply.ok && reply.data && typeof reply.data === "object" &&
      "pngBase64" in reply.data && typeof reply.data.pngBase64 === "string") {
    const { pngBase64, ...data } = reply.data;
    return { text: JSON.stringify({ ...reply, data }), pngBase64 };
  }
  return { text: JSON.stringify(reply) };
}

export async function withBoardMcp<T>(
  tools: BoardMcpTool[],
  call: (name: string, args: unknown) => Promise<CliReply>,
  run: (config: string, env: Record<string, string>) => Promise<T>,
  toolTimeoutSeconds?: number,
): Promise<T> {
  const mcp = await openBoardMcp(tools, call, toolTimeoutSeconds);
  try {
    return await run(mcp.config, mcp.env);
  } finally {
    await mcp.close();
  }
}

export async function openBoardMcp(
  tools: BoardMcpTool[], call: (name: string, args: unknown, signal: AbortSignal) => Promise<CliReply>,
  toolTimeoutSeconds = 140,
) {
  const token = randomBytes(32).toString("hex");
  const tokenVariable = "AI_TASKBOARD_MCP_TOKEN";
  const server = createServer((request, response) => {
    const end = (status: number) => { response.writeHead(status).end(); };
    if (request.headers.origin !== undefined || request.headers.authorization !== "Bearer " + token) return end(403);
    if (request.url !== "/mcp") return end(404);
    if (request.method !== "POST") return end(405);

    void (async () => {
      let body = "";
      request.setEncoding("utf8");
      for await (const part of request) {
        body += part;
        if (Buffer.byteLength(body) > 65 * 1024) {
          end(413);
          return;
        }
      }
      const message = JSON.parse(body);
      if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return end(400);
      if (message.id === undefined) return end(202);
      let result: object | undefined;
      if (message.method === "initialize") {
        const version = message.params?.protocolVersion;
        result = { protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(version) ? version : "2025-11-25",
          capabilities: { tools: {} }, serverInfo: { name: "ai_taskboard", version: "0.1.0" } };
      } else if (message.method === "tools/list") {
        result = { tools };
      } else if (message.method === "tools/call" && tools.some(tool => tool.name === message.params?.name)) {
        if (response.destroyed) return;
        const lifetime = new AbortController();
        const closed = () => lifetime.abort();
        response.once("close", closed);
        try {
          const reply = await call(message.params.name, message.params.arguments, lifetime.signal);
          if (response.destroyed) return;
          const content = boardToolContent(message.params.name, reply);
          result = { content: [{ type: "text", text: content.text },
            ...(content.pngBase64 ? [{ type: "image", mimeType: "image/png", data: content.pngBase64 }] : [])], isError: !reply.ok };
        } finally {
          response.removeListener("close", closed);
        }
      } else if (message.method === "ping") {
        result = {};
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        ...(result ? { result } : { error: { code: -32601, message: "Unknown method or tool." } }),
      }));
    })().catch(() => { if (!response.headersSent) end(400); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  // AI Taskboard authorizes these tools within the scope of the current chat.
  const policies = tools.map(tool => `${tool.name}={approval_mode="approve"}`).join(",");
  return {
    config: `mcp_servers.ai_taskboard={url="http://127.0.0.1:${port}/mcp",bearer_token_env_var="${tokenVariable}",required=true,tool_timeout_sec=${toolTimeoutSeconds},tools={${policies}}}`,
    env: { [tokenVariable]: token },
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
