import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const maxMarkdownBytes = 4 * 1024 * 1024;

// Only read Markdown documents; links never execute files or navigate the renderer.
export async function readMarkdownFile(base: string, value: string, source?: string) {
  let path: string;
  try {
    if (/[\0-\x1f\x7f]/.test(value)) throw new Error();
    const link = value.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
    path = /^file:/i.test(link) ? fileURLToPath(link) : decodeURIComponent(link);
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) throw new Error();
    if (!/\.(md|markdown)$/i.test(path) || /[\0-\x1f\x7f]/.test(path)) throw new Error();
    path = resolve(source ? dirname(source) : base, path.replaceAll("\\", "/"));
  } catch {
    throw new Error("INVALID_MARKDOWN_LINK");
  }
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("MARKDOWN_UNAVAILABLE");
    if (stat.size > maxMarkdownBytes) throw new Error("MARKDOWN_TOO_LARGE");
    const buffer = Buffer.alloc(maxMarkdownBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxMarkdownBytes) throw new Error("MARKDOWN_TOO_LARGE");
    return { path, name: basename(path), text: buffer.toString("utf8", 0, size).replace(/^\uFEFF/, "") };
  } finally { await file.close(); }
}
