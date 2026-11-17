import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TaskboardError } from "./model.ts";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

export interface Repository {
  root: string;
  bare: boolean;
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH",
  ]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  return env;
}

export const skipAutoMaintenance = ["-c", "maintenance.auto=false"];

export function scheduleGitMaintenance(root: string): void {
  try {
    const setting = invokeGit(root, ["config", "--type=bool", "--default=true", "--get", "maintenance.auto"]);
    if (setting.code !== 0 || setting.stdout.trim() !== "true") return;
    const child = spawn("git", ["maintenance", "run", "--auto", "--quiet"], {
      cwd: root, env: gitEnvironment(), detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => { /* Maintenance can run after the next Git operation. */ });
    child.unref();
  } catch {
    // A maintenance failure cannot undo a completed board operation.
  }
}

export function invokeGit(cwd: string, args: string[], overrides?: NodeJS.ProcessEnv): GitResult {
  const result = spawnSync("git", args, {
    cwd, env: { ...gitEnvironment(), ...overrides }, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(cwd)) {
      throw new TaskboardError("GIT_UNAVAILABLE", "Install Git 2.38 or newer, then reopen the project.");
    }
    throw new TaskboardError("GIT_FAILED", result.error.message);
  }
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function git(cwd: string, args: string[], overrides?: NodeJS.ProcessEnv): string {
  const result = invokeGit(cwd, args, overrides);
  if (result.code !== 0) {
    const command = args[0] === "-c" ? args[2] : args[0];
    throw new TaskboardError("GIT_FAILED", "Git failed while running " + command + ".", {
      output: [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"),
      exitCode: result.code,
    });
  }
  return result.stdout;
}

export function isAncestor(path: string, older: string, newer: string): boolean {
  const result = invokeGit(path, ["merge-base", "--is-ancestor", older, newer]);
  if (result.code === 0 || result.code === 1) return result.code === 0;
  throw new TaskboardError("GIT_FAILED", "Git could not compare commits.", { output: result.stderr.trim() });
}

export function mergeTree(path: string, targetHead: string, submitted: string, env?: NodeJS.ProcessEnv): string {
  const result = invokeGit(path, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", targetHead, submitted], env);
  const [tree, ...paths] = result.stdout.split("\0").filter(Boolean);
  if (result.code === 1) {
    throw new TaskboardError("MERGE_CONFLICT", "Resolve the conflicts in the task worktree and submit the result again.", {
      paths: [...new Set(paths)], targetHead,
    });
  }
  if (result.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree ?? "")) {
    throw new TaskboardError("GIT_FAILED", "Git could not calculate the merge result.", { output: result.stderr.trim() });
  }
  return tree;
}

export function inspectMergeTree(path: string, targetHead: string, submitted: string) {
  const env = { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
  // Passive review must not run commands configured as custom merge drivers.
  const drivers = invokeGit(path, ["config", "--get-regexp", "^merge\\..*\\.driver$"], env);
  if (drivers.code !== 1) return { status: "unchecked" as const };
  const objects = git(path, ["rev-parse", "--path-format=absolute", "--git-path", "objects"], env).trimEnd();
  const parent = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(parent, "ai-taskboard-merge-"));
  try {
    mergeTree(path, targetHead, submitted, { ...env, GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects) });
    return { status: "clean" as const };
  } catch (error) {
    if (!(error instanceof TaskboardError)) throw error;
    if (error.code !== "MERGE_CONFLICT") return { status: "unchecked" as const };
    const { paths } = error.details as { paths: string[] };
    return { status: "conflict" as const, paths };
  } finally {
    if (dirname(realpathSync(scratch)) !== parent) throw new Error("Unexpected temporary Git object directory.");
    // Git writes read-only loose objects. Electron on Windows cannot remove them until they are writable.
    if (process.platform === "win32") {
      for (const entry of readdirSync(scratch, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o600);
      }
    }
    rmSync(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

const listWorktrees = ["worktree", "list", "--porcelain", "-z"];

function parseWorktrees(output: string): Worktree[] {
  const records: Worktree[] = [];
  let record: Worktree | undefined;
  for (const field of output.split("\0")) {
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      record = { path: value };
      records.push(record);
    } else if (record && (key === "HEAD" || key === "branch")) {
      record[key === "HEAD" ? "head" : "branch"] = value;
    } else if (record && (key === "bare" || key === "locked" || key === "prunable")) {
      record[key] = true;
    }
  }
  return records;
}

export function worktrees(cwd: string): Worktree[] {
  return parseWorktrees(git(cwd, listWorktrees));
}

export function discoverRepository(cwd: string): Repository | null {
  let result: GitResult;
  try {
    result = invokeGit(cwd, listWorktrees);
  } catch (error) {
    if (error instanceof TaskboardError && error.code === "GIT_UNAVAILABLE") {
      for (let cursor = cwd; ; cursor = dirname(cursor)) {
        if (existsSync(join(cursor, ".git")) || (existsSync(join(cursor, "HEAD")) && existsSync(join(cursor, "objects")))) {
          throw error;
        }
        if (dirname(cursor) === cursor) return null;
      }
    }
    throw error;
  }
  if (result.code !== 0 && result.stderr.includes("not a git repository")) return null;
  if (result.code !== 0) {
    throw new TaskboardError("GIT_FAILED", "Could not discover the Git repository.", { output: result.stderr.trim() });
  }
  const main = parseWorktrees(result.stdout)[0];
  if (!main) throw new TaskboardError("GIT_FAILED", "Git did not identify the main worktree.");
  return { root: realpathSync(main.path), bare: main.bare === true };
}

export const isolatedWorktreesDirectory = ".worktrees";

export function gitSafeDirectoryEnvironment(env: NodeJS.ProcessEnv, ...paths: string[]): NodeJS.ProcessEnv {
  const entries = [...new Set(paths)];
  const count = Number(env.GIT_CONFIG_COUNT || "0");
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(count + entries.length)) {
    throw new TaskboardError("INVALID_GIT_CONFIG", "GIT_CONFIG_COUNT must be a nonnegative integer.");
  }
  const result: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(count + entries.length) };
  for (const [index, path] of entries.entries()) {
    result["GIT_CONFIG_KEY_" + (count + index)] = "safe.directory";
    result["GIT_CONFIG_VALUE_" + (count + index)] = path.replaceAll("\\", "/");
  }
  return result;
}

export function excludeBoard(repo: Repository, directory: ".tasks" | typeof isolatedWorktreesDirectory = ".tasks"): void {
  if (repo.bare) return;
  if (git(repo.root, ["ls-files", "-z", "--", directory]).length) {
    throw new TaskboardError("TRACKED_BOARD", "Git already tracks files under " + directory + ".");
  }
  if (invokeGit(repo.root, ["check-ignore", "-q", "--", directory + "/"]).code === 0) return;
  const path = git(repo.root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trimEnd();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, "\n/" + directory + "/\n");
  if (invokeGit(repo.root, ["check-ignore", "-q", "--", directory + "/"]).code !== 0) {
    throw new TaskboardError("BOARD_NOT_IGNORED", "Git ignore rules prevent excluding " + directory + ".");
  }
}

export function localBranch(repo: Repository, requested?: string): string {
  const branch = requested
    ? (requested.startsWith("refs/heads/") ? requested : "refs/heads/" + requested)
    : repo.bare ? "" : invokeGit(repo.root, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim();
  if (!branch.startsWith("refs/heads/") ||
      invokeGit(repo.root, ["check-ref-format", branch]).code !== 0) {
    throw new TaskboardError("TARGET_REQUIRED", "Select an existing local target branch.");
  }
  return branch;
}

export function resolveCommit(cwd: string, revision: string): string | undefined {
  const result = invokeGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", revision + "^{commit}"]);
  if (result.code === 0) return result.stdout.trim();
  if (result.code === 1) return undefined;
  throw new TaskboardError("GIT_FAILED", "Could not resolve the Git commit.", { output: result.stderr.trim() });
}

export function createInitialCommit(repo: Repository, target: string): string {
  const head = invokeGit(repo.root, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim();
  if (repo.bare || target !== head || git(repo.root, ["for-each-ref", "--count=1", "--format=%(refname)"])) {
    throw new TaskboardError("TARGET_HAS_NO_COMMIT", "Select a local target branch with a commit.");
  }
  // Build the empty tree directly so staged files and the main worktree are untouched.
  const tree = git(repo.root, ["mktree"]).trim();
  const commit = git(repo.root, [
    "-c", "user.name=AI Taskboard", "-c", "user.email=ai-taskboard@localhost",
    "commit-tree", tree, "-m", "chore: initialize repository",
  ]).trim();
  git(repo.root, ["update-ref", "--no-deref", target, commit, ""]);
  return commit;
}

export function requireRepository(repository: Repository | null): Repository {
  if (!repository) throw new TaskboardError("GIT_REQUIRED", "Starting a code task requires a Git repository.");
  return repository;
}
