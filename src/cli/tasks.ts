import { isDeepStrictEqual } from "node:util";
import {
  member, nextScheduledRun, number, object, priorities, reasoningEffortPattern, record, requireRevision, requireState, scheduleTimePattern, strings, taskIdPattern,
  TaskboardError, text, validScheduleDate, validDueDate,
} from "./model.ts";
import { codexThreadPattern } from "./model.ts";
import type { Actor, Task, TaskScheduleRule, TaskState } from "./model.ts";
import { taskWorkingDirectory } from "./storage.ts";
import { taskQuestionAudience } from "./task-messages.ts";

const activeStates = ["draft", "ready", "in_progress", "blocked", "review"] as const;

function fields(task: Task, input: Record<string, unknown>): Task {
  const updated = { ...task };
  if (input.expertId !== undefined) {
    requireState(task, ["draft", "ready"]);
    if (input.expertId === null) delete updated.expertId;
    else updated.expertId = text(input.expertId, "expert ID", true);
  }
  if (input.title !== undefined) updated.title = text(input.title, "title", true);
  if (input.description !== undefined) updated.description = text(input.description, "description");
  for (const key of ["criteria", "questions", "tags"] as const) {
    if (input[key] !== undefined) updated[key] = strings(input[key], key);
  }
  if (input.priority !== undefined) updated.priority = member(input.priority, priorities, "priority");
  if (input.dueDate !== undefined) {
    if (input.dueDate === null) delete updated.dueDate;
    else {
      if (!validDueDate(input.dueDate)) throw new TaskboardError("INVALID_INPUT", "dueDate must be a calendar date in YYYY-MM-DD format.");
      updated.dueDate = input.dueDate;
    }
  }
  if (input.schedule !== undefined) {
    requireState(task, ["draft", "ready", "blocked"]);
    if (input.schedule === null) delete updated.schedule;
    else {
      if (task.expertTeam?.work?.stages.some(stage => stage.artifactOutputs)) {
        throw new TaskboardError("INVALID_INPUT", "Remove required submission artifacts from the work plan before making this task recurring.");
      }
      const schedule = object(input.schedule);
      let rule: TaskScheduleRule;
      if (schedule.everyMinutes !== undefined) {
        if (schedule.time !== undefined || schedule.weekday !== undefined || schedule.dayOfMonth !== undefined || schedule.month !== undefined) {
          throw new TaskboardError("INVALID_INPUT", "Choose a recurring interval or a time of day.");
        }
        rule = { everyMinutes: number(schedule.everyMinutes, "everyMinutes", 1) };
      } else {
        const time = text(schedule.time, "schedule time", true);
        if (!scheduleTimePattern.test(time)) throw new TaskboardError("INVALID_INPUT", "Use a schedule time in HH:MM format.");
        if (schedule.dayOfMonth !== undefined || schedule.month !== undefined) {
          const dayOfMonth = number(schedule.dayOfMonth, "dayOfMonth", 1);
          const month = schedule.month === undefined ? undefined : number(schedule.month, "month", 1);
          if (schedule.weekday !== undefined || !validScheduleDate(dayOfMonth, month)) {
            throw new TaskboardError("INVALID_INPUT", "Choose a valid calendar day for the recurring task.");
          }
          rule = { time, dayOfMonth, month };
        } else {
          const weekday = schedule.weekday === undefined ? undefined : number(schedule.weekday, "weekday", 0);
          if (weekday !== undefined && weekday > 6) throw new TaskboardError("INVALID_INPUT", "Use a weekday from 0 to 6.");
          rule = { time, weekday };
        }
      }
      const previous = task.schedule;
      if (previous?.time !== rule.time || previous?.weekday !== rule.weekday || previous?.everyMinutes !== rule.everyMinutes ||
          previous?.dayOfMonth !== rule.dayOfMonth || previous?.month !== rule.month) {
        updated.schedule = { ...rule, nextAt: nextScheduledRun(rule, new Date()), ...(previous?.paused ? { paused: true } : {}) };
      }
    }
  }
  if (input.schedulePaused !== undefined) {
    if (typeof input.schedulePaused !== "boolean" || !updated.schedule) {
      throw new TaskboardError("INVALID_INPUT", "schedulePaused requires a boolean and an existing schedule.");
    }
    updated.schedule = { ...updated.schedule, paused: input.schedulePaused,
      ...(updated.schedule.paused && !input.schedulePaused ? { nextAt: nextScheduledRun(updated.schedule, new Date()) } : {}) };
  }
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
  if (input.workingDirectory !== undefined) {
    requireState(task, ["draft", "ready"]);
    if (task.git || task.codexThreadId || task.history.some(event => event.action === "start")) {
      throw new TaskboardError("INVALID_TRANSITION", "Choose the working directory before starting the task.");
    }
    if (input.workingDirectory === null) delete updated.workingDirectory;
    else updated.workingDirectory = taskWorkingDirectory(text(input.workingDirectory, "working directory", true));
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

export function actorFor(input: Record<string, unknown>, fallback: "agent" | "user"): "agent" | "user" {
  return input.actor === undefined ? fallback : member(input.actor, ["agent", "user"], "actor");
}

export function boardActor(input: Record<string, unknown>, fallback: "agent" | "user" = "agent"): "agent" | "user" | "manager" {
  return input.actor === "manager" ? "manager" : actorFor(input, fallback);
}

function goalInstance(input: Record<string, unknown>): string | undefined {
  const id = input.managerGoalId;
  if (id === undefined) return;
  if (input.actor !== "manager" || typeof id !== "string" || !codexThreadPattern.test(id)) {
    throw new TaskboardError("INVALID_INPUT", "Expected the saved goal ID for a goal task.");
  }
  return id;
}

export function createTask(id: string, input: Record<string, unknown>): Task {
  if (input.actor === "manager" &&
      (!Array.isArray(input.tags) || input.tags.length === 0 ||
        input.tags.some(tag => typeof tag !== "string" || !tag.trim()))) {
    throw new TaskboardError("TASK_TAGS_REQUIRED", "Supply at least one non-blank tag name in tags, then retry task_create.");
  }
  const now = new Date().toISOString();
  const managerGoalId = goalInstance(input);
  const goalThreadId = input.goalThreadId === undefined ? undefined : text(input.goalThreadId, "goalThreadId", true);
  if (goalThreadId && (input.actor !== "manager" || !codexThreadPattern.test(goalThreadId))) {
    throw new TaskboardError("INVALID_INPUT", "Expected the manager chat ID for a goal task.");
  }
  return fields({
    id,
    title: text(input.title, "title", true),
    description: "", criteria: [], questions: [], tags: [], priority: "normal", subtasks: [], attachments: [],
    status: "draft", revision: 1, createdAt: now, updatedAt: now, summary: "", nextStep: "",
    ...(goalThreadId ? { goalThreadId } : {}),
    ...(managerGoalId ? { managerGoalId } : {}),
    history: [{ at: now, actor: boardActor(input), action: "create" }],
  }, input);
}

export function parseRunEntries(value: unknown) {
  if (!Array.isArray(value) || !value.length || Buffer.byteLength(JSON.stringify(value)) > 1_000_000) {
    throw new TaskboardError("INVALID_INPUT", "Expected a run log of at most 1 MB.");
  }
  return value.map(value => {
    const item = object(value);
    if (typeof item.text !== "string") throw new TaskboardError("INVALID_INPUT", "Expected item text.");
    if (item.at !== undefined && (typeof item.at !== "string" || !item.at.trim() || !Number.isFinite(Date.parse(item.at)))) {
      throw new TaskboardError("INVALID_INPUT", "Expected a valid item timestamp.");
    }
    for (const key of ["threadId", "stageSessionId"]) {
      const id = item[key];
      if (id !== undefined && (typeof id !== "string" || !codexThreadPattern.test(id))) {
        throw new TaskboardError("INVALID_INPUT", "Expected a valid run item " + key + ".");
      }
    }
    if (item.stageChild !== undefined && (item.stageChild !== true || !item.threadId || !item.stageSessionId)) {
      throw new TaskboardError("INVALID_INPUT", "A specialist activity item requires a thread and stage session.");
    }
    return {
      ...(item.at === undefined ? {} : { at: item.at as string }),
      ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
      ...(typeof item.stageSessionId === "string" ? { stageSessionId: item.stageSessionId } : {}),
      ...(item.stageChild === true ? { stageChild: true as const } : {}),
      id: text(item.id, "item ID", true), type: text(item.type, "item type", true),
      title: text(item.title, "item title"), text: item.text, status: text(item.status, "item status"),
      ...(item.phase === undefined ? {} : { phase: member(item.phase, ["commentary", "final_answer"], "item phase") }),
    };
  });
}

export function recordRunLog(task: Task, input: Record<string, unknown>): Task {
  if (task.status === "done" || task.status === "cancelled") return task;
  const updated = record(task, "run-log", "agent");
  const event = updated.history.at(-1)!;
  event.run = parseRunEntries(input.entries);
  if (input.runThreadId !== undefined) {
    const id = input.runThreadId;
    if (typeof id !== "string" || !codexThreadPattern.test(id)) {
      throw new TaskboardError("INVALID_INPUT", "Expected a valid Codex thread ID for the run log.");
    }
    event.runThreadId = id;
  }
  if (input.durationMs !== undefined) updated.history.at(-1)!.durationMs = number(input.durationMs, "durationMs", 0);
  return { ...updated, revision: task.revision, closedAt: task.closedAt };
}

export function withoutVerification(task: Task): Task {
  if (!task.result?.checks.length && !task.result?.limitations.length && !task.history.some(event => event.run)) return task;
  return {
    ...task,
    result: task.result && { ...task.result, checks: [], limitations: [] },
    // Keep event positions for linked messages and keep the chat itself.
    history: task.history.map(event => event.action === "run-log" ? { ...event, run: undefined } : event),
  };
}

export function changeTask(task: Task, action: string, input: Record<string, unknown>): Task {
  requireRevision(task, input.revision);
  if (action === "return-to-draft") {
    requireState(task, [...activeStates, "done", "cancelled"]);
    if (task.status === "draft") return task;
    requireRevision(task, input.revision, true);
    const draft = record(task, action, boardActor(input, "user"), "draft");
    delete draft.closedAt;
    delete draft.blocked;
    delete draft.acceptanceRepair;
    delete draft.launchRequested;
    if (task.status === "done") {
      delete draft.git;
      delete draft.codexArchivePending;
    }
    return draft;
  }
  if (action === "comment" && task.status === "done") {
    return { ...record(task, action, boardActor(input), task.status, text(input.text, "text", true)), closedAt: task.closedAt };
  }
  requireState(task, activeStates);
  switch (action) {
    case "approve": {
      requireState(task, ["draft"]);
      const questionAudience = taskQuestionAudience(task);
      if (task.awaitingAnswer === true || questionAudience) {
        throw new TaskboardError("TASK_AWAITING_ANSWER", "Finish the clarification in the task dialogue before approving the draft.", {
          questionAudience,
        });
      }
      if (boardActor(input, "user") !== "user" &&
          task.history.findLast(event => event.action === "approve" || event.action === "return-to-draft")?.action === "return-to-draft") {
        throw new TaskboardError("USER_APPROVAL_REQUIRED", "The user must approve this returned draft on the board.");
      }
      if (!task.criteria.length) {
        throw new TaskboardError("CRITERIA_REQUIRED", "Add acceptance criteria before approving the task.");
      }
      const managerGoalId = goalInstance(input);
      const approved = record(task, action, boardActor(input, "user"), "ready");
      return managerGoalId ? { ...approved, managerGoalId } : approved;
    }
    case "request-changes":
      requireState(task, ["review"]);
      return record(task, action, input.actor === "reviewer" ? "reviewer" : boardActor(input, "user"),
        "in_progress", text(input.reason, "reason", true));
    case "pause":
      requireState(task, ["in_progress"]);
      return record(task, action, "agent", "ready");
    case "cancel":
      return record(task, action, boardActor(input, "user"), "cancelled", text(input.reason, "reason", true));
    case "comment":
      return record(task, action, boardActor(input), task.status, text(input.text, "text", true));
    case "checklist": {
      requireState(task, task.acceptanceRepair?.phase === "running" ? ["review"] : ["in_progress"]);
      requireRevision(task, input.revision, true);
      const index = number(input.index, "checklist item number") - 1;
      const item = task.subtasks[index];
      if (!item || typeof input.done !== "boolean") throw new TaskboardError("INVALID_INPUT", "Select an existing checklist item and supply its completed state.");
      if (item.done === input.done) return task;
      const subtasks = task.subtasks.slice();
      subtasks[index] = { ...item, done: input.done };
      return record({ ...task, subtasks }, action, "agent", task.status, item.title);
    }
    case "progress": {
      requireState(task, task.acceptanceRepair?.phase === "running" ? ["review"] : ["in_progress", "blocked"]);
      const summary = text(input.summary, "summary", true);
      const nextStep = input.nextStep === undefined ? task.nextStep : text(input.nextStep, "nextStep");
      const status = task.schedule && task.status === "in_progress" ? "ready" : task.status;
      return record({ ...task, summary, nextStep }, action, "agent", status, summary);
    }
    case "block": {
      if (task.acceptanceRepair && task.status === "review") {
        const reason = text(input.reason, "reason", true);
        return record({ ...task, acceptanceRepair: { ...task.acceptanceRepair, phase: "failed", reason } }, "acceptance-failed", "agent", "review", reason);
      }
      requireState(task, input.allowUnstarted === true ? ["draft", "ready", "in_progress"] : ["in_progress"]);
      const reason = text(input.reason, "reason", true);
      const condition = text(input.condition, "condition", true);
      const previousStatus = task.status === "draft" || task.status === "ready" ? task.status : undefined;
      const retryExecutor = input.retryExecutor === true ? true : undefined;
      const unconfirmedTurn = input.unconfirmedTurn === true ? true : undefined;
      return record({ ...task, blocked: { reason, condition, previousStatus, retryExecutor, unconfirmedTurn } }, action, boardActor(input), "blocked", reason);
    }
    case "resume":
    case "unblock": {
      requireState(task, ["blocked"]);
      const { blocked, ...rest } = task;
      const status = blocked?.previousStatus ?? (action === "resume" ? "in_progress" : "ready");
      const updated = action === "unblock" && input.dependencies !== undefined
        ? fields({ ...rest, status }, { dependencies: input.dependencies }) : rest;
      return record({ ...updated, status: task.status }, action, boardActor(input), status, text(input.reason, "reason", true));
    }
    case "update": {
      const updated = fields(task, input);
      if (input.codexThreadId !== undefined) {
        const id = text(input.codexThreadId, "codexThreadId", true);
        const replacing = input.actor === "user" && input.previousCodexThreadId === task.codexThreadId;
        if (!codexThreadPattern.test(id) || (task.codexThreadId && task.codexThreadId !== id && !replacing)) {
          throw new TaskboardError("INVALID_INPUT", "Expected a valid Codex thread ID for this task.");
        }
        updated.codexThreadId = id;
      }
      const actor = boardActor(input);
      const requirementsChanged = updated.description !== task.description ||
        JSON.stringify(updated.criteria) !== JSON.stringify(task.criteria);
      const source = input.ownerChatSequence;
      if (source !== undefined) {
        requireRevision(task, input.revision, true);
        const latest = task.history.findLastIndex(event => event.action === "chat" && event.actor === "user");
        const authorization = text(input.authorization, "owner authorization", true);
        if (actor !== "user" || latest < 0 || source !== latest + 1 ||
            !task.history[latest].text?.includes(authorization)) {
          throw new TaskboardError("USER_DIRECTION_REQUIRED", "Use the current owner message to change the task brief.");
        }
        if (requirementsChanged && task.history.some(event => event.ownerBriefSource === source)) {
          throw new TaskboardError("USER_DIRECTION_REQUIRED", "This owner message has already been applied to the brief.");
        }
      }
      let status: TaskState = task.status;
      let note = input.note === undefined ? undefined : text(input.note, "note", true);
      if (requirementsChanged && task.status !== "draft") {
        if (actor === "agent") {
          throw new TaskboardError("USER_REQUIREMENTS_REQUIRED", "Approved requirements change only on explicit user direction.");
        }
        if (!updated.criteria.length) {
          throw new TaskboardError("CRITERIA_REQUIRED", "An approved task needs acceptance criteria.");
        }
        note = text(input.note, "note", true);
        if (status === "review") {
          if (source === undefined) status = "ready";
          else updated.acceptanceWait = undefined;
        }
      }
      if (input.preserveStatus === true && status !== task.status) {
        throw new TaskboardError("STATUS_CHANGE_REQUIRED", "These requirements would reopen the task. Ask the user to apply the changes on the board.");
      }
      if (input.preserveStatus === true && isDeepStrictEqual(updated, task)) return task;
      const result = record(updated, action, actor, status, note);
      if (requirementsChanged && typeof source === "number") {
        result.history.at(-1)!.ownerBriefSource = source;
        if (task.status === "review") {
          const index = task.history.findLastIndex(event => event.action === "submit" && event.to === "review");
          const submission = result.history[index];
          if (submission && !submission.submissionBrief) {
            result.history[index] = { ...submission, submissionBrief: {
              title: task.title, description: task.description, criteria: [...task.criteria],
            } };
          }
        }
      }
      if (task.codexThreadId && task.codexThreadId !== updated.codexThreadId) {
        result.history.at(-1)!.previousCodexThreadId = task.codexThreadId;
      }
      return result;
    }
    default:
      throw new TaskboardError("UNKNOWN_COMMAND", "Unknown task action " + action + ".");
  }
}
