import { closeSync, fstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { TaskboardError } from "./model.ts";

export interface FileLink {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export function isFileLink(value: unknown): value is FileLink {
  if (!value || typeof value !== "object") return false;
  const link = value as FileLink;
  return typeof link.path === "string" && isAbsolute(link.path) &&
    [link.size, link.mtimeMs, link.ctimeMs, link.dev, link.ino].every(Number.isFinite) &&
    Number.isSafeInteger(link.size) && link.size >= 0;
}

// Open for reading without consuming content. Neither links nor permission checks grant agent access.
export function captureFileLink(path: string): FileLink {
  let descriptor: number | undefined;
  try {
    const canonical = realpathSync(path);
    descriptor = openSync(canonical, "r");
    const entry = fstatSync(descriptor);
    if (!entry.isFile()) throw new Error("Choose a regular file.");
    return { path: canonical, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
      dev: entry.dev, ino: entry.ino };
  } catch (error) {
    throw new TaskboardError("ATTACHMENT_UNAVAILABLE", "Attachment unavailable: " + path + ". " + (error as Error).message);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyFileLink(link: FileLink): string {
  const current = captureFileLink(link.path);
  if ((Object.keys(link) as (keyof FileLink)[]).some(key => current[key] !== link[key])) {
    throw new TaskboardError("ATTACHMENT_CHANGED", "Attachment changed; attach the source again: " + link.path);
  }
  return current.path;
}
