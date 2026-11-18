import { Worker } from "node:worker_threads";
import { InvalidWorklogSubmission } from "./board-worklog.ts";
import type { WorklogSaved, WorklogWrite } from "./board-worklog.ts";

let worker: Worker | undefined;
let next = 0;
const pending = new Map<number, ReturnType<typeof Promise.withResolvers<WorklogSaved | undefined>>>();

export function backgroundWorklog(request: WorklogWrite) {
  try {
    if (!worker) {
      const instance = worker = new Worker(new URL("./worklog-worker.ts", import.meta.url), { execArgv: [] });
      const fail = (error: Error) => {
        if (worker !== instance) return;
        worker = undefined;
        for (const receipt of pending.values()) receipt.reject(error);
        pending.clear();
      };
      instance.on("error", fail);
      instance.on("exit", () => fail(new Error("The background Worklog writer exited.")));
      instance.on("message", ({ id, saved, error, invalid }) => {
        const receipt = pending.get(id);
        if (!receipt || worker !== instance) return;
        pending.delete(id);
        if (error) receipt.reject(invalid ? new InvalidWorklogSubmission(error) : new Error(error));
        else receipt.resolve(saved);
        if (!pending.size) instance.unref();
      });
    }
    const id = ++next;
    const receipt = Promise.withResolvers<WorklogSaved | undefined>();
    worker.ref();
    worker.postMessage({ id, ...request });
    pending.set(id, receipt);
    return receipt.promise;
  } catch (error) {
    if (!pending.size) worker?.unref();
    return Promise.reject(error);
  }
}
