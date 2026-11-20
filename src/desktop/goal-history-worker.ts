import { parentPort } from "node:worker_threads";
import { GoalHistoryIndex, hasGoalHistory } from "./manager-history.ts";

const port = parentPort!;
const index = new GoalHistoryIndex();
port.on("message", ({ id, project, cursor, hasProvider, availabilityOnly }) => {
  try {
    const result = availabilityOnly
      ? { goalLogAvailable: hasGoalHistory(project) }
      : index.read(project, cursor, hasProvider);
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message });
  }
});
