import localization from "../desktop/localization.cjs";
import { member, number, requireState, taskIdPattern, taskReviewModeVersion, TaskboardError, text } from "./model.ts";
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

export function draftManagerQuestion(task: Task, sequence: number | undefined) {
  const event = sequence === undefined ? undefined : task.history[sequence - 1];
  return task.status === "draft" && event?.action === "coordination" && event.actor === "agent" && event.messageKind === "question" &&
    event.expertMessage?.to === "manager" ? event.expertMessage : undefined;
}

export function linkedDraftManagerReply(task: Task, event: TaskEvent | undefined) {
  if (!event || event.action !== "coordination" || event.messageKind === "question") return;
  const mail = event.expertMessage;
  if (mail?.from !== "manager" || mail.replyTo === undefined ||
      draftManagerQuestion(task, mail.replyTo)?.from !== mail.to ||
      deferredDependencyReply(task, mail.replyTo, event)) return;
  return { text: event.text, replyTo: mail.replyTo, question: task.history[mail.replyTo - 1].text };
}

export function draftManagerReply(task: Task, sequence: number, to: string) {
  return task.history.findIndex(event => event.expertMessage?.from === "manager" &&
    event.expertMessage.to === to && event.expertMessage.replyTo === sequence &&
    event.messageKind !== "question" && !deferredDependencyReply(task, sequence, event)) + 1;
}

export function pendingDraftDependency(task: Task, question: number) {
  const transition = task.history.findLastIndex(event => event.to !== undefined);
  if (question <= transition + 1) return;
  return task.history.findLast(event => event.draftDependency?.question === question &&
    event.draftDependency.subject)?.draftDependency;
}

export function draftDependencySubject(message: string | undefined) {
  return /^(?:Обязательная зависимость|Required dependency): ([^\s«»"\r\n][^«»"\r\n]{0,199})$/u.exec(message ?? "")?.[1].trimEnd();
}

export function draftDependencyRequest(task: Task, sequence: number) {
  const message = task.history[sequence - 1]?.text;
  const subject = draftDependencySubject(message);
  if (subject) return { subject, legacy: false };

  const legacy = /^Владелец выбрал отдельную карточку по ([^.\r\n]+)\./u.exec(message ?? "");
  if (legacy && message?.includes("как обязательную зависимость")) {
    const topic = legacy[1].replace(/^уч[её]ту /u, "учёт ");
    if (draftDependencyDecision(task, topic, true, sequence).sequence) return { subject: topic, legacy: true };
  }
}

function deferredDependencyReply(task: Task, sequence: number, event: TaskEvent) {
  return !event.draftDependencyId && event.text?.includes("ID отдельной карточки неизвестен.") &&
    event.text.includes("В этом сеансе нет инструментов для поиска, создания и связывания карточек.") &&
    draftDependencyRequest(task, sequence)?.legacy === true;
}

export function matchesDraftDependency(subject: string, task: Pick<Task, "id" | "title">, legacy = false) {
  if (legacy && subject === "учёт управляемой кучи") {
    const title = task.title.toLowerCase();
    return /^(?:(?:подключить|добавить) уч[её]т управляемой кучи|уч[её]т управляемой кучи)(?:$| )/u.test(title) ||
      /^подключить управляемую кучу к общему сч[её]тчику памяти(?:$| )/u.test(title);
  }
  return taskIdPattern.test(subject) ? task.id === subject : task.title === subject;
}

export function draftDependencyDecision(task: Task, subject: string, legacy = false, before = task.history.length + 1) {
  const transition = task.history.findLastIndex(event => event.to !== undefined);
  let previousChat: TaskEvent | undefined;
  let sequence = 0;
  let cancellation = 0;
  for (let index = transition + 1; index < task.history.length; index++) {
    const event = task.history[index];
    if (!event.chat || event.action !== "chat") continue;
    if (event.actor === "user") {
      const latestText = event.text ?? "";
      const legacyQuestion = legacy && previousChat?.actor === "agent"
        ? /(?:^|[.!?] )Как (?:оформляем|оформить) (.+?) [—–-] отдельной карточкой, которую нужно завершить до сдачи (T-\d+), или прямо в (T-\d+)\?$/u.exec(previousChat.text ?? "")
        : null;
      const answeredLegacy = legacyQuestion?.[1] === subject && legacyQuestion[2] === task.id &&
        legacyQuestion[3] === task.id && /^отдельной ?карточкой$/iu.test(latestText);
      const answeredChoice = previousChat?.actor === "agent" &&
        ((previousChat.text === `Вынести «${subject}» в отдельную обязательную зависимость? Ответьте «отдельной карточкой» или «в этой задаче».` &&
          /^(?:отдельной карточкой|в этой задаче)$/iu.test(latestText)) ||
         (previousChat.text === `Make "${subject}" a separate required dependency? Reply "separate card" or "in this task".` &&
          /^(?:separate card|in this task)$/iu.test(latestText)));
      if (answeredChoice || answeredLegacy || draftDependencySubject(latestText) === subject) {
        if (/^(?:в этой задаче|in this task)$/iu.test(latestText)) {
          cancellation = index + 1;
        } else if (index + 1 < before) {
          sequence = index + 1;
        }
      } else if (latestText === `Отменить обязательную зависимость: ${subject}` ||
          latestText === `Cancel required dependency: ${subject}`) {
        cancellation = index + 1;
      }
    }
    previousChat = event;
  }
  return { sequence, cancellation };
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
    const question = message && recipient === "manager" ? draftManagerQuestion(task, index + 1) : undefined;
    if (question && draftManagerReply(task, index + 1, question.from)) return [];
    return [{
      id: task.id, title: task.title, sequence: index + 1, at: event.at, status: task.status,
      ...(event.expertMessage ? { expertMessage: event.expertMessage } : {}),
      ...(question ? { draftQuestion: true as const,
        ...(pendingDraftDependency(task, index + 1) ? { draftDependencyPending: true as const } : {}) } : {}),
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
  return tasks.flatMap(task => taskMessages(task, "manager").filter(message =>
    message.draftQuestion || message.sequence > (task.managerReadThrough ?? 0)))
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
