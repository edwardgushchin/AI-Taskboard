import { randomUUID } from "node:crypto";
import { callCli, cliFailure } from "./cli.ts";
import type { RpcMessage } from "./codex-rpc.ts";

const s = { type: "string", minLength: 1 };
const list = { type: "array", items: s };
const task = { id: s };
export const expertActions = {
  expert_list: { description: "Find board-owned expert specializations. Search by profession or domain before choosing your own roles or assigning stages. Nothing is installed in Codex or Claude.",
    properties: { query: { type: "string" } }, required: [] },
  expert_context: { description: "Apply one or several expert specializations to your current phase. Returns their system instructions and available board-local skills. Keep your existing manager/executor/reviewer authority. Load relevant skills explicitly; reconsider the selection when the phase changes.",
    properties: { ids: { ...list, minItems: 1, maxItems: 6, uniqueItems: true } }, required: ["ids"] },
  expert_skill: { description: "Read and materialize a skill in the expert's board-owned directory, including bundled scripts and references. Use returned absolute paths. This does not install provider plugins, dependencies or grant tool access.",
    properties: { expertId: s, skillId: s }, required: ["expertId", "skillId"] },
  expert_plan: { description: "Assign the responsible lead's specialization and specialist stages to the work or review phase of one card. Stage keys are stable, dependencies reference stage keys, the lead delegates the stages within its session. Use an empty stages array to set only the lead. Plan both phases before launch when possible.",
    properties: { ...task, revision: { type: "integer", minimum: 1 }, phase: { type: "string", enum: ["work", "review"] },
      lead: { type: ["string", "null"] }, replace: { type: "boolean" }, stages: { type: "array", maxItems: 32, items: {
      type: "object", properties: { key: s, expertId: s, title: s, description: { type: "string" },
        criteria: { ...list, minItems: 1 }, inputs: list, outputs: { ...list, minItems: 1 }, dependsOn: list },
      required: ["key", "expertId", "title", "criteria", "outputs"], additionalProperties: false } } }, required: ["id", "revision", "stages"] },
  expert_stage: { description: "Start, block, or finish a stage in your assigned phase. Start before working. Returns the specialist package and prerequisite results. For done, provide evidence for every exact declared output and the provider agent ID when delegated. For local execution of another specialization, give the actual fallback reason.",
    properties: { ...task, phase: { type: "string", enum: ["work", "review"] }, targetHead: { type: ["string", "null"] },
      revision: { type: "integer", minimum: 1 }, key: s, state: { type: "string", enum: ["running", "blocked", "done"] },
      result: s, outputs: { type: "object", additionalProperties: s }, agentId: s, fallback: s },
    required: ["id", "revision", "key", "state"] },
  team_inbox: { description: "Read the task team's stage status, results and addressed mail. Use afterSequence to avoid rereading mail.",
    properties: { ...task, afterSequence: { type: "integer", minimum: 0 } }, required: ["id"] },
  team_message: { description: "Send persistent mail to a stage address like work:verify, a legacy stage card, manager, owner, or team. The lead may relay mail from its own phase using stage. Use question for an answer and replyTo to retain the conversation.",
    properties: { ...task, to: s, stage: s, text: { ...s, maxLength: 4000 }, kind: { type: "string", enum: ["update", "question", "decision"] }, replyTo: { type: "integer", minimum: 1 } },
    required: ["id", "to", "text"] },
};
export const expertCommands: Record<string, string> = { expert_list: "experts", expert_context: "expert-context", expert_skill: "expert-skill",
  expert_plan: "expert-plan", expert_stage: "expert-stage", team_inbox: "expert-inbox", team_message: "expert-message" };
export const executorExpertTools = Object.entries(expertActions).filter(([name]) => name !== "expert_plan").map(([name, action]) => {
  const properties: Record<string, unknown> = { ...action.properties };
  for (const key of ["id", "phase", "targetHead"]) delete properties[key];
  return { name, description: action.description, inputSchema: { type: "object", properties,
    required: action.required.filter(name => name !== "id"), additionalProperties: false } };
});
export const expertInstructions = "Board experts are internal instruction packages, never Codex/Claude plugins. Apply these instructions when the corresponding expert/team tools are provided. " +
  "As manager, before planning a sprint or doing domain work, use expert_list to choose the necessary specializations yourself, then expert_context " +
  "(for example business-analyst and product-owner) and expert_skill for the relevant methods. You may combine or change specializations for the current phase; " +
  "they never change your process authority or tool permissions. Before launching or queuing work, save the expert_plan for work and review on the same card. " +
  "Use one responsible specialization for a simple phase, with stages only where another distinct deliverable or expertise is needed. " +
  "The responsible agent completes stages of its own specialization directly. Expect a native subagent for a different specialization when the provider supports it. " +
  "Read the updated card revision after each plan change. Give each stage explicit inputs, outputs, criteria and dependencies. " +
  "Each specialization is one shared package, with no expert-specific model or permanent agent identity. " +
  "Use team_inbox/team_message for peer coordination and questions to manager or owner. A question to owner needs a human answer; do not invent it. " +
  "When an owner decision unblocks the card, resume its responsible lead through the normal board lifecycle. " +
  "Do not globally install skills or enable provider plugins. Read only the skills relevant to this phase and use their returned board paths.";

export const leadInstructions = "You are responsible for this card's current phase and its final result. Apply the assigned lead specialization and read your team inbox before delegating or reporting a decision. " +
  "Read the current revision and recorded stage states before opening work with expert_stage. On REVISION_CONFLICT, reread the card and reconcile changed requirements before retrying. A completed stage already has a result; reuse it. After collecting the result, use expert_stage with state done, a summary, and an outputs object keyed by each exact declared output. For delegated work pass the actual child agent ID after waiting for its result. " +
  "Load the assigned package's workflow skill if present and any other relevant skills via expert_skill before delegation. Pass the prompt, applicable skill instructions or readable skill paths, scope, inputs and outputs to the specialist. Ask the specialist to report which skills it actually used and what they contributed. Handle your own stages yourself and reuse the same native subagent for later stages of its specialization. " +
  "Run only independent, non-conflicting stages in parallel. Wait for prerequisites and pass their results to dependent specialists. Use the provider's messaging and wait mechanisms to coordinate. " +
  "Use team_message for meaningful handoffs and questions between assigned roles. Include the decision or artifact the receiving stage needs and route it to its stage address. Deliver incoming mail from team_inbox to its native agent. If a decision blocks a stage, mark it blocked and leave a persistent question. " +
  "If delegation is unavailable or fails, apply the package yourself and give the factual fallback reason when recording its result. Check every result before submitting or giving the review decision. The same task permission and review scope apply to all delegates.";

export function phaseStageReporter(project: string, phase: "work" | "review", id?: string, targetHead?: string | null) {
  const children = new Map<string, string>();
  const completed = new Set<string>();
  const sessionId = randomUUID();
  return {
    observe(message: RpcMessage, lead: string | undefined) {
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
    report(args: unknown) {
      const input = args as Record<string, unknown>;
      const taskId = id ?? input.id;
      if (typeof taskId !== "string") return Promise.resolve(cliFailure("INVALID_INPUT", "Supply the task ID."));
      const agentId = typeof input.agentId === "string" ? children.get(input.agentId) : undefined;
      if (input.agentId !== undefined && !agentId)
        return Promise.resolve(cliFailure("EXPERT_AGENT_UNCONFIRMED", "Use a specialist ID from this responsible agent's observed native spawn."));
      if (input.state === "done" && agentId && !completed.has(agentId))
        return Promise.resolve(cliFailure("EXPERT_AGENT_RUNNING", "Wait for the specialist's completion before submitting its result."));
      return callCli(project, ["expert-stage", taskId], { ...input, agentId, sessionId,
        actor: phase === "work" ? "agent" : id ? "reviewer" : "manager", phase,
        targetHead: id ? targetHead : input.targetHead });
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
