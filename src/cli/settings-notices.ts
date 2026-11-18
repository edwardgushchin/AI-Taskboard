import type { AgentLimits, BoardSettings } from "./model.ts";
import { boardReviewMode, defaultBoardAgents } from "./model.ts";

export const inheritedLimits: AgentLimits = { executor: 1, manager: 0, reviewer: 1 };
type Values = Record<string, string | number | boolean | null>;
export type SettingsJournal = {
  defaults: AgentLimits;
  effective: Values;
  events: { sequence: number; changes: Values; previous: Values; effective: Values }[];
};

// Enumerate supported fields: unknown configuration and credentials never enter context.
export function effectiveSettings(settings: BoardSettings, defaults: AgentLimits): Values {
  if (settings.boardType === "manual") return {
    "Тип доски": "Обычная доска",
    "Имя доски": settings.name ?? "",
    "Статусы": JSON.stringify(settings.manualColumns),
    "Процесс": "Статусы меняет пользователь. Помощники редактируют содержимое. Исполнители, ревью и Git недоступны.",
    "Авторежим": false,
  };
  const values: Values = {
    "Имя доски": settings.name ?? "",
    "Архивация через дней": settings.archiveAfterDays,
    "Интеграция Git": settings.integrationMode,
    "Превью карточек": settings.showCardPreviews ?? true,
    "Режим ревью": boardReviewMode(settings),
    "Авторежим": settings.autoMode ?? false,
  };
  values["Лимит задач в работе"] = settings.taskLimits?.executor ?? defaults.executor;
  values["Лимит задач на ревью"] = settings.taskLimits?.reviewer ?? defaults.reviewer;
  for (const role of ["executor", "manager", "reviewer"] as const) {
    const agent = settings[role] === undefined ? defaultBoardAgents[role] : settings[role];
    values[`${role}: модель`] = agent?.model ?? "по умолчанию провайдера";
    values[`${role}: рассуждение`] = agent?.effort ?? "по умолчанию провайдера";
    values[`${role}: провайдер`] = agent?.provider ?? "codex";
  }
  return values;
}

export function recordSettings(settings: BoardSettings, journal?: SettingsJournal, defaults = journal?.defaults ?? inheritedLimits): SettingsJournal {
  const effective = effectiveSettings(settings, defaults);
  if (!journal) return { defaults, effective, events: [] };
  const changes: Values = {}, previous: Values = {};
  for (const key of Object.keys(effective)) {
    if (effective[key] === journal.effective[key]) continue;
    changes[key] = effective[key];
    previous[key] = journal.effective[key];
  }
  const events = Object.keys(changes).length ? [...journal.events, {
    sequence: (journal.events.at(-1)?.sequence ?? 0) + 1, changes, previous, effective,
  }] : journal.events;
  return { defaults, effective, events };
}

export function settingsContext(journal: SettingsJournal, after = 0): string {
  const display = (key: string, value: Values[string]) => key.startsWith("Лимит ") && value === 0
    ? "без ограничений" : JSON.stringify(value);
  const events = journal.events.filter(event => event.sequence > after);
  return ["AI Taskboard: актуальные эффективные настройки доски (данные приложения).",
    ...events.map(event => `Изменение ${event.sequence}:\n` + Object.keys(event.changes).map(key =>
      `${key}: ${display(key, event.previous[key])} → ${display(key, event.changes[key])}`).join("\n")),
    "Эффективные настройки: " + JSON.stringify(journal.effective),
    "Лимиты действуют для новых запусков. Уменьшение лимита не останавливает работающих исполнителей. " +
    "Модель, рассуждение и набор инструментов текущего сеанса не меняются: сохранённые значения применяются при следующем запуске. " +
    "Если режим ревью изменился, перед решением перечитай настройки; инструменты текущего сеанса могут требовать нового запуска.",
  ].join("\n");
}
