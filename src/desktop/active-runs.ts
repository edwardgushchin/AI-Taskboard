import { projectIdentity, projectLabels } from "./project-tabs.ts";
import { registerRuntime, runtimeEntries, runtimeLocation } from "./board-runtime.ts";
import { exists } from "../cli/storage.ts";
import { join } from "node:path";

let shared = false;
export function enableSharedRuns() { shared = true; }
export function trackProvider(project: string, pid?: number) {
  if (!shared || !pid || !exists(join(runtimeLocation(project).directory, "board.json"))) return Object.assign(() => {}, { run: <T>(callback: () => T) => callback() });
  return registerRuntime(project, { kind: "provider", pid })!;
}
export function claimDiscussion(project: string, task?: string) {
  if (!shared || !task) return Object.assign(() => {}, { run: <T>(callback: () => T) => callback() });
  const release = registerRuntime(project, { kind: "task", task }, entries => !entries.some(entry => entry.kind !== "queue" && entry.task === task));
  if (!release) throw new Error("This task already has a running agent in another window.");
  return release;
}

// Provider turns, independent of tabs, task statuses and reserved agent slots.
const runs = new Map<symbol, { path: string; identity: string }>();
const listeners = new Set<() => void>();

export function observeActiveRuns(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function trackActiveRun(project: string) {
  const release = shared ? registerRuntime(project, { kind: "turn" }) : undefined;
  const key = Symbol();
  runs.set(key, { path: project, identity: projectIdentity(project) });
  for (const listener of listeners) listener();
  return () => {
    release?.();
    if (runs.delete(key)) for (const listener of listeners) listener();
  };
}

export function activeRunSummary(projects: { path: string; name?: string }[] = []) {
  const boards = new Map<string, { path: string; name?: string; count: number }>();
  const observed = shared ? projects.flatMap(project => runtimeEntries(project.path)
    .filter(entry => entry.kind === "turn").map(() => ({ path: project.path, identity: projectIdentity(project.path) }))) : [...runs.values()];
  for (const run of observed) {
    const board = boards.get(run.identity);
    if (board) board.count++;
    else boards.set(run.identity, { path: run.path, count: 1,
      name: projects.find(project => projectIdentity(project.path) === run.identity)?.name });
  }
  const entries = [...boards.values()];
  return { total: observed.length, boards: projectLabels(entries).map((label, index) =>
    ({ ...label, count: entries[index].count })) };
}
