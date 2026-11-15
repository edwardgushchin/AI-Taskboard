import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, gitEnvironment, invokeGit, requireRepository, resolveCommit } from "./git.ts";
import { githubRepositoryPattern, member, number, object, TaskboardError, text } from "./model.ts";
import type { BoardLocation } from "./storage.ts";
import { onBoard } from "./storage.ts";
import { requireNoGitOperation } from "./worktree.ts";

const execute = promisify(execFile);
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function githubRepository(location: BoardLocation): string | undefined {
  if (!location.repository || location.repository.bare) return;
  const remote = invokeGit(location.repository.root, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) return;
  const repository = /^(?:https?:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/git@(?:github\.com(?::22)?|ssh\.github\.com:443)\/|git@github\.com:)([^/]+\/[^/]+)\/?$/i
    .exec(remote.stdout.trim())?.[1].replace(/\.git$/i, "").toLowerCase();
  if (repository && githubRepositoryPattern.test(repository)) return repository;
}

export async function githubMilestones(location: BoardLocation, selected?: { repository: string; number: number }) {
  const repository = githubRepository(location);
  if (!repository || (selected && selected.repository !== repository)) {
    throw new TaskboardError("GITHUB_REMOTE_REQUIRED", "Choose a milestone from the GitHub repository configured as origin.");
  }
  const endpoint = "repos/" + repository + "/milestones";
  const args = selected ? [endpoint + "/" + selected.number] :
    ["--paginate", "--slurp", endpoint + "?state=all&per_page=100"];
  let response: unknown;
  try {
    const { stdout } = await execute("gh", ["api", "--hostname", "github.com", ...args], {
      cwd: location.root, env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    });
    response = JSON.parse(stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TaskboardError("GITHUB_UNAVAILABLE", "Install GitHub CLI (gh) and sign in.");
    }
    throw new TaskboardError("GITHUB_MILESTONES_FAILED", "Could not read GitHub milestones. Check access, connection and whether the milestone still exists.");
  }
  const entries: unknown[] = selected ? [response] : Array.isArray(response) ? response.flat() : [];
  if (!selected && !Array.isArray(response)) throw new TaskboardError("GITHUB_MILESTONES_FAILED", "Invalid milestone response.");
  return { repository, milestones: entries.map(entry => {
    const fields = object(entry);
    const state = member(fields.state, ["open", "closed"] as const, "state");
    return { number: number(fields.number, "milestone number", 1), title: text(fields.title, "milestone title", true), state };
  }) };
}

function repositoryPath(location: BoardLocation): string {
  const repository = requireRepository(location.repository);
  if (repository.bare) throw new TaskboardError("GIT_WORKTREE_REQUIRED", "Open a repository with a main worktree.");
  return repository.root;
}

function currentRevision(root: string) {
  return {
    branch: invokeGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || undefined,
    head: resolveCommit(root, "HEAD"),
  };
}

function requireCurrentRevision(root: string, input: Record<string, unknown>) {
  const current = currentRevision(root);
  if (input.head !== current.head || input.branch !== current.branch) {
    throw new TaskboardError("STALE_REPOSITORY", "The current branch changed. Reopen the Git menu and retry.");
  }
  return current;
}

export function repositoryRefs(location: BoardLocation) {
  const root = repositoryPath(location);
  // Annotated tags show the commit's metadata, as lightweight tags do.
  const field = (name: string) => `%(if)%(*objectname)%(then)%(*${name})%(else)%(${name})%(end)`;
  const format = ["%(refname)", ...["objectname", "authorname", "committerdate:iso-strict", "subject", "objecttype"].map(field)].join("%00") + "%00";
  const fields = git(root, ["for-each-ref", "--sort=-creatordate", "--format=" + format, "refs/heads/", "refs/tags/"]).split("\0");
  const refs = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [raw, sha, author, date, subject, type] = fields.slice(index, index + 6);
    if (type !== "commit") continue;
    const ref = raw!.replace(/^\r?\n/, "");
    const tag = ref.startsWith("refs/tags/");
    refs.push({ ref, name: ref.slice(tag ? 10 : 11), tag, sha, author, date, subject });
  }
  return { ...currentRevision(root), refs };
}

function commitDiff(root: string, input: Record<string, unknown>) {
  const { from, to, paths } = input;
  if (typeof from !== "string" || !commitId.test(from) || typeof to !== "string" || !commitId.test(to)) {
    throw new TaskboardError("INVALID_INPUT", "Use the two full Git commit IDs.");
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > 64 || new Set(paths).size !== paths.length ||
      !paths.every(path => typeof path === "string" && !/[\0\\]/.test(path) &&
        path.split("/").every(part => part !== "" && part !== "." && part !== ".."))) {
    throw new TaskboardError("INVALID_INPUT", "Use 1 to 64 distinct literal paths relative to the repository.");
  }
  const offset = input.offset === undefined ? 0 : number(input.offset, "offset", 0);
  const output = git(root, ["--no-optional-locks", "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
    "--no-color", "--no-renames", "--ignore-submodules=none", "--submodule=short", "--unified=0",
    from + "^{commit}", to + "^{commit}", "--", ...paths], { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });
  if (offset > output.length || /[\uDC00-\uDFFF]/.test(output.charAt(offset))) {
    throw new TaskboardError("INVALID_INPUT", "Use the nextOffset returned for these commits and paths.");
  }
  let end = offset + 16_000;
  if (/[\uDC00-\uDFFF]/.test(output.charAt(end))) end--;
  const truncated = end < output.length;
  return { output: output.slice(offset, end), truncated, ...(truncated ? { nextOffset: end } : {}) };
}

export function inspectRepository(location: BoardLocation, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  if (input.view === "commit_diff") return commitDiff(root, input);
  const view = member(input.view, ["status", "log", "diff", "staged_diff"], "view");
  const commands = {
    status: ["status", "--porcelain=v1", "--branch", "--untracked-files=normal", "--ignore-submodules=dirty"],
    log: ["log", "-20", "--oneline", "--decorate=short", "--no-color", "--no-notes", "--no-show-signature"],
    diff: ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "--submodule=short"],
    staged_diff: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "--submodule=short"],
  };
  const env = { GIT_NO_LAZY_FETCH: "1" };
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
  const disabledFilters = new Set<string>();
  if (view === "status" || view === "diff") {
    // Worktree inspection may otherwise run repository-defined content filters.
    const filters = invokeGit(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], env);
    if (filters.code !== 0 && filters.code !== 1) throw new TaskboardError("GIT_FAILED", "Git could not read filter configuration.");
    for (const key of new Set(filters.stdout.split("\0").filter(Boolean))) {
      if (key.includes("=")) throw new TaskboardError("GIT_FAILED", "Git cannot disable this content filter for inspection.");
      args.push("-c", key + (key.endsWith(".required") ? "=false" : "="));
      disabledFilters.add(key.slice("filter.".length, key.lastIndexOf(".")));
    }
  }
  const output = git(root, [...args, ...commands[view]], env).trimEnd();
  return {
    output: output.slice(0, 24_000), truncated: output.length > 24_000,
    ...(view === "status" ? currentRevision(root) : {}),
    ...(disabledFilters.size ? { note: "Git content filters were disabled. Filtered files may appear modified.", disabledFilters: [...disabledFilters] } : {}),
  };
}

export function changeRepository(location: BoardLocation, action: string, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  requireNoGitOperation(root);
  requireCurrentRevision(root, input);
  const ref = input.ref === undefined ? "HEAD" : text(input.ref, "ref", true);
  if (ref !== "HEAD" && (!/^refs\/(heads|tags)\//.test(ref) || invokeGit(root, ["check-ref-format", ref]).code !== 0)) {
    throw new TaskboardError("INVALID_INPUT", "Choose a local branch or tag.");
  }
  const commit = resolveCommit(root, ref);
  if (!commit && (action !== "create" || ref !== "HEAD")) {
    throw new TaskboardError("GIT_COMMIT_REQUIRED", "The selected reference has no commit.");
  }
  if (action === "create") {
    const name = text(input.name, "name", true);
    if (name.startsWith("-") || name === "HEAD" || invokeGit(root, ["check-ref-format", "refs/heads/" + name]).code !== 0) {
      throw new TaskboardError("INVALID_INPUT", "Enter a valid new branch name.");
    }
    git(root, ["switch", "--no-track", "--create", name, "--", ...(commit ? [commit] : [])]);
  } else if (action === "detach" || ref.startsWith("refs/tags/")) {
    git(root, ["switch", "--detach", "--", commit!]);
  } else {
    if (!ref.startsWith("refs/heads/")) throw new TaskboardError("INVALID_INPUT", "Choose a branch.");
    git(root, ["switch", "--no-guess", "--", ref.slice(11)]);
  }
  return repositoryRefs(location);
}

export async function pushRepositoryBranch(location: BoardLocation, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  const branch = text(input.branch, "branch", true);
  const head = text(input.head, "head", true);
  const source = "refs/heads/" + branch;
  if (Object.keys(input).some(key => key !== "branch" && key !== "head") || branch.startsWith("-") ||
      !commitId.test(head) || invokeGit(root, ["check-ref-format", source]).code !== 0) {
    throw new TaskboardError("INVALID_INPUT", "Pass a local branch name and its full Git commit ID.");
  }
  const { remote, remoteRef } = onBoard(location, () => {
    const tip = resolveCommit(root, source);
    if (!tip) throw new TaskboardError("GIT_BRANCH_REQUIRED", "The local branch does not exist.");
    if (tip !== head) throw new TaskboardError("STALE_REPOSITORY", "The branch tip changed. Read its current commit before pushing.");
    const setting = (name: string) => {
      const result = invokeGit(root, ["config", "--get-all", "branch." + branch + "." + name]);
      if (result.code === 1) return undefined;
      const value = result.stdout.trimEnd();
      if (result.code !== 0 || !value || value.includes("\n")) {
        throw new TaskboardError("GIT_REMOTE_REQUIRED", "Configure a single upstream remote and branch before pushing.");
      }
      return value;
    };
    const remote = setting("remote") ?? "origin";
    const remoteRef = setting("merge") ?? source;
    if (!git(root, ["remote"]).split(/\r?\n/).includes(remote) || !remoteRef.startsWith("refs/heads/") ||
        invokeGit(root, ["check-ref-format", remoteRef]).code !== 0) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "Configure a remote branch upstream or an origin remote before pushing.");
    }
    return { remote, remoteRef };
  });
  try {
    // A pinned refspec keeps a concurrent local commit out of this push.
    await execute("git", ["push", "--porcelain", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--",
      remote, head + ":" + remoteRef], {
      cwd: root, env: { ...gitEnvironment(), GCM_INTERACTIVE: "never" }, windowsHide: true,
      timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const { stdout = "", stderr = "", killed } = error as { stdout?: string; stderr?: string; killed?: boolean };
    const output = [stdout, stderr].filter(Boolean).join("\n").trim()
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1").slice(0, 4000);
    throw new TaskboardError("GIT_PUSH_FAILED",
      killed ? "Git push timed out. Check the remote branch before retrying." : "Git could not push the branch.", { remote, remoteRef, output });
  }
  return { branch, head, remote, remoteRef };
}

export async function publishRepository(location: BoardLocation, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  const name = text(input.name, "name", true);
  const visibility = member(input.visibility, ["private", "public"], "visibility");
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9-]*\/)?[A-Za-z0-9_.-]+$/.test(name) || name.startsWith("-") || name === "." || name === "..") {
    throw new TaskboardError("INVALID_INPUT", "Enter a GitHub repository name, optionally preceded by owner/.");
  }
  const prepare = () => onBoard(location, () => {
    requireNoGitOperation(root);
    const current = requireCurrentRevision(root, input);
    if (!current.branch || !current.head) throw new TaskboardError("GIT_COMMIT_REQUIRED", "Select a branch with at least one commit before publishing.");
    if (git(root, ["remote"]).split(/\r?\n/).includes("origin")) {
      throw new TaskboardError("REMOTE_EXISTS", "The origin remote already exists. Manage this remote with your Git tools.");
    }
    return current;
  });
  prepare();
  // gh also launches Git; inherited routing variables must not select another repository.
  const env = { ...gitEnvironment(), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
  const options = { cwd: root, env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 };
  try {
    await execute("gh", ["auth", "status", "--hostname", "github.com"], options);
  } catch (error) {
    throw new TaskboardError("GITHUB_UNAVAILABLE", (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Install GitHub CLI (gh), then sign in with gh auth login."
      : "Sign in to GitHub CLI with gh auth login, then retry.");
  }
  const current = prepare();
  try {
    await execute("gh", ["repo", "create", name, "--" + visibility, "--source", root, "--remote", "origin"], options);
  } catch (error) {
    throw new TaskboardError("GITHUB_PUBLISH_FAILED", "GitHub publication failed. Check your connection and permissions. If a repository or origin was created, it was preserved; inspect it with your Git tools before retrying.", {
      output: String((error as { stderr?: string }).stderr ?? "").trim().slice(0, 4000),
    });
  }
  try {
    // Publish the reviewed commit and branch even if HEAD changes during the network request.
    await execute("git", ["push", "origin", current.head + ":refs/heads/" + current.branch], options);
  } catch (error) {
    throw new TaskboardError("GITHUB_PUSH_FAILED", "The GitHub repository and origin were created, but the push failed. Check Git authentication and push the branch with your Git tools.", {
      output: String((error as { stderr?: string }).stderr ?? "").trim().slice(0, 4000),
    });
  }
  return { remote: git(root, ["remote", "get-url", "origin"]).trim() };
}
