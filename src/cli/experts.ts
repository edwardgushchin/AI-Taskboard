import { constants, copyFileSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import { isSea } from "node:sea";
import { object, number, strings, text, TaskboardError } from "./model.ts";
import { directory, exists, readJson, writeJson, writeAtomic } from "./storage.ts";
import type { BoardStore } from "./storage.ts";

export interface ExpertSkill { id: string; name: string; content?: string; library?: string }
export interface Expert {
  version: 1; id: string; name: string; group: string; enabled: boolean; revision: number;
  prompt: string; skills: ExpertSkill[]; requirements: string[]; limitations: string;
}
const identifier = /^[a-z0-9][a-z0-9-]{0,239}$/;
function id(value: unknown) {
  const result = text(value, "expert or skill ID", true);
  if (!identifier.test(result)) throw new TaskboardError("INVALID_INPUT", "Use a lowercase expert ID without paths.");
  return result;
}
export function expertAssets() {
  return isSea() ? join(dirname(process.execPath), "experts") : fileURLToPath(new URL("../experts/", import.meta.url));
}
function root(store: BoardStore) { const path = join(store.location.directory, "experts"); directory(path, true); return path; }
function folder(store: BoardStore, key: string) {
  const path = join(root(store), id(key));
  directory(path, true);
  return path;
}
function validate(value: unknown): Expert {
  const data = object(value);
  if (data.version !== 1 || typeof data.enabled !== "boolean" || !Array.isArray(data.skills) || data.skills.length > 32)
    throw new TaskboardError("INVALID_INPUT", "Expected an expert v1 package with at most 32 skills.");
  const skills = data.skills.map(value => {
    const skill = object(value);
    if ((typeof skill.content === "string") === (typeof skill.library === "string"))
      throw new TaskboardError("INVALID_INPUT", "Each skill needs content or a bundled library reference.");
    return { id: id(skill.id), name: text(skill.name, "skill name", true),
      ...(skill.library ? { library: id(skill.library) } : { content: text(skill.content, "skill content", true) }) };
  });
  if (new Set(skills.map(s => s.id)).size !== skills.length) throw new TaskboardError("INVALID_INPUT", "Skill IDs must be unique.");
  const result: Expert = { version: 1, id: id(data.id), name: text(data.name, "expert name", true),
    group: text(data.group, "group", true), enabled: data.enabled, revision: number(data.revision, "revision"),
    prompt: text(data.prompt, "system prompt", true), skills,
    requirements: strings(data.requirements ?? [], "requirements"), limitations: text(data.limitations ?? "", "limitations") };
  if (Buffer.byteLength(JSON.stringify(result)) > 512_000) throw new TaskboardError("INVALID_INPUT", "Expert package exceeds 512 KB.");
  return result;
}
export function ensureExperts(store: BoardStore) {
  const assets = expertAssets();
  const catalog = readJson(join(assets, "catalog.json")) as string[];
  for (const key of catalog) {
    const path = join(folder(store, key), "expert.json");
    if (exists(path)) continue;
    const source = join(assets, "builtin", key);
    const manifest = readJson(join(source, "expert.json")) as Record<string, unknown> & { skills: { file?: string }[] };
    writeJson(path, validate({ ...manifest, prompt: readFileSync(join(source, "system.md"), "utf8"),
      skills: manifest.skills.map(skill => skill.file ? { ...skill, content: readFileSync(join(source, skill.file), "utf8") } : skill) }));
  }
}
export function listExperts(store: BoardStore, query = "") {
  ensureExperts(store);
  const needle = query.toLocaleLowerCase();
  return readdirSync(root(store)).filter(key => identifier.test(key)).flatMap(key => {
    const path = join(folder(store, key), "expert.json");
    if (!exists(path)) return [];
    const expert = validate(readJson(path));
    return (expert.id + " " + expert.name + " " + expert.group).toLocaleLowerCase().includes(needle)
      ? [{ id: expert.id, name: expert.name, group: expert.group, enabled: expert.enabled, revision: expert.revision,
        skills: expert.skills.map(({ id, name, library }) => ({ id, name, ...(library ? { library } : {}) })) }] : [];
  });
}
export function readExpert(store: BoardStore, key: string, enabled = true): Expert {
  ensureExperts(store);
  const path = join(folder(store, key), "expert.json");
  if (!exists(path)) throw new TaskboardError("EXPERT_NOT_FOUND", "Unknown expert: " + key);
  const expert = validate(readJson(path));
  if (expert.id !== key) throw new TaskboardError("CORRUPT_STORAGE", "Expert ID differs from its directory.");
  if (enabled && !expert.enabled) throw new TaskboardError("EXPERT_DISABLED", "Expert is disabled: " + key);
  return expert;
}
export function saveExpert(store: BoardStore, input: Record<string, unknown>) {
  ensureExperts(store);
  const expert = validate({ ...input, version: 1, revision: input.revision ?? 1 });
  const path = join(folder(store, expert.id), "expert.json");
  if (exists(path)) {
    const previous = readExpert(store, expert.id, false);
    if (input.revision !== previous.revision) throw new TaskboardError("REVISION_CONFLICT", "The expert changed. Reload it.");
    expert.revision = previous.revision + 1;
  } else if (input.revision !== undefined) throw new TaskboardError("REVISION_CONFLICT", "The expert no longer exists.");
  const library = readJson(join(expertAssets(), "library.json")) as Record<string, unknown>;
  for (const skill of expert.skills) if (skill.library && !Object.hasOwn(library, skill.library))
    throw new TaskboardError("INVALID_INPUT", "Unknown bundled skill: " + skill.library);
  // The board lock covers both writes. Publish the version first so a failed
  // index write cannot leave a changed profile behind an old version.
  store.index.expertCatalogVersion = randomUUID();
  store.saveIndex();
  writeJson(path, expert);
  return expert;
}
function safeTree(path: string) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new TaskboardError("INVALID_STORAGE_PATH", "Expert assets cannot contain links.");
  if (entry.isDirectory()) for (const child of readdirSync(path)) safeTree(join(path, child));
  else if (!entry.isFile()) throw new TaskboardError("INVALID_STORAGE_PATH", "Expected regular expert assets.");
}
function copyPackage(source: string, destination: string) {
  directory(destination, true);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new TaskboardError("INVALID_STORAGE_PATH", "Expert assets cannot contain links.");
    if (entry.isDirectory()) copyPackage(from, to);
    else if (entry.isFile() && !exists(to)) copyFileSync(toNamespacedPath(from), toNamespacedPath(to), constants.COPYFILE_EXCL);
  }
}
export function expertSkill(store: BoardStore, expertId: string, skillId: string) {
  const expert = readExpert(store, expertId);
  const skill = expert.skills.find(s => s.id === id(skillId));
  if (!skill) throw new TaskboardError("SKILL_NOT_FOUND", "Skill is not part of this expert.");
  const destination = join(folder(store, expertId), "skills"); directory(destination, true);
  let path = join(destination, skill.id);
  let sourceUrl: string | undefined;
  let pluginRoot: string | undefined;
  if (skill.library) {
    const library = readJson(join(expertAssets(), "library.json")) as Record<string, { repo: string; path: string; commit: string; url: string }>;
    const source = library[skill.library];
    if (!source) throw new TaskboardError("SKILL_NOT_FOUND", "Bundled skill is unavailable.");
    const repository = join(expertAssets(), "library", source.repo.toLowerCase().replaceAll("/", "--"));
    const sourcePath = join(repository, dirname(source.path));
    const child = relative(realpathSync(repository), realpathSync(sourcePath));
    if (child.startsWith(".." + sep) || child === ".." || resolve(repository, child) !== realpathSync(sourcePath))
      throw new TaskboardError("INVALID_STORAGE_PATH", "Skill escapes its package.");
    const cache = join(destination, ".library"); directory(cache, true);
    const packagePath = join(cache, source.repo.toLowerCase().replaceAll("/", "--") + "-" + source.commit);
    directory(packagePath, true); safeTree(packagePath);
    const main = join(packagePath, source.path);
    if (!exists(join(packagePath, ".ready")) || !exists(main)) {
      // Node 24 SEA cpSync silently skips this tree for some Unicode Windows destinations.
      copyPackage(repository, packagePath);
      if (!exists(main)) throw new TaskboardError("SKILL_NOT_FOUND", "The skill package copy is incomplete.");
      writeAtomic(join(packagePath, ".ready"), source.commit);
    }
    path = join(packagePath, dirname(source.path)); sourceUrl = source.url;
    const skillsRoot = source.path.indexOf("/skills/");
    if (skillsRoot >= 0) pluginRoot = join(packagePath, source.path.slice(0, skillsRoot));
  } else { directory(path, true); writeAtomic(join(path, "SKILL.md"), skill.content! + "\n"); }
  let content = readFileSync(join(path, "SKILL.md"), "utf8");
  if (sourceUrl) {
    content = content.replaceAll("{baseDir}", path.replaceAll("\\", "/")).replaceAll("%7BbaseDir%7D", path.replaceAll("\\", "/"));
    if (pluginRoot) content = content.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot.replaceAll("\\", "/"));
    // References to other upstream modules remain source links, not missing local files.
    content = content.replace(/\]\(([^\s)]+)\)/g, (match, target: string) => {
      if (/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(target)) return match;
      const local = target.split("#")[0];
      return exists(resolve(path, decodeURIComponent(local))) ? match : "](" + new URL(target, sourceUrl).href + ")";
    });
  }
  return { expertId, skillId, name: skill.name, directory: path, sourceUrl,
    content: "Board skill context: board instructions and lifecycle take precedence. Upstream provider plugins, slash commands, hooks and external integrations are not installed. Use only the tools available in this task.\n\n" + content };
}
export function expertContext(store: BoardStore, keys: string[]) {
  if (!keys.length || keys.length > 6) throw new TaskboardError("INVALID_INPUT", "Choose between one and six specializations for this phase.");
  return keys.map(key => readExpert(store, key));
}
