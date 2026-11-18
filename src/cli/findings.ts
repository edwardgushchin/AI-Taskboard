import { join } from "node:path";
import { member, object, requireState, TaskboardError, text } from "./model.ts";
import { readTask } from "./archive.ts";
import { exists, readJson, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

interface Finding {
  taskId: string;
  revision: number;
  at: string;
  symptom: string;
  environment: string;
  cause: string;
  verification: string;
}

export function boardFindings(store: BoardStore, id: string | undefined, input: Record<string, unknown>) {
  const file = join(store.location.directory, "findings.json");
  const entries = (exists(file) ? readJson(file) : []) as Finding[];
  if (!Array.isArray(entries)) throw new TaskboardError("CORRUPT_STORAGE", "Invalid board findings.");
  if (input.finding !== undefined) {
    if (input.query !== undefined || !id) throw new TaskboardError("INVALID_INPUT", "Supply the source task ID when recording a finding.");
    const actor = member(input.actor ?? "user", ["user", "manager", "agent", "reviewer"], "finding author");
    const task = readTask(store, id);
    if (actor === "agent" || actor === "reviewer") {
      requireState(task, [actor === "reviewer" || task.acceptanceRepair?.phase === "running" ? "review" : "in_progress"]);
    }
    const finding = object(input.finding);
    const symptom = text(finding.symptom, "symptom", true);
    const environment = text(finding.environment, "environment", true);
    const cause = text(finding.cause, "confirmed cause", true);
    const verification = text(finding.verification, "verification", true);
    if ([symptom, environment, cause, verification].some(value => value.length > 1500)) {
      throw new TaskboardError("INVALID_INPUT", "Each finding field is limited to 1500 characters.");
    }
    const previous = entries.find(entry => entry.taskId === id && entry.revision === task.revision &&
      entry.symptom === symptom && entry.environment === environment && entry.cause === cause && entry.verification === verification);
    if (previous) return previous;
    const entry = { taskId: id, revision: task.revision, at: new Date().toISOString(), symptom, environment, cause, verification };
    writeJson(file, [...entries, entry]);
    return entry;
  }
  const query = text(input.query ?? "", "query").trim();
  if (query.length > 300) throw new TaskboardError("INVALID_INPUT", "Search with up to 300 characters.");
  const terms = query ? query.toLowerCase().split(/\s+/) : [];
  return entries.toReversed().filter(({ taskId, symptom, environment, cause, verification }) => {
    const value = [taskId, symptom, environment, cause, verification].join(" ").toLowerCase();
    return terms.every(term => value.includes(term));
  }).slice(0, 10);
}
