import {
  chmodSync, closeSync, constants, copyFileSync, cpSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { excludeBoard, git, invokeGit } from "./git.ts";
import { TaskboardError } from "./model.ts";
import { withGuardedBranchRefs } from "./ref-transaction.ts";

const copyOptions = { recursive: true, verbatimSymlinks: true, preserveTimestamps: true };
const inspectPath = (path: string) => lstatSync(path, { throwIfNoEntry: false });

function copyFilterContext(root: string, checkout: string) {
  for (const name of readdirSync(root)) {
    if ([".git", ".tasks"].includes(name.toLowerCase())) {
      continue;
    }
    cpSync(join(root, name), join(checkout, name), {
      ...copyOptions,
      filter: path => {
        const entry = inspectPath(path);
        return !!entry && (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink());
      },
    });
  }
}

type Snapshot = { relative: string; original: string; saved: string };
type Publication = {
  snapshot: Snapshot;
  staged: string;
  destination: string;
  backup: string;
  previous: string;
  writing?: boolean;
  installed?: boolean;
};

function samePath(left: string, right: string): boolean {
  const a = inspectPath(left);
  const b = inspectPath(right);
  if (!a || !b) return !a && !b;
  if (a.mode !== b.mode) return false;
  if (a.isSymbolicLink()) return readlinkSync(left) === readlinkSync(right);
  if (a.isFile()) return a.size === b.size && readFileSync(left).equals(readFileSync(right));
  if (!a.isDirectory()) return false;
  const names = readdirSync(left).sort();
  const other = readdirSync(right).sort();
  return names.length === other.length && names.every((name, index) =>
    name === other[index] && samePath(join(left, name), join(right, name)));
}

function copyNewPath(source: string, destination: string) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination);
    for (const name of readdirSync(source)) {
      copyNewPath(join(source, name), join(destination, name));
    }
    chmodSync(destination, stat.mode);
  } else if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
  } else {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, stat.mode);
  }
}

function stageWorktreePaths(root: string, scratch: string, checkout: string, changed: string[], fullCheckout: boolean) {
  const invalidPath = () => new TaskboardError("GIT_WORKTREE_PATH_INVALID", "Git returned a worktree path that could not be backed up safely.");
  const caseSetting = invokeGit(root, ["config", "--bool", "--get", "core.ignorecase"]).stdout.trim();
  const ignoreCase = caseSetting === "true" || (!caseSetting && process.platform === "win32");
  const entries = new Set<string>();
  const attributeDirectories = new Set<string>();
  const snapshots: Snapshot[] = [];
  // Capture an affected ancestor only once, including file/directory replacements
  // and the first missing directory of an incoming path.
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
      if (!fullCheckout && !attributeDirectories.has(parent)) {
        attributeDirectories.add(parent);
        const attributes = join(directory, ".gitattributes");
        if (inspectPath(attributes)?.isFile()) {
          cpSync(attributes, join(checkout, parent, ".gitattributes"), copyOptions);
        }
      }
      const candidate = join(directory, name);
      const stat = inspectPath(candidate);
      if (stat && !stat.isSymbolicLink()) {
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
      const relative = parent ? parent + "/" + name : name;
      if (entries.has(relative)) break;
      if (stat?.isDirectory() && index < pieces.length - 1) {
        parent = relative;
        continue;
      }
      const original = join(root, relative);
      const saved = join(scratch, "path-" + entries.size);
      if (stat) {
        cpSync(original, saved, copyOptions);
        if (!fullCheckout) {
          cpSync(saved, join(checkout, relative), copyOptions);
        }
      }
      entries.add(relative);
      snapshots.push({ relative, original, saved });
      break;
    }
  }
  return snapshots;
}

function createRecoveryDirectory(root: string, gitDir: string, snapshots: Snapshot[]) {
  const volume = (path: string) => statSync(path, { bigint: true }).dev;
  const sourceVolumes = new Set(snapshots.map(snapshot => volume(dirname(snapshot.original))));
  const onSourceVolume = (path: string) => !sourceVolumes.size ||
    (sourceVolumes.size === 1 && sourceVolumes.has(volume(path)));
  if (onSourceVolume(gitDir)) {
    return mkdtempSync(join(gitDir, "taskboard-fast-forward-"));
  }
  const board = join(root, ".tasks");
  if (!onSourceVolume(root) || (inspectPath(board) && !inspectPath(board)?.isDirectory())) {
    throw new TaskboardError("GIT_WORKTREE_RECOVERY_VOLUME",
      "Fast-forward could not keep recoverable files on the same volume as the worktree paths.", { root });
  }
  excludeBoard({ root, bare: false });
  mkdirSync(board, { recursive: true, mode: 0o700 });
  if (!onSourceVolume(board)) {
    throw new TaskboardError("GIT_WORKTREE_RECOVERY_VOLUME",
      "The board recovery directory is on a different volume from the worktree paths.", { root, board });
  }
  return mkdtempSync(join(board, "taskboard-fast-forward-"));
}

function publishPaths(checkout: string, recoveryDirectory: string, snapshots: Snapshot[], published: Publication[]) {
  for (const snapshot of snapshots) {
    const staged = join(checkout, snapshot.relative);
    const after = inspectPath(staged);
    const destination = after && !after.isSymbolicLink()
      ? join(dirname(snapshot.original), basename(realpathSync.native(staged))) : snapshot.original;
    if (destination === snapshot.original && samePath(snapshot.saved, staged)) continue;
    const backup = join(recoveryDirectory, String(published.length));
    mkdirSync(backup);
    writeFileSync(join(backup, "path.json"), JSON.stringify(snapshot.relative) + "\n");
    const previous = join(backup, "before");
    const item: Publication = { snapshot, staged, destination, backup, previous };
    published.push(item);
    // Move aside on the same volume before comparing. Even a late save that
    // beat the rename is now in the backup, rather than overwritten.
    if (inspectPath(snapshot.original)) {
      renameSync(snapshot.original, previous);
    }
    if (!samePath(snapshot.saved, previous)) {
      throw new TaskboardError("GIT_DIRTY_WORKTREE", "A worktree path changed while preparing fast-forward. Your edits were preserved.",
        { path: snapshot.relative });
    }
    if (after) {
      item.writing = true;
      copyNewPath(staged, destination);
      item.installed = true;
    }
  }
}

function undoPublishedPaths(published: Publication[]) {
  const unresolved: string[] = [];
  for (const item of [...published].reverse()) {
    try {
      if (item.installed) {
        const displaced = join(item.backup, "after");
        renameSync(item.destination, displaced);
        if (!samePath(item.staged, displaced)) {
          copyNewPath(displaced, item.destination);
          unresolved.push(item.backup);
          continue;
        }
      } else if (item.writing && inspectPath(item.destination)) {
        // A failed exclusive copy may have collided with an editor save.
        unresolved.push(item.backup);
        continue;
      }
      if (inspectPath(item.previous)) {
        if (lstatSync(item.previous).isFile()) {
          // Restore the same inode without overwriting a late save at the live path.
          linkSync(item.previous, item.snapshot.original);
        } else {
          copyNewPath(item.previous, item.snapshot.original);
        }
      }
    } catch {
      unresolved.push(item.backup);
    }
  }
  return unresolved;
}

export async function advanceWorktree(root: string, ref: string, head: string, target: string,
  env: NodeJS.ProcessEnv, check: () => string[]) {
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]).trimEnd();
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
    return await withGuardedBranchRefs(root, ref, head, ["option no-deref", "update " + ref + " " + target + " " + head],
      "taskboard: fast-forward " + ref, async commit => {
        const changed = check();
        const scratch = mkdtempSync(join(tmpdir(), "taskboard-index-"));
        try {
          const checkout = join(scratch, "checkout");
          const temporaryIndex = join(scratch, "index");
          mkdirSync(checkout);
          copyFileSync(index, temporaryIndex);
          const filters = invokeGit(root, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"]);
          if (filters.code !== 0 && filters.code !== 1) {
            throw new TaskboardError("GIT_FAILED", "Git could not read the configured checkout filters.", { output: filters.stderr.trim() });
          }
          const fullCheckout = filters.code === 0;
          if (fullCheckout) {
            // A configured filter can read any relative dependency, including ignored files.
            copyFilterContext(root, checkout);
          }
          const snapshots = stageWorktreePaths(root, scratch, checkout, changed, fullCheckout);
          // Git and its checkout filters write only in the staging checkout.
          const stagedEnv = { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: checkout, GIT_INDEX_FILE: temporaryIndex };
          const stagingOptions = ["-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];
          git(checkout, [...stagingOptions, "update-index", "--ignore-missing", "--refresh"], stagedEnv);
          git(checkout, [...stagingOptions, "read-tree", "-m", "-u", head, target], stagedEnv);
          check();
          // Moved files may still have open writers after this operation returns.
          // Keep their directory entries on the source volume until the user removes them.
          const recoveryDirectory = createRecoveryDirectory(root, gitDir, snapshots);
          const published: Publication[] = [];
          try {
            publishPaths(checkout, recoveryDirectory, snapshots, published);
            for (const item of published) {
              if (!samePath(item.snapshot.saved, item.previous) || !samePath(item.staged, item.destination)) {
                throw new TaskboardError("GIT_DIRTY_WORKTREE", "A worktree path changed during fast-forward.",
                  { path: item.snapshot.relative });
              }
            }
            writeFileSync(descriptor!, readFileSync(temporaryIndex));
            closeSync(descriptor!);
            descriptor = undefined;
            await commit();
          } catch (error) {
            const backups = undoPublishedPaths(published);
            if (backups.length) {
              throw new TaskboardError("GIT_FAST_FORWARD_RECOVERY_FAILED",
                "Fast-forward stopped and kept conflicting worktree versions for manual recovery.", { ref, head, target, recoveryDirectory, backups });
            }
            if (error instanceof TaskboardError) {
              throw new TaskboardError(error.code, error.message, { ...error.details as Record<string, unknown>, recoveryDirectory });
            }
            throw new TaskboardError("GIT_WORKTREE_PUBLISH_FAILED", "Fast-forward could not publish the worktree paths.",
              { reason: (error as NodeJS.ErrnoException).code, recoveryDirectory });
          }
          try {
            renameSync(lock, index);
            removeLock = false;
          } catch {
            // Keep the prepared index if the ref transaction already committed.
            removeLock = false;
            throw new TaskboardError("GIT_INDEX_PUBLISH_FAILED",
              "The branch advanced, but Git could not publish the prepared index. The index lock contains the prepared index.",
              { ref, head: target, lock, recoveryDirectory });
          }
          return recoveryDirectory;
        } finally {
          rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
      });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (removeLock) rmSync(lock, { force: true });
  }
}
