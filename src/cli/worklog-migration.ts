import { createHash } from "node:crypto";
import { globSync, lstatSync, readdirSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { directory, exists, locateBoard, readBinary, removeFile, withLock } from "./storage.ts";
import { appendWorklogBlocks, readWorklogPart, worklogParts } from "./worklog-files.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const entry = /<!-- codex-worklog-entry:([0-9a-f]{24}) -->/g;
function blocks(text: string) {
  const starts = [...text.matchAll(/^## /gm)].map(match => match.index!);
  if (!starts.length && text.trim().split(/\r?\n/).length > 1) throw new Error("Legacy diary has unrecognized content.");
  return starts.map((start, index) => {
    const content = text.slice(start, starts[index + 1] ?? text.length).trimEnd() + "\n";
    const ids = [...content.matchAll(entry)].map(match => match[1]!);
    if (ids.length !== 1) throw new Error("Legacy block must have exactly one entry identity.");
    return { id: ids[0]!, content };
  });
}

function canonicalBlocks(root: string) {
  const known = new Map<string, string>();
  for (const { path } of worklogParts(root)) {
    directory(dirname(dirname(path)));
    directory(dirname(path));
    for (const block of blocks(readWorklogPart(path))) {
      if (known.has(block.id)) throw new Error("WORKLOG_ID_CONFLICT: duplicate canonical identity " + block.id);
      known.set(block.id, block.content);
    }
  }
  return known;
}

// Source files are never deleted here. Cleanup must separately confirm the copy.
export function migrateWorklog(project: string, sources?: string[]) {
  const location = locateBoard(project);
  const root = join(location.directory, "worklog");
  directory(location.directory);
  directory(root, true);
  const roots = sources ?? [join(location.root, ".dev-diary"), ...[".worktrees", ".taskboard-worktrees", ".tasks/worktrees"].flatMap(name => {
    const parent = join(location.root, name);
    if (!exists(parent)) return [];
    directory(parent);
    return readdirSync(parent).flatMap(name => {
      const child = join(parent, name);
      if (lstatSync(child).isSymbolicLink()) throw new Error("Refusing linked legacy worktree: " + child);
      return lstatSync(child).isDirectory() ? [join(child, ".dev-diary")] : [];
    });
  })];
  const report: { source: string; sha256: string; destination: string; before: string; after: string; added: number; verified: number }[] = [];
  for (const source of roots) {
    if (!exists(source)) continue;
    directory(source);
    for (const file of globSync("[0-9][0-9][0-9][0-9]/[0-9][0-9]/????-??-??.md", { cwd: source })) {
      const parts = file.split(/[/\\]/);
      directory(join(source, parts[0]!)); directory(join(source, parts[0]!, parts[1]!));
      const path = join(source, file);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Refusing linked legacy diary: " + path);
      const bytes = readBinary(path);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const day = parts[2]!.slice(0, 10);
      if (!text.startsWith("# Codex Worklog — " + day)) throw new Error("Invalid legacy diary header: " + path);
      const incoming = blocks(text);
      withLock(root, () => {
        const known = canonicalBlocks(root);
        const missing: string[] = [];
        for (const block of incoming) {
          const previous = known.get(block.id);
          if (previous !== undefined && previous !== block.content) throw new Error("WORKLOG_ID_CONFLICT: " + block.id + " in " + path);
          if (previous === undefined) { missing.push("\n" + block.content); known.set(block.id, block.content); }
        }
        if (!readBinary(path).equals(bytes)) throw new Error("Legacy diary changed during migration: " + path);
        const { path: destination, before, after } = appendWorklogBlocks(root, day, missing);
        const saved = missing.length ? canonicalBlocks(root) : known;
        if (incoming.some(block => saved.get(block.id) !== block.content)) throw new Error("Worklog migration verification failed: " + path);
        report.push({ source: path, sha256: hash(bytes), destination, before: hash(before), after: hash(after), added: missing.length, verified: incoming.length });
      });
    }
  }
  return report;
}

// Only used after the lifecycle guard has excluded live worktree users.
export function removeMigratedWorklog(project: string, source: string) {
  const report = migrateWorklog(project, [source]);
  const root = join(locateBoard(project).directory, "worklog");
  withLock(root, () => {
    const saved = canonicalBlocks(root);
    for (const row of report) {
      if (hash(readBinary(row.source)) !== row.sha256) throw new Error("Legacy diary changed before cleanup: " + row.source);
      if (blocks(readBinary(row.source).toString("utf8")).some(block => saved.get(block.id) !== block.content)) throw new Error("Legacy diary is not fully preserved: " + row.source);
    }
    for (const row of report) removeFile(row.source);
  });
  const empty = (path: string) => {
    if (!exists(path)) return;
    directory(path);
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (lstatSync(child).isDirectory() && !lstatSync(child).isSymbolicLink()) empty(child);
    }
    if (!readdirSync(path).length) rmdirSync(path);
  };
  empty(source); // Unknown files, locks and links are retained.
}
