import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import { TaskboardError } from "./model.ts";
import { directory, exists, readBinary, readJson, sha256, writeAtomic, writeJson } from "./storage.ts";

const workflow = `## AI Taskboard workflow

Use the board tools supplied for your role. Read the current card, its criteria and messages before acting. When using the CLI supplied by the board, pass \`--project\` with the board root. Use the board tools or CLI for card updates and keep work in the working directory assigned to the card.

- **Manager:** use the board tools to draft, approve and start cards. Apply the current review mode and respect human decisions and required independent review before acceptance.
- **Executor:** verify the criteria in the assigned copy. Record checkpoints with \`progress\` and concrete blockers with \`block\` (or the equivalent \`task_record_result\` actions). Submit from a reviewed \`preview\` using its token and report checks and limitations. For recurring work, record the scheduled result with \`progress\`.
- **Reviewer:** inspect the submission and evidence against the card. Report approval or actionable findings through the review result. Acceptance follows the board's current review mode.
`;

const sections = {
  workflow: { start: "<!-- ai-taskboard:workflow:start -->", end: "<!-- ai-taskboard:workflow:end -->" },
  rules: { start: "<!-- ai-taskboard:project-rules:start -->", end: "<!-- ai-taskboard:project-rules:end -->" },
};
const rulesHeading = "## Project rules";
const markdown = new MarkdownIt({ html: true });
const rulesVersion = /^<!-- ai-taskboard:rules-version:([a-f0-9]{64}) -->$/m;
type ProjectRule = { text: string; enabled: boolean; separator?: string };
type ProjectRulesInput = { text?: unknown; rules?: unknown; revision: unknown };

function section(source: string, markers: typeof sections.rules) {
  const code = markdown.parse(source, {}).filter(token => token.type === "fence" || token.type === "code_block");
  const allLines = [...source.matchAll(/(?:^|(?<=\n))[^\r\n]*/g)];
  const lines = allLines.filter((_, index) =>
    !code.some(token => token.map && index >= token.map[0] && index < token.map[1]));
  const starts = lines.filter(line => line[0] === markers.start ||
    (line.index === 0 && line[0] === "\uFEFF" + markers.start));
  const ends = lines.filter(line => line[0] === markers.end);
  // An unfinished Markdown fence can extend to the end of the file. Keep its
  // original text and recognize the final marker of the managed rules envelope.
  const last = allLines.findLast(line => line[0].trim());
  if (markers === sections.rules && starts.length === 1 && ends.length === 0 && last?.[0] === markers.end) {
    ends.push(last);
  }
  if (!starts.length && !ends.length) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "Check the AI Taskboard section markers in AGENTS.md.");
  }
  const start = starts[0].index + Number(starts[0][0].startsWith("\uFEFF"));
  return { start, end: ends[0].index + markers.end.length,
    content: source.slice(start + markers.start.length, ends[0].index) };
}

function rulesRevision(path: string, bytes: Buffer, link?: string) {
  return sha256(Buffer.concat([Buffer.from(path + "\0" + (link ?? "") + "\0"), bytes]));
}

function load(root: string) {
  const entry = join(root, "AGENTS.md");
  const info = lstatSync(entry, { throwIfNoEntry: false });
  if (!info) return { entry, path: entry, source: "", revision: "missing" };

  const link = info.isSymbolicLink() ? readlinkSync(entry) : undefined;
  const path = link === undefined ? entry : realpathSync(entry);
  const bytes = readBinary(path);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { entry, path, link, source, revision: rulesRevision(path, bytes, link) };
}

function readRules(source: string) {
  const block = section(source, sections.rules);
  if (!block) return null;
  const content = block.content.replace(/\r\n?/g, "\n");
  if (content === "\n" + rulesHeading + "\n") return "";
  const prefix = "\n" + rulesHeading + "\n\n";
  if (!content.startsWith(prefix)) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "Check the project rules heading in AGENTS.md.");
  }
  return content.slice(prefix.length, -1);
}

function normalize(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

function splitRules(text: string): ProjectRule[] {
  if (!text.trim()) return [];
  const env: Parameters<typeof markdown.parse>[1] = {};
  const tokens = markdown.parse(text, env);
  const lines = text.split("\n");
  const starts = new Set([0]);
  if (!env.references) {
    const blocks = tokens.filter(token => token.level === 0 && token.map);
    const first = blocks[0];
    if (first?.type === "heading_open") {
      for (const heading of blocks.filter(token => token.type === "heading_open" && token.tag === first.tag)) {
        if (heading.map) starts.add(heading.map[0]);
      }
    } else if (blocks.length === 1 && (first.type === "bullet_list_open" || first.type === "ordered_list_open")) {
      for (const item of tokens.filter(token => token.type === "list_item_open" && token.level === 1)) {
        if (item.map) starts.add(item.map[0]);
      }
    }
  }
  const boundaries = [...starts].sort((a, b) => a - b);
  return boundaries.map((start, index) => ({
    text: lines.slice(start, boundaries[index + 1]).join("\n"),
    enabled: true,
    separator: "\n",
  })).filter(rule => rule.text.trim());
}

function enabledText(rules: ProjectRule[]) {
  return rules.filter(rule => rule.enabled).map((rule, index) =>
    (index ? rule.separator ?? "\n\n" : "") + rule.text).join("");
}

function versionOf(source: string) {
  return section(source, sections.workflow)?.content.match(rulesVersion)?.[1];
}

function rulesStorage(root: string) {
  return join(root, ".tasks", "project-rules.json");
}

function savedRules(root: string, source: string, text: string) {
  const version = versionOf(source);
  const path = rulesStorage(root);
  if (!version || !exists(path)) return splitRules(text);
  directory(join(root, ".tasks"));
  const rules = (readJson(path) as Record<string, ProjectRule[]>)[version];
  if (!rules) return splitRules(text);
  if (enabledText(rules) === text) return rules;
  return [...splitRules(text), ...rules.filter(rule => !rule.enabled)];
}

function rulesState(root: string, { source, revision }: ReturnType<typeof load>) {
  const text = readRules(source) ?? "";
  return { text, revision, rules: savedRules(root, source, text) };
}

export function readBoardProjectRules(root: string) {
  return rulesState(root, load(root));
}

function rulesConflict(root: string, latest: ReturnType<typeof load>) {
  return new TaskboardError("PROJECT_RULES_CONFLICT", "AGENTS.md changed since these rules were opened.",
    rulesState(root, latest));
}

/** The canonical rules take precedence over an older managed section in a worktree. */
export function boardProjectRulesPrompt(root: string) {
  const rules = readRules(load(root).source);
  if (rules === null) return "";
  return "Current board-managed project rules from the board root AGENTS.md. " +
    "Use these in place of any older AI Taskboard project rules in the working copy. " +
    "Apply them within the permissions and scope of your assigned role.\n" +
    (rules || "(The board-managed project rules are empty.)") + "\n\n";
}

/** Call under the project rules lock to serialize saves across windows and processes. */
export function writeBoardProjectRules(root: string, input?: ProjectRulesInput) {
  const current = load(root);
  if (input === undefined) {
    return writeRules(root, current, splitRules(readRules(current.source) ?? ""), false, false, false);
  }
  if (input.revision !== current.revision) throw rulesConflict(root, current);
  let rules: ProjectRule[];
  if (Array.isArray(input.rules)) {
    rules = input.rules.map(rule => {
      if (typeof rule?.text !== "string" || !rule.text.trim() || typeof rule.enabled !== "boolean" ||
          (rule.separator !== undefined && rule.separator !== "\n")) {
        throw new TaskboardError("INVALID_INPUT", "Each project rule needs Markdown text and an enabled state.");
      }
      const entry: ProjectRule = { text: normalize(rule.text), enabled: rule.enabled };
      if (rule.separator !== undefined) entry.separator = rule.separator;
      return entry;
    });
  } else if (input.rules === undefined && typeof input.text === "string") {
    rules = splitRules(normalize(input.text));
  } else {
    throw new TaskboardError("INVALID_INPUT", "Project rules must contain Markdown entries.");
  }
  return writeRules(root, current, rules, false, false, Array.isArray(input.rules) || !current.link);
}

/** Call under the same project rules lock as settings saves. */
export function migrateBoardProjectRules(root: string, detachLink = true) {
  const current = load(root);
  const { source, link } = current;
  const managed = readRules(source) ?? "";
  const rules = savedRules(root, source, managed);
  const existingRules = section(source, sections.rules);
  const blocks = [section(source, sections.workflow), existingRules]
    .filter(block => block !== undefined).sort((a, b) => a.start - b.start);
  if (link && !detachLink) {
    const result = blocks.length === 2 ? rulesState(root, current) :
      writeRules(root, current, rules, false, false, false);
    return { ...result, imported: 0, changed: result.revision !== current.revision };
  }
  const combined: ProjectRule[] = [];
  let imported = 0;
  const appendManual = (fragment: string) => {
    const normalized = normalize(fragment).replace(/^\uFEFF/, "");
    const entries = splitRules(blocks.length ? normalized.replace(/^\n+|\n+$/g, "") : normalized);
    if (entries.length && combined.length) delete entries[0].separator;
    combined.push(...entries);
    imported += entries.length;
  };
  let offset = 0;
  for (const block of blocks) {
    appendManual(source.slice(offset, block.start));
    if (block.start === existingRules?.start) {
      if (combined.length && rules.length) {
        const [first, ...rest] = rules;
        combined.push({ text: first.text, enabled: first.enabled }, ...rest);
      } else {
        combined.push(...rules);
      }
    }
    offset = block.end;
  }
  appendManual(source.slice(offset));
  const result = writeRules(root, current, combined, true, detachLink, true);
  return { ...result, imported, changed: result.revision !== current.revision };
}

function writeRules(root: string, current: ReturnType<typeof load>, rules: ProjectRule[],
  migrate: boolean, detachLink: boolean, persistList: boolean) {
  const { entry, path, link, source, revision } = current;
  const workflowBlock = section(source, sections.workflow);
  const rulesBlock = section(source, sections.rules);
  if (workflowBlock && rulesBlock && workflowBlock.start < rulesBlock.end && rulesBlock.start < workflowBlock.end) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "AI Taskboard sections in AGENTS.md must be separate.");
  }
  const text = enabledText(rules);
  if (Object.values(sections).some(markers => section(text, markers))) {
    throw new TaskboardError("INVALID_INPUT", "Project rules cannot contain AI Taskboard section markers on their own lines.");
  }
  const version = persistList && rules.length ? sha256(Buffer.from(JSON.stringify(rules))) : undefined;
  const previousVersion = versionOf(source);
  const newline = source.match(/\r\n|\n/)?.[0] ?? "\n";
  let updated = migrate ? "" : source;
  for (const [markers, content] of [
    [sections.workflow, workflow.trimEnd() + (version ? "\n<!-- ai-taskboard:rules-version:" + version + " -->" : "")],
    [sections.rules, text ? rulesHeading + "\n\n" + text : rulesHeading],
  ] as const) {
    const current = section(updated, markers);
    const block = [markers.start, content, markers.end].join("\n").replaceAll("\n", newline);
    if (current) {
      updated = updated.slice(0, current.start) + block + updated.slice(current.end);
    } else {
      const separator = updated ? (updated.endsWith(newline) ? newline : newline + newline) : "";
      updated += separator + block + newline;
    }
  }
  if (migrate && source.startsWith("\uFEFF")) updated = "\uFEFF" + updated;
  if (readRules(updated) !== text) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "The project rules could not be serialized to AGENTS.md.");
  }
  if (updated === source && !(link && detachLink)) return { text, revision, rules };

  if (version && version !== previousVersion) {
    const storage = rulesStorage(root);
    directory(join(root, ".tasks"), true);
    const previous = previousVersion && exists(storage)
      ? (readJson(storage) as Record<string, ProjectRule[]>)[previousVersion] : undefined;
    // Keep the published version readable if replacing AGENTS.md fails or is interrupted.
    writeJson(storage, { ...(previous && previousVersion ? { [previousVersion]: previous } : {}), [version]: rules });
  }

  const bytes = Buffer.from(updated);
  const destination = detachLink ? entry : path;
  writeAtomic(destination, bytes, () => {
    const latest = load(root);
    if (latest.revision !== revision) {
      throw rulesConflict(root, latest);
    }
  }, !!link && detachLink);
  return { text, revision: rulesRevision(destination, bytes, detachLink ? undefined : link), rules };
}
