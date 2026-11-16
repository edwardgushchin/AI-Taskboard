import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function electronCheck(script, name, timeout) {
  if (!process.versions.electron) {
    const temp = realpathSync(tmpdir());
    const scratch = mkdtempSync(join(temp, "ai-taskboard-" + name + "-"));
    const env = { ...process.env, TASKBOARD_CHECK_DIR: scratch, TASKBOARD_CHECK_NODE: process.execPath };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf("--artifacts");
    const output = args[outputIndex + 1];
    if (outputIndex >= 0 && output && !output.startsWith("--")) args[outputIndex + 1] = resolve(output);
    let status = 1;
    try {
      const electron = createRequire(script)("electron");
      const result = spawnSync(electron, [fileURLToPath(script), ...args], {
        cwd: scratch, env, windowsHide: true, stdio: "inherit", timeout,
      });
      if (result.error) console.error(result.error);
      else if (result.status !== 0) console.error("Electron check failed: " + (result.signal ?? result.status));
      status = result.status ?? 1;
    } finally {
      // Electron can keep the profile open until its subprocesses exit.
      if (dirname(realpathSync(scratch)) !== temp) throw new Error("Unexpected Electron check directory: " + scratch);
      rmSync(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
    }
    process.exit(status);
  }

  const scratch = process.env.TASKBOARD_CHECK_DIR;
  if (!scratch) throw new Error("Start this check with Node.js.");
  const outputIndex = process.argv.indexOf("--artifacts", 2);
  if (outputIndex === -1) return { scratch, artifacts: scratch, keepArtifacts: false };
  const output = process.argv[outputIndex + 1];
  if (!output || output.startsWith("--")) throw new Error("Supply a directory after --artifacts.");
  const artifacts = resolve(output);
  mkdirSync(artifacts, { recursive: true });
  return { scratch, artifacts, keepArtifacts: true };
}
