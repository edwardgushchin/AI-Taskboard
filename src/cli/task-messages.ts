import localization from "../desktop/localization.cjs";
import { member, number, requireState, taskReviewModeVersion, TaskboardError, text } from "./model.ts";
import type { BoardSettings, Task, TaskEvent } from "./model.ts";

export function statusNotice(task: Task, event: TaskEvent, language: string | boolean = true) {
  if (event.actor === "user") return;
  if (!event.from || !event.to || event.from === event.to) return;
  const locale = typeof language === "boolean" ? (language ? "ru" : "en") : language;
  const t = (key: string, parameters = {}) => localization.text(key, parameters, locale);
  // Acceptance stores a Git SHA in event.text, not a user-facing outcome.
  if (event.mergedInto) {
    const target = event.mergedInto;
    return t("status.merged", { p0: task.id, p1: task.title, p2: target.id, p3: target.title, p4: target.transferred });
  }
  const detail = event.action === "accept" ? task.result?.summary :
    ["block", "submit", "progress", "request-changes"].includes(event.action) ? event.text : undefined;
  return `${task.id} «${task.title}» — ${t("status." + event.to)}${detail?.trim() ? ": " + detail.trim() : "."}`;
}

export function executorOutcome(event: TaskEvent | undefined) {
  return event?.actor === "agent" && ["submit", "block", "progress", "pause"].includes(event.action);
}

function reviewerAcceptance(event: TaskEvent | undefined) {
  return event?.actor === "reviewer" && event.action === "accept" && event.to === "done";
}

function reviewerReturn(event: TaskEvent | undefined) {
  return event?.actor === "reviewer" && event.action === "request-changes";
}

export function currentReviewApproval(task: Task, settings?: Pick<BoardSettings, "reviewModeVersion">) {
  if (task.status !== "review") return;
  return task.history.findLast(event => event.actor === "reviewer" && event.action === "review-approve" &&
    event.reviewApproval?.revision === task.revision &&
    (!settings || event.reviewApproval.reviewModeVersion === taskReviewModeVersion(task, settings)));
}

export function taskMessages(task: Task, recipient: "manager" | "agent") {
  const lifecycle = task.history.findLastIndex(event => event.to !== undefined || executorOutcome(event));
  const approval = recipient === "manager" ? currentReviewApproval(task) : undefined;
  const latestSubmissionEvent = recipient === "manager" && !["done", "cancelled"].includes(task.status)
    ? task.history.findLastIndex(event => ["submit", "request-changes", "return-to-draft"].includes(event.action)) : -1;
  return task.history.flatMap((event, index) => {
    if (event.expertMessage && (recipient !== "manager" || event.expertMessage.from === "manager" ||
        event.expertMessage.from !== "owner" && !["manager", "owner", "team"].includes(event.expertMessage.to))) return [];
    const message = event.action === "coordination" && (event.expertMessage ? recipient === "manager" : event.actor === (recipient === "manager" ? "agent" : "manager"));
    const outcome = recipient === "manager" && index === lifecycle && executorOutcome(event);
    const accepted = recipient === "manager" && index === lifecycle && reviewerAcceptance(event);
    const returned = index === latestSubmissionEvent && reviewerReturn(event);
    if (!message && !outcome && !accepted && !returned && event !== approval) return [];
    if (outcome && event.action === "submit" && approval) return [];
    return [{
      id: task.id, title: task.title, sequence: index + 1, at: event.at, status: task.status,
      ...(event.expertMessage ? { expertMessage: event.expertMessage } : {}),
      kind: message ? event.messageKind ?? "update" : event.action, replyTo: event.replyToMessage,
      text: accepted ? task.result?.summary : event.text, ...(outcome && event.action === "submit" ? { result: task.result } : {}),
      ...(accepted ? { actor: "reviewer" as const, target: task.git?.target, commit: task.git?.accepted } : {}),
      ...(event === approval || returned ? { actor: "reviewer" as const, target: task.git?.target } : {}),
      ...(outcome && event.action === "block" ? { blocked: task.blocked } : {}),
      ...(outcome && event.action === "progress" ? { nextStep: task.nextStep } : {}),
    }];
  });
}

export function needsManagerAttention(kind: string) {
  return kind === "question" || kind === "decision" || kind === "block" || kind === "submit" || kind === "accept" ||
    kind === "review-approve" || kind === "request-changes";
}

export function managerInbox(tasks: Task[]) {
  return tasks.flatMap(task => taskMessages(task, "manager").filter(message => message.sequence > (task.managerReadThrough ?? 0)))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id) || left.sequence - right.sequence);
}

export function sendTaskMessage(task: Task, input: Record<string, unknown>, sender: "manager" | "agent"): Task {
  requireState(task, sender === "manager" ? ["ready", "in_progress", "blocked", "review"] : ["in_progress", "blocked", "review"]);
  const message = text(input.text, "text", true);
  if (message.length > 4000) throw new TaskboardError("INVALID_INPUT", "Keep coordination messages within 4000 characters.");
  const kind = input.kind === undefined ? "update" : member(input.kind, ["question", "update", "decision"], "kind");
  const replyTo = input.replyTo === undefined ? undefined : number(input.replyTo, "replyTo", 1);
  if (replyTo !== undefined && !taskMessages(task, sender).some(message => message.sequence === replyTo)) {
    throw new TaskboardError("INVALID_INPUT", "Reply to a message addressed to you on this card.");
  }
  // Communication does not change the work specification or invalidate a Git preview.
  return { ...task, history: [...task.history, { at: new Date().toISOString(), action: "coordination",
    actor: sender, text: message, messageKind: kind, replyToMessage: replyTo }] };
}

export function acknowledgeTaskMessages(task: Task, input: Record<string, unknown>): Task {
  const through = number(input.through, "through", 1);
  if (through <= (task.managerReadThrough ?? 0)) return task;
  const event = task.history[through - 1];
  if (!(event?.action === "coordination" && (event.actor === "agent" || event.actor === "reviewer" || event.expertMessage?.from === "owner")) && !executorOutcome(event) && !reviewerAcceptance(event) &&
      !reviewerReturn(event) && !(event?.action === "review-approve" && event.actor === "reviewer")) {
    throw new TaskboardError("INVALID_INPUT", "Acknowledge an existing inbox message.");
  }
  return { ...task, managerReadThrough: through };
}
