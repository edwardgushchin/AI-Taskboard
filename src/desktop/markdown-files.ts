import { open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { insideProject } from "./project-files.ts";
import sourceFile from "./source-files.cjs";

const maxDocumentBytes = 4 * 1024 * 1024;

// Only read text documents; links never execute files or navigate the renderer.
export async function readMarkdownFile(base: string, value: string, source?: string, project = base) {
  let path: string;
  let line: number | undefined;
  try {
    if (/[\0-\x1f\x7f]/.test(value)) throw new Error();
    const fragmentIndex = value.indexOf("#");
    const location = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
    const fragment = fragmentIndex < 0 ? "" : value.slice(fragmentIndex);
    const suffix = /:(\d+)(?::\d+)?$/.exec(location);
    const link = suffix ? location.slice(0, suffix.index) : location;
    path = /^file:/i.test(link) ? fileURLToPath(link) : decodeURIComponent(link);
    if (process.platform === "win32") path = path.replace(/^\/(?=[a-z]:[\\/])/i, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) throw new Error();
    if (sourceFile.test(path)) {
      const fragmentLine = /^#L([1-9]\d*)$/.exec(fragment);
      line = Number(suffix?.[1] ?? fragmentLine?.[1]);
    }
    if ((line !== undefined ? !Number.isSafeInteger(line) || line < 1 : !/\.(md|markdown|txt|log|json)$/i.test(path)) ||
        /[\0-\x1f\x7f]/.test(path)) throw new Error();
    path = resolve(source ? dirname(source) : base, path.replaceAll("\\", "/"));
  } catch {
    throw new Error("INVALID_MARKDOWN_LINK");
  }
  if (!/\.(md|markdown)$/i.test(path)) {
    if (/^[\\/]{2}/.test(path) || path.replace(/^[a-z]:/i, "").includes(":") ||
        ![project, base].some(root => insideProject(root, path))) {
      throw new Error("INVALID_MARKDOWN_LINK");
    }
    const actual = await realpath(path);
    const roots = await Promise.all([...new Set([project, base])].map(root => realpath(root).catch(() => root)));
    if (!roots.some(root => insideProject(root, actual)) || (line !== undefined && !sourceFile.test(actual))) {
      throw new Error("INVALID_MARKDOWN_LINK");
    }
    path = actual;
  }
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("MARKDOWN_UNAVAILABLE");
    if (stat.size > maxDocumentBytes) throw new Error("MARKDOWN_TOO_LARGE");
    const buffer = Buffer.alloc(maxDocumentBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxDocumentBytes) throw new Error("MARKDOWN_TOO_LARGE");
    return { path, name: basename(path), text: buffer.toString("utf8", 0, size).replace(/^\uFEFF/, ""),
      ...(line !== undefined ? { line } : {}) };
  } finally { await file.close(); }
}
