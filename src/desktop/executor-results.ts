import { member, object } from "../cli/model.ts";
import { callCli, cliFailure } from "./cli.ts";

const actions = ["progress", "checklist", "block", "message", "submit"] as const;

// Keep executor writes on the existing UTF-8 process boundary. PowerShell 5.1
// string pipelines can replace Unicode with ASCII '?' before the CLI sees it.
export const executorResultTool = {
  name: "task_record_result",
  description: "Record progress, mark a checklist item, report a blocker, message the manager, or submit the assigned task. For checklist use input {revision, index, done}, with the 1-based item number from the current card. Report each completed item promptly and reread after a revision conflict. Submit requires a fresh reviewed preview token. For extra review files, set input.artifacts to the individual paths relative to the task worktree. Any PNG needed as evidence must be registered for review, including PNGs committed to Git. The board fixes the project and task ID.",
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
