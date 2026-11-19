import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChatImage {
  id: string;
  status?: string;
  result?: string;
  savedPath?: string;
}

export async function saveChatImages(images: ChatImage[], directory: string, limit: number, stem = "generated") {
  const sources: { path: string; name: string }[] = [];
  for (const image of images) {
    let data: Buffer;
    if (typeof image.result === "string" && image.result) {
      const encoded = image.result.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/i, "");
      if (encoded.length > 4 * Math.ceil(limit / 3)) throw new Error("Attachments are limited to 64 MiB per task.");
      if (!/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new Error("Codex returned an invalid image.");
      data = Buffer.from(encoded, "base64");
      if (data.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
        throw new Error("Codex returned an invalid image.");
      }
    } else if (typeof image.savedPath === "string" && image.savedPath) {
      const file = await stat(image.savedPath);
      if (!file.isFile()) throw new Error("Codex returned an invalid image path.");
      if (file.size > limit) throw new Error("Attachments are limited to 64 MiB per task.");
      data = await readFile(image.savedPath);
    } else {
      throw new Error("Codex returned an image without downloadable content.");
    }
    if (data.length > limit) throw new Error("Attachments are limited to 64 MiB per task.");
    limit -= data.length;
    const extension = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? ".png"
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? ".jpg"
      : /^GIF8[79]a$/.test(data.toString("ascii", 0, 6)) ? ".gif"
      : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? ".webp" : undefined;
    if (!extension) throw new Error("Codex returned an unsupported or invalid image.");
    const name = stem + "-" + (sources.length + 1) + extension;
    const path = join(directory, name);
    await writeFile(path, data, { flag: "wx" });
    sources.push({ path, name });
  }
  return sources;
}
