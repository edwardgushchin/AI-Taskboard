import { join } from "node:path";
import { codexThreadPattern } from "./model.ts";
import { exists, readJson } from "./storage.ts";

export function managerGoalBinding(project: string) {
  const legacy = join(project, ".tasks", "orchestrator.json");
  return exists(legacy) ? legacy : join(project, ".tasks", "manager-dialog.json");
}

export function managerGoalState(project: string) {
  const path = managerGoalBinding(project);
  if (!exists(path)) return;
  const saved = readJson(path) as { provider?: string; id?: string; goalId?: string; goal?: { status?: string } } | null;
  if (saved?.provider !== "codex" || !saved.goal ||
      typeof saved.id !== "string" || !codexThreadPattern.test(saved.id)) return;
  const id = saved.goalId ?? saved.id;
  const status = saved.goal.status;
  const iterativeGoalId = status === "active" && typeof id === "string" && codexThreadPattern.test(id) ? id : undefined;
  return { status, iterativeGoalId };
}

export function activeManagerGoal(project: string): string | undefined {
  return managerGoalState(project)?.iterativeGoalId;
}
