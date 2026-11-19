import { codexThreadPattern } from "../cli/model.ts";
import { onBoard } from "../cli/storage.ts";
import { registerRuntime, runtimeLocation, taskWriterId } from "./board-runtime.ts";
import { archiveCodexThread } from "./codex-chat.ts";

// Called only for IDs returned by Codex when the board creates a dedicated thread.
export function rememberTaskCodexThread(project: string, id: string, threadId: string) {
  if (!codexThreadPattern.test(threadId)) throw new Error("Codex returned an invalid task thread ID.");
  const location = runtimeLocation(project);
  if (location.root !== project) throw new Error("The task board root changed.");
  onBoard(location, store => {
    const task = store.card(id);
    if (task.status === "done" || task.status === "cancelled") return;
    const threads = task.codexServiceThreads ?? [];
    if (!threads.includes(threadId)) store.save({ ...task, codexServiceThreads: [...threads, threadId] });
  });
}

export async function archiveAcceptedCodexChats(profile: string, project: string, id: string, archive = archiveCodexThread) {
  const location = runtimeLocation(project);
  if (location.root !== project) return;
  const release = registerRuntime(project, { kind: "task", task: id }, entries =>
    !entries.some(entry => entry.kind !== "queue" && taskWriterId(entry.task) === id));
  if (!release) return;
  try {
    const pending = onBoard(location, store => {
      const task = store.index.archive[id] ?? store.card(id);
      return task.status === "done" ? task.codexArchivePending ?? [] : [];
    });
    for (const threadId of pending) {
      if (typeof threadId !== "string" || !codexThreadPattern.test(threadId)) continue;
      try {
        if (!await release.run(() => archive(profile, project, threadId))) continue;
        onBoard(location, store => {
          const link = store.index.archive[id];
          const task = link ?? store.card(id);
          if (task.status !== "done" || !task.codexArchivePending?.includes(threadId)) return;
          const remaining = task.codexArchivePending.filter(entry => entry !== threadId);
          const codexArchivePending = remaining.length ? remaining : undefined;
          if (link) {
            store.index.archive[id] = { ...link, codexArchivePending };
            store.saveIndex();
          } else {
            store.save({ ...store.card(id), codexArchivePending });
          }
        });
      } catch (error) {
        console.warn("Could not archive a Codex chat for %s: %s", id, (error as Error).message);
      }
    }
  } finally {
    release();
  }
}
