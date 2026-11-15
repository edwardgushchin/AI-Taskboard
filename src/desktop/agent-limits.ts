import type { AgentLimits } from "../cli/model.ts";
import { inheritedLimits } from "../cli/settings-notices.ts";

export const defaultAgentLimits: AgentLimits = inheritedLimits;
export type AgentRole = keyof AgentLimits;

export function parseAgentLimits(value: unknown): AgentLimits | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { executor, manager, reviewer } = value as AgentLimits;
  if (![executor, manager, reviewer].every(limit => Number.isSafeInteger(limit) && limit >= 0)) return;
  return { executor, manager, reviewer };
}

export function createAgentSlots() {
  let limits = { ...defaultAgentLimits };
  const active = new Map<string, AgentLimits>();
  const available = (project: string, role: AgentRole, overrides?: Partial<AgentLimits>) => {
    const limit = overrides?.[role] ?? limits[role];
    return limit === 0 ? Infinity : Math.max(0, limit - (active.get(project)?.[role] ?? 0));
  };
  return {
    get limits() { return { ...limits }; },
    configure(next: AgentLimits) { limits = { ...next }; },
    available,
    acquire(project: string, role: AgentRole, overrides?: Partial<AgentLimits>) {
      if (!available(project, role, overrides)) return;
      const counts = active.get(project) ?? { executor: 0, manager: 0, reviewer: 0 };
      counts[role]++;
      active.set(project, counts);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        counts[role]--;
        if (Object.values(counts).every(count => count === 0)) active.delete(project);
      };
    },
  };
}
