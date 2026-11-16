(function (root) {
  const names = { en: "English", es: "Español", de: "Deutsch", ja: "日本語", fr: "Français", pt: "Português", ru: "Русский", it: "Italiano", nl: "Nederlands", pl: "Polski" };
  const catalogs = typeof module === "object" ? Object.fromEntries(Object.keys(names).map(id => [id, require("./locales/" + id + ".json")])) : {};
  let locale = "en", preference = "system";
  function resolve(preferred = []) {
    for (const value of preferred) {
      try { const base = new Intl.Locale(String(value).replaceAll("_", "-")).language; if (Object.hasOwn(names, base)) return base; } catch {}
    }
    return "en";
  }
  function select(value, preferred = []) {
    if (value !== "system" && !Object.hasOwn(names, value)) throw new Error("Unsupported application language");
    preference = value; locale = value === "system" ? resolve(preferred) : value;
  }
  function install(state) {
    locale = state.locale; preference = state.preference;
    catalogs.en = state.english; catalogs[locale] = state.messages;
  }
  function state() { return { locale, preference, messages: catalogs[locale], english: catalogs.en }; }
  function text(key, parameters = {}, language = locale) {
    let value = catalogs[language]?.[key] || catalogs.en?.[key];
    if (!value) throw new Error("Unknown application message: " + key);
    if (typeof value === "object") value = value[new Intl.PluralRules(language).select(parameters.count)] || value.other;
    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      if (!Object.hasOwn(parameters, name)) throw new Error("Missing message parameter: " + key + "." + name);
      return typeof parameters[name] === "number" ? new Intl.NumberFormat(language).format(parameters[name]) : String(parameters[name]);
    });
  }
  function errorText(message) {
    if (typeof message !== "string") return message;
    for (const [key, value] of Object.entries(catalogs.en ?? {})) {
      if (!key.startsWith("errors.") || typeof value !== "string") continue;
      const names = [];
      const pattern = value.split(/(\{p\d+\})/).map(part => {
        if (/^\{p\d+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([\\s\\S]*?)"; }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join("");
      const match = new RegExp("^" + pattern + "$", "u").exec(message);
      if (match) return text(key, Object.fromEntries(names.map((name, index) => [name, match[index + 1]])));
    }
    return message;
  }
  const api = { errorText, names, resolve, select, install, state, text, get locale() { return locale; }, catalogs };
  if (typeof module === "object") module.exports = api; else root.taskboardLocalization = api;
})(globalThis);
