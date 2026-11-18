import { isDeepStrictEqual } from "node:util";
import { locateBoard, onBoard } from "../cli/storage.ts";
import { requireRevision, requireState, TaskboardError } from "../cli/model.ts";
import type { SkillCheck, TaskEvent } from "../cli/model.ts";
import { skillProofScope, expertStagesStatus } from "../cli/expert-team.ts";
import { verifyReviewDecision } from "../cli/acceptance.ts";
import { cliFailure } from "./cli.ts";
import type { RpcMessage } from "./codex-rpc.ts";

type Request = <T>(method: string, params: object) => Promise<T>;
type EvidenceItem = { id: string; type: string; status?: string; command?: string; exitCode?: number;
  tool?: string; server?: string; arguments?: Record<string, unknown>; success?: boolean;
  result?: { isError?: boolean } | null; error?: unknown; text?: string; phase?: string };
type Observed = { item: EvidenceItem; at: number };

function actionMatches(item: EvidenceItem, check: SkillCheck) {
  if ("command" in check) {
    if (item.type !== "commandExecution" || item.status !== "completed" || item.exitCode !== 0 || typeof item.command !== "string") return false;
    const cmd = item.command.trim();
    const payload = /^(?:"?[^"\s]*[/\\]|"[^"]*[/\\])?(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+(.+)$/is.exec(cmd)?.[1] ??
      /^(?:"?[^"\s]*\/)?(?:bash|sh|zsh)"?\s+-[lc]+\s+(.+)$/s.exec(cmd)?.[1];
    return cmd === check.command || payload === check.command || payload === '"' + check.command + '"' || payload === "'" + check.command + "'";
  }
  const successful = item.type === "dynamicToolCall" ? item.success === true :
    item.type === "mcpToolCall" && item.status === "completed" && !!item.result && !item.error && item.result.isError !== true;
  return successful && item.tool === check.tool && item.server === check.server &&
    Object.entries(check.arguments ?? {}).every(([name, value]) => isDeepStrictEqual(item.arguments?.[name], value));
}

export function skillEvidence(project: string, phase: "work" | "review", sessionId: string, assignedTask?: string, head?: string | null) {
  const observed = new Map<string, Map<string, Observed>>();
  let provider: Request | undefined;
  let lead: string | undefined;
  const bind = (request: Request, threadId: string) => { provider = request; lead = threadId; };
  const observe = (event: RpcMessage, leadId: string) => {
    const data = event.params as { threadId?: string; item?: EvidenceItem } | undefined;
    if (event.method !== "item/completed" || !data?.threadId || !data.item?.id) return;
    const { id, type, status, command, exitCode, tool, server, arguments: args, success, result, error, text, phase } = data.item;
    if (!["commandExecution", "mcpToolCall", "dynamicToolCall", "agentMessage"].includes(type)) return;
    if (!lead) lead = leadId;
    const items = observed.get(data.threadId) ?? new Map<string, Observed>();
    items.set(id, { item: { id, type, status, command, exitCode, tool, server, arguments: args, success,
      result: result ? { isError: result.isError } : result, error: !!error, text, phase }, at: Date.now() });
    observed.set(data.threadId, items);
  };
  async function itemsFor(id: string, since: number, delegated: boolean) {
    const items = new Map([...observed.get(id)?.entries() ?? []].filter(([, entry]) => entry.at >= since));
    if (!delegated || !provider) return [...items.values()].map(entry => entry.item);
    let cursor: string | null = null;
    do {
      const page: { data: { item: EvidenceItem; startedAtMs?: number | null; completedAtMs?: number | null }[]; nextCursor: string | null } =
        await provider("thread/items/list", { threadId: id, cursor, limit: 100, sortDirection: "desc" });
      let older = false;
      for (const entry of page.data) {
        const at = entry.startedAtMs ?? entry.completedAtMs;
        if (typeof at !== "number") continue;
        if (at < since) { older = true; continue; }
        if (!items.has(entry.item.id)) items.set(entry.item.id, { item: entry.item, at });
      }
      cursor = older ? null : page.nextCursor;
    } while (cursor);
    return [...items.values()].sort((a, b) => a.at - b.at).map(entry => entry.item);
  }
  const verify = async (input: Record<string, unknown>, key?: string, child?: string) => {
    const id = assignedTask ?? input.id;
    const agentId = child ?? lead;
    const targetHead = phase === "review" ? (assignedTask ? head : input.targetHead) as string | null : undefined;
    if (typeof id !== "string") return cliFailure("INVALID_INPUT", "Supply the card being verified.");
    const location = locateBoard(project);
    const snapshot = () => onBoard(location, store => {
      const task = store.card(id);
      requireState(task, phase === "work" ? ["in_progress"] : ["review"]);
      requireRevision(task, input.revision, true);
      if (phase === "review") verifyReviewDecision(store, task, targetHead);
      const stage = key ? expertStagesStatus(task, phase, targetHead).find(entry => entry.key === key) : undefined;
      const started = key ? task.history.findLast(event => event.expertStageRun?.key === key &&
        event.expertStageRun.phase === phase && event.expertStageRun.targetHead === targetHead && event.expertStageRun.state === "running") : undefined;
      const scope = skillProofScope(store, task, phase, key);
      if (scope && key && stage?.state !== "running" && stage?.state !== "done") {
        throw new TaskboardError("EXPERT_STAGE_NOT_RUNNING", "Start the stage before verifying its assigned skill actions.");
      }
      const boundary = started?.expertStageRun?.state === "running" ? started :
        task.history.findLast(event => event.action === (phase === "review" ? "submit" : "start") ||
          ["request-changes", "expert-plan", "update"].includes(event.action));
      return { task, scope, since: boundary ? Date.parse(boundary.at) : Date.parse(task.createdAt) };
    });
    try {
      const { scope, since } = snapshot();
      if (!scope) return { ok: true as const, data: { required: false } };
      if (!agentId) return cliFailure("SKILL_USE_REQUIRED", "The responsible Codex thread is unavailable.");
      const currentReview = !assignedTask && phase === "review" && lead ? [...observed.get(lead)?.values() ?? []]
        .findLast(({ item }) => actionMatches(item, { server: "ai_taskboard", tool: "task_review" })) : undefined;
      if (!assignedTask && phase === "review" && currentReview?.item.arguments?.id !== id) {
        return cliFailure("REVIEW_REQUIRED", "Open this card with task_review before verifying skill actions.");
      }
      const available = await itemsFor(agentId, Math.max(since, currentReview?.at ?? 0), !!child);
      const items = Object.fromEntries(Object.entries(scope.skillChecks).flatMap(([skill, check]) => {
        const match = available.find(item => actionMatches(item, check));
        return match ? [[skill, match.id]] : [];
      }));
      const missing = Object.keys(scope.skillChecks).filter(id => !Object.hasOwn(items, id));
      if (missing.length) return cliFailure("SKILL_USE_REQUIRED", "No successful assigned action by this agent for: " + missing.join(", ") + ".");
      let outputs: Record<string, string> | undefined;
      if (child && scope.outputs) {
        const answer = available.findLast(item => item.type === "agentMessage" && item.phase !== "commentary")?.text;
        try {
          const reported = JSON.parse(answer ?? "").outputs;
          if (!reported || Object.keys(reported).length !== scope.outputs.length ||
              scope.outputs.some(name => !Object.hasOwn(reported, name) || typeof reported[name] !== "string" || !reported[name].trim())) {
            throw new Error();
          }
          outputs = Object.fromEntries(scope.outputs.map(name => [name, reported[name].trim()]));
        } catch {
          return cliFailure("EXPERT_RESULT_MISMATCH", "The assigned specialist must return its outputs as a JSON object named outputs.");
        }
        const claimed = input.outputs as Record<string, string> | undefined;
        if (scope.outputs.some(name => outputs![name] !== claimed?.[name]?.trim())) {
          return cliFailure("EXPERT_RESULT_MISMATCH", "The reported outputs differ from the specialist's own answer.");
        }
      }
      const proof: NonNullable<TaskEvent["expertSkillProof"]> = {
        phase, key, targetHead, agentId, sessionId, expertId: scope.expertId, expertRevision: scope.expertRevision, items, outputs,
      };
      return onBoard(location, store => {
        const task = store.card(id);
        requireState(task, phase === "work" ? ["in_progress"] : ["review"]);
        requireRevision(task, input.revision, true);
        if (phase === "review") verifyReviewDecision(store, task, targetHead);
        if (!isDeepStrictEqual(skillProofScope(store, task, phase, key), scope))
          throw new TaskboardError("REVISION_CONFLICT", "The skill package changed while verifying it. Reload the assignment.");
        store.save({ ...task, history: [...task.history, { at: new Date().toISOString(), action: "expert-skill-proof",
          actor: phase === "work" ? "agent" : assignedTask ? "reviewer" : "manager", expertSkillProof: proof }] });
        return { ok: true as const, data: { agentId, skillItems: items } };
      });
    } catch (error) {
      return cliFailure(error instanceof TaskboardError ? error.code : "SKILL_EVIDENCE_UNAVAILABLE", (error as Error).message);
    }
  };
  return { bind, observe, verify };
}
