import { callCli } from "./cli.ts";
import type { BoardMcpTool } from "./board-mcp.ts";

export const githubReadTool: BoardMcpTool = {
  name: "github_read",
  description: "Use the host's GitHub CLI login to read the active account, this board's origin repository, or one milestone with its due date. For view milestone pass its number.",
  inputSchema: { type: "object", properties: { view: { type: "string", enum: ["account", "repository", "milestone"] },
    number: { type: "integer", minimum: 1 } },
    required: ["view"], additionalProperties: false },
};

export const readBoardGitHub = (project: string, args: unknown) => callCli(project, ["github-read"], args);
