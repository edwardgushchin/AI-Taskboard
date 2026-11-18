import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { maxAttachmentBytes, member, number, object, TaskboardError, strings, taskIdPattern } from "./model.ts";
import type { ArtifactKind } from "./model.ts";
import { directory, exists, readJson, removeFile, writeJson } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

interface TaskArtifact {
  source: string;
  sha256: string;
}

const maxArtifactEntries = 64;

function checkArtifactBudget(bytes: number, entries: number): void {
  if (bytes > maxAttachmentBytes || entries > maxArtifactEntries) {
    throw new TaskboardError("ARTIFACT_LIMIT", "A task can keep up to 64 MiB and 64 artifact entries. Select the files needed for review.", {
      bytes, entries, maxBytes: maxAttachmentBytes, maxEntries: maxArtifactEntries,
    });
  }
}

function artifactFolder(store: BoardStore, id: string, create = false): string {
  if (!taskIdPattern.test(id)) throw new TaskboardError("INVALID_INPUT", "Use an exact task ID.");
  const root = join(store.location.directory, "artifacts");
  if (create || exists(root)) directory(root, create);
  const folder = join(root, id);
  if (create || exists(folder)) directory(folder, create);
  return folder;
}

export function artifactFiles(store: BoardStore, id: string) {
  const folder = artifactFolder(store, id);
  const manifest = join(folder, "manifest.json");
  if (!exists(manifest)) return [];
  const entries = readJson(manifest);
  if (!Array.isArray(entries)) throw new TaskboardError("CORRUPT_STORAGE", "Invalid artifact manifest.");
  return entries.map(entry => {
    const { source, sha256 } = object(entry);
    if (typeof source !== "string" || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new TaskboardError("CORRUPT_STORAGE", "Invalid artifact manifest entry.");
    }
    const parts = pathParts(source);
    return { source, sha256, file: join(folder, sha256, parts.at(-1)!) };
  });
}

export function discardTaskArtifacts(store: BoardStore, id: string): void {
  const folder = artifactFolder(store, id);
  if (exists(folder)) rmSync(folder, { recursive: true });
}

export function openReviewArtifact(store: BoardStore, id: string, input: Record<string, unknown>) {
  const artifact = artifactFiles(store, id).find(entry => entry.source === input.source && entry.sha256 === input.sha256);
  if (!artifact) throw new TaskboardError("ARTIFACT_NOT_FOUND", "Select the source and SHA-256 from this submission's saved materials.");
  const offset = input.offset === undefined ? 0 : number(input.offset, "offset", 0);
  const format = member(input.format ?? "text", ["text", "png"], "artifact format");
  if (format === "png" && offset !== 0) throw new TaskboardError("INVALID_INPUT", "Read the PNG without an offset.");
  return openSavedArtifact(artifact, format, offset);
}

function openSavedArtifact(artifact: ReturnType<typeof artifactFiles>[number], format: ArtifactKind, offset: number) {
  directory(dirname(artifact.file));
  if (!lstatSync(artifact.file, { throwIfNoEntry: false })?.isFile()) {
    throw new TaskboardError("ARTIFACT_NOT_FOUND", "The saved material is unavailable.");
  }
  const fd = openSync(artifact.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  return { fd, offset, source: artifact.source, sha256: artifact.sha256, format };
}

export function readSavedPng(store: BoardStore, path: string) {
  const comparable = (value: string) => sep === "\\" ? value.replaceAll("\\", "/").toLowerCase() : value;
  const candidate = comparable(path);
  const id = /(?:^|\/)\.tasks\/artifacts\/(T-\d{4,})\/[a-f0-9]{64}\/[^/]+\.png$/i.exec(candidate)?.[1].toUpperCase();
  if (!id) return null;
  const artifact = artifactFiles(store, id).find(({ file }) =>
    candidate === comparable(file) || candidate === comparable(relative(store.location.root, file)));
  if (!artifact) return null;
  const result = readReviewArtifact(openSavedArtifact(artifact, "png", 0));
  return "pngBase64" in result ? { name: basename(artifact.file), base64: result.pngBase64 } : null;
}

function readArtifactBytes(fd: number, kind: ArtifactKind) {
  const limit = 1024 * 1024 * (kind === "png" ? 4 : 1);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size > limit) {
      throw new TaskboardError("ARTIFACT_LIMIT", kind === "png" ? "Choose a PNG no larger than 4 MiB." :
        "Choose a text report or excerpt no larger than 1 MiB.");
    }
    const buffer = Buffer.allocUnsafe(entry.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size !== entry.size) {
      throw new TaskboardError("ARTIFACT_CHANGED", "The file changed size while reading.");
    }
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function artifactText(bytes: Buffer) {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("NUL in text");
    return content;
  } catch {
    throw new TaskboardError("ARTIFACT_NOT_TEXT", "Choose a UTF-8 text file.");
  }
}

function pngDimensions(bytes: Buffer) {
  if (bytes.length >= 45 && bytes.subarray(0, 16).equals(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")) &&
      bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width * height <= 16_000_000) return { width, height };
  }
  throw new TaskboardError("ARTIFACT_NOT_PNG", "Choose a PNG screenshot up to 16 megapixels.");
}

export function readReviewArtifact({ fd, offset, source, sha256, format }: ReturnType<typeof openReviewArtifact>) {
  const bytes = readArtifactBytes(fd, format);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new TaskboardError("ARTIFACT_CHANGED", "The saved material does not match the reviewed SHA-256.");
  }
  if (format === "png") return { source, sha256, ...pngDimensions(bytes), pngBase64: bytes.toString("base64") };
  const content = artifactText(bytes);
  if (offset > content.length || /[\uDC00-\uDFFF]/.test(content.charAt(offset))) {
    throw new TaskboardError("INVALID_INPUT", "Use the nextOffset returned for this artifact.");
  }
  let end = offset + 16_000;
  if (/[\uDC00-\uDFFF]/.test(content.charAt(end))) end--;
  return { source, sha256, text: content.slice(offset, end),
    ...(end < content.length ? { nextOffset: end } : {}) };
}

function pathParts(value: string): string[] {
  const parts = value.replace(/[\\/]$/, "").split(/[\\/]/);
  if (isAbsolute(value) || win32.isAbsolute(value) || parts.some(part =>
    !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part) ||
    (process.platform === "win32" && (/[. ]$|[<>"|?*]/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) ||
    parts.some((part, index) => /^\.git$/i.test(part) ||
      (/^\.tasks$/i.test(part) && (index !== 0 || parts[1] !== "qa")))) {
    throw new TaskboardError("INVALID_ARTIFACT_PATH", "Use a file or directory path relative to the task worktree.", { path: value });
  }
  return parts;
}

export function artifactSource(value: string) {
  return pathParts(value).join("/");
}

function sourcePath(root: string, parts: string[], allowMissing = false) {
  let path = root;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    if (allowMissing && !exists(path)) return;
    directory(path);
  }
  path = join(path, parts.at(-1)!);
  const entry = lstatSync(path, { throwIfNoEntry: !allowMissing });
  if (!entry) return;
  if (!entry.isFile() && !entry.isDirectory()) {
    throw new TaskboardError("INVALID_ARTIFACT_PATH", "Select regular files and directories without links.", { path });
  }
  return { path, entry };
}

export function inspectRequiredArtifact(root: string, source: string, kind: ArtifactKind) {
  const file = sourcePath(root, pathParts(source), true);
  if (!file?.entry.isFile()) {
    throw new TaskboardError("ARTIFACT_NOT_FOUND", "Capture the required artifact before preview and submission.", { source });
  }
  const bytes = readArtifactBytes(openSync(file.path, "r"), kind);
  if (kind === "png") pngDimensions(bytes);
  else if (!artifactText(bytes).trim()) throw new TaskboardError("ARTIFACT_NOT_TEXT", "Include a non-empty check report.", { source });
  return createHash("sha256").update(bytes).digest("hex");
}

function checksum(path: string, copy?: number, expectedBytes?: number): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let bytes: number;
    let total = 0;
    while ((bytes = readSync(fd, buffer)) > 0) {
      total += bytes;
      if (expectedBytes !== undefined && total > expectedBytes) {
        throw new TaskboardError("ARTIFACT_CHANGED", "The artifact grew while reading.", { path });
      }
      hash.update(buffer.subarray(0, bytes));
      if (copy !== undefined) {
        for (let offset = 0; offset < bytes;) offset += writeSync(copy, buffer, offset, bytes - offset);
      }
    }
    if (expectedBytes !== undefined && total !== expectedBytes) {
      throw new TaskboardError("ARTIFACT_CHANGED", "The artifact changed size while reading.", { path });
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function saveArtifacts(store: BoardStore, id: string, root: string, input: unknown, allowMissing = false,
  pinned?: ReadonlyMap<string, string>) {
  const selected = strings(input, "artifacts");
  if (!selected.length) return;
  const paths = new Map<string, { path: string; bytes: number }>();
  for (const value of selected) {
    const parts = pathParts(value);
    const source = parts.join("/");
    const original = sourcePath(root, parts, allowMissing || pinned?.has(source));
    if (!original) {
      if (pinned?.has(source)) throw new TaskboardError("ARTIFACT_NOT_FOUND", "Capture the required artifact before submitting.", { source });
      continue;
    }
    const { path, entry } = original;
    if (entry.isDirectory()) {
      throw new TaskboardError("ARTIFACT_DIRECTORY", "Select individual files needed for review.", { path: source });
    }
    paths.set(source, { path, bytes: entry.size });
    checkArtifactBudget(entry.size, paths.size);
  }
  if (!paths.size) return;
  const existing = artifactFiles(store, id);
  const folder = artifactFolder(store, id);
  const entries = new Map<string, TaskArtifact>();
  const stored = new Map<string, number>();
  let total = 0;
  for (const { source, sha256, file } of existing) {
    entries.set(source + "\0" + sha256, { source, sha256 });
    if (stored.has(file) || !exists(file)) continue;
    directory(dirname(file));
    const entry = lstatSync(file);
    if (!entry.isFile()) throw new TaskboardError("INVALID_STORAGE_PATH", "Expected a regular artifact file.", { path: file });
    stored.set(file, entry.size);
    total += entry.size;
  }
  checkArtifactBudget(total, entries.size);
  const planned = [];
  for (const [source, { path, bytes }] of paths) {
    if (!sourcePath(root, pathParts(source))?.entry.isFile()) {
      throw new TaskboardError("ARTIFACT_CHANGED", "The selected file changed before copying.", { path });
    }
    const sha256 = checksum(path, undefined, bytes);
    if (pinned?.has(source) && pinned.get(source) !== sha256) {
      throw new TaskboardError("ARTIFACT_CHANGED", "The required artifact changed after preview.", { source });
    }
    const file = join(folder, sha256, basename(source));
    if (!stored.has(file)) {
      stored.set(file, bytes);
      total += bytes;
    }
    entries.set(source + "\0" + sha256, { source, sha256 });
    checkArtifactBudget(total, entries.size);
    planned.push({ source, path, bytes, sha256, file });
  }
  artifactFolder(store, id, true);
  const created: string[] = [];
  const buckets = new Set<string>();
  try {
    for (const { source, path, bytes, sha256, file } of planned) {
      if (!sourcePath(root, pathParts(source))?.entry.isFile()) {
        throw new TaskboardError("ARTIFACT_CHANGED", "The selected file changed before copying.", { path });
      }
      const parent = dirname(file);
      if (!exists(parent)) buckets.add(parent);
      directory(parent, true);
      if (!exists(file)) {
        const temporary = join(parent, ".copy-" + randomUUID());
        try {
          const copy = openSync(temporary, "wx");
          try {
            if (checksum(path, copy, bytes) !== sha256) {
              throw new TaskboardError("ARTIFACT_CHANGED", "The artifact changed while copying.", { path: source });
            }
            fsyncSync(copy);
          } finally {
            closeSync(copy);
          }
          verifyArtifact(temporary, sha256, bytes);
          renameSync(temporary, file);
          created.push(file);
        } finally {
          removeFile(temporary);
        }
      } else {
        verifyArtifact(file, sha256, bytes);
      }
    }
    writeJson(join(folder, "manifest.json"), [...entries.values()]);
  } catch (error) {
    for (const file of created) removeFile(file);
    for (const bucket of buckets) {
      if (exists(bucket) && !readdirSync(bucket).length) rmdirSync(bucket);
    }
    throw error;
  }
}

function verifyArtifact(path: string, sha256: string, expectedBytes?: number): void {
  directory(dirname(path));
  if (!lstatSync(path).isFile() || checksum(path, undefined, expectedBytes) !== sha256) {
    throw new TaskboardError("ARTIFACT_CHANGED", "The file differs from the verified artifact.", { path });
  }
}

export function removeSavedSource(root: string, artifact: ReturnType<typeof artifactFiles>[number]): boolean {
  const { source, sha256, file } = artifact;
  const original = sourcePath(root, pathParts(source), true);
  if (!original) return false;
  const { path, entry } = original;
  if (!entry.isFile() || !exists(file)) return false;
  verifyArtifact(file, sha256);
  if (!sourcePath(root, pathParts(source), true)?.entry.isFile() || checksum(path) !== sha256) return false;
  removeFile(path);
  return true;
}
