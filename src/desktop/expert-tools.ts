import { randomUUID } from "node:crypto";
import { callCli, cliFailure } from "./cli.ts";
import { skillEvidence } from "./skill-evidence.ts";
import type { RpcMessage } from "./codex-rpc.ts";
import type { Expert } from "../cli/experts.ts";
import type { ExpertPhase } from "../cli/model.ts";

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
  expert_stage: { description: "Start, block, or finish an assigned stage. Returns the specialist package and prerequisite results. For done, provide each exact output. For artifactOutputs, give the path of the individual file relative to the worktree. For delegated work, give the actual provider agent ID.",
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
  "As manager, before planning a sprint or doing domain work, use expert_list to choose the necessary specializations yourself, then expert_context " +
  "(for example business-analyst and product-owner) and expert_skill for the relevant methods. Load at most six distinct IDs per expert_context call. Choose the roles needed now and load later roles when their phase begins; " +
  "they never change your process authority or tool permissions. Before launching or queuing work, save the expert_plan for work and review on the same card. " +
  "Use one responsible specialization for a simple phase, with stages only where another distinct deliverable or expertise is needed. " +
  "Run ready cards in parallel when their worktrees, write scopes and exclusive resources allow it. Use card dependencies for required results and queue holds for temporary resource contention. Run the final integration check after its prerequisites. " +
  "The responsible agent completes stages of its own specialization directly. Expect a native subagent for a different specialization when the provider supports it. " +
  "Read the updated card revision after each plan change. Give each stage explicit inputs, outputs, criteria and dependencies. " +
  "Assign a skill explicitly in skills only with a concrete action in skillChecks for its ID. Choose the exact command or tool with any required arguments from the skill's actual procedure. The general workflow is already delivered by default. " +
  "For a visible UI change, plan a verification work stage with PNG outputs for relevant viewports or window sizes and a text report of the key interaction. Specify the screens, sizes, states, and visible outcomes to verify. Let the review phase inspect these materials against those criteria. " +
  "Each specialization is one shared package, with no expert-specific model or permanent agent identity. " +
  "Use team_inbox/team_message for peer coordination and questions to manager or owner. A question to owner needs a human answer; do not invent it. " +
  "Use team_findings to reuse confirmed diagnoses across cards. Check the stated environment before applying a finding to a new task. " +
  "When an owner decision unblocks the card, resume its responsible lead through the normal board lifecycle. " +
  "Do not globally install skills or enable provider plugins. Read only the skills relevant to this phase and use their returned board paths.";

export const leadInstructions = "You are responsible for this card's current phase and its final result. Apply the assigned lead specialization and read your team inbox before delegating or reporting a decision. " +
  "Read the current revision and recorded stage states before opening work with expert_stage. On REVISION_CONFLICT, reread the card and reconcile changed requirements before retrying. A completed stage already has a result; reuse it. After collecting the result, use expert_stage with state done, a summary, and an outputs object keyed by each exact declared output. For delegated work pass the actual child agent ID after waiting for its result. " +
  "Apply the preloaded lead skills. If your lead has explicit skillChecks in this phase, perform them and call expert_verify_skills before submitting or approving when the tool is available. The implicit workflow alone requires no verification call. Load the delegated specialist's assigned skills via expert_skill and pass the actual instructions and assigned actions to the specialist. For a stage with assigned skills, the specialist must perform the actions personally and return JSON with an outputs object keyed by the exact declared output names. Pass those outputs unchanged to expert_stage. Handle your own stages yourself and reuse the same native subagent for later stages of its specialization. " +
  "Run only independent, non-conflicting stages in parallel. Wait for prerequisites and pass their results to dependent specialists. Use the provider's messaging and wait mechanisms to coordinate. " +
  "For declared artifact outputs, save individual evidence files in the task's ignored .tasks/qa/ directory. Finish the stage with a path for each declared artifact output. Capture from the same sources you will submit. Open saved screenshots and verify the required state is visible. If a capture is empty or clipped, repair the delivered capture or document the tested replacement in the reproducible QA procedure. If you record source hashes, state whether they cover checked-out bytes or Git blobs and verify them against the submission. Recheck any affected source changed after QA. The board saves the declared outputs with the submission. " +
  "For evidence from external research, verify the comparison against the saved material with no live lookups before the first preview. Each material price, unit and calculating condition must be readable in a short dated source extract or screenshot referenced from that claim. If a claim cannot be checked from the saved evidence, save the missing context or qualify the claim before submission. " +
  "Use team_message for meaningful handoffs and questions between assigned roles. Include the decision or artifact the receiving stage needs and route it to its stage address. Deliver incoming mail from team_inbox to its native agent. If a decision blocks a stage, mark it blocked and leave a persistent question. " +
  "Search team_findings when a failure or diagnostic is likely to recur. Record confirmed reusable causes with the environment and verification. Treat findings from other cards as evidence and recheck applicability when conditions differ. " +
  "If delegation is unavailable or fails, apply the package yourself and give the factual fallback reason when recording its result. Check every result before submitting or giving the review decision. The same task permission and review scope apply to all delegates.";

export function phaseStageReporter(project: string, phase: "work" | "review", id?: string, targetHead?: string | null) {
  const children = new Map<string, string>();
  const completed = new Set<string>();
  const sessionId = randomUUID();
  const evidence = skillEvidence(project, phase, sessionId, id, targetHead);
  return {
    bind: evidence.bind,
    verify(args: unknown) { return evidence.verify(args as Record<string, unknown>); },
    observe(message: RpcMessage, lead: string | undefined) {
      if (lead) evidence.observe(message, lead);
      const event = message.params as { threadId?: string; item?: { type?: string; tool?: string; status?: string;
        receiverThreadIds?: string[]; agentsStates?: Record<string, { status: string }>;
        kind?: string; agentThreadId?: string; agentPath?: string } } | undefined;
      const item = event?.item;
      if (!lead || event?.threadId !== lead || !item) return;
      if (message.method === "item/completed" && item.type === "collabAgentToolCall" &&
          item.tool === "spawnAgent" && item.status === "completed") {
        for (const child of item.receiverThreadIds ?? []) children.set(child, child);
      }
      if (message.method === "item/completed" && item.type === "collabAgentToolCall" && item.tool === "wait") {
        for (const [child, state] of Object.entries(item.agentsStates ?? {})) {
          if (children.has(child) && state.status === "completed") completed.add(children.get(child)!);
        }
      }
      if ((message.method === "item/started" || message.method === "item/completed") && item.type === "subAgentActivity" &&
          (item.kind === "started" || item.kind === "completed") && item.agentThreadId) {
        children.set(item.agentThreadId, item.agentThreadId);
        if (item.agentPath) children.set(item.agentPath, item.agentThreadId);
        if (item.kind === "completed") completed.add(item.agentThreadId);
        else completed.delete(item.agentThreadId);
      }
    },
    async report(args: unknown) {
      const input = args as Record<string, unknown>;
      const taskId = id ?? input.id;
      if (typeof taskId !== "string") return Promise.resolve(cliFailure("INVALID_INPUT", "Supply the task ID."));
      const agentId = typeof input.agentId === "string" ? children.get(input.agentId) : undefined;
      if (input.agentId !== undefined && !agentId)
        return Promise.resolve(cliFailure("EXPERT_AGENT_UNCONFIRMED", "Use a specialist ID from this responsible agent's observed native spawn."));
      if (input.state === "done" && agentId && !completed.has(agentId))
        return Promise.resolve(cliFailure("EXPERT_AGENT_RUNNING", "Wait for the specialist's completion before submitting its result."));
      if (input.state === "done" && typeof input.key === "string") {
        const proof = await evidence.verify(input, input.key, agentId);
        if (!proof.ok) return proof;
      }
      const updated = await callCli<{ skills?: string[]; expertId: string }>(project, ["expert-stage", taskId], { ...input, agentId, sessionId,
        actor: phase === "work" ? "agent" : id ? "reviewer" : "manager", phase,
        targetHead: id ? targetHead : input.targetHead });
      if (!updated.ok || input.state !== "running" || !updated.data.skills?.length) return updated;
      const assignedSkills = [];
      for (const skillId of updated.data.skills) {
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
