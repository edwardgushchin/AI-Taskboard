import { join } from "node:path";
import { codexThreadPattern } from "./model.ts";
import { exists, readJson } from "./storage.ts";

export function managerGoalBinding(project: string) {
  const legacy = join(project, ".tasks", "orchestrator.json");
  return exists(legacy) ? legacy : join(project, ".tasks", "manager-dialog.json");
}

export function activeManagerGoal(project: string): string | undefined {
  const path = managerGoalBinding(project);
  if (!exists(path)) return;
  const saved = readJson(path) as { provider?: string; id?: string; goalId?: string; goal?: { status?: string } } | null;
  if (saved?.provider !== "codex" || saved.goal?.status !== "active" ||
      typeof saved.id !== "string" || !codexThreadPattern.test(saved.id)) return;
  const id = saved.goalId ?? saved.id;
  if (typeof id === "string" && codexThreadPattern.test(id)) return id;
}
