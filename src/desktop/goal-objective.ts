import { hash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { managerGoalBinding } from "../cli/manager-goal.ts";
import { codexThreadPattern } from "../cli/model.ts";
import { directory, readBinary, readJson, removeFile, writeAtomic, writeJson } from "../cli/storage.ts";
import type { BoardGoal } from "./codex-chat.ts";

type GoalChange = { id: string; previous: BoardGoal | null; next: string };

function changePath(project: string, threadId: string) {
  if (!codexThreadPattern.test(threadId)) throw new Error("Invalid Codex goal thread ID.");
  return join(project, ".tasks", `manager-goal-change-${threadId}.json`);
}

export function readGoalChange(project: string, threadId: string): GoalChange | undefined {
  if (!codexThreadPattern.test(threadId)) return;
  try {
    return readJson(changePath(project, threadId)) as GoalChange;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function stageGoalChange(project: string, threadId: string, objective: string, previous: BoardGoal | null) {
  directory(join(project, ".tasks"));
  const next = prepareGoalObjective(project, threadId, objective);
  const change = { id: randomUUID(), previous, next };
  try {
    writeJson(changePath(project, threadId), change);
  } catch (error) {
    if (next !== previous?.objective) discardGoalObjective(project, threadId, next);
    throw error;
  }
  return change;
}

export function goalChangeCommitted(project: string, threadId: string, change: GoalChange) {
  try {
    const saved = readJson(managerGoalBinding(project)) as { id?: string; goalChangeId?: string } | null;
    return saved?.id === threadId && saved.goalChangeId === change.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export function finishGoalChange(project: string, threadId: string, change: GoalChange, committed: boolean) {
  try {
    if (change.previous?.objective !== change.next) {
      discardGoalObjective(project, threadId, committed ? change.previous?.objective : change.next);
    }
    removeFile(changePath(project, threadId));
  } catch (error) {
    // A subsequent connection can finish cleanup using the saved confirmation ID.
    console.warn("Could not remove the pending goal change.", (error as Error).message);
  }
}

function reference(threadId: string, digest: string) {
  const file = `.tasks/manager-goal-${threadId}-${digest}.md`;
  return {
    file,
    objective: `Execute the full objective in \`${file}\` in the board root. Read that Markdown file in full as your first step. ` +
      "Carry out its requested work and verify all its completion conditions before marking the goal complete. " +
      "Reading the file alone does not complete the goal. If the file cannot be read, report the problem and leave the goal incomplete.",
  };
}

function referencedFile(threadId: string, objective: string) {
  const digest = /-([a-f0-9]{64})\.md`/.exec(objective)?.[1];
  if (!digest || !codexThreadPattern.test(threadId)) return;
  const target = reference(threadId, digest);
  if (target.objective === objective) return { ...target, digest };
}

export function needsGoalFile(objective: string) {
  // Codex trims whitespace at the edges and counts Unicode scalar values.
  return objective !== objective.trim() || (objective.length > 4000 && Array.from(objective).length > 4000);
}

export function prepareGoalObjective(project: string, threadId: string, objective: string) {
  if (!needsGoalFile(objective)) return objective;
  if (!codexThreadPattern.test(threadId)) throw new Error("Invalid Codex goal thread ID.");
  const target = reference(threadId, hash("sha256", objective));
  const path = join(project, target.file);
  try {
    directory(join(project, ".tasks"));
    writeAtomic(path, objective);
    if (!readBinary(path).equals(Buffer.from(objective))) throw new Error("The saved text differs from the objective.");
  } catch (error) {
    throw new Error("Could not save the goal Markdown at " + target.file + ". " + (error as Error).message);
  }
  return target.objective;
}

export function fullGoalObjective(project: string, threadId: string, objective: string, restore = false) {
  const target = referencedFile(threadId, objective);
  if (!target) return objective;
  const path = join(project, target.file);
  try {
    directory(join(project, ".tasks"));
    try {
      const bytes = readBinary(path);
      if (hash("sha256", bytes) !== target.digest) throw new Error("The saved Markdown does not match this goal version.");
      return bytes.toString("utf8");
    } catch (error) {
      if (restore && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const saved = readJson(managerGoalBinding(project)) as { id?: string; goal?: { objective?: string } } | null;
      const text = saved?.goal?.objective;
      if (saved?.id !== threadId || typeof text !== "string" || hash("sha256", text) !== target.digest) throw error;
      if (restore) prepareGoalObjective(project, threadId, text);
      return text;
    }
  } catch (error) {
    throw new Error("Could not read the goal Markdown at " + target.file + ". " + (error as Error).message);
  }
}

export function discardGoalObjective(project: string, threadId: string, objective: string | undefined) {
  const target = objective && referencedFile(threadId, objective);
  if (!target) return;
  try {
    directory(join(project, ".tasks"));
    removeFile(join(project, target.file));
  } catch (error) {
    console.warn("Could not remove the unused goal Markdown.", (error as Error).message);
  }
}
