import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { advanceWorktree } from "./fast-forward-worktree.ts";
import { withGuardedBranchRefs } from "./ref-transaction.ts";
import { discoverRepository, git, gitEnvironment, invokeGit, isAncestor, resolveCommit, worktrees } from "./git.ts";
import { member, TaskboardError, text } from "./model.ts";
import { redactSecrets } from "./redact.ts";
import { onBoard, type BoardLocation, type BoardStore } from "./storage.ts";
import { checkProtectedPaths, gitStatus, requireNoGitOperation } from "./worktree.ts";

const execute = promisify(execFile);
const heads = "refs/heads/";
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const historyEnv = { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_GRAFT_FILE: "" };
const fetchOptions = ["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules",
  "--no-write-fetch-head", "--no-auto-maintenance", "--refmap="];

export function branchRef(root: string, value: unknown, label = "branch") {
  const branch = text(value, label, true);
  const ref = heads + branch;
  if (branch.startsWith("-") || branch === "HEAD" || invokeGit(root, ["check-ref-format", ref]).code !== 0) {
    throw new TaskboardError("INVALID_INPUT", "Use a literal Git branch name for " + label + ".");
  }
  return ref;
}

function expectedCommit(value: unknown) {
  const head = text(value, "head", true);
  if (!commitId.test(head)) throw new TaskboardError("INVALID_INPUT", "Use a full Git commit ID.");
  return head;
}

function remotes(root: string) {
  return git(root, ["remote"]).split(/\r?\n/).filter(Boolean);
}

export function configuredRemote(root: string, value: unknown) {
  const remote = text(value, "remote", true);
  if (!remotes(root).includes(remote)) {
    throw new TaskboardError("GIT_REMOTE_REQUIRED", "Choose a configured Git remote.", { remote });
  }
  return remote;
}

function remoteUrls(root: string, remote: string, push = false) {
  return git(root, ["remote", "get-url", "--all", ...(push ? ["--push"] : []), "--", remote]).trimEnd();
}

function networkOptions(root: string) {
  return {
    cwd: root, env: { ...gitEnvironment(), ...historyEnv, GCM_INTERACTIVE: "never" },
    windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const,
  };
}

function networkFailure(error: unknown, remote: string, message: string) {
  const { stderr, stdout, killed, code } = error as {
    stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean; code?: string;
  };
  const output = redactSecrets([stderr, stdout].filter(Boolean).join("\n").trim()
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1")).slice(0, 4000);
  return new TaskboardError("GIT_REMOTE_FAILED",
    message + (killed || code === "ETIMEDOUT" ? " Git timed out. Check the remote before retrying." : ""), { remote, output });
}

async function networkGit(root: string, remote: string, args: string[], message: string) {
  try {
    return (await execute("git", args, networkOptions(root))).stdout;
  } catch (error) {
    throw networkFailure(error, remote, message);
  }
}

async function advertisedRefs(root: string, remote: string, refs: string[]) {
  const output = await networkGit(root, remote, ["ls-remote", "--symref", "--", remote, ...refs],
    "Git could not read the remote branches. Check the remote URL, connection and permissions.");
  return new Map(output.trimEnd().split(/\r?\n/).filter(line => line.includes("\t")).map(line => {
    const [value, name] = line.split("\t");
    // HEAD has both a symbolic target and an object ID.
    return [value!.startsWith("ref: ") ? "symref:" + name : name!, value!.replace(/^ref: /, "")];
  }));
}

async function fetchObject(root: string, remote: string, head: string) {
  await networkGit(root, remote, [...fetchOptions, "--", remote, head],
    "Git could not fetch the checked remote commit. Check the remote and retry.");
  if (resolveCommit(root, head) !== head) {
    throw new TaskboardError("GIT_COMMIT_REQUIRED", "Git could not verify the fetched commit.");
  }
}

export function listRepositoryBranches(root: string) {
  const refs = git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)%00%(upstream)",
    "refs/heads/", "refs/remotes/"]).trimEnd();
  const branches = refs ? refs.split(/\r?\n/).map(line => {
    const [ref, head, symbolicTarget, upstream] = line.split("\0");
    return { ref, head, ...(symbolicTarget ? { symbolicTarget } : {}), ...(upstream ? { upstream } : {}) };
  }) : [];
  return { branches, remotes: remotes(root), worktrees: worktrees(root) };
}

export async function fetchRepositoryBranches(root: string, input: Record<string, unknown>) {
  const remote = configuredRemote(root, input.remote);
  const result = invokeGit(root, ["config", "--get-all", "remote." + remote + ".fetch"]);
  const specs = result.stdout.trimEnd().split(/\r?\n/);
  const prefix = "refs/remotes/" + remote + "/";
  if (result.code !== 0 || !specs.some(spec => !spec.startsWith("^")) || specs.some(spec => {
    if (spec.startsWith("^")) return !spec.startsWith("^" + heads);
    const [source, target, extra] = spec.replace(/^\+/, "").split(":");
    return !source?.startsWith(heads) || !target?.startsWith(prefix) || extra !== undefined ||
      invokeGit(root, ["check-ref-format", "--refspec-pattern", target]).code !== 0;
  })) {
    throw new TaskboardError("GIT_FETCH_MAPPING", "Configure a branch fetch mapping into " + prefix + " before fetching.");
  }
  const tracking = git(root, ["for-each-ref", "--format=%(symref)", prefix]).split(/\r?\n/).filter(Boolean);
  if (tracking.some(target => !target.startsWith(prefix))) {
    throw new TaskboardError("GIT_FETCH_MAPPING", "A symbolic tracking ref points outside " + prefix + ".");
  }
  await networkGit(root, remote, [...fetchOptions, "--atomic", "--", remote, ...specs],
    "Git could not fetch remote-tracking branches. Check the remote URL, connection and permissions.");
  return { remote, ...listRepositoryBranches(root) };
}

export function createRepositoryBranch(root: string, input: Record<string, unknown>) {
  const ref = branchRef(root, input.branch);
  const head = expectedCommit(input.head);
  if (resolveCommit(root, head) !== head) throw new TaskboardError("GIT_COMMIT_REQUIRED", "The starting commit does not exist.");
  git(root, ["branch", "--no-track", "--", ref.slice(heads.length), head]);
  return { branch: ref.slice(heads.length), ref, head };
}

export async function fastForwardRepository(location: BoardLocation, input: Record<string, unknown>) {
  const root = location.root;
  const ref = branchRef(root, input.branch);
  const head = expectedCommit(input.head);
  const checkWorktree = () => {
    requireNoGitOperation(root);
    if (invokeGit(root, ["symbolic-ref", "-q", "HEAD"]).stdout.trim() !== ref || resolveCommit(root, "HEAD") !== head) {
      throw new TaskboardError("STALE_REPOSITORY", "The checked-out branch or HEAD changed. Read the current Git status and retry.");
    }
    if (gitStatus(root)) throw new TaskboardError("GIT_DIRTY_WORKTREE", "Commit or save worktree changes before fast-forwarding.");
  };
  const source = () => {
    const configured = ["remote", "merge"].map(key => {
      const result = invokeGit(root, ["config", "--get-all", "branch." + input.branch + "." + key]);
      if (result.code === 1) return "";
      if (result.code !== 0 || !result.stdout.trimEnd() || result.stdout.trimEnd().includes("\n")) {
        throw new TaskboardError("GIT_REMOTE_REQUIRED", "Configure a single upstream remote and branch.");
      }
      return result.stdout.trimEnd();
    });
    if (Boolean(configured[0]) !== Boolean(configured[1]) ||
        (input.remote === undefined) !== (input.remoteBranch === undefined)) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "Use a complete upstream or specify both remote and remoteBranch.");
    }
    if (input.remote === undefined && !configured[0]) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "This branch has no upstream. Specify remote and remoteBranch.");
    }
    const remote = configuredRemote(root, input.remote ?? configured[0]);
    const remoteRef = input.remoteBranch === undefined ? configured[1]! : branchRef(root, input.remoteBranch, "remoteBranch");
    if (!remoteRef.startsWith(heads) || invokeGit(root, ["check-ref-format", remoteRef]).code !== 0 ||
        (configured[0] && (configured[0] !== remote || configured[1] !== remoteRef))) {
      throw new TaskboardError("GIT_REMOTE_REQUIRED", "Use the configured upstream, or name the remote and branch when there is no upstream.");
    }
    return { remote, remoteRef, url: remoteUrls(root, remote) };
  };
  const snapshot = onBoard(location, () => {
    checkWorktree();
    return source();
  });
  const { remote, remoteRef } = snapshot;
  const target = (await advertisedRefs(root, remote, [remoteRef])).get(remoteRef);
  if (!target || !commitId.test(target)) {
    throw new TaskboardError("GIT_BRANCH_REQUIRED", "The source branch is missing on the configured remote.", { remote, remoteRef });
  }
  await fetchObject(root, remote, target);
  const checkSource = () => {
    if (JSON.stringify(source()) !== JSON.stringify(snapshot)) {
      throw new TaskboardError("STALE_REPOSITORY", "The upstream or remote configuration changed during fetch.");
    }
  };
  const check = () => {
    checkWorktree();
    checkSource();
    checkProtectedPaths(root, git(root, ["diff", "--name-only", "--no-renames", "-z", head, target, "--"], historyEnv).split("\0").filter(Boolean));
  };
  const needsUpdate = onBoard(location, () => {
    checkWorktree();
    checkSource();
    if (head === target || isAncestor(root, target, head, historyEnv)) {
      return false;
    }
    if (!isAncestor(root, head, target, historyEnv)) {
      throw new TaskboardError("GIT_DIVERGED", "Local and remote histories diverged. Fast-forward was refused.", { head, remote, remoteRef, target });
    }
    return true;
  });
  if (!needsUpdate) return { branch: input.branch, head, remote, remoteRef, remoteHead: target, updated: false };
  await advanceWorktree(root, ref, head, target, historyEnv, () => onBoard(location, check));
  return { branch: input.branch, head: target, previousHead: head, remote, remoteRef, remoteHead: target, updated: true };
}

function transactionalRemote(root: string, url: string, remote: string) {
  const unsupported = () => new TaskboardError("GIT_REMOTE_TRANSACTION_UNAVAILABLE",
    "Safe branch deletion requires direct transactional access to the configured remote repository. The branch was preserved.", { remote });
  if (url.includes("\n")) throw unsupported();
  let path: string;
  if (url.startsWith("file://")) {
    try { path = fileURLToPath(url); } catch { throw unsupported(); }
  } else if (isAbsolute(url) || !url.includes(":")) {
    path = resolve(root, url);
  } else {
    throw unsupported();
  }
  const repo = existsSync(path) ? discoverRepository(path) : null;
  if (!repo || repo.root !== realpathSync(path) || repo.root === realpathSync(root)) throw unsupported();
  return repo;
}

function requireDirectRemoteDeletion(root: string, remoteRoot: string, remote: string) {
  const hooks = (cwd: string, names: string[]) => names.some(name =>
    existsSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/" + name]).trimEnd()));
  const deny = invokeGit(remoteRoot, ["config", "--type=bool", "--default=false", "--get", "receive.denyDeletes"]);
  const customTransport = ["receivepack", "uploadpack"].some(key =>
    invokeGit(root, ["config", "--get", "remote." + remote + "." + key]).code !== 1);
  const filters = invokeGit(remoteRoot, ["config", "--get-regexp", "^(receive[.](hiderefs|procreceiverefs)|transfer[.]hiderefs)$"]);
  if (deny.code !== 0 || deny.stdout.trim() !== "false" || filters.code !== 1 || customTransport ||
      hooks(root, ["pre-push"]) ||
      hooks(remoteRoot, ["pre-receive", "update", "proc-receive", "post-receive", "post-update"])) {
    throw new TaskboardError("GIT_REMOTE_TRANSACTION_UNAVAILABLE",
      "The remote or project has push rules that require normal receive-pack. Branch deletion was refused.", { remote });
  }
}

function clearDeletedBranchConfig(root: string, branch: string) {
  const result = invokeGit(root, ["config", "--local", "--remove-section", "branch." + branch]);
  if (result.code !== 0 && !result.stderr.startsWith("fatal: no such section:")) {
    throw new TaskboardError("GIT_BRANCH_CONFIG_FAILED",
      "The local branch was deleted, but Git could not remove its configuration. Clean up the old branch settings before recreating it.",
      { branch, deleted: true, output: result.stderr.trim() });
  }
}

export async function deleteRepositoryBranch(location: BoardLocation, input: Record<string, unknown>) {
  const root = location.root;
  const scope = member(input.scope, ["local", "remote"], "scope");
  const ref = branchRef(root, input.branch);
  const head = expectedCommit(input.head);
  const remote = configuredRemote(root, input.remote);
  if (input.confirmed !== true) {
    throw new TaskboardError("USER_DIRECTION_REQUIRED", "Deletion requires user approval for this branch, remote and commit.");
  }
  const url = remoteUrls(root, remote);
  const repo = transactionalRemote(root, url, remote);
  const oid = (path: string, name: string) => invokeGit(path,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", name], historyEnv).stdout.trim();
  const symbolic = (path: string, name: string) => invokeGit(path, ["symbolic-ref", "--no-recurse", "--quiet", name]).stdout.trim();
  const defaultBranch = (path: string, name: string) => {
    const ref = symbolic(path, "HEAD");
    const head = ref.startsWith(heads) && !symbolic(path, ref) ? oid(path, ref) : "";
    if (!commitId.test(head) || invokeGit(path, ["cat-file", "-t", head], historyEnv).stdout.trim() !== "commit") {
      throw new TaskboardError("GIT_REMOTE_DEFAULT_UNKNOWN", "Could not verify the remote's default branch and current commit.", { remote: name });
    }
    return { ref, head };
  };
  const selected = defaultBranch(repo.root, remote);
  const { ref: primary, head: primaryHead } = selected;
  const originUrl = () => remote !== "origin" && remotes(root).includes("origin") ? remoteUrls(root, "origin") : undefined;
  const configuredOrigin = originUrl();
  const originRepo = configuredOrigin === undefined ? undefined : transactionalRemote(root, configuredOrigin, "origin");
  const projectDefault = originRepo && originRepo.root !== repo.root ? defaultBranch(originRepo.root, "origin") : selected;

  const branch = ref.slice(heads.length);
  const checkBranch = (store: BoardStore) => {
    const compare = (candidate?: string) => candidate?.toLowerCase() === ref.toLowerCase();
    const trees = worktrees(root);
    const originDefault = symbolic(root, "refs/remotes/origin/HEAD");
    const originPrefix = "refs/remotes/origin/";
    if ([primary, projectDefault.ref, trees[0]?.branch, heads + "main", heads + "master",
      originDefault.startsWith(originPrefix) ? heads + originDefault.slice(originPrefix.length) : undefined].some(compare) ||
      ref.toLowerCase().startsWith(heads + "ai-taskboard/")) {
      throw new TaskboardError("GIT_PROTECTED_BRANCH", "This is a protected project, remote default or task branch.", { ref, remote });
    }
    const task = store.storedCards().find(task => !["done", "cancelled"].includes(task.status) &&
      (compare(task.git?.target) || compare(task.git?.branch)));
    if (task) throw new TaskboardError("GIT_PROTECTED_BRANCH", "An open card uses this branch.", { ref, id: task.id });
    if (trees.some(tree => compare(tree.branch)) || (scope === "remote" && worktrees(repo.root).some(tree => compare(tree.branch)))) {
      throw new TaskboardError("GIT_BRANCH_IN_USE", "A registered worktree has this branch checked out.", { ref });
    }
    const targetRoot = scope === "local" ? root : repo.root;
    if (symbolic(targetRoot, ref) || oid(targetRoot, ref) !== head) {
      throw new TaskboardError("STALE_REPOSITORY", "The selected branch is missing, symbolic or changed since inspection.", { remote, ref });
    }
  };
  const checkDestination = () => {
    if (invokeGit(root, ["config", "--get", "remote." + remote + ".uploadpack"]).code !== 1) {
      throw new TaskboardError("GIT_REMOTE_TRANSACTION_UNAVAILABLE",
        "The configured remote uses a custom upload-pack command. Its default branch could not be guarded directly.", { remote });
    }
    if (remoteUrls(root, remote) !== url || transactionalRemote(root, url, remote).root !== repo.root) {
      throw new TaskboardError("STALE_REPOSITORY", "The remote destination changed during verification.");
    }
    if (originUrl() !== configuredOrigin || (originRepo && transactionalRemote(root, configuredOrigin!, "origin").root !== originRepo.root)) {
      throw new TaskboardError("STALE_REPOSITORY", "The project origin changed during verification.");
    }
    if (originRepo && invokeGit(root, ["config", "--get", "remote.origin.uploadpack"]).code !== 1) {
      throw new TaskboardError("GIT_REMOTE_TRANSACTION_UNAVAILABLE",
        "The project origin uses a custom upload-pack command. Its default branch could not be guarded directly.", { remote: "origin" });
    }
    if (scope === "remote") {
      if (!repo.bare || remoteUrls(root, remote, true) !== url) {
        throw new TaskboardError("GIT_REMOTE_TRANSACTION_UNAVAILABLE",
          "Remote deletion requires a bare repository with one identical fetch and push destination.", { remote });
      }
      requireDirectRemoteDeletion(root, repo.root, remote);
    }
  };

  onBoard(location, store => {
    checkDestination();
    checkBranch(store);
  });
  if (invokeGit(repo.root, ["cat-file", "-t", head], historyEnv).stdout.trim() !== "commit" ||
      !isAncestor(repo.root, head, primaryHead, historyEnv)) {
    throw new TaskboardError("GIT_UNMERGED_BRANCH", "The branch contains commits outside the verified history of the remote's current default branch.",
      { ref, head, remote, primary, primaryHead });
  }

  const commands = ["option no-deref", "verify " + primary + " " + primaryHead];
  if (scope === "remote") commands.push("option no-deref", "delete " + ref + " " + head);
  await onBoard(location, async store =>
    withGuardedBranchRefs(repo.root, primary, primaryHead, commands, "taskboard: guard deletion of " + ref, async commit => {
      const remove = async () => {
        checkDestination();
        checkBranch(store);
        if (scope === "remote") {
          await commit();
        } else {
          git(root, ["update-ref", "--no-deref", "-d", ref, head]);
          clearDeletedBranchConfig(root, branch);
        }
      };
      if (originRepo && originRepo.root !== repo.root) {
        await withGuardedBranchRefs(originRepo.root, projectDefault.ref, projectDefault.head,
          ["option no-deref", "verify " + projectDefault.ref + " " + projectDefault.head],
          "taskboard: guard project default branch", remove);
      } else {
        await remove();
      }
    }));
  return { scope, branch, ref, head, remote, primary, primaryHead, deleted: true };
}
