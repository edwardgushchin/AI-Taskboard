import { object, strings, text, number, record, requireRevision, requireState, TaskboardError } from "./model.ts";
import type { ExpertPhase, Task } from "./model.ts";
import type { BoardStore } from "./storage.ts";
import { readExpert } from "./experts.ts";
import { readTask } from "./archive.ts";
import { currentReviewApproval } from "./task-messages.ts";

export function createExpertPlan(store: BoardStore, parentId: string, input: Record<string, unknown>) {
  const parent = store.card(parentId);
  const phase = input.phase ?? "work";
  if (phase !== "work" && phase !== "review") throw new TaskboardError("INVALID_INPUT", "Unknown expert phase.");
  requireState(parent, phase === "work" ? ["draft", "ready"] : ["draft", "ready", "review"]);
  const previous = parent.expertTeam?.[phase];
  const lead = input.lead === undefined ? previous?.lead : input.lead === null ? null : text(input.lead, "lead specialization", true);
  if (lead) readExpert(store, lead);
  if (!Array.isArray(input.stages) || input.stages.length > 32)
    throw new TaskboardError("INVALID_INPUT", "Supply up to 32 assigned stages.");
  const proposed = input.stages.map(value => {
    const stage = object(value);
    const key = text(stage.key, "stage key", true);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new TaskboardError("INVALID_INPUT", "Invalid stage key.");
    const expertId = text(stage.expertId, "expert ID", true); readExpert(store, expertId);
    const criteria = strings(stage.criteria, "stage criteria");
    const outputs = strings(stage.outputs, "outputs");
    if (!criteria.length || !outputs.length) throw new TaskboardError("INVALID_INPUT", "Each stage needs criteria and outputs.");
    return { key, expertId, title: text(stage.title, "stage title", true), description: text(stage.description ?? "", "stage description"),
      criteria, inputs: strings(stage.inputs ?? [], "inputs"), outputs, dependsOn: strings(stage.dependsOn ?? [], "stage dependencies") };
  });
  const existing = previous?.stages ?? [];
  if (new Set(proposed.map(s => s.key)).size !== proposed.length) throw new TaskboardError("INVALID_INPUT", "Stage keys must be unique.");
  for (const stage of proposed) {
    const saved = existing.find(old => old.key === stage.key);
    if (saved && JSON.stringify(saved) !== JSON.stringify(stage))
      throw new TaskboardError("REVISION_CONFLICT", "This stage key already belongs to a different plan.");
  }
  const all = [...existing, ...proposed.filter(stage => !existing.some(old => old.key === stage.key))];
  if (all.length > 32) throw new TaskboardError("INVALID_INPUT", "Each phase can have at most 32 stages.");
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new TaskboardError("INVALID_INPUT", "Stage dependency cycle.");
    if (done.has(key)) return;
    const stage = all.find(s => s.key === key);
    if (!stage) throw new TaskboardError("INVALID_INPUT", "Unknown prerequisite stage: " + key);
    visiting.add(key);
    stage.dependsOn.forEach(visit);
    visiting.delete(key);
    done.add(key);
  };
  all.forEach(stage => visit(stage.key));
  const plan: ExpertPhase = { lead, stages: all };
  if (all.length === existing.length && previous?.lead === lead) return { parent, phase, ...plan };
  requireRevision(parent, input.revision, true);
  if (parent.status === "review" && (parent.acceptanceRepair || currentReviewApproval(parent)))
    throw new TaskboardError("INVALID_TRANSITION", "The submission already has a review decision or is being integrated.");
  const updated = record({ ...parent, expertTeam: { ...parent.expertTeam, [phase]: plan } }, "expert-plan", "manager");
  store.save(updated);
  return { parent: updated, phase, ...plan };
}

export function teamRoot(store: BoardStore, taskId: string) {
  const task = readTask(store, taskId);
  return task.expertStage ? readTask(store, task.expertStage.parentId) : task;
}
export function teamInbox(store: BoardStore, taskId: string, recipient: string, after = 0) {
  const parent = teamRoot(store, taskId);
  if (!["manager", "owner", "reviewer", parent.id, ...(parent.expertStages ?? []).map(s => s.taskId)].includes(recipient))
    throw new TaskboardError("INVALID_INPUT", "Unknown team recipient.");
  return { parentId: parent.id, expertTeam: parent.expertTeam, members: (parent.expertStages ?? []).map(stage => {
    const card = readTask(store, stage.taskId);
    return { ...stage, expertId: card.expertId ?? stage.expertId, status: card.status, revision: card.revision, summary: card.summary, result: card.result, artifacts: card.artifacts };
  }), messages: parent.history.flatMap((event, index) => event.expertMessage && index + 1 > after &&
    (event.expertMessage.to === recipient || event.expertMessage.to === "team" || event.expertMessage.from === recipient)
    ? [{ sequence: index + 1, at: event.at, text: event.text, kind: event.messageKind, ...event.expertMessage }] : []) };
}
export function sendTeamMessage(store: BoardStore, taskId: string, sender: string, input: Record<string, unknown>) {
  const parent = teamRoot(store, taskId);
  requireState(parent, ["draft", "ready", "in_progress", "blocked", "review"]);
  const members = [parent.id, ...(parent.expertStages ?? []).map(s => s.taskId), "manager", "owner", "reviewer"];
  const to = text(input.to, "recipient", true);
  if (!members.includes(sender) || ![...members, "team"].includes(to)) throw new TaskboardError("INVALID_INPUT", "Message must stay within this task's team.");
  const message = text(input.text, "message", true);
  if (message.length > 4000) throw new TaskboardError("INVALID_INPUT", "Messages are limited to 4000 characters.");
  const kind = input.kind ?? "update";
  if (!["update", "question", "decision"].includes(kind as string)) throw new TaskboardError("INVALID_INPUT", "Invalid message kind.");
  const replyTo = input.replyTo === undefined ? undefined : number(input.replyTo, "replyTo");
  if (replyTo !== undefined && !(sender === "owner" || sender === "manager"
    ? parent.history[replyTo - 1]?.expertMessage
    : teamInbox(store, taskId, sender).messages.some(m => m.sequence === replyTo)))
    throw new TaskboardError("INVALID_INPUT", "Reply to a team message available to you.");
  const event: Task["history"][number] = { at: new Date().toISOString(), action: "coordination",
    actor: sender === "owner" ? "user" : sender === "manager" || sender === "reviewer" ? sender : "agent", text: message,
    messageKind: kind as "update", expertMessage: { from: sender, to, replyTo } };
  store.save({ ...parent, history: [...parent.history, event] });
  return { parentId: parent.id, sequence: parent.history.length + 1, at: event.at };
}

export function reviewDecisionSequence(task: Task) {
  const submission = task.history.findLastIndex(event => event.action === "submit" && event.to === "review");
  const latest = task.history.findLastIndex(event => event.messageKind === "decision" && event.expertMessage &&
    ["owner", "manager"].includes(event.expertMessage.from) && ["team", "reviewer", "manager"].includes(event.expertMessage.to));
  return latest > submission ? latest + 1 : 0;
}
