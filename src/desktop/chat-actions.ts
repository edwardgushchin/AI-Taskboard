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

const actions = {
  update: {
    description: "Edit only the requested fields. Lists replace existing lists.",
    fields: {
      title: string, description: string, criteria: strings, questions: strings, tags: strings, dependencies: strings,
      priority: { ...string, enum: priorities }, note: string,
      subtasks: { type: "array", items: {
        type: "object", properties: { title: string, done: boolean }, required: ["title"], additionalProperties: false,
      } },
    },
  },
  approve: { description: "Approve the draft so it is ready to start." },
  start: { description: "Prepare the task worktree. To reopen a conflicting review, pass resolveConflicts.",
    fields: { target: string, resolveConflicts: boolean } },
  progress: { description: "Record progress and the next step.", fields: { summary: string, nextStep: string }, required: ["summary"] },
  block: { description: "Record a blocker and its resumption condition.",
    fields: { reason: string, condition: string }, required: ["reason", "condition"] },
  resume: { description: "Resume a blocked task.", fields: { reason: string }, required: ["reason"] },
  preview: { description: "Read the exact Git snapshot and token before submitting.", readOnly: true },
  submit: { description: "Submit the previewed snapshot. Report only checks that actually ran.",
    fields: { token: string, message: string, summary: string, checks: strings, limitations: strings },
    required: ["token", "message", "summary", "checks"] },
  review: { description: "Read the submitted diff, status, and target revision before accepting.", readOnly: true },
  accept: { description: "Accept the submitted result. Read the review first and pass its targetHead. Optionally verify an existing acceptance commit.",
    fields: { targetHead: string, message: string, commit: string }, required: ["targetHead"] },
  "request-changes": { description: "Return a submitted task for changes with the user's feedback.",
    fields: { reason: string }, required: ["reason"] },
  cancel: { description: "Cancel the task with the user's reason.", fields: { reason: string }, required: ["reason"] },
} satisfies Record<string, { description: string; fields?: object; required?: string[]; readOnly?: boolean }>;

const tools = new Map(Object.entries(actions).map(([action, spec]) => {
  const { description, fields, required, readOnly }: {
    description: string; fields?: object; required?: string[]; readOnly?: boolean;
  } = spec;
  const properties = readOnly ? {} : { ...fields, authorization };
  return ["task_" + action.replaceAll("-", "_"), {
    action, readOnly, description, properties, required: readOnly ? [] : ["authorization", ...(required ?? [])],
  }] as const;
}));

export const chatTools = Array.from(tools, ([name, spec]) => ({
  type: "function", name, description: spec.description,
  inputSchema: { type: "object", properties: spec.properties, required: spec.required, additionalProperties: false },
}));

export function taskChatActions(project: string, initial: Task, userText: string, onChange: () => void) {
  let task = initial;
  return async (name: string, args: unknown): Promise<CliReply> => {
    const spec = tools.get(name);
    if (!spec || !args || typeof args !== "object" || Array.isArray(args)) {
      return cliFailure("INVALID_INPUT", "Unknown task action or invalid arguments.");
    }
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !Object.hasOwn(spec.properties, key)) ||
        spec.required.some(key => !Object.hasOwn(input, key))) {
      return cliFailure("INVALID_INPUT", "Use the parameters defined for this task action.");
    }
    if (spec.readOnly) return callCli(project, [spec.action, task.id]);
    const { authorization, ...fields } = input;
    if (typeof authorization !== "string" || !authorization.trim() || !userText.includes(authorization)) {
      return cliFailure("USER_DIRECTION_REQUIRED", "Only the latest user's explicit request can authorize this action.");
    }
    if (spec.action === "accept" && (typeof fields.targetHead !== "string" || !fields.targetHead.trim())) {
      return cliFailure("INVALID_INPUT", "Review the task and supply the target commit before accepting.");
    }
    if (spec.action === "update") {
      fields.actor = "user";
      fields.note ??= authorization;
    }
    const result = await callCli<Task | { task: Task }>(project, [spec.action, task.id], { ...fields, revision: task.revision });
    if (!result.ok) return result;
    task = "task" in result.data ? result.data.task : result.data;
    onChange();
    return { ok: true, data: { id: task.id, title: task.title, status: task.status, revision: task.revision,
      summary: task.summary, nextStep: task.nextStep, git: task.git, result: task.result } };
  };
}
