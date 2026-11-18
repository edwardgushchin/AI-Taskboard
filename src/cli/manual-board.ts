import { randomUUID } from "node:crypto";
import { TaskboardError, record, requireRevision, object, text, hexTagColor, registerTags } from "./model.ts";
import type { BoardSettings, ManualColumn, Task } from "./model.ts";
import type { BoardStore } from "./storage.ts";
import { changeTask } from "./tasks.ts";

export const isManual = (settings: Pick<BoardSettings, "boardType"> | undefined) => settings?.boardType === "manual";
export function manualError(): never {
  throw new TaskboardError("MANUAL_BOARD", "На обычной доске статусы меняет пользователь. Исполнители, ревью и авторежим недоступны.");
}
export function defaultColumns(): ManualColumn[] {
  return ["Планы", "В работе", "Сделано"].map((name, i) => ({ id: `manual:${randomUUID()}`, name,
    color: ["#818CF8", "#FB923C", "#4ADE80"][i], terminal: i === 2 }));
}
export function validateColumns(value: unknown): ManualColumn[] {
  if (!Array.isArray(value) || !value.length) throw new TaskboardError("INVALID_INPUT", "Нужна хотя бы одна колонка.");
  const ids = new Set<string>();
  return value.map(item => {
    const column = object(item);
    const id = text(column.id, "column id", true);
    const name = text(column.name, "column name", true);
    if (!/^manual:[a-zA-Z0-9-]+$/.test(id) || ids.has(id) || typeof column.color !== "string" ||
      !hexTagColor.test(column.color) || typeof column.terminal !== "boolean") {
      throw new TaskboardError("INVALID_INPUT", "Укажите уникальный ID, название, цвет #RRGGBB и признак завершения колонки.");
    }
    ids.add(id);
    return { id: id as ManualColumn["id"], name, color: column.color, terminal: column.terminal };
  });
}
export function guardManual(settings: BoardSettings, command: string, input: Record<string, unknown>) {
  if (!isManual(settings)) return;
  if (!["list", "show", "settings", "create", "update", "comment", "chat", "attachment", "tag", "doctor", "watch",
    "manual-move", "manual-columns", "manager-inbox", "manager-ack", "messages", "message", "manager-message",
    "manager-usage", "project-usage", "token-usage", "metrics", "experts", "expert-get", "expert-save", "expert-context", "expert-skill", "sync-notices"].includes(command)) manualError();
  if (input.schedule != null || input.execution != null || input.workingDirectory != null || input.status !== undefined) manualError();
}
export function manualAction(store: BoardStore, command: string, id: string | undefined, input: Record<string, unknown>): Task | BoardSettings | undefined {
  if (!isManual(store.index.settings)) return;
  const columns = store.index.settings.manualColumns!;
  if (command === "manual-columns") {
    if (input.actor !== "user") manualError();
    if (JSON.stringify(input.previous) !== JSON.stringify(columns)) throw new TaskboardError("REVISION_CONFLICT", "Колонки изменились в другом окне. Обновите настройки.");
    const next = validateColumns(input.columns);
    const moves = object(input.moves ?? {});
    const removed = columns.filter(c => !next.some(n => n.id === c.id));
    const cards = store.snapshot().tasks.filter(t => removed.some(c => c.id === t.status));
    for (const card of cards) if (!next.some(c => c.id === moves[card.status])) {
      throw new TaskboardError("COLUMN_NOT_EMPTY", "Выберите оставшуюся колонку для переноса дел.");
    }
    for (const card of cards) {
      const from = columns.find(c => c.id === card.status)!;
      const to = next.find(c => c.id === moves[card.status])!;
      const updated = record(card, "manual-move", "user", to.id, `${from.name} → ${to.name} (удаление колонки)`);
      if (to.terminal) updated.closedAt = updated.updatedAt;
      else delete updated.closedAt;
      store.save(updated);
    }
    store.index.settings.manualColumns = next;
    store.saveIndex();
    return store.index.settings;
  }
  if (command === "manual-move") {
    if (input.actor !== "user") manualError();
    const card = store.card(id!);
    requireRevision(card, input.revision, true);
    const to = columns.find(c => c.id === input.to);
    if (!to) throw new TaskboardError("INVALID_INPUT", "Выберите существующую колонку.");
    const from = columns.find(c => c.id === card.status);
    const updated = record(card, command, "user", to.id, `${from?.name ?? card.status} → ${to.name}`);
    if (to.terminal) updated.closedAt = updated.updatedAt;
    else delete updated.closedAt;
    return store.save(updated);
  }
  if (command === "update") {
    const card = store.card(id!);
    requireRevision(card, input.revision);
    // Reuse field validation without the agent lifecycle or approved-requirement rules.
    const updated = changeTask({ ...card, status: "draft" }, "update", input);
    if (updated.revision === card.revision) return card;
    updated.status = card.status;
    if (input.tags !== undefined) {
      updated.tags = registerTags(store.index.tags ??= [], updated.tags);
      store.saveIndex();
    }
    updated.history = [...card.history, { at: updated.updatedAt, action: "update", actor: input.actor === "manager" ? "manager" : "user", text: typeof input.note === "string" ? input.note : undefined }];
    return store.save(updated);
  }
  if (command === "comment") return store.save(record(store.card(id!), command, input.actor === "manager" ? "manager" : "user", undefined, text(input.text, "text", true)));
}
export function manualContext(settings: BoardSettings): string {
  return isManual(settings) ? `Обычная доска личных дел. Пользователь сам меняет статусы через интерфейс. Помогай создавать и редактировать содержимое дел; не меняй статусы, не запускай исполнителей, ревьюеров, Git или авторежим и не предлагай сдачу кода или агентное ревью. Статусы: ${JSON.stringify(settings.manualColumns)}. terminal означает завершённое дело независимо от названия.` : "";
}
