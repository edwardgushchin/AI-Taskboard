import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const entry = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
export const bundled = join(process.resourcesPath, "bin", process.platform === "win32" ? "ai-taskboard.exe" : "ai-taskboard");

export interface CliError {
  code: string;
  message: string;
  details?: unknown;
}

export type CliReply<T = unknown> = { ok: true; data: T } | { ok: false; error: CliError };

export function cliFailure(code: string, message: string): CliReply<never> {
  return { ok: false, error: { code, message } };
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

export function callCli<T>(project: string, args: string[], input?: unknown): Promise<CliReply<T>> {
  return new Promise(resolve => {
    const child = cliChild(project, args, input);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errorOutput += chunk; });
    child.once("error", error => resolve(cliFailure("CLI_UNAVAILABLE", error.message)));
    child.once("close", () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve(cliFailure("CLI_UNAVAILABLE", errorOutput.trim() || "The CLI returned no result."));
      }
    });
  });
}
