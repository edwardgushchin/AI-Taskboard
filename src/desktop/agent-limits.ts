import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentLimits } from "../cli/model.ts";
import { inheritedLimits } from "../cli/settings-notices.ts";
import { deferExecutor, registerRuntime, runtimeEntries, runtimeLocation, runtimeTransaction } from "./board-runtime.ts";
import type { DeferredExecutor, RuntimeEntry } from "./board-runtime.ts";
import { projectIdentity } from "./project-tabs.ts";
import { readBoardSettings } from "../cli/storage.ts";

export const desktopAppName = "AI Taskboard";
export const defaultAgentLimits: AgentLimits = inheritedLimits;
export type AgentRole = keyof AgentLimits;

const defaultsId = "task-defaults-v2";
type TaskLimitsPreference = { limits: AgentLimits; savedAt?: number };

const savedDefaults = (entries: RuntimeEntry[]) => entries.find(entry => entry.id === defaultsId);
const isNewerPreference = (current: RuntimeEntry | undefined, preference?: TaskLimitsPreference) =>
  (preference?.savedAt ?? 0) > (current?.limitsSavedAt ?? 0);

export function cachedTaskLimits(entries: RuntimeEntry[], preference?: TaskLimitsPreference): AgentLimits | undefined {
  const current = savedDefaults(entries);
  if (preference && isNewerPreference(current, preference)) return preference.limits;
  if (current?.limits) return current.limits;
  const legacy = entries.find(entry => entry.id === "task-defaults")?.limits;
  // The old cache stored 1/1 even without a profile override. Let callers
  // resolve that ambiguous value from the desktop profile.
  if (legacy && (legacy.executor !== 1 || legacy.reviewer !== 1)) return legacy;
  return preference?.limits;
}

export function parseAgentLimits(value: unknown): AgentLimits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { executor, reviewer } = value as AgentLimits;
  const manager = 0;
  if (![executor, manager, reviewer].every(limit => Number.isSafeInteger(limit) && limit >= 0)) return;
  return { executor, manager, reviewer };
}

function defaultProfile() {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const appData = process.platform === "win32" ? process.env.APPDATA || join(home, "AppData", "Roaming")
    : process.platform === "darwin" ? join(home, "Library", "Application Support")
    : xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(appData, desktopAppName);
}

export function readProfileTaskLimits(profile = defaultProfile()): TaskLimitsPreference | undefined {
  const path = join(profile, "task-limits.json");
  try {
    if (!lstatSync(path).isFile()) return;
    const file = openSync(path, "r");
    try {
      const stat = fstatSync(file);
      if (!stat.isFile()) return;
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      const limits = parseAgentLimits(value);
      if (!limits) return;
      const { savedAt } = value as { savedAt?: number };
      // Older releases only wrote the preference file on explicit save.
      const timestamp = Math.trunc(stat.mtimeMs);
      return { limits, savedAt: typeof savedAt === "number" && Number.isSafeInteger(savedAt) && savedAt > 0
        ? savedAt : timestamp > 0 ? timestamp : undefined };
    } finally {
      closeSync(file);
    }
  } catch {
    return undefined;
  }
}

export function createAgentSlots(shared = false) {
  const projects = new Map<string, string>();
  const sharedProject = shared ? (identity: string) => projects.get(identity) ?? identity : undefined;
  let limits = { ...defaultAgentLimits };
  let preference: TaskLimitsPreference | undefined;
  const active = new Map<string, AgentLimits>();
  const taskId = (key: string | undefined) => key?.replace(/^review:/, "");
  const inherited = (path: string) => cachedTaskLimits(runtimeEntries(path)) ?? limits;
  const persistDefaults = (path: string, replace = false) => runtimeTransaction(path, entries => {
    const saved = savedDefaults(entries);
    const useProfile = isNewerPreference(saved, preference) || (replace && preference?.savedAt === undefined);
    if (saved?.limits && !useProfile) return;
    const next = useProfile ? limits : cachedTaskLimits(entries, preference) ?? limits;
    const limitsSavedAt = useProfile ? preference?.savedAt : undefined;
    if (saved) {
      saved.limits = { ...next };
      saved.limitsSavedAt = limitsSavedAt;
    } else {
      const legacy = entries.findIndex(entry => entry.kind === "defaults");
      if (legacy >= 0) entries.splice(legacy, 1);
      entries.push({ id: defaultsId, owner: 0, kind: "defaults", limits: { ...next }, limitsSavedAt });
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
    remember(project: string) {
      if (shared) {
        const saved = savedDefaults(runtimeEntries(project));
        if (!saved?.limits || isNewerPreference(saved, preference)) persistDefaults(project);
        projects.set(projectIdentity(project), project);
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
    configure(next: AgentLimits, savedAt?: number) {
      limits = { ...next, manager: 0 };
      preference = { limits, savedAt };
      if (shared) for (const path of projects.values()) persistDefaults(path, true);
    },
    available,
    acquire(project: string, role: AgentRole, overrides?: Partial<AgentLimits>, task?: string, queuedRevision?: number,
      operation?: RuntimeEntry["operation"]) {
      if (sharedProject) {
        const path = sharedProject(project);
        return registerRuntime(path, { kind: "slot", role, task, operation }, entries => {
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
