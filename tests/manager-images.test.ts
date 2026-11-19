import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readManagerImage, saveManagerImage } from "../src/desktop/manager-images.ts";
import { readManagerHistory, saveManagerHistory } from "../src/desktop/manager-history.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");

test("manager image copies survive provider cleanup and reopening with their history references", async t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-manager-images-"));
  t.after(() => rmSync(project, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(project, ".tasks"));
  const source = join(project, "provider.png");
  writeFileSync(source, png);
  const first = await saveManagerImage(project, { id: "first", result: png.toString("base64") });
  const second = await saveManagerImage(project, { id: "second", savedPath: source });
  assert.ok(first && second);
  assert.notEqual(first, second);
  unlinkSync(source);
  const items = [first, second].map((file, index) => ({
    id: "image-" + index, type: "imageGeneration", status: "completed", title: "", text: "",
    generatedImage: { file }, providerTurnId: "turn-1",
  }));
  saveManagerHistory(project, Date.now(), "11111111-1111-4111-8111-111111111111", { lane: "chat", items });
  const reopened = readManagerHistory(project, null, "chat")!;
  assert.deepEqual(reopened.turns.flatMap(turn => turn.items), items);
  for (const file of [first, second]) {
    assert.deepEqual(readManagerImage(project, file), { type: "image/png", data: png });
  }
  for (const file of [source, "../provider.png", first + "\n", first.toUpperCase(), {}, null]) {
    assert.equal(readManagerImage(project, file), undefined);
  }
  unlinkSync(join(project, ".tasks/manager-images", first));
  assert.equal(readManagerImage(project, first), undefined);
  assert.deepEqual(readManagerImage(project, second)?.data, png);
  assert.deepEqual(readManagerHistory(project)!.turns[0]!.items, items);
});

test("a failed manager image leaves other results readable and a later valid image can be saved", async t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-manager-images-"));
  t.after(() => rmSync(project, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(project, ".tasks"));
  for (const image of [
    { id: "missing" }, { id: "invalid", result: "%%%" },
    { id: "not-image", result: Buffer.from("text").toString("base64") },
    { id: "bad-path", savedPath: join(project, "missing.png") },
  ]) {
    assert.equal(await saveManagerImage(project, image), undefined);
  }
  assert.deepEqual(readdirSync(join(project, ".tasks/manager-images")), []);
  const saved = await saveManagerImage(project, { id: "valid", result: png.toString("base64") });
  assert.deepEqual(readManagerImage(project, saved)?.data, png);
});
