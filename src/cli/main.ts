#!/usr/bin/env node
import { readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acceptTask, inspectReview, reopenConflictingReview } from "./acceptance.ts";
import { describeSavedChanges, restoreSavedChanges } from "./saved-changes.ts";
import {
  addAttachment, addChatMessage, archiveDiagnostics, createWithAttachments, isArchived, readAttachment, readTask, sweepArchives,
  upgradeTagCatalog,
} from "./archive.ts";
import { member, number, object, registerTags, tagColors, tagKey, TaskboardError, text } from "./model.ts";
import type { Task } from "./model.ts";
import { initializeBoard, locateBoard, onBoard } from "./storage.ts";
import type { BoardLocation, BoardStore } from "./storage.ts";
import { previewSubmission, submitTask } from "./submission.ts";
import { changeTask, createTask } from "./tasks.ts";
import { cleanTaskWorktree, hasPending, startTask, taskWithCurrentWorktree } from "./worktree.ts";
import packageInfo from "../../package.json" with { type: "json" };

const taskActions = new Set(["approve", "request-changes", "cancel", "comment", "progress", "block", "resume", "update"]);
const help = [
  "Usage: ai-taskboard [--project PATH] [--json] COMMAND [TASK-ID] [--stdin]",
  "Commands: init, list, show, create, update, comment, approve, start, progress,",
  "          block, resume, preview, submit, review, accept, restore-changes, request-changes, cancel, cleanup, settings, watch, doctor",
  "          list --archived, archive sweep, chat TASK-ID, attachment add TASK-ID, attachment read TASK-ID",
  "          list --tag NAME, tag ensure --stdin, tag set --stdin (name and color)",
  "For init, pass git: true with --stdin to initialize Git in the chosen folder.",
  "With --stdin, pass one JSON object as the command input.",
].join("\n");

function send(result: unknown): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

function describe(error: unknown) {
  if (error instanceof TaskboardError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const cause = error as NodeJS.ErrnoException;
  const code = cause.code?.startsWith("ERR_PARSE_ARGS") || cause instanceof SyntaxError ? "INVALID_INPUT" : "IO_ERROR";
  return { code, message: cause.message ?? String(error) };
}

function readInput(fromStdin: boolean | undefined): Record<string, unknown> {
  return fromStdin ? object(JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""))) : {};
}

function snapshotBoard(store: BoardStore) {
  upgradeTagCatalog(store);
  return store.snapshot();
}

function assignTags(store: BoardStore, task: Task): Task {
  const catalog = upgradeTagCatalog(store);
  const previous = catalog.length;
  const tags = registerTags(catalog, task.tags);
  if (catalog.length !== previous) store.saveIndex();
  return { ...task, tags };
}

function watchBoard(location: BoardLocation): void {
  let previous = JSON.stringify({ ok: true, data: onBoard(location, snapshotBoard) });
  process.stdout.write(previous + "\n");
  let refreshTimer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  const refresh = () => {
    refreshTimer = undefined;
    let current: string;
    try {
      current = JSON.stringify({ ok: true, data: onBoard(location, snapshotBoard) });
    } catch (error) {
      if (error instanceof TaskboardError && error.code === "BOARD_BUSY") return;
      current = JSON.stringify({ ok: false, error: describe(error) });
    }
    if (current !== previous) {
      process.stdout.write(current + "\n");
      previous = current;
    }
  };
  const schedule = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 25);
  };
  for (const [path, relevant] of [
    [location.directory, (name: string) => name === "board.json"],
    [join(location.directory, "tasks"), (name: string) => /^T-[0-9]{4,}\.json$/.test(name)],
  ] as const) {
    try {
      const watcher = watch(path, (_event, filename) => {
        if (!filename || relevant(filename)) schedule();
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // The periodic refresh covers filesystems that do not support watch.
    }
  }
  const interval = setInterval(refresh, 1500);
  const stop = () => {
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    for (const watcher of watchers) watcher.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function run(
  store: BoardStore,
  command: string,
  id: string | undefined,
  extra: string | undefined,
  input: Record<string, unknown>,
  filters: { archived?: boolean; tag?: string },
) {
  if (command === "list") {
    const key = filters.tag === undefined ? undefined : tagKey(text(filters.tag, "tag", true));
    const matches = (entry: { tags?: string[] }) => key === undefined || entry.tags?.some(name => tagKey(name) === key);
    const snapshot = snapshotBoard(store);
    const archived = snapshot.archived.filter(matches);
    return filters.archived ? { project: snapshot.project, tags: snapshot.tags, archived } :
      { ...snapshot, tasks: snapshot.tasks.filter(matches), archived };
  }
  if (command === "create") {
    const task = createTask(store.allocateId(), input);
    return createWithAttachments(store, task.tags.length ? assignTags(store, task) : task, input.attachmentSources);
  }
  if (command === "tag") {
    if (id !== "ensure" && id !== "set") throw new TaskboardError("INVALID_INPUT", "Use tag ensure or tag set.");
    const name = text(input.name, "name", true);
    const color = member(input.color, tagColors, "color");
    const tags = upgradeTagCatalog(store);
    const key = tagKey(name);
    const existing = tags.find(tag => tagKey(tag.name) === key);
    if (existing) {
      if (id === "set" && existing.color !== color) {
        existing.color = color;
        store.saveIndex();
      }
      return existing;
    }
    const tag = { name, color };
    tags.push(tag);
    store.saveIndex();
    return tag;
  }
  if (command === "archive") {
    if (id !== "sweep") throw new TaskboardError("INVALID_INPUT", "Use archive sweep.");
    return sweepArchives(store);
  }
  if (command === "attachment") {
    if (!extra || (id !== "add" && id !== "read")) {
      throw new TaskboardError("INVALID_INPUT", "Use attachment add or read with a task ID.");
    }
    if (id === "read") return readAttachment(store, extra, input);
    const task = store.card(extra);
    if (hasPending(store, task)) throw new TaskboardError("PENDING_OPERATION", "Finish the pending Git operation first.");
    return addAttachment(store, task, input);
  }
  if (command === "doctor") {
    const archive = archiveDiagnostics(store, input.repair === true);
    const active = store.doctor(input.repair === true);
    return { issues: [...active.issues, ...archive.issues], recovered: active.recovered, cleanedArchives: archive.cleaned };
  }
  if (command === "settings") {
    if (input.archiveAfterDays !== undefined) {
      store.index.settings.archiveAfterDays = input.archiveAfterDays === null
        ? null : number(input.archiveAfterDays, "archiveAfterDays", 0);
    }
    if (input.integrationMode !== undefined) {
      store.index.settings.integrationMode = member(input.integrationMode, ["merge", "squash"], "integrationMode");
    }
    store.saveIndex();
    return store.index.settings;
  }
  if (command !== "show" && command !== "start" && command !== "cleanup" && command !== "preview" && command !== "submit" && command !== "review" && command !== "accept" && command !== "restore-changes" && command !== "chat" && !taskActions.has(command)) {
    throw new TaskboardError("UNKNOWN_COMMAND", "Unknown command " + command + ".");
  }
  if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
  if (command === "show") {
    const task = taskWithCurrentWorktree(store, readTask(store, id));
    return { ...task, savedChanges: describeSavedChanges(store, task) };
  }
  if (command === "restore-changes") return restoreSavedChanges(store, readTask(store, id), input);
  if (command === "cleanup" && isArchived(store, id)) return cleanTaskWorktree(store, readTask(store, id));
  const task = store.card(id);
  if (command === "start") {
    if (task.status !== "in_progress" && input.resolveConflicts === true) return reopenConflictingReview(store, task, input);
    return startTask(store, task, input);
  }
  if (command === "preview") return previewSubmission(store, task);
  if (command === "submit") return submitTask(store, task, input);
  if (command === "review") return inspectReview(store, task);
  if (command === "accept") return acceptTask(store, task, input);
  if (hasPending(store, task)) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
  }
  if (command === "cleanup") return cleanTaskWorktree(store, task);
  if (command === "chat") return addChatMessage(store, task, input);
  const updated = changeTask(task, command, input);
  return store.save(command === "update" && input.tags !== undefined ? assignTags(store, updated) : updated);
}

process.stdout.on("error", error => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw error;
});

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      stdin: { type: "boolean" },
      archived: { type: "boolean" },
      tag: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, id, extra, unexpected] = positionals;
  if (values.version) {
    if (values.json) send({ ok: true, data: { version: packageInfo.version } });
    else process.stdout.write(packageInfo.version + "\n");
  } else if (!command || values.help) {
    if (values.json) send({ ok: true, data: { help } });
    else process.stdout.write(help + "\n");
  } else {
    if (unexpected !== undefined || (command !== "attachment" && extra !== undefined)) {
      throw new TaskboardError("INVALID_INPUT", "Unexpected positional argument.");
    }
    if (values.archived && command !== "list") throw new TaskboardError("INVALID_INPUT", "Use --archived with list.");
    if (values.tag !== undefined && command !== "list") throw new TaskboardError("INVALID_INPUT", "Use --tag with list.");
    const input = readInput(values.stdin);
    const location = locateBoard(values.project ?? process.cwd(), command === "init", command === "init" && input.git === true);
    if (command === "watch") {
      watchBoard(location);
    } else {
      const data = command === "init" ? initializeBoard(location, snapshotBoard) :
        onBoard(location, store => run(store, command, id, extra, input, values));
      send({ ok: true, data });
    }
  }
} catch (error) {
  send({ ok: false, error: describe(error) });
  process.exitCode = 1;
}
