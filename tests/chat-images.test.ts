import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { addAttachment, addChatMessage, readAttachment, readTask, restoreReplyImages, sweepArchives } from "../src/cli/archive.ts";
import { BoardStore, initializeBoard, validateCard } from "../src/cli/storage.ts";
import { changeTask, createTask } from "../src/cli/tasks.ts";
import { maxAttachmentBytes } from "../src/cli/model.ts";
import { saveChatImages } from "../src/desktop/chat-images.ts";

const parent = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const settings = { model: "test-model", effort: "low" };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(parent, ".chat-images-test-"));
  t.after(() => {
    assert.equal(dirname(realpathSync(root)), parent);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const location = { root, directory: join(root, ".tasks"), repository: null };
  return { root, store: initializeBoard(location, store => store) };
}

test("five generated images stay ordered after reopening and archiving the chat", async t => {
  const { root, store } = fixture(t);
  const scratch = join(root, "generated");
  mkdirSync(scratch);
  const bytes = Array.from({ length: 5 }, (_, index) => Buffer.concat([png, Buffer.from(String(index))]));
  const savedPath = join(root, "provider-image");
  writeFileSync(savedPath, bytes[2]);
  const sources = await saveChatImages(bytes.map((data, index) => ({
    id: String(index),
    ...(index === 2 ? { savedPath } : { result: (index === 1 ? "data:image/png;base64," : "") + data.toString("base64") }),
  })), scratch, maxAttachmentBytes);
  assert.deepEqual(sources.map(source => source.name), [1, 2, 3, 4, 5].map(index => "generated-" + index + ".png"));
  const task = store.create(createTask("T-0001", { title: "Images" }));
  const sent = addChatMessage(store, task, { ...settings, text: "Show five variants." });
  const reply = { ...settings, actor: "agent", text: "", replyTo: sent.history.length - 1,
    attachmentSources: sources, commentary: ["Prepared the variants."], usage: { used: 10, limit: 100 } };
  const answered = addChatMessage(store, sent, reply);
  assert.equal(answered.history.at(-1)?.text, undefined);
  assert.deepEqual(answered.history.at(-1)?.chat, { ...settings, files: answered.attachments.map(file => file.file),
    commentary: reply.commentary, usage: reply.usage });
  // Provider and temporary files are no longer needed by the stored conversation.
  rmSync(savedPath);
  for (const source of sources) rmSync(source.path);
  let reopened = new BoardStore(store.location);
  assert.deepEqual(readTask(reopened, task.id).history, answered.history);
  function checkImages() {
    const card = readTask(reopened, task.id);
    assert.deepEqual(card.history.findLast(event => event.chat && event.actor === "agent")?.chat?.files, card.attachments.map(file => file.file));
    card.attachments.forEach((file, index) => {
      const saved = readAttachment(reopened, task.id, { file: file.file });
      assert.ok("base64" in saved);
      assert.equal(saved.base64, bytes[index].toString("base64"));
    });
  }
  checkImages();
  const closed = store.save(changeTask(answered, "cancel", { reason: "Archive the chat" }));
  store.index.settings.archiveAfterDays = 0;
  store.saveIndex();
  assert.deepEqual(sweepArchives(store).archived, [task.id]);
  reopened = new BoardStore(store.location);
  assert.deepEqual(readTask(reopened, task.id).history, closed.history);
  checkImages();
});

test("image failures and stale replies do not save part of an agent reply", async t => {
  const { root, store } = fixture(t);
  const task = store.create(createTask("T-0001", { title: "Images" }));
  const sent = addChatMessage(store, task, { ...settings, text: "Show images." });
  const source = join(root, "source.png");
  writeFileSync(source, png);
  const reply = { ...settings, actor: "agent", text: "Variants", replyTo: sent.history.length - 1 };
  const unchanged = () => {
    assert.deepEqual(store.card(task.id), sent);
    assert.deepEqual(store.card(task.id).attachments, []);
  };
  assert.throws(() => addChatMessage(store, sent, { ...reply, attachmentSources: [{ path: source }, { path: root }] }),
    { code: "INVALID_INPUT" });
  unchanged();
  assert.throws(() => addChatMessage(store, sent, { ...reply, text: "" }), { code: "INVALID_INPUT" });
  unchanged();
  const large = join(root, "too-large.png");
  writeFileSync(large, "");
  truncateSync(large, maxAttachmentBytes + 1);
  assert.throws(() => addChatMessage(store, sent, { ...reply, attachmentSources: [{ path: source }, { path: large }] }),
    { code: "ATTACHMENT_LIMIT" });
  unchanged();
  const save = store.save;
  store.save = () => { throw new Error("Fixture write failure"); };
  assert.throws(() => addChatMessage(store, sent, { ...reply, attachmentSources: [{ path: source }] }), /Fixture write failure/);
  store.save = save;
  unchanged();
  assert.deepEqual(readdirSync(join(store.location.directory, "attachments", task.id)), []);
  const answered = addChatMessage(store, sent, { ...reply, attachmentSources: [{ path: source }] });
  assert.throws(() => addChatMessage(store, answered, { ...reply, attachmentSources: [{ path: source }] }), { code: "CHAT_CHANGED" });
  assert.deepEqual(store.card(task.id), answered);

  let attempt = 0;
  const output = () => { const folder = join(root, "attempt-" + attempt++); mkdirSync(folder); return folder; };
  await assert.rejects(saveChatImages([{ id: "missing" }], output(), maxAttachmentBytes), /without downloadable content/);
  await assert.rejects(saveChatImages([{ id: "invalid", result: "%%%" }], output(), maxAttachmentBytes), /invalid image/);
  await assert.rejects(saveChatImages([{ id: "invalid", result: "YQ" }], output(), maxAttachmentBytes), /unsupported or invalid image/);
  await assert.rejects(saveChatImages([{ id: "unreadable", savedPath: join(root, "missing.png") }], output(), maxAttachmentBytes), { code: "ENOENT" });
  const image = { id: "valid", result: png.toString("base64") };
  await assert.rejects(saveChatImages([image, { ...image, id: "second" }], output(), png.length), /64 MiB/);
  await assert.rejects(saveChatImages([{ id: "large", savedPath: large }], output(), maxAttachmentBytes), /64 MiB/);
});

test("known image files restore an existing reply without changing the conversation", t => {
  const { root, store } = fixture(t);
  const task = store.create(createTask("T-0001", { title: "Images" }));
  const sent = addChatMessage(store, task, { ...settings, text: "Show images." });
  const answered = addChatMessage(store, sent, { ...settings, actor: "agent", text: "Here they are.", replyTo: sent.history.length - 1 });
  const source = join(root, "source.png");
  writeFileSync(source, png);
  const replyAt = answered.history.length - 1;
  const input = { replyAt, revision: answered.revision, attachmentSources: [{ path: source }] };
  assert.throws(() => restoreReplyImages(store, answered, { ...input, replyAt: replyAt - 1 }), { code: "CHAT_CHANGED" });
  const restored = restoreReplyImages(store, answered, input);
  assert.deepEqual(restored.history[replyAt], {
    ...answered.history[replyAt], chat: { ...answered.history[replyAt].chat, files: [restored.attachments[0].file] },
  });
  assert.deepEqual(restored.history.slice(0, replyAt), answered.history.slice(0, replyAt));
  assert.equal(restored.history.length, answered.history.length);
  assert.equal(restored.status, answered.status);
  assert.throws(() => restoreReplyImages(store, restored, input), { code: "REVISION_CONFLICT" });
  assert.throws(() => restoreReplyImages(store, restored, { ...input, revision: restored.revision }), { code: "CHAT_CHANGED" });
});

test("standalone attachments keep exact event references after reopening and archiving", t => {
  const { root, store } = fixture(t);
  const source = join(root, "source.png");
  writeFileSync(source, png);
  let task = store.create(createTask("T-0001", { title: "Standalone images" }));
  task = addAttachment(store, task, { path: source, name: "same.png", actor: "agent" });
  task = addAttachment(store, task, { path: source, name: "same.png", actor: "user" });
  const expected = task.attachments.map(file => file.file);
  assert.deepEqual(task.history.filter(event => event.action === "attach").map(event => event.attachment), expected);
  assert.deepEqual(readTask(new BoardStore(store.location), task.id), task);
  const invalid = structuredClone(task);
  invalid.history.at(-1)!.attachment = "missing";
  assert.throws(() => validateCard(invalid, task.id), { code: "CORRUPT_STORAGE" });
  invalid.history.at(-1)!.attachment = expected[0];
  invalid.history.at(-1)!.action = "comment";
  assert.throws(() => validateCard(invalid, task.id), { code: "CORRUPT_STORAGE" });
  delete invalid.history.at(-1)!.attachment;
  assert.doesNotThrow(() => validateCard(invalid, task.id));
  const closed = store.save(changeTask(task, "cancel", { reason: "Archive images" }));
  store.index.settings.archiveAfterDays = 0;
  store.saveIndex();
  assert.deepEqual(sweepArchives(store).archived, [task.id]);
  assert.deepEqual(readTask(new BoardStore(store.location), task.id), closed);
  expected.forEach(file => {
    const saved = readAttachment(store, task.id, { file });
    assert.ok("base64" in saved);
    assert.equal(saved.base64, png.toString("base64"));
  });
});
