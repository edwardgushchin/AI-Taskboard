import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function localizationFixture(locale = "ru") {
  const localization = createRequire(import.meta.url)("../src/desktop/localization.cjs");
  return readFileSync(new URL("../src/desktop/localization.cjs", import.meta.url), "utf8") +
    `\nObject.assign(window.taskboardLocalization.catalogs, ${JSON.stringify(localization.catalogs)});\nwindow.taskboardLocalization.select(${JSON.stringify(locale)});\n`;
}

export function electronCheck(script, name, timeout, phases = [[]]) {
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
      for (const phase of phases) {
        const result = spawnSync(electron, [fileURLToPath(script), ...args, ...phase], {
          // Desktop helpers can briefly retain their inherited working directory after exit.
          cwd: process.platform === "win32" || phases.length > 1 ? temp : scratch, env, windowsHide: true, stdio: "inherit", timeout,
        });
        if (result.error) console.error(result.error);
        else if (result.status !== 0) console.error("Electron check failed: " + (result.signal ?? result.status));
        status = result.status ?? 1;
        if (status !== 0) break;
      }
    } finally {
      // Electron can keep the profile open until its subprocesses exit.
      if (dirname(realpathSync(scratch)) !== temp) throw new Error("Unexpected Electron check directory: " + scratch);
      if (process.platform === "win32") {
        const cleanup = spawnSync(process.execPath, ["--input-type=module", "-e",
          'import { rm } from "node:fs/promises"; await rm(process.argv[1], { recursive: true, maxRetries: 10, retryDelay: 250 });',
          scratch], { cwd: temp, windowsHide: true, stdio: "inherit" });
        if (cleanup.error) throw cleanup.error;
        if (cleanup.status !== 0) status = 1;
      } else {
        rmSync(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
      }
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
