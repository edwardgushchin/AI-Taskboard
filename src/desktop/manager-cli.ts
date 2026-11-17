import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { invokeGit } from "../cli/git.ts";
import { githubMilestoneArgs, githubRepository, gitContentFilterPattern, readOnlyGitOptions } from "../cli/repository.ts";
import type { BoardMcpTool } from "./board-mcp.ts";

type ProbeResult = { exitCode: number; stdout: string };
type Run = (cwd: string, command: string[], env?: Record<string, string>) => Promise<ProbeResult>;

export type ManagerCli = { gitOptions?: string[]; github?: string };
const cached = new Map<string, { key: string; until: number; result: ManagerCli }>();

export async function probeManagerCli(project: string, profileKey: string, tools: BoardMcpTool[], run: Run): Promise<ManagerCli> {
  const checkGit = tools.some(({ name }) => name === "project_git");
  const checkGitHub = tools.some(({ name }) => name === "milestones_list");
  if (!checkGit && !checkGitHub) return {};
  try {
    const location = invokeGit(project, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
    if (location.code) return {};
    const [worktree, gitDir] = location.stdout.trimEnd().split(/\r?\n/);
    if (!worktree || !gitDir) return {};
    const root = realpathSync(worktree);
    const config = invokeGit(root, ["config", "--includes", "--null", "--list"]);
    if (config.code) return {};
    const key = createHash("sha256").update(JSON.stringify([profileKey, gitDir, config.stdout, checkGit, checkGitHub])).digest("hex");
    const previous = cached.get(root);
    if (previous?.key === key && previous.until > Date.now()) return previous.result;

    const checked = async (command: string[], env?: Record<string, string>) => {
      try { return await run(root, command, env); }
      catch { return undefined; }
    };
    const filters = ["config", "--null", "--name-only", "--get-regexp", gitContentFilterPattern];
    const filterKeys = (value: string) => [...new Set(value.split("\0").filter(Boolean))].sort();
    const probeGit = async () => {
      if (!checkGit) return;
      const local = invokeGit(root, filters);
      const env = { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" };
      const actual = await checked(["git", ...filters], env);
      if (![0, 1].includes(local.code) || !actual || ![0, 1].includes(actual.exitCode)) return;
      const keys = filterKeys(local.stdout);
      if (JSON.stringify(keys) !== JSON.stringify(filterKeys(actual.stdout)) ||
          !keys.every(key => /^[a-zA-Z0-9._-]+$/.test(key))) return;
      const options = [...readOnlyGitOptions,
        ...keys.flatMap(key => ["-c", key + (key.endsWith(".required") ? "=false" : "=")])];
      const prefix = ["git", "--no-pager", "--literal-pathspecs", ...options];
      const results = await Promise.all([
        ["status", "--porcelain=v1", "--branch", "--ignore-submodules=dirty"],
        ["log", "-1", "--oneline", "--no-notes", "--no-show-signature"],
        ["diff", "--stat=80,60,1", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--"],
        ["diff", "--cached", "--stat=80,60,1", "--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--"],
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        ["rev-parse", "--verify", "HEAD^{commit}"],
      ].map(args => checked([...prefix, ...args], env)));
      if (results.every(result => result?.exitCode === 0) &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(results.at(-1)!.stdout.trim())) return options;
    };
    const probeGitHub = async () => {
      if (!checkGitHub) return;
      const github = githubRepository({ repository: { root, bare: false } });
      if (!github) return;
      const env = { GH_PROMPT_DISABLED: "1" };
      const identity = await checked(["gh", "api", "--hostname", "github.com", "user", "--jq", ".type"], env);
      if (identity?.exitCode !== 0 || identity.stdout.trim() !== "User") return;
      const response = await checked(["gh", ...githubMilestoneArgs(github)], env);
      if (response?.exitCode === 0) {
        const pages: unknown = JSON.parse(response.stdout);
        if (Array.isArray(pages) && pages.every(Array.isArray)) return github;
      }
    };
    const [git, github] = await Promise.allSettled([probeGit(), probeGitHub()]);
    const result = { gitOptions: git.status === "fulfilled" ? git.value : undefined,
      github: github.status === "fulfilled" ? github.value : undefined };
    cached.set(root, { key, result, until: Date.now() + 5 * 60_000 });
    return result;
  } catch {
    return {};
  }
}

export function managerCliContext(tools: BoardMcpTool[], { gitOptions, github }: ManagerCli) {
  const instructions: string[] = [];
  if (tools.some(({ name }) => name === "project_git")) {
    instructions.push(gitOptions
      ? "For read-only Git commands from the repository root, set GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL to an empty string. " +
        "Start commands with git --no-pager --literal-pathspecs " + gitOptions.join(" ") + ". " +
        "Use status, log -20 --no-notes --no-show-signature, diff or diff --cached. Add --ignore-submodules=dirty to status and diffs, " +
        "and --no-ext-diff --no-textconv to diffs. Bound output, use -- before literal paths, and use full commit IDs for review comparisons. " +
        "Read branch with symbolic-ref --quiet --short HEAD and full commit with rev-parse --verify 'HEAD^{commit}' for project_git_push."
      : "Use project_git for status, log, diff and branch/full HEAD. For review comparisons use commit_diff with the full commit IDs and relevant literal paths.");
  }
  if (github && tools.some(({ name }) => name === "milestones_list")) {
    const command = ["gh", ...githubMilestoneArgs(github)].map(arg => arg.includes("?") ? '"' + arg + '"' : arg).join(" ");
    instructions.push("List milestones with " + command + " and GH_PROMPT_DISABLED=1. Use " + github +
      " and the selected milestone number with task_set_milestone.");
  }
  return {
    tools: tools.filter(({ name }) => !(gitOptions && name === "project_git") && !(github && name === "milestones_list")),
    instructions: instructions.join(" "),
  };
}
