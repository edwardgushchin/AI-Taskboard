import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { maxAttachmentBytes } from "../cli/model.ts";
import type { RunActivity, Task } from "../cli/model.ts";
import { readReviewerChat } from "./reviewer-chat.ts";

export function imageViewPath(item: RunActivity): string | undefined {
  if (item.type !== "imageView" || item.status !== "completed") return;
  try {
    const path = JSON.parse(item.text)?.path;
    if (typeof path === "string" && path.trim() && !path.includes("\0")) return path;
  } catch { /* Incomplete or older tool output remains readable as text. */ }
}

// The renderer may request only files actually viewed in this task, never an arbitrary path.
export async function readRunImage(project: string, task: Pick<Task, "history" | "git">,
  live: RunActivity[], path: string) {
  if (!live.some(item => imageViewPath(item) === path) &&
      !task.history.some(event => event.run?.some(item => imageViewPath(item) === path))) return null;
  return readViewedImage(task.git?.worktree ?? project, path);
}

export async function readReviewerImage(project: string, id: string, path: string) {
  try {
    if (!readReviewerChat(project, id).some(attempt => attempt.items.some(item => imageViewPath(item) === path))) return null;
  } catch { return null; }
  // Reviewer sessions run from the board root.
  return readViewedImage(project, path);
}

export async function readViewedImage(cwd: string, path: string) {
  const type = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
    [".gif", "image/gif"], [".webp", "image/webp"]]).get(extname(path).toLowerCase());
  if (!type) return null;
  try {
    const file = await open(resolve(cwd, path), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxAttachmentBytes) return null;
      const data = await file.readFile();
      if (data.length > maxAttachmentBytes) return null;
      return { data, type, name: basename(path.replaceAll("\\", "/")) };
    } finally { await file.close(); }
  } catch { return null; }
}
