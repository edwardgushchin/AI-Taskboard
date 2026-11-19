import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { directory, readBinary } from "../cli/storage.ts";
import { saveChatImages } from "./chat-images.ts";
import type { ChatImage } from "./chat-images.ts";

const imageLimit = 64 * 1024 * 1024;
const imageTypes = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;

function imageDirectory(project: string, create = false) {
  const board = join(project, ".tasks");
  directory(board);
  const folder = join(board, "manager-images");
  directory(folder, create);
  return folder;
}

export async function saveManagerImage(project: string, image: ChatImage): Promise<string | undefined> {
  try {
    const [stored] = await saveChatImages([image], imageDirectory(project, true), imageLimit, randomUUID());
    return stored?.name;
  } catch {
    return undefined;
  }
}

export function readManagerImage(project: string, file: unknown) {
  if (typeof file !== "string") {
    return;
  }
  const match = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-1\.(png|jpg|gif|webp)$/.exec(file);
  if (!match || match[0] !== file) {
    return;
  }
  const extension = match[1] as keyof typeof imageTypes;
  try {
    const path = join(imageDirectory(project), file);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size === 0 || entry.size > imageLimit) {
      return;
    }
    return { type: imageTypes[extension], data: readBinary(path) };
  } catch {
    return undefined;
  }
}
