import assert from "node:assert/strict";
import test from "node:test";
import { advanceInterval, intervalDeadline, ownerIterationDirective } from "../src/desktop/iterative-goal.ts";

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
