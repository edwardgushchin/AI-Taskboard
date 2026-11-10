#!/usr/bin/env node
import { readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acceptTask, inspectReview } from "./acceptance.ts";
import { addAttachment, archiveDiagnostics, isArchived, readAttachment, readTask, sweepArchives } from "./archive.ts";
import { member, number, object, TaskboardError } from "./model.ts";
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
  "          block, resume, preview, submit, review, accept, request-changes, cancel, cleanup, settings, watch, doctor",
  "          list --archived, archive sweep, attachment add TASK-ID, attachment read TASK-ID",
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

function watchBoard(location: BoardLocation): void {
  let previous = JSON.stringify(onBoard(location, store => ({ ok: true, data: store.snapshot() })));
  process.stdout.write(previous + "\n");
  let refreshTimer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  const refresh = () => {
    refreshTimer = undefined;
    let current: string;
    try {
      current = JSON.stringify(onBoard(location, store => ({ ok: true, data: store.snapshot() })));
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
  archived: boolean,
) {
  if (command === "list") {
    const snapshot = store.snapshot();
    return archived ? { project: snapshot.project, archived: snapshot.archived } : snapshot;
  }
  if (command === "create") return createTask(store, input);
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
  if (command !== "show" && command !== "start" && command !== "cleanup" && command !== "preview" && command !== "submit" && command !== "review" && command !== "accept" && !taskActions.has(command)) {
    throw new TaskboardError("UNKNOWN_COMMAND", "Unknown command " + command + ".");
  }
  if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
  if (command === "show") return taskWithCurrentWorktree(store, readTask(store, id));
  if (command === "cleanup" && isArchived(store, id)) return cleanTaskWorktree(store, readTask(store, id));
  const task = store.card(id);
  if (command === "start") return startTask(store, task, input);
  if (command === "preview") return previewSubmission(store, task);
  if (command === "submit") return submitTask(store, task, input);
  if (command === "review") return inspectReview(store, task);
  if (command === "accept") return acceptTask(store, task, input);
  if (hasPending(store, task)) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
  }
  if (command === "cleanup") return cleanTaskWorktree(store, task);
  return store.save(changeTask(task, command, input));
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
    const input = readInput(values.stdin);
    const location = locateBoard(values.project ?? process.cwd(), command === "init");
    if (command === "watch") {
      watchBoard(location);
    } else {
      const data = command === "init" ? initializeBoard(location) : onBoard(location, store => run(store, command, id, extra, input, values.archived === true));
      send({ ok: true, data });
    }
  }
} catch (error) {
  send({ ok: false, error: describe(error) });
  process.exitCode = 1;
}
