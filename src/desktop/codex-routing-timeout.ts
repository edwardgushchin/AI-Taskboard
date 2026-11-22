export const routingRetryDelayMs = 5_000;

export class CodexRoutingTimeout extends Error {}

export function isRoutingTimeout(turn: { status?: string; error?: { message?: string } | null }) {
  return turn.status === "failed" &&
    /^workspace routing discovery timed out\.?$/i.test(turn.error?.message?.trim() ?? "");
}
