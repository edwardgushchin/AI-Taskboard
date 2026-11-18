import { closeSync, fstatSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function fileLink(path: string, descriptor: number): FileLink {
  const entry = fstatSync(descriptor);
  if (!entry.isFile()) throw new Error("Choose a regular file.");
  return { path, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, dev: entry.dev, ino: entry.ino };
}

function withFileLink<T>(path: string, read: (current: FileLink, descriptor: number) => T): T {
  let source: { descriptor: number; current: FileLink };
  let descriptor: number | undefined;
  try {
    const canonical = realpathSync(path);
    descriptor = openSync(canonical, "r");
    source = { descriptor, current: fileLink(canonical, descriptor) };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new TaskboardError("ATTACHMENT_UNAVAILABLE", "Attachment unavailable: " + path + ". " + (error as Error).message);
  }
  try {
    return read(source.current, source.descriptor);
  } finally {
    closeSync(source.descriptor);
  }
}

// Open for reading without consuming content. Links do not grant agent access.
export function captureFileLink(path: string): FileLink {
  return withFileLink(path, current => current);
}

function requireSameFile(link: FileLink, current: FileLink) {
  if ((Object.keys(link) as (keyof FileLink)[]).some(key => current[key] !== link[key])) {
    throw changedFile(link);
  }
}

function changedFile(link: FileLink) {
  return new TaskboardError("ATTACHMENT_CHANGED", "Attachment changed; attach the source again: " + link.path);
}

export function verifyFileLink(link: FileLink): string {
  const current = captureFileLink(link.path);
  requireSameFile(link, current);
  return current.path;
}

export function snapshotFileLink(link: FileLink, destination: string) {
  let created = false;
  try {
    withFileLink(link.path, (current, source) => {
      requireSameFile(link, current);
      const output = openSync(destination, "wx");
      created = true;
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let remaining = link.size;
        while (remaining > 0) {
          const count = readSync(source, buffer, 0, Math.min(buffer.length, remaining), null);
          if (!count) throw changedFile(link);
          writeFileSync(output, buffer.subarray(0, count));
          remaining -= count;
        }
        requireSameFile(link, fileLink(current.path, source));
        verifyFileLink(link);
      } finally {
        closeSync(output);
      }
    });
  } catch (error) {
    if (created) rmSync(destination, { force: true });
    throw error;
  }
}
