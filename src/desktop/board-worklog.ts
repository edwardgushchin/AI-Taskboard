import { createHash, randomUUID } from "node:crypto";
import { globSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";
import { redactSecrets } from "../cli/redact.ts";
import { directory, exists, locateBoard, readBinary, readJson, removeFile, withLock, writeAtomic, writeJson } from "../cli/storage.ts";
import type { BoardMcpTool } from "./board-mcp.ts";
import type { CliReply } from "./cli.ts";
import type { RpcMessage } from "./codex-rpc.ts";

type Role = "manager" | "executor" | "reviewer";
const labels = {
  context: ["Контекст", "Context"],
  timeline: ["Хронология", "Timeline"],
  changes: ["Изменения", "Changes"],
  decisions: ["Решения", "Decisions"],
  checks: ["Проверки", "Checks"],
  next_steps: ["Следующие шаги", "Next steps"],
} as const;
const sections = ["context", "changes", "decisions", "checks", "next_steps"] as const;
const skips = ["acknowledgement", "no_material_work", "already_recorded"];
const languagePattern = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i;
const idPattern = /^[0-9a-f]{24}$/;
const identityPattern = /^[a-zA-Z0-9_-]+$/;
const stampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/;
const linkPattern = /(?<!!)\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
const privatePath = /(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|\.ssh|\.gnupg|private|credentials?)(?:[\\/]|$)/i;
const maxDocumentBytes = 64 * 1024;
const maxDayBytes = 32 * 1024 * 1024;
const tool = "mcp__ai_taskboard__worklog_record";
export const worklogReminder = "Worklog for this turn: before the final reply, call " + tool +
  " with {language, entries} for substantive work or {skip:\"no_material_work\"} for a trivial turn. " +
  "Each entry needs a result title, context, timeline, changes, decisions, checks and next_steps. " +
  "Record concrete outcomes and evidence so someone can continue without opening the chat.";
export const worklogInstructions = [
  worklogReminder,
  "Use only the built-in worklog_record tool and canonical project .tasks/worklog. Do not run external journal hooks or create .dev-diary in the project or a worktree. The journal survives cancellation, deletion and cleanup; include failures and rollbacks even without a successful submission.",
  "Group investigation, unsuccessful attempts, final changes and checks for the same objective in one block. Use the language of the discussion.",
  "Context gives the problem, starting state and constraints. Timeline records significant phases, including failed attempts and their causes. Use observed HH:MM, ISO dates with timezone across midnight, or null if the time was not observed.",
  "Changes names the files, cards or components and the result. Separate the final state from reverted experiments and unresolved defects. Decisions records why a choice was made and what evidence supported it.",
  "Checks records the commands or evidence actually used, the tested revision when relevant, results or counts, failures and limits. Distinguish checks you ran from results you reviewed. Preserve full SHA-256 digests and link durable evidence with project-relative Markdown links.",
  "Next steps gives the smallest continuation, any decision that remains, or confirms the work is complete. For a read-only review, record the finding, evidence and disposition even when no files changed.",
  "Keep secrets, transcripts, tool inventories, raw logs and generic directions to read the chat out of the diary. Use inline Markdown inside items. Internally verify recorded:true and staged:false; retry the same payload after a storage failure. Do not announce successful journal writes or expose recorded/staged fields to the user. This is an internal workflow check. Answer direct questions about the journal substantively.",
].join("\n");

const itemsSchema = { type: "array", minItems: 1, maxItems: 32, items: { type: "string", maxLength: 4096 } };
const entrySchema = {
  type: "object", additionalProperties: false, required: ["title", "timeline", ...sections],
  properties: {
    title: { type: "string", minLength: 12, maxLength: 160 },
    ...Object.fromEntries(sections.map(key => [key, itemsSchema])),
    timeline: { type: "array", minItems: 1, maxItems: 32, items: {
      type: "object", additionalProperties: false, required: ["time", "items"],
      properties: { time: { type: ["string", "null"], description: "HH:MM, an ISO timestamp with timezone, or null." }, items: itemsSchema },
    } },
    artifacts: { ...itemsSchema, minItems: 0 },
    supersedes: { type: "array", maxItems: 32, items: { type: "string", pattern: idPattern.source } },
  },
};
export const worklogTool: BoardMcpTool = {
  name: "worklog_record",
  description: "Write complete work blocks for the current AI Taskboard turn. For a turn without substantive work, supply skip alone.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      language: { type: "string", maxLength: 24 },
      entries: { type: "array", minItems: 1, maxItems: 8, items: entrySchema },
      skip: { type: "string", enum: skips },
    },
  },
};

type Entry = Record<typeof sections[number], string[]> & {
  title: string; timeline: { time: string | null; items: string[] }[]; artifacts: string[]; supersedes: string[];
};
type Submission = { language: string; entries: Entry[] };
type Binding = { threadId: string; turnId: string };
type Staged = Binding & { stamp: string; role: Role; taskId?: string; submission: Submission };

function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error("Unexpected Worklog fields.");
  }
  return value as Record<string, unknown>;
}

function reference(target: string, project: string) {
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (!url.username && !url.password &&
          ![...url.searchParams.keys()].some(key => /auth|credential|key|password|secret|signature|token/i.test(key))) return target;
    } catch { /* Invalid URLs are private references. */ }
    return;
  }
  if (/^(?:~[/\\]|\/\/|\\\\)/.test(target) || (win32.isAbsolute(target) && !isAbsolute(target)) ||
      (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[/\\]/i.test(target))) return;
  let file: string;
  try { file = decodeURIComponent(target); } catch { return; }
  const path = relative(project, resolve(project, file)).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || privatePath.test(path) ||
      /[<>\s]/.test(path.replaceAll(" ", ""))) return;
  return path;
}

function cleanText(value: unknown, project: string, limit = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error("Expected non-empty Worklog text.");
  if (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(value.replace(/\r?\n/g, "")) || /<!--|-->|^\s*(?:#{1,6}\s|::|~~~|\x60{3})/m.test(value) ||
      /<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*|\s*\/?)>/i.test(value.replace(linkPattern, "$1").replace(/\x60[^\x60\n]+\x60/g, ""))) {
    throw new Error("Use inline Markdown without headings, code fences, HTML or diary markers in Worklog items.");
  }
  const units: string[] = [];
  const hold = (unit: string) => "\0" + (units.push(unit) - 1) + "\0";
  const localPaths = (text: string) => text.replace(/(?<![\w:/])(?:[a-z]:[/\\]|\\\\|\/(?!\/)|~\/)[^\s<>"()\x60]+/gi,
    path => reference(path, project) ?? "[external path]");
  const webLinks = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"()\x60]+/gi,
    url => hold(reference(url, project) ?? "[private link]"));
  return redactSecrets(value.normalize("NFC").trim().replace(/\r\n/g, "\n"))
    .replace(linkPattern, (_link, label: string, rawTarget: string) => {
      const target = reference(rawTarget.replace(/^<|>$/g, ""), project);
      return hold(target ? "[" + label + "](<" + target + ">)" : "[private link]");
    })
    .replace(/\x60([^\x60\n]+)\x60/g, (_code, text: string) => {
      if (privatePath.test(text)) return hold("[private path]");
      if (/^(?:[a-z]:[/\\]|\/|\\\\|~\/)/i.test(text)) return hold("\x60" + (reference(text, project) ?? "[external path]") + "\x60");
      return "\x60" + localPaths(webLinks(text)) + "\x60";
    })
    .replace(/\b(?:\.env|\.ssh|\.gnupg)(?:[/\\][^\s\x60]+)?/g, "[private path]")
    .replace(/\.(?:env|ssh|gnupg)(?=\s|$)/g, "[private path]")
    .replace(/https?:\/\/[^\s<>"()\x60]+/gi, url => hold(reference(url, project) ?? "[private link]"))
    .replace(/(?<![\w:/])(?:[a-z]:[/\\]|\\\\|\/(?!\/)|~\/)[^\s<>"()\x60]+/gi, path => reference(path, project) ?? "[external path]")
    .replace(/\0(\d+)\0/g, (_unit, index: string) => units[Number(index)]!);
}

function submissionOf(args: unknown, project: string): Submission | { skip: string } {
  if (Buffer.byteLength(JSON.stringify(args) ?? "") > maxDocumentBytes) throw new Error("Worklog submission exceeds 64 KiB.");
  const document = object(args, ["language", "entries", "skip"]);
  if (Object.hasOwn(document, "skip")) {
    if (Object.keys(document).length !== 1 || typeof document.skip !== "string" || !skips.includes(document.skip)) {
      throw new Error("Submit a Worklog skip reason by itself.");
    }
    return { skip: document.skip };
  }
  const language = document.language ?? "en";
  if (typeof language !== "string" || language.length > 24 || !languagePattern.test(language)) throw new Error("Use a Worklog language code.");
  if (!Array.isArray(document.entries) || !document.entries.length || document.entries.length > 8) {
    throw new Error("Submit 1–8 work blocks with title and all six sections.");
  }
  const items = (value: unknown, optional = false) => {
    if (value === undefined && optional) return [];
    if (!Array.isArray(value) || value.length > 32 || (!optional && !value.length)) throw new Error("Worklog sections need 1–32 text items.");
    return value.map(item => cleanText(item, project));
  };
  const titles = new Set<string>();
  const entries = document.entries.map(value => {
    const entry = object(value, ["title", "timeline", "artifacts", "supersedes", ...sections]);
    const title = cleanText(entry.title, project, 160);
    if (title.length < 12 || title.includes("\n") || titles.has(title)) throw new Error("Each work block needs a distinct title that names its result.");
    titles.add(title);
    if (!Array.isArray(entry.timeline) || !entry.timeline.length || entry.timeline.length > 32) throw new Error("A work block needs 1–32 timeline phases.");
    const timeline = entry.timeline.map(value => {
      const { time, items: details } = object(value, ["time", "items"]);
      if (time !== null && (typeof time !== "string" ||
          (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) &&
            (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(Date.parse(time)))))) {
        throw new Error("Use HH:MM, a timezone ISO timestamp, or null for a timeline phase.");
      }
      return { time, items: items(details) };
    });
    const supersedes = entry.supersedes ?? [];
    if (!Array.isArray(supersedes) || supersedes.length > 32 || !supersedes.every(id => typeof id === "string" && idPattern.test(id))) {
      throw new Error("Use Worklog entry IDs in supersedes.");
    }
    return { title, timeline, supersedes, artifacts: items(entry.artifacts, true),
      context: items(entry.context), changes: items(entry.changes), decisions: items(entry.decisions),
      checks: items(entry.checks), next_steps: items(entry.next_steps) };
  });
  const normalized = { language, entries };
  if (Buffer.byteLength(JSON.stringify(normalized)) > maxDocumentBytes) throw new Error("Use a shorter Worklog submission.");
  return normalized;
}

function timestamp(date = new Date()) {
  const local = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(date);
  const minutes = -date.getTimezoneOffset();
  const hours = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
  return local + " " + (minutes < 0 ? "-" : "+") + hours + ":" + String(Math.abs(minutes) % 60).padStart(2, "0");
}

function entryId({ threadId, turnId }: Binding, index = 0) {
  return createHash("sha256").update([threadId, turnId, index].join("\0")).digest("hex").slice(0, 24);
}

const marker = (id: string) => "<!-- codex-worklog-entry:" + id + " -->";
class InvalidWorklogSubmission extends Error {}

function readDiary(path: string, maxBytes = maxDayBytes) {
  if (statSync(path).size > maxBytes) throw new Error("Daily Worklog exceeds its size limit.");
  return readBinary(path).toString("utf8");
}

function renderBlock(staged: Staged, entry: Entry, id: string) {
  const { stamp, threadId, turnId, role, taskId, submission } = staged;
  const ru = submission.language.toLowerCase().split("-")[0] === "ru";
  const bullet = (item: string, indent = "") => indent + "- " + item.replace(linkPattern, (link, label: string, rawTarget: string) => {
    const target = rawTarget.replace(/^<|>$/g, "");
    return /^https?:/i.test(target) ? link : "[" + label + "](<../../../../" + target + ">)";
  }).replaceAll("\n", "\n" + indent + "  ");
  return [
    "", "## " + stamp + " — " + entry.title, "", "<!-- codex-worklog-session:" + threadId + " turn:" + turnId + " -->",
    "<!-- ai-taskboard-role:" + [role, taskId].filter(Boolean).join(" ") + " -->",
    ...Object.entries(labels).flatMap(([key, titles]) => {
      const heading = ["", "### " + titles[ru ? 0 : 1], ""];
      if (key === "timeline") {
        return [...heading, ...entry.timeline.flatMap(({ time, items }) => [
          "- \x60" + (time ?? (ru ? "Время не зафиксировано" : "Time not recorded")) + "\x60", ...items.map(item => bullet(item, "  ")),
        ])];
      }
      const values = entry[key as typeof sections[number]];
      if (key === "checks") return [...heading, ...[...values, ...entry.artifacts].map(item => bullet(item))];
      if (key === "decisions" && entry.supersedes.length) {
        const corrections = (ru ? "Заменяет записи" : "Supersedes entries") + ": " + entry.supersedes.map(id => "\x60" + id + "\x60").join(", ") + ".";
        return [...heading, ...[...values, corrections].map(item => bullet(item))];
      }
      return [...heading, ...values.map(item => bullet(item))];
    }),
    "", marker(id), "",
  ].join("\n");
}

function save(project: string, staged: Staged) {
  const day = staged.stamp.slice(0, 10);
  const year = day.slice(0, 4);
  const month = day.slice(5, 7);
  const board = join(project, ".tasks");
  const root = join(board, "worklog");
  directory(board);
  directory(root, true);
  const entry_ids = staged.submission.entries.map((_entry, index) => entryId(staged, index));
  const path = join(root, year, month, day + ".md");
  withLock(root, () => {
    directory(join(root, year), true);
    directory(join(root, year, month), true);
    const header = "# Codex Worklog — " + day + "\n";
    const prior = exists(path) ? readDiary(path) : header;
    if (!prior.startsWith(header) || !prior.endsWith("\n")) throw new Error("Invalid daily Worklog file.");
    const content = staged.submission.entries.map((entry, index) => renderBlock(staged, entry, entry_ids[index]!)).join("");
    if (staged.turnId.includes("_fact_")) {
      // Facts can be replayed after midnight. Identity, not delivery date, owns the record.
      for (const file of globSync("[0-9][0-9][0-9][0-9]/[0-9][0-9]/????-??-??.md", { cwd: root })) {
        const parts = file.split(/[/\\]/);
        directory(join(root, parts[0]!));
        directory(join(root, parts[0]!, parts[1]!));
        const previous = readDiary(join(root, file));
        if (previous.includes(marker(entry_ids[0]!))) {
          if (!previous.includes(content.split("\n").slice(2).join("\n"))) throw new InvalidWorklogSubmission("Conflicting Worklog event identity.");
          return;
        }
      }
    }
    if (entry_ids.some(id => prior.includes(marker(id)))) {
      if (!prior.includes(content)) throw new InvalidWorklogSubmission("This turn already has a different Worklog submission.");
      return;
    }
    const missing = new Set(staged.submission.entries.flatMap(entry => entry.supersedes));
    if (missing.size) {
      if (entry_ids.some(id => missing.has(id))) throw new InvalidWorklogSubmission("Worklog entries cannot supersede their own submission.");
      let days = 0;
      let remaining = 4 * maxDayBytes;
      for (const file of globSync("[0-9][0-9][0-9][0-9]/[0-9][0-9]/????-??-??.md", { cwd: root })) {
        if (++days > 4096 || remaining <= 0) throw new InvalidWorklogSubmission("Worklog corrections exceed the history lookup limit.");
        const parts = file.split(/[/\\]/);
        directory(join(root, parts[0]!));
        directory(join(root, parts[0]!, parts[1]!));
        const previous = readDiary(join(root, file), Math.min(maxDayBytes, remaining));
        remaining -= Buffer.byteLength(previous);
        for (const id of missing) if (previous.includes(marker(id))) missing.delete(id);
        if (!missing.size) break;
      }
      if (missing.size) throw new InvalidWorklogSubmission("The entry to supersede is missing in this board's Worklog.");
    }
    if (Buffer.byteLength(prior) + Buffer.byteLength(content) > maxDayBytes) throw new Error("Daily Worklog exceeds 32 MiB.");
    writeAtomic(path, prior + content);
  });
  return { recorded: true, staged: false, entry_ids, path };
}

export function boardWorklog(project: string, role: Role, taskId?: string) {
  project = locateBoard(project).root;
  const pendingRoot = join(project, ".tasks", "pending");
  const pendingPath = (binding: Binding) => join(pendingRoot, "worklog-" + entryId(binding) + ".json");
  let turn: (Binding & { reminded?: boolean; skipped?: boolean; editedFiles?: boolean; submission?: Staged; saved?: boolean; facts?: boolean }) | undefined;
  let finishedTurnId: string | undefined;
  const recover = (path: string): Staged => {
    const staged = object(readJson(path), ["threadId", "turnId", "stamp", "role", "taskId", "submission"]);
    const { threadId, turnId, stamp, role, taskId } = staged;
    if (typeof threadId !== "string" || typeof turnId !== "string" ||
        !identityPattern.test(threadId) || !identityPattern.test(turnId) ||
        typeof stamp !== "string" || !stampPattern.test(stamp) ||
        !["manager", "executor", "reviewer"].includes(String(role)) ||
        (taskId !== undefined && (typeof taskId !== "string" || !/^T-\d+$/.test(taskId))) ||
        pendingPath({ threadId, turnId }) !== path) throw new Error("Invalid staged Worklog entry.");
    const submission = submissionOf(staged.submission, project);
    if ("skip" in submission) throw new Error("Invalid staged Worklog submission.");
    return { threadId, turnId, stamp, role: role as Role, taskId, submission };
  };
  const commit = (path: string, staged: Staged) => {
    try {
      const saved = save(project, staged);
      removeFile(path);
      return saved;
    } catch (error) {
      // Keep conflicting deliveries for diagnosis; never discard historical evidence.
      throw error;
    }
  };
  const persist = (staged: Staged) => {
    directory(join(project, ".tasks"));
    directory(pendingRoot, true);
    const path = pendingPath(staged);
    return withLock(pendingRoot, () => {
      if (exists(path)) {
        const pending = recover(path);
        if (JSON.stringify(pending.submission) !== JSON.stringify(staged.submission)) {
          throw new Error("This turn already has a different staged Worklog submission.");
        }
        staged.stamp = pending.stamp;
        return commit(path, pending);
      }
      writeJson(path, staged);
      return commit(path, staged);
    });
  };
  const retry = () => {
    if (!exists(pendingRoot)) return;
    try {
      directory(pendingRoot);
      for (const name of readdirSync(pendingRoot).filter(name => /^worklog-[0-9a-f]{24}\.json$/.test(name))) {
        const path = join(pendingRoot, name);
        try {
          withLock(pendingRoot, () => {
            if (exists(path)) commit(path, recover(path));
          });
        } catch (error) {
          console.warn("Could not retry AI Taskboard Worklog:", (error as Error).message);
        }
      }
    } catch (error) {
      console.warn("Could not read staged AI Taskboard Worklog:", (error as Error).message);
    }
  };
  function finish(outcome = "interrupted or disconnected; final outcome unknown") {
    if (turn?.facts) fact("turn-finished", "turn: " + outcome);
    const current = turn;
    if (current) finishedTurnId = current.turnId;
    turn = undefined;
    if (current?.submission && !current.saved && !exists(pendingPath(current))) {
      try { persist(current.submission); }
      catch (error) { console.warn("Could not stage AI Taskboard Worklog:", (error as Error).message); }
      return;
    }
    retry();
  }
  const start = (threadId: string, turnId: string) => {
    if (!identityPattern.test(threadId) || !identityPattern.test(turnId) || turn?.turnId === turnId || finishedTurnId === turnId) return;
    finish();
    turn = { threadId, turnId };
  };
  async function submit(args: unknown): Promise<CliReply> {
    if (!turn) return { ok: false, error: { code: "WORKLOG_NO_TURN", message: "There is no active AI Taskboard turn." } };
    let submission: ReturnType<typeof submissionOf>;
    try {
      submission = submissionOf(args, project);
      if ("skip" in submission) {
        if (turn.submission) throw new Error("The turn already has a Worklog submission.");
        if (turn.editedFiles) throw new Error("This turn changed files. Submit an authored Worklog entry with the result.");
        turn.skipped = true;
        return { ok: true, data: { recorded: false, staged: false, skipped: submission.skip } };
      }
      if (turn.skipped || (turn.submission && JSON.stringify(turn.submission.submission) !== JSON.stringify(submission))) {
        throw new Error("This turn already has a different Worklog submission.");
      }
    } catch (error) {
      return { ok: false, error: { code: "INVALID_WORKLOG", message: (error as Error).message } };
    }
    turn.submission ??= { threadId: turn.threadId, turnId: turn.turnId, role, taskId, stamp: timestamp(), submission };
    try {
      const saved = persist(turn.submission);
      turn.saved = true;
      return { ok: true, data: saved };
    } catch (error) {
      if (error instanceof InvalidWorklogSubmission) {
        turn.submission = undefined;
        return { ok: false, error: { code: "INVALID_WORKLOG", message: error.message } };
      }
      return { ok: false, error: { code: "WORKLOG_WRITE_FAILED", message: (error as Error).message } };
    }
  }
  function fact(id: string, detail: string) {
    if (!turn) return;
    turn.facts = true;
    persist({ threadId: turn.threadId, turnId: turn.turnId + "_fact_" + createHash("sha256").update(id).digest("hex"),
      stamp: timestamp(), role, taskId, submission: { language: "ru", entries: [{
        title: "Событие выполнения операции", context: ["Наблюдаемый факт выполнения; итог работы требует авторского отчёта."],
        timeline: [{ time: null, items: [detail] }], changes: ["Сохранён факт операции без команды, вывода и содержимого файлов."],
        decisions: ["Событие записано сразу, независимо от сдачи и существования карточки."],
        checks: ["Статус сообщён источником события; независимая проверка не выполнялась."],
        next_steps: ["Сопоставить с авторским отчётом. Отсутствие отчёта не означает успех работы."], artifacts: [], supersedes: [],
      }] } });
  }
  function observe(message: RpcMessage, threadId: string) {
    const params = message.params as { threadId?: string; turnId?: string; turn?: { id: string; status?: string };
      item?: { id?: string; type?: string; status?: string; exitCode?: number | null } } | undefined;
    if (params?.threadId !== threadId) return;
    if (message.method === "turn/started" && params.turn) start(threadId, params.turn.id);
    if (message.method === "turn/completed" && params.turn?.id === turn?.turnId) finish(["completed", "failed", "interrupted"].includes(params.turn?.status ?? "") ? params.turn!.status : "completed; status unknown");
    if ((message.method === "item/started" || message.method === "item/completed") && turn && turn.turnId === params.turnId &&
        params.item?.id && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(params.item.type ?? "")) {
      const item = params.item;
      const status = ["inProgress", "completed", "failed", "declined", "interrupted"].includes(item.status ?? "") ? item.status : "unknown";
      const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode : "unknown";
      fact(message.method + ":" + item.id, `${item.type}: ${message.method === "item/started" ? "started" : "completed"}; status=${status}; exitCode=${exitCode}`);
    }
    if (message.method === "item/completed" && turn && turn.turnId === params.turnId) {
      if (params.item?.type === "contextCompaction") turn.reminded = false;
      if (params.item?.type === "fileChange" && params.item.status === "completed") {
        turn.editedFiles = true;
        if (turn.skipped) {
          turn.skipped = false;
          turn.reminded = false;
        }
      }
    }
  }
  function remind(reply: CliReply): CliReply & { worklog?: string } {
    if (!turn || turn.reminded || turn.skipped || turn.submission) return reply;
    turn.reminded = true;
    return { ...reply, worklog: worklogReminder };
  }
  return { start, observe, finish, submit, remind, fact };
}

// Service operations use the same writer and recovery queue, without reading a card.
export function beginBoardOperation(project: string, operation: string, taskId?: string) {
  const log = boardWorklog(project, "manager", taskId);
  log.start("board-service", randomUUID());
  log.fact("started", operation + ": started; outcome unknown");
  return (outcome: string) => { log.fact("result", operation + ": " + outcome); log.finish(outcome); };
}
