import { setTimeout as delay } from "node:timers/promises";
import { number, object, TaskboardError } from "../cli/model.ts";
import type { BoardMcpTool } from "./board-mcp.ts";
import { cliFailure } from "./cli.ts";
import { inspectProjectPath } from "./project-files.ts";

const maxWaitSeconds = 20 * 60;
export const executorToolTimeoutSeconds = maxWaitSeconds + 20;
export const checkWaitInstructions = [
  "For a long check launched with exec_command, keep its session_id and use write_stdin with empty chars to wait for the exit code and output on that session. When waiting is the only work left, use a 60000 ms yield. Inspect partial logs only to answer a specific diagnostic question.",
  "For a detached or delegated check without a session_id, arrange before launch to save the exit code and create a unique marker in the working directory after exit, including on failure. When waiting is the only work left, call check_wait with that marker and omit timeoutSeconds. If the wait times out while the check is still running, wait on the same marker again. Read the saved exit code and report when the marker appears.",
  "In functions.exec, use a 60000 ms yield when waiting is your only action. If it returns a running cell, continue waiting on that cell with functions.wait.",
].join(" ");

export const checkWaitTool: BoardMcpTool = {
  name: "check_wait",
  description: "Wait for a fresh completion marker in the assigned working directory while a check runs. Set up the check to create a unique marker after it exits, including on failure. Read the saved exit code and report separately. When waiting is the only remaining work, omit timeoutSeconds to use the full wait. The result returns early when the marker arrives.",
  inputSchema: { type: "object", required: ["path"], additionalProperties: false, properties: {
    path: { type: "string", description: "Relative path to the completion marker for this run." },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: maxWaitSeconds,
      description: `Defaults to ${maxWaitSeconds} seconds. Set a shorter timeout if you need to return to other work before then.` },
  } },
};

export async function waitForCheck(cwd: string, args: unknown, signal: AbortSignal) {
  try {
    const { path, timeoutSeconds = maxWaitSeconds, ...extra } = object(args);
    const seconds = number(timeoutSeconds, "timeoutSeconds", 1);
    if (Object.keys(extra).length || seconds > maxWaitSeconds) {
      return cliFailure("INVALID_INPUT", `Choose a marker path and a wait of at most ${maxWaitSeconds} seconds.`);
    }
    const deadline = performance.now() + seconds * 1000;
    while (true) {
      const marker = await inspectProjectPath(cwd, path, false, signal);
      if (marker.exists) {
        return marker.kind === "file" ? { ok: true as const, data: { path: marker.path, timedOut: false } } :
          cliFailure("INVALID_INPUT", "The completion marker must be a file.");
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { ok: true as const, data: { path: marker.path, timedOut: true } };
      await delay(Math.min(1000, remaining), undefined, { signal });
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TaskboardError) return cliFailure(error.code, error.message);
    throw error;
  }
}
