import localization from "../src/desktop/localization.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("Git menu dates use relative labels in English and Russian", () => {
  const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
  const start = renderer.indexOf("function relativeCommitDate(");
  const end = renderer.indexOf("\nasync function openGitBranches", start);
  assert.ok(start >= 0 && end > start);
  localization.select("en");
  const frame = { russian: false };
  const format = runInNewContext(renderer.slice(start, end) + "\nrelativeCommitDate", {
    frame, t: (key: string, parameters = {}) => localization.text(key, parameters, frame.russian ? "ru" : "en"), localization, bindLocalized: (node: any, property: string, render: () => string, attribute = false) => { const value = render(); if (attribute) node.setAttribute(property, value); else node[property] = value; return value; },
  }) as (value: string, now: number) => string;
  const now = Date.parse("2026-11-12T12:00:00Z");
  const ago = (seconds: number) => format(new Date(now - seconds * 1000).toISOString(), now);
  assert.equal(format("invalid", now), "");
  assert.equal(ago(0), "just now");
  assert.equal(ago(59), "just now");
  assert.equal(ago(300), "5 min. ago");
  assert.equal(ago(7200), "2 hr. ago");
  assert.equal(ago(86400), "yesterday");
  assert.equal(ago(-86400), "tomorrow");
  assert.equal(ago(63072000), "2 yr. ago");
  frame.russian = true; localization.select("ru");
  assert.equal(ago(0), "только что");
  assert.match(ago(300), /5.+мин.+назад/u);
  assert.equal(ago(86400), "вчера");
});
