// Also loaded by node tests; the browser uses the same minimum and freshness rules.
globalThis.providerLimitSummary = (providers, now = Date.now()) => {
  const fresh = providers.map(provider => ({ ...provider,
    state: provider.state === "ready" && (!provider.observedAt || now - provider.observedAt > 180_000 ||
      provider.windows.some(window => window.resetsAt && window.resetsAt <= now)) ? "stale" : provider.state }));
  const known = fresh.filter(provider => provider.state === "ready").flatMap(provider =>
    provider.windows.map(window => ({ ...window, provider: provider.provider })));
  return { providers: fresh, lowest: known.sort((a, b) => a.remaining - b.remaining)[0],
    unavailable: fresh.filter(provider => provider.state !== "ready").length };
};

globalThis.providerLimitWindowLabel = (minutes, locale) => {
  const ru = locale.startsWith("ru");
  if (minutes === 10080) return ru ? "Недельный лимит" : "Weekly limit";
  if (minutes === 1440) return ru ? "Суточный лимит" : "Daily limit";
  if (!(minutes > 0)) return ru ? "Лимит" : "Limit";
  const [value, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] :
    minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  const duration = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
  return ru ? `Лимит на ${duration}` : `Limit over ${duration}`;
};

if (typeof document !== "undefined") {
  const control = document.getElementById("status-limits");
  const panel = document.getElementById("provider-limits");
  const ru = navigator.language.startsWith("ru");
  const text = (en, russian) => ru ? russian : en;
  const states = {
    ready: text("Remaining", "Осталось"), unknown: text("No data", "Нет данных"),
    no_windows: text("Provider reports no quota windows", "Провайдер не сообщает окон лимитов"),
    unsupported: text("Quota windows unavailable in this connection", "Окна лимитов недоступны в этом подключении"),
    auth: text("Sign in required", "Нужно войти в аккаунт"), error: text("Could not read limits", "Ошибка чтения лимитов"),
    stale: text("Stale data; waiting for update", "Данные устарели; ожидается обновление"),
  };
  const label = text("Limits", "Лимиты");
  panel.setAttribute("aria-label", label);
  panel.tabIndex = -1;
  let providers = [];
  function render() {
    const summary = globalThis.providerLimitSummary(providers);
    const lowest = summary.lowest;
    control.querySelector("span").textContent = lowest ? `${label} ${Math.floor(lowest.remaining)}%` : label + " ?";
    const warning = lowest && lowest.remaining <= 10 ? text("Low quota", "Лимит заканчивается") : "";
    const description = `${label}: ${summary.providers.length} ${text("connected", "подключено")}; ${summary.unavailable} ${text("without current data", "без актуальных данных")}. ` +
      (lowest ? `${lowest.provider}: ${Math.floor(lowest.remaining)}% ${text("remaining", "осталось")}. ` : "") + warning;
    control.title = description;
    control.setAttribute("aria-label", description);
    control.classList.toggle("quota-low", Boolean(warning));
    const content = document.createElement("div");
    if (summary.providers.length !== 1) {
      const overview = document.createElement("p");
      overview.className = "limits-overview";
      overview.textContent = `${summary.providers.length} ${text("connected", "подключено")}; ${summary.unavailable} ${text("without current data", "без актуальных данных")}`;
      content.append(overview);
    }
    for (const provider of summary.providers) {
      const group = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = provider.provider;
      group.append(title);
      content.append(group);
      if (provider.state !== "ready") {
        const status = document.createElement("p");
        status.textContent = states[provider.state];
        group.append(status);
        continue;
      }
      for (const window of provider.windows) {
        const quota = document.createElement("div");
        quota.className = "limits-window";
        const row = document.createElement("p");
        const windowLabel = globalThis.providerLimitWindowLabel(window.durationMins, navigator.language);
        const bucket = window.name && window.name.toLowerCase() !== provider.provider.toLowerCase() ? window.name + " · " : "";
        row.textContent = `${bucket}${windowLabel}: ${text("remaining", "осталось")} ${Math.floor(window.remaining)}%`;
        const meter = document.createElement("meter");
        meter.min = 0; meter.max = 100; meter.value = window.remaining;
        meter.setAttribute("aria-label", row.textContent);
        quota.append(row, meter);
        if (window.resetsAt) {
          const reset = document.createElement("p");
          reset.className = "limits-reset";
          reset.textContent = `${text("Resets", "Сброс")} ${new Date(window.resetsAt).toLocaleString()}`;
          quota.append(reset);
        }
        if (window.remaining <= 10) {
          const warning = document.createElement("p");
          warning.textContent = text("Low quota", "Лимит заканчивается");
          quota.append(warning);
        }
        group.append(quota);
      }
    }
    panel.replaceChildren(content);
  }
  async function refresh() {
    try { providers = await window.taskboard.providerLimits(); }
    catch { providers = [{ provider: "Codex", state: "error", windows: [] }]; }
    render();
  }
  panel.addEventListener("toggle", event => {
    control.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") panel.focus();
    else if (panel.contains(document.activeElement)) control.focus();
  });
  control.setAttribute("aria-controls", panel.id);
  control.setAttribute("aria-expanded", "false");
  window.taskboard.onProviderLimitsChanged(() => { providers = []; render(); void refresh(); });
  void refresh();
  setInterval(refresh, 60_000);
  setInterval(render, 15_000);
}
