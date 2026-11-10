import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { directory, readJson, writeAtomic, writeJson } from "../cli/storage.ts";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../../codex/marketplace/", import.meta.url));
const marketplaceName = "ai-taskboard-plugins";
const pluginName = "ai-taskboard";
const pluginId = pluginName + "@" + marketplaceName;
const manifestFile = ".codex-plugin/plugin.json";
const skills = ["create-task", "work-task", "update-task", "task-writing"];
const marker = "__AI_TASKBOARD_CLI__";

interface Launch {
  path: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface Client extends Launch {
  version: string;
}

export interface CodexStatus {
  state: "unavailable" | "ready" | "installed" | "disabled" | "conflict" | "error";
  selectedPath?: string;
  clientPath?: string;
  clientVersion?: string;
  pluginVersion?: string;
  error?: string;
}

interface MarketplaceReply {
  marketplaces: { name: string; root: string }[];
}

interface PluginReply {
  installed: {
    pluginId: string; version: string; enabled: boolean;
    source?: { source: string; path?: string };
  }[];
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(delimiter).map(path => path.replace(/^"(.*)"$/, "$1"))
    .filter(isAbsolute);
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function preference(directory: string): string | undefined {
  const path = join(directory, "codex.json");
  if (!existsSync(path)) return undefined;
  const value = readJson(path) as { executable?: unknown };
  return typeof value?.executable === "string" && isAbsolute(value.executable) ? value.executable : undefined;
}

export function setCodexExecutable(dataDirectory: string, path?: string): void {
  if (path && (!isAbsolute(path) || !isFile(path) || (process.platform === "win32" && !/\.exe$/i.test(path)))) {
    throw new Error("Select the Codex executable.");
  }
  directory(dataDirectory, true);
  writeJson(join(dataDirectory, "codex.json"), { executable: path });
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

function candidates(): Launch[] {
  const path = pathEntries();
  if (process.platform === "win32") {
    return [
      ...path.map(root => ({ path: join(root, "codex.exe"), args: [] })),
      ...path.filter(root => isFile(join(root, "codex.cmd"))).map(root => ({
        path: process.execPath,
        args: [join(root, "node_modules", "@openai", "codex", "bin", "codex.js")],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      })).filter(candidate => isFile(candidate.args[0])),
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
      cwd, env: client.env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim().slice(0, 1500) || failure.message);
  }
}

async function findClient(dataDirectory: string, selectedPath?: string): Promise<Client | undefined> {
  const probe = async (choices: Launch[]) => {
    const checked = new Set<string>();
    for (const choice of choices) {
      const key = choice.path + "\0" + choice.args.join("\0");
      if (checked.has(key) || !isFile(choice.path)) continue;
      checked.add(key);
      try {
        const version = /^codex-cli (\S+)/m.exec(await invoke(choice, ["--version"], dataDirectory))?.[1];
        if (!version) continue;
        await invoke(choice, ["plugin", "marketplace", "list", "--help"], dataDirectory);
        await invoke(choice, ["plugin", "add", "--help"], dataDirectory);
        return { ...choice, version };
      } catch {
        // A stale wrapper or old binary should not hide a working installation.
      }
    }
    return undefined;
  };
  if (selectedPath) return probe([{ path: selectedPath, args: [] }]);
  return await probe(candidates()) ?? (process.platform === "win32" ? await probe(await windowsDesktopClients()) : undefined);
}

function comparable(path: string): string {
  const stripped = process.platform === "win32" ? path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "") : path;
  let result = normalize(stripped);
  try { result = realpathSync(result); } catch {}
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function marketRoot(dataDirectory: string): string {
  return join(dataDirectory, "codex-marketplace");
}

async function marketplace(client: Client, dataDirectory: string) {
  const reply = JSON.parse(await invoke(client, ["plugin", "marketplace", "list", "--json"], dataDirectory)) as MarketplaceReply;
  if (!Array.isArray(reply.marketplaces)) throw new Error("Codex returned an unreadable marketplace list.");
  return reply.marketplaces.find(entry => entry.name === marketplaceName);
}

async function status(client: Client, dataDirectory: string, selectedPath?: string): Promise<CodexStatus> {
  const base = { selectedPath, clientPath: client.args[0] ?? client.path, clientVersion: client.version };
  const existing = await marketplace(client, dataDirectory);
  if (existing && comparable(existing.root) !== comparable(marketRoot(dataDirectory))) {
    return { ...base, state: "conflict", error: "Another marketplace already uses the AI Taskboard name." };
  }
  if (!existing) return { ...base, state: "ready" };
  const reply = JSON.parse(await invoke(client, ["plugin", "list", "--marketplace", marketplaceName, "--json"], dataDirectory)) as PluginReply;
  if (!Array.isArray(reply.installed)) throw new Error("Codex returned an unreadable plugin list.");
  const plugin = reply.installed.find(entry => entry.pluginId === pluginId);
  if (!plugin) return { ...base, state: "ready" };
  if (!plugin.source?.path ||
      comparable(plugin.source.path) !== comparable(join(marketRoot(dataDirectory), "plugins", pluginName))) {
    return { ...base, state: "conflict", error: "The installed AI Taskboard plugin has a different source." };
  }
  return { ...base, state: plugin.enabled ? "installed" : "disabled", pluginVersion: plugin.version };
}

export async function codexStatus(dataDirectory: string): Promise<CodexStatus> {
  let selectedPath: string | undefined;
  try {
    selectedPath = preference(dataDirectory);
    const client = await findClient(dataDirectory, selectedPath);
    return client ? await status(client, dataDirectory, selectedPath) : { state: "unavailable", selectedPath };
  } catch (error) {
    return { state: "error", selectedPath, error: (error as Error).message };
  }
}

function prepareMarketplace(dataDirectory: string, launch: string[], version: string): void {
  const target = marketRoot(dataDirectory);
  directory(target, true);
  for (const relative of [".agents", ".agents/plugins", "plugins", "plugins/" + pluginName]) {
    directory(join(target, relative), true);
  }
  writeAtomic(join(target, ".agents/plugins/marketplace.json"), readFileSync(join(source, ".agents/plugins/marketplace.json")));
  const root = join("plugins", pluginName);
  const plugin = join(target, root);
  directory(join(plugin, ".codex-plugin"), true);
  const manifest = JSON.parse(readFileSync(join(source, root, manifestFile), "utf8"));
  writeJson(join(plugin, manifestFile), { ...manifest, version });
  directory(join(plugin, "skills"), true);
  for (const skill of skills) {
    const relative = join("skills", skill);
    directory(join(plugin, relative), true);
    const markdown = readFileSync(join(source, root, relative, "SKILL.md"), "utf8");
    writeAtomic(join(plugin, relative, "SKILL.md"), markdown.replace(marker, JSON.stringify(launch)));
  }
}

export async function installCodex(dataDirectory: string, launch: string[], version: string): Promise<CodexStatus> {
  let selectedPath: string | undefined;
  let current: CodexStatus | undefined;
  try {
    mkdirSync(dataDirectory, { recursive: true });
    selectedPath = preference(dataDirectory);
    const client = await findClient(dataDirectory, selectedPath);
    if (!client) return { state: "unavailable", selectedPath };
    current = await status(client, dataDirectory, selectedPath);
    if (current.state === "conflict") return current;
    if (!launch.length || !isFile(launch[0])) throw new Error("The AI Taskboard CLI is unavailable.");
    const versionReply = JSON.parse(await invoke({ path: launch[0], args: launch.slice(1) }, ["--version", "--json"], dataDirectory));
    if (versionReply.ok !== true || versionReply.data?.version !== version) {
      throw new Error("The AI Taskboard CLI does not match the app version.");
    }
    prepareMarketplace(dataDirectory, launch, version);
    const registered = await marketplace(client, dataDirectory);
    if (registered && comparable(registered.root) !== comparable(marketRoot(dataDirectory))) {
      return { ...current, state: "conflict", error: "Another marketplace already uses the AI Taskboard name." };
    }
    if (!registered) {
      await invoke(client, ["plugin", "marketplace", "add", marketRoot(dataDirectory), "--json"], dataDirectory);
    }
    await invoke(client, ["plugin", "add", pluginId, "--json"], dataDirectory);
    const installed = await status(client, dataDirectory, selectedPath);
    if (installed.state !== "installed" || installed.pluginVersion !== version) {
      throw new Error("Codex did not confirm that AI Taskboard is installed and enabled.");
    }
    return installed;
  } catch (error) {
    return { ...current, state: "error", selectedPath, error: (error as Error).message };
  }
}

export function skillLaunch(native: string, entry: string): string[] {
  if (isFile(native)) return [native];
  const node = process.platform === "win32" ? "node.exe" : "node";
  const developerNode = [process.env.npm_node_execpath, ...pathEntries().map(root => join(root, node))]
    .find((path): path is string => Boolean(path && isAbsolute(path) && isFile(path)));
  return developerNode ? [developerNode, "--disable-warning=ExperimentalWarning", entry] : [];
}
