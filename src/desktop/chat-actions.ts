import { callCli, cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";
import { priorities } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";

const string = { type: "string" };
const strings = { type: "array", items: string };
const boolean = { type: "boolean" };
const authorization = {
  ...string,
  description: "Quote the exact words in latestUserMessage.text that state the new task requirement, fact, or constraint, or explicitly request this edit. Include the context needed to justify all changed fields.",
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
  description: "Save clear new information from the latest user's message to the current card, even without a separate edit request. Send only changed fields, preserving existing content unless the user clearly changes it. Lists replace existing lists.",
  inputSchema: { type: "object", properties, required: ["authorization"], additionalProperties: false },
};
const returnProperties = { reason: string };
const returnTool = {
  type: "function", name: "task_request_changes",
  description: "Return this review card for correction. Include all user feedback and confirmed defects in reason. The executor waits for this discussion to finish and for an available slot. Confirm only the operation result; do not claim it has started.",
  inputSchema: { type: "object", properties: returnProperties, required: ["reason"], additionalProperties: false },
};
export const chatTools = [updateTool, returnTool];

export function taskChatActions(project: string, initial: Task, userText: string, onChange: () => void,
  requestChanges?: (task: Task, reason: string) => Promise<CliReply>) {
  let task = initial;
  return async (name: string, args: unknown): Promise<CliReply> => {
    if (name === returnTool.name) {
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).some(key => !Object.hasOwn(returnProperties, key))) {
        return cliFailure("INVALID_INPUT", "Supply only the correction reason for this card.");
      }
      const { reason } = args as { reason?: unknown };
      if (typeof reason !== "string" || !reason.trim()) return cliFailure("INVALID_INPUT", "Describe all required corrections.");
      if (task.status !== "review" || !requestChanges) return cliFailure("INVALID_TRANSITION", "Only the current review card can be returned.");
      const result = await requestChanges(task, reason);
      if (result.ok) { task = { ...task, status: "in_progress" }; onChange(); }
      return result;
    }
    if (name !== updateTool.name || !args || typeof args !== "object" || Array.isArray(args)) {
      return cliFailure("INVALID_INPUT", "Unknown task action or invalid arguments.");
    }
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !Object.hasOwn(properties, key))) {
      return cliFailure("INVALID_INPUT", "Use the parameters defined for this task action.");
    }
    const { authorization, ...fields } = input;
    if (typeof authorization !== "string" || !authorization.trim() || !userText.includes(authorization)) {
      return cliFailure("USER_DIRECTION_REQUIRED", "Quote the new information or edit request from the latest user's message.");
    }
    if ((task.status === "review" || task.closedAt) &&
        ["title", "description", "criteria", "questions", "subtasks", "dependencies", "expertId"].some(key => Object.hasOwn(fields, key))) {
      return cliFailure("REQUIREMENTS_LOCKED", "The requirements of submitted or completed work are locked.");
    }
    const revision = task.revision;
    const result = await callCli<Task>(project, ["update", task.id], {
      ...fields, actor: "user", note: fields.note ?? authorization, revision, preserveStatus: true,
    });
    if (!result.ok) return result;
    task = result.data;
    const changed = task.revision !== revision;
    if (changed) onChange();
    return { ok: true as const, data: { id: task.id, title: task.title, status: task.status, revision: task.revision,
      changed, summary: task.summary, nextStep: task.nextStep, git: task.git, result: task.result } };
  };
}
