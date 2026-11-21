import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern } from "../cli/model.ts";
import { directory, exists, readJson, withRuntimeLock, writeJson } from "../cli/storage.ts";
import type { BoardMcpTool } from "./board-mcp.ts";
import { cliFailure, type CliReply } from "./cli.ts";
import { goalMessages } from "./manager-history.ts";

const readTools = new Set([
  "board_list", "task_show", "expert_list", "expert_context", "expert_skill", "team_inbox", "team_findings",
  "provider_tools", "manager_inbox", "task_wait", "task_review_queue", "task_review", "task_review_diff",
  "task_review_artifact", "task_cleanup_status", "project_git", "project_path", "project_sha256",
  "project_git_branches", "milestones_list", "github_read", "ask_user",
]);

function managed(name: string, input: Record<string, unknown>) {
  if (name.startsWith("goal_")) {
    return false;
  }
  if (name === "team_findings") {
    return input.finding !== undefined;
  }
  if (name === "board_auto_queue") {
    return Object.keys(input).some(key => key !== "revision");
  }
  return !readTools.has(name);
}

export function goalActionTools(tools: BoardMcpTool[]): BoardMcpTool[] {
  return tools.map(tool => {
    if (tool.name.startsWith("goal_") || (readTools.has(tool.name) && tool.name !== "team_findings")) {
      return tool;
    }
    const schema = tool.inputSchema as { properties?: object };
    return { ...tool,
      description: tool.description + " When acting on a goal_inbox instruction, supply its goalMessageId and a stable goalActionKey for this one action. Reuse both on retries, including after compaction; the application returns the saved result. Do not change the key to retry an uncertain effect.",
      inputSchema: { ...schema, properties: { ...schema.properties,
        goalMessageId: { type: "string", pattern: codexThreadPattern.source },
        goalActionKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,120}$" },
      } },
    };
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

type Receipt = { signature: string; result?: CliReply };

// Reserve before invoking the shared application action. An interrupted action
// without a saved result stays uncertain and cannot silently execute twice.
export async function runGoalAction(project: string, goalId: string, name: string, args: unknown,
  invoke: (input: unknown) => Promise<CliReply>): Promise<CliReply> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    return cliFailure("INVALID_INPUT", "Supply an object with the action's arguments.");
  }
  const { goalMessageId, goalActionKey, ...input } = (args ?? {}) as Record<string, unknown>;
  if (!managed(name, input)) {
    return invoke(input);
  }
  const messages = goalMessages(project, goalId);
  if (goalMessageId === undefined && goalActionKey === undefined) {
    if (messages.some(message => message.status === "pending")) {
      return cliFailure("GOAL_INSTRUCTION_REQUIRED", "Read goal_inbox and identify the instruction with goalMessageId and a stable goalActionKey before changing the board.");
    }
    return invoke(input);
  }
  if (typeof goalMessageId !== "string" || !codexThreadPattern.test(goalMessageId) ||
      typeof goalActionKey !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(goalActionKey)) {
    return cliFailure("INVALID_INPUT", "Supply a valid goalMessageId and goalActionKey.");
  }
  const message = messages.find(entry => entry.id === goalMessageId);
  if (!message) {
    return cliFailure("GOAL_MESSAGE_NOT_FOUND", "Read goal_inbox for the current goal's instructions.");
  }
  const folder = join(project, ".tasks", "goal-actions");
  directory(folder, true);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const path = join(folder, hash(JSON.stringify([goalId, goalMessageId, goalActionKey])) + ".json");
  const signature = JSON.stringify(canonical({ name, input }));
  const prior = withRuntimeLock(folder, () => {
    if (exists(path)) {
      const receipt = readJson(path) as Receipt;
      if (receipt.signature !== signature) {
        return cliFailure("GOAL_ACTION_CONFLICT", "This instruction/action key already identifies different arguments.");
      }
      return receipt.result ?? cliFailure("GOAL_ACTION_UNCERTAIN", "This action was started without a saved result. Inspect its effect; do not execute it again under another key.");
    }
    if (message.status !== "pending") {
      return cliFailure("GOAL_MESSAGE_CLOSED", "This instruction is already closed; no new action may be started for it.");
    }
    writeJson(path, { signature });
    return undefined;
  });
  if (prior) {
    return prior;
  }
  const result = await invoke(input);
  withRuntimeLock(folder, () => {
    if (name === "task_create" && !result.ok && result.error.code === "TASK_TAGS_REQUIRED") {
      // Creation stopped before saving a card or registering tags. Allow corrected arguments for this key.
      unlinkSync(path);
    } else {
      writeJson(path, { signature, result });
    }
  });
  return result;
}
