import { closeSync, copyFileSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.ts";
import { TaskboardError } from "./model.ts";
import { withGuardedBranchRefs } from "./ref-transaction.ts";

export async function advanceWorktree(root: string, ref: string, head: string, target: string,
  env: NodeJS.ProcessEnv, check: () => void) {
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
        check();
        const scratch = mkdtempSync(join(tmpdir(), "taskboard-index-"));
        try {
          const temporaryIndex = join(scratch, "index");
          copyFileSync(index, temporaryIndex);
          const apply = (from: string, to: string) => git(root, ["-c", "submodule.recurse=false",
            "read-tree", "-m", "-u", from, to], { ...env, GIT_INDEX_FILE: temporaryIndex });
          apply(head, target);
          try {
            writeFileSync(descriptor!, readFileSync(temporaryIndex));
            closeSync(descriptor!);
            descriptor = undefined;
            await commit();
          } catch (error) {
            try {
              apply(target, head);
            } catch {
              throw new TaskboardError("GIT_FAST_FORWARD_RECOVERY_FAILED",
                "Git could not restore the worktree after the branch update failed. Inspect the checkout before retrying.", { ref, head, target });
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
          rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
        }
      });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (removeLock) rmSync(lock, { force: true });
  }
}
