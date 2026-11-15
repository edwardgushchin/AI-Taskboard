import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TaskboardError } from "../cli/model.ts";

export function insideProject(root: string, file: string) {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function requireProjectPath(root: string, file: string) {
  if (!insideProject(root, file)) throw new TaskboardError("INVALID_INPUT", "Choose a path inside the current project.");
  return file;
}

async function projectPath(project: string, input: unknown) {
  if (typeof input !== "string" || !input.trim() || /[\x00-\x1f\x7f:]/.test(input) || /^[\\/]/.test(input)) {
    throw new TaskboardError("INVALID_INPUT", "Use a path relative to the current project.");
  }
  const root = await realpath(project);
  const requested = requireProjectPath(root, resolve(root, input.replaceAll("\\", "/")));
  return { root, requested, label: relative(root, requested).split(sep).join("/") || "." };
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const entryKind = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) =>
  entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "link" : "other";

export async function inspectProjectPath(project: string, input: unknown, list: unknown, signal: AbortSignal) {
  if (list !== undefined && typeof list !== "boolean") throw new TaskboardError("INVALID_INPUT", "list must be a boolean.");
  try {
    const { root, requested, label } = await projectPath(project, input);
    signal.throwIfAborted();
    let path: string;
    try {
      path = requireProjectPath(root, await realpath(requested));
    } catch (error) {
      if (!isMissing(error)) throw error;
      // Verify the nearest existing ancestor before calling a path absent.
      let ancestor = requested;
      while (ancestor !== root) {
        signal.throwIfAborted();
        try {
          await lstat(ancestor);
        } catch (error) {
          if (!isMissing(error)) throw error;
          ancestor = dirname(ancestor);
          continue;
        }
        const parent = requireProjectPath(root, await realpath(ancestor));
        if (!(await stat(parent)).isDirectory()) {
          throw new TaskboardError("PROJECT_PATH_UNAVAILABLE", "A parent path is not a directory.");
        }
        break;
      }
      return { path: label, exists: false as const };
    }
    const kind = entryKind(await stat(path));
    const result = { path: label, exists: true as const, kind };
    if (!list) return result;
    if (kind !== "directory") throw new TaskboardError("INVALID_INPUT", "Choose a directory to list its entries.");
    const entries = [];
    const limit = 200;
    const directory = await opendir(requireProjectPath(root, await realpath(path)));
    try {
      requireProjectPath(root, await realpath(directory.path));
    } catch (error) {
      await directory.close();
      throw error;
    }
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (entries.length === limit) return { ...result, entries, truncated: true };
      entries.push({ name: entry.name, kind: entryKind(entry) });
    }
    return { ...result, entries, truncated: false };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TaskboardError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new TaskboardError("PROJECT_PATH_UNAVAILABLE", "Could not inspect the project path" + (code ? " (" + code + ")." : "."));
  }
}

export async function projectSha256(project: string, input: unknown, signal: AbortSignal) {
  const unreadable = () => new TaskboardError("FILE_HASH_UNAVAILABLE", "Could not read a regular file at that project path.");
  try {
    const { root, requested, label } = await projectPath(project, input);
    if (requested === root) throw new TaskboardError("INVALID_INPUT", "Choose a file inside the current project.");
    const path = requireProjectPath(root, await realpath(requested));
    if (path === root) throw new TaskboardError("INVALID_INPUT", "Choose a file inside the current project.");
    const before = await stat(path, { bigint: true });
    if (!before.isFile()) throw unreadable();
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const file = await open(path, flags);
    try {
      const opened = await file.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
          !insideProject(root, await realpath(path))) throw unreadable();
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) hash.update(chunk);
      const after = await file.stat({ bigint: true });
      if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
        throw new TaskboardError("FILE_CHANGED", "The file changed while it was being hashed. Retry after it stops changing.");
      }
      return { path: label, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TaskboardError) throw error;
    throw unreadable();
  }
}
