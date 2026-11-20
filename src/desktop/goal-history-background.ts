import { Worker } from "node:worker_threads";
import type { GoalHistoryIndex } from "./manager-history.ts";

type GoalHistory = ReturnType<GoalHistoryIndex["read"]>;
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, ReturnType<typeof Promise.withResolvers<GoalHistory>>>();

export async function backgroundGoalHistory(project: string, cursor: string | null, hasProvider: boolean, availabilityOnly = false) {
  if (!worker) {
    const instance = new Worker(new URL("./goal-history-worker.ts", import.meta.url), { execArgv: [] });
    worker = instance;
    const fail = (error: Error) => {
      if (worker !== instance) return;
      worker = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    instance.on("error", fail);
    instance.on("exit", () => fail(new Error("The goal history worker exited.")));
    instance.on("message", ({ id, result, error }) => {
      const request = pending.get(id);
      if (!request || worker !== instance) return;
      pending.delete(id);
      if (error !== undefined) request.reject(new Error(error));
      else request.resolve(result);
      if (!pending.size) instance.unref();
    });
  }
  const id = ++sequence;
  const request = Promise.withResolvers<GoalHistory>();
  try {
    worker.postMessage({ id, project, cursor, hasProvider, availabilityOnly });
    pending.set(id, request);
    worker.ref();
  } catch (error) {
    if (!pending.size) worker.unref();
    throw error;
  }
  return request.promise;
}
