import { projectIdentity, projectLabels } from "./project-tabs.ts";

// Provider turns, independent of tabs, task statuses and reserved agent slots.
const runs = new Map<symbol, { path: string; identity: string }>();
const listeners = new Set<() => void>();

export function observeActiveRuns(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function trackActiveRun(project: string) {
  const key = Symbol();
  runs.set(key, { path: project, identity: projectIdentity(project) });
  for (const listener of listeners) listener();
  return () => {
    if (runs.delete(key)) for (const listener of listeners) listener();
  };
}

export function activeRunSummary(projects: { path: string; name?: string }[] = []) {
  const boards = new Map<string, { path: string; name?: string; count: number }>();
  for (const run of runs.values()) {
    const board = boards.get(run.identity);
    if (board) board.count++;
    else boards.set(run.identity, { path: run.path, count: 1,
      name: projects.find(project => projectIdentity(project.path) === run.identity)?.name });
  }
  const entries = [...boards.values()];
  return { total: runs.size, boards: projectLabels(entries).map((label, index) =>
    ({ ...label, count: entries[index].count })) };
}
