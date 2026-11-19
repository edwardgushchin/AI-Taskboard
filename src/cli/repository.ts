import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, gitEnvironment, invokeGit, requireRepository, resolveCommit } from "./git.ts";
import { githubRepositoryPattern, member, number, object, TaskboardError, text } from "./model.ts";
import type { BoardLocation } from "./storage.ts";
import { onBoard, sha256, withMilestoneLinksLock } from "./storage.ts";
import { requireNoGitOperation } from "./worktree.ts";
import { githubApi, githubRequests } from "./github-cli.ts";
import { redactSecrets } from "./redact.ts";
import { branchRef, configuredRemote, createRepositoryBranch, deleteRepositoryBranch, fastForwardRepository, fetchRepositoryBranches, listRepositoryBranches } from "./repository-branches.ts";

const execute = promisify(execFile);
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function githubRepository(location: Pick<BoardLocation, "repository">): string | undefined {
  if (!location.repository || location.repository.bare) return;
  const remote = invokeGit(location.repository.root, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) return;
  const repository = /^(?:https?:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/git@(?:github\.com(?::22)?|ssh\.github\.com:443)\/|git@github\.com:)([^/]+\/[^/]+)\/?$/i
    .exec(remote.stdout.trim())?.[1].replace(/\.git$/i, "").toLowerCase();
  if (repository && githubRepositoryPattern.test(repository)) return repository;
}

export function githubMilestoneArgs(repository: string) {
  return ["api", "--hostname", "github.com", "--paginate", "--slurp", "repos/" + repository + "/milestones?state=all&per_page=100"];
}

export async function githubMilestones(location: BoardLocation, selected?: { repository: string; number: number }) {
  const repository = githubRepository(location);
  if (!repository || (selected && selected.repository !== repository)) {
    throw new TaskboardError("GITHUB_REMOTE_REQUIRED", "Choose a milestone from the GitHub repository configured as origin.");
  }
  return listGitHubMilestones(githubApi(location.root), repository, selected?.number);
}

async function listGitHubMilestones(request: ReturnType<typeof githubApi>, repository: string, selected?: number) {
  const args = selected === undefined ? githubMilestoneArgs(repository).slice(3) : ["repos/" + repository + "/milestones/" + selected];
  const endpoint = args.pop()!;
  const response = await request(endpoint, args, "GITHUB_MILESTONES_FAILED");
  const entries: unknown[] = selected === undefined ? Array.isArray(response) ? response.flat() : [] : [response];
  if (selected === undefined && !Array.isArray(response)) throw new TaskboardError("GITHUB_MILESTONES_FAILED", "Invalid milestone response.");
  return { repository, milestones: entries.map(entry => {
    const fields = object(entry);
    const state = member(fields.state, ["open", "closed"] as const, "state");
    const due_on = fields.due_on == null ? null : text(fields.due_on, "milestone due_on", true);
    if (due_on !== null && !Number.isFinite(Date.parse(due_on))) throw new TaskboardError("GITHUB_MILESTONES_FAILED", "Invalid milestone due_on.");
    return { number: number(fields.number, "milestone number"), title: text(fields.title, "milestone title", true), state, due_on };
  }) };
}

export async function readGitHub(location: BoardLocation, input: Record<string, unknown>) {
  const view = member(input.view, ["account", "repository", "milestone", "run-failed-log"], "GitHub view");
  const fieldsByView: Record<typeof view, string[]> = { account: [], repository: [], milestone: ["number"], "run-failed-log": ["runId", "before"] };
  if (Object.keys(input).some(key => key !== "view" && !fieldsByView[view].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use view with its supported arguments.");
  }
  if (view === "account") {
    const account = object(await githubApi(location.root)("user"));
    return { login: text(account.login, "GitHub login") };
  }
  const repository = githubRepository(location);
  if (!repository) throw new TaskboardError("GITHUB_REMOTE_REQUIRED", "The board's origin must identify a GitHub repository.");
  if (view === "milestone") {
    const milestoneNumber = number(input.number, "milestone number");
    return readGitHubMilestone(githubApi(location.root), repository, milestoneNumber);
  }
  if (view === "run-failed-log") {
    const runId = number(input.runId, "workflow run ID");
    const before = input.before === undefined ? undefined : number(input.before, "before");
    const output = redactSecrets(await githubRequests(location.root).failedLog(repository, runId));
    const end = Math.min(before ?? output.length, output.length);
    const start = Math.max(0, end - 16_000);
    return { repository, runId, log: output.slice(start, end), ...(start ? { nextBefore: start } : {}) };
  }
  const fields = object(await githubApi(location.root)("repos/" + repository));
  if (typeof fields.private !== "boolean") throw new TaskboardError("GITHUB_READ_FAILED", "GitHub returned invalid repository metadata.");
  return { repository: text(fields.full_name, "GitHub repository"), private: fields.private,
    defaultBranch: text(fields.default_branch, "default branch") };
}

function milestoneRepository(location: BoardLocation, value: unknown) {
  const repository = githubRepository(location);
  if (!repository || text(value, "repository", true).toLowerCase() !== repository) {
    throw new TaskboardError("GITHUB_REMOTE_REQUIRED", "Use the GitHub repository configured as the board's origin.");
  }
  return repository;
}

function milestoneDueOn(value: unknown) {
  const dueDate = text(value, "due date", true);
  const dueOn = dueDate + "T00:00:00Z";
  const timestamp = new Date(dueOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== dueDate) {
    throw new TaskboardError("INVALID_INPUT", "Use an existing calendar date in YYYY-MM-DD format.");
  }
  return dueOn;
}

function milestoneEndpoint(repository: string, milestoneNumber: number) {
  return "repos/" + repository + "/milestones/" + milestoneNumber;
}

async function readGitHubMilestone(request: ReturnType<typeof githubApi>, repository: string, milestoneNumber: number) {
  const fields = object(await request(milestoneEndpoint(repository, milestoneNumber)));
  if (fields.number !== milestoneNumber || (fields.due_on !== null &&
      (typeof fields.due_on !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(fields.due_on)))) {
    throw new TaskboardError("GITHUB_MILESTONE_VERIFY_FAILED", "GitHub returned unexpected milestone data.");
  }
  const description = fields.description;
  if (description != null && typeof description !== "string") {
    throw new TaskboardError("GITHUB_MILESTONE_VERIFY_FAILED", "GitHub returned an invalid milestone description.");
  }
  return { repository, number: milestoneNumber, title: text(fields.title, "milestone title", true),
    state: member(fields.state, ["open", "closed"], "milestone state"),
    ...(description !== undefined ? { description } : {}),
    dueDate: fields.due_on === null ? null : fields.due_on.slice(0, 10),
    url: "https://github.com/" + repository + "/milestone/" + milestoneNumber };
}

export async function updateGitHubMilestone(location: BoardLocation, input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !["repository", "number", "title", "description", "state"].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use only repository, number, title, description and state.");
  }
  const repository = milestoneRepository(location, input.repository);
  const milestoneNumber = number(input.number, "milestone number");
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new TaskboardError("INVALID_INPUT", "Milestone description must be a string.");
  }
  const changes = {
    ...(input.title !== undefined ? { title: text(input.title, "milestone title", true) } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.state !== undefined ? { state: member(input.state, ["open", "closed"], "milestone state") } : {}),
  };
  const entries = Object.entries(changes) as [keyof typeof changes, string][];
  if (!entries.length) throw new TaskboardError("INVALID_INPUT", "Supply a title, description or state to change.");
  const request = githubApi(location.root);
  const read = () => readGitHubMilestone(request, repository, milestoneNumber);
  const matches = (milestone: Awaited<ReturnType<typeof read>>) => entries.every(([key, value]) =>
    (key === "description" ? milestone.description ?? "" : milestone[key]) === value);
  const before = await read();
  if (matches(before)) return { ...before, changed: false };
  milestoneRepository(location, repository);
  await request(milestoneEndpoint(repository, milestoneNumber),
    ["--method", "PATCH", ...entries.flatMap(([key, value]) => ["-f", key + "=" + value])],
    "GITHUB_MILESTONE_UPDATE_FAILED");
  const after = await read();
  if (!matches(after)) {
    throw new TaskboardError("GITHUB_MILESTONE_VERIFY_FAILED", "Reading the milestone after the update did not confirm the requested result.");
  }
  return { ...after, changed: true };
}

export async function deleteGitHubMilestone(location: BoardLocation, input: Record<string, unknown>, signal?: AbortSignal) {
  if (Object.keys(input).some(key => !["repository", "number", "token", "keepLinks"].includes(key)) ||
      (input.keepLinks !== undefined && typeof input.keepLinks !== "boolean") ||
      (input.token !== undefined && (typeof input.token !== "string" || !/^[0-9a-f]{64}$/.test(input.token)))) {
    throw new TaskboardError("INVALID_INPUT", "Use repository, number, optional preview token and keepLinks.");
  }
  const milestoneNumber = number(input.number, "milestone number");
  const inspectOrDelete = async () => {
    const repository = milestoneRepository(location, input.repository);
    const { request, deleteMilestone } = githubRequests(location.root, signal);
    const milestone = await readGitHubMilestone(request, repository, milestoneNumber);
    signal?.throwIfAborted();
    const linkedCards = onBoard(location, store => {
      const links = (source: ReturnType<typeof store.storedCards> | ReturnType<typeof store.archivedCards>, archived: boolean) =>
        source.filter(task => task.milestone?.repository.toLowerCase() === repository && task.milestone.number === milestoneNumber)
          .map(({ id, title, status, updatedAt }) => ({ id, title, status, updatedAt, archived }));
      return [...links(store.storedCards(), false), ...links(store.archivedCards(), true)]
        .sort((a, b) => a.id.localeCompare(b.id));
    }, 0);
    const snapshot = sha256(Buffer.from(JSON.stringify([milestone, linkedCards])));
    const token = sha256(Buffer.from(JSON.stringify([snapshot, input.keepLinks === true])));
    if (input.token === undefined) return { milestone, linkedCards, snapshot, token, deleted: false };
    if (input.token !== token) {
      throw new TaskboardError("GITHUB_MILESTONE_STALE", "The milestone or its card links changed. Inspect them and obtain a new confirmation.");
    }
    if (linkedCards.length && input.keepLinks !== true) {
      throw new TaskboardError("GITHUB_MILESTONE_LINKED", "Resolve the linked cards or explicitly choose to keep their links.");
    }
    milestoneRepository(location, repository);
    await deleteMilestone(milestoneEndpoint(repository, milestoneNumber));
    return { repository, number: milestoneNumber, state: "deleted", deleted: true, linkedCards };
  };
  return input.token === undefined ? inspectOrDelete() : withMilestoneLinksLock(location, inspectOrDelete);
}

export async function createGitHubMilestone(location: BoardLocation, input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !["repository", "title", "dueDate"].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use only repository, title and dueDate.");
  }
  const repository = milestoneRepository(location, input.repository);
  const title = text(input.title, "milestone title", true);
  const dueOn = input.dueDate === undefined ? undefined : milestoneDueOn(input.dueDate);
  const request = githubApi(location.root);
  const find = async () => (await listGitHubMilestones(request, repository)).milestones.find(milestone => milestone.title === title);
  const confirm = async (milestoneNumber: number, created: boolean) => {
    const milestone = await readGitHubMilestone(request, repository, milestoneNumber);
    if (milestone.title !== title || (created && dueOn && milestone.dueDate !== dueOn.slice(0, 10))) {
      throw new TaskboardError("GITHUB_MILESTONE_VERIFY_FAILED", "Reading the milestone did not confirm the requested result.");
    }
    return { ...milestone, created };
  };
  const existing = await find();
  if (existing) return confirm(existing.number, false);

  const flags = ["--method", "POST", "-f", "title=" + title, ...(dueOn ? ["-f", "due_on=" + dueOn] : [])];
  let response: unknown;
  try {
    response = await request("repos/" + repository + "/milestones", flags, "GITHUB_MILESTONE_CREATE_FAILED");
  } catch (error) {
    if (error instanceof TaskboardError && error.code === "GITHUB_MILESTONE_CREATE_FAILED") {
      const appeared = await find().catch(() => undefined);
      if (appeared) return confirm(appeared.number, false);
    }
    throw error;
  }
  return confirm(number(object(response).number, "milestone number"), true);
}

export async function setGitHubMilestoneDueDate(location: BoardLocation, input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !["repository", "number", "dueDate"].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use only repository, number and dueDate.");
  }
  const repository = milestoneRepository(location, input.repository);
  const milestoneNumber = number(input.number, "milestone number");
  const dueOn = milestoneDueOn(input.dueDate);
  const dueDate = dueOn.slice(0, 10);
  const endpoint = "repos/" + repository + "/milestones/" + milestoneNumber;
  const request = githubApi(location.root);
  const before = await readGitHubMilestone(request, repository, milestoneNumber);
  if (before.dueDate === dueDate) return { ...before, changed: false };
  await request(endpoint, ["--method", "PATCH", "-f", "due_on=" + dueOn], "GITHUB_MILESTONE_UPDATE_FAILED");
  const after = await readGitHubMilestone(request, repository, milestoneNumber);
  if (after.dueDate !== dueDate || after.title !== before.title || after.state !== before.state) {
    throw new TaskboardError("GITHUB_MILESTONE_VERIFY_FAILED", "Reading the milestone after the update did not confirm the requested result.");
  }
  return { ...after, changed: true };
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

export function manageRepositoryBranches(location: BoardLocation, action: string, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  const params: Record<string, string[]> = {
    branches: [], fetch: ["remote"], "fast-forward": ["branch", "head", "remote", "remoteBranch"],
    "branch-create": ["branch", "head"], "branch-delete": ["scope", "branch", "head", "remote", "confirmed"],
  };
  if (Object.keys(input).some(key => !params[action]?.includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use the parameters defined for this Git action.");
  }
  if (action === "branches") return { ...currentRevision(root), ...listRepositoryBranches(root) };
  if (action === "fetch") return fetchRepositoryBranches(root, input);
  if (action === "fast-forward") return fastForwardRepository(location, input);
  if (action === "branch-delete") return deleteRepositoryBranch(location, input);
  return onBoard(location, () => createRepositoryBranch(root, input));
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

export const gitContentFilterPattern = "^filter\\..*\\.(clean|process|required)$";
export const readOnlyGitOptions = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

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
  const args = [...readOnlyGitOptions];
  const disabledFilters = new Set<string>();
  if (view === "status" || view === "diff") {
    // Worktree inspection may otherwise run repository-defined content filters.
    const filters = invokeGit(root, ["config", "--null", "--name-only", "--get-regexp", gitContentFilterPattern], env);
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

// Use the same destination rules for the status bar and the actual push.
function repositoryPushTarget(root: string, branch: string) {
  const setting = (name: string) => {
    const result = invokeGit(root, ["config", "--get-all", "branch." + branch + "." + name]);
    if (result.code === 1) return undefined;
    const value = result.stdout.trimEnd();
    if (result.code !== 0 || !value || value.includes("\n")) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "Configure a single upstream remote and branch before pushing.");
    }
    return value;
  };
  const configuredRemote = setting("remote");
  const merge = setting("merge");
  if (Boolean(configuredRemote) !== Boolean(merge)) {
    throw new TaskboardError("GIT_REMOTE_REQUIRED", "Complete the upstream remote and branch configuration before pushing.");
  }
  const remote = configuredRemote ?? "origin";
  const remoteRef = merge ?? "refs/heads/" + branch;
  if (!git(root, ["remote"]).split(/\r?\n/).includes(remote) || !remoteRef.startsWith("refs/heads/") ||
      invokeGit(root, ["check-ref-format", remoteRef]).code !== 0) {
    throw new TaskboardError("GIT_REMOTE_REQUIRED", "Configure a remote branch upstream or an origin remote before pushing.");
  }
  return { remote, remoteRef };
}

export function boardGitInfo(location: BoardLocation) {
  if (!location.repository || location.repository.bare) return {};
  const root = location.root;
  try {
    const value = (args: string[]) => {
      const result = invokeGit(root, args, { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });
      return result.code === 0 ? result.stdout.trim() || undefined : undefined;
    };
    const branch = value(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const head = value(["rev-parse", "--verify", "--quiet", "HEAD"]);
    const remotes = git(root, ["remote"]).split(/\r?\n/).filter(Boolean);
    let pushTarget: { remote: string; remoteRef: string } | undefined;
    let pushError: string | undefined;
    if (branch && head && remotes.length) {
      try { pushTarget = repositoryPushTarget(root, branch); }
      catch { pushError = "destination"; }
    }
    const upstream = branch && value(["config", "--get", "branch." + branch + ".merge"]);
    const counts = branch && head && upstream ? value(["rev-list", "--left-right", "--count", "--end-of-options",
      head + "..." + branch + "@{upstream}"]) : undefined;
    const divergence = /^(\d+)\s+(\d+)$/.exec(counts ?? "");
    return { branch, head, remotes, pushTarget, pushError,
      upstream: upstream || undefined, trackingError: Boolean(upstream && head && !divergence),
      tracking: divergence ? { ahead: Number(divergence[1]), behind: Number(divergence[2]) } : undefined,
      user: value(["config", "--get", "user.name"]), githubRepository: githubRepository(location) };
  } catch {
    return { gitError: true };
  }
}

function branchTracking(root: string, branch: string) {
  return ["remote", "merge"].map(key => {
    const result = invokeGit(root, ["config", "--get-all", "branch." + branch + "." + key]);
    if (result.code === 1) return "";
    if (result.code !== 0) throw new TaskboardError("GIT_FAILED", "Could not read upstream configuration.");
    return result.stdout.trimEnd();
  });
}

async function pushPinnedBranch(location: BoardLocation, branch: string, head: string,
  target: { remote: string; remoteRef: string }, originalTracking = branchTracking(location.root, branch)) {
  const root = location.root;
  const { remote, remoteRef } = target;
  const remoteConfiguration = () => JSON.stringify(["url", "pushurl", "fetch"].map(key => {
    const result = invokeGit(root, ["config", "--get-all", "remote." + remote + "." + key]);
    if (result.code !== 0 && result.code !== 1) throw new Error("Could not read remote configuration.");
    return result.stdout;
  }));
  const configuration = remoteConfiguration();
  try {
    // A pinned refspec keeps a concurrent local commit out of this push.
    await execute("git", ["push", "--porcelain", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no", "--",
      remote, head + ":" + remoteRef], {
      cwd: root, env: { ...gitEnvironment(), GCM_INTERACTIVE: "never" }, windowsHide: true,
      timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const { stdout = "", stderr = "", killed } = error as { stdout?: string; stderr?: string; killed?: boolean };
    const output = redactSecrets([stdout, stderr].filter(Boolean).join("\n").trim()
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1")).slice(0, 4000);
    throw new TaskboardError("GIT_PUSH_FAILED",
      killed ? "Git push timed out. Check the remote branch before retrying." : "Git could not push the branch.", { remote, remoteRef, output });
  }
  try {
    onBoard(location, () => {
      if (configuration !== remoteConfiguration() || resolveCommit(root, "refs/heads/" + branch) !== head) {
        throw new Error("The source branch or remote configuration changed during push. Read the current state before setting upstream.");
      }
      const current = branchTracking(root, branch);
      if (current[0] === remote && current[1] === remoteRef) return;
      if (current.some(Boolean) || originalTracking.some(Boolean)) {
        throw new Error("Upstream configuration changed or conflicts with the pushed destination; it was preserved.");
      }
      // Let Git write both branch settings for the explicitly named source branch.
      // Resolve the actual fetch mapping, including renamed local tracking refs.
      const fetch = git(root, ["config", "--get-all", "remote." + remote + ".fetch"]);
      let trackingRef: string | undefined;
      for (const spec of fetch.trim().split(/\r?\n/)) {
        const [source, destination] = spec.replace(/^\+/, "").split(":");
        if (!destination || source.startsWith("^")) continue;
        if (source === remoteRef) trackingRef = destination;
        else if (source.includes("*") && destination.includes("*")) {
          const [prefix, suffix] = source.split("*");
          if (remoteRef.startsWith(prefix) && remoteRef.endsWith(suffix)) {
            trackingRef = destination.replace("*", remoteRef.slice(prefix.length, suffix ? -suffix.length : undefined));
          }
        }
      }
      if (!trackingRef) throw new Error("The remote has no fetch mapping for the pushed branch.");
      git(root, ["branch", "--set-upstream-to=" + trackingRef, "--", branch]);
    });
  } catch (error) {
    const cause = error instanceof TaskboardError ? error.message + " " + String((error.details as { output?: string } | undefined)?.output ?? "") : String(error);
    throw new TaskboardError("GIT_UPSTREAM_FAILED", "The commit was pushed, but upstream could not be configured. " +
      "The repository and remote were preserved; check branch tracking before retrying.",
      { pushed: true, branch, head, remote, remoteRef, output: redactSecrets(cause.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1")).slice(0, 4000) });
  }
}

export async function pushRepositoryBranch(location: BoardLocation, input: Record<string, unknown>) {
  const root = repositoryPath(location);
  const branch = text(input.branch, "branch", true);
  const head = text(input.head, "head", true);
  const source = "refs/heads/" + branch;
  if (Object.keys(input).some(key => !["branch", "head", "remote", "remoteBranch"].includes(key)) || branch.startsWith("-") ||
      !commitId.test(head) || invokeGit(root, ["check-ref-format", source]).code !== 0) {
    throw new TaskboardError("INVALID_INPUT", "Pass a local branch name and its full Git commit ID.");
  }
  const { remote, remoteRef } = onBoard(location, () => {
    const tip = resolveCommit(root, source);
    if (!tip) throw new TaskboardError("GIT_BRANCH_REQUIRED", "The local branch does not exist.");
    if (tip !== head) throw new TaskboardError("STALE_REPOSITORY", "The branch tip changed. Read its current commit before pushing.");
    if (input.remote === undefined && input.remoteBranch === undefined) return repositoryPushTarget(root, branch);
    const remote = configuredRemote(root, input.remote);
    const remoteRef = branchRef(root, input.remoteBranch, "remoteBranch");
    const tracking = branchTracking(root, branch);
    if (tracking.some(Boolean) && (tracking[0] !== remote || tracking[1] !== remoteRef)) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "Use the existing upstream as the push destination.");
    }
    return { remote, remoteRef };
  });
  await pushPinnedBranch(location, branch, head, { remote, remoteRef });
  return { branch, head, remote, remoteRef, gitInfo: boardGitInfo(location) };
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
    if (git(root, ["remote"]).trim()) {
      throw new TaskboardError("REMOTE_EXISTS", "A remote already exists. Manage this remote with your Git tools.");
    }
    return { branch: current.branch, head: current.head };
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
  const originalTracking = branchTracking(root, current.branch);
  try {
    await execute("gh", ["repo", "create", name, "--" + visibility, "--source", root, "--remote", "origin"], options);
  } catch (error) {
    throw new TaskboardError("GITHUB_PUBLISH_FAILED", "GitHub publication failed. Check your connection and permissions. If a repository or origin was created, it was preserved; inspect it with your Git tools before retrying.", {
      output: String((error as { stderr?: string }).stderr ?? "").trim().slice(0, 4000),
    });
  }
  try {
    await pushPinnedBranch(location, current.branch, current.head,
      { remote: "origin", remoteRef: "refs/heads/" + current.branch }, originalTracking);
  } catch (error) {
    if (error instanceof TaskboardError && error.code === "GIT_UPSTREAM_FAILED") throw error;
    const output = error instanceof TaskboardError
      ? (error.details as { output?: string } | undefined)?.output : (error as { stderr?: string }).stderr;
    throw new TaskboardError("GITHUB_PUSH_FAILED", "The GitHub repository and origin were created, but the push failed. Check Git authentication and push the branch with your Git tools.", {
      output: String(output ?? "").trim().slice(0, 4000),
    });
  }
  return { remote: git(root, ["remote", "get-url", "origin"]).trim(), gitInfo: boardGitInfo(location) };
}
