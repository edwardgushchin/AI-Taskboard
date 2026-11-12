import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

type Request = <Result>(method: string, params: object) => Promise<Result>;
type Project = { id: string; roots: { path: string }[] };

function pathKey(path: string) {
  let absolute = resolve(path);
  try {
    absolute = realpathSync.native(absolute);
  } catch {
    // A provider may still list paths for disconnected drives.
  }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export async function codexProject(request: Request, project: string): Promise<string> {
  const root = realpathSync.native(project);
  const key = pathKey(root);
  let cursor: string | null = null;
  do {
    const page: { data: Project[]; nextCursor: string | null } = await request("project/list", { cursor, limit: 100 });
    const existing = page.data.find(entry => entry.roots.some(folder => isAbsolute(folder.path) && pathKey(folder.path) === key));
    if (existing) return existing.id;
    cursor = page.nextCursor;
  } while (cursor);

  const created = await request<{ project: Project }>("project/create", {
    name: basename(root) || root,
    roots: [{ path: root }],
    idempotencyKey: "ai-taskboard-" + createHash("sha256").update(key).digest("hex"),
  });
  return created.project.id;
}
