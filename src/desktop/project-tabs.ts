import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface SavedWindow {
  projects: string[];
  active?: string;
}

export function projectIdentity(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return stat.dev + ":" + stat.ino;
  } catch {
    return resolve(path);
  }
}

export function projectPath(path: string): string {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

export function projectLabels(paths: string[]) {
  return paths.map(path => {
    const name = basename(path) || path;
    const duplicates = paths.filter(other => other !== path && basename(other) === name);
    let detail = "";
    if (duplicates.length) {
      detail = basename(dirname(path));
      if (duplicates.some(other => basename(dirname(other)) === detail)) detail = dirname(path);
    }
    return { path, name, detail };
  });
}

export function savedWindows(value: unknown): SavedWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(window => {
    if (!window || !Array.isArray(window.projects)) return [];
    const projects: string[] = [];
    const identities = new Set<string>();
    for (const path of window.projects) {
      if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) continue;
      const identity = projectIdentity(path);
      if (identities.has(identity)) continue;
      identities.add(identity);
      projects.push(path);
    }
    return [{ projects, active: projects.includes(window.active) ? window.active : projects[0] }];
  });
}
