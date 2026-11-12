import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { configuredCodex } from "./codex.ts";

interface ModelPage {
  data: { model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[];
  nextCursor?: string | null;
}

export async function executionModels(profile: string, project: string) {
  const client = await configuredCodex(profile);
  if (!client) throw new Error("Connect Codex in AI Taskboard settings.");
  const child = spawn(client.path, [...client.args, "app-server"], {
    cwd: project, env: client.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const reader = createInterface({ input: child.stdout });
  const lines = reader[Symbol.asyncIterator]();
  let reason = "Codex closed while loading available models.";
  function close(message: string) {
    reason = message;
    reader.close();
  }
  child.on("error", error => close(error.message));
  child.stdin.on("error", error => close(error.message));
  const timeout = setTimeout(() => close("Codex did not return available models in time."), 20_000);
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  let nextId = 0;
  async function request<R>(method: string, params: object): Promise<R> {
    const id = nextId++;
    send({ id, method, params });
    for (;;) {
      const line = await lines.next();
      if (line.done) throw new Error(reason);
      const response = JSON.parse(line.value);
      if (response.id !== id || response.method) continue;
      if (response.error) throw new Error(response.error.message);
      return response.result;
    }
  }
  try {
    await request("initialize", { clientInfo: { name: "ai_taskboard", version: "0.1.0" } });
    send({ method: "initialized" });
    const models: ModelPage["data"] = [];
    let cursor: string | null = null;
    do {
      const page: ModelPage = await request("model/list", { cursor, includeHidden: false, limit: 100 });
      models.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return models.map(model => ({
      id: model.model, name: model.displayName,
      efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort),
    }));
  } finally {
    clearTimeout(timeout);
    reader.close();
    child.stdin.end();
    child.kill();
  }
}
