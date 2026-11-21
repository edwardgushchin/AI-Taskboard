import { randomUUID } from "node:crypto";
import { callCli, cliFailure } from "./cli.ts";
import { skillEvidence } from "./skill-evidence.ts";
import { previewRunActivity, runActivity } from "./run-activity.ts";
import { stageRunJournal } from "./stage-run-history.ts";
import type { AgentControl, RpcMessage } from "./codex-rpc.ts";
import type { teamInbox } from "../cli/expert-team.ts";
import type { Expert } from "../cli/experts.ts";
import { codexThreadPattern } from "../cli/model.ts";
import type { ExpertPhase, RunActivity } from "../cli/model.ts";

const s = { type: "string", minLength: 1 };
const list = { type: "array", items: s };
const task = { id: s };
const skillChecks = { type: "object", additionalProperties: { type: "object", additionalProperties: false,
  properties: { command: s, tool: s, server: s, arguments: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } } } } };
export const expertActions = {
  expert_list: { description: "Find board-owned expert IDs, names, groups and availability. Start with a profession or domain query. Read candidate instructions and skill lists with expert_context.",
    properties: { query: { type: "string" } }, required: [] },
  expert_context: { description: "Apply 1–6 distinct expert IDs per call for your current phase. For a larger team, load only the specialists needed in each phase. Returns their system instructions and available board-local skills. Keep your existing manager/executor/reviewer authority. Load relevant skills explicitly; reconsider the selection when the phase changes.",
    properties: { ids: { ...list, minItems: 1, maxItems: 6, uniqueItems: true } }, required: ["ids"] },
  expert_skill: { description: "Read and materialize a skill in the expert's board-owned directory, including bundled scripts and references. Use returned absolute paths. This does not install provider plugins, dependencies or grant tool access.",
    properties: { expertId: s, skillId: s }, required: ["expertId", "skillId"] },
  expert_plan: { description: "Assign a lead, lead skills and stages, with a rationale for the team. Dependencies reference stable stage keys. For work stages submitted for review, artifactOutputs maps exact output names to png or text so submission requires and saves those files.",
    properties: { ...task, revision: { type: "integer", minimum: 1 }, phase: { type: "string", enum: ["work", "review"] },
      reason: { ...s, maxLength: 2000 }, skills: list, skillChecks,
      lead: { type: ["string", "null"] }, replace: { type: "boolean" }, stages: { type: "array", maxItems: 32, items: {
      type: "object", properties: { key: s, expertId: s, title: s, description: { type: "string" },
        criteria: { ...list, minItems: 1 }, inputs: list, outputs: { ...list, minItems: 1 }, dependsOn: list,
        artifactOutputs: { type: "object", description: "On a work stage of a task submitted for review, map an exact string from this stage's outputs array to png or text. Example: outputs contains desktop, artifactOutputs is {\"desktop\":\"png\"}.",
          additionalProperties: { type: "string", enum: ["png", "text"] } }, skills: list, skillChecks },
      required: ["key", "expertId", "title", "criteria", "outputs"], additionalProperties: false } } }, required: ["id", "revision", "reason", "stages"] },
  expert_stage: { description: "Start, block, or finish an assigned stage. Returns the specialist package and prerequisite results. Once the provider confirms a delegated agent, repeat running with its ID to bind its live activity. For done, provide each exact output and the same agent ID. For artifactOutputs, give the path of the individual file relative to the worktree.",
    properties: { ...task, phase: { type: "string", enum: ["work", "review"] }, targetHead: { type: ["string", "null"] },
      revision: { type: "integer", minimum: 1 }, key: s, state: { type: "string", enum: ["running", "blocked", "done"] },
      result: s, outputs: { type: "object", additionalProperties: s }, agentId: s, fallback: s },
    required: ["id", "revision", "key", "state"] },
  expert_verify_skills: { description: "Verify the current lead's assigned skill actions from its successful Codex tool or command events before submitting or approving. Read the current revision and, for review, targetHead.",
    properties: { ...task, revision: { type: "integer", minimum: 1 }, targetHead: { type: ["string", "null"] } },
    required: ["id", "revision"] },
  team_inbox: { description: "Read the task team's stage status, results and addressed mail. Use afterSequence to avoid rereading mail.",
    properties: { ...task, afterSequence: { type: "integer", minimum: 0 } }, required: ["id"] },
  team_findings: { description: "Search verified findings across cards with keywords, or record a confirmed finding from the current card. Include the exact environment and the check or evidence that confirmed the cause. Use id when publishing as manager.",
    properties: { ...task, query: { type: "string", maxLength: 300 }, finding: { type: "object",
      properties: { symptom: s, environment: s, cause: s, verification: s },
      required: ["symptom", "environment", "cause", "verification"], additionalProperties: false } }, required: [] },
  team_message: { description: "Send persistent mail up to 4000 characters to a stage like work:verify, a legacy stage card, manager, owner, or team. Summarize the relevant part and reference large documents by path, revision or artifact instead of pasting them. Use stage for the lead's own phase, question for an answer and replyTo to keep the conversation.",
    properties: { ...task, to: s, stage: s, text: { ...s, maxLength: 4000 }, kind: { type: "string", enum: ["update", "question", "decision"] }, replyTo: { type: "integer", minimum: 1 } },
    required: ["id", "to", "text"] },
};
export const expertCommands: Record<string, string> = { expert_list: "experts", expert_context: "expert-context", expert_skill: "expert-skill",
  expert_plan: "expert-plan", expert_stage: "expert-stage", team_inbox: "expert-inbox", team_message: "expert-message", team_findings: "findings" };
export const executorExpertTools = Object.entries(expertActions).filter(([name]) => name !== "expert_plan").map(([name, action]) => {
  const properties: Record<string, unknown> = { ...action.properties };
  for (const key of ["id", "phase", "targetHead"]) delete properties[key];
  return { name, description: action.description, inputSchema: { type: "object", properties,
    required: action.required.filter(name => name !== "id"), additionalProperties: false } };
});

export function watchTeamMail(project: string, taskId: string, control: AgentControl, actor: "agent" | "reviewer", afterSequence = 0) {
  let reading = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    void callCli<ReturnType<typeof teamInbox>>(project, ["expert-inbox", taskId], { actor, afterSequence }).then(async inbox => {
      if (stopped || !inbox.ok || !inbox.data.messages.length) return;
      const sequence = Math.max(...inbox.data.messages.map(message => message.sequence));
      if (actor === "agent" || inbox.data.messages.some(message =>
        message.from !== "reviewer" && !message.from.startsWith("review:"))) {
        await control.steer("AI Taskboard: new addressed team mail through sequence " + sequence +
          ". Read team_inbox and coordinate with the sender. Owner questions need a human answer.", []);
      }
      afterSequence = sequence;
    }).catch(() => { /* Persisted mail remains available; retry on the next pass. */ }).finally(() => { reading = false; });
  }, 2000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function leadSkillInstructions(project: string, taskId: string, expert: Expert, plan: ExpertPhase | undefined,
  actor: "agent" | "reviewer", context: string) {
  const workflow = expert.skills.filter(skill => skill.id === "workflow").map(skill => skill.id);
  const selected = plan?.skills ?? (/\bElectron\b/i.test(context)
    ? expert.skills.filter(skill => skill.name === "electron").map(skill => skill.id) : []);
  const loaded = [];
  for (const skillId of new Set([...workflow, ...selected])) {
    const skill = await callCli<{ content: string; directory: string }>(project, ["expert-skill", taskId],
      { expertId: expert.id, skillId, actor, source: "plan" });
    if (!skill.ok) throw new Error("Could not load " + expert.id + "/" + skillId + ": " + skill.error.message);
    loaded.push("Loaded board skill " + skillId + " (" + skill.data.directory + ")\n" + skill.data.content);
  }
  return loaded;
}
export const expertInstructions = "Board experts are internal instruction packages, never Codex/Claude plugins. Apply these instructions when the corresponding expert/team tools are provided. " +
  "Before working or reviewing as an assigned expert, match the main action in the brief to the skills in the supplied expert package. Choose the most specific match for the requested result, such as writing new copy or editing a supplied draft. Load another skill only when it is needed for a distinct part of the brief. For each selected skill whose instructions you have not received, call expert_skill with that expert's ID and the exact skill ID before doing the work. Follow the returned procedure. " +
  "Select and load relevant skills yourself even when the plan has no explicit skills and the user did not mention skills. The generic workflow is separate from this selection. If no library skill applies, continue with the general workflow. " +
  "As manager, before planning a sprint or doing domain work, use expert_list to choose the necessary specializations yourself, then expert_context " +
  "(for example business-analyst and product-owner) and expert_skill for the relevant methods. Load at most six distinct IDs per expert_context call. Choose the roles needed now and load later roles when their phase begins; " +
  "they never change your process authority or tool permissions. Before launching or queuing work, save the expert_plan for work and review on the same card. " +
  "Use one responsible specialization for a simple phase, with stages only where another distinct deliverable or expertise is needed. " +
  "Run ready cards in parallel when their worktrees, write scopes and exclusive resources allow it. Use card dependencies for required results and queue holds for temporary resource contention. Run the final integration check after its prerequisites. " +
  "The responsible agent completes stages of its own specialization directly. Expect a native subagent for a different specialization when the provider supports it. " +
  "Read the updated card revision after each plan change. Give each stage explicit inputs, outputs, criteria and dependencies. " +
  "When a brief depends on external facts, make collection of primary excerpts an output of the research stage and an input to the stage that interprets them. Require a compact set of claims that can be checked against the saved evidence from the first submission. " +
  "Assign a skill explicitly in skills only with a concrete action in skillChecks for its ID. Choose the exact command or tool with any required arguments from the skill's actual procedure. The general workflow is already delivered by default. " +
  "For a visible UI change, plan a verification work stage with PNG outputs for relevant viewports or window sizes and a text report of the key interaction. Specify the screens, sizes, states, and visible outcomes to verify. Let the review phase inspect these materials against those criteria. " +
  "Each specialization is one shared package, with no expert-specific model or permanent agent identity. " +
  "Use team_inbox/team_message for peer coordination and questions to manager or owner. A question to owner needs a human answer; do not invent it. " +
  "Use team_findings to reuse confirmed diagnoses across cards. Check the stated environment before applying a finding to a new task. " +
  "When an owner decision unblocks the card, resume its responsible lead through the normal board lifecycle. " +
  "Do not globally install skills or enable provider plugins. Read only the skills relevant to this phase and use their returned board paths.";

export const leadInstructions = "You are responsible for this card's current phase and its final result. Apply the assigned lead specialization and read your team inbox before delegating or reporting a decision. " +
  "After spawning a specialist, repeat expert_stage with state running and the provider agent ID before waiting. For a reused specialist, bind that ID to the new stage before sending the next assignment. " +
  "Read the current revision and recorded stage states before opening work with expert_stage. On REVISION_CONFLICT, reread the card and reconcile changed requirements before retrying. A completed stage already has a result; reuse it. After collecting the result, use expert_stage with state done, a summary, and an outputs object keyed by each exact declared output. For delegated work pass the actual child agent ID after waiting for its result. " +
  "Apply the preloaded lead skills. If your lead has explicit skillChecks in this phase, perform them and call expert_verify_skills before submitting or approving when the tool is available. The implicit workflow alone requires no verification call. When opening a stage, select library skills from the returned specialist package for that stage's outputs. Reuse the instructions in assignedSkills and call expert_skill for relevant skills that are still missing. Pass the loaded instructions and any assigned actions to the specialist. For a stage with assigned skills, the specialist must perform the actions personally and return JSON with an outputs object keyed by the exact declared output names. Pass those outputs unchanged to expert_stage. Handle your own stages yourself and reuse the same native subagent for later stages of its specialization. " +
  "Run only independent, non-conflicting stages in parallel. Wait for prerequisites and pass their results to dependent specialists. Use the provider's messaging and wait mechanisms to coordinate. Wait for the current run to report completion after following up with a previous specialist. " +
  "Keep browser profiles and disposable checks in a system temporary directory. Save only the files needed for review in the task's ignored .tasks/qa/ directory and register all retained files before submission. If a QA command is delivered to the user, run it in an ordinary clean clone and check git status --porcelain after it finishes. Finish the stage with a path for each declared artifact output. Capture from the same sources you will submit. Open saved screenshots and verify the required state is visible. For review, use PNGs up to 4 MiB and 16 megapixels. Capture the relevant viewport or region for oversized pages. If a capture is empty or clipped, repair the delivered capture or document the tested replacement in the reproducible QA procedure. Every executable verification report must identify the tested commit or list the tested source hashes and their representation. Run on committed sources when possible. For a worktree snapshot, verify its source hashes against the final preview before submitting. Keep commit IDs separate from tree and blob IDs. Recheck any affected source changed after QA. The board saves the declared outputs with the submission. " +
  "Capture the primary evidence as you collect external facts, before drafting the comparison. Keep short source excerpts or legible crops with the URL, observation time and enough surrounding context to verify each material claim. For a tariff, keep the actual row or card showing which service, amount, unit and conditions belong together. A paraphrase or line number from an unsaved extraction does not verify the claim offline. Keep the compact evidence at durable paths, check that the handoff links open from a clean checkout and register unique evidence PNGs for task_review_artifact. Prefer a small set of fully supported claims. Label unestablished details as unknown and remove claims without saved support before first preview. If an interactive browser is unavailable, use a permitted alternative to capture the evidence or limit claims to what you can preserve and verify. " +
  "Use team_message for meaningful handoffs and questions between assigned roles. Include the decision or artifact the receiving stage needs and route it to its stage address. Deliver incoming mail from team_inbox to its native agent. If a decision blocks a stage, mark it blocked and leave a persistent question. " +
  "Search team_findings when a failure or diagnostic is likely to recur. Record confirmed reusable causes with the environment and verification. Treat findings from other cards as evidence and recheck applicability when conditions differ. " +
  "If delegation is unavailable or fails, apply the package yourself and give the factual fallback reason when recording its result. Check every result before submitting or giving the review decision. The same task permission and review scope apply to all delegates.";

export function phaseStageReporter(project: string, phase: "work" | "review", id?: string, targetHead?: string | null) {
  const children = new Map<string, string>();
  const completed = new Set<string>();
  const sessionId = randomUUID();
  const startedAt = Date.now();
  const evidence = skillEvidence(project, phase, sessionId, id, targetHead);
  let threadId: string | undefined;
  let provider: Parameters<typeof evidence.bind>[0] | undefined;
  let onActivity: ((item: RunActivity) => void) | undefined;
  const assigned = new Map<string, string>();
  const open = new Map<string, string>();
  const journals = new Map<string, ReturnType<typeof stageRunJournal>>();
  const owners = new Map<string, string>();
  const activity = new Map<string, Map<string, RunActivity>>();
  const leadActivity = new Map<string, RunActivity>();
  const latestChildItem = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let closed = false;

  function journal(taskId: string) {
    let value = journals.get(taskId);
    if (!value) {
      value = stageRunJournal(project, taskId, phase, sessionId);
      journals.set(taskId, value);
    }
    return value;
  }

  function saveActivity(item: RunActivity, taskIds: Set<string>) {
    const key = item.threadId + "\0" + item.id;
    let taskId = owners.get(key);
    if (!taskId && taskIds.size === 1) {
      taskId = [...taskIds][0];
      owners.set(key, taskId);
    }
    if (taskId) journal(taskId).record({ ...item, stageSessionId: sessionId });
  }

  function childItem(child: string, method: string, params: Record<string, unknown>, at?: string, restored = false) {
    if (closed) return;
    const entries = activity.get(child) ?? new Map<string, RunActivity>();
    activity.set(child, entries);
    const item = runActivity(entries, method, params, at, true);
    // A completion or delta without a confirmed start may belong to an earlier assignment.
    if (!item?.at) return;
    if (restored && at) item.at = at;
    const previous = entries.get(item.id);
    entries.set(item.id, item);
    if (JSON.stringify(previous) === JSON.stringify(item)) return;
    const entry = { ...item, id: child + ":" + item.id, stageSessionId: sessionId, stageChild: true as const };
    const taskIds = new Set([...open].filter(([key]) => assigned.get(key) === child).map(([, taskId]) => taskId));
    saveActivity(entry, taskIds);
    onActivity?.(previewRunActivity(entry));
  }

  async function readChild(child: string, final = false) {
    if (!provider || closed || !codexThreadPattern.test(child)) return;
    let cursor: string | null = null;
    const seen = new Set<string>();
    const items: { item: Record<string, unknown>; at?: number }[] = [];
    const previousLatest = final ? undefined : latestChildItem.get(child);
    let latest: string | undefined;
    let complete = false;
    try {
      // Ask the same provider session for persisted items even if it did not notify the lead of child activity.
      while (!closed) {
        const page: {
          data: { item: Record<string, unknown>; startedAtMs?: number | null; completedAtMs?: number | null }[];
          nextCursor: string | null;
        } = await provider("thread/items/list", { threadId: child, cursor, limit: 100, sortDirection: "desc" });
        latest ??= typeof page.data[0]?.item.id === "string" ? page.data[0].item.id : undefined;
        let reachedStart = page.data.length > 0;
        let reachedPrevious = false;
        for (const entry of page.data) {
          const at = entry.startedAtMs;
          if (entry.item.id === previousLatest) reachedPrevious = true;
          if (typeof at !== "number" || !Number.isFinite(at)) {
            reachedStart = false;
            items.push({ item: entry.item });
          } else if (at >= startedAt) {
            reachedStart = false;
            items.push({ item: entry.item, at });
          }
        }
        if (reachedStart || reachedPrevious || !page.nextCursor) {
          complete = true;
          break;
        }
        if (seen.has(page.nextCursor)) break;
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } catch {
      // Some providers expose child notifications but do not support listing their threads.
    }
    for (const { item, at } of items.reverse()) {
      const running = item.status === "inProgress";
      const previous = typeof item.id === "string" ? activity.get(child)?.get(item.id) : undefined;
      if (running && previous && previous.status !== "inProgress") {
        if (item.type === "commandExecution" && previous.type === "commandExecution") {
          // Keep the terminal metadata and merge any output that only the older snapshot carries.
          const output = {
            id: previous.id, type: previous.type, status: previous.status, aggregatedOutput: item.aggregatedOutput,
          };
          childItem(child, "item/completed", { item: output, threadId: child });
        }
        continue;
      }
      const method = running ? "item/started" : "item/completed";
      childItem(child, method, { item, threadId: child }, at === undefined ? undefined : new Date(at).toISOString(), true);
    }
    if (complete && latest) latestChildItem.set(child, latest);
  }

  function schedule() {
    if (timer || polling || closed || !assigned.size) return;
    timer = setTimeout(async () => {
      timer = undefined;
      polling = true;
      try {
        await Promise.all([...new Set(assigned.values())].map(child => readChild(child)));
      } finally {
        polling = false;
        schedule();
      }
    }, 700);
    timer.unref();
  }

  return {
    sessionId,
    bind(request: Parameters<typeof evidence.bind>[0], lead: string) {
      threadId = lead;
      provider = request;
      evidence.bind(request, lead);
    },
    listen(listener: (item: RunActivity) => void) {
      onActivity = listener;
      schedule();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      assigned.clear();
      for (const value of journals.values()) value.close();
    },
    verify(args: unknown) { return evidence.verify(args as Record<string, unknown>); },
    observe(message: RpcMessage, lead: string | undefined) {
      if (closed) return;
      if (lead) evidence.observe(message, lead);
      const event = message.params as { threadId?: string; item?: { type?: string; tool?: string; status?: string;
        receiverThreadIds?: string[]; agentsStates?: Record<string, { status: string }>;
        kind?: string; agentThreadId?: string; agentPath?: string } } | undefined;
      const item = event?.item;
      const child = event?.threadId;
      if (lead && event && child === lead && message.method?.startsWith("item/")) {
        const taskIds = new Set(open.values());
        const entry = runActivity(leadActivity, message.method, event, new Date().toISOString(), true);
        if (entry) {
          const seen = leadActivity.has(entry.id);
          leadActivity.set(entry.id, entry);
          saveActivity(entry, seen ? new Set() : taskIds);
        }
      }
      if (child && child !== lead && codexThreadPattern.test(child) &&
          ([...assigned.values()].includes(child) || activity.has(child) || children.has(child)) &&
          message.method?.startsWith("item/")) {
        const started = message.method === "item/started" || message.method === "item/autoApprovalReview/started";
        childItem(child, message.method, event, started ? new Date().toISOString() : undefined);
      }
      if (!lead || event?.threadId !== lead || !item) return;
      if (message.method === "item/completed" && item.type === "collabAgentToolCall" &&
          item.status === "completed" && ["spawnAgent", "resumeAgent", "followupTask"].includes(item.tool ?? "")) {
        for (const child of item.receiverThreadIds ?? []) {
          children.set(child, child);
          if (item.tool !== "spawnAgent") completed.delete(child);
        }
      }
      if (message.method === "item/completed" && item.type === "collabAgentToolCall" && item.tool === "wait") {
        for (const [child, state] of Object.entries(item.agentsStates ?? {})) {
          if (children.has(child) && state.status === "completed") completed.add(children.get(child)!);
        }
      }
      if ((message.method === "item/started" || message.method === "item/completed") && item.type === "subAgentActivity" &&
          item.agentThreadId) {
        children.set(item.agentThreadId, item.agentThreadId);
        if (item.agentPath) children.set(item.agentPath, item.agentThreadId);
        if (item.kind === "completed") completed.add(item.agentThreadId);
        else if (item.kind === "started" || item.kind === "interrupted") completed.delete(item.agentThreadId);
      }
    },
    async report(args: unknown) {
      const input = args as Record<string, unknown>;
      const taskId = id ?? input.id;
      if (typeof taskId !== "string") return Promise.resolve(cliFailure("INVALID_INPUT", "Supply the task ID."));
      const agentId = typeof input.agentId === "string" ? children.get(input.agentId) : undefined;
      if (input.agentId !== undefined && !agentId)
        return Promise.resolve(cliFailure("EXPERT_AGENT_UNCONFIRMED", "Use a specialist ID observed by the provider in this responsible agent's native collaboration."));
      if (input.state === "done" && agentId && !completed.has(agentId))
        return Promise.resolve(cliFailure("EXPERT_AGENT_RUNNING", "Wait for the specialist's completion before submitting its result."));
      if (input.state === "done" && typeof input.key === "string") {
        const proof = await evidence.verify(input, input.key, agentId);
        if (!proof.ok) return proof;
      }
      const updated = await callCli<{ skills?: string[]; expertId: string; package: Expert; run?: { agentId?: string } }>(project, ["expert-stage", taskId], { ...input, agentId, sessionId, threadId,
        actor: phase === "work" ? "agent" : id ? "reviewer" : "manager", phase,
        targetHead: id ? targetHead : input.targetHead });
      if (!updated.ok) return updated;
      const key = taskId + ":" + input.key;
      if (input.state === "running") open.set(key, taskId);
      if (input.state === "running" && updated.data.run?.agentId) {
        assigned.set(key, updated.data.run.agentId);
        const child = updated.data.run.agentId;
        for (const item of activity.get(child)?.values() ?? []) {
          saveActivity({ ...item, id: child + ":" + item.id, stageChild: true }, new Set([taskId]));
        }
        schedule();
      } else if (input.state !== "running") {
        const child = agentId ?? assigned.get(key);
        if (child) await readChild(child, true);
        assigned.delete(key);
        open.delete(key);
        journals.get(taskId)?.flush();
      }
      if (input.state !== "running") return updated;
      const skills = new Set(updated.data.skills);
      if (updated.data.package.skills.some(skill => skill.id === "workflow")) skills.add("workflow");
      if (!skills.size) return updated;
      const assignedSkills = [];
      for (const skillId of skills) {
        const skill = await callCli(project, ["expert-skill", ...(id ? [id] : [])],
          { expertId: updated.data.expertId, skillId, actor: phase === "work" ? "agent" : id ? "reviewer" : "manager", source: "plan" });
        if (!skill.ok) return skill;
        assignedSkills.push(skill.data);
      }
      return { ...updated, data: { ...updated.data, assignedSkills } };
    },
  };
}

export async function subagentInstructions(request: <T>(method: string, params: object) => Promise<T>) {
  try {
    const features = await request<{ data: { name: string; enabled: boolean }[] }>("experimentalFeature/list", { limit: 200 });
    if (features.data.some(feature => ["multi_agent", "multi_agent_v2"].includes(feature.name) && feature.enabled))
      return "Native subagents are enabled in this Codex App Server. Use its spawn, messaging and wait tools for the assigned specialist stages.";
  } catch {
    // Older servers may not expose feature discovery.
  }
  return "If the provider exposes native spawn tools, use them for the assigned specialist stages. Otherwise complete the stages yourself using their specialization packages.";
}
