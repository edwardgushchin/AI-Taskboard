import { TaskboardError } from "./model.ts";
import type { Task, TaskState } from "./model.ts";
import type { BoardStore } from "./storage.ts";

export function dependencyStatus(store: BoardStore, id: string): TaskState | undefined {
  return Object.hasOwn(store.index.archive, id) ? store.index.archive[id].status :
    Object.hasOwn(store.index.tasks, id) ? store.card(id).status : undefined;
}

export function unfinishedDependencies(task: Pick<Task, "dependencies">, status: (id: string) => TaskState | undefined): string[] {
  return (task.dependencies ?? []).filter(id => status(id) !== "done");
}

export function validateDependencies(store: BoardStore, task: Task): void {
  const pending = [...(task.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === task.id) {
      throw new TaskboardError("DEPENDENCY_CYCLE", "A task cannot depend on itself, directly or indirectly.", { id });
    }
    if (visited.has(id) || Object.hasOwn(store.index.archive, id)) continue;
    visited.add(id);
    pending.push(...(store.card(id).dependencies ?? []));
  }
}
