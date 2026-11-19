import { projectIdentity, projectLabels } from "./project-tabs.ts";
import { registerRuntime, runtimeEntries, runtimeLocation } from "./board-runtime.ts";
import type { RuntimeEntry } from "./board-runtime.ts";
import type { AgentLimits } from "../cli/model.ts";
import { cachedTaskLimits, defaultAgentLimits } from "./agent-limits.ts";
import { exists } from "../cli/storage.ts";
import { join } from "node:path";

let shared = false;
export function enableSharedRuns() { shared = true; }
export function trackProvider(project: string, pid?: number) {
  if (!shared || !pid || !exists(join(runtimeLocation(project).directory, "board.json"))) return Object.assign(() => {}, { run: <T>(callback: () => T) => callback() });
  return registerRuntime(project, { kind: "provider", pid })!;
}
export function claimDiscussion(project: string, task?: string) {
  if (!shared || !task) return Object.assign(() => {}, { run: <T>(callback: () => T) => callback() });
  const release = registerRuntime(project, { kind: "task", task }, entries => !entries.some(entry => entry.kind !== "queue" && entry.task === task));
  if (!release) throw new Error("This task already has a running agent in another window.");
  return release;
}

// Provider turns, independent of tabs, task statuses and reserved agent slots.
type Role = "manager" | "executor" | "reviewer";
const runs = new Map<symbol, { path: string; identity: string; role: Role }>();
const listeners = new Set<() => void>();

export function observeActiveRuns(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function trackActiveRun(project: string, role: Role = "executor") {
  const release = shared ? registerRuntime(project, { kind: "turn", role }) : undefined;
  const key = Symbol();
  runs.set(key, { path: project, identity: projectIdentity(project), role });
  for (const listener of listeners) listener();
  return () => {
    release?.();
    if (runs.delete(key)) for (const listener of listeners) listener();
  };
}

function boardOperations(entries: RuntimeEntry[], overrides?: Partial<AgentLimits>) {
  const slots = entries.filter(entry => entry.kind === "slot");
  const backgroundUsesReviewSlot = slots.some(entry => entry.operation && entry.operation !== "mergeRepair");
  const operations = entries.flatMap<{ role: Role; kind: string; task?: string }>(entry => {
    const task = entry.task?.match(/^(?:(?:review|draft):)?(T-\d+)$/)?.[1];
    if (entry.kind === "slot" && entry.role) {
      const kind = entry.operation ?? (entry.role === "reviewer" ? "review" : "execution");
      return [{ role: entry.role, kind, task }];
    }
    if (entry.kind === "task") {
      if (entry.task === "manager:context" || entry.task === "manager:dialogue") {
        const kind = entry.task === "manager:context" ? "goal" : "managerConversation";
        return [{ role: "manager" as const, kind, task }];
      }
      if (entry.task === "manager:background" && !backgroundUsesReviewSlot) {
        const kind = entry.state?.lane === "maintenance" ? "maintenance" : "boardAutomation";
        return [{ role: "manager" as const, kind, task }];
      }
      if (task) return [{ role: "executor" as const, kind: "discussion", task }];
    }
    return [];
  });
  const inherited = cachedTaskLimits(entries) ?? defaultAgentLimits;
  const occupancy = (role: "executor" | "reviewer") => ({
    used: slots.filter(entry => entry.role === role).length,
    limit: overrides?.[role] ?? inherited[role],
  });
  return {
    executor: occupancy("executor"),
    reviewer: occupancy("reviewer"),
    managerBusy: entries.some(entry => entry.kind === "task" && entry.task === "manager:dialogue"),
    operations,
  };
}

export function activeRunSummary(projects: { path: string; name?: string; taskLimits?: Partial<AgentLimits> }[] = []) {
  const boards = new Map<string, { path: string; name?: string; count: number; roles: Record<Role, number> }>();
  const snapshots = shared ? projects.map(project => ({ ...project, entries: runtimeEntries(project.path) })) : [];
  const observed = shared ? snapshots.flatMap(project => project.entries
    .filter(entry => entry.kind === "turn").map(entry => ({ path: project.path, identity: projectIdentity(project.path), role: entry.role ?? "executor" }))) : [...runs.values()];
  for (const run of observed) {
    const board = boards.get(run.identity);
    if (board) { board.count++; board.roles[run.role]++; }
    else boards.set(run.identity, { path: run.path, count: 1, roles: { manager: 0, executor: 0, reviewer: 0, [run.role]: 1 },
      name: projects.find(project => projectIdentity(project.path) === run.identity)?.name });
  }
  const entries = [...boards.values()];
  return {
    total: observed.length,
    boards: projectLabels(entries).map((label, index) =>
      ({ ...label, count: entries[index].count, roles: entries[index].roles })),
    details: projectLabels(snapshots).map((label, index) => ({
      ...label,
      ...boardOperations(snapshots[index].entries, snapshots[index].taskLimits),
    })),
  };
}
