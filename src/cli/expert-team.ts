import { boardReviewMode, member, object, strings, text, number, record, requireRevision, requireState, reviewsAcceptanceRepair, TaskboardError, usesIndependentReviewer } from "./model.ts";
import type { BoardSettings, ExpertPhase, SkillCheck, Task, TaskEvent } from "./model.ts";
import type { BoardStore } from "./storage.ts";
import { exists } from "./storage.ts";
import { resolveCommit } from "./git.ts";
import { isManual } from "./manual-board.ts";
import { readExpert } from "./experts.ts";
import { readTask } from "./archive.ts";
import { artifactSource } from "./artifacts.ts";
import { currentReviewApproval } from "./task-messages.ts";
import { runtimeEntries } from "../desktop/board-runtime.ts";

type Phase = NonNullable<TaskEvent["expertPhase"]>;
type StageRun = NonNullable<TaskEvent["expertStageRun"]>;

export function taskExpertPhase(value: unknown): Phase {
  if (value === "work" || value === "review") return value;
  throw new TaskboardError("INVALID_INPUT", "Unknown expert phase.");
}

export function requireExpertPlan(task: Task, phase: Phase) {
  const plan = task.expertTeam?.[phase];
  if (!plan?.lead) throw new TaskboardError("EXPERT_PLAN_REQUIRED", "Assign a responsible specialization for " + phase + " before launching " + task.id + ".");
}

export function approvalRequirements(task: Task, settings: BoardSettings) {
  if (isManual(settings)) return [];
  return [
    ...(!task.description.trim() ? ["description"] : []),
    ...(!task.criteria.some(criterion => criterion.trim()) ? ["criteria"] : []),
    ...(!task.expertTeam?.work?.lead ? ["work"] : []),
    ...(!task.schedule && boardReviewMode(settings) !== "human" && !task.expertTeam?.review?.lead ? ["review"] : []),
  ];
}

export function requireApprovalPlan(task: Task, settings: BoardSettings, action: "creation" | "approval" = "approval") {
  const missing = approvalRequirements(task, settings);
  if (missing.length) throw new TaskboardError("EXPERT_PLAN_REQUIRED", "Missing required card fields for " + action + ": " + missing.join(", ") + ".");
}

export function planNewTask(store: BoardStore, task: Task, value: unknown) {
  if (value !== undefined) {
    if (isManual(store.index.settings)) throw new TaskboardError("MANUAL_BOARD", "Expert plans require an agent board.");
    task.expertTeam = Object.fromEntries(Object.entries(object(value)).map(([key, plan]) => {
      const phase = taskExpertPhase(key);
      const parsed = parseExpertPlan(store, task, phase, object(plan));
      task.history.push({ at: task.createdAt, action: "expert-plan", actor: task.history[0].actor,
        expertPhase: phase, text: parsed.reason });
      return [phase, parsed];
    }));
  }
  requireApprovalPlan(task, store.index.settings, "creation");
}

function parseSkillChecks(value: unknown, skills: string[] | undefined): Record<string, SkillCheck> | undefined {
  if (value === undefined) return;
  return Object.fromEntries(Object.entries(object(value)).map(([id, entry]) => {
    if (!skills?.includes(id)) throw new TaskboardError("INVALID_INPUT", "Checks must refer to assigned skill IDs.");
    const check = object(entry);
    if (check.command !== undefined && Object.keys(check).length === 1) {
      const command = text(check.command, "skill command", true);
      if (command.length <= 1000 && !/[\r\n\0]/.test(command)) return [id, { command }];
    }
    if (Object.keys(check).every(key => ["tool", "server", "arguments"].includes(key))) {
      const tool = text(check.tool, "skill tool", true);
      const server = check.server === undefined ? undefined : text(check.server, "skill server", true);
      const args = check.arguments === undefined ? undefined : object(check.arguments);
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(tool) && !/^(?:expert_|team_|worklog_|task_record_result$)/.test(tool) &&
          (!server || /^[a-zA-Z0-9_-]{1,128}$/.test(server)) && (!args || Object.keys(args).length <= 12 &&
            Object.values(args).every(v => v === null || typeof v === "boolean" ||
              typeof v === "number" && Number.isFinite(v) || typeof v === "string" && v.length <= 1000))) {
        return [id, { tool, ...(server ? { server } : {}), ...(args ? { arguments: args as Record<string, string | number | boolean | null> } : {}) }];
      }
    }
    throw new TaskboardError("INVALID_INPUT", "Use an exact command or a specific observable tool action for " + id + ".");
  }));
}

function checkSkillAssignments(scope: Pick<ExpertPhase, "skills" | "skillChecks">, name: string) {
  const missing = scope.skills?.filter(id => !Object.hasOwn(scope.skillChecks ?? {}, id)) ?? [];
  if (missing.length) throw new TaskboardError("SKILL_CHECK_REQUIRED",
    "Define a successful command or tool action for each assigned skill in " + name + ": " + missing.join(", ") + ".");
}

function parseExpertPlan(store: BoardStore, task: Pick<Task, "schedule">, phase: Phase, input: Record<string, unknown>, previous?: ExpertPhase): ExpertPhase {
  const lead = input.lead === undefined ? previous?.lead : input.lead === null ? null : text(input.lead, "lead specialization", true);
  const expert = lead ? readExpert(store, lead) : undefined;
  const reason = text(input.reason, "team rationale", true);
  if (reason.length > 2000) throw new TaskboardError("INVALID_INPUT", "Team rationale is limited to 2000 characters.");
  const previousSkills = previous?.lead === lead ? previous?.skills : undefined;
  const skills = input.skills === undefined ? previousSkills : strings(input.skills, "lead skills");
  if (skills && (new Set(skills).size !== skills.length || skills.some(id => !expert?.skills.some(skill => skill.id === id))))
    throw new TaskboardError("INVALID_INPUT", "Select distinct skills from the lead specialization.");
  const skillChecks = parseSkillChecks(input.skillChecks ?? (input.skills === undefined && previous?.lead === lead ? previous?.skillChecks : undefined), skills);
  checkSkillAssignments({ skills, skillChecks }, phase + " lead");
  if (!Array.isArray(input.stages) || input.stages.length > 32)
    throw new TaskboardError("INVALID_INPUT", "Supply up to 32 assigned stages.");
  const proposed = input.stages.map(value => {
    const stage = object(value);
    const key = text(stage.key, "stage key", true);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new TaskboardError("INVALID_INPUT", "Invalid stage key.");
    const expertId = text(stage.expertId, "expert ID", true);
    const stageExpert = readExpert(store, expertId);
    const stageSkills = stage.skills === undefined ? undefined : strings(stage.skills, "stage skills");
    if (stageSkills && (new Set(stageSkills).size !== stageSkills.length || stageSkills.some(id => !stageExpert.skills.some(skill => skill.id === id)))) {
      throw new TaskboardError("INVALID_INPUT", "Select distinct skills from the stage specialization.");
    }
    const stageChecks = parseSkillChecks(stage.skillChecks, stageSkills);
    checkSkillAssignments({ skills: stageSkills, skillChecks: stageChecks }, key);
    const criteria = strings(stage.criteria, "stage criteria");
    const outputs = strings(stage.outputs, "outputs");
    if (!criteria.length || !outputs.length) throw new TaskboardError("INVALID_INPUT", "Each stage needs criteria and outputs.");
    if (new Set(outputs).size !== outputs.length || outputs.some(output => !output.trim()))
      throw new TaskboardError("INVALID_INPUT", "Stage outputs must be distinct and non-empty.");
    const artifacts = Object.entries(object(stage.artifactOutputs ?? {})).map(([name, kind]) => {
      if (phase !== "work" || task.schedule || !outputs.includes(name))
        throw new TaskboardError("INVALID_INPUT", "Artifact outputs must name declared outputs on a work stage of a task submitted for review.");
      return [name, member(kind, ["png", "text"], "artifact kind")] as const;
    });
    return { key, expertId, title: text(stage.title, "stage title", true), description: text(stage.description ?? "", "stage description"),
      criteria, inputs: strings(stage.inputs ?? [], "inputs"), outputs, dependsOn: strings(stage.dependsOn ?? [], "stage dependencies"),
      ...(stageSkills !== undefined ? { skills: stageSkills } : {}),
      ...(stageChecks ? { skillChecks: stageChecks, skillExpertRevision: stageExpert.revision } : {}),
      ...(artifacts.length ? { artifactOutputs: Object.fromEntries(artifacts) } : {}) };
  });
  const existing = previous?.stages ?? [];
  if (new Set(proposed.map(s => s.key)).size !== proposed.length) throw new TaskboardError("INVALID_INPUT", "Stage keys must be unique.");
  if (input.replace !== undefined && typeof input.replace !== "boolean") throw new TaskboardError("INVALID_INPUT", "replace must be a boolean.");
  for (const stage of input.replace ? [] : proposed) {
    const saved = existing.find(old => old.key === stage.key);
    if (saved && JSON.stringify(saved) !== JSON.stringify(stage))
      throw new TaskboardError("REVISION_CONFLICT", "This stage key already belongs to a different plan.");
  }
  const all = input.replace ? proposed : [...existing, ...proposed.filter(stage => !existing.some(old => old.key === stage.key))];
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
  return { lead, reason, ...(skills !== undefined ? { skills } : {}),
    ...(skillChecks ? { skillChecks, skillExpertRevision: expert?.revision } : {}), stages: all };
}

export function createExpertPlan(store: BoardStore, parentId: string, input: Record<string, unknown>) {
  const parent = store.card(parentId);
  const phase = taskExpertPhase(input.phase ?? "work");
  requireState(parent, ["draft", "ready", "in_progress", "blocked", "review"]);
  const previous = parent.expertTeam?.[phase];
  const plan = parseExpertPlan(store, parent, phase, input, previous);
  if (previous && JSON.stringify(plan) === JSON.stringify(previous)) return { parent, phase, ...plan };
  requireRevision(parent, input.revision, true);
  if (runtimeEntries(store.location.root).some(entry => entry.kind === "slot" && [parent.id, "review:" + parent.id].includes(entry.task ?? "")))
    throw new TaskboardError("EXPERT_PHASE_RUNNING", "The responsible agent is already running this phase.");
  const settings = store.index.settings;
  const fillsMissingReviewPlan = phase === "review" && !previous?.lead && Boolean(plan.lead);
  const fillsMissingRepairPlan = fillsMissingReviewPlan && reviewsAcceptanceRepair(parent, settings);
  const approval = currentReviewApproval(parent, settings)?.reviewApproval;
  const currentTarget = fillsMissingReviewPlan && approval?.targetHead && parent.git && store.location.repository &&
    usesIndependentReviewer(boardReviewMode(settings)) && resolveCommit(store.location.repository.root, parent.git.target);
  const hasCurrentApproval = approval && (!currentTarget || currentTarget === approval.targetHead);
  if (parent.status === "review" && (exists(store.pendingPath(parent.id)) ||
      (parent.acceptanceRepair && !fillsMissingRepairPlan) || hasCurrentApproval))
    throw new TaskboardError("INVALID_TRANSITION", "The submission already has a review decision or is being integrated.");
  const updated = record({ ...parent, expertTeam: { ...parent.expertTeam, [phase]: plan } }, "expert-plan", "manager", parent.status, plan.reason);
  updated.history.at(-1)!.expertPhase = phase;
  store.save(updated);
  return { parent: updated, phase, ...plan };
}

function stageEpoch(task: Task, phase: Phase) {
  const boundary = task.history.findLastIndex(event =>
    (event.action === "expert-plan" && (event.expertPhase === phase || !event.expertPhase)) ||
    event.action === "update" ||
    (phase === "review" ? event.action === "submit" || event.action === "request-changes" :
      event.action === "request-changes" || event.action === "return-to-draft" || (event.action === "progress" && event.to === "ready")));
  return phase === "review" ? Math.max(boundary, reviewDecisionSequence(task) - 1) : boundary;
}

export function expertStagesStatus(task: Task, phase: Phase, targetHead?: string | null) {
  const runs = new Map<string, StageRun>();
  for (const event of task.history.slice(stageEpoch(task, phase) + 1)) {
    const run = event.expertStageRun;
    if (run?.phase === phase && (targetHead === undefined || run.targetHead === targetHead)) runs.set(run.key, run);
  }
  return (task.expertTeam?.[phase]?.stages ?? []).map(stage => {
    const run = runs.get(stage.key);
    const state = run?.state ?? (stage.dependsOn.every(key => runs.get(key)?.state === "done") ? "ready" : "waiting");
    return { ...stage, address: phase + ":" + stage.key, state, run };
  });
}

export function requireExpertResults(task: Task, phase: Phase, targetHead?: string | null) {
  requireSkillProof(task, phase, undefined, targetHead);
  const pending = expertStagesStatus(task, phase, targetHead).filter(stage => stage.state !== "done");
  if (pending.length) throw new TaskboardError("EXPERT_STAGES_INCOMPLETE",
    "Record the required results for " + pending.map(stage => stage.address).join(", ") + " before finishing this phase.");
}

export function requireSkillProof(task: Task, phase: Phase, key?: string, targetHead?: string | null, agentId?: string, sessionId?: string) {
  const plan = task.expertTeam?.[phase];
  const scope = key ? plan?.stages.find(stage => stage.key === key) : plan;
  if (!scope?.skills?.length) return;
  checkSkillAssignments(scope, key ?? phase + " lead");
  const event = task.history.slice(stageEpoch(task, phase) + 1).findLast(({ expertSkillProof: proof }) =>
    proof?.phase === phase && proof.key === key && proof.targetHead === targetHead && proof.expertRevision === scope.skillExpertRevision &&
    (!agentId || proof.agentId === agentId) && (!sessionId || proof.sessionId === sessionId));
  if (!scope.skills.every(id => Object.hasOwn(event?.expertSkillProof?.items ?? {}, id))) {
    throw new TaskboardError("SKILL_USE_REQUIRED", "Verify the assigned skill actions before finishing " + (key ?? phase) + ".");
  }
  return event?.expertSkillProof;
}

export function skillProofScope(store: BoardStore, task: Task, phase: Phase, key?: string) {
  const plan = task.expertTeam?.[phase];
  const stage = key ? plan?.stages.find(stage => stage.key === key) : undefined;
  if (key && !stage) throw new TaskboardError("INVALID_INPUT", "Unknown specialist stage.");
  const scope = stage ?? plan;
  if (!scope?.skills?.length) return;
  checkSkillAssignments(scope, key ?? phase + " lead");
  const expert = readExpert(store, stage?.expertId ?? plan!.lead!);
  if (expert.revision !== scope.skillExpertRevision) {
    throw new TaskboardError("SKILL_PLAN_OUTDATED", "The expert package changed. Refresh the assigned skills in the plan.");
  }
  return { skillChecks: scope.skillChecks!, expertId: expert.id, expertRevision: expert.revision, outputs: stage?.outputs };
}

export function updateExpertStage(store: BoardStore, id: string, phase: Phase, input: Record<string, unknown>, targetHead?: string | null) {
  const task = store.card(id);
  requireState(task, phase === "work" ? ["in_progress"] : ["review"]);
  requireRevision(task, input.revision, true);
  const settings = store.index.settings;
  const approval = phase === "review" ? currentReviewApproval(task, settings)?.reviewApproval : undefined;
  if (approval && (settings.reviewMode !== "reviewer-human" || approval.targetHead === targetHead)) {
    throw new TaskboardError("EXPERT_PHASE_CLOSED", "This submission already has a review decision.");
  }
  const stages = expertStagesStatus(task, phase, targetHead);
  const stage = stages.find(item => item.key === input.key);
  if (!stage) throw new TaskboardError("INVALID_INPUT", "Unknown specialist stage.");
  const state = input.state;
  if (state !== "running" && state !== "blocked" && state !== "done")
    throw new TaskboardError("INVALID_INPUT", "Supply running, blocked or done.");
  const dependencies = stages.filter(item => stage.dependsOn.includes(item.key));
  if (dependencies.some(item => item.state !== "done"))
    throw new TaskboardError("EXPERT_DEPENDENCIES_INCOMPLETE", "Complete every prerequisite before starting this stage.");
  const role = readExpert(store, stage.expertId, state === "running");
  const run: StageRun = { phase, key: stage.key, state, ...(phase === "review" ? { targetHead } : {}) };
  if (state !== "running") {
    run.result = text(input.result, "stage result", true);
    if (run.result.length > 8000) throw new TaskboardError("INVALID_INPUT", "Stage summaries are limited to 8000 characters.");
  }
  if (state === "done") {
    const proof = requireSkillProof(task, phase, stage.key, targetHead, typeof input.agentId === "string" ? input.agentId : undefined,
      typeof input.sessionId === "string" ? input.sessionId : undefined);
    const outputs = object(input.outputs);
    if (Object.keys(outputs).length !== stage.outputs.length ||
        stage.outputs.some(name => !Object.hasOwn(outputs, name) || typeof outputs[name] !== "string" || !outputs[name].trim() || outputs[name].length > 4000))
      throw new TaskboardError("INVALID_INPUT", "Supply evidence for each declared output, keyed by its exact name.");
    if (proof && (input.agentId || proof.outputs) && (input.agentId !== proof.agentId ||
      stage.outputs.some(name => proof.outputs?.[name] !== (outputs[name] as string).trim())))
      throw new TaskboardError("EXPERT_RESULT_MISMATCH", "Report the specialist's own verified outputs.");
    run.outputs = Object.fromEntries(stage.outputs.map(name => [name, (outputs[name] as string).trim()]));
    const artifactNames = Object.keys(stage.artifactOutputs ?? {});
    if (artifactNames.length) {
      const used = stages.filter(other => other.key !== stage.key && other.state === "done").flatMap(other =>
        Object.keys(other.artifactOutputs ?? {}).map(name => other.run!.outputs![name]));
      const assigned = new Set(used.map(source => process.platform === "win32" ? source.toLowerCase() : source));
      for (const name of artifactNames) {
        const source = artifactSource(run.outputs[name]);
        const key = process.platform === "win32" ? source.toLowerCase() : source;
        if (assigned.has(key)) throw new TaskboardError("ARTIFACT_OUTPUT_CONFLICT", "Use a distinct file for each required stage output.");
        assigned.add(key);
        run.outputs[name] = source;
      }
    }
    const ownRole = stage.expertId === task.expertTeam?.[phase]?.lead;
    if (!ownRole && input.agentId == null) {
      run.fallback = text(input.fallback, "reason for local execution", true);
      if (run.fallback.length > 1000) throw new TaskboardError("INVALID_INPUT", "Fallback reasons are limited to 1000 characters.");
    }
    if (input.agentId != null) {
      run.agentId = text(input.agentId, "confirmed provider agent ID", true);
      if (!/^[a-z0-9-]{1,100}$/i.test(run.agentId) || stages.some(item => item.key !== stage.key && item.run?.agentId === run.agentId && item.expertId !== stage.expertId))
        throw new TaskboardError("EXPERT_AGENT_SCOPE", "A provider agent represents one specialization.");
      if (input.sessionId !== undefined) {
        run.sessionId = text(input.sessionId, "provider session ID", true);
        if (stages.some(item => item.key !== stage.key && item.expertId === stage.expertId &&
            item.run?.sessionId === run.sessionId && item.run?.agentId && item.run.agentId !== run.agentId))
          throw new TaskboardError("EXPERT_AGENT_DUPLICATE", "Reuse the provider agent already assigned to this specialization in this session.");
      }
    }
  }
  if (stage.run?.state === "done" || JSON.stringify(stage.run) === JSON.stringify(run)) {
    if (JSON.stringify(stage.run) !== JSON.stringify(run)) throw new TaskboardError("EXPERT_STAGE_COMPLETE", "This stage already has a recorded result.");
  } else {
    if (state === "done" && stage.state !== "running") throw new TaskboardError("EXPERT_STAGE_NOT_RUNNING", "Start the stage before recording its result.");
    const event: TaskEvent = { at: new Date().toISOString(), action: "expert-stage", actor: phase === "review" ? "reviewer" : "agent", expertStageRun: run };
    store.save({ ...task, history: [...task.history, event] });
  }
  return { ...stage, state, run, package: role, dependencies };
}

export function teamRoot(store: BoardStore, taskId: string) {
  const task = readTask(store, taskId);
  return task.expertStage ? readTask(store, task.expertStage.parentId) : task;
}
export function teamInbox(store: BoardStore, taskId: string, recipient: string, after = 0) {
  const parent = teamRoot(store, taskId);
  const stages = [...expertStagesStatus(parent, "work"), ...expertStagesStatus(parent, "review")];
  if (!["manager", "owner", "reviewer", parent.id, ...(parent.expertStages ?? []).map(s => s.taskId), ...stages.map(stage => stage.address)].includes(recipient))
    throw new TaskboardError("INVALID_INPUT", "Unknown team recipient.");
  return { parentId: parent.id, expertTeam: parent.expertTeam, stages, members: (parent.expertStages ?? []).map(stage => {
    const card = readTask(store, stage.taskId);
    return { ...stage, expertId: card.expertId ?? stage.expertId, status: card.status, revision: card.revision, summary: card.summary, result: card.result, artifacts: card.artifacts };
  }), messages: parent.history.flatMap((event, index) => event.expertMessage && index + 1 > after &&
    (event.expertMessage.to === recipient || event.expertMessage.to === "team" || event.expertMessage.from === recipient ||
      (recipient === parent.id && [event.expertMessage.to, event.expertMessage.from].some(address => address.startsWith("work:"))) ||
      (recipient === "reviewer" && [event.expertMessage.to, event.expertMessage.from].some(address => address.startsWith("review:"))))
    ? [{ sequence: index + 1, at: event.at, text: event.text, kind: event.messageKind, ...event.expertMessage }] : []) };
}
export function sendTeamMessage(store: BoardStore, taskId: string, sender: string, input: Record<string, unknown>) {
  const parent = teamRoot(store, taskId);
  requireState(parent, ["draft", "ready", "in_progress", "blocked", "review"]);
  const members = [parent.id, ...(parent.expertStages ?? []).map(s => s.taskId), "manager", "owner", "reviewer",
    ...expertStagesStatus(parent, "work").map(stage => stage.address), ...expertStagesStatus(parent, "review").map(stage => stage.address)];
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
    event.expertMessage.from === "owner" &&
    (["team", "reviewer", "manager"].includes(event.expertMessage.to) || event.expertMessage.to.startsWith("review:")));
  return latest > submission ? latest + 1 : 0;
}
