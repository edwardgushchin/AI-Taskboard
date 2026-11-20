import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, removeFile, writeJson } from "../cli/storage.ts";
import { parseUsageReport } from "../cli/token-usage.ts";
import type { TokenUsageReport } from "../cli/token-usage.ts";
import { callCli } from "./cli.ts";

type PendingReport = {
  project: string;
  task: string;
  report: TokenUsageReport;
  failure?: { code: string; message?: string; details?: unknown };
};

const retryable = new Set(["CLI_UNAVAILABLE", "BOARD_BUSY", "GIT_FAILED", "GIT_UNAVAILABLE"]);

export class TokenUsageQueue {
  private readonly directory: string;
  private readonly delays: readonly number[];
  private tail = Promise.resolve();

  constructor(profile: string, delays: readonly number[] = [5_000, 30_000]) {
    this.directory = join(profile, "pending-token-usage");
    this.delays = delays;
  }

  restore(): void {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith(".json")) continue;
      const path = join(this.directory, name.name);
      try {
        const entry = readJson(path) as PendingReport;
        if (typeof entry.project !== "string" || !/^T-\d+$/.test(entry.task)) {
          throw new Error("Invalid pending token usage entry.");
        }
        void this.send(path, { ...entry, report: parseUsageReport(entry.report) }, 0);
      } catch {
        console.warn("Could not read a pending token usage report (%s).", name.name);
      }
    }
  }

  enqueue(project: string, task: string, report: TokenUsageReport): Promise<void> {
    const path = join(this.directory, randomUUID() + ".json");
    const entry = { project, task, report };
    mkdirSync(this.directory, { recursive: true });
    // Persist before spawning: success with a lost reply can be replayed by ID and sequence.
    writeJson(path, entry);
    return this.send(path, entry, 0);
  }

  private send(path: string, entry: PendingReport, attempt: number): Promise<void> {
    this.tail = this.tail.then(async () => {
      const result = await callCli(entry.project, ["token-usage", entry.task, "--compact"], entry.report);
      if (result.ok) {
        removeFile(path);
        return;
      }
      const { code, message, details } = result.error;
      const failure = code === "CLI_UNAVAILABLE" ? { code, message, details } : { code, message };
      writeJson(path, { ...entry, failure });
      console.warn("Task token usage deferred for %s (%s).", entry.task, code);
      const delay = this.delays[attempt];
      if (delay !== undefined && retryable.has(code)) {
        setTimeout(() => void this.send(path, entry, attempt + 1), delay).unref();
      }
    }).catch(error => {
      console.warn("Could not process a pending token usage report for %s (%s).",
        entry.task, (error as NodeJS.ErrnoException).code ?? "UNKNOWN");
    });
    return this.tail;
  }
}
