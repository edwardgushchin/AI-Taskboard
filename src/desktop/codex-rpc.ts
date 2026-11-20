import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { debuglog } from "node:util";

let onQuotaExceeded: (() => void) | undefined;

export function watchCodexQuotaExceeded(listener: () => void) {
  onQuotaExceeded = listener;
}

const traceRpc = debuglog("taskboard-rpc");

interface PendingReply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  startedAt: number;
}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

export class CodexRpcRejection extends Error {}

export interface AgentControl {
  steer(text: string, images: string[], clientUserMessageId?: string): Promise<void>;
  interrupt(): Promise<void>;
}

// One reader routes responses by id, so steering never competes with the turn monitor.
export function codexRpc(child: ChildProcess,
  onNotification: (message: RpcMessage) => void | Promise<void>,
  onRequest?: (message: RpcMessage) => Promise<object | undefined>) {
  const reader = createInterface({ input: child.stdout! });
  const pending = new Map<number, PendingReply>();
  const notifications: RpcMessage[] = [];
  let waiting: (() => void) | undefined;
  let failure: Error | undefined;
  let nextId = 0;
  const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
  function logReply(id: number, reply: PendingReply, outcome: string, receivedAt = performance.now()) {
    if (!traceRpc.enabled) return;
    traceRpc("%j", { at: new Date().toISOString(), serverPid: child.pid, id, method: reply.method, outcome,
      roundTripMs: Math.round(receivedAt - reply.startedAt), dispatchQueueMs: Math.round(performance.now() - receivedAt) });
  }
  function fail(error: Error) {
    failure ??= error;
    for (const [id, reply] of pending) {
      logReply(id, reply, "connection-failed");
      reply.reject(failure);
    }
    pending.clear();
    waiting?.();
    waiting = undefined;
  }
  let processing = Promise.resolve();
  async function route(line: string, receivedAt: number) {
    if (failure) return;
    try {
      const message = JSON.parse(line) as RpcMessage;
      const notification = message.params as { error?: unknown; turn?: { error?: unknown } } | undefined;
      const error = (message.error ?? (message.method === "error" ? notification?.error :
        message.method === "turn/completed" ? notification?.turn?.error : undefined)) as
        { codexErrorInfo?: unknown; data?: { codexErrorInfo?: unknown } } | undefined;
      if ((error?.codexErrorInfo ?? error?.data?.codexErrorInfo) === "usageLimitExceeded") onQuotaExceeded?.();
      if (message.method && message.id !== undefined) {
        void Promise.resolve().then(() => onRequest?.(message)).then(result => {
          if (!failure) send(result ? { id: message.id, result } :
            { id: message.id, error: { code: -32601, message: "Unsupported request in this task session." } });
        }).catch(error => {
          if (!failure) send({ id: message.id, error: { code: -32603, message: String(error) } });
        });
      } else if (message.method) {
        await onNotification(message);
        if (failure) return;
        notifications.push(message);
        waiting?.();
        waiting = undefined;
      } else if (typeof message.id === "number") {
        const reply = pending.get(message.id);
        pending.delete(message.id);
        if (reply) logReply(message.id, reply, message.error ? "error" : "ok", receivedAt);
        if (message.error) reply?.reject(new CodexRpcRejection(message.error.message ?? "Codex rejected the request."));
        else reply?.resolve(message.result);
      }
    } catch (error) { fail(error as Error); }
  }
  reader.on("line", line => {
    const receivedAt = traceRpc.enabled ? performance.now() : 0;
    processing = processing.then(() => route(line, receivedAt));
  });
  reader.once("close", () => { void processing.then(() => fail(new Error("The Codex process closed."))); });
  child.once("error", fail);
  child.stdin!.on("error", fail);
  return {
    send,
    fail,
    get failed() { return Boolean(failure); },
    close: () => {
      fail(new Error("The Codex session ended."));
      reader.close();
      // A descendant can keep the App Server's output handles open after it exits.
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    request<R>(method: string, params: object): Promise<R> {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as R), reject, method, startedAt: traceRpc.enabled ? performance.now() : 0 });
        try { send({ id, method, params }); } catch (error) { fail(error as Error); }
      });
    },
    async receive() {
      while (!notifications.length && !failure) await new Promise<void>(resolve => { waiting = resolve; });
      if (notifications.length) return notifications.shift()!;
      throw failure;
    },
  };
}

export function turnControl(request: <R>(method: string, params: object) => Promise<R>,
  threadId: string, turnId: string, inlineImages = false): AgentControl {
  return {
    async steer(text, images, clientUserMessageId) {
      await request("turn/steer", { threadId, expectedTurnId: turnId,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        input: [{ type: "text", text, text_elements: [] }, ...images.map(path =>
          inlineImages ? { type: "image", url: path } : { type: "localImage", path })] });
    },
    async interrupt() { await request("turn/interrupt", { threadId, turnId }); },
  };
}
