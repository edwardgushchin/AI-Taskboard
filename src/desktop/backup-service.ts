import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { exists, readJson, writeJson } from "../cli/storage.ts";
import { backupHour, listBackups } from "./board-backups.ts";
import type { Backup } from "./board-backups.ts";
import type { BackupRequest } from "./backup-worker.ts";

interface BackupStatus {
  nextAutomatic?: number;
  lastSuccess?: number;
  error?: string;
}

export class BackupService {
  readonly root: string;
  readonly preferences: string;
  private queue: Promise<unknown> = Promise.resolve();
  private states: Record<string, BackupStatus>;

  constructor(profile: string, now: () => number = Date.now) {
    this.root = join(profile, "board-backups");
    this.preferences = join(profile, "board-backup-settings.json");
    this.states = exists(this.preferences) ? readJson(this.preferences) as Record<string, BackupStatus> : {};
    this.now = now;
  }

  private readonly now: () => number;

  private update(project: string, state: BackupStatus): void {
    const next = { ...this.states, [project]: state };
    writeJson(this.preferences, next);
    this.states = next;
  }

  status(project?: string) {
    const state = project ? this.states[project] : undefined;
    try {
      return { ...state, root: this.root, backups: listBackups(this.root, this.now()) };
    } catch (error) {
      return { ...state, root: this.root, backups: [], error: state?.error ?? (error as Error).message };
    }
  }

  automatic(project: string, enabled: boolean): void {
    const state = this.states[project] ?? {};
    const nextAutomatic = enabled ? state.nextAutomatic ?? this.now() + backupHour : undefined;
    this.update(project, { ...state, nextAutomatic });
  }

  private run<T>(request: BackupRequest): Promise<T> {
    const next = this.queue.then(() => new Promise<T>((resolve, reject) => {
      const worker = new Worker(new URL("./backup-worker.ts", import.meta.url), {
        execArgv: [], workerData: { request, root: this.root, now: this.now() },
      });
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error("Backup worker exited before responding (" + code + ").")));
      worker.once("message", ({ data, error }) => error ? reject(new Error(error)) : resolve(data));
    }));
    this.queue = next.catch(() => {});
    return next;
  }

  async create(project: string): Promise<void> {
    let backup: Backup;
    try {
      backup = await this.run<Backup>({ action: "create", project });
    } catch (error) {
      this.update(project, { ...this.states[project], error: (error as Error).message });
      throw error;
    }
    this.update(project, { ...this.states[project], lastSuccess: backup.createdAt, error: undefined });
  }

  verify(id: string): Promise<Backup> {
    return this.run({ action: "verify", id });
  }

  restore(id: string, parent: string): Promise<string> {
    return this.run({ action: "restore", id, parent });
  }

  async tick(): Promise<void> {
    try {
      await this.run({ action: "prune" });
    } finally {
      for (const project of Object.keys(this.states)) {
        const state = this.states[project];
        if (state.nextAutomatic === undefined || this.now() < state.nextAutomatic) continue;
        this.update(project, { ...state, nextAutomatic: this.now() + backupHour });
        await this.create(project).catch(() => {});
      }
    }
  }
}
