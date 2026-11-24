// Also loaded by node tests; the browser uses the same minimum and freshness rules.
globalThis.providerLimitSummary = (providers, now = Date.now()) => {
  const fresh = providers.map(provider => {
    if (provider.state !== "ready") return provider;
    if (!provider.observedAt || now - provider.observedAt > 180_000) return { ...provider, state: "stale" };
    const windows = provider.windows.filter(window => !window.resetsAt || window.resetsAt > now);
    if (windows.some(window => window.remaining === 0)) return { ...provider, windows };
    if (windows.length !== provider.windows.length) return { ...provider, state: "stale" };
    if (provider.incomplete) return { ...provider, state: "unknown" };
    return provider;
  });
  const known = fresh.filter(provider => provider.state === "ready").flatMap(provider =>
    provider.windows.map(window => ({ ...window, provider: provider.provider })));
  return { providers: fresh, lowest: known.sort((a, b) => a.remaining - b.remaining)[0],
    unavailable: fresh.filter(provider => provider.state !== "ready").length };
};

globalThis.providerLimitResetCount = (provider, now = Date.now()) => {
  const { state, observedAt, availableResetCount } = provider;
  if (!["ready", "no_windows", "unknown"].includes(state)) return;
  if (observedAt === undefined || observedAt > now || now - observedAt > 180_000) return;
  if (Number.isSafeInteger(availableResetCount) && availableResetCount >= 0) return availableResetCount;
};

globalThis.providerLimitWindowLabel = (minutes, locale) => {
  const t = (key, parameters) => globalThis.taskboardLocalization.text(key, parameters, globalThis.taskboardLocalization.resolve([locale]));
  if (minutes === 10080) return t("limits.weekly");
  if (minutes === 1440) return t("limits.daily");
  if (!(minutes > 0)) return t("limits.window");
  const [value, unit] = minutes % 1440 === 0 ? [minutes / 1440, "day"] :
    minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
  const duration = new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
  return t("limits.duration", { duration });
};

if (typeof document !== "undefined") {
  const control = document.getElementById("status-limits");
  const panel = document.getElementById("provider-limits");
  const localization = globalThis.taskboardLocalization;
  const t = (key, parameters) => localization.text(key, parameters);
  panel.tabIndex = -1;
  let providers = [];
  let boardBudget;
  let project;
  let boardReset = { pending: false, failed: false };
  let displayedLocale;
  let resettingCodex = false;
  let codexResetOutcome = "";
  function render() {
    if (!localization.state().english) return;
    displayedLocale = localization.locale;
    const label = t("limits.label");
    panel.setAttribute("aria-label", label);
    const now = Date.now();
    const summary = globalThis.providerLimitSummary(providers, now);
    const lowest = summary.lowest;
    control.querySelector("span").textContent = lowest ? `${label} ${Math.floor(lowest.remaining)}%` : label + " ?";
    const warning = lowest && lowest.remaining <= 10 ? t("limits.low") : "";
    const overviewText = t("limits.summary", { count: summary.providers.length, unavailable: summary.unavailable });
    const description = `${label}: ${overviewText}. ` +
      (lowest ? `${lowest.provider}: ${t("limits.remaining", { percent: Math.floor(lowest.remaining) })}. ` : "") + warning;
    control.title = description;
    control.setAttribute("aria-label", description);
    control.classList.toggle("quota-low", Boolean(warning));
    const content = document.createElement("div");
    if (summary.providers.length !== 1) {
      const overview = document.createElement("p");
      overview.className = "limits-overview";
      overview.textContent = overviewText;
      content.append(overview);
    }
    for (const [index, provider] of summary.providers.entries()) {
      const group = document.createElement("section");
      const header = document.createElement("header");
      header.className = "limits-header";
      const title = document.createElement("h3");
      title.textContent = t("limits.provider", { provider: provider.provider });
      header.append(title);
      if (provider.plan) {
        const plan = document.createElement("span");
        plan.className = "limits-plan";
        plan.textContent = provider.plan.replaceAll("_", " ").replace(/\b[a-z]/g, letter => letter.toUpperCase());
        header.append(plan);
      }
      group.append(header);
      content.append(group);
      if (!["ready", "unsupported", "no_windows"].includes(provider.state)) {
        const status = document.createElement("p");
        status.textContent = t("limits." + provider.state);
        group.append(status);
      }
      const windows = provider.state === "ready" ? provider.windows : [];
      for (const window of windows) {
        const quota = document.createElement("div");
        quota.className = "limits-window";
        const row = document.createElement("p");
        row.className = "limits-row";
        const windowLabel = globalThis.providerLimitWindowLabel(window.durationMins, localization.locale);
        const bucket = window.name && window.name.toLowerCase() !== provider.provider.toLowerCase() ? " · " + window.name : "";
        const name = document.createElement("span");
        name.textContent = windowLabel + bucket;
        const percent = Math.floor(window.remaining);
        const value = document.createElement("span");
        value.textContent = new Intl.NumberFormat(localization.locale, { style: "percent" }).format(percent / 100);
        row.append(name, value);
        const meter = document.createElement("meter");
        meter.min = 0; meter.max = 100; meter.value = window.remaining;
        meter.setAttribute("aria-label", name.textContent);
        meter.setAttribute("aria-valuetext", t("limits.remaining", { percent }));
        quota.append(row, meter);
        if (window.resetsAt) {
          const reset = document.createElement("p");
          reset.className = "limits-reset";
          reset.textContent = t("limits.reset", { time: new Date(window.resetsAt).toLocaleString(localization.locale) });
          quota.append(reset);
        }
        if (window.remaining <= 10) {
          const warning = document.createElement("p");
          warning.textContent = t("limits.low");
          quota.append(warning);
        }
        group.append(quota);
      }
      const snapshot = providers[index];
      const count = globalThis.providerLimitResetCount(snapshot, now);
      if (count === undefined) continue;
      const resets = document.createElement("p");
      resets.className = "limits-reset-count";
      resets.textContent = t("limits.available_resets", { count: new Intl.NumberFormat(localization.locale).format(count) });
      group.append(resets);
      const expirations = count > 0 ? snapshot.resetCreditExpirations?.filter(time => time === null || time > now) : undefined;
      if (expirations?.length) {
        const list = document.createElement("ul");
        list.className = "limits-reset-credits";
        for (const time of expirations) {
          const item = document.createElement("li");
          item.textContent = time === null ? t("limits.reset_expiry_unknown") :
            t("limits.reset_expires", { time: new Date(time).toLocaleString(localization.locale) });
          list.append(item);
        }
        group.append(list);
      }
      if (count > 0 && snapshot.resetAccount) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.disabled = resettingCodex;
        reset.textContent = t("limits.reset_codex");
        reset.addEventListener("click", async () => {
          if (resettingCodex) return;
          resettingCodex = true;
          reset.disabled = true;
          codexResetOutcome = "";
          try {
            const outcome = await window.taskboard.resetCodexLimits(snapshot.resetAccount);
            if (outcome !== "cancelled") codexResetOutcome = outcome;
          } catch {
            codexResetOutcome = "failed";
          } finally {
            resettingCodex = false;
            render();
          }
        });
        group.append(reset);
      }
    }
    if (codexResetOutcome) {
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = t("limits.reset_result." + codexResetOutcome);
      content.append(status);
    }
    let resetButton;
    if (project) {
      const openedProject = project;
      const action = boardReset;
      const quota = document.createElement("section");
      quota.className = "limits-window";
      quota.dataset.boardBudget = "";
      const title = document.createElement("strong");
      title.textContent = t(boardBudget ? "limits.board.title" : "limits.board.usage");
      quota.append(title);
      if (boardBudget) {
        const { limit, remaining, resetsAt } = boardBudget;
        const meter = document.createElement("meter");
        meter.max = limit;
        meter.value = remaining;
        meter.dataset.resetsAt = String(resetsAt);
        meter.setAttribute("aria-label", title.textContent);
        const schedule = document.createElement("small");
        schedule.className = "limits-reset";
        schedule.textContent = t("limits.reset", { time: new Date(resetsAt).toLocaleString(localization.locale) });
        quota.append(meter, schedule);
      }
      const row = document.createElement("div");
      row.className = "limits-board-actions";
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = action.failed ? t("limits.board.reset_failed") : "";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "button quiet limits-board-reset";
      reset.textContent = t("limits.board.reset");
      reset.setAttribute("aria-label", t("limits.board.reset_label"));
      reset.setAttribute("aria-disabled", String(action.pending));
      reset.addEventListener("click", async () => {
        if (action !== boardReset || action.pending) return;
        action.pending = true;
        action.failed = false;
        reset.setAttribute("aria-disabled", "true");
        status.textContent = "";
        try {
          action.failed = !await window.taskboard.resetBoardBudget(openedProject);
        } catch (error) {
          console.error(error);
          action.failed = true;
        } finally {
          action.pending = false;
          if (action === boardReset) {
            const currentReset = panel.querySelector(".limits-board-reset");
            currentReset.setAttribute("aria-disabled", "false");
            currentReset.nextElementSibling.textContent = action.failed ? t("limits.board.reset_failed") : "";
          }
        }
      });
      resetButton = reset;
      row.append(reset, status);
      quota.append(row);
      content.append(quota);
    }
    const restoreResetFocus = document.activeElement?.matches("#provider-limits .limits-board-reset");
    panel.replaceChildren(content);
    if (restoreResetFocus) resetButton?.focus({ preventScroll: true });
  }
  async function refresh() {
    try { providers = await window.taskboard.providerLimits(); }
    catch { providers = [{ provider: "Codex", state: "error", windows: [] }]; }
    render();
  }
  panel.addEventListener("toggle", event => {
    const open = event.newState === "open";
    control.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      panel.focus();
      if (providers.some(provider => provider.state === "error")) {
        void refresh();
      }
    } else if (panel.contains(document.activeElement)) {
      control.focus();
    }
  });
  control.setAttribute("aria-controls", panel.id);
  control.setAttribute("aria-expanded", "false");
  window.taskboard.onProviderLimitsChanged(() => { providers = []; render(); void refresh(); });
  function applyBoardBudget(budget) {
    boardBudget = budget;
    if (!panel.matches(":popover-open")) return;
    const meter = panel.querySelector("[data-board-budget] meter");
    if (meter && budget && meter.max === budget.limit &&
        meter.dataset.resetsAt === String(budget.resetsAt)) meter.value = budget.remaining;
    else if (Boolean(meter) !== Boolean(budget) || meter) render();
  }
  window.taskboard.onBoardBudgetChanged(applyBoardBudget);
  window.renderProviderLimits = (budget, openedProject) => {
    if (project === openedProject && displayedLocale === localization.locale) {
      applyBoardBudget(budget);
      return;
    }
    if (project !== openedProject) boardReset = { pending: false, failed: false };
    project = openedProject;
    boardBudget = budget;
    render();
  };
  void refresh();
  setInterval(refresh, 60_000);
  setInterval(() => {
    if (providers.some(provider => provider.state === "error")) {
      void refresh();
    } else {
      render();
    }
  }, 15_000);
}
