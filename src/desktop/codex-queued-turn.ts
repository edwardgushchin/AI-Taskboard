import { CodexRpcRejection } from "./codex-rpc.ts";

export function missingCodexThread(message: string | undefined, threadId: string | undefined) {
  return Boolean(threadId && message === "no rollout found for thread id " + threadId);
}

type SavedTurn = {
  id: string;
  status: string;
  completedAt?: number | null;
  error?: { message?: string } | null;
  itemsView?: string;
  items: { type: string; clientId?: string; text?: string; phase?: string }[];
};

export async function findQueuedTurn(request: <R>(method: string, params: object) => Promise<R>,
  threadId: string, queued: { clientId: string; turnId?: string; requireCompletion?: boolean }, allowMissingThread = false): Promise<SavedTurn | undefined> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  let active = false;
  try {
    do {
      const page: { data: SavedTurn[]; nextCursor?: string | null } = await request("thread/turns/list", {
        threadId, cursor, sortDirection: "desc", limit: 10, itemsView: "full",
      });
      for (const turn of page.data) {
        const completeItems = Array.isArray(turn.items) && turn.itemsView !== "summary" && turn.itemsView !== "notLoaded";
        if (!completeItems && (queued.requireCompletion || turn.id !== queued.turnId)) {
          throw new Error("Codex returned incomplete turn history.");
        }
        if (turn.id === queued.turnId || turn.items.some(item => item.type === "userMessage" && item.clientId === queued.clientId)) {
          if (queued.requireCompletion && turn.status !== "inProgress" && !Number.isFinite(turn.completedAt)) {
            throw new Error("Codex has not confirmed the queued turn's completion.");
          }
          return turn;
        }
        active ||= turn.status === "inProgress";
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex repeated a turn history cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (queued.turnId || active) throw new Error("Codex has not confirmed the queued turn in history.");
  } catch (error) {
    if (allowMissingThread && error instanceof CodexRpcRejection && missingCodexThread(error.message, threadId)) throw error;
    throw Object.assign(new Error((error as Error).message), { code: "CODEX_START_UNCONFIRMED" });
  }
}
