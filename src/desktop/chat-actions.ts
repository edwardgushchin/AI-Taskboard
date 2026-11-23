import { callCli, cliFailure } from "./cli.ts";
import type { CliReply } from "./cli.ts";
import { exists, locateBoard, onBoard } from "../cli/storage.ts";
import { readTask } from "../cli/archive.ts";
import { member, requireRevision, requireState, record, reviewModes, taskReviewMode, taskIdPattern, TaskboardError, priorities } from "../cli/model.ts";
import type { ReviewMode, Task } from "../cli/model.ts";
import localization from "./localization.cjs";

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
export const reviewModeInstruction = "Use task_set_review_mode for direct, unambiguous owner requests. Examples: 'поставь карточке 319 только ревью, без человеческой приемки' means T-0319 in reviewer mode, 'Назначь T-0319 режим «Ревью + человек»' means reviewer-human, and 'Верни наследование для T-0319' restores inheritance. The card chat may omit the ID. Pass the complete latest owner message unchanged as authorization. If the card or mode is unclear, ask one short question about the missing information. Confirm the effective mode and inheritance from the successful tool result.";

const reviewModeProperties = {
  mode: { type: ["string", "null"], enum: [...reviewModes, null], description: "Existing review mode. Null restores inheritance from the board." },
  authorization: { ...string, description: "The complete latest owner message, including when it supplies just the requested card number." },
};
const reviewModeTool = {
  type: "function", name: "task_set_review_mode", description: reviewModeInstruction,
  inputSchema: { type: "object", properties: reviewModeProperties, required: ["mode", "authorization"], additionalProperties: false },
};
export const boardReviewModeTool = {
  ...reviewModeTool,
  description: reviewModeInstruction + " In the manager chat accept a card number or full ID. If the application has verified an answer to its card question, pass that answer as authorization. Read task_show for the exact ID and current revision.",
  inputSchema: { ...reviewModeTool.inputSchema, properties: { ...reviewModeProperties, id: string, revision: { type: "integer" } },
    required: [...reviewModeTool.inputSchema.required, "id", "revision"] },
};
export const chatTools = [updateTool, returnTool, reviewModeTool];

const reviewModeNames = new Map<string, ReviewMode>([
  ...reviewModes.map(mode => [mode, mode] as const),
  ["project manager", "manager"], ["review", "reviewer"], ["review + human", "reviewer-human"],
  ["человек", "human"], ["менеджер", "manager"], ["менеджер проекта", "manager"], ["ревью", "reviewer"],
  ["ревьюер", "reviewer"], ["ревью + человек", "reviewer-human"],
  ["только ревью", "reviewer"], ["ревью без человеческой приемки", "reviewer"],
  ["только ревью без человеческой приемки", "reviewer"],
  ["ревью, без человеческой приемки", "reviewer"], ["только ревью, без человеческой приемки", "reviewer"],
]);

const target = "(?:t-[0-9]{4,}|[0-9]+)";
const reviewModeCommand = new RegExp(
  `^(?:(?:пожалуйста|please),? )?(?:(?:для (?:карточки )?|for (?:card )?)(${target}),? )?` +
  "(назначь(?:те)?|установи(?:те)?|поставь(?:те)?|set|use|верни(?:те)?|восстанови(?:те)?|restore|reset) " +
  `(?:(?:карточке |для карточки |для |for card |for |card )?(${target}) )?(.+?)` +
  `(?: (?:для (?:карточки )?|for (?:card )?)(${target}|этой карточки|this card))?$`, "u",
);

export function reviewModeReplyTarget(value: string): string | undefined {
  value = value.trim();
  const id = value.toUpperCase();
  if (taskIdPattern.test(id)) return id;
  if (/^[0-9]+$/.test(value)) return "T-" + value.replace(/^0+(?=[0-9])/, "").padStart(4, "0");
}

function requestedReviewMode(message: string): { target?: string; mode: ReviewMode | null | undefined } | undefined {
  if (/[\r\n]/.test(message.trim())) return;
  const command = message.trim().toLowerCase().replaceAll("ё", "е").replace(/\s+/g, " ").replace(/[.!]$/, "");
  const match = reviewModeCommand.exec(command);
  if (!match) return;
  const [, before, verb, after, value, trailing] = match;
  const targets = [before, after, trailing].filter(Boolean);
  if (targets.length > 1) return;
  const target = targets[0] && (reviewModeReplyTarget(targets[0]) ?? targets[0]);

  if (/^(?:верни|восстанови|restore|reset)/u.test(verb)) {
    if (/^(?:наследование(?: (?:режима )?доски)?|(?:board )?inheritance|to board default)$/u.test(value)) {
      return { target, mode: null };
    }
    return;
  }
  const name = value.replace(/^(?:to |режим(?: ревью)? |review mode )/u, "");
  const quoted = /^(?:"([^"]+)"|«([^»]+)»|„([^“]+)“|“([^”]+)”|`([^`]+)`)$/u.exec(name);
  const mode = reviewModeNames.get((quoted?.slice(1).find(Boolean) ?? name).replace(/\s*\+\s*/g, " + "));
  if (mode || /^(?:режим|review mode|to)$/.test(value)) return { target, mode };
}

export function reviewModeQuestion(message: string, cardId?: string) {
  const request = requestedReviewMode(message);
  if (!request) return;
  if (!cardId && !request.target && request.mode !== undefined) return "card";
  if (request.mode === undefined && (cardId ? matchesReviewCard(request.target, cardId) : request.target?.startsWith("T-"))) {
    return "mode";
  }
}

function matchesReviewCard(target: string | undefined, id: string) {
  return !target || target === id || target === "этой карточки" || target === "this card";
}

export function reviewModeCardReply(message: string, previousRequest: string) {
  const target = reviewModeReplyTarget(message);
  const original = requestedReviewMode(previousRequest);
  if (target && original && !original.target && original.mode !== undefined) return { target, mode: original.mode };
}

export function setReviewModeFromChat(project: string, userText: string, args: unknown, current?: Task,
  previousRequest?: string): CliReply<Task & { effectiveReviewMode: ReviewMode }> {
  const fields = current ? reviewModeProperties : boardReviewModeTool.inputSchema.properties;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(fields, key))) {
    return cliFailure("INVALID_INPUT", "Use the parameters defined for this task action.");
  }
  const input = args as Record<string, unknown>;
  const id = current?.id ?? input.id;
  const { authorization } = input;
  if (typeof id !== "string" || !taskIdPattern.test(id) || typeof authorization !== "string" || authorization.trim() !== userText.trim()) {
    return cliFailure("USER_DIRECTION_REQUIRED", "Use the latest owner's complete command for this card.");
  }
  try {
    const selection = input.mode === null ? null : member(input.mode, reviewModes, "review mode");
    const request = requestedReviewMode(userText) ??
      (!current && previousRequest ? reviewModeCardReply(userText, previousRequest) : undefined);
    const target = request?.target;
    const matchesCard = current ? matchesReviewCard(target, id) : target === id;
    if (!matchesCard || request?.mode !== selection) {
      return cliFailure("USER_DIRECTION_REQUIRED", "Ask one short question about the unclear card or mode. Use the owner's complete latest message as authorization.");
    }
    const mode = selection ?? undefined;
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

export function reviewModeReceipt(task: Task & { effectiveReviewMode: ReviewMode }) {
  return { id: task.id, revision: task.revision, reviewMode: task.effectiveReviewMode, inherited: !task.reviewModeOverride };
}

export function reviewModeConfirmation(receipt: ReturnType<typeof reviewModeReceipt>) {
  const labels = {
    human: "ui.human_56f4a79e",
    manager: "ui.project_manager_48697fa0",
    reviewer: "ui.reviewer_50c42665",
    "reviewer-human": "ui.review_then_human",
  };
  const { id, inherited, reviewMode } = receipt;
  return localization.text(inherited ? "review_mode.inherited" : "review_mode.saved", {
    id, mode: localization.text(labels[reviewMode]),
  });
}

export function taskChatActions(project: string, initial: Task, userText: string, onChange: (revision: number) => void,
  requestChanges?: (task: Task, reason: string) => Promise<CliReply>,
  ownerChatSequence = initial.history.findLastIndex(event =>
    event.action === "chat" && event.actor === "user" && event.text === userText) + 1,
  onReviewMode?: (receipt: ReturnType<typeof reviewModeReceipt>) => void) {
  let task = initial;
  return async (name: string, args: unknown): Promise<CliReply> => {
    if (name === reviewModeTool.name) {
      const result = setReviewModeFromChat(project, userText, args, task);
      if (!result.ok) return result;
      if (result.data.revision !== task.revision) onChange(result.data.revision);
      task = result.data;
      const receipt = reviewModeReceipt(result.data);
      onReviewMode?.(receipt);
      return { ok: true, data: receipt };
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
      if (result.ok) {
        task = { ...task, status: "in_progress" };
        onChange(task.revision);
      }
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
    const editsBrief = ["description", "criteria"].some(key => Object.hasOwn(fields, key));
    const otherRequirements = ["title", "questions", "subtasks", "dependencies", "expertId"].some(key => Object.hasOwn(fields, key));
    if ((task.closedAt && (editsBrief || otherRequirements)) || (task.status === "review" && otherRequirements)) {
      return cliFailure("REQUIREMENTS_LOCKED", "This field is locked for the current task status.");
    }
    const revision = task.revision;
    const result = await callCli<Task>(project, ["update", task.id], {
      ...fields, actor: "user", note: fields.note ?? authorization, revision, preserveStatus: true,
      ...(editsBrief && (ownerChatSequence > 0 || task.status !== "draft") ? { ownerChatSequence, authorization } : {}),
    });
    if (!result.ok) return result;
    task = result.data;
    const changed = task.revision !== revision;
    if (changed) onChange(task.revision);
    return { ok: true as const, data: { id: task.id, title: task.title, status: task.status, revision: task.revision,
      changed, summary: task.summary, nextStep: task.nextStep, git: task.git, result: task.result } };
  };
}
