import { closeSync, copyFileSync, cpSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { git, invokeGit } from "./git.ts";
import { TaskboardError } from "./model.ts";
import { withGuardedBranchRefs } from "./ref-transaction.ts";

function saveWorktreePaths(root: string, scratch: string, changed: string[]) {
  const invalidPath = () => new TaskboardError("GIT_WORKTREE_PATH_INVALID", "Git returned a worktree path that could not be backed up safely.");
  const copyOptions = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true };
  const caseSetting = invokeGit(root, ["config", "--bool", "--get", "core.ignorecase"]).stdout.trim();
  const ignoreCase = caseSetting === "true" || (!caseSetting && process.platform === "win32");
  const entries = new Set<string>();
  const originals: { original: string; saved?: string }[] = [];
  // Save a changed ancestor once, including file/directory replacements and
  // the first missing directory of an incoming path.
  for (const path of [...changed].sort((a, b) => a.split("/").length - b.split("/").length)) {
    const pieces = path.split("/");
    if (pieces.some(piece => !piece || piece === "." || piece === ".." || piece.includes("\ufffd") ||
        (process.platform === "win32" && /[\\:]/.test(piece)))) {
      throw invalidPath();
    }
    let parent = "";
    for (let index = 0; index < pieces.length; index++) {
      let name = pieces[index]!;
      const directory = join(root, parent);
      const candidate = join(directory, name);
      const stat = lstatSync(candidate, { throwIfNoEntry: false });
      if (stat && !stat.isSymbolicLink()) {
        // Resolve actual spelling and Windows short-name aliases.
        name = basename(realpathSync.native(candidate));
      } else if (stat && ignoreCase) {
        const names = readdirSync(directory);
        const key = name.normalize("NFC").toLowerCase();
        name = names.find(entry => entry === name) ??
          names.find(entry => entry.normalize("NFC").toLowerCase() === key) ?? name;
      }
      if (name.toLowerCase() === ".git" || (!parent && name.toLowerCase() === ".tasks")) {
        throw invalidPath();
      }
      const relativePath = parent ? parent + "/" + name : name;
      if (entries.has(relativePath)) break;
      if (stat?.isDirectory() && index < pieces.length - 1) {
        parent = relativePath;
        continue;
      }
      const saved = stat ? join(scratch, "path-" + entries.size) : undefined;
      const original = join(root, relativePath);
      if (saved) cpSync(original, saved, copyOptions);
      entries.add(relativePath);
      originals.push({ original, saved });
      break;
    }
  }

  writeFileSync(join(scratch, "paths.json"), JSON.stringify(originals, null, 2));
  return () => {
    for (const { original, saved } of originals) {
      rmSync(original, { recursive: true, force: true, maxRetries: 3 });
      if (saved) cpSync(saved, original, copyOptions);
    }
  };
}

export async function advanceWorktree(root: string, ref: string, head: string, target: string,
  env: NodeJS.ProcessEnv, check: () => string[]) {
  const index = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trimEnd();
  const lock = index + ".lock";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lock, "wx");
  } catch (error) {
    throw new TaskboardError("GIT_INDEX_LOCKED", "Git could not lock the worktree index. Finish the other Git operation and retry.",
      { reason: (error as NodeJS.ErrnoException).code });
  }
  let removeLock = true;
  try {
    await withGuardedBranchRefs(root, ref, head, ["option no-deref", "update " + ref + " " + target + " " + head],
      "taskboard: fast-forward " + ref, async commit => {
        const changed = check();
        const scratch = mkdtempSync(join(tmpdir(), "taskboard-index-"));
        let preserveBackup = false;
        try {
          const temporaryIndex = join(scratch, "index");
          copyFileSync(index, temporaryIndex);
          const restore = saveWorktreePaths(root, scratch, changed);
          try {
            git(root, ["-c", "submodule.recurse=false", "read-tree", "-m", "-u", head, target],
              { ...env, GIT_INDEX_FILE: temporaryIndex });
            writeFileSync(descriptor!, readFileSync(temporaryIndex));
            closeSync(descriptor!);
            descriptor = undefined;
            await commit();
          } catch (error) {
            try {
              restore();
            } catch {
              preserveBackup = true;
              throw new TaskboardError("GIT_FAST_FORWARD_RECOVERY_FAILED",
                "Git could not restore all worktree paths after fast-forward failed. The backup was saved for manual recovery.",
                { ref, head, target, backup: scratch });
            }
            throw error;
          }
          try {
            renameSync(lock, index);
            removeLock = false;
          } catch {
            // Keep the new index and stop other Git writers until the operator recovers.
            removeLock = false;
            throw new TaskboardError("GIT_INDEX_PUBLISH_FAILED",
              "The branch advanced, but Git could not publish the prepared index. The index lock contains the prepared index.", { ref, head: target, lock });
          }
        } finally {
          if (!preserveBackup) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
      });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (removeLock) rmSync(lock, { force: true });
  }
}
