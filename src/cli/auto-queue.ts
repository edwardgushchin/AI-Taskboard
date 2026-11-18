import type { BoardSettings } from "./model.ts";
import { TaskboardError, taskIdPattern } from "./model.ts";
import type { BoardStore } from "./storage.ts";
import { isManual } from "./manual-board.ts";

export function autoQueueSettings(settings: BoardSettings): NonNullable<BoardSettings["autoQueue"]> {
  return settings.autoQueue ?? { revision: 0, paused: false, order: [], held: [] };
}

export function updateAutoQueue(store: BoardStore, input: Record<string, unknown>) {
  if (isManual(store.index.settings)) throw new TaskboardError("MANUAL_BOARD", "Automatic queues require an agent board.");
  if (Object.keys(input).some(key => !["revision", "paused", "order", "hold", "release"].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use revision, paused, order, hold and release for the automatic queue.");
  }
  const previous = autoQueueSettings(store.index.settings);
  if (!Object.keys(input).length) return previous;
  if (input.revision !== previous.revision) throw new TaskboardError("REVISION_CONFLICT", "The automatic queue changed. Read it before updating.");
  if (input.paused !== undefined && typeof input.paused !== "boolean") throw new TaskboardError("INVALID_INPUT", "paused must be a boolean.");
  const ids = (name: string) => {
    const value = input[name] === undefined ? [] : input[name];
    if (!Array.isArray(value) || !value.every(id => typeof id === "string" && taskIdPattern.test(id)) ||
        new Set(value).size !== value.length) throw new TaskboardError("INVALID_INPUT", "Use distinct task IDs for " + name + ".");
    for (const id of value) {
      if (name === "release" && previous.held.includes(id)) continue;
      const task = store.card(id);
      if (!["draft", "ready", "blocked"].includes(task.status)) {
        throw new TaskboardError("INVALID_TRANSITION", "Only waiting tasks can be reordered or held. Read " + id + " again.");
      }
    }
    return value as string[];
  };
  const order = input.order === undefined ? previous.order : ids("order");
  const hold = ids("hold"), release = ids("release");
  if (hold.some(id => release.includes(id))) throw new TaskboardError("INVALID_INPUT", "A task cannot be held and released together.");
  const next = {
    revision: previous.revision + 1, paused: input.paused as boolean | undefined ?? previous.paused,
    order, held: [...new Set([...previous.held, ...hold])].filter(id => !release.includes(id)),
  };
  store.index.settings.autoQueue = next;
  store.saveIndex();
  return next;
}

export function requireAutoQueue(settings: BoardSettings, id: string, revision?: unknown) {
  const queue = autoQueueSettings(settings);
  if (queue.paused || queue.held.includes(id)) throw new TaskboardError("AUTO_QUEUE_PAUSED", "The automatic queue or task is paused by its manager.");
  if (revision !== undefined && revision !== queue.revision) throw new TaskboardError("AUTO_QUEUE_CHANGED", "The automatic queue changed before this launch.");
}
