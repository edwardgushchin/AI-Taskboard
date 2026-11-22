import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, removeFile, writeJson } from "../cli/storage.ts";
import { parseUsageReport } from "../cli/token-usage.ts";
import type { TokenUsageReport } from "../cli/token-usage.ts";
import { callCli } from "./cli.ts";
import type { CliError } from "./cli.ts";
import { recordCodexDailyUsage, type CodexBudgetRole } from "./codex-daily-budget.ts";

type PendingReport = {
  project: string;
  task?: string;
  budgetRole?: CodexBudgetRole;
  report: TokenUsageReport;
  failure?: CliError;
};

const retryable = new Set(["CLI_UNAVAILABLE", "BOARD_BUSY", "GIT_FAILED", "GIT_UNAVAILABLE"]);

function pendingFailure({ code, message, details }: CliError): CliError {
  if (code === "CLI_UNAVAILABLE") return { code, message, details };
  if (code !== "GIT_FAILED") return { code, message };
  const git = details as { operation?: unknown; code?: unknown; exitCode?: unknown; output?: unknown } | undefined;
  // Git stderr can include paths and values from the repository configuration.
  const configLine = typeof git?.output === "string" ?
    /^fatal: bad config line ([0-9]+) in file /m.exec(git.output)?.[1] : undefined;
  return {
    code,
    message: configLine ? "Invalid Git configuration at line " + configLine + "." : "Git failed while saving token usage.",
    details: {
      operation: git?.operation === "worktree" || git?.operation === "worktree list" ? "worktree list" : undefined,
      exitCode: typeof git?.exitCode === "number" ? git.exitCode : undefined,
      code: typeof git?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(git.code) ? git.code : undefined,
    },
  };
}

export class TokenUsageQueue {
  private readonly directory: string;
  private readonly delays: readonly number[];
  private readonly budgetChanged?: (project: string) => void;
  private tail = Promise.resolve();
  private budgetWrites = new Map<string, PendingReport>();

  constructor(profile: string, delays: readonly number[] = [5_000, 30_000],
    budgetChanged?: (project: string) => void) {
    this.directory = join(profile, "pending-token-usage");
    this.delays = delays;
    this.budgetChanged = budgetChanged;
  }

  restore(): void {
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith(".json")) continue;
      const path = join(this.directory, name.name);
      try {
        const entry = readJson(path) as PendingReport;
        if (typeof entry.project !== "string" || (!entry.budgetRole && !/^T-\d+$/.test(entry.task ?? ""))) {
          throw new Error("Invalid pending token usage entry.");
        }
        const parsed = { ...entry, report: parseUsageReport(entry.report) };
        if (parsed.budgetRole) {
          this.budgetWrites.set(path, parsed);
          this.sendBudget(path, parsed, 0);
        } else {
          void this.send(path, parsed, 0);
        }
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

  hasPendingBudget(project: string, midnight: number, now: number): boolean {
    return [...this.budgetWrites.values()].some(entry => entry.project === project &&
      entry.report.records.some(record => record.completedAt !== undefined &&
        record.completedAt >= midnight && record.completedAt <= now));
  }

  enqueueBudget(project: string, role: CodexBudgetRole, report: TokenUsageReport, task?: string): void {
    if (!report.records.some(record => record.completedAt !== undefined)) return;
    const path = join(this.directory, randomUUID() + ".json");
    const entry = { project, task, report, budgetRole: role };
    this.budgetWrites.set(path, entry);
    this.sendBudget(path, entry, 0);
  }

  private sendBudget(path: string, entry: PendingReport, attempt: number): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      writeJson(path, entry);
      const changed = recordCodexDailyUsage(entry.project, entry.budgetRole!, entry.report, entry.task);
      removeFile(path);
      this.budgetWrites.delete(path);
      if (changed || attempt) this.budgetChanged?.(entry.project);
    } catch (error) {
      console.warn("Could not save the board Codex budget (%s).", (error as NodeJS.ErrnoException).code ?? "UNKNOWN");
      if (attempt === 0) this.budgetChanged?.(entry.project);
      const delay = this.delays[attempt];
      if (delay !== undefined) setTimeout(() => this.sendBudget(path, entry, attempt + 1), delay).unref();
    }
  }

  private send(path: string, entry: PendingReport, attempt: number): Promise<void> {
    this.tail = this.tail.then(async () => {
      const result = await callCli(entry.project, ["token-usage", entry.task!, "--compact"], entry.report);
      if (result.ok) {
        removeFile(path);
        return;
      }
      const failure = pendingFailure(result.error);
      writeJson(path, { ...entry, failure });
      console.warn("Task token usage deferred for %s (%s).", entry.task, failure.code);
      const delay = this.delays[attempt];
      if (delay !== undefined && retryable.has(failure.code)) {
        setTimeout(() => void this.send(path, entry, attempt + 1), delay).unref();
      }
    }).catch(error => {
      console.warn("Could not process a pending token usage report for %s (%s).",
        entry.task, (error as NodeJS.ErrnoException).code ?? "UNKNOWN");
    });
    return this.tail;
  }
}
