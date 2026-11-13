import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TaskboardError } from "../cli/model.ts";

function insideProject(root: string, file: string) {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

export async function projectSha256(project: string, input: unknown, signal: AbortSignal) {
  if (typeof input !== "string" || !input.trim() || /[\x00-\x1f\x7f:]/.test(input) || /^[\\/]/.test(input)) {
    throw new TaskboardError("INVALID_INPUT", "Use a file path relative to the current project.");
  }
  const outside = () => new TaskboardError("INVALID_INPUT", "Choose a file inside the current project.");
  const unreadable = () => new TaskboardError("FILE_HASH_UNAVAILABLE", "Could not read a regular file at that project path.");
  try {
    const root = await realpath(project);
    const requested = resolve(root, input.replaceAll("\\", "/"));
    if (!insideProject(root, requested)) throw outside();
    const path = await realpath(requested);
    if (!insideProject(root, path)) throw outside();
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
      return { path: relative(root, requested).split(sep).join("/"), sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TaskboardError) throw error;
    throw unreadable();
  }
}
