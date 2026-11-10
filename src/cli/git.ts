import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
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

export function invokeGit(cwd: string, args: string[], overrides?: NodeJS.ProcessEnv): GitResult {
  const env = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH",
  ]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  const result = spawnSync("git", ["-C", cwd, ...args], {
    env: { ...env, ...overrides }, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TaskboardError("GIT_UNAVAILABLE", "Install Git 2.38 or newer, then reopen the project.");
    }
    throw new TaskboardError("GIT_FAILED", result.error.message);
  }
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function git(cwd: string, args: string[], overrides?: NodeJS.ProcessEnv): string {
  const result = invokeGit(cwd, args, overrides);
  if (result.code !== 0) {
    throw new TaskboardError("GIT_FAILED", "Git failed while running " + args[0] + ".", {
      output: [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n"),
      exitCode: result.code,
    });
  }
  return result.stdout;
}

export function worktrees(cwd: string): Worktree[] {
  const records: Worktree[] = [];
  let record: Worktree | undefined;
  for (const field of git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
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

export function discoverRepository(cwd: string): Repository | null {
  let result: GitResult;
  try {
    result = invokeGit(cwd, ["rev-parse", "--git-common-dir"]);
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
  const main = worktrees(cwd)[0];
  if (!main) throw new TaskboardError("GIT_FAILED", "Git did not identify the main worktree.");
  return { root: realpathSync(main.path), bare: main.bare === true };
}

export function excludeBoard(repo: Repository): void {
  if (repo.bare) return;
  if (git(repo.root, ["ls-files", "-z", "--", ".tasks"]).length) {
    throw new TaskboardError("TRACKED_BOARD", "Git already tracks files under .tasks.");
  }
  if (invokeGit(repo.root, ["check-ignore", "-q", "--", ".tasks/"]).code === 0) return;
  const path = git(repo.root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trimEnd();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, "\n/.tasks/\n");
  if (invokeGit(repo.root, ["check-ignore", "-q", "--", ".tasks/"]).code !== 0) {
    throw new TaskboardError("BOARD_NOT_IGNORED", "Git ignore rules prevent excluding .tasks.");
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

export function requireRepository(repository: Repository | null): Repository {
  if (!repository) throw new TaskboardError("GIT_REQUIRED", "Starting a code task requires a Git repository.");
  return repository;
}
