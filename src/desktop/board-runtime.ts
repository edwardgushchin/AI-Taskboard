import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { exists, locateBoard, readJson, withLock, writeJson } from "../cli/storage.ts";
import type { AgentLimits } from "../cli/model.ts";

const context = new AsyncLocalStorage<string>();

export interface RuntimeEntry {
  id: string;
  owner: number;
  kind: "slot" | "provider" | "turn" | "task" | "defaults" | "queue";
  role?: keyof AgentLimits;
  task?: string;
  pid?: number;
  parent?: string;
  limits?: AgentLimits;
  revision?: number;
  continuation?: { afterDisconnect?: boolean; withoutProgress?: boolean };
  state?: { id: string; phase: "starting" | "waiting" | "running"; startedAt: number; reviewing?: string[] };
  startedAt?: number;
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

// All readers and writers use the board's existing transaction lock. A live
// provider protects only its own ancestors after the desktop has died.
export function runtimeTransaction<T>(project: string, action: (entries: RuntimeEntry[]) => T): T {
  const { directory } = locateBoard(project);
  return withLock(directory, () => {
    const path = join(directory, "runtime.json");
    const entries = (exists(path) ? readJson(path) : []) as RuntimeEntry[];
    const providers = entries.filter(entry => entry.kind === "provider" && entry.pid && alive(entry.pid));
    const protectedIds = new Set(providers.map(entry => entry.id));
    for (const provider of providers) {
      let entry: RuntimeEntry | undefined = provider;
      while (entry?.parent && !protectedIds.has(entry.parent)) {
        protectedIds.add(entry.parent);
        entry = entries.find(candidate => candidate.id === entry!.parent);
      }
    }
    const kept = entries.filter(entry => entry.kind === "defaults" || entry.kind === "queue" ? true : entry.kind === "provider"
      ? providers.includes(entry)
      : alive(entry.owner) || protectedIds.has(entry.id) || (entry.parent && protectedIds.has(entry.parent)));
    const before = JSON.stringify(entries);
    const result = action(kept);
    if (JSON.stringify(kept) !== before) writeJson(path, kept);
    return result;
  });
}

export function runtimeEntries(project: string) {
  return runtimeTransaction(project, entries => [...entries]);
}

export function registerRuntime(project: string, value: Omit<RuntimeEntry, "id" | "owner">,
  accept: (entries: RuntimeEntry[]) => boolean = () => true) {
  const id = randomUUID();
  const accepted = runtimeTransaction(project, entries => {
    if (!accept(entries)) return false;
    entries.push({ parent: value.kind === "provider" || value.kind === "turn" ? context.getStore() : undefined,
      startedAt: Date.now(), ...value, id, owner: process.pid });
    return true;
  });
  if (!accepted) return;
  const release = () => runtimeTransaction(project, entries => {
    const index = entries.findIndex(entry => entry.id === id);
    if (index >= 0) entries.splice(index, 1);
  });
  return Object.assign(release, { run: <T>(callback: () => T) => context.run(id, callback) });
}
