import { member, object } from "../cli/model.ts";
import { callCli, cliFailure } from "./cli.ts";

const actions = ["progress", "block", "message", "submit"] as const;

// Keep executor writes on the existing UTF-8 process boundary. PowerShell 5.1
// string pipelines can replace Unicode with ASCII '?' before the CLI sees it.
export const executorResultTool = {
  name: "task_record_result",
  description: "Record progress, a blocker, a message to the manager, or submit the current assigned task. Prefer this tool over shell JSON pipelines. Pass action and the same input object as the CLI command; submit still requires a fresh reviewed preview token. The board fixes the project and task ID and runs the normal CLI validation.",
  inputSchema: { type: "object", properties: {
    action: { type: "string", enum: actions },
    input: { type: "object", additionalProperties: true },
  }, required: ["action", "input"], additionalProperties: false },
};

export async function recordExecutorResult(project: string, id: string, args: unknown) {
  try {
    const value = object(args);
    const action = member(value.action, actions, "action");
    return await callCli(project, [action, id, "--compact"], object(value.input));
  } catch (error) {
    return cliFailure("INVALID_INPUT", (error as Error).message);
  }
}
