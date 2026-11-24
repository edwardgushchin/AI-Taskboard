import { beginBoardOperation } from "../desktop/board-worklog.ts";
import { captureFileLink, isFileLink, snapshotFileLink, verifyFileLink } from "./attachment-links.ts";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { unzipSync, zipSync } from "fflate";
import { hasDraftConfirmation, imageAttachmentPattern, invalidateDraftDiscussion, maxAttachmentBytes, number, object, record, registerTags, requireRevision, requireState, strings, TaskboardError, text } from "./model.ts";
import type { ArchiveLink, Attachment, BoardTag, Task } from "./model.ts";
import { directory, exists, readBinary, removeFile, validateCard, writeAtomic } from "./storage.ts";
import type { BoardStore } from "./storage.ts";
import { linkedDraftManagerReply, managerInbox } from "./task-messages.ts";
import { actorFor, parseRunEntries, withoutVerification } from "./tasks.ts";

const maxCard = 16 * 1024 * 1024;
const day = 24 * 60 * 60 * 1000;

interface ArchivedTask {
  task: Task;
  card: Buffer;
  zip?: Buffer;
}

function checksum(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function verifyBytes(attachment: Attachment, data: Uint8Array): void {
  if (data.length !== attachment.bytes || checksum(data) !== attachment.sha256) {
    throw new TaskboardError("ATTACHMENT_CORRUPT", "The attachment no longer matches its recorded content.", {
      file: attachment.file,
    });
  }
}

function archivePath(store: BoardStore, link: ArchiveLink): string {
  return join(store.subdirectory("archive"), basename(link.path));
}

function attachmentFolder(store: BoardStore, task: Task, create = false): string {
  const path = join(store.subdirectory("attachments"), task.id);
  if (create || exists(path)) directory(path, create);
  return path;
}

function activeBytes(store: BoardStore, task: Task, attachment: Attachment): Buffer {
  const path = join(attachmentFolder(store, task), attachment.file);
  const data = readBinary(path);
  verifyBytes(attachment, data);
  return data;
}

function closedAt(task: Task): string | undefined {
  return task.closedAt ?? task.history.findLast(event => event.to === task.status)?.at;
}

function openArchive(store: BoardStore, id: string, link: ArchiveLink): ArchivedTask {
  try {
    const data = readBinary(archivePath(store, link));
    const zipped = link.path.endsWith(".zip");
    const card = zipped
      ? unzipSync(data, { filter: entry => entry.name === "task.json" && entry.originalSize <= maxCard })["task.json"]
      : gunzipSync(data, { maxOutputLength: maxCard });
    if (!card) throw new Error("Archive has no readable task.json.");
    const bytes = Buffer.from(card);
    const task = validateCard(JSON.parse(bytes.toString("utf8")), id);
    const closure = closedAt(task) ?? (task.status === "cancelled" ? task.updatedAt : undefined);
    if (task.status !== link.status || task.title !== link.title || closure !== link.closedAt ||
        (link.tags !== undefined && JSON.stringify(link.tags) !== JSON.stringify(task.tags)) ||
        zipped !== (task.attachments.length > 0) ||
        task.attachments.reduce((total, entry) => total + (entry.link ? 0 : entry.bytes), 0) > maxAttachmentBytes) {
      throw new Error("The archived card differs from the archive index.");
    }
    return { task, card: bytes, zip: zipped ? data : undefined };
  } catch (error) {
    throw new TaskboardError("ARCHIVE_CORRUPT", "Could not read the archive for " + id + ".", {
      cause: (error as Error).message,
    });
  }
}

function archivedBytes(archive: ArchivedTask, attachments: Attachment[]): Record<string, Uint8Array> {
  attachments = attachments.filter(file => !file.link);
  if (!attachments.length) return {};
  if (!archive.zip) throw new TaskboardError("ARCHIVE_CORRUPT", "Missing archived attachments.");
  const expected = new Map(attachments.map(entry => ["attachments/" + entry.file, entry]));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive.zip, { filter: entry => expected.get(entry.name)?.bytes === entry.originalSize });
  } catch (error) {
    throw new TaskboardError("ARCHIVE_CORRUPT", "Could not decompress archived attachments.", {
      cause: (error as Error).message,
    });
  }
  for (const [path, attachment] of expected) {
    if (!Object.hasOwn(entries, path)) {
      throw new TaskboardError("ARCHIVE_CORRUPT", "An attachment is missing from the archive.", { file: attachment.file });
    }
    verifyBytes(attachment, entries[path]);
  }
  return entries;
}

export function isArchived(store: BoardStore, id: string): boolean {
  return Object.hasOwn(store.index.archive, id);
}

export function readTask(store: BoardStore, id: string): Task {
  if (!isArchived(store, id)) return store.card(id);
  const link = store.index.archive[id];
  const { task } = openArchive(store, id, link);
  if (link.codexArchivePending) task.codexArchivePending = link.codexArchivePending;
  else delete task.codexArchivePending;
  const edit = link.tagOverride;
  return edit ? { ...task, tags: edit.tags, history: [...task.history, ...edit.history],
    revision: task.revision + edit.history.length, updatedAt: edit.history.at(-1)!.at } : task;
}

export function reactivateArchivedTask(store: BoardStore, draft: Task): Task {
  const link = store.index.archive[draft.id];
  const archive = openArchive(store, draft.id, link);
  const bytes = archivedBytes(archive, draft.attachments);
  for (const file of draft.attachments.filter(file => !file.link)) {
    const path = join(attachmentFolder(store, draft, true), file.file);
    if (exists(path)) verifyBytes(file, readBinary(path));
    else writeAtomic(path, bytes["attachments/" + file.file]);
  }
  store.save(draft);
  delete store.index.archive[draft.id];
  store.index.tasks[draft.id] = "tasks/" + draft.id + ".json";
  store.saveIndex();
  return draft;
}

export function setAttachmentCover(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  requireRevision(task, input.revision);
  const file = text(input.file, "file", true);
  const attachment = task.attachments.find(entry => entry.file === file);
  if (!attachment || !imageAttachmentPattern.test(attachment.name)) {
    throw new TaskboardError("INVALID_INPUT", "Choose an image attached to this task.");
  }
  if (task.coverAttachment === file) return task;
  const updated = record({ ...task, coverAttachment: file }, "cover", "user");
  return store.save({ ...updated, closedAt: task.closedAt });
}

export function upgradeTagCatalog(store: BoardStore, persist = true): BoardTag[] {
  if (store.index.tags !== undefined) return store.index.tags;
  const names = Object.keys(store.index.tasks).flatMap(id => store.card(id).tags);
  for (const [id, link] of Object.entries(store.index.archive)) {
    if (link.tags === undefined) {
      try {
        link.tags = openArchive(store, id, link).task.tags;
      } catch (error) {
        if (!(error instanceof TaskboardError && error.code === "ARCHIVE_CORRUPT")) throw error;
        continue;
      }
    }
    for (const name of link.tagOverride?.tags ?? link.tags) names.push(name);
  }
  const tags: BoardTag[] = [];
  registerTags(tags, names);
  store.index.tags = tags;
  if (persist) store.saveIndex();
  return tags;
}

function loadAttachment(input: Record<string, unknown>, limit: number) {
  if (input.link !== undefined) {
    const link = input.link === true ? captureFileLink(resolve(text(input.path, "path", true))) : input.link;
    if (!isFileLink(link) || link.path !== resolve(text(input.path, "path", true))) throw new TaskboardError("INVALID_INPUT", "Invalid attachment link.");
    const attachment: Attachment = { name: input.name === undefined ? basename(link.path) : text(input.name, "name", true),
      file: randomUUID(), bytes: link.size, sha256: "", link };
    return { attachment, data: undefined };
  }
  const source = realpathSync(resolve(text(input.path, "path", true)));
  const entry = statSync(source);
  if (!entry.isFile()) throw new TaskboardError("INVALID_INPUT", "Choose a file to attach.");
  if (entry.size > limit) throw new TaskboardError("ATTACHMENT_LIMIT", "Attachments are limited to 64 MiB per task.");
  const data = readBinary(source);
  if (data.length > limit) throw new TaskboardError("ATTACHMENT_LIMIT", "Attachments are limited to 64 MiB per task.");
  const attachment: Attachment = {
    name: input.name === undefined ? basename(source) : text(input.name, "name", true),
    file: randomUUID(), bytes: data.length, sha256: checksum(data),
  };
  return { attachment, data };
}

export function createWithAttachments(store: BoardStore, task: Task, sources: unknown): Task {
  return withNewAttachments(store, task, sources, attachments => store.create({ ...task, attachments }),
    () => exists(store.cardPath(task.id)));
}

function withNewAttachments(
  store: BoardStore, task: Task, sources: unknown, save: (attachments: Attachment[]) => Task,
  keepOnError = () => false,
): Task {
  if (sources === undefined) return save([]);
  if (!Array.isArray(sources)) throw new TaskboardError("INVALID_INPUT", "attachmentSources must be an array.");
  if (!sources.length) return save([]);

  let remaining = maxAttachmentBytes - task.attachments.reduce((sum, item) => sum + (item.link ? 0 : item.bytes), 0);
  const files = sources.map(source => {
    const file = loadAttachment(object(source), remaining);
    remaining -= file.attachment.link ? 0 : file.attachment.bytes;
    return file;
  });
  const folder = attachmentFolder(store, task, true);
  const written: string[] = [];
  try {
    for (const { attachment, data } of files) {
      if (data === undefined) continue;
      const path = join(folder, attachment.file);
      writeAtomic(path, data);
      written.push(path);
    }
    return save(files.map(file => file.attachment));
  } catch (error) {
    // A saved card whose index update failed can be recovered by doctor with its files.
    if (!keepOnError()) {
      for (const path of written) removeFile(path);
    }
    throw error;
  }
}

export function addChatMessage(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  const draftDiscussion = input.draftDiscussion === true;
  const actor = actorFor(input, "user");
  const { requestId, waitForLimit } = input;
  if (requestId !== undefined && (actor !== "user" || typeof requestId !== "string" ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(requestId)) ||
      waitForLimit !== undefined && (actor !== "user" || typeof waitForLimit !== "boolean")) {
    throw new TaskboardError("INVALID_INPUT", "Invalid queued chat message.");
  }
  if (requestId && task.history.some(event => event.actor === "user" && event.chat?.requestId === requestId)) {
    return task;
  }
  const pending = task.pendingLimitChat;
  let repliesToPending = false;
  const pendingManagerReply = task.draftDiscussion?.managerReply;
  const managerReply = draftDiscussion && input.managerReply !== undefined
    ? number(input.managerReply, "managerReply") : undefined;
  if (draftDiscussion) {
    if (actor !== "agent" || task.status !== "draft" || task.draftDiscussion?.phase !== "running") {
      throw new TaskboardError("CHAT_CHANGED", "The draft discussion is no longer awaiting a reply.");
    }
    const revision = number(input.revision, "revision");
    if (revision < task.revision) {
      // Discard the answer and requeue under the same board lock.
      return store.save(record({
        ...task, draftConfirmed: false, draftDiscussion: { phase: "queued", managerReply: pendingManagerReply },
      }, "draft-discussion-queued", "agent"));
    }
    if (managerReply !== undefined && (managerReply > (pendingManagerReply ?? 0) ||
        managerReply <= (task.draftManagerReplyThrough ?? 0) ||
        !linkedDraftManagerReply(task, task.history[managerReply - 1]))) {
      throw new TaskboardError("CHAT_CHANGED", "The manager reply is no longer awaiting discussion.");
    }
  }
  const at = input.at;
  if (at !== undefined && (actor !== "agent" || typeof at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
      !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)) {
    throw new TaskboardError("INVALID_INPUT", "Only an agent reply can supply an ISO timestamp from its first event.");
  }
  const message = text(input.text, "text");
  const model = text(input.model, "model", true);
  const effort = text(input.effort, "effort", true);
  if (input.awaitingAnswer !== undefined && (actor !== "agent" || typeof input.awaitingAnswer !== "boolean")) {
    throw new TaskboardError("INVALID_INPUT", "Only an agent reply can set a boolean awaitingAnswer state.");
  }
  const awaitingOwnerAnswer = input.awaitingOwnerAnswer;
  if (awaitingOwnerAnswer !== undefined &&
      (typeof awaitingOwnerAnswer !== "boolean" || typeof input.awaitingAnswer !== "boolean" ||
        (awaitingOwnerAnswer && !input.awaitingAnswer))) {
    throw new TaskboardError("INVALID_INPUT", "Only an agent reply can identify an open owner question.");
  }
  if (input.confirmsDraft !== undefined && (actor !== "agent" || task.status !== "draft" || draftDiscussion ||
      typeof input.confirmsDraft !== "boolean" || typeof input.awaitingAnswer !== "boolean" ||
      (input.confirmsDraft && input.awaitingAnswer))) {
    throw new TaskboardError("INVALID_INPUT", "Only a draft dialogue reply without an open question can confirm the draft.");
  }
  let queuedDuringReply = false;
  if (!draftDiscussion && actor === "agent") {
    const last = task.history.findLastIndex(event => event.chat);
    const replyTo = number(input.replyTo, "replyTo", 0);
    repliesToPending = pending?.[0] === replyTo;
    const newerPending = (pending ?? []).filter(index => index > replyTo);
    const onlyQueuedMessages = newerPending.length > 0 && task.history.slice(replyTo + 1).every((event, offset) =>
      !event.chat || newerPending.includes(replyTo + offset + 1));
    const startedBeforeQueue = onlyQueuedMessages && pending![0] > replyTo;
    if ((!repliesToPending && !startedBeforeQueue && (last !== replyTo || pending?.length)) ||
        !task.history[replyTo]?.chat || task.history[replyTo]?.actor !== "user") {
      throw new TaskboardError("CHAT_CHANGED", "The last chat message changed before the reply was saved.");
    }
    queuedDuringReply = onlyQueuedMessages && typeof input.revision === "number" &&
      task.revision === input.revision + newerPending.length;
  }
  if (!queuedDuringReply) {
    const revisableDraftReply = !draftDiscussion && actor === "agent" && task.status === "draft" && input.awaitingAnswer === false;
    requireRevision(task, input.revision, draftDiscussion || revisableDraftReply);
  }
  const requiresChoice = managerReply !== undefined && task.history[managerReply - 1].draftDependencyRequiresChoice;
  const awaitingAnswer = requiresChoice ? true : input.awaitingAnswer;
  const draftReply = actor === "agent" && task.status === "draft" && typeof awaitingAnswer === "boolean";
  const confirmsDraft = awaitingAnswer === false && (draftDiscussion || input.confirmsDraft === true);
  const usage = actor === "agent" && input.usage !== undefined ? object(input.usage) : undefined;
  const commentary = actor === "agent" && input.commentary !== undefined ? strings(input.commentary, "commentary") : [];
  const durationMs = actor === "agent" && input.durationMs !== undefined ? number(input.durationMs, "durationMs", 0) : undefined;
  const run = actor === "agent" && input.run !== undefined ? parseRunEntries(input.run) : undefined;
  const chat = {
    model, effort,
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(commentary.length ? { commentary } : {}),
    ...(usage ? { usage: { used: number(usage.used, "used", 0), limit: number(usage.limit, "limit") } } : {}),
  };
  return withNewAttachments(store, task, input.attachmentSources, attachments => {
    if (!message && !attachments.length) throw new TaskboardError("INVALID_INPUT", "Write a message or attach a file.");
    const current = attachments.length
      ? invalidateDraftDiscussion({ ...task, attachments: [...task.attachments, ...attachments] })
      : { ...task };
    if (actor === "user" && (waitForLimit || pending?.length)) {
      current.pendingLimitChat = [...(pending ?? []), task.history.length];
    } else if (repliesToPending) {
      current.pendingLimitChat = pending!.length > 1 ? pending!.slice(1) : undefined;
      if (current.limitChatContinuation?.index === pending![0]) delete current.limitChatContinuation;
    }
    if (actor === "user" && task.status === "draft") {
      // Keep the proof for an unchanged brief while awaiting the outcome of the dialogue.
      current.draftConfirmed = current.draftConfirmed === true || hasDraftConfirmation(current);
      current.awaitingAnswer = task.awaitingAnswer === true ? true : undefined;
      if (pendingManagerReply === undefined && task.draftDiscussion?.phase !== "failed") {
        current.draftDiscussion = undefined;
      }
    }
    if (typeof awaitingAnswer === "boolean") {
      current.awaitingAnswer = awaitingAnswer;
      current.awaitingOwnerAnswer = requiresChoice ? true : awaitingOwnerAnswer;
    }
    if (draftReply) {
      current.draftConfirmed = confirmsDraft || (!draftDiscussion && awaitingAnswer === false &&
        current.draftConfirmed === true);
      if (draftDiscussion) {
        current.draftDiscussion = pendingManagerReply === managerReply
          ? undefined : { phase: "queued", managerReply: pendingManagerReply };
        if (managerReply !== undefined) current.draftManagerReplyThrough = managerReply;
      } else if (pendingManagerReply === undefined && input.revision !== undefined &&
          (confirmsDraft || input.awaitingAnswer === true) && current.draftDiscussion?.phase !== "running") {
        current.draftDiscussion = undefined;
      }
    }
    const updated = record(current, "chat", actor, task.status, message);
    updated.history.at(-1)!.chat = {
      ...chat,
      ...(actor === "user" || attachments.length ? { files: attachments.map(attachment => attachment.file) } : {}),
    };
    if (typeof at === "string") updated.history.at(-1)!.at = at;
    if (durationMs !== undefined) updated.history.at(-1)!.durationMs = durationMs;
    if (run) updated.history.at(-1)!.run = run;
    return store.save(updated);
  });
}

export function restoreReplyImages(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  requireState(task, ["draft", "ready", "in_progress", "blocked", "review"]);
  requireRevision(task, input.revision, true);
  const replyAt = number(input.replyAt, "replyAt", 0);
  const reply = task.history[replyAt];
  const chat = reply?.chat;
  if (reply?.action !== "chat" || reply.actor !== "agent" || !chat || chat.files?.length) {
    throw new TaskboardError("CHAT_CHANGED", "Choose an agent reply without attachments.");
  }
  return withNewAttachments(store, task, input.attachmentSources, attachments => {
    if (!attachments.length || attachments.some(file => !imageAttachmentPattern.test(file.name))) {
      throw new TaskboardError("INVALID_INPUT", "Choose images to restore to the reply.");
    }
    const history = task.history.slice();
    history[replyAt] = { ...reply, chat: { ...chat, files: attachments.map(file => file.file) } };
    return store.save(invalidateDraftDiscussion({
      ...task, revision: task.revision + 1, updatedAt: new Date().toISOString(),
      history, attachments: [...task.attachments, ...attachments],
    }));
  });
}

export function addAttachment(store: BoardStore, task: Task, input: Record<string, unknown>): Task {
  requireState(task, ["draft", "ready", "in_progress", "blocked", "review"]);
  requireRevision(task, input.revision);
  const limit = maxAttachmentBytes - task.attachments.reduce((sum, item) => sum + (item.link ? 0 : item.bytes), 0);
  const { attachment, data } = loadAttachment(input, limit);
  const actor = actorFor(input, "agent");
  if (data !== undefined) writeAtomic(join(attachmentFolder(store, task, true), attachment.file), data);
  const attached = record(invalidateDraftDiscussion({
    ...task, attachments: [...task.attachments, attachment],
  }), "attach", actor, task.status, attachment.name);
  attached.history.at(-1)!.attachment = attachment.file;
  return store.save(attached);
}

export function readAttachment(store: BoardStore, id: string, input: Record<string, unknown>) {
  const archive = isArchived(store, id) ? openArchive(store, id, store.index.archive[id]) : undefined;
  const task = archive?.task ?? store.card(id);
  const file = text(input.file, "file", true);
  const attachment = task.attachments.find(entry => entry.file === file);
  if (!attachment) throw new TaskboardError("ATTACHMENT_NOT_FOUND", "The task does not have that attachment.");
  if (attachment.link) {
    if (input.snapshot === true) {
      const path = resolve(text(input.destination, "destination", true));
      snapshotFileLink(attachment.link, path);
      return { ...attachment, path };
    }
    const path = verifyFileLink(attachment.link);
    if (input.destination !== undefined) throw new TaskboardError("ATTACHMENT_LINK", "Open the linked source instead of copying it: " + path);
    return { ...attachment, path };
  }
  const data = archive
    ? Buffer.from(archivedBytes(archive, [attachment])["attachments/" + file])
    : activeBytes(store, task, attachment);
  if (input.destination !== undefined) {
    const path = resolve(text(input.destination, "destination", true));
    writeFileSync(path, data, { flag: "wx" });
    return { ...attachment, path };
  }
  return { ...attachment, base64: data.toString("base64") };
}

function checkOriginals(store: BoardStore, task: Task, card: Buffer): string[] {
  const cardFile = store.cardPath(task.id);
  const originals: string[] = [];
  if (exists(cardFile)) {
    if (!readBinary(cardFile).equals(card)) {
      throw new TaskboardError("ARCHIVE_ORIGINAL_CHANGED", "The original task was changed after archiving.", { id: task.id });
    }
    originals.push(cardFile);
  }
  const folder = attachmentFolder(store, task);
  if (!exists(folder)) return originals;
  const known = new Map(task.attachments.map(entry => [entry.file, entry]));
  for (const file of readdirSync(folder)) {
    const attachment = known.get(file);
    if (!attachment) {
      throw new TaskboardError("ATTACHMENT_UNINDEXED", "A local attachment is missing from the task index.", {
        id: task.id, file,
      });
    }
    const path = join(folder, file);
    verifyBytes(attachment, readBinary(path));
    originals.push(path);
  }
  return originals;
}

function removeOriginals(store: BoardStore, archive: ArchivedTask): void {
  const paths = checkOriginals(store, archive.task, archive.card);
  archivedBytes(archive, archive.task.attachments);
  for (const path of paths) removeFile(path);
  const folder = attachmentFolder(store, archive.task);
  if (exists(folder)) rmdirSync(folder);
}

function archiveTask(store: BoardStore, task: Task, now: Date, closure: string): void {
  if (task.status !== "done" && task.status !== "cancelled") return;
  if (exists(store.pendingPath(task.id))) {
    throw new TaskboardError("PENDING_OPERATION", "Finish the pending task operation before archiving.");
  }
  const finish = beginBoardOperation(store.location.root, "archive card", task.id);
  try {
    const card = readBinary(store.cardPath(task.id));
    if (card.length > maxCard) throw new TaskboardError("ARCHIVE_LIMIT", "The task card exceeds 16 MiB.");
    checkOriginals(store, task, card);
    const link: ArchiveLink = {
      path: "archive/" + task.id + (task.attachments.length ? ".zip" : ".json.gz"),
      title: task.title, status: task.status, closedAt: closure, archivedAt: now.toISOString(),
      codexArchivePending: task.codexArchivePending,
      updatedAt: task.updatedAt,
      tags: task.tags,
      milestone: task.milestone,
    };
    let compressed: Uint8Array;
    if (task.attachments.length) {
      const files: Record<string, Uint8Array> = { "task.json": card };
      for (const attachment of task.attachments.filter(file => !file.link)) {
        files["attachments/" + attachment.file] = activeBytes(store, task, attachment);
      }
      compressed = zipSync(files, { level: 6 });
    } else {
      compressed = gzipSync(card, { level: 6 });
    }
    writeAtomic(archivePath(store, link), compressed);
    const archive = openArchive(store, task.id, link);
    if (!archive.card.equals(card)) throw new TaskboardError("ARCHIVE_CORRUPT", "The archived JSON differs from the original.");
    archivedBytes(archive, archive.task.attachments);

    const activeLink = store.index.tasks[task.id];
    delete store.index.tasks[task.id];
    store.index.archive[task.id] = link;
    try {
      store.saveIndex();
    } catch (error) {
      store.index.tasks[task.id] = activeLink;
      delete store.index.archive[task.id];
      throw error;
    }
    removeOriginals(store, archive);
    finish("archived; original card removed after verification");
  } catch (error) { finish("failed; inspect archive recovery state"); throw error; }
}

export function archiveDiagnostics(store: BoardStore, repair: boolean, inspectAll = true) {
  const issues: { id: string; problem: string }[] = [];
  const cleaned: string[] = [];
  for (const [id, link] of Object.entries(store.index.archive)) {
    try {
      const originals = exists(store.cardPath(id)) || exists(join(store.subdirectory("attachments"), id));
      if (!inspectAll && !originals) continue;
      const archive = openArchive(store, id, link);
      if (originals && repair) {
        removeOriginals(store, archive);
        cleaned.push(id);
      } else {
        archivedBytes(archive, archive.task.attachments);
      }
    } catch (error) {
      issues.push({ id, problem: (error as Error).message });
    }
  }
  return { issues, cleaned };
}

export function sweepArchives(store: BoardStore, now = new Date()) {
  const { issues, cleaned } = archiveDiagnostics(store, true, false);
  const archived: string[] = [];
  const afterDays = store.index.settings.archiveAfterDays;
  if (afterDays === null) return { archived, cleaned, issues };
  for (const id of Object.keys(store.index.tasks)) {
    try {
      let task = store.card(id);
      if (task.status !== "done" && task.status !== "cancelled") continue;
      const compact = task.status === "done" ? withoutVerification(task) : task;
      if (compact !== task && !exists(store.pendingPath(id))) task = store.save(compact);
      const closure = closedAt(task);
      if (!closure || !(now.getTime() - Date.parse(closure) >= afterDays * day)) continue;
      if (managerInbox([task]).some(message => message.kind === "accept")) continue;
      archiveTask(store, task, now, closure);
      archived.push(id);
    } catch (error) {
      issues.push({ id, problem: (error as Error).message });
    }
  }
  return { archived, cleaned, issues };
}

// The CLI opens the store under the board lock before reading candidate cards.
export function archiveCancelled(store: BoardStore, now = new Date()) {
  const archived: string[] = [];
  const issues: { id: string; problem: string }[] = [];
  for (const id of Object.keys(store.index.tasks)) {
    try {
      const task = store.card(id);
      if (task.status !== "cancelled") continue;
      archiveTask(store, task, now, closedAt(task) ?? task.updatedAt);
    } catch (error) {
      issues.push({ id, problem: (error as Error).message });
    }
    // The move is visible once the index is saved, even if original cleanup fails.
    if (store.index.archive[id]) archived.push(id);
  }
  return { count: archived.length, archived, issues };
}
