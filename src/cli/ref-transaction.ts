import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { git, gitEnvironment, invokeGit } from "./git.ts";
import { TaskboardError } from "./model.ts";

// A detached Git directory shares the repository's branch refs without causing
// Git to add an implicit update for the main worktree's HEAD to a branch transaction.
export async function withDetachedRefStore<T>(root: string, head: string, use: (args: string[]) => Promise<T>) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trimEnd();
  const directory = mkdtempSync(join(tmpdir(), "taskboard-refs-"));
  try {
    writeFileSync(join(directory, "commondir"), common + "\n");
    writeFileSync(join(directory, "HEAD"), head + "\n");
    return await use(["--git-dir", directory]);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function withPreparedRefs<T>(root: string, args: string[], commands: string[], message: string,
  use: (commit: () => Promise<void>) => Promise<T>) {
  const child = spawn("git", [...args, "update-ref", "-m", message, "--stdin"], {
    cwd: root, env: { ...gitEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    stdio: "pipe", windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  child.stdin.on("error", () => {});
  child.on("error", error => { diagnostic = error.message; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  const failure = () => new TaskboardError("GIT_REF_TRANSACTION_FAILED",
    "Git could not lock or verify the expected references. Check the checkout, branch tips and Git version.",
    { output: diagnostic.trim() });
  try {
    child.stdin.write(["start", ...commands, "prepare", ""].join("\n"));
    if ((await lines.next()).value !== "start: ok" || (await lines.next()).value !== "prepare: ok") {
      child.stdin.end();
      await closed;
      throw failure();
    }
    return await use(async () => {
      child.stdin.end("commit\n");
      if (await closed !== 0) throw failure();
    });
  } finally {
    if (!child.stdin.writableEnded && child.exitCode === null) child.stdin.end("abort\n");
    child.stdout.resume();
    await closed;
  }
}

export async function withGuardedBranchRefs<T>(root: string, ref: string, head: string, commands: string[],
  message: string, use: (commit: () => Promise<void>) => Promise<T>) {
  if (invokeGit(root, ["rev-parse", "--show-ref-format"]).stdout.trim() === "reftable") {
    // Reftable holds the main repository's table lock for every prepared
    // transaction. Read HEAD under that lock without queuing it twice.
    return withPreparedRefs(root, [], commands, message, async commit => {
      if (invokeGit(root, ["symbolic-ref", "--no-recurse", "--quiet", "HEAD"]).stdout.trim() !== ref) {
        throw new TaskboardError("STALE_REPOSITORY", "The checkout or remote default branch changed before the reference transaction.");
      }
      return use(commit);
    });
  }
  const guard = ["option no-deref", "symref-verify HEAD " + ref];
  return withPreparedRefs(root, [], guard, "taskboard: verify symbolic HEAD", async () =>
    withDetachedRefStore(root, head, async args => withPreparedRefs(root, args, commands, message, use)));
}
