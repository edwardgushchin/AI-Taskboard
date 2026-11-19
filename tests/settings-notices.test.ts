import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { settingsDelivery, syncSettingsNotices } from "../src/desktop/settings-notices.ts";
import { inheritedLimits, recordSettings, settingsContext } from "../src/cli/settings-notices.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { TaskboardError } from "../src/cli/model.ts";

process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

test("settings writes survive coalesced watches, inactive manager and restart; lanes and boards stay isolated", async t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-settings-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); });
  const cli = (project: string, args: string[], input?: unknown) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", project, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", windowsHide: true,
      input: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).data;
  };
  const a = join(root, "a"), b = join(root, "b");
  mkdirSync(a); mkdirSync(b);
  cli(a, ["init"]); cli(b, ["init"]);
  const read = () => syncSettingsNotices(a, inheritedLimits);
  read();
  cli(a, ["settings"], { taskLimits: { executor: 2 } });
  cli(a, ["settings"], { taskLimits: { executor: 3 } });
  cli(a, ["settings"], { taskLimits: { executor: 1 }, manager: { model: "gpt-6.1-sol", effort: "high" }, reviewMode: "human", secret: "DO_NOT_INCLUDE" });
  const journal = read();
  assert.equal(journal.events.length, 3);
  const text = settingsContext(journal);
  assert.match(text, /Лимит задач в работе: 2 → 3/);
  assert.match(text, /Лимит задач в работе: 3 → 1/);
  assert.match(text, /manager: рассуждение: "medium" → "high"/);
  assert.match(text, /Режим ревью: "reviewer" → "human"/);
  assert.doesNotMatch(text, /DO_NOT_INCLUDE|secret/);
  cli(a, ["settings"], { taskLimits: { executor: 1 }, reviewMode: "human" });
  assert.deepEqual(read(), journal);
  assert.deepEqual(read(), journal);
  const defaults = { executor: 8, manager: 2, reviewer: 1 };
  const inherited = syncSettingsNotices(a, defaults);
  assert.equal(inherited.effective["Лимит менеджеров"], undefined);
  assert.equal(inherited.effective["Лимит задач в работе"], 1);
  assert.equal(syncSettingsNotices(b, defaults).events.length, 0);
  cli(a, ["settings"], { taskLimits: {}, manager: { model: "gpt-6.1-terra", effort: "high" } });
  const current = () => syncSettingsNotices(a, defaults);
  assert.equal(current().effective["Лимит задач в работе"], 8);
  assert.match(settingsContext(current()), /manager: модель: "gpt-6.1-sol" → "gpt-6.1-terra"/);
  const chat = settingsDelivery(a, "chat", current), work = settingsDelivery(a, "work", current);
  assert.match(chat.initial().text, /2 → 3/);
  const received: string[] = [];
  const send = async (text: string) => { received.push(text); };
  await Promise.all([chat.flush(send), chat.flush(send)]);
  assert.equal(received.length, 1);
  await work.flush(send);
  assert.equal(received.length, 2);
  await settingsDelivery(a, "chat", current).flush(send);
  assert.equal(received.length, 2);
  cli(a, ["settings"], { taskLimits: { executor: 0 } });
  await assert.rejects(chat.flush(async () => { throw new Error("No active turn."); }));
  const restarted = settingsDelivery(a, "chat", current);
  assert.match(restarted.initial().text, /Лимит задач в работе: 8 → без ограничений/);
  await restarted.flush(send);
  assert.match(received.at(-1)!, /следующем запуске/);
  await settingsDelivery(b, "chat", () => syncSettingsNotices(b, defaults)).flush(send);
  assert.equal(received.length, 3);
  // A new save during an outstanding send must follow its receipt, in order.
  cli(a, ["settings"], { taskLimits: { executor: 2 } });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const one = restarted.flush(async text => { received.push(text); entered.resolve(); await gate.promise; });
  await entered.promise;
  cli(a, ["settings"], { taskLimits: { executor: 3 } });
  const two = restarted.flush(send);
  gate.resolve();
  await Promise.all([one, two]);
  assert.match(received.at(-2)!, /без ограничений → 2/);
  assert.match(received.at(-1)!, /2 → 3/);

  let reads = 0;
  const busy = settingsDelivery(a, "background", () => {
    if (reads++ === 0) throw new TaskboardError("BOARD_BUSY", "Board is temporarily busy.");
    return current();
  });
  const beforeRetry = received.length;
  await busy.flush(send);
  assert.equal(reads, 2);
  assert.equal(received.length, beforeRetry + 1);
  await busy.flush(send);
  assert.equal(received.length, beforeRetry + 1);
  const stopped = AbortSignal.abort();
  await assert.rejects(busy.flush(send, stopped), { name: "AbortError" });
  assert.equal(reads, 3);
});

test("effective projection omits unknown fields, normalizes aliases and tracks all supported fields", () => {
  const settings = { archiveAfterDays: 90, integrationMode: "merge" as const, autoReview: true, password: "SECRET" };
  const initial = recordSettings(settings);
  const normalized = recordSettings({ ...settings, reviewMode: "reviewer", showCardPreviews: true }, initial);
  assert.equal(normalized.events.length, 0);
  const changed = recordSettings({ ...settings, name: "Board", archiveAfterDays: null, integrationMode: "squash",
    showCardPreviews: false, manager: null, executor: { model: "other", effort: "low" } }, normalized);
  assert.equal(Object.keys(changed.events[0].changes).length, 8);
  assert.doesNotMatch(settingsContext(changed), /SECRET|password/);
  assert.match(settingsContext(changed), /по умолчанию провайдера/);
});

test("new launches respect 2 → 3 → 1 and unlimited without stopping active executors", () => {
  const slots = createAgentSlots();
  slots.configure({ ...inheritedLimits, executor: 2 });
  const first = slots.acquire("a", "executor")!, second = slots.acquire("a", "executor")!;
  assert.equal(slots.acquire("a", "executor"), undefined);
  slots.configure({ ...inheritedLimits, executor: 3 });
  const third = slots.acquire("a", "executor")!;
  slots.configure({ ...inheritedLimits, executor: 1 });
  assert.equal(slots.acquire("a", "executor"), undefined);
  first(); second();
  assert.equal(slots.available("a", "executor"), 0);
  third();
  assert.equal(slots.available("a", "executor"), 1);
  assert.equal(slots.available("b", "executor"), 1);
  slots.configure({ ...inheritedLimits, executor: 0 });
  assert.equal(slots.available("a", "executor"), Infinity);
});
