import { callCli } from "./cli.ts";
import type { BoardMcpTool } from "./board-mcp.ts";

export const githubReadTool: BoardMcpTool = {
  name: "github_read",
  description: "Read the active GitHub account or metadata for this board's GitHub origin using the host's existing GitHub CLI login.",
  inputSchema: { type: "object", properties: { view: { type: "string", enum: ["account", "repository"] } },
    required: ["view"], additionalProperties: false },
};

export const readBoardGitHub = (project: string, args: unknown) => callCli(project, ["github-read"], args);
