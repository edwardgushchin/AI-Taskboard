import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maxAttachmentBytes } from "../src/cli/model.ts";
import type { RunActivity, Task } from "../src/cli/model.ts";
import { imageViewPath, readRunImage } from "../src/desktop/run-images.ts";

const viewed = (path: string): RunActivity => ({ id: path, type: "imageView", status: "completed", title: "",
  text: JSON.stringify({ path, startedAtMs: 1, completedAtMs: 1 }) });

test("only completed image-view events identify readable image paths", () => {
  assert.equal(imageViewPath(viewed("C:\\project\\снимок.png")), "C:\\project\\снимок.png");
  for (const item of [
    { ...viewed("x.png"), type: "commandExecution" }, { ...viewed("x.png"), status: "failed" },
    { ...viewed("x.png"), status: "inProgress" }, { ...viewed("x.png"), text: "not JSON" },
    { ...viewed("x.png"), text: "null" }, { ...viewed("x.png"), text: '{"path":42}' },
    viewed(""), viewed("x\0.png"),
  ]) assert.equal(imageViewPath(item), undefined);
});

test("live and saved views read their own files, resolving relative paths in the task worktree", async () => {
  const project = await mkdtemp(join(tmpdir(), "taskboard-run-images-"));
  try {
    const worktree = join(project, "worktree");
    await mkdir(worktree);
    const first = Buffer.from("first image");
    const second = Buffer.from("second image");
    await writeFile(join(project, "reference.png"), "wrong root");
    await writeFile(join(worktree, "reference.png"), first);
    const otherPath = join(project, "второе изображение.JPG");
    await writeFile(otherPath, second);
    const task: Pick<Task, "history" | "git"> = { history: [], git: { worktree, target: "main", branch: "task", base: "base" } };
    const live = [viewed("reference.png"), viewed(otherPath)];
    assert.deepEqual((await readRunImage(project, task, live, "reference.png"))?.data, first);
    assert.equal((await readRunImage(project, task, live, otherPath))?.type, "image/jpeg");
    assert.deepEqual((await readRunImage(project, task, live, otherPath))?.data, second);
    task.history.push({ at: "2026-11-12T15:00:00Z", actor: "agent", action: "run-log", run: live });
    assert.deepEqual((await readRunImage(project, task, [], "reference.png"))?.data, first);
    assert.equal(await readRunImage(project, task, [], join(project, "reference.png")), null, "unlogged paths are refused");
    assert.equal(await readRunImage(project, task, [], otherPath + ".png"), null);
    await rm(otherPath);
    assert.equal(await readRunImage(project, task, [], otherPath), null, "removed files are unavailable");
  } finally { await rm(project, { recursive: true }); }
});

test("unsupported, oversized and non-file sources are unavailable without throwing", async () => {
  const project = await mkdtemp(join(tmpdir(), "taskboard-run-image-errors-"));
  try {
    const task = { history: [] };
    await writeFile(join(project, "large.png"), "");
    await truncate(join(project, "large.png"), maxAttachmentBytes + 1);
    await writeFile(join(project, "source.svg"), "<svg/>");
    await mkdir(join(project, "directory.png"));
    for (const path of ["large.png", "source.svg", "directory.png", "missing.png"]) {
      assert.equal(await readRunImage(project, task, [viewed(path)], path), null);
    }
  } finally { await rm(project, { recursive: true }); }
});
