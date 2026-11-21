import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexThreadPattern, taskIdPattern, type RunActivity } from "../cli/model.ts";
import { directory, exists, readJson, writeJson } from "../cli/storage.ts";

type Phase = "work" | "review";

const active = new Map<string, Map<string, RunActivity>>();

export function stageRunJournal(project: string, id: string, phase: Phase, sessionId: string) {
  const path = join(project, ".tasks", "stage-run-history", id, phase, sessionId + ".json");
  const entries = new Map<string, RunActivity>();
  let timeout: NodeJS.Timeout | undefined;
  let changed = false;

  function flush() {
    clearTimeout(timeout);
    timeout = undefined;
    if (!changed) return;
    try {
      const folder = dirname(path);
      const task = dirname(folder);
      const root = dirname(task);
      directory(dirname(root));
      for (const dir of [root, task, folder]) directory(dir, true);
      writeJson(path, [...entries.values()]);
      changed = false;
    } catch (error) {
      console.warn("Could not save specialist activity:", (error as Error).message);
    }
  }

  return {
    record(item: RunActivity) {
      entries.set(item.threadId + "\0" + item.id, item);
      active.set(path, entries);
      changed = true;
      timeout ??= setTimeout(flush, 2000).unref();
    },
    flush,
    close() {
      flush();
      active.delete(path);
    },
  };
}

export function readStageRunHistory(project: string, id: string) {
  const history: Record<Phase, RunActivity[]> = { work: [], review: [] };
  if (!taskIdPattern.test(id)) return history;
  const task = join(project, ".tasks", "stage-run-history", id);
  for (const phase of ["work", "review"] as const) {
    const path = join(task, phase);
    const saved = new Set<string>();
    if (exists(path)) {
      directory(dirname(dirname(task)));
      directory(dirname(task));
      directory(task);
      directory(path);
      for (const name of readdirSync(path)) {
        if (name.endsWith(".json") && codexThreadPattern.test(name.slice(0, -5))) saved.add(join(path, name));
      }
    }
    for (const file of active.keys()) {
      if (dirname(file) === path) saved.add(file);
    }
    for (const file of saved) {
      const entries = active.get(file);
      for (const item of entries?.values() ?? readJson(file) as RunActivity[]) {
        history[phase].push(item);
      }
    }
    history[phase].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  }
  return history;
}
