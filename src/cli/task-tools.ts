import { requireRevision, requireState, TaskboardError, text } from "./model.ts";
import type { Task } from "./model.ts";
import { sendTaskMessage } from "./task-messages.ts";

export function toolReference(input: Record<string, unknown>) {
  const server = text(input.server, "server", true);
  const tool = text(input.tool, "tool", true);
  if ([server, tool].some(value => value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) || server === "ai_taskboard") {
    throw new TaskboardError("INVALID_INPUT", "Choose an external provider server and tool from provider_tools.");
  }
  return { server, tool };
}

export function requestTaskTool(task: Task, input: Record<string, unknown>) {
  const ref = toolReference(input);
  const reason = text(input.reason, "reason", true);
  return sendTaskMessage(task, { kind: "question", text: `Tool requested: ${JSON.stringify(ref)}. ${reason}` }, "agent");
}

export function grantTaskTool(task: Task, input: Record<string, unknown>, revoke = false) {
  requireRevision(task, input.revision, true);
  requireState(task, ["ready", "in_progress", "blocked"]);
  const ref = toolReference(input);
  const grants = task.toolGrants ?? [];
  if (revoke) {
    const remaining = grants.filter(entry => entry.server !== ref.server || entry.tool !== ref.tool);
    if (remaining.length === grants.length) return task;
    return sendTaskMessage({ ...task, toolGrants: remaining, revision: task.revision + 1, updatedAt: new Date().toISOString() }, {
      kind: "decision", text: `Tool assignment removed: ${JSON.stringify(ref)}. Restart this task run to apply the change.`,
    }, "manager");
  }
  if (grants.some(entry => entry.server === ref.server && entry.tool === ref.tool)) return task;
  if (grants.length >= 256) throw new TaskboardError("INVALID_INPUT", "A task can have at most 256 tool assignments.");
  const updated = { ...task, toolGrants: [...grants, ref], revision: task.revision + 1, updatedAt: new Date().toISOString() };
  return sendTaskMessage(updated, { kind: "decision", text: `Tool assignment saved: ${JSON.stringify(ref)}. Restart this task run to apply it. Availability and provider authorization will be checked at launch; no hot connection was performed.` }, "manager");
}
