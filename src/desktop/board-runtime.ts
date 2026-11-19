import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { directory, exists, locateBoard, readJson, withRuntimeLock, writeJson } from "../cli/storage.ts";
import type { BoardLocation } from "../cli/storage.ts";
import type { AgentLimits, RunActivity, Task } from "../cli/model.ts";
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
  limitsSavedAt?: number;
  revision?: number;
  linkedThread?: { revision: number; codexThreadId: string };
  turnRequest?: { threadId: string; clientId: string; turnId?: string };
  restart?: { threadId: string; cwd: string };
  continuation?: { afterDisconnect?: boolean; withoutProgress?: boolean };
  queuedMessageId?: string;
  steeringMessageId?: string;
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
  const live = entries.filter(entry => entry.kind === "defaults" || entry.kind === "queue" ? true : entry.kind === "provider"
    ? providers.has(entry)
    : isAlive(entry.owner) || protectedIds.has(entry.id) || (entry.parent && protectedIds.has(entry.parent)));
  const retained = new Set(live);
  for (const entry of entries) if (!retained.has(entry)) queueRestart(live, entry);
  return live;
}

function queueRestart(entries: RuntimeEntry[], slot: RuntimeEntry) {
  const { task, revision, restart, continuation } = slot;
  if (slot.kind !== "slot" || !task || revision === undefined || !restart ||
      entries.some(entry => entry.kind === "queue" && entry.task === task)) return;
  entries.push({ id: slot.id, kind: "queue", owner: 0, task, revision, restart, continuation });
}

export function rememberExecutor(project: string, task: QueuedTask, cwd: string, continuation: RuntimeEntry["continuation"]) {
  runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === context.getStore() && entry.kind === "slot" && entry.role === "executor");
    if (slot && task.status === "in_progress" && task.codexThreadId) {
      slot.revision = task.revision;
      slot.restart = { threadId: task.codexThreadId, cwd };
      slot.continuation = continuation;
    }
  });
}

export function forgetExecutor(project: string, task: string) {
  runtimeTransaction(project, entries => {
    for (const entry of entries) if (entry.kind === "slot" && entry.task === task) delete entry.restart;
    const index = entries.findIndex(entry => entry.kind === "queue" && entry.task === task);
    if (index >= 0) entries.splice(index, 1);
  });
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

type QueuedTask = Pick<Task, "id" | "revision" | "status" | "codexThreadId">;

export function matchesQueuedExecutor(entry: RuntimeEntry, task: QueuedTask) {
  return entry.kind === "queue" && entry.task === task.id && task.status === "in_progress" &&
    (entry.restart ? entry.restart.threadId === task.codexThreadId && (entry.revision ?? Infinity) <= task.revision
      : entry.revision === task.revision || (entry.linkedThread?.revision === task.revision &&
        entry.linkedThread.codexThreadId === task.codexThreadId));
}

export function linkQueuedExecutor(project: string, task: QueuedTask, updated: QueuedTask) {
  return runtimeTransaction(project, entries => {
    const entry = entries.find(entry => matchesQueuedExecutor(entry, task));
    if (!entry) return false;
    // Publish both revisions before saving the card, so either snapshot survives a crash.
    if (updated.revision !== task.revision && updated.codexThreadId) {
      entry.revision = task.revision;
      entry.linkedThread = { revision: updated.revision, codexThreadId: updated.codexThreadId };
    }
    return true;
  });
}

export function prepareQueuedTurn(project: string, task: QueuedTask, threadId: string) {
  return runtimeTransaction(project, entries => {
    const entry = entries.find(entry => matchesQueuedExecutor(entry, task));
    if (!entry) return;
    const previous = entry.turnRequest;
    entry.turnRequest ??= { threadId, clientId: randomUUID() };
    return { ...entry.turnRequest, recover: Boolean(previous) };
  });
}

export function recordQueuedTurn(project: string, task: string, clientId: string, turnId: string) {
  runtimeTransaction(project, entries => {
    const entry = entries.find(entry => entry.kind === "queue" && entry.task === task);
    if (entry?.turnRequest?.clientId === clientId) entry.turnRequest.turnId = turnId;
  });
}

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
  const release = (restart = false) => runtimeTransaction(project, entries => {
    const index = entries.findIndex(entry => entry.id === id);
    if (index >= 0) {
      const [entry] = entries.splice(index, 1);
      if (restart) queueRestart(entries, entry);
    }
  });
  return Object.assign(release, { run: <T>(callback: () => T) => context.run(id, callback) });
}
