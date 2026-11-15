import { createHash } from "node:crypto";
import { join } from "node:path";
import { taskIdPattern } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";
import type { ReviewedSubmission } from "./board-actions.ts";

function legacyReportPath(profile: string, project: string) {
  const key = createHash("sha256").update(project).digest("hex");
  return join(profile, "review-history", key + ".json");
}

export function readReviewReports(profile: string, project: string): Map<string, ReviewedSubmission> {
  try {
    const board = join(project, ".tasks");
    directory(board);
    const current = join(board, "review-history.json");
    const file = exists(current) ? current : legacyReportPath(profile, project);
    if (file !== current) directory(join(profile, "review-history"));
    const stored = readJson(file);
    if (!Array.isArray(stored)) return new Map();
    return new Map(stored.flatMap(entry => {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !taskIdPattern.test(entry[0])) return [];
      const [, report] = entry as [string, ReviewedSubmission | null];
      if (!report || typeof report.submitted !== "string" || typeof report.description !== "string" ||
          !Array.isArray(report.criteria) || !Array.isArray(report.artifacts) || !report.report) return [];
      // Recheck current evidence after a restart, including evidence outside Git.
      return [[entry[0], { ...report, snapshot: undefined }]];
    }));
  } catch {
    return new Map();
  }
}

export function saveReviewReports(project: string, reports: ReadonlyMap<string, ReviewedSubmission>) {
  const entries = [...reports].flatMap(([id, report]) => {
    if (!report.submitted) return [];
    const { snapshot: _snapshot, ...previous } = report;
    return [[id, previous] as const];
  });
  try {
    const board = join(project, ".tasks");
    directory(board);
    writeJson(join(board, "review-history.json"), entries);
  } catch (error) {
    console.warn("Could not save review history.", (error as Error).message);
  }
}
