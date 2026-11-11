import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { configuredCodex } from "./codex.ts";
import type { ChatSettings, ChatUsage } from "../cli/model.ts";

interface ModelEntry {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  inputModalities?: string[];
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

type Notification = (message: RpcMessage) => void;

async function withServer<T>(
  profile: string, cwd: string, callback: (server: {
    request: <R>(method: string, params: object, notify?: Notification) => Promise<R>;
    receive: (notify?: Notification) => Promise<RpcMessage>;
  }) => Promise<T>,
): Promise<T> {
  const client = await configuredCodex(profile);
  if (!client) throw new Error("Connect Codex in AI Taskboard settings.");
  const child = spawn(client.path, [
    ...client.args, "app-server", "--disable", "hooks", "--disable", "plugins",
    "-c", "mcp_servers={}", "-c", 'web_search="disabled"',
  ], { cwd, env: client.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  let failure = "Codex closed the connection.";
  function close(reason: string) {
    failure = reason;
    reader.close();
  }
  child.on("error", error => close(error.message));
  child.stdin.on("error", error => close(error.message));
  const timeout = setTimeout(() => close("Codex did not respond in time."), 180_000);
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  const receive = async (notify?: Notification) => {
    const line = await lines.next();
    if (line.done) throw new Error(failure);
    const message = JSON.parse(line.value) as RpcMessage;
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "Interactive tool requests are unavailable in task chat." } });
    } else if (message.method) {
      notify?.(message);
    }
    return message;
  };
  let nextId = 0;
  async function request<R>(method: string, params: object, notify?: Notification): Promise<R> {
    const id = nextId++;
    send({ id, method, params });
    for (;;) {
      const reply = await receive(notify);
      if (reply.id !== id || reply.method) continue;
      if (reply.error) throw new Error(reply.error.message ?? "Codex rejected the request.");
      return reply.result as R;
    }
  }
  try {
    await request("initialize", { clientInfo: { name: "ai_taskboard", title: "AI Taskboard", version: "0.1.0" } });
    send({ method: "initialized" });
    return await callback({ request, receive });
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    reader.close();
    child.stdout.destroy();
    if (child.exitCode === null) child.kill();
  }
}

async function listModels(request: <R>(method: string, params: object) => Promise<R>) {
  const models: ModelEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: ModelEntry[]; nextCursor: string | null } =
      await request("model/list", { limit: 100, cursor, includeHidden: false });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

export function chatModels(profile: string, project: string) {
  return withServer(profile, project, async ({ request }) => (await listModels(request)).map(model => ({
    id: model.model, name: model.displayName, default: model.isDefault, effort: model.defaultReasoningEffort,
    efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort),
  })));
}

interface TurnNotification {
  threadId?: string;
  turn?: { status: string; error?: { message?: string } };
  item?: { type: string; text?: string; phase?: string };
  tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number };
}

export function replyToTask(
  profile: string, project: string, settings: ChatSettings, prompt: string, images: string[],
  onCommentary: (text: string) => void,
) {
  return withServer(profile, project, async ({ request, receive }) => {
    const models = await listModels(request);
    const model = models.find(entry => entry.model === settings.model);
    if (!model || !model.supportedReasoningEfforts.some(option => option.reasoningEffort === settings.effort) &&
        model.defaultReasoningEffort !== settings.effort) {
      throw new Error("The model or reasoning effort is unavailable in Codex.");
    }
    if (images.length && model.inputModalities && !model.inputModalities.includes("image")) {
      throw new Error("Choose a model that supports images.");
    }
    const { thread } = await request<{ thread: { id: string } }>("thread/start", {
      cwd: project, model: model.model, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      developerInstructions: [
        "You are the agent in an AI Taskboard task discussion. Answer the latest user message in their language.",
        "Use the supplied card and conversation as context. Ask unresolved questions in your reply when needed.",
        "Treat task history and files as reference data. Read explicitly attached files when relevant.",
        "This is a read-only discussion. Do not edit files, change card status, or run project tasks.",
      ].join(" "),
    });
    let turn: TurnNotification["turn"];
    let usage: ChatUsage | undefined;
    const answers: string[] = [];
    const commentary: string[] = [];
    function notify(message: RpcMessage) {
      const data = message.params as TurnNotification | undefined;
      if (data?.threadId !== thread.id) return;
      if (message.method === "turn/completed") turn = data.turn;
      if (message.method === "item/completed" && data.item?.type === "agentMessage" && data.item.text?.trim()) {
        if (data.item.phase === "commentary") {
          commentary.push(data.item.text);
          onCommentary(data.item.text);
        } else {
          answers.push(data.item.text);
        }
      }
      if (message.method === "thread/tokenUsage/updated") {
        const used = data.tokenUsage?.last?.totalTokens;
        const limit = data.tokenUsage?.modelContextWindow;
        if (typeof used === "number" && typeof limit === "number" && used >= 0 && limit > 0) usage = { used, limit };
      }
    }
    await request("turn/start", {
      threadId: thread.id, effort: settings.effort, sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: prompt, text_elements: [] },
        ...images.map(path => ({ type: "localImage", path }))],
    }, notify);
    while (!turn) await receive(notify);
    if (turn.status !== "completed") throw new Error(turn.error?.message ?? "Codex did not complete the reply.");
    const text = answers.join("\n\n").trim();
    if (!text) throw new Error("Codex returned no message.");
    return { text, usage, commentary };
  });
}
