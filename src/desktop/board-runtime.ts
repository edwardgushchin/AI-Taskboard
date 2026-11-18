import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { directory, exists, locateBoard, readJson, withRuntimeLock, writeJson } from "../cli/storage.ts";
import type { BoardLocation } from "../cli/storage.ts";
import type { AgentLimits, RunActivity } from "../cli/model.ts";
import type { BoardActivity } from "./codex-chat.ts";

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
  state?: {
    id: string;
    phase: "starting" | "waiting" | "running";
    startedAt: number;
    lane?: "chat" | "work" | "maintenance";
    reviewing?: string[];
    item?: Pick<RunActivity, "type" | "title" | "text" | "status">;
    live?: { sequence: number; items: BoardActivity[] };
    goalRunning?: boolean;
  };
  startedAt?: number;
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function runtimeLocation(project: string): BoardLocation {
  const path = join(project, ".tasks");
  if (!exists(join(path, "board.json"))) return locateBoard(project);
  directory(path);
  return { root: project, directory: path, repository: null };
}

function readEntries(path: string) {
  return (exists(path) ? readJson(path) : []) as RuntimeEntry[];
}

function liveEntries(entries: RuntimeEntry[]) {
  const processes = new Map<number, boolean>();
  const isAlive = (pid: number) => {
    if (!processes.has(pid)) processes.set(pid, alive(pid));
    return processes.get(pid);
  };
  // A surviving provider protects its reservation and its turns after desktop exit.
  const providers = new Set(entries.filter(entry => entry.kind === "provider" && entry.pid && isAlive(entry.pid)));
  const protectedIds = new Set([...providers].map(entry => entry.id));
  for (const provider of providers) {
    let entry: RuntimeEntry | undefined = provider;
    while (entry?.parent && !protectedIds.has(entry.parent)) {
      protectedIds.add(entry.parent);
      entry = entries.find(candidate => candidate.id === entry!.parent);
    }
  }
  return entries.filter(entry => entry.kind === "defaults" || entry.kind === "queue" ? true : entry.kind === "provider"
    ? providers.has(entry)
    : isAlive(entry.owner) || protectedIds.has(entry.id) || (entry.parent && protectedIds.has(entry.parent)));
}

export function runtimeTransaction<T>(project: string, action: (entries: RuntimeEntry[]) => T): T {
  const { directory } = runtimeLocation(project);
  const path = join(directory, "runtime.json");
  return withRuntimeLock(directory, () => {
    const entries = readEntries(path);
    const kept = liveEntries(entries);
    const before = JSON.stringify(entries);
    const result = action(kept);
    if (JSON.stringify(kept) !== before) writeJson(path, kept);
    return result;
  });
}

export function runtimeEntries(project: string) {
  // Atomic replacement gives readers a complete snapshot without waiting for writers.
  return liveEntries(readEntries(join(runtimeLocation(project).directory, "runtime.json")));
}

export type DeferredExecutor = Pick<RuntimeEntry, "continuation"> & { revision: number };

export function deferExecutor(project: string, task: string, pending?: DeferredExecutor, expectedRevision?: number, onlyIfIdle = false) {
  return runtimeTransaction(project, entries => {
    const index = entries.findIndex(entry => entry.kind === "queue" && entry.task === task);
    const existing = entries[index];
    if (pending && existing?.revision === pending.revision) return true;
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) return false;
    if (onlyIfIdle && entries.some(entry => entry.kind !== "queue" && taskWriterId(entry.task) === task)) return false;
    if (existing) entries.splice(index, 1);
    if (pending) entries.push({ id: "queue:" + task, owner: 0, kind: "queue", task, ...pending });
    return Boolean(pending || existing);
  });
}

export function taskWriterId(task: string | undefined) {
  return task?.replace(/^(review|draft):/, "");
}

export function registerRuntime(project: string, value: Omit<RuntimeEntry, "id" | "owner">,
  accept: (entries: RuntimeEntry[]) => boolean = () => true) {
  const id = randomUUID();
  const accepted = runtimeTransaction(project, entries => {
    if (value.task && entries.some(entry => entry.kind !== "queue" &&
        (value.task?.startsWith("draft:") || entry.task?.startsWith("draft:")) &&
        taskWriterId(entry.task) === taskWriterId(value.task))) return false;
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
