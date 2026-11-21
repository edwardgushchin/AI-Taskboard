import type { RunActivity } from "../cli/model.ts";

// Keep the rendered suffix out of the output reused by later provider snapshots.
const commandResults = new WeakMap<RunActivity, { output: string; exitCode?: number }>();

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bounded(value: string): string {
  return value.length > 24_000 ? value.slice(0, 24_000) + "\n[…]" : value;
}

export function previewRunActivity(item: RunActivity): RunActivity {
  return { ...item, title: bounded(item.title), text: bounded(item.text) };
}

export function runActivity(entries: Map<string, RunActivity>, method: string, params: Record<string, unknown>, at?: string,
  full = false): RunActivity | undefined {
  const limit = full ? (value: string) => value : bounded;
  const item = parseRunActivity(entries, method, params, limit);
  if (item) {
    const previous = entries.get(item.id);
    const firstAt = previous?.at ?? at;
    if (firstAt !== undefined) item.at = firstAt;
    const threadId = previous?.threadId ?? params.threadId;
    if (typeof threadId === "string" && threadId) item.threadId = threadId;
  }
  return item;
}

function parseRunActivity(entries: Map<string, RunActivity>, method: string, params: Record<string, unknown>,
  limit: (value: string) => string): RunActivity | undefined {
  if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    const reviewId = string(params.reviewId);
    const review = params.review as Record<string, unknown> | undefined;
    const status = string(review?.status);
    if (!reviewId || !status) return;
    const action = params.action as Record<string, unknown> | undefined;
    const title = string(action?.command) || string(action?.target) || string(action?.toolName) ||
      string(action?.program) || (action?.permissions ? JSON.stringify(action.permissions) : string(action?.type));
    const text = [string(action?.reason), string(review?.rationale)].filter(Boolean).join("\n");
    return { id: "approval:" + reviewId, type: "autoApprovalReview", title: limit(title), text: limit(text), status };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item as Record<string, unknown> | undefined;
    const id = string(item?.id);
    const type = string(item?.type);
    if (!item || !id || !type || type === "userMessage") return;
    const previous = entries.get(id);
    const status = string(item.status) || (method === "item/completed" ? "completed" : "inProgress");
    if (type === "agentMessage" || type === "plan") {
      const phase = item.phase ?? previous?.phase;
      return { id, type, title: "", text: limit(string(item.text) || previous?.text || ""), status,
        ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}) };
    }
    if (type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map(string).join("\n") : "";
      return { id, type, title: "", text: limit(summary || previous?.text || ""), status };
    }
    if (type === "commandExecution") {
      const prior = previous && commandResults.get(previous);
      const output = string(item.aggregatedOutput) || prior?.output || "";
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : prior?.exitCode;
      return commandResult({ id, type, title: limit(string(item.command) || previous?.title || ""), text: "", status }, output, exitCode, limit);
    }
    const { id: _id, type: _type, status: _status, ...details } = item;
    const title = [string(item.server), string(item.tool)].filter(Boolean).join(" / ") || string(item.query);
    const result = JSON.stringify(details, null, 2);
    return { id, type, title: limit(title), text: limit(result), status };
  }
  const [itemType, update] = method.slice("item/".length).split("/");
  if (itemType === "reasoning" && update === "summaryPartAdded") {
    const previous = entries.get(string(params.itemId));
    if (previous?.text && !previous.text.endsWith("\n")) return { ...previous, text: limit(previous.text + "\n\n") };
    return;
  }
  if (!["delta", "outputDelta", "progress", "summaryTextDelta"].includes(update)) return;
  const id = string(params.itemId);
  if (!id || (itemType === "reasoning" && update !== "summaryTextDelta")) return;
  const delta = string(params.delta) || string(params.message);
  if (!delta) return;
  const previous = entries.get(id) ?? { id, type: itemType, title: "", text: "", status: "inProgress" };
  if (itemType === "commandExecution") {
    const prior = commandResults.get(previous);
    return commandResult({ ...previous }, (prior?.output ?? "") + delta, prior?.exitCode, limit);
  }
  const separator = update === "progress" && previous.text ? "\n" : "";
  return { ...previous, text: limit(previous.text + separator + delta) };
}

function commandResult(item: RunActivity, output: string, exitCode: number | undefined, limit: (value: string) => string) {
  const renderedExit = exitCode === undefined ? "" : "\nExit code: " + exitCode;
  item.text = limit(output + renderedExit);
  if (exitCode !== undefined && exitCode !== 0) item.status = "failed";
  commandResults.set(item, { output: limit(output), exitCode });
  return item;
}

export function runLog(entries: Map<string, RunActivity>, maxBytes = 900_000, keepSummaries = false): RunActivity[] {
  const result: RunActivity[] = [];
  const items = [...entries.values()].reverse().filter(item => item.text || item.title);
  const summaries = new Set<RunActivity>();
  let remaining = maxBytes;
  const size = (item: RunActivity) => Buffer.byteLength(JSON.stringify(item)) + 1;
  if (keepSummaries) {
    // Leave room for recent checks and the final report.
    for (const item of items) {
      if (item.type !== "reasoning" || !item.text.trim() || remaining - size(item) < maxBytes / 2) continue;
      summaries.add(item);
      remaining -= size(item);
    }
  }
  for (const item of items) {
    if (summaries.has(item)) {
      result.push(item);
      continue;
    }
    remaining -= size(item);
    if (remaining < 0) {
      if (result.at(-1)?.type === "truncated") continue;
      result.push({ id: "truncated", type: "truncated", title: "", text: "", status: "" });
      if (!summaries.size) break;
      continue;
    }
    result.push(item);
  }
  return result.reverse();
}
