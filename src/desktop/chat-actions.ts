import { callCli, cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";
import { exists, locateBoard, onBoard } from "../cli/storage.ts";
import { readTask } from "../cli/archive.ts";
import { member, requireRevision, requireState, record, reviewModes, taskReviewMode, taskIdPattern, TaskboardError, priorities } from "../cli/model.ts";
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
export const reviewModeInstruction = "Use task_set_review_mode only for an explicit request in the latest owner message to set an existing review mode or restore inheritance. Ask for clarification before writing if the target or mode is ambiguous. Confirm the effective mode and whether it is assigned or inherited using the tool result.";

const reviewModeProperties = {
  mode: { type: ["string", "null"], enum: [...reviewModes, null], description: "Existing review mode. Null restores inheritance from the board." },
  authorization: { ...string, description: "Exact quote from the latest owner message containing the explicit request and mode or inheritance. Include the card ID if specified." },
};
const reviewModeTool = {
  type: "function", name: "task_set_review_mode", description: reviewModeInstruction,
  inputSchema: { type: "object", properties: reviewModeProperties, required: ["mode", "authorization"], additionalProperties: false },
};
export const boardReviewModeTool = {
  ...reviewModeTool,
  description: reviewModeInstruction + " The latest owner message must name the exact card ID. Read task_show for its current revision.",
  inputSchema: { ...reviewModeTool.inputSchema, properties: { ...reviewModeProperties, id: string, revision: { type: "integer" } },
    required: [...reviewModeTool.inputSchema.required, "id", "revision"] },
};
export const chatTools = [updateTool, returnTool, reviewModeTool];

export function setReviewModeFromChat(project: string, userText: string, args: unknown, current?: Task): CliReply<Task & { effectiveReviewMode: string }> {
  const fields = current ? reviewModeProperties : boardReviewModeTool.inputSchema.properties;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(fields, key))) {
    return cliFailure("INVALID_INPUT", "Use the parameters defined for this task action.");
  }
  const input = args as Record<string, unknown>;
  const id = current?.id ?? input.id;
  const { authorization } = input;
  const referenced = userText.match(/\bT-\d+\b/gi) ?? [];
  if (typeof id !== "string" || !taskIdPattern.test(id) || typeof authorization !== "string" || !authorization.trim() || !userText.includes(authorization) ||
      (!current && !(authorization.match(/\bT-\d+\b/gi) ?? []).some(reference => reference.toUpperCase() === id)) || referenced.some(reference => reference.toUpperCase() !== id)) {
    return cliFailure("USER_DIRECTION_REQUIRED", "Quote the latest owner's explicit request for this card.");
  }
  try {
    const mode = input.mode === null ? undefined : member(input.mode, reviewModes, "review mode");
    const data = onBoard(locateBoard(project), store => {
      const settings = store.index.settings;
      if (settings.boardType === "manual") throw new TaskboardError("MANUAL_BOARD", "Review modes require an agent board.");
      let task = readTask(store, id);
      requireState(task, ["draft", "ready", "in_progress", "blocked", "review"]);
      requireRevision(task, current?.revision ?? input.revision, true);
      if (task.reviewModeOverride?.mode !== mode) {
        if (exists(store.pendingPath(id))) throw new TaskboardError("PENDING_OPERATION", "Recover the interrupted operation before changing the review mode.");
        task = store.save(record({ ...task, acceptanceRepair: undefined,
          reviewModeOverride: mode ? { mode, version: task.revision + 1 } : undefined,
        }, "review-mode", "user", undefined, mode ?? "inherit"));
      }
      return { ...task, effectiveReviewMode: taskReviewMode(task, settings) };
    }, 0);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof TaskboardError) return cliFailure(error.code, error.message);
    throw error;
  }
}

export function reviewModeReceipt(task: Task & { effectiveReviewMode: string }) {
  return { id: task.id, revision: task.revision, reviewMode: task.effectiveReviewMode, inherited: !task.reviewModeOverride };
}

export function taskChatActions(project: string, initial: Task, userText: string, onChange: () => void,
  requestChanges?: (task: Task, reason: string) => Promise<CliReply>) {
  let task = initial;
  return async (name: string, args: unknown): Promise<CliReply> => {
    if (name === reviewModeTool.name) {
      const result = setReviewModeFromChat(project, userText, args, task);
      if (!result.ok) return result;
      if (result.data.revision !== task.revision) onChange();
      task = result.data;
      return { ok: true, data: reviewModeReceipt(result.data) };
    }
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
