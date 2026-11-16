import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import localization from "../src/desktop/localization.cjs";
import { responseLanguageInstructions } from "../src/desktop/board-agent-hooks.ts";

const parameters = (value: string) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(match => match[1]).sort();

test("all ten shipped catalogs contain every key and preserve interpolation parameters", () => {
  const keys = Object.keys(localization.catalogs.en).sort();
  assert.equal(Object.keys(localization.names).length, 10);
  assert.ok(keys.length > 1100);
  for (const [locale, catalog] of Object.entries(localization.catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, locale);
    for (const key of keys) {
      const english = localization.catalogs.en[key];
      const expected = parameters(typeof english === "string" ? english : english.other);
      const value = catalog[key];
      const forms = typeof value === "string" ? [value] : Object.values(value);
      if (typeof value !== "string") assert.ok(value.other, locale + ": " + key);
      for (const form of forms) {
        assert.ok(form.trim(), locale + ": " + key);
        assert.deepEqual(parameters(form), expected, locale + ": " + key);
        assert.doesNotMatch(form, /ZXNEWLINEZX|^\d{4}\s*\|/);
        const args = Object.fromEntries(expected.map(name => [name, name === "count" ? 22 : "user value"]));
        assert.ok(localization.text(key, args, locale));
      }
    }
  }
});

test("ordered OS preferences, regional tags, unsupported values and explicit selection", () => {
  for (const [preferences, expected] of [
    [["zh-CN", "fr-CA", "de-DE"], "fr"], [["pt_BR"], "pt"], [["ja-JP", "en-US"], "ja"],
    [["en-GB", "ru-RU"], "en"], [["uk-UA", "ru-RU"], "ru"], [["invalid_!", "zh-Hans"], "en"], [[], "en"],
  ] as [string[], string][]) assert.equal(localization.resolve(preferences), expected);
  localization.select("pl", ["ja-JP"]);
  assert.equal(localization.locale, "pl");
  localization.select("system", ["ja-JP"]);
  assert.equal(localization.locale, "ja");
  assert.throws(() => localization.select("unknown"));
  localization.select("en");
});

test("missing translations use English and malformed interpolation fails visibly", () => {
  const saved = localization.catalogs.ja["settings.language"];
  delete localization.catalogs.ja["settings.language"];
  try { assert.equal(localization.text("settings.language", {}, "ja"), "Language"); }
  finally { localization.catalogs.ja["settings.language"] = saved; }
  assert.throws(() => localization.text("tasks.show_more", {}, "en"), /Missing message parameter/);
  assert.throws(() => localization.text("nonexistent"), /Unknown application message/);
});

test("plural categories and numbers follow the selected locale", () => {
  assert.equal(localization.text("activity.command", { count: 1 }, "ru"), "1 команда");
  assert.equal(localization.text("activity.command", { count: 2 }, "ru"), "2 команды");
  assert.equal(localization.text("activity.command", { count: 5 }, "ru"), "5 команд");
  assert.equal(localization.text("activity.action", { count: 2 }, "pl"), "2 działania");
  assert.equal(localization.text("activity.action", { count: 5 }, "pl"), "5 działań");
  for (const locale of Object.keys(localization.names)) {
    for (const count of [0, 1, 2, 5, 21, 22, 10000, 1.5]) {
      assert.ok(localization.text("activity.action", { count }, locale).includes(new Intl.NumberFormat(locale).format(count)));
    }
  }
});

test("application errors preserve substituted user values and external diagnostics", () => {
  localization.select("de");
  assert.notEqual(localization.errorText("Choose an available language."), "Choose an available language.");
  assert.equal(localization.errorText("external log: user title Русский 日本語"), "external log: user title Русский 日本語");
  localization.select("en");
});

test("new and continued instruction builds use current language and defer to explicit user requests", () => {
  for (const locale of ["ja", "pl", "en"]) {
    localization.select(locale);
    const text = responseLanguageInstructions();
    assert.ok(text.includes("(" + locale + ")"));
    assert.match(text, /explicit language requested by the user/);
    assert.match(text, /new and continued turns/);
  }
});

test("migrated UI paths reference shipped keys and contain no Russian flag branches", () => {
  for (const file of ["main.ts", "renderer.js", "chat.js", "markdown.js", "image-preview.js"]) {
    const source = readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /activityCount\([^;\n]+\[/);
    assert.doesNotMatch(source, /frame\.russian|\brussian\s*\?|\blanguage\(english|app\.getLocale\(/);
    for (const match of source.matchAll(/["']((?:ui|errors|html)\.[a-zA-Z0-9_.]+)["']/g)) {
      assert.ok(localization.catalogs.en[match[1]], file + ": " + match[1]);
    }
  }
});
