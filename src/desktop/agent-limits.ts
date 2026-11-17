import type { AgentLimits } from "../cli/model.ts";
import { inheritedLimits } from "../cli/settings-notices.ts";
import { registerRuntime, runtimeEntries, runtimeLocation, runtimeTransaction } from "./board-runtime.ts";
import { projectIdentity } from "./project-tabs.ts";
import { readBoardSettings } from "../cli/storage.ts";

export const defaultAgentLimits: AgentLimits = inheritedLimits;
export type AgentRole = keyof AgentLimits;

export function parseAgentLimits(value: unknown): AgentLimits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { executor, reviewer } = value as AgentLimits;
  const manager = 0;
  if (![executor, manager, reviewer].every(limit => Number.isSafeInteger(limit) && limit >= 0)) return;
  return { executor, manager, reviewer };
}

export function createAgentSlots(shared = false) {
  const projects = new Map<string, string>();
  const sharedProject = shared ? (identity: string) => projects.get(identity) ?? identity : undefined;
  let limits = { ...defaultAgentLimits };
  const active = new Map<string, AgentLimits>();
  const inherited = (path: string) => runtimeEntries(path).find(entry => entry.kind === "defaults")?.limits ?? limits;
  const persistDefaults = (path: string, replace = false) => runtimeTransaction(path, entries => {
    const saved = entries.find(entry => entry.kind === "defaults");
    if (saved) { if (replace) saved.limits = { ...limits }; }
    else entries.push({ id: "defaults", owner: 0, kind: "defaults", limits: { ...limits } });
  });
  const available = (project: string, role: AgentRole, overrides?: Partial<AgentLimits>) => {
    if (role === "manager") return Infinity;
    if (sharedProject) {
      const path = sharedProject(project);
      const entries = runtimeEntries(path);
      const limit = readBoardSettings(runtimeLocation(path)).agentLimits?.[role] ??
        entries.find(entry => entry.kind === "defaults")?.limits?.[role] ?? limits[role];
      return limit === 0 ? Infinity : Math.max(0, limit - entries.filter(entry => entry.kind === "slot" && entry.role === role).length);
    }
    const limit = overrides?.[role] ?? limits[role];
    return limit === 0 ? Infinity : Math.max(0, limit - (active.get(project)?.[role] ?? 0));
  };
  return {
    remember(project: string) {
      if (shared) {
        projects.set(projectIdentity(project), project);
        if (!runtimeEntries(project).some(entry => entry.kind === "defaults")) persistDefaults(project);
      }
    },
    claim(project: string, task: string) {
      if (sharedProject) return registerRuntime(sharedProject(project), { kind: "task", task },
        entries => !entries.some(entry => entry.kind !== "queue" && entry.task === task));
      return Object.assign(() => {}, { run: <T>(callback: () => T) => callback() });
    },
    inherited(project: string) { return sharedProject ? inherited(sharedProject(project)) : limits; },
    update(project: string, task: string, state: import("./board-runtime.ts").RuntimeEntry["state"]) {
      if (sharedProject) runtimeTransaction(sharedProject(project), entries => {
        const entry = entries.find(entry => entry.owner === process.pid && entry.task === task && (entry.kind === "slot" || entry.kind === "task"));
        if (entry) entry.state = state;
      });
    },
    defer(project: string, task: string, pending?: { revision: number; continuation?: { afterDisconnect?: boolean; withoutProgress?: boolean } }) {
      if (sharedProject) runtimeTransaction(sharedProject(project), entries => {
        const index = entries.findIndex(entry => entry.kind === "queue" && entry.task === task);
        if (index >= 0) entries.splice(index, 1);
        if (pending) entries.push({ id: "queue:" + task, owner: 0, kind: "queue", task, ...pending });
      });
    },
    entries(project: string) { return sharedProject ? runtimeEntries(sharedProject(project)) : []; },
    busy(project: string, task: string) {
      return sharedProject ? runtimeEntries(sharedProject(project)).some(entry => entry.kind !== "queue" && entry.task === task) : false;
    },
    get limits() { return { ...limits }; },
    configure(next: AgentLimits) {
      limits = { ...next, manager: 0 };
      if (shared) for (const path of projects.values()) persistDefaults(path, true);
    },
    available,
    acquire(project: string, role: AgentRole, overrides?: Partial<AgentLimits>, task?: string) {
      if (sharedProject) {
        const path = sharedProject(project);
        return registerRuntime(path, { kind: "slot", role, task }, entries => {
          const limit = role === "manager" ? 0 : readBoardSettings(runtimeLocation(path)).agentLimits?.[role] ?? entries.find(entry => entry.kind === "defaults")?.limits?.[role] ?? limits[role];
          return (!task || !entries.some(entry => entry.kind !== "queue" && entry.task === task)) &&
            (limit === 0 || entries.filter(entry => entry.kind === "slot" && entry.role === role).length < limit);
        });
      }
      if (!available(project, role, overrides)) return;
      const counts = active.get(project) ?? { executor: 0, manager: 0, reviewer: 0 };
      counts[role]++;
      active.set(project, counts);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        counts[role]--;
        if (Object.values(counts).every(count => count === 0)) active.delete(project);
      };
      return Object.assign(release, { run: <T>(callback: () => T) => callback() });
    },
  };
}
