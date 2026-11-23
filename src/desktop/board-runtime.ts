import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { directory, exists, locateBoard, readJson, withRuntimeLock, writeJson } from "../cli/storage.ts";
import { TaskboardError } from "../cli/model.ts";
import type { BoardLocation } from "../cli/storage.ts";
import type { AgentLimits, RunActivity, Task } from "../cli/model.ts";
import type { BoardActivity } from "./codex-chat.ts";

const context = new AsyncLocalStorage<string>();

export interface RuntimeEntry {
  id: string;
  owner: number;
  kind: "slot" | "provider" | "turn" | "task" | "defaults" | "queue" | "executor-release" | "review-retry";
  role?: keyof AgentLimits;
  task?: string;
  operation?: "maintenance" | "acceptanceRepair" | "managerReview" | "mergeRepair";
  pid?: number;
  parent?: string;
  limits?: AgentLimits;
  limitsSavedAt?: number;
  revision?: number;
  linkedThread?: { revision: number; codexThreadId: string };
  turnRequest?: { threadId: string; clientId: string; turnId?: string };
  restart?: { threadId: string; cwd: string };
  routingRetryAt?: number;
  routingRetryFailure?: string;
  reviewRetry?: { binding: string; reason: string; notBefore: number; exhausted?: true; manual?: true };
  earlyLaunch?: { cwd: string };
  writeProbeRetry?: {
    cwd: string;
    fullAccess: boolean;
    windowsSandbox?: "mxc" | "elevated";
    threadId?: string;
    notBefore: number;
    failure?: string;
    unconfirmedTurn?: true;
  };
  launchStopped?: true;
  continuation?: { afterDisconnect?: boolean; withoutProgress?: boolean };
  quotaPaused?: boolean;
  reviewReturn?: true;
  newThread?: "user" | "manager";
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
  releasedAt?: number;
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

export function isRuntimeRecord(entry: RuntimeEntry) {
  return entry.kind === "defaults" || entry.kind === "queue" ||
    entry.kind === "executor-release" || entry.kind === "review-retry";
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
  const live = entries.filter(entry => {
    if (isRuntimeRecord(entry)) return true;
    if (entry.kind === "provider") return providers.has(entry);
    return isAlive(entry.owner) || protectedIds.has(entry.id) || (entry.parent && protectedIds.has(entry.parent));
  });
  const retained = new Set(live);
  for (const entry of entries) if (!retained.has(entry)) queueRestart(live, entry);
  return live;
}

function queueRestart(entries: RuntimeEntry[], slot: RuntimeEntry, quotaPaused?: boolean) {
  const { task, revision, restart, continuation, newThread } = slot;
  if (slot.kind !== "slot" || !task || revision === undefined || (!restart && !quotaPaused) ||
      entries.some(entry => entry.kind === "queue" && entry.task === task)) return;
  entries.push({ id: slot.id, kind: "queue", owner: 0, task, revision, restart, continuation, quotaPaused, newThread });
}

export function rememberExecutor(project: string, task: QueuedTask, cwd: string,
  continuation: RuntimeEntry["continuation"], newThread?: RuntimeEntry["newThread"]) {
  runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === context.getStore() && entry.kind === "slot" && entry.task === task.id);
    if (slot && !slot.launchStopped && task.status === "in_progress") {
      slot.revision = task.revision;
      slot.newThread = newThread;
      if (task.codexThreadId && !newThread) {
        slot.restart = { threadId: task.codexThreadId, cwd };
      } else {
        delete slot.restart;
      }
      slot.continuation = continuation;
      if (!newThread) {
        const queued = entries.find(entry => entry.kind === "queue" && entry.task === task.id);
        if (queued) {
          delete queued.newThread;
        }
      }
    }
  });
}

export function forgetExecutor(project: string, task: string) {
  runtimeTransaction(project, entries => {
    for (const entry of entries) {
      if (entry.kind !== "slot" || entry.task !== task) continue;
      entry.launchStopped = true;
      delete entry.restart;
      delete entry.revision;
      delete entry.newThread;
    }
    const index = entries.findIndex(entry => entry.kind === "queue" && entry.task === task);
    if (index >= 0) entries.splice(index, 1);
  });
}

export function queueEarlyExecutor(project: string, task: QueuedTask, slotId: string, cwd: string) {
  runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === slotId && entry.kind === "slot" &&
      entry.role === "executor" && entry.task === task.id);
    if (!slot || slot.launchStopped || entries.some(entry => entry.kind === "queue" && entry.task === task.id)) {
      throw new TaskboardError("CHAT_BUSY", "This executor no longer owns the launch.");
    }
    entries.push({ id: "queue:" + task.id, kind: "queue", owner: 0, task: task.id,
      revision: task.revision, earlyLaunch: { cwd } });
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

export type DeferredExecutor = Pick<RuntimeEntry, "continuation" | "quotaPaused" | "newThread" | "reviewReturn" | "earlyLaunch"> & { revision: number };

type QueuedTask = Pick<Task, "id" | "revision" | "status" | "codexThreadId" | "reviewReturn">;

export function matchesQueuedExecutor(entry: RuntimeEntry, task: QueuedTask) {
  if (entry.kind !== "queue" || entry.task !== task.id || task.status !== "in_progress") return false;
  if (entry.reviewReturn) return task.reviewReturn !== undefined && entry.revision === task.reviewReturn;
  if (entry.restart) return entry.restart.threadId === task.codexThreadId && (entry.revision ?? Infinity) <= task.revision;
  if (entry.writeProbeRetry) {
    return entry.revision !== undefined && entry.revision <= task.revision &&
      (entry.writeProbeRetry.threadId === task.codexThreadId || entry.linkedThread?.codexThreadId === task.codexThreadId &&
        entry.linkedThread !== undefined);
  }
  if (entry.earlyLaunch) {
    // The revision is the first card snapshot covered by this launch.
    // Comments and other edits may advance it while the task stays in progress.
    return entry.revision !== undefined && entry.revision <= task.revision &&
      (task.codexThreadId === undefined || task.codexThreadId === entry.linkedThread?.codexThreadId);
  }
  return entry.revision === task.revision || (entry.linkedThread?.revision === task.revision &&
    entry.linkedThread.codexThreadId === task.codexThreadId);
}

export function queueWriteProbeRetry(project: string, slotId: string, task: QueuedTask,
  retry: NonNullable<RuntimeEntry["writeProbeRetry"]>, continuation: RuntimeEntry["continuation"],
  newThread: RuntimeEntry["newThread"]) {
  return runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === slotId && entry.task === task.id && entry.kind === "slot");
    if (!slot || slot.launchStopped) return false;
    const queued = entries.find(entry => entry.kind === "queue" && entry.task === task.id);
    if (queued) {
      if (!matchesQueuedExecutor(queued, task) || queued.writeProbeRetry) return false;
      queued.writeProbeRetry = retry;
    } else {
      entries.push({ id: "queue:" + task.id, kind: "queue", owner: 0, task: task.id, revision: task.revision,
        writeProbeRetry: retry, continuation, newThread });
    }
    return true;
  });
}

export function queueExecutorRoutingRetry(project: string, slotId: string, task: QueuedTask, cwd: string,
  notBefore: number, continuation: RuntimeEntry["continuation"]) {
  return runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === slotId && entry.task === task.id && entry.kind === "slot");
    if (!slot || slot.launchStopped || task.status !== "in_progress" || !task.codexThreadId) return false;
    if (entries.some(entry => matchesQueuedExecutor(entry, task))) return false;
    entries.push({
      id: "queue:" + task.id, kind: "queue", owner: 0, task: task.id, revision: task.revision,
      restart: { threadId: task.codexThreadId, cwd }, routingRetryAt: notBefore, continuation,
    });
    return true;
  });
}

export function exhaustExecutorRoutingRetry(project: string, slotId: string, task: string, reason: string) {
  return runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === slotId && entry.task === task && entry.kind === "slot");
    if (!slot || slot.launchStopped) return false;
    const queued = entries.find(entry => entry.kind === "queue" && entry.task === task && entry.routingRetryAt !== undefined);
    if (!queued) return false;
    queued.routingRetryFailure = reason;
    return true;
  });
}

export function recordWriteProbeRetryFailure(project: string, slotId: string, task: QueuedTask, failure: string,
  outcome?: { rejectedClientId: string } | { unconfirmedTurn: true }) {
  return runtimeTransaction(project, entries => {
    const slot = entries.find(entry => entry.id === slotId && entry.task === task.id && entry.kind === "slot");
    const queued = entries.find(entry => matchesQueuedExecutor(entry, task));
    if (!slot || slot.launchStopped || !queued?.writeProbeRetry) return false;
    if (outcome && "rejectedClientId" in outcome) {
      if (queued.turnRequest?.clientId !== outcome.rejectedClientId || queued.turnRequest.turnId) return false;
      delete queued.turnRequest;
    }
    if (outcome && "unconfirmedTurn" in outcome) {
      if (!queued.turnRequest || queued.turnRequest.threadId !== task.codexThreadId) return false;
      queued.writeProbeRetry.unconfirmedTurn = true;
    }
    queued.writeProbeRetry.failure = failure;
    return true;
  });
}

export function preserveLegacyFirstLaunch(project: string, task: QueuedTask & Pick<Task, "git" | "workingDirectory">) {
  const cwd = task.git?.worktree ?? task.workingDirectory;
  if (!cwd || task.status !== "in_progress" || task.codexThreadId) return;
  // An older manual queue entry can only be upgraded while it still matches
  // the card, before the next revision is saved.
  const legacy = (entry: RuntimeEntry) => entry.revision === task.revision &&
    !entry.earlyLaunch && !entry.reviewReturn && !entry.restart && !entry.newThread &&
    !entry.quotaPaused && !entry.continuation && !entry.linkedThread && !entry.turnRequest &&
    matchesQueuedExecutor(entry, task);
  if (!runtimeEntries(project).some(legacy)) return;
  runtimeTransaction(project, entries => {
    const pending = entries.find(legacy);
    if (pending) pending.earlyLaunch = { cwd };
  });
}

export function linkQueuedExecutor(project: string, task: QueuedTask, updated: QueuedTask) {
  return runtimeTransaction(project, entries => {
    const entry = entries.find(entry => matchesQueuedExecutor(entry, task));
    if (!entry) return false;
    // Publish the chat binding before saving the card, so either snapshot survives a crash.
    if (!entry.reviewReturn && updated.revision !== task.revision && updated.codexThreadId) {
      if (!entry.earlyLaunch) entry.revision = task.revision;
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
  const release = (restart: boolean | "quota" = false) => runtimeTransaction(project, entries => {
    const index = entries.findIndex(entry => entry.id === id);
    if (index >= 0) {
      const [entry] = entries.splice(index, 1);
      if (entry.kind === "slot" && entry.role === "executor") {
        // Keep one receipt even if acquire and release happen between dispatcher passes.
        const previous = entries.findIndex(candidate => candidate.kind === "executor-release");
        if (previous >= 0) entries.splice(previous, 1);
        entries.push({ id: "executor-release:" + entry.id, owner: 0, kind: "executor-release", releasedAt: Date.now() });
      }
      if (restart === "quota") {
        const queued = entries.find(candidate => candidate.kind === "queue" && candidate.task === entry.task);
        if (queued) {
          queued.quotaPaused = true;
          if (!queued.writeProbeRetry) delete queued.turnRequest;
        }
      }
      if (restart) queueRestart(entries, entry, restart === "quota" || undefined);
    }
  });
  return Object.assign(release, { id, run: <T>(callback: () => T) => context.run(id, callback) });
}
