import assert from "node:assert/strict";
import test from "node:test";
import { advanceInterval, goalEventConditions, goalQueueCondition, goalReserveTarget, intervalDeadline,
  normalizeGoalRules, ownerIterationDirective, type IterativeGoalState } from "../src/desktop/iterative-goal.ts";
import { taskActivity } from "../src/cli/task-activity.ts";
import type { TaskEvent } from "../src/cli/model.ts";

test("the explicit owner directive authorizes the exact multiplier and supports correction", () => {
  const command = "Включи итеративный режим и настрой правило: если число карточек, доступных к запуску, меньше общего лимита исполнителей, умноженного на ";
  for (const value of ["2x", "2e0", "0x2", "2.0", "-2", "02"]) {
    assert.equal(ownerIterationDirective(command + value + ", создай четыре карточки и жди").rules, undefined);
  }
  const objective = command + "2, создай четыре карточки и жди";
  const rule = { kind: "reserve", scope: "board", threshold: "multiplier", value: 2 } as const;
  assert.deepEqual(ownerIterationDirective(objective), { enabled: true, intervalMs: undefined, rules: [rule] });
  assert.equal(ownerIterationDirective("> " + objective).rules, undefined);
  assert.equal(ownerIterationDirective("«" + objective + "»").rules, undefined);
  assert.equal(normalizeGoalRules([{ ...rule, value: "2" }]), undefined);
  assert.deepEqual(normalizeGoalRules([rule]), [rule]);
  assert.equal(goalReserveTarget(rule, 3), 6);
});

test("scheduled cards never affect the reserve at, below, or above the threshold", () => {
  const ordinary = Array.from({ length: 4 }, (_, index) => ({
    id: "T-000" + (index + 1), status: "ready" as const, priority: "normal" as const,
  }));
  const scheduled = {
    ...ordinary[0], id: "T-0005", schedule: { everyMinutes: 1, nextAt: new Date(1000).toISOString(), paused: false },
  };
  for (const paused of [false, true]) {
    scheduled.schedule.paused = paused;
    for (const now of [999, 1000, 1001]) {
      for (const count of [3, 4]) {
        const cards = [...ordinary.slice(0, count), scheduled];
        for (const threshold of [undefined, 4]) {
          const result = goalQueueCondition(cards, cards, new Set(), 2, now, undefined, threshold);
          assert.equal(result.ready, count);
          assert.equal(Boolean(result.waitFor), count === 3);
          assert.equal(result.waitFor?.includes(scheduled.id), count === 3 ? false : undefined);
        }
      }
    }
  }
});

test("scoped events coalesce, survive restart and skip disabled periods", () => {
  const state: IterativeGoalState = {
    goalId: "goal", questions: [], observingSince: 1000,
    rules: [{ kind: "status", scope: "T-0001" }, { kind: "blocked", scope: "T-0001" },
      { kind: "submitted", scope: "board" }, { kind: "idle", scope: "T-0001", durationMs: 1000 }],
  };
  const first: TaskEvent[] = [];
  const second: TaskEvent[] = [];
  const push = (history: TaskEvent[], at: number, action: string, from?: TaskEvent["from"], to?: TaskEvent["to"]) => {
    history.push({ at: new Date(at).toISOString(), action, actor: "agent", from, to });
  };
  const check = (now: number, since = 0) => goalEventConditions(state, [
    { id: "T-0001", activity: taskActivity({ history: first }) },
    { id: "T-0002", activity: taskActivity({ history: second }) },
  ], since, now);
  push(second, 1100, "block", "in_progress", "blocked");
  assert.deepEqual(check(1200).reasons, []);
  push(first, 1300, "block", "in_progress", "blocked");
  push(second, 1301, "submit", "in_progress", "review");
  const initial = check(1400);
  assert.deepEqual(initial.reasons.map(reason => reason.kind), ["status", "blocked", "submitted"]);
  state.handled = JSON.parse(JSON.stringify(initial.handled));
  push(first, 1800, "message");
  push(first, 2000, "update");
  assert.deepEqual(check(2299).reasons, []);
  const idle = check(2300);
  assert.deepEqual(idle.reasons, [{ kind: "idle", scope: "T-0001" }]);
  state.handled = idle.handled;
  push(first, 2300, "progress");
  assert.deepEqual(check(3299).reasons, []);
  assert.deepEqual(check(3300).reasons, [{ kind: "idle", scope: "T-0001" }]);
  push(first, 3400, "start", "blocked", "in_progress");
  assert.deepEqual(check(3600, 3500).reasons, []);
  assert.deepEqual(check(4500, 3500).reasons, [{ kind: "idle", scope: "T-0001" }]);
});

test("explicit goal commands authorize only the requested settings", () => {
  assert.deepEqual(ownerIterationDirective("Включи итеративный режим и настрой проверку T-0123 каждые 25 минут"), {
    enabled: true,
    intervalMs: 1500000,
  });
  for (const [duration, intervalMs] of [
    ["10 секунд", 10000],
    ["15 секунд", 15000],
    ["5 минут", 300000],
    ["25 минут", 1500000],
    ["1 час", 3600000],
  ] as const) {
    assert.deepEqual(ownerIterationDirective("Измени интервал на " + duration), { enabled: undefined, intervalMs });
  }
  assert.deepEqual(ownerIterationDirective("Отключи итеративный режим."), { enabled: false, intervalMs: undefined });
});

test("implicit instructions, quotations and malformed numbers have no authority", () => {
  for (const objective of [
    "Проверяй T-0123 каждые 25 минут.",
    "Агент предложил включить итеративный режим.",
    "«Включи итеративный режим»",
    "Цитата: «\nВключи итеративный режим\n»",
    "> Включи итеративный режим",
    "> Цитата\nВключи итеративный режим",
    "- > Пример\n  Включи итеративный режим",
    "1. > Пример\n   Измени интервал на 10 секунд",
    "- Раздел\n  - > Пример\n    >\n    > Отключи итеративный режим",
    "<blockquote>\nВключи итеративный режим\n</blockquote>",
    "<BLOCKQUOTE title=\"пример > текста\">\n\nИзмени интервал на 10 секунд\n\n</BLOCKQUOTE>",
    "<blockquote>\n<blockquote>\nТекст\n</blockquote>\nОтключи итеративный режим\n</blockquote>",
    "<blockquote>\n<textarea>\n</blockquote>\nВключи итеративный режим\n</textarea>\n</blockquote>",
    "<blockquote\n cite='example'>\nВключи итеративный режим",
    "```\nВключи итеративный режим\n```",
    "```text\n~~~\nВключи итеративный режим\n```",
    "Измени интервал на 10a секунд",
    "Измени интервал на 1e1 секунд",
    "Измени интервал на 0xA секунд",
    "Измени интервал на 10.0 секунд",
    "Измени интервал на 0 секунд",
  ]) {
    assert.deepEqual(ownerIterationDirective(objective), { enabled: undefined, intervalMs: undefined }, objective);
  }
  assert.equal(ownerIterationDirective("Измени интервал на 10 секунд").intervalMs, 10000);
  assert.deepEqual(ownerIterationDirective(
    "<blockquote>\nОтключи итеративный режим\n</blockquote>\n\nВключи итеративный режим",
  ), { enabled: true, intervalMs: undefined });
  assert.equal(ownerIterationDirective("```html\n<blockquote>\n```\n\nВключи итеративный режим").enabled, true);
  assert.equal(ownerIterationDirective("- > Пример\n  Отключи итеративный режим\n\nВключи итеративный режим").enabled, true);
});

test("late launches keep their phase, resume starts a full interval and missed deadlines coalesce", () => {
  const noon = Date.parse("2026-11-21T12:00:00Z");
  const intervalMs = 10000;
  const state = { goalId: "goal", questions: [], intervalMs, nextAt: noon };
  assert.equal(intervalDeadline(state, 0), noon);
  assert.equal(advanceInterval(noon, intervalMs, noon + 7000), noon + 10000);
  assert.equal(advanceInterval(noon, intervalMs, noon + 37000), noon + 40000);
  assert.equal(intervalDeadline(state, noon + 37000), noon + 47000);
  assert.equal(intervalDeadline({ ...state, intervalMs: undefined }, 0), undefined);
});
