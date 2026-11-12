import type { RunActivity } from "../cli/model.ts";

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bounded(value: string): string {
  return value.length > 24_000 ? value.slice(0, 24_000) + "\n[…]" : value;
}

export function runActivity(entries: Map<string, RunActivity>, method: string, params: Record<string, unknown>): RunActivity | undefined {
  if (method === "item/started" || method === "item/completed") {
    const item = params.item as Record<string, unknown> | undefined;
    const id = string(item?.id);
    const type = string(item?.type);
    if (!item || !id || !type || type === "userMessage") return;
    const previous = entries.get(id);
    const status = string(item.status) || (method === "item/completed" ? "completed" : "inProgress");
    if (type === "agentMessage" || type === "plan") {
      return { id, type, title: "", text: bounded(string(item.text) || previous?.text || ""), status };
    }
    if (type === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary.map(string).join("\n") : "";
      return { id, type, title: "", text: bounded(summary || previous?.text || ""), status };
    }
    if (type === "commandExecution") {
      const output = string(item.aggregatedOutput) || previous?.text || "";
      const exit = typeof item.exitCode === "number" ? "\nExit code: " + item.exitCode : "";
      return { id, type, title: bounded(string(item.command)), text: bounded(output + exit), status };
    }
    const { id: _id, type: _type, status: _status, ...details } = item;
    const title = [string(item.server), string(item.tool)].filter(Boolean).join(" / ") || string(item.query);
    const result = JSON.stringify(details, null, 2);
    return { id, type, title: bounded(title), text: bounded(result), status };
  }
  const [itemType, update] = method.slice("item/".length).split("/");
  if (!["delta", "outputDelta", "progress", "summaryTextDelta"].includes(update)) return;
  const id = string(params.itemId);
  if (!id || (itemType === "reasoning" && update !== "summaryTextDelta")) return;
  const delta = string(params.delta) || string(params.message);
  if (!delta) return;
  const previous = entries.get(id) ?? { id, type: itemType, title: "", text: "", status: "inProgress" };
  const separator = update === "progress" && previous.text ? "\n" : "";
  return { ...previous, text: bounded(previous.text + separator + delta) };
}

export function runLog(entries: Map<string, RunActivity>): RunActivity[] {
  const result: RunActivity[] = [];
  let remaining = 900_000;
  for (const item of Array.from(entries.values()).reverse()) {
    if (!item.text && !item.title) continue;
    remaining -= Buffer.byteLength(JSON.stringify(item)) + 1;
    if (remaining < 0) {
      result.push({ id: "truncated", type: "truncated", title: "", text: "", status: "" });
      break;
    }
    result.push(item);
  }
  return result.reverse();
}
