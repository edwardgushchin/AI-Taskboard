import { callCli, cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";
import { priorities } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";

const string = { type: "string" };
const strings = { type: "array", items: string };
const boolean = { type: "boolean" };
const authorization = {
  ...string,
  description: "Quote the exact words in the latest user message that explicitly request this specific action.",
};

export const taskFields = {
  expertId: { type: ["string", "null"], description: "Board-owned expert specialization ID from expert_list. Set before starting. Null restores a general executor." },
  title: string, description: string, criteria: strings, questions: strings,
  tags: strings, dependencies: strings, priority: { ...string, enum: priorities },
  dueDate: { type: ["string", "null"], description: "Task deadline in YYYY-MM-DD format. Null removes it. This is not a scheduled start." },
  subtasks: { type: "array", items: {
    type: "object", properties: { title: string, done: boolean }, required: ["title"], additionalProperties: false,
  } },
};
const properties = { ...taskFields, authorization, note: string };
const updateTool = {
  type: "function", name: "task_update",
  description: "Edit the requested fields while keeping the current status. Lists replace existing lists.",
  inputSchema: { type: "object", properties, required: ["authorization"], additionalProperties: false },
};
export const chatTools = [updateTool];

export function taskChatActions(project: string, initial: Task, userText: string, onChange: () => void) {
  let task = initial;
  return async (name: string, args: unknown): Promise<CliReply> => {
    if (name !== updateTool.name || !args || typeof args !== "object" || Array.isArray(args)) {
      return cliFailure("INVALID_INPUT", "Unknown task action or invalid arguments.");
    }
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !Object.hasOwn(properties, key))) {
      return cliFailure("INVALID_INPUT", "Use the parameters defined for this task action.");
    }
    const { authorization, ...fields } = input;
    if (typeof authorization !== "string" || !authorization.trim() || !userText.includes(authorization)) {
      return cliFailure("USER_DIRECTION_REQUIRED", "Only the latest user's explicit request can authorize this action.");
    }
    const result = await callCli<Task>(project, ["update", task.id], {
      ...fields, actor: "user", note: fields.note ?? authorization, revision: task.revision, preserveStatus: true,
    });
    if (!result.ok) return result;
    task = result.data;
    onChange();
    return { ok: true, data: { id: task.id, title: task.title, status: task.status, revision: task.revision,
      summary: task.summary, nextStep: task.nextStep, git: task.git, result: task.result } };
  };
}
