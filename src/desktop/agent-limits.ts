import type { AgentLimits } from "../cli/model.ts";
import { inheritedLimits } from "../cli/settings-notices.ts";
import { deferExecutor, registerRuntime, runtimeEntries, runtimeLocation, runtimeTransaction } from "./board-runtime.ts";
import type { DeferredExecutor, RuntimeEntry } from "./board-runtime.ts";
import { projectIdentity } from "./project-tabs.ts";
import { readBoardSettings } from "../cli/storage.ts";

export const defaultAgentLimits: AgentLimits = inheritedLimits;
export type AgentRole = keyof AgentLimits;

const defaultsId = "task-defaults-v2";

export function cachedTaskLimits(entries: RuntimeEntry[]): AgentLimits | undefined {
  const current = entries.find(entry => entry.id === defaultsId)?.limits;
  if (current) return current;
  const legacy = entries.find(entry => entry.id === "task-defaults")?.limits;
  // The old cache stored 1/1 even without a profile override. Opening the
  // board republishes the profile's actual values, including an explicit 1/1.
  if (legacy && (legacy.executor !== 1 || legacy.reviewer !== 1)) return legacy;
}

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
  const taskId = (key: string | undefined) => key?.replace(/^review:/, "");
  const savedDefaults = (entries: RuntimeEntry[]) => entries.find(entry => entry.id === defaultsId);
  const inherited = (path: string) => cachedTaskLimits(runtimeEntries(path)) ?? limits;
  const persistDefaults = (path: string, replace = false) => runtimeTransaction(path, entries => {
    const saved = savedDefaults(entries);
    if (saved) { if (replace) saved.limits = { ...limits }; }
    else {
      const next = replace ? limits : cachedTaskLimits(entries) ?? limits;
      const legacy = entries.findIndex(entry => entry.kind === "defaults");
      if (legacy >= 0) entries.splice(legacy, 1);
      entries.push({ id: defaultsId, owner: 0, kind: "defaults", limits: { ...next } });
    }
  });
  const available = (project: string, role: AgentRole, overrides?: Partial<AgentLimits>) => {
    if (role === "manager") return Infinity;
    if (sharedProject) {
      const path = sharedProject(project);
      const entries = runtimeEntries(path);
      const limit = readBoardSettings(runtimeLocation(path)).taskLimits?.[role] ??
        cachedTaskLimits(entries)?.[role] ?? limits[role];
      return limit === 0 ? Infinity : Math.max(0, limit - entries.filter(entry => entry.kind === "slot" && entry.role === role).length);
    }
    const limit = overrides?.[role] ?? limits[role];
    return limit === 0 ? Infinity : Math.max(0, limit - (active.get(project)?.[role] ?? 0));
  };
  return {
    remember(project: string, refreshDefaults = false) {
      if (shared) {
        const identity = projectIdentity(project);
        const refresh = refreshDefaults && !projects.has(identity);
        projects.set(identity, project);
        if (refresh || !savedDefaults(runtimeEntries(project))) persistDefaults(project, refresh);
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
    defer(project: string, task: string, pending?: DeferredExecutor, expectedRevision?: number) {
      return sharedProject ? deferExecutor(sharedProject(project), task, pending, expectedRevision) : false;
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
    acquire(project: string, role: AgentRole, overrides?: Partial<AgentLimits>, task?: string, queuedRevision?: number) {
      if (sharedProject) {
        const path = sharedProject(project);
        return registerRuntime(path, { kind: "slot", role, task }, entries => {
          const limit = role === "manager" ? 0 : readBoardSettings(runtimeLocation(path)).taskLimits?.[role] ?? cachedTaskLimits(entries)?.[role] ?? limits[role];
          const queued = entries.find(entry => entry.kind === "queue" && entry.task === task);
          return queued?.revision === queuedRevision && (!task || !entries.some(entry => entry.kind !== "queue" && (entry.task === task ||
            entry.kind === "slot" && entry.role === role && taskId(entry.task) === taskId(task)))) &&
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
