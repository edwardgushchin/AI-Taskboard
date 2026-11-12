import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

export interface AgentControl {
  steer(text: string, images: string[]): Promise<void>;
  interrupt(): Promise<void>;
}

// One reader routes responses by id, so steering never competes with the turn monitor.
export function codexRpc(child: ChildProcess,
  onNotification: (message: RpcMessage) => void,
  onRequest?: (message: RpcMessage) => Promise<object | undefined>) {
  const reader = createInterface({ input: child.stdout! });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const notifications: RpcMessage[] = [];
  let waiting: (() => void) | undefined;
  let failure: Error | undefined;
  let nextId = 0;
  const send = (message: object) => child.stdin!.write(JSON.stringify(message) + "\n");
  function fail(error: Error) {
    failure ??= error;
    for (const reply of pending.values()) reply.reject(failure);
    pending.clear();
    waiting?.();
    waiting = undefined;
  }
  reader.on("line", line => {
    if (failure) return;
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.method && message.id !== undefined) {
        void Promise.resolve().then(() => onRequest?.(message)).then(result => {
          if (!failure) send(result ? { id: message.id, result } :
            { id: message.id, error: { code: -32601, message: "Unsupported request in this task session." } });
        }).catch(error => {
          if (!failure) send({ id: message.id, error: { code: -32603, message: String(error) } });
        });
      } else if (message.method) {
        onNotification(message);
        notifications.push(message);
        waiting?.();
        waiting = undefined;
      } else if (typeof message.id === "number") {
        const reply = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reply?.reject(new Error(message.error.message ?? "Codex rejected the request."));
        else reply?.resolve(message.result);
      }
    } catch (error) { fail(error as Error); }
  });
  reader.once("close", () => fail(new Error("The Codex process closed.")));
  child.once("error", fail);
  child.stdin!.on("error", fail);
  return {
    send,
    fail,
    close: () => { fail(new Error("The Codex session ended.")); reader.close(); },
    request<R>(method: string, params: object): Promise<R> {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as R), reject });
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
  threadId: string, turnId: string): AgentControl {
  return {
    async steer(text, images) {
      await request("turn/steer", { threadId, expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }, ...images.map(path => ({ type: "localImage", path }))] });
    },
    async interrupt() { await request("turn/interrupt", { threadId, turnId }); },
  };
}
