#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, watch } from "node:fs";
import type { FSWatcher, Stats } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acceptTask, cleanAcceptedTask, compareAcceptedTree, inspectReview, inspectReviewDiff, inspectReviewQueue, reopenConflictingReview, reviewDetails, verifyReviewDecision } from "./acceptance.ts";
import { describeSavedChanges, restoreSavedChanges } from "./saved-changes.ts";
import {
  addAttachment, addChatMessage, archiveDiagnostics, createWithAttachments, isArchived, readAttachment, readTask, restoreReplyImages, sweepArchives,
  setAttachmentCover, upgradeTagCatalog,
} from "./archive.ts";
import { boardAgentRoles, boardReviewMode, hexTagColor, member, number, object, reasoningEffortPattern, record, registerTags, requireRevision, requireState, reviewModes, strings, tagKey, taskIdPattern, TaskboardError, text, validAgentLimitOverrides } from "./model.ts";
import type { GitHubMilestone, Task } from "./model.ts";
import { exists, initializeBoard, locateBoard, onBoard, readBoardSettings, withTaskStartLock } from "./storage.ts";
import type { BoardLocation, BoardStore } from "./storage.ts";
import { discoverRepository, invokeGit, scheduleGitMaintenance } from "./git.ts";
import { changeRepository, githubMilestones, githubRepository, inspectRepository, publishRepository, pushRepositoryBranch, repositoryRefs } from "./repository.ts";
import { previewSubmission, previewTask, submitTask } from "./submission.ts";
import { changeTask, createTask, recordRunLog, withoutVerification } from "./tasks.ts";
import { recordTokenUsage, taskMetrics } from "./token-usage.ts";
import type { ReviewDecisionTiming } from "./token-usage.ts";
import { managerUsage } from "./manager-usage.ts";
import { dependencyStatus, unfinishedDependencies, validateDependencies } from "./dependencies.ts";
import { checkoutTaskWorktree, cleanTaskWorktree, finishTaskStart, hasPending, inspectCleanup, prepareTaskStart, taskWithCurrentWorktree } from "./worktree.ts";
import { artifactFiles, discardTaskArtifacts, openReviewArtifact, readReviewArtifact } from "./artifacts.ts";
import { acknowledgeTaskMessages, currentReviewApproval, managerInbox, sendTaskMessage, taskMessages } from "./task-messages.ts";
import packageInfo from "../../package.json" with { type: "json" };

const taskActions = new Set(["approve", "return-to-draft", "request-changes", "cancel", "comment", "progress", "pause", "block", "resume", "unblock", "update"]);
const help = [
  "Usage: ai-taskboard [--project PATH] [--json] COMMAND [TASK-ID] [--stdin]",
  "Commands: init, list, show, create, update, comment, approve, return-to-draft, start, progress,",
  "          pause, block, resume, unblock, preview, submit, review, accept, restore-changes, request-changes, cancel, cleanup, cleanup-status, settings, watch, doctor",
  "          list --archived, archive sweep, chat TASK-ID, attachment add TASK-ID, attachment read TASK-ID",
  "          review-artifact TASK-ID --stdin (revision, source, sha256 and optional offset)",
  "          review-queue (Git status and submission time for tasks in review)",
  "          attachment cover TASK-ID --stdin (file and revision)",
  "          token-usage TASK-ID --stdin (id, sequence and records with threadId, turnId, model and token breakdown)",
  "          metrics [TASK-ID] (cycle time, submissions, returns, and known token usage)",
  "          manager-usage (known board manager token usage) or manager-usage --stdin (record a run snapshot)",
  "          message TASK-ID --stdin (text, optional kind), messages TASK-ID (optional afterSequence with --stdin), manager-inbox",
  "          manager-ack [TASK-ID] --stdin (through for one card, messages with id and through for a batch)",
  "          attachment restore-reply TASK-ID --stdin (replyAt, revision and attachmentSources)",
  "          list --tag NAME, tag ensure --stdin, tag set --stdin (name and #RRGGBB color), tag assign TASK-ID --stdin (tags)",
  "          milestones, milestone TASK-ID --stdin (revision, milestone: {repository, number} or null)",
  "          milestone-batch --stdin (tasks: [{id, revision}], milestone: {repository, number} or null)",
  "          git refs, git inspect, git switch, git create, git detach, git publish --stdin, git push --stdin (branch and head)",
  "For init, pass git: true with --stdin to initialize Git in the chosen folder.",
  "Pass one UTF-8 JSON object with --stdin or --input-file PATH.",
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

function readInput(fromStdin: boolean | undefined, file: string | undefined): Record<string, unknown> {
  if (fromStdin && file !== undefined) throw new TaskboardError("INVALID_INPUT", "Use either --stdin or --input-file.");
  if (!fromStdin && file === undefined) return {};
  const payload = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file ?? 0));
  return object(JSON.parse(payload));
}

type CompactTask = ReturnType<typeof compactTask>;

function compactTask(task: Task) {
  const { id, title, description, status, revision, tags, priority, attachments, coverAttachment, codexThreadId,
    createdAt, updatedAt, blocked, subtasks, goalThreadId, summary, nextStep, dependencies, milestone, workingDirectory, schedule } = task;
  return { id, title, description: description.slice(0, 512), status, revision, tags, priority, attachments,
    coverAttachment, codexThreadId, createdAt, updatedAt, blocked, subtasks, goalThreadId, summary, nextStep,
    dependencies, milestone, workingDirectory, schedule, historyLength: task.history.length,
    ...(status === "review" && task.git?.submission && !task.result?.noChanges ? { reviewHasCommit: true } : {}),
    ...(currentReviewApproval(task) ? { reviewApproved: true } : {}),
    initialAttachments: attachments.length - task.history.reduce((total, event) =>
      total + (event.action === "attach" ? 1 : event.chat?.files?.length ?? 0), 0),
    readySince: status === "ready" ? task.history.findLast(event => event.to === "ready")?.at : undefined,
    submittedAt: status === "review" ? task.history.findLast(event => event.action === "submit" && event.to === "review")?.at : undefined };
}

function taskReceipt({ id, status, revision, git, result }: Task) {
  return { id, status, revision, git, result };
}

function taskLaunchState({ id, title, status, revision, codexThreadId, blocked }: Task) {
  return { id, title, status, revision, codexThreadId, blocked };
}

function reviewWithSettings(store: BoardStore, review: ReturnType<typeof inspectReview>, input: Record<string, unknown>) {
  if (input.includeReviewerSettings !== true) return review;
  return { ...review, settings: {
    reviewMode: boardReviewMode(store.index.settings),
    reviewer: store.index.settings.reviewer,
  } };
}

type CachedCard = { file: Stats; task: CompactTask; inbox: ReturnType<typeof managerInbox> };

function snapshotBoard(store: BoardStore, compact = false, cache = new Map<string, CachedCard>()) {
  upgradeTagCatalog(store, false);
  const archived = store.archivedCards();
  const header = { project: store.location.root, settings: store.index.settings, tags: store.index.tags ?? [], archived };
  if (compact) {
    const ids = Object.keys(store.index.tasks);
    for (const id of cache.keys()) if (!Object.hasOwn(store.index.tasks, id)) cache.delete(id);
    const cards = ids.map(id => {
      const file = lstatSync(store.cardPath(id));
      const saved = cache.get(id);
      if (saved && saved.file.mtimeMs === file.mtimeMs && saved.file.ctimeMs === file.ctimeMs &&
          saved.file.ino === file.ino && saved.file.size === file.size) return saved;
      const task = store.card(id);
      const card = { file, task: compactTask(task), inbox: managerInbox([task]) };
      cache.set(id, card);
      return card;
    });
    const statuses = new Map([...cards.map(card => card.task), ...archived].map(task => [task.id, task.status]));
    return { ...header, tasks: cards.map(({ task }) => task.dependencies?.length
      ? { ...task, unfinishedDependencies: unfinishedDependencies(task, id => statuses.get(id)) } : task),
      managerInbox: cards.flatMap(card => card.inbox).sort((left, right) => left.at.localeCompare(right.at) ||
        left.id.localeCompare(right.id) || left.sequence - right.sequence) };
  }
  const board = store.snapshot();
  const statuses = new Map([...board.tasks, ...board.archived].map(task => [task.id, task.status]));
  return {
    ...board,
    tasks: board.tasks.map(task => task.dependencies?.length
      ? { ...task, unfinishedDependencies: unfinishedDependencies(task, id => statuses.get(id)) } : task),
  };
}

function assignTags(store: BoardStore, task: Task): Task {
  const catalog = upgradeTagCatalog(store);
  const previous = catalog.length;
  const tags = registerTags(catalog, task.tags);
  if (catalog.length !== previous) store.saveIndex();
  return { ...task, tags };
}

function changeTags(store: BoardStore, task: Task, input: Record<string, unknown>, defaultActor: "user" | "agent"): Task {
  requireRevision(task, input.revision);
  if (hasPending(store, task)) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
  }
  const names = strings(input.tags, "tags");
  const actor = input.actor === undefined ? defaultActor : member(input.actor, ["user", "agent", "manager"] as const, "actor");
  const note = input.note === undefined ? undefined : text(input.note, "note", true);
  const catalog = upgradeTagCatalog(store);
  const previousCount = catalog.length;
  const tags = registerTags(catalog, names);
  if (JSON.stringify(task.tags) === JSON.stringify(tags)) {
    if (catalog.length !== previousCount) store.saveIndex();
    return task;
  }
  const updated = { ...record({ ...task, tags }, "update", actor, task.status, note), closedAt: task.closedAt };
  if (!isArchived(store, task.id)) {
    if (catalog.length !== previousCount) store.saveIndex();
    return store.save(updated);
  }
  // The index owns tag edits after archiving, so the archive stays intact.
  const link = store.index.archive[task.id];
  link.tagOverride = { tags, history: [...(link.tagOverride?.history ?? []), updated.history.at(-1)!] };
  store.saveIndex();
  return updated;
}

function boardGitInfo(location: BoardLocation) {
  if (!location.repository || location.repository.bare) return {};
  const value = (args: string[], env?: NodeJS.ProcessEnv) => {
    try {
      const result = invokeGit(location.root, args, env);
      return result.code === 0 ? result.stdout.trim() || undefined : undefined;
    } catch {
      return undefined;
    }
  };
  const branch = value(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = value(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const counts = branch && head ? value(["rev-list", "--left-right", "--count", "--end-of-options",
    head + "..." + branch + "@{upstream}"], { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" }) : undefined;
  const divergence = /^(\d+)\s+(\d+)$/.exec(counts ?? "");
  return {
    branch, head,
    tracking: divergence ? { ahead: Number(divergence[1]), behind: Number(divergence[2]) } : undefined,
    user: value(["config", "--get", "user.name"]),
    githubRepository: githubRepository(location),
  };
}

function watchBoard(location: BoardLocation, compact: boolean): void {
  const cards = new Map<string, CachedCard>();
  const cleanedTasks = new Set<string>();
  const cleanupRetries = new Map<string, number>();
  let nextCleanup = 0;
  let gitInfo: ReturnType<typeof boardGitInfo> = {};
  const read = (refreshGit: boolean) => {
    const previousRepository = location.repository;
    const board = onBoard(location, store => {
      if (!location.repository && existsSync(join(location.root, ".git"))) {
        const repo = discoverRepository(location.root);
        if (repo?.root === location.root) location.repository = repo;
      }
      return snapshotBoard(store, compact, cards);
    });
    if (location.repository && Date.now() >= nextCleanup) {
      const completedIds = new Set([...board.tasks, ...board.archived].filter(task => task.status === "done").map(task => task.id));
      for (const id of retryAcceptedCleanup(location, location.repository.root, completedIds, cleanupRetries)) cleanedTasks.add(id);
      nextCleanup = Date.now() + 15_000;
    }
    if (refreshGit || previousRepository !== location.repository) gitInfo = boardGitInfo(location);
    return { ok: true, data: { ...board, gitInfo, cleanedTasks: [...cleanedTasks] } };
  };
  let previous = JSON.stringify(read(true));
  process.stdout.write(previous + "\n");
  let refreshTimer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  const refresh = (refreshGit: boolean) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    let current: string;
    try {
      current = JSON.stringify(read(refreshGit));
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
    refreshTimer = setTimeout(refresh, 25, false);
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
  const interval = setInterval(refresh, 1500, true);
  const stop = () => {
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    for (const watcher of watchers) watcher.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function retryAcceptedCleanup(location: BoardLocation, root: string, completedIds: ReadonlySet<string>, retries: Map<string, number>): string[] {
  if (!completedIds.size) return [];
  const prefix = "refs/heads/ai-taskboard/";
  let branches: string[];
  try {
    const result = invokeGit(root, ["for-each-ref", "--format=%(refname)", prefix]);
    if (result.code !== 0) return [];
    branches = result.stdout.trimEnd().split("\n");
  } catch {
    return [];
  }
  const cleaned: string[] = [];
  for (const branch of branches) {
    const id = branch.slice(prefix.length);
    if (!completedIds.has(id)) continue;
    const retryAt = retries.get(id);
    if (retryAt !== undefined && Date.now() < retryAt) continue;
    try {
      const removed = withTaskStartLock(location, id, () => {
        const snapshot = onBoard(location, store => {
          if (!Object.hasOwn(store.index.tasks, id) && store.index.archive[id]?.status !== "done") return;
          const task = readTask(store, id);
          if (task.status !== "done" || task.git?.branch !== branch ||
              (!task.git.accepted && !task.result?.noChanges) || hasPending(store, task)) return;
          return { store, task };
        });
        return snapshot && cleanTaskWorktree(snapshot.store, snapshot.task).branchRemoved;
      }, 0);
      retries.delete(id);
      if (removed) cleaned.push(id);
    } catch (error) {
      if (error instanceof TaskboardError && ["DIRTY_WORKTREE", "TASK_BRANCH_CHANGED", "UNMANAGED_WORKTREE"].includes(error.code)) {
        // Persistent local state is unlikely to change between consecutive board refreshes.
        retries.set(id, Date.now() + (retryAt === undefined ? 15_000 : 120_000));
      }
    }
  }
  return cleaned;
}

function run(
  store: BoardStore,
  command: string,
  id: string | undefined,
  extra: string | undefined,
  input: Record<string, unknown>,
  filters: { archived?: boolean; tag?: string; compact?: boolean },
  lockWaitMs: number,
) {
  if (command === "metrics") {
    const tasks = id ? [readTask(store, id)] : store.snapshot().tasks;
    const now = Date.now();
    const metrics = tasks.map(task => taskMetrics(task, now));
    return id ? metrics[0] : metrics;
  }
  if (command === "list") {
    const key = filters.tag === undefined ? undefined : tagKey(text(filters.tag, "tag", true));
    const matches = (entry: { tags?: string[] }) => key === undefined || entry.tags?.some(name => tagKey(name) === key);
    const snapshot = snapshotBoard(store, filters.compact);
    const archived = snapshot.archived.filter(matches);
    return filters.archived ? { project: snapshot.project, tags: snapshot.tags, archived } :
      { ...snapshot, tasks: snapshot.tasks.filter(matches), archived };
  }
  if (command === "create") {
    const task = createTask(store.allocateId(), input);
    validateDependencies(store, task);
    return createWithAttachments(store, task.tags.length ? assignTags(store, task) : task, input.attachmentSources);
  }
  if (command === "manager-inbox") return managerInbox(store.snapshot().tasks);
  if (command === "manager-ack") {
    const batch = id === undefined;
    const entries = batch ? input.messages : [{ id, through: input.through }];
    if (!Array.isArray(entries) || !entries.length || entries.length > 64 || (!batch && input.messages !== undefined)) {
      throw new TaskboardError("INVALID_INPUT", "Supply an acknowledgement for one card or a batch of up to 64 cards.");
    }
    const seen = new Set<string>();
    const updates = entries.map(value => {
      const entry = object(value);
      const taskId = text(entry.id, "task ID", true);
      if (!taskIdPattern.test(taskId) || seen.has(taskId)) {
        throw new TaskboardError("INVALID_INPUT", "Supply distinct task IDs.");
      }
      seen.add(taskId);
      const card = store.card(taskId);
      return { card, acknowledged: acknowledgeTaskMessages(card, entry) };
    });
    const receipts = updates.map(({ card, acknowledged }) => {
      if (card !== acknowledged) store.save(acknowledged);
      return { id: card.id, through: acknowledged.managerReadThrough };
    });
    return batch ? receipts : receipts[0];
  }
  if (command === "messages" || command === "message" || command === "manager-message") {
    if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
    if (command === "messages") {
      const afterSequence = input.afterSequence === undefined ? 0 : number(input.afterSequence, "afterSequence", 0);
      return taskMessages(readTask(store, id), "agent").filter(message => message.sequence > afterSequence);
    }
    const task = store.card(id);
    const sender = command === "manager-message" ? "manager" : "agent";
    const saved = store.save(sendTaskMessage(task, input, sender));
    return { id, sequence: saved.history.length };
  }
  if (command === "tag") {
    if (id === "assign") {
      if (!extra) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
      return changeTags(store, readTask(store, extra), input, "user");
    }
    if (id !== "ensure" && id !== "set") throw new TaskboardError("INVALID_INPUT", "Use tag ensure or tag set.");
    const name = text(input.name, "name", true);
    const value = text(input.color, "color", true);
    if (!hexTagColor.test(value)) throw new TaskboardError("INVALID_INPUT", "Use a tag color in #RRGGBB format.");
    const tags = upgradeTagCatalog(store);
    const existing = tags.find(tag => tagKey(tag.name) === tagKey(name));
    if (existing && id === "ensure") return existing;
    if (!existing) registerTags(tags, [name]);
    const tag = existing ?? tags.at(-1)!;
    tag.color = value.toUpperCase();
    store.saveIndex();
    return tag;
  }
  if (command === "archive") {
    if (id !== "sweep") throw new TaskboardError("INVALID_INPUT", "Use archive sweep.");
    return sweepArchives(store);
  }
  if (command === "attachment") {
    if (!extra || !id || !["add", "read", "cover", "restore-reply"].includes(id)) {
      throw new TaskboardError("INVALID_INPUT", "Use attachment add, read, cover or restore-reply with a task ID.");
    }
    if (id === "read") return readAttachment(store, extra, input);
    const task = store.card(extra);
    if (hasPending(store, task)) throw new TaskboardError("PENDING_OPERATION", "Finish the pending Git operation first.");
    if (id === "cover") return setAttachmentCover(store, task, input);
    if (id === "restore-reply") return restoreReplyImages(store, task, input);
    return addAttachment(store, task, input);
  }
  if (command === "doctor") {
    const archive = archiveDiagnostics(store, input.repair === true);
    const active = store.doctor(input.repair === true);
    return { issues: [...active.issues, ...archive.issues], recovered: active.recovered, cleanedArchives: archive.cleaned };
  }
  if (command === "settings") {
    if (input.name !== undefined) {
      const name = text(input.name, "Board name");
      if (/[\r\n\0]/.test(name)) throw new TaskboardError("INVALID_INPUT", "Board name must be a single line.");
      if (name) store.index.settings.name = name;
      else delete store.index.settings.name;
    }
    if (input.archiveAfterDays !== undefined) {
      store.index.settings.archiveAfterDays = input.archiveAfterDays === null
        ? null : number(input.archiveAfterDays, "archiveAfterDays", 0);
    }
    if (input.integrationMode !== undefined) {
      store.index.settings.integrationMode = member(input.integrationMode, ["merge", "squash"], "integrationMode");
    }
    if (input.showCardPreviews !== undefined) {
      if (typeof input.showCardPreviews !== "boolean") {
        throw new TaskboardError("INVALID_INPUT", "showCardPreviews must be a boolean.");
      }
      store.index.settings.showCardPreviews = input.showCardPreviews;
    }
    if (input.autoReview !== undefined) {
      if (typeof input.autoReview !== "boolean") throw new TaskboardError("INVALID_INPUT", "autoReview must be a boolean.");
      store.index.settings.reviewMode = input.autoReview ? "reviewer" : "human";
      delete store.index.settings.autoReview;
    }
    if (input.reviewMode !== undefined) {
      store.index.settings.reviewMode = member(input.reviewMode, reviewModes, "review mode");
      delete store.index.settings.autoReview;
    }
    if (input.agentLimits !== undefined) {
      if (!validAgentLimitOverrides(input.agentLimits)) {
        throw new TaskboardError("INVALID_INPUT", "Agent limits must be non-negative whole numbers for known roles.");
      }
      if (Object.keys(input.agentLimits).length) store.index.settings.agentLimits = input.agentLimits;
      else delete store.index.settings.agentLimits;
    }
    for (const role of boardAgentRoles) {
      if (input[role] === undefined) continue;
      if (input[role] === null) store.index.settings[role] = null;
      else {
        const settings = object(input[role]);
        const model = text(settings.model, role + " model", true);
        const effort = text(settings.effort, role + " reasoning effort", true);
        if (!reasoningEffortPattern.test(effort)) throw new TaskboardError("INVALID_INPUT", "Invalid " + role + " reasoning effort.");
        const provider = settings.provider === undefined ? undefined : member(settings.provider, ["codex"] as const, role + " provider");
        store.index.settings[role] = provider ? { provider, model, effort } : { model, effort };
      }
    }
    store.saveIndex();
    return store.index.settings;
  }
  const reviewerReport = command === "review-note" || command === "review-approve";
  if (command !== "show" && command !== "cleanup" && command !== "cleanup-status" && command !== "submit" && command !== "review" && !reviewerReport && command !== "accept" && command !== "restore-changes" && command !== "chat" && command !== "run-log" && command !== "token-usage" && !taskActions.has(command)) {
    throw new TaskboardError("UNKNOWN_COMMAND", "Unknown command " + command + ".");
  }
  if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
  if (command === "show") {
    const stored = readTask(store, id);
    if (filters.compact && input.launchDetails === true) return taskLaunchState(stored);
    const task = taskWithCurrentWorktree(store, stored);
    const details = {
      artifacts: artifactFiles(store, id), savedChanges: describeSavedChanges(store, task),
      ...(task.dependencies?.length ? {
        unfinishedDependencies: unfinishedDependencies(task, dependency => dependencyStatus(store, dependency)),
      } : {}),
    };
    if (!filters.compact && input.compact !== true) return { ...task, ...details };
    const { history, tokenUsage: _tokenUsage, ...current } = task;
    const limit = input.historyLimit === undefined ? 0 : number(input.historyLimit, "historyLimit", 1);
    const before = input.beforeSequence === undefined ? history.length + 1 : number(input.beforeSequence, "beforeSequence", 1);
    if (limit > 20 || (input.beforeSequence !== undefined && !limit)) {
      throw new TaskboardError("INVALID_INPUT", "Request 1 to 20 history entries to page through history.");
    }
    const end = Math.min(history.length, before - 1);
    const start = Math.max(0, end - limit);
    const entries = history.slice(start, end).map(({ run: _run, chat, ...entry }, index) => ({
      ...entry, sequence: start + index + 1, ...(chat?.files?.length ? { files: chat.files } : {}),
    }));
    return { ...current, ...details, historyLength: history.length, ...(limit ? { history: entries } : {}) };
  }
  if (command === "restore-changes") return restoreSavedChanges(store, readTask(store, id), input);
  const tagsOnly = command === "update" && input.tags !== undefined && Object.keys(input).every(key =>
    ["tags", "revision", "actor", "note", "preserveStatus"].includes(key));
  const task = tagsOnly ? readTask(store, id) : store.card(id);
  let decisionTiming: ReviewDecisionTiming | undefined;
  const withReviewerUsage = (card: Task) => {
    if (input.reviewerUsage === undefined) return card;
    try {
      const report = object(input.reviewerUsage);
      return recordTokenUsage(card, { ...report, role: "reviewer",
        ...(report.reviewTiming !== undefined && decisionTiming
          ? { reviewTiming: { ...object(report.reviewTiming), decisionTiming } } : {}),
      });
    } catch (error) {
      if (!(error instanceof TaskboardError)) throw error;
      console.warn("Could not record review token usage for %s (%s).", id, error.code);
      return card;
    }
  };
  if (tagsOnly && (task.status === "done" || task.status === "cancelled")) {
    return changeTags(store, task, input, "agent");
  }
  if (reviewerReport || ((input.actor === "manager" || input.actor === "reviewer") &&
      (command === "accept" || command === "request-changes"))) {
    const mode = boardReviewMode(store.index.settings);
    if (mode === "human") {
      throw new TaskboardError("AUTO_REVIEW_DISABLED", "This board uses manual acceptance.");
    }
    const actor = reviewerReport ? "reviewer" : input.actor;
    const decisionActor = command === "accept" ? "manager" : mode;
    if (actor !== decisionActor || (input.reviewMode !== undefined && input.reviewMode !== mode)) {
      throw new TaskboardError("REVIEW_MODE_CHANGED", "The board's review mode changed. Review the submission again.");
    }
    if (command === "accept" && mode === "reviewer" && task.status === "review") {
      requireRevision(task, input.revision, true);
      if (!currentReviewApproval(task) || input.targetHead === undefined) {
        throw new TaskboardError("REVIEW_REQUIRED", "Use the current target HEAD and the reviewer's approval for this submission.");
      }
    }
    if (command === "request-changes" || reviewerReport) {
      requireRevision(task, input.revision, true);
      const verificationStarted = performance.now();
      const targetHead = verifyReviewDecision(store, task, input.targetHead);
      decisionTiming = { lockWaitMs, verificationMs: Math.round(performance.now() - verificationStarted) };
      if (reviewerReport) {
        if (hasPending(store, task)) throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation first.");
        const summary = text(input.summary, "review summary", true);
        if (command === "review-approve") {
          const evidence = input.evidence;
          if (!Array.isArray(evidence) || !evidence.length || evidence.length !== task.criteria.length ||
              evidence.some(entry => typeof entry !== "string" || !entry.trim())) {
            throw new TaskboardError("VERIFICATION_REQUIRED", "Provide evidence for each criterion.");
          }
          if (currentReviewApproval(task)) {
            const recorded = withReviewerUsage(task);
            if (recorded !== task) store.save(recorded);
            return filters.compact ? taskReceipt(recorded) : recorded;
          }
          const approved = record(task, command, "reviewer", task.status, summary);
          approved.history.at(-1)!.reviewApproval = { revision: task.revision, targetHead, evidence };
          const saved = store.save(withReviewerUsage({ ...approved, revision: task.revision }));
          return filters.compact ? taskReceipt(saved) : saved;
        }
        const submitted = task.history.findLastIndex(event => event.action === "submit");
        const noted = task.history.slice(submitted + 1).findLast(event => event.action === "review-note")?.text === summary
          ? task : { ...record(task, "review-note", "reviewer", task.status, summary), revision: task.revision };
        const recorded = withReviewerUsage(noted);
        if (recorded !== task) store.save(recorded);
        return filters.compact ? taskReceipt(recorded) : recorded;
      }
    }
  }
  if (command === "token-usage") {
    const recorded = recordTokenUsage(task, input);
    if (recorded !== task) store.save(recorded);
    return filters.compact ? taskReceipt(recorded) : recorded;
  }
  if (command === "submit") {
    const submitted = submitTask(store, task, input);
    return filters.compact ? taskReceipt(submitted) : submitted;
  }
  if (command === "accept") return acceptTask(store, task, input);
  if (hasPending(store, task)) {
    throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
  }
  if (command === "chat") return addChatMessage(store, task, input);
  if (command === "run-log") {
    const logged = recordRunLog(task, input);
    if (logged !== task) store.save(logged);
    return filters.compact ? taskReceipt(logged) : logged;
  }
  const updated = changeTask(task, command, input);
  if (command === "cancel") {
    const closed = store.save(withoutVerification(updated));
    discardTaskArtifacts(store, id);
    return closed;
  }
  if ((command === "update" || command === "unblock") && input.dependencies !== undefined) validateDependencies(store, updated);
  const saved = store.save(command === "request-changes" && input.actor === "reviewer" ? withReviewerUsage(updated) :
    command === "update" && input.tags !== undefined ? assignTags(store, updated) : updated);
  if (!filters.compact) return saved;
  if (input.launchDetails === true && ["request-changes", "resume", "update"].includes(command)) return taskLaunchState(saved);
  if (["progress", "pause", "block", "resume"].includes(command)) {
    return { ...taskLaunchState(saved), summary: saved.summary, nextStep: saved.nextStep };
  }
  return saved;
}

function startTask(location: BoardLocation, id: string, input: Record<string, unknown>, compact: boolean) {
  const reply = <T extends { task: Task }>(store: BoardStore, started: T) => {
    if (!compact) return started;
    if (input.launchDetails !== true) return { ...started, task: taskReceipt(started.task) };
    const { description, criteria, execution, git, history, workingDirectory, schedule } = started.task;
    return { ...started, task: { ...taskLaunchState(started.task), description, criteria,
      execution: execution ?? store.index.settings.executor ?? undefined, git, workingDirectory, schedule,
      feedback: history.findLast(event => event.action === "request-changes")?.text } };
  };
  return withTaskStartLock(location, id, startLockWaitMs => {
    const prepared = onBoard(location, (store, lockWaitMs) => {
      const task = store.card(id);
      if (input.scheduled === true) {
        requireRevision(task, input.revision, true);
        requireState(task, ["ready"]);
        if (!task.schedule || !(Date.parse(task.schedule.nextAt) <= Date.now())) {
          throw new TaskboardError("INVALID_TRANSITION", "The task is not due to run.");
        }
      }
      if (task.status !== "in_progress" && input.resolveConflicts === true) {
        return { started: reply(store, reopenConflictingReview(store, task, input)) };
      }
      const result = prepareTaskStart(store, task, input, startLockWaitMs + lockWaitMs);
      return "task" in result ? { started: reply(store, result) } : { checkout: result };
    });
    if (!prepared.checkout) return prepared.started;
    const plan = prepared.checkout;
    const worktree = checkoutTaskWorktree(plan);
    return onBoard(location, (store, lockWaitMs) => reply(store, finishTaskStart(store, plan, worktree, lockWaitMs)));
  });
}

process.stdout.on("error", error => {
  if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  throw error;
});

function fail(error: unknown) {
  send({ ok: false, error: describe(error) });
  process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      stdin: { type: "boolean" },
      "input-file": { type: "string" },
      archived: { type: "boolean" },
      tag: { type: "string" },
      compact: { type: "boolean" },
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
    if (unexpected !== undefined || (command !== "attachment" && !(command === "tag" && id === "assign") && extra !== undefined)) {
      throw new TaskboardError("INVALID_INPUT", "Unexpected positional argument.");
    }
    if (values.archived && command !== "list") throw new TaskboardError("INVALID_INPUT", "Use --archived with list.");
    if (values.tag !== undefined && command !== "list") throw new TaskboardError("INVALID_INPUT", "Use --tag with list.");
    const input = readInput(values.stdin, values["input-file"]);
    const location = locateBoard(values.project ?? process.cwd(), command === "init", command === "init" && input.git === true);
    if (command === "watch") {
      watchBoard(location, values.compact === true);
    } else {
      let data;
      if (command === "settings" && !Object.keys(input).length) {
        data = readBoardSettings(location);
      } else if (command === "manager-usage") {
        if (id !== undefined) throw new TaskboardError("INVALID_INPUT", "Manager usage takes no task ID.");
        readBoardSettings(location);
        data = managerUsage(location.directory, input);
      } else if (command === "milestones") {
        if (id !== undefined || Object.keys(input).length) throw new TaskboardError("INVALID_INPUT", "Milestones takes no arguments.");
        data = await githubMilestones(location);
      } else if (command === "milestone" || command === "milestone-batch") {
        const batch = command === "milestone-batch";
        if (batch ? id !== undefined || !Array.isArray(input.tasks) || !input.tasks.length : !id) {
          throw new TaskboardError("INVALID_INPUT", batch ? "Supply a list of tasks." : "Supply a task ID.");
        }
        const tasks = (batch ? input.tasks as unknown[] : [{ id, revision: input.revision }]).map(value => {
          const fields = object(value);
          const taskId = text(fields.id, "task ID", true);
          if (!taskIdPattern.test(taskId)) throw new TaskboardError("INVALID_INPUT", "Use an exact task ID.");
          return { id: taskId, revision: number(fields.revision, "revision") };
        });
        if (new Set(tasks.map(task => task.id)).size !== tasks.length) {
          throw new TaskboardError("INVALID_INPUT", "Use distinct task IDs.");
        }
        const actor = input.actor === undefined ? "user" : member(input.actor, ["user", "manager"], "actor");
        let milestone: GitHubMilestone | undefined;
        if (input.milestone !== null) {
          const fields = object(input.milestone);
          const selected = { repository: text(fields.repository, "repository", true).toLowerCase(),
            number: number(fields.number, "milestone number") };
          const result = await githubMilestones(location, selected);
          const entry = result.milestones[0];
          if (entry?.number !== selected.number) throw new TaskboardError("GITHUB_MILESTONES_FAILED", "GitHub returned a different milestone.");
          milestone = { ...selected, title: entry.title };
        }
        data = onBoard(location, store => {
          if (milestone && githubRepository(location) !== milestone.repository) {
            throw new TaskboardError("GITHUB_REMOTE_REQUIRED", "The GitHub repository configured as origin changed.");
          }
          const update = ({ id, revision }: (typeof tasks)[number]) => {
            const task = store.card(id);
            requireRevision(task, revision, true);
            if (hasPending(store, task)) throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
            if (JSON.stringify(task.milestone) === JSON.stringify(milestone)) return task;
            const updated = record({ ...task, milestone }, "milestone", actor, task.status, milestone?.title);
            return store.save({ ...updated, closedAt: task.closedAt });
          };
          if (!batch) return update(tasks[0]);
          return { milestone: milestone ?? null, tasks: tasks.map(reference => {
            try {
              const { id, title, status, revision } = update(reference);
              return { ok: true, data: { id, title, status, revision, changed: revision !== reference.revision } };
            } catch (error) {
              if (!(error instanceof TaskboardError)) throw error;
              return { id: reference.id, ok: false, error: { code: error.code, message: error.message } };
            }
          }) };
        });
      } else if (command === "start") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        data = startTask(location, id, input, values.compact === true);
      } else if (command === "accept") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        data = withTaskStartLock(location, id, () => {
          const { store, task } = onBoard(location, (store, lockWaitMs) => ({
            store, task: run(store, command, id, extra, input, values, lockWaitMs) as Task,
          }));
          return cleanAcceptedTask(store, task);
        });
      } else if (command === "cleanup" || command === "cleanup-status") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        data = withTaskStartLock(location, id, () => {
          const { store, task } = onBoard(location, store => {
            const task = readTask(store, id);
            if (command === "cleanup" && !isArchived(store, id) && hasPending(store, task)) {
              throw new TaskboardError("PENDING_OPERATION", "Retry the interrupted Git operation before modifying the task.");
            }
            return { store, task };
          });
          return command === "cleanup" ? cleanTaskWorktree(store, task, input.artifacts) : inspectCleanup(store, task);
        });
      } else if (command === "preview") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        const { store, task } = onBoard(location, store => ({ store, task: previewTask(store, id) }));
        data = previewSubmission(store, task, values.compact === true, input);
        onBoard(location, store => previewTask(store, id, task.revision));
      } else if (command === "review-artifact") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        const artifact = onBoard(location, store => {
          const task = store.card(id);
          requireState(task, ["review"]);
          requireRevision(task, input.revision, true);
          return openReviewArtifact(store, id, input);
        });
        data = readReviewArtifact(artifact);
      } else if (command === "review-queue") {
        if (id !== undefined || Object.keys(input).length) {
          throw new TaskboardError("INVALID_INPUT", "Review queue takes no arguments.");
        }
        const snapshot = onBoard(location, store => ({ store, tasks: store.snapshot().tasks.filter(task => task.status === "review") }));
        data = inspectReviewQueue(snapshot.store, snapshot.tasks);
      } else if (command === "review" && input.paths !== undefined) {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        const task = onBoard(location, store => store.card(id));
        data = inspectReviewDiff(location.repository, task, input);
      } else if (command === "review") {
        if (!id) throw new TaskboardError("INVALID_INPUT", "Supply a task ID.");
        const compact = input.compact === true;
        const { store, task, details } = onBoard(location, store => {
          const task = store.card(id);
          return { store, task, details: reviewDetails(store, task, compact) };
        });
        const review = inspectReview(store, task, details, compact, input.previousTargetHead, input.previousSubmitted);
        if (!compact) onBoard(location, latest => {
          const card = latest.card(id);
          requireState(card, ["review"]);
          requireRevision(card, task.revision, true);
          if (exists(latest.pendingPath(id)) !== details.pending ||
              latest.index.settings.integrationMode !== store.index.settings.integrationMode) {
            throw new TaskboardError("REVISION_CONFLICT", "The submission changed. Open the current review.");
          }
        });
        data = reviewWithSettings(store, review, input);
      } else if (command === "git") {
        const action = member(id, ["refs", "inspect", "switch", "create", "detach", "publish", "push"], "action");
        if (action === "inspect") data = inspectRepository(location, input);
        else if (action === "publish") data = await publishRepository(location, input);
        else if (action === "push") data = await pushRepositoryBranch(location, input);
        else data = onBoard(location, () => action === "refs" ? repositoryRefs(location) : changeRepository(location, action, input));
      } else {
        data = command === "init" ? initializeBoard(location, store => snapshotBoard(store, values.compact === true)) :
          onBoard(location, (store, lockWaitMs) => run(store, command, id, extra, input, values, lockWaitMs));
      }
      if (command === "show") {
        const task = data as Pick<Task, "status" | "git">;
        if (task.status === "done") data = { ...task, acceptedTreeMatchesSubmission: compareAcceptedTree(location.repository, task.git) };
      }
      send({ ok: true, data });
      const repo = location.repository;
      if (repo && ((command === "accept" && (data as Task).git?.accepted) ||
          (command === "submit" && (data as Task).git?.submission))) {
        scheduleGitMaintenance(repo.root);
      }
    }
  }
}

void main().catch(fail);
