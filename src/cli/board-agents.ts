import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { TaskboardError } from "./model.ts";
import { readBinary, sha256, writeAtomic } from "./storage.ts";

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

function section(source: string, markers: typeof sections.rules) {
  const lines = [...source.matchAll(/(?:^|(?<=\n))[^\r\n]+/g)];
  const starts = lines.filter(line => line[0] === markers.start);
  const ends = lines.filter(line => line[0] === markers.end);
  if (!starts.length && !ends.length) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "Check the AI Taskboard section markers in AGENTS.md.");
  }
  return { start: starts[0].index, end: ends[0].index + markers.end.length,
    content: source.slice(starts[0].index + markers.start.length, ends[0].index) };
}

function rulesRevision(path: string, bytes: Buffer) {
  return sha256(Buffer.concat([Buffer.from(path + "\0"), bytes]));
}

function load(root: string) {
  const entry = join(root, "AGENTS.md");
  const info = lstatSync(entry, { throwIfNoEntry: false });
  if (!info) return { path: entry, source: "", revision: "missing" };

  // Replace the regular file named by the link, leaving AGENTS.md itself in place.
  const path = info.isSymbolicLink() ? realpathSync(entry) : entry;
  const bytes = readBinary(path);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path, source, revision: rulesRevision(path, bytes) };
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

export function readBoardProjectRules(root: string) {
  const { source, revision } = load(root);
  return { text: readRules(source) ?? "", revision };
}

function rulesConflict(source: string, revision: string) {
  return new TaskboardError("PROJECT_RULES_CONFLICT", "AGENTS.md changed since these rules were opened.", {
    text: readRules(source) ?? "", revision,
  });
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
export function writeBoardProjectRules(root: string, input?: { text: unknown; revision: unknown }) {
  const { path, source, revision } = load(root);
  const savedText = readRules(source);
  const workflowBlock = section(source, sections.workflow);
  const rulesBlock = section(source, sections.rules);
  if (workflowBlock && rulesBlock && workflowBlock.start < rulesBlock.end && rulesBlock.start < workflowBlock.end) {
    throw new TaskboardError("INVALID_AGENTS_SECTIONS", "AI Taskboard sections in AGENTS.md must be separate.");
  }
  if (input && input.revision !== revision) {
    throw rulesConflict(source, revision);
  }
  if (input && typeof input.text !== "string") {
    throw new TaskboardError("INVALID_INPUT", "Project rules must be Markdown text.");
  }
  const draft = typeof input?.text === "string" ? input.text.replace(/\r\n?/g, "\n") : savedText ?? "";
  const rules = draft.trim() ? draft : "";
  if (rules.split("\n").some(line => Object.values(sections).some(({ start, end }) => line === start || line === end))) {
    throw new TaskboardError("INVALID_INPUT", "Project rules cannot contain AI Taskboard section markers on their own lines.");
  }
  const newline = source.match(/\r\n|\n/)?.[0] ?? "\n";
  let updated = source;
  for (const [markers, content] of [
    [sections.workflow, workflow.trimEnd()],
    [sections.rules, rules ? rulesHeading + "\n\n" + rules : rulesHeading],
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
  if (updated === source) return { text: rules, revision };

  const bytes = Buffer.from(updated);
  writeAtomic(path, bytes, () => {
    const latest = load(root);
    if (latest.revision !== revision) {
      throw rulesConflict(latest.source, latest.revision);
    }
  });
  return { text: rules, revision: rulesRevision(path, bytes) };
}
