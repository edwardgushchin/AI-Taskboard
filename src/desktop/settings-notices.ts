import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { TaskboardError, type AgentLimits } from "../cli/model.ts";
import { onBoard, readJson, exists, writeJson } from "../cli/storage.ts";
import { runtimeLocation } from "./board-runtime.ts";
import { recordSettings, settingsContext } from "../cli/settings-notices.ts";
import type { SettingsJournal } from "../cli/settings-notices.ts";

export function syncSettingsNotices(project: string, defaults: AgentLimits): SettingsJournal {
  return onBoard(runtimeLocation(project), store => {
    const previous = store.index.managerSettings;
    const journal = recordSettings(store.index.settings, previous, defaults);
    if (JSON.stringify(previous) !== JSON.stringify(journal)) {
      store.index.managerSettings = journal;
      store.saveIndex();
    }
    return journal;
  }, 0);
}

// Each lane has its own durable receipt. Windows share the same running request.
export function settingsDelivery(project: string, lane: string, read: () => SettingsJournal) {
  const path = join(project, ".tasks", `manager-settings-${lane}.json`);
  let through = exists(path) ? (readJson(path) as { through: number }).through : 0;
  let queue = Promise.resolve();
  const acknowledge = (sequence: number) => {
    through = Math.max(through, sequence);
    writeJson(path, { through });
  };
  const readForDelivery = async (signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return read(); }
      catch (error) {
        if (!(error instanceof TaskboardError) || error.code !== "BOARD_BUSY" || attempt === 4) throw error;
        await wait(100, undefined, { signal });
      }
    }
  };
  return {
    initial() {
      const journal = read();
      return { text: settingsContext(journal, through), sequence: journal.events.at(-1)?.sequence ?? 0 };
    },
    acknowledge,
    flush(send: (text: string) => Promise<void>, signal?: AbortSignal) {
      queue = queue.catch(() => {}).then(async () => {
        const journal = await readForDelivery(signal);
        const sequence = journal.events.at(-1)?.sequence ?? 0;
        if (sequence <= through) return;
        signal?.throwIfAborted();
        await send(settingsContext(journal, through));
        acknowledge(sequence);
      });
      return queue;
    },
  };
}
