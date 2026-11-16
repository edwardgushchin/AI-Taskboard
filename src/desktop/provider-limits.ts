import { spawn } from "node:child_process";
import { configuredCodex } from "./codex.ts";
import { codexRpc } from "./codex-rpc.ts";

export interface LimitWindow { name: string; remaining: number; resetsAt?: number }
export interface ProviderLimits {
  provider: string;
  state: "ready" | "unknown" | "no_windows" | "unsupported" | "auth" | "error" | "stale";
  windows: LimitWindow[];
  observedAt?: number;
}

// Missing or invalid values never become a full or empty quota.
export function codexLimitWindows(value: any): LimitWindow[] {
  const buckets = value?.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : [value?.rateLimits];
  return buckets.flatMap((bucket: any) => ["primary", "secondary"].flatMap(key => {
    const window = bucket?.[key];
    const used = window?.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const minutes = window.windowDurationMins;
    const duration = typeof minutes === "number" && minutes > 0 ? `${minutes} min` : key;
    return [{ name: `${bucket.limitName || bucket.limitId || "Codex"} · ${duration}`,
      remaining: 100 - used,
      ...(typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) ? { resetsAt: window.resetsAt * 1000 } : {}) }];
  }));
}

export function codexLimitState(data: any, windows = codexLimitWindows(data)): ProviderLimits["state"] {
  if (windows.length) return "ready";
  const buckets: any[] = data?.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId) : [data?.rateLimits];
  return buckets.length && buckets.every(bucket => bucket && bucket.primary === null && bucket.secondary === null)
    ? "no_windows" : "unknown";
}

export async function readCodexLimits(profile: string): Promise<ProviderLimits | undefined> {
  const client = await configuredCodex(profile);
  if (!client) return undefined;
  const child = spawn(client.path, [...client.args, "app-server"], {
    env: client.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const rpc = codexRpc(child, () => {});
  const timeout = setTimeout(() => rpc.fail(new Error("Rate limits request timed out")), 20_000);
  try {
    await rpc.request("initialize", { clientInfo: { name: "ai_taskboard", version: "0.1.0" } });
    rpc.send({ method: "initialized" });
    const account: any = await rpc.request("account/read", {});
    if (!account.account) return { provider: "Codex", state: "auth", windows: [] };
    if (account.account.type !== "chatgpt") return { provider: "Codex", state: "unsupported", windows: [] };
    const data = await rpc.request("account/rateLimits/read", {});
    const windows = codexLimitWindows(data);
    return { provider: "Codex", state: codexLimitState(data, windows), windows, observedAt: Date.now() };
  } catch (error) {
    const message = String(error);
    return { provider: "Codex", state: /auth|unauthorized|login|401/i.test(message) ? "auth" :
      /not supported|method not found/i.test(message) ? "unsupported" : "error", windows: [] };
  } finally {
    clearTimeout(timeout);
    rpc.close();
    child.stdin.end();
    child.kill();
  }
}

// Owned by the main process: all boards and windows share one in-flight read and TTL.
export function providerLimitSource(read: () => Promise<ProviderLimits | undefined>, now = Date.now) {
  let cached: ProviderLimits[] | undefined;
  let expires = 0;
  let pending: Promise<ProviderLimits[]> | undefined;
  let generation = 0;
  const get = (): Promise<ProviderLimits[]> => {
    if (pending) return pending;
    if (cached && now() < expires) return Promise.resolve(cached);
    const started = generation;
    const request: Promise<ProviderLimits[]> = read().then(value => {
      if (started !== generation) { pending = undefined; return get(); }
      cached = value ? [value] : []; expires = now() + 60_000; return cached;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  };
  return Object.assign(get, { invalidate: () => { generation++; cached = undefined; expires = 0; } });
}
