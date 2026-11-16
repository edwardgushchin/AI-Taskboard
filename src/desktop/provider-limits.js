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
  let providers = [];
  function render() {
    const summary = globalThis.providerLimitSummary(providers);
    const lowest = summary.lowest;
    control.querySelector("span").textContent = lowest ? `${lowest.provider} ${Math.floor(lowest.remaining)}%` : label + " ?";
    const warning = lowest && lowest.remaining <= 10 ? text("Low quota", "Лимит заканчивается") : "";
    const description = `${label}: ${summary.providers.length} ${text("connected", "подключено")}; ${summary.unavailable} ${text("without current data", "без актуальных данных")}. ` +
      (lowest ? `${lowest.provider}: ${Math.floor(lowest.remaining)}% ${text("remaining", "осталось")}. ` : "") + warning;
    control.title = description;
    control.setAttribute("aria-label", description);
    control.classList.toggle("quota-low", Boolean(warning));
    const heading = document.createElement("h3");
    heading.textContent = label;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "button quiet";
    close.textContent = text("Close", "Закрыть");
    close.onclick = () => { panel.hidePopover(); control.focus(); };
    const content = document.createElement("div");
    const overview = document.createElement("p");
    overview.textContent = description;
    content.append(overview);
    for (const provider of summary.providers) {
      const title = document.createElement("h4");
      title.textContent = provider.provider;
      const status = document.createElement("p");
      status.textContent = states[provider.state];
      content.append(title, status);
      if (provider.state !== "ready") continue;
      for (const window of provider.windows) {
        const row = document.createElement("p");
        row.textContent = `${window.name}: ${Math.floor(window.remaining)}% ${text("remaining", "осталось")}` +
          (window.remaining <= 10 ? ` · ${text("Low quota", "Лимит заканчивается")}` : "") +
          (window.resetsAt ? ` · ${text("Resets", "Сброс")} ${new Date(window.resetsAt).toLocaleString()}` : "");
        const meter = document.createElement("meter");
        meter.min = 0; meter.max = 100; meter.value = window.remaining;
        meter.setAttribute("aria-label", row.textContent);
        content.append(row, meter);
      }
    }
    // Preserve keyboard focus on Close during background updates.
    if (!panel.firstChild) panel.append(heading, close, content);
    else panel.lastChild.replaceWith(content);
  }
  async function refresh() {
    try { providers = await window.taskboard.providerLimits(); }
    catch { providers = [{ provider: "Codex", state: "error", windows: [] }]; }
    render();
  }
  panel.addEventListener("toggle", event => {
    control.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") panel.querySelector("button").focus();
    else if (panel.contains(document.activeElement)) control.focus();
  });
  control.setAttribute("aria-controls", panel.id);
  control.setAttribute("aria-expanded", "false");
  window.taskboard.onProviderLimitsChanged(() => { providers = []; render(); void refresh(); });
  void refresh();
  setInterval(refresh, 60_000);
  setInterval(render, 15_000);
}
