import {
  member, object, priorities, reasoningEffortPattern, record, requireRevision, requireState, strings, taskIdPattern,
  TaskboardError, text,
} from "./model.ts";
import { codexThreadPattern } from "./model.ts";
import type { Actor, Task, TaskState } from "./model.ts";

const activeStates = ["draft", "ready", "in_progress", "blocked", "review"] as const;

function fields(task: Task, input: Record<string, unknown>): Task {
  const updated = { ...task };
  if (input.title !== undefined) updated.title = text(input.title, "title", true);
  if (input.description !== undefined) updated.description = text(input.description, "description");
  for (const key of ["criteria", "questions", "tags"] as const) {
    if (input[key] !== undefined) updated[key] = strings(input[key], key);
  }
  if (input.priority !== undefined) updated.priority = member(input.priority, priorities, "priority");
  if (input.dependencies !== undefined) {
    requireState(task, ["draft", "ready"]);
    const dependencies = [...new Set(strings(input.dependencies, "dependencies"))];
    if (dependencies.some(id => !taskIdPattern.test(id))) {
      throw new TaskboardError("INVALID_INPUT", "Dependencies must be task IDs.");
    }
    if (dependencies.length) updated.dependencies = dependencies;
    else delete updated.dependencies;
  }
  if (input.execution !== undefined) {
    requireState(task, ["draft", "ready"]);
    if (input.execution === null) {
      delete updated.execution;
    } else {
      const execution = object(input.execution);
      const model = text(execution.model, "model", true);
      const effort = execution.effort === undefined ? undefined : text(execution.effort, "effort", true);
      if (effort && !reasoningEffortPattern.test(effort)) {
        throw new TaskboardError("INVALID_INPUT", "Invalid reasoning effort.");
      }
      updated.execution = { model, effort };
    }
  }
  if (input.subtasks !== undefined) {
    if (!Array.isArray(input.subtasks)) throw new TaskboardError("INVALID_INPUT", "subtasks must be an array.");
    updated.subtasks = input.subtasks.map(item => {
      const entry = object(item);
      if (entry.done !== undefined && typeof entry.done !== "boolean") {
        throw new TaskboardError("INVALID_INPUT", "subtask done must be a boolean.");
      }
      return { title: text(entry.title, "subtask title", true), done: entry.done === true };
    });
  }
  return updated;
}

export function actorFor(input: Record<string, unknown>, fallback: Actor): Actor {
  return input.actor === undefined ? fallback : member(input.actor, ["agent", "user"], "actor");
}

export function createTask(id: string, input: Record<string, unknown>): Task {
  const now = new Date().toISOString();
  return fields({
    id,
    title: text(input.title, "title", true),
    description: "", criteria: [], questions: [], tags: [], priority: "normal", subtasks: [], attachments: [],
    status: "draft", revision: 1, createdAt: now, updatedAt: now, summary: "", nextStep: "",
    history: [{ at: now, actor: actorFor(input, "agent"), action: "create" }],
  }, input);
}

export function changeTask(task: Task, action: string, input: Record<string, unknown>): Task {
  requireRevision(task, input.revision);
  requireState(task, activeStates);
  switch (action) {
    case "approve":
      requireState(task, ["draft"]);
      if (!task.criteria.length) {
        throw new TaskboardError("CRITERIA_REQUIRED", "Add acceptance criteria before approving the task.");
      }
      return record(task, action, "user", "ready");
    case "return-to-draft":
      requireState(task, ["ready"]);
      return record(task, action, "user", "draft");
    case "request-changes":
      requireState(task, ["review"]);
      return record(task, action, "user", "ready", text(input.reason, "reason", true));
    case "pause":
      requireState(task, ["in_progress"]);
      return record(task, action, "agent", "ready");
    case "cancel":
      return record(task, action, "user", "cancelled", text(input.reason, "reason", true));
    case "comment":
      return record(task, action, actorFor(input, "agent"), task.status, text(input.text, "text", true));
    case "progress": {
      requireState(task, ["in_progress", "blocked"]);
      const summary = text(input.summary, "summary", true);
      const nextStep = input.nextStep === undefined ? task.nextStep : text(input.nextStep, "nextStep");
      return record({ ...task, summary, nextStep }, action, "agent", task.status === "blocked" ? "blocked" : "ready", summary);
    }
    case "block": {
      requireState(task, ["in_progress"]);
      const reason = text(input.reason, "reason", true);
      const condition = text(input.condition, "condition", true);
      return record({ ...task, blocked: { reason, condition } }, action, "agent", "blocked", reason);
    }
    case "resume": {
      requireState(task, ["blocked"]);
      const { blocked: _blocked, ...rest } = task;
      return record(rest, action, "agent", "in_progress", text(input.reason, "reason", true));
    }
    case "update": {
      const updated = fields(task, input);
      if (input.codexThreadId !== undefined) {
        const id = text(input.codexThreadId, "codexThreadId", true);
        if (!codexThreadPattern.test(id) || (task.codexThreadId && task.codexThreadId !== id)) {
          throw new TaskboardError("INVALID_INPUT", "Expected a valid Codex thread ID for this task.");
        }
        updated.codexThreadId = id;
      }
      const actor = actorFor(input, "agent");
      const requirementsChanged = updated.description !== task.description ||
        JSON.stringify(updated.criteria) !== JSON.stringify(task.criteria);
      let status: TaskState = task.status;
      let note = input.note === undefined ? undefined : text(input.note, "note", true);
      if (requirementsChanged && task.status !== "draft") {
        if (actor !== "user") {
          throw new TaskboardError("USER_REQUIREMENTS_REQUIRED", "Approved requirements change only on explicit user direction.");
        }
        if (!updated.criteria.length) {
          throw new TaskboardError("CRITERIA_REQUIRED", "An approved task needs acceptance criteria.");
        }
        note = text(input.note, "note", true);
        if (status === "review") status = "ready";
      }
      if (input.preserveStatus === true && status !== task.status) {
        throw new TaskboardError("STATUS_CHANGE_REQUIRED", "These requirements would reopen the task. Ask the user to apply the changes on the board.");
      }
      return record(updated, action, actor, status, note);
    }
    default:
      throw new TaskboardError("UNKNOWN_COMMAND", "Unknown task action " + action + ".");
  }
}
