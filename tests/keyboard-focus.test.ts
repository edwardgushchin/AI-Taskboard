import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("text-field focus indicators follow keyboard navigation, not typing or pointer clicks", () => {
  const document = Object.assign(new EventTarget(), { documentElement: { dataset: {} as Record<string, string> } });
  runInNewContext(readFileSync(new URL("../src/desktop/keyboard-focus.js", import.meta.url), "utf8"), { document });
  const keyboardFocus = () => Object.hasOwn(document.documentElement.dataset, "keyboardFocus");
  const keydown = (key: string, options = {}) => document.dispatchEvent(Object.assign(new Event("keydown"), { key, ...options }));
  const pointerdown = () => document.dispatchEvent(new Event("pointerdown"));

  assert.equal(keyboardFocus(), false);
  keydown("a");
  assert.equal(keyboardFocus(), false);
  keydown("Tab");
  assert.equal(keyboardFocus(), true);
  pointerdown();
  assert.equal(keyboardFocus(), false);
  keydown("Tab", { shiftKey: true });
  assert.equal(keyboardFocus(), true);
  pointerdown();
  keydown("f", { code: "KeyF", ctrlKey: true });
  assert.equal(keyboardFocus(), true);
  pointerdown();
  keydown("f", { code: "KeyF", metaKey: true });
  assert.equal(keyboardFocus(), true);
  pointerdown();
  keydown("v", { code: "KeyV", ctrlKey: true });
  assert.equal(keyboardFocus(), false);
});
