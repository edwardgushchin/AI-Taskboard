import { readTask } from "./archive.ts";
import { managerUsage } from "./manager-usage.ts";
import type { BoardStore } from "./storage.ts";
import { summarizeTokenUsage, totalTokenUsage } from "./token-usage.ts";
import type { ModelTokenUsage, TokenUsageRecord } from "./token-usage.ts";

export function projectUsage(store: BoardStore) {
  const tasks = [...Object.keys(store.index.tasks), ...Object.keys(store.index.archive)].map(id => readTask(store, id));
  const roles = new Map<string, TokenUsageRecord[]>();
  let missingTasks = 0;
  for (const task of tasks) {
    const reports = task.tokenUsage?.reports ?? [];
    if (!reports.length) missingTasks++;
    for (const report of reports) {
      const role = report.role ?? "unattributed";
      roles.set(role, [...(roles.get(role) ?? []), ...report.records]);
    }
  }
  const manager = managerUsage(store.location.directory, {});
  if (!("reports" in manager)) throw new Error("Expected manager usage summary.");
  const byRole: Record<string, ModelTokenUsage[]> = { manager: manager.byModel };
  for (const role of ["executor", "reviewer", "discussion", "unattributed"]) byRole[role] = totalTokenUsage(roles.get(role) ?? []);
  // Aggregate the disjoint role totals once. Cache and reasoning remain subsets.
  const byModel = totalTokenUsage(Object.values(byRole).flat().map(entry => ({ ...entry, threadId: "", turnId: "" })));
  const summary = summarizeTokenUsage(byModel);
  return { ...summary, byModel, byRole, tasks: tasks.length, missingTasks,
    managerReports: manager.reports, incomplete: summary.incomplete || missingTasks > 0 || !manager.reports };
}
