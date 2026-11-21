import { spawn } from "node:child_process";
import { configuredCodex } from "./codex.ts";
import { codexRpc } from "./codex-rpc.ts";

export interface LimitWindow { name: string; remaining: number; durationMins?: number; resetsAt?: number }
export interface ProviderLimits {
  provider: string;
  state: "ready" | "unknown" | "no_windows" | "unsupported" | "auth" | "error" | "stale";
  windows: LimitWindow[];
  observedAt?: number;
  incomplete?: boolean;
  plan?: string;
}

export interface QuotaWait { resetsAt?: number }

export function confirmedQuota(limits: ProviderLimits | undefined, now = Date.now()): QuotaWait | "available" | undefined {
  if (limits?.state !== "ready" || !limits.windows.length || limits.observedAt === undefined ||
      now - limits.observedAt >= 60_000 || limits.observedAt > now) return;
  const fresh = limits.windows.filter(window => window.resetsAt === undefined || window.resetsAt > now);
  const exhausted = fresh.filter(window => window.remaining === 0);
  if (!exhausted.length) {
    if (!limits.incomplete && fresh.length === limits.windows.length) return "available";
    return;
  }
  const resets = exhausted.map(window => window.resetsAt);
  const known = resets.filter((time): time is number => time !== undefined);
  return known.length === resets.length ? { resetsAt: Math.max(...known) } : {};
}

const windowKeys = ["primary", "secondary"] as const;

function codexLimitBuckets(value: any): any[] {
  return value?.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : [value?.rateLimits];
}

// Missing or invalid values never become a full or empty quota.
export function codexLimitWindows(value: any): LimitWindow[] {
  return codexLimitBuckets(value).flatMap(bucket => windowKeys.flatMap(key => {
    const window = bucket?.[key];
    const used = window?.usedPercent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const minutes = window.windowDurationMins;
    return [{ name: bucket.limitName || bucket.limitId || "Codex",
      remaining: 100 - used,
      ...(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? { durationMins: minutes } : {}),
      ...(typeof window.resetsAt === "number" && window.resetsAt > 0 && window.resetsAt <= 8.64e12 ? { resetsAt: window.resetsAt * 1000 } : {}) }];
  }));
}

export function codexLimitState(data: any, windows = codexLimitWindows(data)): ProviderLimits["state"] {
  if (windows.length) return "ready";
  const buckets = codexLimitBuckets(data);
  return buckets.length && buckets.every(bucket => bucket && bucket.primary === null && bucket.secondary === null)
    ? "no_windows" : "unknown";
}

export function codexLimitSnapshot(data: unknown, observedAt = Date.now()): ProviderLimits {
  const buckets = codexLimitBuckets(data);
  const windows = codexLimitWindows(data);
  const reported = buckets.flatMap(bucket => windowKeys.map(key => bucket?.[key])).filter(window => window != null);
  const incomplete = reported.length !== windows.length ||
    buckets.some(bucket => !bucket || typeof bucket !== "object" || Array.isArray(bucket));
  return {
    provider: "Codex", state: codexLimitState(data, windows), windows, observedAt,
    ...(incomplete ? { incomplete: true } : {}),
  };
}

export async function readCodexLimits(profile: string): Promise<ProviderLimits | undefined> {
  const client = await configuredCodex(profile);
  if (!client) return undefined;
  const child = spawn(client.path, [...client.args, "app-server"], {
    env: client.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const rpc = codexRpc(child, () => {});
  const timeout = setTimeout(() => rpc.fail(new Error("Rate limits request timed out")), 20_000);
  let plan: string | undefined;
  try {
    await rpc.request("initialize", { clientInfo: { name: "ai_taskboard", version: "0.1.0" } });
    rpc.send({ method: "initialized" });
    const account: any = await rpc.request("account/read", {});
    if (!account.account) return { provider: "Codex", state: "auth", windows: [] };
    if (account.account.type !== "chatgpt") return { provider: "Codex", state: "unsupported", windows: [] };
    const planType = account.account.planType;
    if (typeof planType === "string" && planType.trim() && planType.trim().toLowerCase() !== "unknown") {
      plan = planType.trim();
    }
    const data = await rpc.request("account/rateLimits/read", {});
    return { ...codexLimitSnapshot(data), plan };
  } catch (error) {
    const message = String(error);
    return { provider: "Codex", state: /auth|unauthorized|login|401/i.test(message) ? "auth" :
      /not supported|method not found/i.test(message) ? "unsupported" : "error", windows: [], plan };
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
      cached = value ? [value] : [];
      // Throttle repeat failures across windows without keeping a transient error for a full poll.
      expires = now() + (value?.state === "error" ? 5_000 : 60_000);
      return cached;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
  };
  return Object.assign(get, { invalidate: () => { generation++; cached = undefined; expires = 0; } });
}
