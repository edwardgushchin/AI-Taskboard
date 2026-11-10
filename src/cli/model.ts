export const taskStates = ["draft", "ready", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export const priorities = ["low", "normal", "high", "urgent"] as const;

export type TaskState = typeof taskStates[number];
export type Priority = typeof priorities[number];
export type Actor = "agent" | "user";
export type IntegrationMode = "merge" | "squash";

export interface Attachment {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
}

export interface TaskGit {
  target: string;
  base: string;
  branch: string;
  worktree?: string;
  submission?: { sha: string; message: string };
  accepted?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  questions: string[];
  tags: string[];
  priority: Priority;
  subtasks: { title: string; done: boolean }[];
  attachments: Attachment[];
  status: TaskState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  summary: string;
  nextStep: string;
  blocked?: { reason: string; condition: string };
  result?: { summary: string; checks: string[]; limitations: string[] };
  git?: TaskGit;
  history: { at: string; actor: Actor; action: string; text?: string; from?: TaskState; to?: TaskState }[];
}

export interface BoardSettings {
  archiveAfterDays: number | null;
  integrationMode: IntegrationMode;
}

export interface ArchiveLink {
  path: string;
  title: string;
  status: "done" | "cancelled";
  closedAt: string;
  archivedAt: string;
}

export interface BoardIndex {
  version: 1;
  nextId: number;
  settings: BoardSettings;
  tasks: Record<string, string>;
  archive: Record<string, ArchiveLink>;
}

export class TaskboardError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const taskIdPattern = /^T-[0-9]{4,}$/;

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskboardError("INVALID_INPUT", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, required = false): string {
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new TaskboardError("INVALID_INPUT", name + " must be " + (required ? "a nonempty string." : "a string."));
  }
  return value.trim();
}

export function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) {
    throw new TaskboardError("INVALID_INPUT", name + " must be an array.");
  }
  return value.map(item => text(item, name + " item", true));
}

export function member<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new TaskboardError("INVALID_INPUT", name + " must be one of " + choices.join(", ") + ".");
  }
  return value as T;
}

export function number(value: unknown, name: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TaskboardError("INVALID_INPUT", name + " must be an integer of at least " + minimum + ".");
  }
  return value;
}

export function requireState(task: Task, allowed: readonly TaskState[]): void {
  if (!allowed.includes(task.status)) {
    throw new TaskboardError("INVALID_TRANSITION", "This action requires " + allowed.join(" or ") + ".", {
      id: task.id, status: task.status,
    });
  }
}

export function requireRevision(task: Task, value: unknown, required = false): void {
  if (value === undefined && !required) return;
  const revision = number(value, "revision");
  if (task.revision !== revision) {
    throw new TaskboardError("REVISION_CONFLICT", "The task changed. Read it again before retrying.", {
      id: task.id, expected: revision, actual: task.revision,
    });
  }
}

export function record(
  task: Task,
  action: string,
  actor: Actor,
  next: TaskState = task.status,
  message?: string,
): Task {
  const at = new Date().toISOString();
  const event: Task["history"][number] = { at, actor, action };
  if (message) event.text = message;
  if (next !== task.status) {
    event.from = task.status;
    event.to = next;
  }
  return {
    ...task,
    status: next,
    revision: task.revision + 1,
    updatedAt: at,
    ...(next === "done" || next === "cancelled" ? { closedAt: at } : {}),
    history: [...task.history, event],
  };
}
