import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJson, writeJson } from "../cli/storage.ts";

const filename = "recent-boards.json";

export function normalizeRecentBoards(paths: unknown[]): string[] {
  const boards = new Map<string, string>();
  for (const path of paths) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) continue;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (!boards.has(key)) boards.set(key, path);
    if (boards.size === 10) break;
  }
  return [...boards.values()];
}

function readHistory(file: string): string[] | undefined {
  try {
    const saved = readJson(file);
    if (Array.isArray(saved)) return normalizeRecentBoards(saved);
  } catch {
    // A missing or unreadable history does not prevent opening a board.
  }
}

export function readRecentBoards(appData: string, userData: string): string[] | undefined {
  return readHistory(join(appData, "AI Taskboard", filename)) ?? readHistory(join(userData, filename));
}

export function rememberRecentBoard(appData: string, userData: string, path: string): string[] {
  const directory = join(appData, "AI Taskboard");
  mkdirSync(directory, { recursive: true });
  const lock = new DatabaseSync(join(directory, ".recent-boards.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
    const recent = normalizeRecentBoards([path, ...(readRecentBoards(appData, userData) ?? [])]);
    writeJson(join(directory, filename), recent);
    return recent;
  } finally {
    lock.close();
  }
}
