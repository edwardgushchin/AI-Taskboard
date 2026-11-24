export const routingRetryDelayMs = 5_000;

export class CodexRoutingRetry extends Error {}

export function isRoutingDiscoveryFailure(turn: { status?: string; error?: { message?: string } | null }) {
  return turn.status === "failed" &&
    /^workspace routing discovery (?:timed out|failed)\.?$/i.test(turn.error?.message?.trim() ?? "");
}
