import { parentPort, workerData } from "node:worker_threads";
import { GoalHistoryIndex, hasGoalHistory, readManagerLocalPage } from "./manager-history.ts";

const port = parentPort!;
const index = workerData === "work" ? new GoalHistoryIndex() : undefined;
port.on("message", ({ id, project, cursor, hasProvider, availabilityOnly }) => {
  try {
    let result;
    if (!index) {
      result = readManagerLocalPage(project, cursor, "chat", hasProvider);
    } else if (availabilityOnly) {
      result = { goalLogAvailable: hasGoalHistory(project) };
    } else {
      result = index.read(project, cursor, hasProvider);
    }
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message });
  }
});
