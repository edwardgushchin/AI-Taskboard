import semver from "semver";
import type { BoardSettings, Task } from "./model.ts";
import { requireRevision, TaskboardError, taskIdPattern } from "./model.ts";
import type { BoardStore } from "./storage.ts";
import { isManual } from "./manual-board.ts";
import { validateDependencies } from "./dependencies.ts";
import { changeTask } from "./tasks.ts";

type ReleaseTask = Pick<Task, "id" | "status" | "milestone" | "schedule" | "launchRequested"> & { mergeRepair?: boolean };

function releaseVersion(task: ReleaseTask) {
  return task.milestone && semver.valid(task.milestone.title);
}

export function earliestOpenRelease(tasks: Iterable<ReleaseTask>, now: number) {
  let earliest: { version: string; taskIds: string[] } | undefined;
  for (const task of tasks) {
    if (task.status === "draft" || task.status === "done" || task.status === "cancelled") continue;
    if (task.status === "ready" && task.schedule &&
        (task.schedule.paused || Date.parse(task.schedule.nextAt) > now)) continue;

    const version = releaseVersion(task);
    if (!version) continue;
    if (!earliest || semver.compare(version, earliest.version) < 0) {
      earliest = { version, taskIds: [task.id] };
    } else if (semver.compare(version, earliest.version) === 0) {
      earliest.taskIds.push(task.id);
    }
  }
  return earliest;
}

export function releaseWait(task: ReleaseTask, earliest: ReturnType<typeof earliestOpenRelease>) {
  if (!earliest || task.status !== "ready" || task.schedule || task.launchRequested || task.mergeRepair) return;
  const version = releaseVersion(task);
  if (version && semver.compare(version, earliest.version) > 0) return earliest;
}

export function autoQueueSettings(settings: BoardSettings): NonNullable<BoardSettings["autoQueue"]> {
  return settings.autoQueue ?? { revision: 0, paused: false, order: [], held: [] };
}

export function updateAutoQueue(store: BoardStore, input: Record<string, unknown>) {
  if (isManual(store.index.settings)) throw new TaskboardError("MANUAL_BOARD", "Automatic queues require an agent board.");
  if (Object.keys(input).some(key => !["revision", "paused", "order", "hold", "release", "replaceHold"].includes(key))) {
    throw new TaskboardError("INVALID_INPUT", "Use revision, paused, order, hold, release or replaceHold for the automatic queue.");
  }
  const previous = autoQueueSettings(store.index.settings);
  if (!Object.keys(input).length) return previous;
  if (input.revision !== previous.revision) throw new TaskboardError("REVISION_CONFLICT", "The automatic queue changed. Read it before updating.");
  if (Object.hasOwn(input, "replaceHold")) {
    const replacement = input.replaceHold as Record<string, unknown> | undefined;
    if (Object.keys(input).length !== 2 || !replacement || typeof replacement !== "object" ||
        Object.keys(replacement).length !== 3 ||
        typeof replacement.id !== "string" || !taskIdPattern.test(replacement.id) ||
        typeof replacement.dependency !== "string" || !taskIdPattern.test(replacement.dependency)) {
      throw new TaskboardError("INVALID_INPUT", "Use replaceHold with id, revision and dependency, without other queue changes.");
    }
    const { id, revision, dependency } = replacement;
    const task = store.card(id);
    requireRevision(task, revision, true);
    if (!previous.held.includes(id) || !["draft", "ready", "blocked"].includes(task.status)) {
      throw new TaskboardError("INVALID_TRANSITION", "Only a held waiting task can replace its hold with a dependency.");
    }
    const dependencies = [...new Set([...(task.dependencies ?? []), dependency])];
    const updated = changeTask(task, "update", { revision, dependencies, actor: "manager", preserveStatus: true,
      note: "Replace the automatic queue hold with a dependency on " + dependency + "." });
    validateDependencies(store, updated);
    // Keep the hold if saving the card fails. If saving the queue fails, both gates remain.
    if (updated !== task) store.save({ ...updated, acceptanceRepair: undefined });
    const next = { ...previous, revision: previous.revision + 1, held: previous.held.filter(held => held !== id) };
    store.index.settings.autoQueue = next;
    store.saveIndex();
    return next;
  }
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
  if (!settings.autoMode) throw new TaskboardError("AUTO_MODE_DISABLED", "Automatic starts are disabled.");
  const queue = autoQueueSettings(settings);
  if (queue.paused || queue.held.includes(id)) throw new TaskboardError("AUTO_QUEUE_PAUSED", "The automatic queue or task is paused by its manager.");
  if (revision !== undefined && revision !== queue.revision) throw new TaskboardError("AUTO_QUEUE_CHANGED", "The automatic queue changed before this launch.");
}

export function requireReleaseTurn(store: BoardStore, task: ReleaseTask) {
  if (task.status !== "ready" || task.schedule || task.launchRequested || task.mergeRepair || !releaseVersion(task)) return;
  const cards = Object.keys(store.index.tasks).map(id => store.card(id));
  const waiting = releaseWait(task, earliestOpenRelease(cards, Date.now()));
  if (waiting) {
    throw new TaskboardError("AUTO_RELEASE_WAIT", "Automatic launch is waiting for release " + waiting.version + ".", waiting);
  }
}
