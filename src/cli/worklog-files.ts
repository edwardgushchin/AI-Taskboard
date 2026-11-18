import { globSync, statSync } from "node:fs";
import { join } from "node:path";
import { directory, exists, readBinary, writeAtomic } from "./storage.ts";

export const maxWorklogPartBytes = 32 * 1024 * 1024;

export function worklogParts(root: string, day?: string) {
  const files = day ? join(day.slice(0, 4), day.slice(5, 7), day + "*.md").replaceAll("\\", "/")
    : "[0-9][0-9][0-9][0-9]/[0-9][0-9]/*.md";
  return globSync(files, { cwd: root }).flatMap(file => {
    const match = /^(\d{4})[\\/](\d{2})[\\/](\d{4}-\d{2}-\d{2})(?:\.part-([2-9]|[1-9]\d+))?\.md$/.exec(file);
    if (!match || !match[3]!.startsWith(match[1] + "-" + match[2] + "-") || (day && match[3] !== day)) return [];
    const part = Number(match[4] ?? 1);
    if (!Number.isSafeInteger(part)) return [];
    return [{ path: join(root, file), day: match[3]!, part }];
  }).sort((a, b) => a.day.localeCompare(b.day) || a.part - b.part);
}

export function readWorklogPart(path: string, maxBytes = maxWorklogPartBytes) {
  if (statSync(path).size > maxBytes) throw new Error("Worklog part exceeds its size limit.");
  return readBinary(path).toString("utf8");
}

// The caller holds the board's Worklog lock. Each block is independently atomic.
export function appendWorklogBlocks(root: string, day: string, blocks: string[]) {
  const year = join(root, day.slice(0, 4));
  const month = join(year, day.slice(5, 7));
  directory(year, true);
  directory(month, true);
  const header = "# Codex Worklog — " + day + "\n";
  let part = worklogParts(root, day).at(-1)?.part ?? 1;
  const filename = () => join(month, day + (part === 1 ? "" : ".part-" + part) + ".md");
  let path = filename();
  let prior = exists(path) ? readWorklogPart(path) : header;
  if (!prior.startsWith(header) || !prior.endsWith("\n")) throw new Error("Invalid daily Worklog file.");
  let before = prior;
  let size = Buffer.byteLength(prior);
  let added = "";
  const headerBytes = Buffer.byteLength(header);
  const sizes = blocks.map(block => Buffer.byteLength(block));
  if (sizes.some(bytes => bytes + headerBytes > maxWorklogPartBytes)) throw new Error("A Worklog block exceeds 32 MiB.");
  for (const [index, block] of blocks.entries()) {
    const bytes = sizes[index]!;
    if (size + bytes > maxWorklogPartBytes) {
      if (added) writeAtomic(path, prior + added);
      part++;
      path = filename();
      prior = header;
      before = header;
      size = headerBytes;
      added = "";
    }
    added += block;
    size += bytes;
  }
  if (added) writeAtomic(path, prior + added);
  return { path, before, after: prior + added };
}
