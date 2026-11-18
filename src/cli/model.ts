export const taskStates = ["draft", "ready", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export const priorities = ["low", "normal", "high", "urgent"] as const;
export const legacyTagColors = {
  purple: "#C0A5F4",
  blue: "#91B6F9",
  cyan: "#7FC8D6",
  pink: "#F196B2",
  green: "#86CFAD",
} as const;
const tagColors = Object.values(legacyTagColors);
export const hexTagColor = /^#[0-9a-fA-F]{6}$/;
export const maxAttachmentBytes = 64 * 1024 * 1024;
export const codexThreadPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const imageAttachmentPattern = /\.(png|jpe?g|webp|gif)$/i;

export type TaskState = typeof taskStates[number] | `manual:${string}`;
export interface ManualColumn { id: `manual:${string}`; name: string; color: string; terminal: boolean }
export type Priority = typeof priorities[number];
export function validDueDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export type Actor = "agent" | "user" | "manager" | "reviewer";
export type IntegrationMode = "merge" | "squash";
export interface BoardTag {
  name: string;
  color: string;
}

export function tagKey(name: string): string {
  return name.trim().normalize().toLowerCase();
}

function defaultTagColor(name: string): string {
  let color = 0;
  for (const character of name) color = (color * 31 + character.codePointAt(0)!) % tagColors.length;
  return tagColors[color];
}

export function registerTags(tags: BoardTag[], names: string[]): string[] {
  const byName = new Map(tags.map(tag => [tagKey(tag.name), tag]));
  const assigned = new Set<string>();
  for (const name of names) {
    const key = tagKey(name);
    let tag = byName.get(key);
    if (!tag) {
      tag = { name, color: defaultTagColor(name) };
      byName.set(key, tag);
      tags.push(tag);
    }
    assigned.add(tag.name);
  }
  return [...assigned];
}

export interface Attachment {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  link?: import("./attachment-links.ts").FileLink;
}

export interface TaskGit {
  target: string;
  base: string;
  branch: string;
  worktree?: string;
  submission?: { sha: string; message: string };
  accepted?: string;
}

export interface ChatSettings {
  model: string;
  effort: string;
}

export const boardAgentRoles = ["manager", "executor", "reviewer"] as const;
export type AgentLimits = Record<typeof boardAgentRoles[number], number>;

export function validAgentLimitOverrides(value: unknown): value is Partial<AgentLimits> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([role, limit]) => boardAgentRoles.some(key => key === role) &&
      typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0);
}

export type BoardAgentSettings = ChatSettings & { provider?: "codex" };
export const reviewModes = ["human", "manager", "reviewer", "reviewer-human"] as const;
export type ReviewMode = typeof reviewModes[number];

export interface ChatUsage {
  used: number;
  limit: number;
}

export interface RunActivity {
  at?: string;
  id: string;
  type: string;
  title: string;
  text: string;
  status: string;
  phase?: "commentary" | "final_answer";
}

export interface TaskEvent {
  expertMessage?: { from: string; to: string; replyTo?: number };
  expertSkill?: { expertId: string; skillId: string; name: string; source: "plan" | "tool" };
  expertPhase?: "work" | "review";
  expertStageRun?: { phase: "work" | "review"; key: string; state: "running" | "blocked" | "done";
    result?: string; outputs?: Record<string, string>; agentId?: string; sessionId?: string; fallback?: string; targetHead?: string | null };
  at: string;
  durationMs?: number;
  startTiming?: { lockWaitMs: number; prepareMs: number; gitWorktreeAddMs?: number };
  actor: Actor;
  action: string;
  text?: string;
  mergedInto?: { id: string; title: string; transferred: string };
  messageKind?: "question" | "update" | "decision";
  reviewApproval?: { reviewModeVersion?: number; revision: number; targetHead: string | null; evidence: string[] };
  replyToMessage?: number;
  attachment?: string;
  from?: TaskState;
  to?: TaskState;
  chat?: ChatSettings & { files?: string[]; usage?: ChatUsage; commentary?: string[] };
  run?: RunActivity[];
}

export const githubRepositoryPattern = /^[a-z0-9][a-z0-9-]*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i;
export interface GitHubMilestone {
  repository: string;
  number: number;
  title: string;
}

export const scheduleTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type TaskScheduleRule =
  | ({ time: string; everyMinutes?: never } & (
    { weekday?: number; dayOfMonth?: never; month?: never } |
    { weekday?: never; dayOfMonth: number; month?: number }))
  | { everyMinutes: number; time?: never; weekday?: never; dayOfMonth?: never; month?: never };
export type TaskSchedule = TaskScheduleRule & { nextAt: string; paused?: boolean };

export function validScheduleDate(day: unknown, month: unknown): boolean {
  return typeof day === "number" && Number.isInteger(day) && day >= 1 && (month === undefined ? day <= 31 :
    typeof month === "number" && Number.isInteger(month) && month >= 1 && month <= 12 &&
    day <= new Date(2024, month, 0).getDate());
}

export function nextScheduledRun(rule: TaskScheduleRule, after: Date, previous?: string): string {
  if (rule.everyMinutes !== undefined) {
    const interval = rule.everyMinutes * 60_000;
    const now = after.getTime();
    const anchor = previous ? Date.parse(previous) : now;
    const next = new Date(anchor > now ? anchor : anchor + (Math.floor((now - anchor) / interval) + 1) * interval);
    if (!Number.isFinite(next.getTime())) throw new TaskboardError("INVALID_INPUT", "The recurring interval is too long.");
    return next.toISOString();
  }
  const { time, weekday, dayOfMonth, month } = rule;
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3));
  if (dayOfMonth !== undefined) {
    const year = after.getFullYear();
    const currentMonth = month === undefined ? after.getMonth() : month - 1;
    const occurrence = (offset: number) => {
      const nextMonth = currentMonth + offset;
      const lastDay = new Date(year, nextMonth + 1, 0).getDate();
      return new Date(year, nextMonth, Math.min(dayOfMonth, lastDay), hour, minute);
    };
    const next = occurrence(0);
    return (next > after ? next : occurrence(month === undefined ? 1 : 12)).toISOString();
  }
  const next = new Date(after);
  const days = weekday === undefined ? 0 : (weekday - after.getDay() + 7) % 7;
  next.setDate(after.getDate() + days);
  next.setHours(hour, minute, 0, 0);
  if (next <= after) {
    next.setDate(next.getDate() + (weekday === undefined ? 1 : 7));
    next.setHours(hour, minute, 0, 0);
  }
  return next.toISOString();
}

export interface ExpertPhase {
  lead?: string | null;
  reason?: string;
  skills?: string[];
  stages: { key: string; expertId: string; title: string; description: string; criteria: string[];
    inputs: string[]; outputs: string[]; dependsOn: string[]; artifactOutputs?: Record<string, ArtifactKind> }[];
}

export type ArtifactKind = "png" | "text";

export interface Task {
  draftDiscussion?: { phase: "queued" | "running" } | { phase: "failed"; reason: string };
  expertId?: string;
  expertTeam?: { work?: ExpertPhase; review?: ExpertPhase };
  expertStage?: { parentId: string; key: string; inputs: string[]; outputs: string[] };
  expertStages?: { key: string; taskId: string; expertId: string; title: string; inputs: string[]; outputs: string[]; dependsOn: string[] }[];
  acceptanceRepair?: { phase: "queued" | "running" | "checking" | "failed"; reviewModeVersion?: number; targetHead: string; attempts: number; message: string; reason?: string };
  tokenUsage?: import("./token-usage.ts").TaskTokenUsage;
  id: string;
  title: string;
  description: string;
  criteria: string[];
  questions: string[];
  tags: string[];
  priority: Priority;
  dueDate?: string;
  subtasks: { title: string; done: boolean }[];
  attachments: Attachment[];
  coverAttachment?: string;
  status: TaskState;
  codexThreadId?: string;
  goalThreadId?: string;
  managerReadThrough?: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  summary: string;
  nextStep: string;
  dependencies?: string[];
  milestone?: GitHubMilestone;
  execution?: { model: string; effort?: string };
  toolGrants?: { server: string; tool: string }[];
  workingDirectory?: string;
  schedule?: TaskSchedule;
  origin?: { parent: string; key: string; basis: string };
  launchRequested?: boolean;
  discussionReturn?: number;
  childWork?: { key: string; basis: string; id: string }[];
  blocked?: { reason: string; condition: string; previousStatus?: "draft" | "ready" };
  result?: { summary: string; checks: string[]; limitations: string[]; noChanges?: { head: string | null };
    artifactEvidence?: { stage: string; output: string; kind: ArtifactKind; source: string; sha256: string }[] };
  artifacts?: { source: string; file: string; sha256: string }[];
  git?: TaskGit;
  history: TaskEvent[];
}

export interface BoardSettings {
  boardType?: "agent" | "manual";
  requireExpertPlans?: boolean;
  manualColumns?: ManualColumn[];
  name?: string;
  archiveAfterDays: number | null;
  integrationMode: IntegrationMode;
  showCardPreviews?: boolean;
  manager?: BoardAgentSettings | null;
  executor?: BoardAgentSettings | null;
  reviewer?: BoardAgentSettings | null;
  taskLimits?: Partial<AgentLimits>;
  reviewMode?: ReviewMode;
  reviewModeVersion?: number;
  autoReview?: boolean;
  autoMode?: boolean;
  autoQueue?: { revision: number; paused: boolean; order: string[]; held: string[] };
}

export const defaultBoardAgents = {
  manager: { provider: "codex", model: "gpt-6.2-sol", effort: "medium" },
  executor: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
  reviewer: { provider: "codex", model: "gpt-6.1-terra", effort: "high" },
} satisfies Record<typeof boardAgentRoles[number], BoardAgentSettings>;

export const reviewVerifier = { model: "gpt-6.1-sol", effort: "xhigh" } satisfies ChatSettings;

export function usesIndependentReviewer(mode: ReviewMode): boolean {
  return mode === "reviewer" || mode === "reviewer-human";
}

export function boardReviewMode(settings: Pick<BoardSettings, "reviewMode" | "autoReview">): ReviewMode {
  return settings.reviewMode ?? (settings.autoReview === true ? "reviewer" : "human");
}

export interface ArchiveLink {
  path: string;
  title: string;
  status: "done" | "cancelled";
  closedAt: string;
  archivedAt: string;
  updatedAt?: string;
  tags?: string[];
  milestone?: GitHubMilestone;
  tagOverride?: { tags: string[]; history: TaskEvent[] };
}

export interface BoardIndex {
  managerSettings?: import("./settings-notices.ts").SettingsJournal;
  version: 1;
  nextId: number;
  settings: BoardSettings;
  tags?: BoardTag[];
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
export const reasoningEffortPattern = /^[a-z][a-z0-9_-]{0,31}$/;

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
  if (task.acceptanceRepair) {
    if (action === "submit") task = { ...task, acceptanceRepair: { ...task.acceptanceRepair, phase: "checking" } };
    else if (["request-changes", "cancel", "accept"].includes(action)) task = { ...task, acceptanceRepair: undefined };
  }
  const at = new Date().toISOString();
  const event: Task["history"][number] = { at, actor, action };
  if (message) event.text = message;
  if (next !== task.status) {
    event.from = task.status;
    event.to = next;
  }
  return {
    ...task,
    ...(task.schedule && next === "ready" && task.status !== "ready"
      ? { schedule: { ...task.schedule, nextAt: nextScheduledRun(task.schedule, new Date(at),
        task.status === "in_progress" ? task.schedule.nextAt : undefined) } } : {}),
    ...(next !== "draft" && task.draftDiscussion ? { draftDiscussion: undefined } : {}),
    ...(next !== "in_progress" && task.discussionReturn !== undefined ? { discussionReturn: undefined } : {}),
    status: next,
    revision: task.revision + 1,
    updatedAt: at,
    ...(next === "done" || next === "cancelled" ? { closedAt: at } : {}),
    history: [...task.history, event],
  };
}
