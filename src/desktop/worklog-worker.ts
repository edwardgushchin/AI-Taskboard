import { parentPort } from "node:worker_threads";
import { InvalidWorklogSubmission, worklogStorage } from "./board-worklog.ts";
import type { WorklogWrite } from "./board-worklog.ts";

const port = parentPort!;
port.on("message", ({ id, project, staged }: WorklogWrite & { id: number }) => {
  try {
    const storage = worklogStorage(project);
    if (!staged) storage.retry();
    port.postMessage({ id, saved: staged ? storage.persist(staged) : undefined });
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message, invalid: error instanceof InvalidWorklogSubmission });
  }
});
