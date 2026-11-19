import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdates, releasesUrl } from "./updates.ts";
import { cliFailure, type CliReply } from "./cli.ts";
import type { BoardMcpTool } from "./board-mcp.ts";

export const applicationUpdateTools: BoardMcpTool[] = [
  { name: "app_check_updates", description: "Check AI Taskboard's current and latest version from the app's official release source and alpha-channel rules. Explain availability, failures and the installation method in the user's language.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "app_install_update", description: "Install the exact version found by app_check_updates, only on the user's explicit installation request. Windows NSIS clients verify the official package and ask for confirmation, then close normally and restart. Busy work keeps running. After success finish your reply so the app can close. Other installations return manual instructions.",
    inputSchema: { type: "object", properties: { version: { type: "string", minLength: 1 } }, required: ["version"], additionalProperties: false } },
];

type Candidate = NonNullable<Awaited<ReturnType<typeof checkForUpdates>>["latest"]>;
export interface PreparedUpdate {
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

export class ApplicationUpdates {
  private found?: Candidate;
  private pending = false;
  prepared?: PreparedUpdate;

  private options: {
    version: () => string;
    supported: () => boolean;
    busy: () => boolean;
    confirm: (version: string, signal: AbortSignal) => Promise<boolean>;
    prepare: (candidate: Candidate, signal: AbortSignal) => Promise<PreparedUpdate>;
  };

  constructor(options: ApplicationUpdates["options"]) {
    this.options = options;
  }

  get installing() {
    return this.pending;
  }

  async check(): Promise<CliReply> {
    this.found = undefined;
    try {
      const result = await checkForUpdates(this.options.version());
      if (result.status === "available" && result.latest) {
        this.found = result.latest;
      }
      return { ok: true, data: { ...result, installation: this.options.supported() ? "windows-nsis" : "manual",
        manualUrl: result.latest?.url ?? releasesUrl } };
    } catch (error) {
      return cliFailure("UPDATE_CHECK_FAILED", (error as Error).message);
    }
  }

  async install(version: unknown, signal: AbortSignal): Promise<CliReply> {
    if (this.pending) {
      return cliFailure("UPDATE_IN_PROGRESS", "An update is already being prepared or installed.");
    }
    if (!this.options.supported()) {
      return cliFailure("UPDATE_MANUAL_REQUIRED",
        `Install the package for your OS and architecture from ${this.found?.url ?? releasesUrl}. Windows requires an installed NSIS client; source, unpacked, Linux and macOS installations update manually.`);
    }
    if (typeof version !== "string" || !this.found || version !== this.found.version) {
      return cliFailure("UPDATE_CHECK_REQUIRED", "Check for updates, then pass the exact found version.");
    }
    const candidate = this.found;
    if (this.options.busy()) {
      return cliFailure("UPDATE_APP_BUSY", "Wait for running work to finish, then retry. No work was interrupted.");
    }
    this.pending = true;
    try {
      signal.throwIfAborted();
      if (!await this.options.confirm(version, signal)) {
        return cliFailure("UPDATE_CANCELLED", "Update cancelled; the current version keeps running.");
      }
      signal.throwIfAborted();
      const prepared = await this.options.prepare(candidate, signal);
      try {
        signal.throwIfAborted();
        if (this.options.busy()) {
          return cliFailure("UPDATE_APP_BUSY", "The app became busy. Wait for running work to finish, then retry.");
        }
        this.prepared = prepared;
        return { ok: true, data: { status: "ready", version, message: "The verified update will install after this reply finishes, using normal application shutdown." } };
      } finally {
        if (!this.prepared) {
          await prepared.cancel();
        }
      }
    } catch (error) {
      return cliFailure(signal.aborted ? "UPDATE_CANCELLED" : "UPDATE_INSTALL_FAILED", (error as Error).message);
    } finally {
      if (!this.prepared) {
        this.pending = false;
      }
    }
  }

  async cancel() {
    const prepared = this.prepared;
    this.prepared = undefined;
    this.pending = false;
    await prepared?.cancel();
  }
}

async function download(url: string, limit: number, signal: AbortSignal, target?: string) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const file = target ? await open(target, "wx") : undefined;
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) {
        throw new Error("Release asset is too large.");
      }
      hash.update(chunk);
      if (file) {
        await file.writeFile(chunk);
      } else {
        chunks.push(Buffer.from(chunk));
      }
    }
  } finally {
    await file?.close();
  }
  return { digest: hash.digest("hex"), text: Buffer.concat(chunks).toString("utf8") };
}

export function manifestChecksum(manifest: string, name: string) {
  const matches: string[] = [];
  const lines = manifest.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64})  ([^\\/\r\n]+)$/.exec(line);
    if (!match) {
      throw new Error("Invalid SHA256SUMS manifest.");
    }
    if (match[2] === name) {
      matches.push(match[1].toLowerCase());
    }
  }
  if (matches.length !== 1) {
    throw new Error("The release manifest must identify exactly one matching installer.");
  }
  return matches[0];
}

export async function prepareWindowsUpdate(candidate: Candidate, signal: AbortSignal, options: {
  arch: string;
  executable: string;
  profile: string;
  args: string[];
  relaunch: (executable: string, args: string[]) => void;
}): Promise<PreparedUpdate> {
  if (!["x64", "arm64"].includes(options.arch)) {
    throw new Error("Unsupported Windows architecture.");
  }
  const directory = await mkdtemp(join(tmpdir(), "ai-taskboard-update-"));
  const cancel = () => rm(directory, { recursive: true, force: true, maxRetries: 5 });
  try {
    const name = `ai-taskboard-${candidate.version}-windows-${options.arch}.exe`;
    const base = `${releasesUrl}/download/${encodeURIComponent(candidate.tag)}/`;
    const manifest = await download(base + "SHA256SUMS", 1024 * 1024, signal);
    const digest = manifestChecksum(manifest.text, name);
    const installer = join(directory, name);
    const downloaded = await download(base + name, 1024 * 1024 * 1024, signal, installer);
    if (downloaded.digest !== digest) {
      throw new Error("Installer SHA-256 does not match the release manifest.");
    }
    const header = await open(installer, "r");
    try {
      const signature = Buffer.alloc(2);
      await header.read(signature, 0, 2, 0);
      if (signature.toString("ascii") !== "MZ") {
        throw new Error("The release asset is not a Windows installer.");
      }
    } finally {
      await header.close();
    }
    const script = join(directory, "install.ps1");
    await writeFile(script, await readFile(fileURLToPath(new URL("./update-runner.ps1", import.meta.url))));
    const config = join(directory, "update.json");
    await writeFile(config, JSON.stringify({ parentId: process.pid, installer, digest,
      executable: options.executable, installDirectory: dirname(options.executable),
      args: [...options.args, `--user-data-dir=${options.profile}`] }), "utf8");
    return { cancel, start: async () => {
      signal.throwIfAborted();
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      options.relaunch(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden", "-File", script, "-Config", config]);
    } };
  } catch (error) {
    await cancel();
    throw error;
  }
}
