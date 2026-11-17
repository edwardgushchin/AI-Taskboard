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
      lead: { type: ["string", "null"] }, stages: { type: "array", maxItems: 32, items: {
      type: "object", properties: { key: s, expertId: s, title: s, description: { type: "string" },
        criteria: { ...list, minItems: 1 }, inputs: list, outputs: { ...list, minItems: 1 }, dependsOn: list },
      required: ["key", "expertId", "title", "criteria", "outputs"], additionalProperties: false } } }, required: ["id", "revision", "stages"] },
  team_inbox: { description: "Read the task team's roster, stage results and addressed mail. The mailbox is persistent and shared by the parent and child cards. Use afterSequence to avoid rereading mail.",
    properties: { ...task, afterSequence: { type: "integer", minimum: 0 } }, required: ["id"] },
  team_message: { description: "Send task-scoped persistent mail to another stage task ID, manager, owner (human board owner), or team. Use question for an answer, replyTo to retain the conversation. No external email or provider chat is used.",
    properties: { ...task, to: s, text: { ...s, maxLength: 4000 }, kind: { type: "string", enum: ["update", "question", "decision"] }, replyTo: { type: "integer", minimum: 1 } },
    required: ["id", "to", "text"] },
};
export const expertCommands: Record<string, string> = { expert_list: "experts", expert_context: "expert-context", expert_skill: "expert-skill",
  expert_plan: "expert-plan", team_inbox: "expert-inbox", team_message: "expert-message" };
export const executorExpertTools = Object.entries(expertActions).filter(([name]) => name !== "expert_plan").map(([name, action]) => {
  const properties: Record<string, unknown> = { ...action.properties }; delete properties.id;
  return { name, description: action.description, inputSchema: { type: "object", properties,
    required: action.required.filter(name => name !== "id"), additionalProperties: false } };
});
export const expertInstructions = "Board experts are internal instruction packages, never Codex/Claude plugins. Apply these instructions when the corresponding expert/team tools are provided. " +
  "As manager, before planning a sprint or doing domain work, use expert_list to choose the necessary specializations yourself, then expert_context " +
  "(for example business-analyst and product-owner) and expert_skill for the relevant methods. You may combine or change specializations for the current phase; " +
  "they never change your process authority or tool permissions. Use expert_plan to assign the lead and specialist stages for work and independent review on the same card. Give each stage explicit inputs, outputs, criteria and dependencies. Each specialization is one shared package, with no expert-specific model or permanent agent identity. " +
  "Use team_inbox/team_message for peer coordination and questions to manager or owner. A question to owner needs a human answer; do not invent it. " +
  "When an owner decision unblocks the card, resume its responsible lead through the normal board lifecycle. " +
  "Do not globally install skills or enable provider plugins. Read only the skills relevant to this phase and use their returned board paths.";

export const leadInstructions = "You are responsible for this card's current phase and its final result. Apply the assigned lead specialization and read your team inbox before delegating or reporting a decision. " +
  "For each specialist stage, load its instructions with expert_context and its relevant skills with expert_skill. " +
  "Handle stages of your own specialization yourself. When native subagents are available, delegate the other specialist stages with the role prompt, skill instructions, scope, inputs and outputs. Reuse the same subagent for stages of the same specialization. " +
  "Run only independent, non-conflicting stages in parallel. Wait for prerequisites and pass their results to dependent specialists. Use the provider's messaging and wait mechanisms to coordinate. " +
  "Relay teammate questions and decisions through team_message, and read replies with team_inbox. Persist useful stage outcomes in team mail or the final report. " +
  "If delegation is unavailable or fails, apply the stage specializations yourself. Check every result before submitting or giving the review decision. The same task permission and review scope apply to all delegates.";

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
