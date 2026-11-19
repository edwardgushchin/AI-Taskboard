import { parentPort, workerData } from "node:worker_threads";
import { createBackup, pruneBackups, restoreBackup, verifyBackup } from "./board-backups.ts";

export type BackupRequest =
  | { action: "create"; project: string }
  | { action: "prune" }
  | { action: "verify"; id: string }
  | { action: "restore"; id: string; parent: string };

const { request, root, now } = workerData as { request: BackupRequest; root: string; now: number };
try {
  switch (request.action) {
    case "create":
      parentPort!.postMessage({ data: createBackup(root, request.project, now) });
      break;
    case "prune":
      pruneBackups(root, now);
      parentPort!.postMessage({});
      break;
    case "verify":
      parentPort!.postMessage({ data: verifyBackup(root, request.id, now) });
      break;
    case "restore":
      parentPort!.postMessage({ data: restoreBackup(root, request.id, request.parent, now) });
      break;
  }
} catch (error) {
  parentPort!.postMessage({ error: (error as Error).message });
}
