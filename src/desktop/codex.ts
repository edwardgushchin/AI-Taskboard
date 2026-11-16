import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Task } from "../cli/model.ts";
import { taskIdPattern } from "../cli/model.ts";
import { directory, readJson, writeJson } from "../cli/storage.ts";
import { callCli, cliFailure } from "./cli.ts";
import { projectIdentity } from "./project-tabs.ts";

const run = promisify(execFile);

interface Launch {
  path: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface Client extends Launch {
  version: string;
  windowsSandbox?: WindowsSandbox;
}

type WindowsSandbox = "mxc" | "elevated";

export interface CodexStatus {
  state: "unavailable" | "ready" | "error";
  selectedPath?: string;
  clientPath?: string;
  clientVersion?: string;
  windowsSandbox?: WindowsSandbox;
  error?: string;
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(delimiter).map(path => path.replace(/^"(.*)"$/, "$1"))
    .filter(isAbsolute);
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function preferences(directory: string) {
  const path = join(directory, "codex.json");
  const value = existsSync(path) ? readJson(path) as { executable?: unknown; windowsSandbox?: unknown } : undefined;
  const executable = typeof value?.executable === "string" && isAbsolute(value.executable) ? value.executable : undefined;
  const windowsSandbox: WindowsSandbox = value?.windowsSandbox === "elevated" ? "elevated" : "mxc";
  return { executable, windowsSandbox: process.platform === "win32" ? windowsSandbox : undefined };
}

export function executorFullAccess(dataDirectory: string, project: string, task: Pick<Task, "id" | "createdAt">, enabled?: boolean): boolean {
  const file = join(dataDirectory, "executor-full-access.json");
  const value = existsSync(file) ? readJson(file) : [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw new Error("Invalid executor access settings.");
  }
  const selected = new Set<string>(value);
  const key = JSON.stringify([projectIdentity(project), task.id, task.createdAt]);
  if (enabled === undefined || enabled === selected.has(key)) return selected.has(key);
  if (enabled) selected.add(key);
  else selected.delete(key);
  directory(dataDirectory, true);
  writeJson(file, [...selected]);
  return enabled;
}

export async function setTaskExecutorAccess(dataDirectory: string, project: string, args: unknown, signal?: AbortSignal) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some(key => !["id", "revision", "fullAccess"].includes(key))) {
    return cliFailure("INVALID_INPUT", "Use id, revision and fullAccess.");
  }
  const { id, revision, fullAccess } = args as Record<string, unknown>;
  if (typeof id !== "string" || !taskIdPattern.test(id) || typeof revision !== "number" ||
      !Number.isSafeInteger(revision) || revision < 1 || typeof fullAccess !== "boolean") {
    return cliFailure("INVALID_INPUT", "Choose a task, its current revision and an executor access mode.");
  }
  const current = await callCli<Task>(project, ["show", id, "--compact"]);
  if (!current.ok) return current;
  if (current.data.revision !== revision) return cliFailure("REVISION_CONFLICT", "Read the current revision before changing access.");
  if (["done", "cancelled"].includes(current.data.status)) return cliFailure("INVALID_TRANSITION", "Choose an open task.");
  signal?.throwIfAborted();
  executorFullAccess(dataDirectory, project, current.data, fullAccess);
  return { ok: true as const, data: { id, revision, fullAccess, appliesOn: "next-run" } };
}

export function setCodexExecutable(dataDirectory: string, path?: string): void {
  if (path && (!isAbsolute(path) || !isFile(path) || (process.platform === "win32" && !/\.exe$/i.test(path)))) {
    throw new Error("Select the Codex executable.");
  }
  directory(dataDirectory, true);
  writeJson(join(dataDirectory, "codex.json"), { ...preferences(dataDirectory), executable: path });
  configuredClients.delete(dataDirectory);
}

export function setCodexWindowsSandbox(dataDirectory: string, value: unknown): void {
  if (process.platform !== "win32" || (value !== "mxc" && value !== "elevated")) {
    throw new Error("Select MXC or Elevated for the Windows sandbox.");
  }
  directory(dataDirectory, true);
  writeJson(join(dataDirectory, "codex.json"), { ...preferences(dataDirectory), windowsSandbox: value });
  configuredClients.delete(dataDirectory);
}

async function windowsDesktopClients(): Promise<Launch[]> {
  try {
    const { stdout } = await run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); " +
      "Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }",
    ], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(isAbsolute)
      .map(path => ({ path: join(path, "app", "resources", "codex.exe"), args: [] }));
  } catch {
    return [];
  }
}

function windowsNpmClient(root: string): Launch[] {
  const packageRoot = join(root, "node_modules", "@openai", "codex");
  const entry = join(packageRoot, "bin", "codex.js");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  let vendor = join(packageRoot, "vendor");
  try {
    const manifest = createRequire(entry).resolve("@openai/codex-win32-" + arch + "/package.json");
    vendor = join(dirname(manifest), "vendor");
  } catch {
    // Older npm releases shipped their native binaries in the main package.
  }
  // The npm shim spawns a console executable without windowsHide.
  const path = join(vendor, triple, "bin", "codex.exe");
  return isFile(path) ? [{
    path, args: [], env: { ...process.env, CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: packageRoot },
  }] : [];
}

function candidates(): Launch[] {
  const path = pathEntries();
  if (process.platform === "win32") {
    return [
      ...path.map(root => ({ path: join(root, "codex.exe"), args: [] })),
      ...path.filter(root => isFile(join(root, "codex.cmd"))).flatMap(windowsNpmClient),
    ];
  }
  const home = homedir();
  const dirs = [...path, join(home, ".local", "bin"), join(home, ".cargo", "bin"), "/usr/local/bin"];
  const found: Launch[] = dirs.map(root => ({ path: join(root, "codex"), args: [] }));
  if (process.platform === "darwin") {
    found.push({ path: "/opt/homebrew/bin/codex", args: [] });
    for (const applications of ["/Applications", join(home, "Applications")]) {
      for (const name of ["Codex.app", "ChatGPT.app"]) {
        found.push({ path: join(applications, name, "Contents", "Resources", "codex"), args: [] });
      }
    }
  }
  return found;
}

async function invoke(client: Launch, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run(client.path, [...client.args, ...args], {
      cwd, env: client.env, encoding: "utf8", timeout: 20000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim().slice(0, 1500) || failure.message);
  }
}

async function findClient(dataDirectory: string, selectedPath?: string, windowsSandbox?: WindowsSandbox): Promise<Client | undefined> {
  const probe = async (choices: Launch[]) => {
    const checked = new Set<string>();
    for (const choice of choices) {
      const key = choice.path + "\0" + choice.args.join("\0");
      if (checked.has(key) || !isFile(choice.path)) continue;
      checked.add(key);
      try {
        const version = /^codex-cli (\S+)/m.exec(await invoke(choice, ["--version"], dataDirectory))?.[1];
        if (!version) continue;
        await invoke(choice, ["app-server", "--help"], dataDirectory);
        return { ...choice, version, windowsSandbox };
      } catch {
        // A stale wrapper or old binary should not hide a working installation.
      }
    }
    return undefined;
  };
  if (selectedPath) return probe([{ path: selectedPath, args: [] }]);
  return await probe(candidates()) ?? (process.platform === "win32" ? await probe(await windowsDesktopClients()) : undefined);
}

const configuredClients = new Map<string, { selected?: string; windowsSandbox?: WindowsSandbox; expires: number; client: Promise<Client | undefined> }>();

export function configuredCodex(dataDirectory: string) {
  const { executable: selected, windowsSandbox } = preferences(dataDirectory);
  const cached = configuredClients.get(dataDirectory);
  if (cached && cached.selected === selected && cached.windowsSandbox === windowsSandbox && cached.expires > Date.now()) return cached.client;
  const client = findClient(dataDirectory, selected, windowsSandbox);
  const entry = { selected, windowsSandbox, expires: Date.now() + 60_000, client };
  configuredClients.set(dataDirectory, entry);
  const forget = () => { if (configuredClients.get(dataDirectory) === entry) configuredClients.delete(dataDirectory); };
  void client.then(found => { if (!found) forget(); }, forget);
  return client;
}

export async function codexStatus(dataDirectory: string): Promise<CodexStatus> {
  let selectedPath: string | undefined;
  let windowsSandbox: WindowsSandbox | undefined;
  try {
    ({ executable: selectedPath, windowsSandbox } = preferences(dataDirectory));
    const client = await findClient(dataDirectory, selectedPath, windowsSandbox);
    return client
      ? { state: "ready", selectedPath, clientPath: client.path, clientVersion: client.version, windowsSandbox }
      : { state: "unavailable", selectedPath, windowsSandbox };
  } catch (error) {
    return { state: "error", selectedPath, windowsSandbox, error: (error as Error).message };
  }
}

export function taskboardCliLaunch(native: string, entry: string): string[] {
  if (isFile(native)) return [native];
  const node = process.platform === "win32" ? "node.exe" : "node";
  const developerNode = [process.env.npm_node_execpath, ...pathEntries().map(root => join(root, node))]
    .find((path): path is string => Boolean(path && isAbsolute(path) && isFile(path)));
  return developerNode ? [developerNode, "--disable-warning=ExperimentalWarning", entry] : [];
}
