import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const entry = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
export const bundled = join(process.resourcesPath ?? dirname(process.execPath), "bin", process.platform === "win32" ? "ai-taskboard.exe" : "ai-taskboard");

export interface CliError {
  code: string;
  message: string;
  details?: unknown;
}

export type CliReply<T = unknown> = { ok: true; data: T } | { ok: false; error: CliError };

export function cliFailure(code: string, message: string): CliReply<never> {
  return { ok: false, error: { code, message } };
}

export function cliSpawnFailure(operation: string, phase: "spawn" | "error", cause: unknown): CliError {
  const error = cause as NodeJS.ErrnoException | undefined;
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : undefined;
  return {
    code: "CLI_UNAVAILABLE",
    message: "Could not start the CLI for " + operation + (code ? " (" + code + ")." : "."),
    details: {
      operation, phase, platform: process.platform, runtime: existsSync(bundled) ? "bundled" : "source",
      code, errno: typeof error?.errno === "number" ? error.errno : undefined,
      syscall: error?.syscall?.split(" ")[0] === "spawn" ? "spawn" : undefined,
    },
  };
}

export function cliChild(project: string, args: string[], input?: unknown): ChildProcessWithoutNullStreams {
  const packaged = existsSync(bundled);
  const command = packaged ? bundled : process.execPath;
  const prefix = packaged ? [] : ["--disable-warning=ExperimentalWarning", entry];
  const child = spawn(command, [...prefix, "--project", project, "--json", ...args, ...(input === undefined ? [] : ["--stdin"])], {
    cwd: project,
    env: packaged ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: "pipe",
  });
  child.stdin.on("error", () => {
    // The child may exit before reading stdin. Its own error is reported by the caller.
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return child;
}

export async function callCli<T>(project: string, args: string[], input?: unknown): Promise<CliReply<T>> {
  const result = await callCliOnce<T>(project, args, input);
  // BOARD_BUSY is returned before the CLI starts the operation.
  return !result.ok && result.error.code === "BOARD_BUSY" ? callCliOnce<T>(project, args, input) : result;
}

function callCliOnce<T>(project: string, args: string[], input?: unknown): Promise<CliReply<T>> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = cliChild(project, args, input);
    } catch (error) {
      resolve({ ok: false, error: cliSpawnFailure(args[0], "spawn", error) });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", error => resolve({ ok: false, error: cliSpawnFailure(args[0], "error", error) }));
    child.once("close", (exitCode, signal) => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve({ ok: false, error: { code: "CLI_UNAVAILABLE", message: "The CLI returned no result.",
          details: { operation: args[0], phase: "reply", exitCode, signal } } });
      }
    });
  });
}
