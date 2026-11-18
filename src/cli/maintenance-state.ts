import { join } from "node:path";
import { directory, exists, readJson, withRuntimeLock, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { TaskboardError } from "./model.ts";

export interface MaintenanceJob {
  id: string;
  task?: string;
  operation: "cleanup" | "migration" | "attachments";
  error: { code: string; message: string; details?: unknown };
  attempts: number;
  retryAt: number;
  cleanupRetryAt?: number;
  repairAttempts?: number;
  owner?: number;
}

function transaction<T>(store: BoardStore, update: (jobs: MaintenanceJob[]) => T): T {
  const root = store.location.directory;
  directory(root);
  return withRuntimeLock(root, () => {
    const path = join(root, "maintenance.json");
    const jobs = exists(path) ? readJson(path) : [];
    if (!Array.isArray(jobs) || jobs.some(job => !job ||
        job.id !== (job.task ?? "project") + ":" + job.operation ||
        !/^(?:T-[0-9]{4,}|project):(cleanup|migration|attachments)$/.test(job.id) ||
        !["cleanup", "migration", "attachments"].includes(job.operation) ||
        !Number.isSafeInteger(job.attempts) || job.attempts < 1 ||
        !Number.isFinite(job.retryAt) || job.retryAt < 0 || !job.error ||
        typeof job.error.code !== "string" || typeof job.error.message !== "string")) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid maintenance queue.");
    }
    const before = JSON.stringify(jobs);
    const result = update(jobs);
    if (JSON.stringify(jobs) !== before) writeJson(path, jobs);
    return result;
  });
}

function alive(pid?: number): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function maintenanceFailure(store: BoardStore, operation: MaintenanceJob["operation"], error: unknown, task?: string) {
  transaction(store, jobs => {
    const id = (task ?? "project") + ":" + operation;
    const existing = jobs.find(job => job.id === id);
    const diagnostic = error instanceof TaskboardError
      ? { code: error.code, message: error.message, details: error.details }
      : { code: "MAINTENANCE_FAILED", message: String(error) };
    const retries = existing && existing.error.code === diagnostic.code ? existing.attempts : 0;
    const now = Date.now();
    const cleanupRetryAt = operation === "cleanup" ? now + Math.min(300_000, 15_000 * 2 ** Math.min(retries, 5)) : undefined;
    if (existing) { existing.error = diagnostic; existing.attempts++; existing.cleanupRetryAt = cleanupRetryAt; }
    else jobs.push({ id, task, operation, error: diagnostic, attempts: 1, retryAt: now + 15_000, cleanupRetryAt });
  });
}

export function cleanupRetryDeferred(store: BoardStore, task: string) {
  return transaction(store, jobs => jobs.some(job => job.task === task && job.operation === "cleanup" &&
    (alive(job.owner) || (job.cleanupRetryAt ?? 0) > Date.now())));
}

export function maintenanceSuccess(store: BoardStore, operation: MaintenanceJob["operation"], task?: string) {
  transaction(store, jobs => {
    const index = jobs.findIndex(job => job.id === (task ?? "project") + ":" + operation);
    if (index >= 0) jobs.splice(index, 1);
  });
}

export function maintenanceQueue(store: BoardStore) {
  return transaction(store, jobs => jobs.filter(job => !alive(job.owner) && job.retryAt <= Date.now()));
}

export function claimMaintenance(store: BoardStore, id: string, owner: number) {
  return transaction(store, jobs => {
    const job = jobs.find(job => job.id === id);
    if (!job || alive(job.owner) || job.retryAt > Date.now() || !alive(owner)) return false;
    job.owner = owner;
    return true;
  });
}

export function releaseMaintenance(store: BoardStore, id: string, owner: number) {
  transaction(store, jobs => {
    const job = jobs.find(job => job.id === id && job.owner === owner);
    if (job) {
      delete job.owner;
      const attempts = job.repairAttempts ?? 0;
      job.repairAttempts = attempts + 1;
      job.retryAt = Date.now() + Math.min(3_600_000, 120_000 * 2 ** Math.min(attempts, 5));
    }
  });
}
