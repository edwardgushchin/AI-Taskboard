import { readdirSync } from "node:fs";
import { join } from "node:path";
import { codexThreadPattern, TaskboardError } from "./model.ts";
import { directory, exists, readJson, withLock, writeJson } from "./storage.ts";
import { parseUsageReport, summarizeTokenUsage, totalTokenUsage } from "./token-usage.ts";

export function managerUsage(boardDirectory: string, input: Record<string, unknown>) {
  const path = join(boardDirectory, "manager-usage");
  if (Object.keys(input).length) {
    const report = parseUsageReport(input);
    if (!codexThreadPattern.test(report.id) || report.role) {
      throw new TaskboardError("INVALID_INPUT", "Supply a manager run UUID and unassigned token usage records.");
    }
    directory(path, true);
    return withLock(path, () => {
      const file = join(path, report.id.toLowerCase() + ".json");
      const previous = exists(file) ? parseUsageReport(readJson(file)) : undefined;
      if (!previous || previous.sequence < report.sequence) writeJson(file, report);
      return { id: report.id, sequence: Math.max(previous?.sequence ?? 0, report.sequence) };
    });
  }
  if (!exists(path)) return { reports: 0, ...summarizeTokenUsage([]), byModel: [] };
  directory(path);
  const reports = withLock(path, () => readdirSync(path)
    .filter(name => name.endsWith(".json") && codexThreadPattern.test(name.slice(0, -5)))
    .map(name => parseUsageReport(readJson(join(path, name)))));
  const byModel = totalTokenUsage(reports.flatMap(report => report.records));
  return { reports: reports.length, ...summarizeTokenUsage(byModel), byModel };
}
