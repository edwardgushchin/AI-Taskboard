import type { MaintenanceJob } from "../cli/maintenance-state.ts";
import { isManual, manualContext } from "../cli/manual-board.ts";
import { russianWriting } from "./russian-writing.ts";
import { captureFileLink, isFileLink, verifyFileLink } from "../cli/attachment-links.ts";
import type { FileLink } from "../cli/attachment-links.ts";
import { providerLimitSource, readCodexLimits } from "./provider-limits.ts";
import localization from "./localization.cjs";
import { activeRunSummary, observeActiveRuns, enableSharedRuns } from "./active-runs.ts";
import { registerRuntime, runtimeLocation, runtimeTransaction } from "./board-runtime.ts";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, session, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { callCli, cliChild, cliFailure } from "./cli.ts";
import { githubReadTool, readBoardGitHub } from "./github-read.ts";
import { codexStatus, configuredCodex, executorFullAccess, isManagerAccess, managerAccess, setCodexExecutable, setCodexWindowsSandbox, setTaskExecutorAccess } from "./codex.ts";
import { chatModels, readBoardHistory, readLastTaskTurn, readTaskRunHistory, replyToBoard, replyToTask, reviewWithCodex, updateBoardGoal } from "./codex-chat.ts";
import type { BoardActivity, BoardGoal, BoardGoalAction } from "./codex-chat.ts";
import { autoReviewInstructions, autoReviewReadTools, autoReviewTaskTools, boardActions, boardInstructions, boardMcpTools, boardTools, manualReviewInstructions, reviewerTools } from "./board-actions.ts";
import { phaseStageReporter } from "./expert-tools.ts";
import type { BoardChange, ReviewedSubmission, ReviewReport } from "./board-actions.ts";
import type { AgentControl } from "./codex-rpc.ts";
import type { TaskUsageRole, TokenUsageReport } from "../cli/token-usage.ts";
import { taskChatActions } from "./chat-actions.ts";
import type { CliReply } from "./cli.ts";
import { executionModels } from "./codex-models.ts";
import type { ArchiveLink, BoardSettings, BoardTag, ReviewMode, RunActivity, Task } from "../cli/model.ts";
import { boardReviewMode, codexThreadPattern, defaultBoardAgents, maxAttachmentBytes, reviewVerifier, taskIdPattern } from "../cli/model.ts";
import { directory as storageDirectory, readBoardSettings, readJson, writeJson } from "../cli/storage.ts";
import { missingCodexThread, startCodexRun } from "./codex-run.ts";
import type { ExecutorTask } from "./codex-run.ts";
import { runLog } from "./run-activity.ts";
import { readRunImage } from "./run-images.ts";
import { projectIdentity, projectLabels, projectPath, savedWindows } from "./project-tabs.ts";
import { readMarkdownFile } from "./markdown-files.ts";
import { normalizeRecentBoards, readRecentBoards, rememberRecentBoard } from "./recent-boards.ts";
import { transcribeVoice } from "./voice-transcription.ts";
import { startWindowsDictation } from "./windows-dictation.ts";
import { needsManagerAttention } from "../cli/task-messages.ts";
import { readReviewReports, saveReviewReports } from "./review-history.ts";
import { readReviewerChat, reviewerActivity, withReviewerChat } from "./reviewer-chat.ts";
import { goalMessages, hasManagerMessage, managerChatItems, managerUnread, managerWorkItems, readManagerHistory, readManagerMessages, readManagerView, saveManagerHistory } from "./manager-history.ts";
import type { BoardMcpTool } from "./board-mcp.ts";
import { createAgentSlots, parseAgentLimits } from "./agent-limits.ts";
import { nextReadyTask } from "./auto-queue.ts";
import { automationDelivery } from "./automation-delivery.ts";
import type { AgentRole } from "./agent-limits.ts";
import { checkForUpdates } from "./updates.ts";
import { settingsDelivery, syncSettingsNotices } from "./settings-notices.ts";

interface Board {
  project: string;
  settings: BoardSettings;
  tags: BoardTag[];
  tasks: (Task & { historyLength?: number; reviewApproved?: true; reviewHasCommit?: true; mergeRepair?: true; unfinishedDependencies?: string[];
    expertWorkPlanned?: boolean; expertReviewPlanned?: boolean })[];
  managerInbox?: ReturnType<typeof import("../cli/task-messages.ts").managerInbox>;
  archived: (ArchiveLink & { id: string })[];
  cleanedTasks?: string[];
  gitInfo?: ReturnType<typeof import("../cli/repository.ts").boardGitInfo>;
}

interface ProjectTab {
  window: BrowserWindow;
  project?: string;
  board?: Board;
  error?: { code: string; message: string; operation: "refresh" | "open" | "create" | "save-session" };
  loading?: boolean;
  selection: number;
}

interface WindowState {
  window: BrowserWindow;
  tabs: ProjectTab[];
  active: ProjectTab;
  closing?: boolean;
  ready?: Promise<void>;
  restoring: boolean;
  restoredActive?: ProjectTab;
}

interface BoardWatch {
  tabs: Set<ProjectTab>;
  listeners: Set<(board: Board, runChanged?: boolean) => void>;
  board: Board;
  stop: () => void;
  reviewAttempts: Map<string, string>;
  integrationAttempts: Map<string, number>;
  shared?: { runtime: string; context?: string; activity: string; queue: number; history: number; unread: number };
  reviewReports: Map<string, ReviewedSubmission>;
  reviewerRuns: Map<string, Promise<void>>;
}

const html = new URL("./index.html", import.meta.url);
const markdownAsset = "taskboard-assets://vendor/markdown-it.js";
protocol.registerSchemesAsPrivileged([{ scheme: "taskboard-assets", privileges: { standard: true, secure: true } }]);
const customTitleBar = process.platform === "win32";
const titleBarHeight = 36;
const windowStates = new Map<number, WindowState>();
const subscriptions = new Map<string, BoardWatch>();
const commands = new Map<string, string[]>([
  ...["experts", "expert-get", "expert-save", "expert-skill", "expert-plan", "expert-inbox"].map(name => [name, [name]] as [string, string[]]),
  ["create", ["create"]],
  ["manual-move", ["manual-move"]], ["manual-columns", ["manual-columns"]],
  ["project-usage", ["project-usage"]],
  ["init", ["init", "--compact"]], ["list", ["list", "--compact"]], ["show", ["show"]], ["update", ["update"]],
  ["comment", ["comment"]],
  ["git-refs", ["git", "refs"]], ["git-switch", ["git", "switch"]],
  ["git-create", ["git", "create"]], ["git-detach", ["git", "detach"]], ["git-publish", ["git", "publish"]],
  ["git-push", ["git", "push"]],
  ["approve", ["approve"]], ["review", ["review"]], ["review-queue", ["review-queue"]], ["accept", ["accept"]],
  ["return-to-draft", ["return-to-draft"]],
  ["restore-changes", ["restore-changes"]],
  ["attachment-cover", ["attachment", "cover"]],
  ["request-changes", ["request-changes"]], ["cancel", ["cancel"]], ["cleanup", ["cleanup"]],
  ["cleanup-status", ["cleanup-status"]],
  ["settings", ["settings"]], ["archive", ["archive", "sweep"]], ["doctor", ["doctor"]],
  ["tag-color", ["tag", "set"]],
  ["tag-create", ["tag", "ensure"]],
  ["tag-assign", ["tag", "assign"]],
  ["milestones", ["milestones"]], ["milestone", ["milestone"]],
]);

const t = localization.text;
const themes = {
  system: ["System", "system"],
  light: ["Light", "light"],
  dark: ["Dark", "dark"],
  "github-light": ["GitHub Light", "light"],
  "github-dark": ["GitHub Dark", "dark"],
  dracula: ["Dracula", "dark"],
  nord: ["Nord", "dark"],
  "one-dark": ["One Dark", "dark"],
  "tokyo-night": ["Tokyo Night", "dark"],
  "catppuccin-mocha": ["Catppuccin Mocha", "dark"],
  "solarized-light": ["Solarized Light", "light"],
  "solarized-dark": ["Solarized Dark", "dark"],
  "gruvbox-dark": ["Gruvbox Dark", "dark"],
} as const;
type Theme = keyof typeof themes;
let theme: Theme = "system";
let recentBoards: string[] = [];

function loadRecentBoards(): void {
  recentBoards = readRecentBoards(app.getPath("appData"), app.getPath("userData")) ?? recentBoards;
}

function rememberBoard(path: string, current: ProjectTab): void {
  try {
    recentBoards = rememberRecentBoard(app.getPath("appData"), app.getPath("userData"), path);
  } catch {
    recentBoards = normalizeRecentBoards([path, ...recentBoards]);
  }
  for (const state of windowStates.values()) {
    if (state.window !== current.window) send(state.active);
  }
}

function titleBarOverlay() {
  return { height: titleBarHeight, color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#e3e7f3" : "#20283a" };
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && Object.hasOwn(themes, value);
}

function loadTheme(): void {
  try {
    const preference = readJson(join(app.getPath("userData"), "appearance.json")) as { theme?: unknown; language?: unknown };
    if (isTheme(preference?.theme)) theme = preference.theme;
    localization.select(typeof preference?.language === "string" && (preference.language === "system" || Object.hasOwn(localization.names, preference.language)) ? preference.language : "system", app.getPreferredSystemLanguages());
  } catch {
    // A missing or unreadable preference falls back to the system setting.
  }
  nativeTheme.themeSource = themes[theme][1];
}

function stateOf(event: IpcMainInvokeEvent): ProjectTab {
  const state = windowStates.get(event.sender.id);
  if (!state || !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== html.href) {
    throw new Error("Unexpected application frame.");
  }
  return state.active;
}

function boardUnread(project?: string) {
  try { return project ? managerUnread(project) : []; }
  catch { return []; }
}

function frame(state: ProjectTab) {
  const key = state.board && projectIdentity(state.board.project);
  const request = key ? boardRequests.get(key) : undefined;
  const work = key ? boardWorkRequests.get(key) : undefined;
  const reviewerRuns = state.project ? subscriptions.get(state.project)?.reviewerRuns : undefined;
  const sharedRuns = state.board ? agentSlots.entries(state.board.project) : [];
  const managerContext = sharedRuns.find(entry => entry.task === "manager:context");
  const sharedManager = managerContext?.state && { ...managerContext.state, live: undefined };
  const background = sharedRuns.find(entry => entry.task === "manager:background")?.state;
  const openTabs = windowStates.get(state.window.webContents.id)?.tabs ?? [];
  const unreadTabs = new Set(openTabs.flatMap(tab =>
    tab.project && boardUnread(tab.board?.project).length ? [tab.project] : []));
  const activity = activeRunSummary([...subscriptions.values()].map(watch => ({
    path: watch.board.project, name: watch.board.settings.name })));
  return {
    restoring: windowStates.get(state.window.webContents.id)?.restoring ?? false,
    tabs: projectLabels(openTabs.flatMap(tab =>
      tab.project ? [{ path: tab.project, name: tab.board?.settings?.name }] : []))
      .map(tab => ({ ...tab, unread: unreadTabs.has(tab.path), activity: activity.boards.find(board => board.path === tab.path) })),
    activeAgents: activity,
    managerUnread: boardUnread(state.board?.project),
    project: state.project, board: state.board, error: state.error, loading: state.loading, localization: localization.state(), theme,
    managerQuestion: key ? managerQuestion(key)?.view : undefined,
    managerAccess: state.project ? managerAccess(app.getPath("userData"), state.project) : "auto",
    managerBusy: Boolean(managerContext),
    managerRun: request?.managerRun ?? (sharedManager?.lane === "chat" ? sharedManager : null),
    managerWork: work?.managerRun ?? (sharedManager?.lane !== "chat" ? sharedManager : undefined) ??
      (background ? { ...background, live: undefined } : null),
    runningTasks: state.board?.tasks.filter(task => {
      const key = state.project + "\0" + task.id;
      return runningTasks.has(key) || sharedRuns.some(entry => entry.kind === "slot" && entry.task === task.id);
    }).map(task => task.id),
    replyingTasks: state.board?.tasks.filter(task => (replyingTasks.has(state.project + "\0" + task.id) || sharedRuns.some(entry => entry.kind === "task" && entry.task === task.id))).map(task => task.id),
    waitingTasks: state.board?.tasks.filter(task => {
      const key = state.project + "\0" + task.id;
      return task.status === "in_progress" && (deferredExecutors.get(key)?.revision === task.revision || sharedRuns.some(entry => entry.kind === "queue" && entry.task === task.id && entry.revision === task.revision)) &&
        !runningTasks.has(key) && !replyingTasks.has(key) && !sharedRuns.some(entry => entry.kind === "slot" && entry.task === task.id);
    }).map(task => task.id),
    reviewingTasks: Object.fromEntries(state.board?.tasks.flatMap(task => {
      if (task.status !== "review") return [];
      if (reviewerRuns?.has(task.id) || sharedRuns.some(entry => entry.kind === "slot" && entry.role === "reviewer" && entry.task === "review:" + task.id)) return [[task.id, "reviewer"]];
      if (request?.reviewing?.has(task.id) || work?.reviewing?.has(task.id) || sharedRuns.some(entry => entry.state?.reviewing?.includes(task.id))) return [[task.id, "manager"]];
      return [];
    }) ?? []),
    runActivity: Object.fromEntries(state.board?.tasks.flatMap(task => {
      const log = runActivityByTask.get(state.project + "\0" + task.id);
      return log ? [[task.id, log]] : [];
    }) ?? []),
    recentBoards: recentBoards.map(path => ({ name: basename(path) || path, path })),
  };
}

function send(state: ProjectTab): void {
  if (state.window.isDestroyed()) return;
  const owner = windowStates.get(state.window.webContents.id);
  if (owner) {
    state = owner.active;
    state.window.webContents.send("board:changed", frame(state));
    state.window.setTitle(state.project ? basename(state.project) + " · AI Taskboard" : "AI Taskboard");
  }
}

observeActiveRuns(() => {
  for (const { active } of windowStates.values()) send(active);
});

function publishReviewActivity(project: string) {
  for (const requests of [boardRequests, boardWorkRequests, backgroundManagerRequests]) {
    requests.get(projectIdentity(project))?.publishRun?.();
  }
  for (const { active } of windowStates.values()) {
    if (active.project === project) send(active);
  }
}

function publishManagerUnread(project: string) {
  for (const { active, tabs } of windowStates.values()) {
    if (tabs.some(tab => tab.board?.project === project)) send(active);
  }
}

function unbind(state: ProjectTab): void {
  if (!state.board) return;
  const project = state.board.project;
  const watch = subscriptions.get(project);
  watch?.tabs.delete(state);
  if (watch) releaseWatch(project, watch);
}

function releaseWatch(project: string, watch: BoardWatch): void {
  if (!watch.tabs.size && !watch.listeners.size) {
    watch.stop();
    subscriptions.delete(project);
  }
}

function subscribe(project: string, board: Board): BoardWatch {
  agentSlots.remember(project);
  const tabs = new Set<ProjectTab>();
  let child: ReturnType<typeof cliChild> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let noticeRetry: NodeJS.Timeout | undefined;
  let noticesRunning = false;
  let noticesPending = false;
  let stopped = false;
  let startedArchiveSweep = false;
  const watch: BoardWatch = {
    tabs, board, listeners: new Set(), reviewAttempts: new Map(), integrationAttempts: new Map(),
    reviewReports: readReviewReports(app.getPath("userData"), project), reviewerRuns: new Map(),
    stop: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (noticeRetry) clearTimeout(noticeRetry);
      clearInterval(sweep);
      child?.kill();
    },
  };
  const archive = () => { void callCli(project, ["archive", "sweep"]); };
  const sweep = setInterval(archive, 24 * 60 * 60 * 1000);
  async function syncNotices() {
    if (stopped || noticesRunning || noticeRetry || !noticesPending) return;
    noticesRunning = true;
    noticesPending = false;
    try {
      const result = await callCli<{ changed: boolean }>(project, ["sync-notices"], {
        language: localization.locale,
      });
      if (stopped) return;
      if (!result.ok) {
        if (result.error.code !== "BOARD_BUSY") throw new Error(result.error.message);
        noticesPending = true;
        noticeRetry = setTimeout(() => {
          noticeRetry = undefined;
          void syncNotices();
        }, 1000);
        return;
      }
      if (result.data.changed) {
        broadcastBoardChat(project, "orchestrator-work-history");
      }
      const key = projectIdentity(project);
      boardRequests.get(key)?.settingsChanged?.();
      boardWorkRequests.get(key)?.settingsChanged?.();
      backgroundManagerRequests.get(key)?.settingsChanged?.();
    } catch (error) {
      if (!stopped) console.error("Could not synchronize board notices.", error);
    } finally {
      noticesRunning = false;
      if (noticesPending && !noticeRetry) void syncNotices();
    }
  }
  let noticeStamp: string | undefined;
  function queueNotices(snapshot: Board) {
    // Git-only changes and runtime refreshes do not affect persistent notices.
    const stamp = JSON.stringify([snapshot.settings,
      snapshot.tasks.map(task => [task.id, task.historyLength ?? task.history?.length, task.revision]),
      snapshot.archived.map(task => task.id)]);
    if (noticeStamp === stamp) return;
    noticeStamp = stamp;
    noticesPending = true;
    void syncNotices();
  }
  const launch = () => {
    if (stopped) return;
    const active = cliChild(project, ["watch", "--compact"]);
    child = active;
    const lines = createInterface({ input: active.stdout });
    active.stderr.resume();
    lines.on("line", line => {
      if (stopped) return;
      let result: CliReply<Board>;
      try { result = JSON.parse(line); }
      catch { result = cliFailure("CLI_UNAVAILABLE", t("errors.4bdf418ab969e5b1")); }
      if (result.ok) {
        queueNotices(result.data);
        watch.board = result.data;
        for (const requests of [boardRequests, boardWorkRequests]) requests.get(projectIdentity(project))?.automationChanged?.(result.data);
        for (const listener of watch.listeners) listener(result.data);
        scheduleAgentWork();
      }
      for (const state of tabs) {
        if (result.ok) state.board = result.data;
        state.error = result.ok ? undefined : { ...result.error, operation: "refresh" };
        send(state);
      }
      if (result.ok && !startedArchiveSweep) {
        startedArchiveSweep = true;
        archive();
      }
    });
    active.on("error", () => {});
    active.once("close", () => {
      lines.close();
      if (stopped) return;
      for (const state of tabs) {
        state.error = { code: "WATCH_STOPPED", operation: "refresh",
          message: t("ui.updates_paused_reconnecting_4108c957") };
        send(state);
      }
      retry = setTimeout(launch, 1500);
    });
  };
  queueNotices(board);
  launch();
  return watch;
}

function bind(state: ProjectTab, board: Board): void {
  if (state.board?.project !== board.project) unbind(state);
  state.project = board.project;
  let watch = subscriptions.get(board.project);
  if (!watch) {
    watch = subscribe(board.project, board);
    subscriptions.set(board.project, watch);
  }
  watch.tabs.add(state);
  state.board = watch.board;
  rememberBoard(board.project, state);
  scheduleAutoReview(watch);
}

function observeBoardTasks(board: Board, listener: (board: Board, runChanged?: boolean) => void): () => void {
  let watch = subscriptions.get(board.project);
  if (!watch) {
    watch = subscribe(board.project, board);
    subscriptions.set(board.project, watch);
  }
  const observed = watch;
  observed.listeners.add(listener);
  return () => {
    observed.listeners.delete(listener);
    releaseWatch(board.project, observed);
  };
}

function activateTab(owner: WindowState, tab: ProjectTab): void {
  owner.restoredActive = undefined;
  owner.active = tab;
  send(tab);
  saveSession();
}

async function openProject(current: ProjectTab, project: string, create: false | "agent" | "manual" = false): Promise<void> {
  const owner = windowStates.get(current.window.webContents.id);
  if (!owner || owner.closing) return;
  project = projectPath(project);
  const existing = owner.tabs.find(tab => tab.project && projectIdentity(tab.project) === projectIdentity(project));
  if (existing) {
    activateTab(owner, existing);
    if (existing.board || existing.loading) return;
  }
  const state = existing ?? (owner.tabs.find(tab => !tab.project) || { window: owner.window, selection: 0 });
  if (!owner.tabs.includes(state)) owner.tabs.push(state);
  state.project = project;
  state.error = undefined;
  state.loading = true;
  activateTab(owner, state);
  await loadProject(owner, state, project, create);
}

async function loadProject(owner: WindowState, state: ProjectTab, project: string, create: false | "agent" | "manual" = false): Promise<void> {
  const selection = ++state.selection;
  state.project = project;
  state.error = undefined;
  state.loading = true;
  const result = existsSync(project) ? await callCli<Board>(project, [create ? "init" : "list", "--compact"], create ? { git: create !== "manual", boardType: create } : undefined)
    : cliFailure("PROJECT_UNAVAILABLE", t("ui.the_folder_is_unavailable_a85a1dc3"));
  if (state.selection !== selection || owner.window.isDestroyed() || !owner.tabs.includes(state)) return;
  state.loading = false;
  if (result.ok) {
    const duplicate = owner.tabs.find(tab => tab !== state && tab.project &&
      projectIdentity(tab.project) === projectIdentity(result.data.project));
    if (duplicate) {
      owner.tabs.splice(owner.tabs.indexOf(state), 1);
      if (owner.active === state) owner.active = duplicate;
    } else bind(state, result.data);
  } else state.error = { ...result.error, operation: create ? "create" : "open" };
  // Only an untouched startup selection may fall back after a failed load.
  // User selection/closure cancels this even when its request is still pending.
  if (owner.restoredActive === owner.active) {
    if (owner.active.board) owner.restoredActive = undefined;
    else if (owner.active.error) {
      const available = owner.tabs.find(tab => tab.board);
      if (available) {
        owner.active = available;
        owner.restoredActive = undefined;
      }
    }
  }
  send(state);
  saveSession();
}

let restoringSession = false;
let quitting = false;

function saveSession(): void {
  if (restoringSession || quitting || !windowStates.size) return;
  try {
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "project-tabs.json"), [...windowStates.values()].map(state => ({
      projects: state.tabs.flatMap(tab => tab.project ? [tab.project] : []), active: state.active.project,
    })));
  } catch (error) {
    const state = [...windowStates.values()].find(state => !state.window.isDestroyed());
    if (state) {
      state.active.error = { code: "SESSION_SAVE_FAILED", operation: "save-session",
        message: t("ui.could_not_save_open_projects_ca8ee196") + " " + (error as Error).message };
      send(state.active);
    }
  }
}

interface ProjectOperation {
  label?: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}
const projectOperations = new Map<string, Set<ProjectOperation>>();
const closingProjects = new Set<string>();

function beginOperation(project: string, label?: string) {
  if (closingProjects.has(project)) throw new Error(t("ui.the_project_is_closing_beb637fb"));
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  const operation: ProjectOperation = { label, controller, done: completion.promise, finish: () => {
    projectOperations.get(project)?.delete(operation);
    if (!projectOperations.get(project)?.size) projectOperations.delete(project);
    completion.resolve();
  } };
  const operations = projectOperations.get(project) ?? new Set();
  operations.add(operation);
  projectOperations.set(project, operations);
  return operation;
}

async function confirmProjectClose(state: WindowState, tabs: ProjectTab[]): Promise<boolean> {
  const projects = [...new Set(tabs.flatMap(tab => tab.project ? [tab.project] : []))];
  const operations = projects.flatMap(project => [...(projectOperations.get(project) ?? [])]);
  if (!operations.length) return true;
  const result = await dialog.showMessageBox(state.window, {
    type: "warning", title: "AI Taskboard",
    message: t("ui.a_task_is_still_running_in_the_project_closing_w_52cab0f1"),
    detail: projects.flatMap(project => {
      const pending = projectOperations.get(project);
      if (!pending?.size) return [];
      const labels = [...new Set([...pending].flatMap(operation => operation.label ? [operation.label] : []))];
      return [[project, ...labels].join("\n")];
    }).join("\n\n"),
    buttons: [t("ui.cancel_4c6dcc32"), t("ui.interrupt_and_close_03ea6433")],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  if (result.response !== 1) return false;
  for (const project of projects) closingProjects.add(project);
  try {
    const active = projects.flatMap(project => [...(projectOperations.get(project) ?? [])]);
    for (const operation of active) operation.controller.abort(new Error(t("ui.the_project_was_closed_ef8bc05a")));
    await Promise.all(active.map(operation => operation.done));
    return true;
  } finally {
    for (const project of projects) closingProjects.delete(project);
  }
}

async function closeTab(owner: WindowState, tab: ProjectTab): Promise<void> {
  if (owner.closing) return;
  owner.closing = true;
  try {
    if (!await confirmProjectClose(owner, [tab]) || owner.window.isDestroyed()) return;
    const index = owner.tabs.indexOf(tab);
    if (index < 0) return;
    owner.restoredActive = undefined;
    unbind(tab);
    tab.selection++;
    owner.tabs.splice(index, 1);
    if (!owner.tabs.length) owner.tabs.push({ window: owner.window, selection: 0 });
    if (owner.active === tab) owner.active = owner.tabs[Math.min(index, owner.tabs.length - 1)];
    send(owner.active);
    saveSession();
  } finally {
    owner.closing = false;
  }
}

async function pickProject(state: ProjectTab, create: false | "agent" | "manual" = false): Promise<void> {
  const result = await dialog.showOpenDialog(state.window, {
    title: create ? t("ui.create_board_e02d5c15") : t("ui.open_existing_board_754e46e5"),
    defaultPath: state.project && existsSync(state.project) ? state.project : undefined,
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths[0] && !state.window.isDestroyed()) {
    await openProject(state, result.filePaths[0], create);
  }
}

function createWindow(initial: string[] = [], selected?: string): WindowState {
  const window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 720, minHeight: 540,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
    title: "AI Taskboard",
    ...(customTitleBar ? { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay() } : {}),
  });
  window.webContents.zoomMode = "isolated";
  const id = window.webContents.id;
  const active: ProjectTab = { window, selection: 0 };
  const state: WindowState = { window, tabs: [active], active, restoring: initial.length > 0 };
  if (initial.length) {
    state.tabs = initial.map(project => ({ window, project: projectPath(project), selection: 0, loading: true }));
    state.active = state.tabs.find(tab => selected && projectIdentity(tab.project!) === projectIdentity(selected)) ?? state.tabs[0];
    state.restoredActive = state.active;
  }
  windowStates.set(id, state);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    if (state.closing) return;
    state.closing = true;
    void confirmProjectClose(state, state.tabs).then(confirmed => {
      if (!confirmed) return;
      saveSession();
      window.destroy();
    }).finally(() => { state.closing = false; });
  });
  window.once("closed", () => {
    for (const tab of state.tabs) { unbind(tab); tab.selection++; }
    windowStates.delete(id);
    saveSession();
  });
  state.ready = window.loadFile(fileURLToPath(html)).then(async () => {
    state.restoring = false;
    send(state.active);
    await Promise.all(state.tabs.filter(tab => tab.project).map(tab => loadProject(state, tab, tab.project!)));
    saveSession();
  }).finally(() => {
    state.restoring = false;
    send(state.active);
  });
  return state;
}

const menuActions: Record<string, (state: ProjectTab) => unknown> = {
  "new-window": () => createWindow(),
  "open-project": pickProject,
  "close-tab": tab => {
    const owner = windowStates.get(tab.window.webContents.id)!;
    return tab.project ? closeTab(owner, tab) : tab.window.close();
  },
  "close-window": ({ window }) => window.close(),
  quit: () => app.quit(),
  undo: ({ window }) => window.webContents.undo(),
  redo: ({ window }) => window.webContents.redo(),
  cut: ({ window }) => window.webContents.cut(),
  copy: ({ window }) => window.webContents.copy(),
  paste: ({ window }) => window.webContents.paste(),
  "select-all": ({ window }) => window.webContents.selectAll(),
  "zoom-in": ({ window }) => { window.webContents.zoomLevel += 1; },
  "zoom-out": ({ window }) => { window.webContents.zoomLevel -= 1; },
  "reset-zoom": ({ window }) => { window.webContents.zoomLevel = 0; },
  fullscreen: ({ window }) => window.setFullScreen(!window.isFullScreen()),
  about: ({ window }) => dialog.showMessageBox(window, {
    title: "AI Taskboard",
    message: "AI Taskboard " + app.getVersion(),
    detail: t("ui.a_local_task_board_for_software_projects_9cc9d29b"),
  }),
};

ipcMain.handle("menu:action", async (event, action: unknown) => {
  const state = stateOf(event);
  if (typeof action !== "string" || !Object.hasOwn(menuActions, action)) throw new Error("Unknown menu action.");
  await menuActions[action](state);
});

ipcMain.handle("board:bootstrap", event => {
  const state = stateOf(event);
  loadRecentBoards();
  return frame(state);
});
ipcMain.handle("board:selectTab", (event, project: unknown) => {
  const current = stateOf(event);
  const owner = windowStates.get(current.window.webContents.id)!;
  const tab = owner.tabs.find(tab => tab.project === project);
  if (!tab || owner.closing) return;
  activateTab(owner, tab);
});
ipcMain.handle("board:reorderTab", (event, project: unknown, target: unknown, after: unknown) => {
  const current = stateOf(event);
  const owner = windowStates.get(current.window.webContents.id)!;
  if (owner.closing || typeof after !== "boolean") return;
  const tab = owner.tabs.find(tab => tab.project === project);
  const destination = owner.tabs.find(tab => tab.project === target);
  if (!tab?.project || !destination?.project || tab === destination) return;
  owner.tabs.splice(owner.tabs.indexOf(tab), 1);
  owner.tabs.splice(owner.tabs.indexOf(destination) + Number(after), 0, tab);
  send(owner.active);
  saveSession();
});
ipcMain.handle("board:closeTab", async (event, project: unknown) => {
  const current = stateOf(event);
  const owner = windowStates.get(current.window.webContents.id)!;
  const tab = owner.tabs.find(tab => tab.project === project);
  if (tab) await closeTab(owner, tab);
});
ipcMain.handle("board:open", async event => pickProject(stateOf(event)));

interface PastedFile {
  name: string;
  type: string;
  bytes: ArrayBuffer;
  link?: FileLink;
}

function isPastedFile(file: unknown): file is PastedFile {
  if (!file || typeof file !== "object") return false;
  const { name, type, bytes, link } = file as Partial<PastedFile>;
  return typeof name === "string" && Boolean(name.trim()) && typeof type === "string" && bytes instanceof ArrayBuffer && (link === undefined || (isFileLink(link) && bytes.byteLength === 0));
}

ipcMain.handle("board:fileLink", (event, path: unknown) => {
  stateOf(event);
  if (typeof path !== "string") throw new Error("Invalid file path.");
  return captureFileLink(path);
});

ipcMain.handle("board:openFileLink", async (event, link: unknown) => {
  stateOf(event);
  if (!isFileLink(link)) return cliFailure("INVALID_INPUT", "Invalid attachment link.");
  try {
    const error = await shell.openPath(verifyFileLink(link));
    return error ? cliFailure("ATTACHMENT_UNAVAILABLE", error) : { ok: true, data: null };
  } catch (error) { return cliFailure("ATTACHMENT_UNAVAILABLE", (error as Error).message); }
});

const imageExtensions = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"],
]);
const imageTypes = new Map([...imageExtensions].map(([type, suffix]) => [suffix, type]));
imageTypes.set(".jpeg", "image/jpeg");
const chatRuns = new Set<string>();
const replyingTasks = new Set<string>();
interface ActiveAgent {
  control: AgentControl;
  directories: Set<string>;
  draftDiscussion?: true;
  chatWindow?: number;
  updateMessage?: (task: Task, index: number) => () => void;
}
const activeAgents = new Map<string, ActiveAgent>();
const returningDrafts = new Set<string>();
const reviewOperations = new Map<string, ProjectOperation>();
const managerReviewOperations = new Map<string, ProjectOperation>();
const taskOperations = new Map<string, ProjectOperation>();
const steeringOperations = new Map<string, Set<ProjectOperation>>();

async function returnTaskToDraft(project: string, id: string, revision: unknown, actor: "user" | "manager") {
  const key = project + "\0" + id;
  if (returningDrafts.has(key)) return cliFailure("CHAT_BUSY", "This task is already being returned to draft.");
  returningDrafts.add(key);
  try {
    if (isManual(readBoardSettings(runtimeLocation(project)))) return cliFailure("MANUAL_BOARD", "This action requires an agent board.");
    const current = await callCli<Task>(project, ["show", id, "--compact"]);
    if (!current.ok) return current;
    if (current.data.revision !== revision || ["done", "draft"].includes(current.data.status)) {
      return callCli<Task>(project, ["return-to-draft", id], { revision, actor });
    }
    const timeout = AbortSignal.timeout(15_000);
    const stop = (async () => {
      reviewOperations.get(key)?.controller.abort();
      managerReviewOperations.get(key)?.controller.abort();
      for (const operation of steeringOperations.get(key) ?? []) operation.controller.abort();
      const active = activeAgents.get(key);
      if (active) await active.control.interrupt();
      else taskOperations.get(key)?.controller.abort();
      while (launchingTasks.has(key) || runningTasks.has(key) || chatRuns.has(key) ||
          reviewOperations.has(key) || managerReviewOperations.has(key) || steeringOperations.has(key)) {
        await wait(50, undefined, { signal: timeout });
      }
    })();
    const deadline = new AbortController();
    try {
      await Promise.race([stop, wait(15_000, undefined, { signal: deadline.signal }).then(() => {
        throw new Error("The task writer did not stop within 15 seconds.");
      })]);
    } catch (error) {
      return cliFailure("CHAT_STOP_FAILED", timeout.aborted ? "The task writer did not stop within 15 seconds." : (error as Error).message);
    } finally {
      deadline.abort();
    }
    const result = await callCli<Task>(project, ["return-to-draft", id], { revision, actor });
    if (result.ok) deferredExecutors.delete(key);
    return result;
  } finally {
    returningDrafts.delete(key);
  }
}

async function stopChat(project: string, id: string) {
  const active = activeAgents.get(project + "\0" + id);
  if (!active) return cliFailure("CHAT_NOT_RUNNING", t("ui.the_agent_is_no_longer_running_72c32478"));
  try {
    await active.control.interrupt();
    return { ok: true as const, data: null };
  } catch (error) {
    return cliFailure("CHAT_STOP_FAILED", (error as Error).message);
  }
}

ipcMain.handle("chat:stop", async (event, id: unknown) => {
  const project = stateOf(event).board?.project;
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  return stopChat(project, id);
});

ipcMain.handle("chat:models", async event => {
  const project = stateOf(event).board?.project;
  if (!project) return cliFailure("BOARD_NOT_FOUND", t("errors.7b7b2fc6a65615f0"));
  try {
    return { ok: true, data: await chatModels(app.getPath("userData"), project) };
  } catch (error) {
    return cliFailure("CODEX_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }
});

interface ChatRequest {
  model: string;
  effort: string;
  text: string;
  files: PastedFile[];
  retryAt?: number;
}

type ChatUpdate = { type: "saved" | "changed" } | { type: "commentary"; text: string } | { type: "run"; items: RunActivity[] };

async function saveTaskTokenUsage(project: string, id: string, role: TaskUsageRole, report: TokenUsageReport): Promise<void> {
  const saved = await callCli(project, ["token-usage", id, "--compact"], { ...report, role });
  if (!saved.ok) console.warn("Could not save task token usage for %s (%s).", id, saved.error.code);
}

async function sendChat(project: string, id: string, request: ChatRequest, notify: (update: ChatUpdate) => void,
  automatic?: NonNullable<Task["draftDiscussion"]>["phase"], chatWindow?: number) {
  const key = project + "\0" + id;
  const active = activeAgents.get(key);
  if (returningDrafts.has(key) || (!active && (chatRuns.has(key) || launchingTasks.has(key))) ||
      (active && (automatic || active.draftDiscussion || request.retryAt !== undefined ||
        active.chatWindow !== undefined && active.chatWindow !== chatWindow))) {
    return { saved: false, result: cliFailure("CHAT_BUSY", t("ui.the_agent_is_already_replying_to_this_task_234378d8")) };
  }
  if (closingProjects.has(project)) return { saved: false, result: cliFailure("PROJECT_CLOSING",
    t("ui.the_project_is_closing_beb637fb")) };
  // A steering request can outlive the provider turn whose files it is preparing.
  const writer = active ? registerRuntime(project, { kind: "task", task: id }) : agentSlots.claim(project, id);
  if (!writer) return { saved: false, result: cliFailure("CHAT_BUSY", t("task_chat.writer_busy")) };
  const operation = beginOperation(project, t("ui.task_discussion_97daf76e") + " · " + id);
  const signal = operation.controller.signal;
  const steering = active ? steeringOperations.get(key) ?? new Set<ProjectOperation>() : undefined;
  if (steering) {
    steering.add(operation);
    steeringOperations.set(key, steering);
  } else {
    chatRuns.add(key);
    taskOperations.set(key, operation);
  }
  const directories = new Set<string>();
  let scratch: string | undefined;
  let saved = request.retryAt !== undefined;
  let streamed = false;
  let discussionStarted = false;
  let discussionFailure = t("draft_discussion.interrupted");
  try {
    let { model, effort } = request;
    const { text, files, retryAt } = request;
    signal.throwIfAborted();
    if (!automatic) {
      scratch = await mkdtemp(join(tmpdir(), "ai-taskboard-chat-"));
      directories.add(scratch);
    }
    let reply: CliReply<Task>;
    if (automatic) {
      const current = await callCli<Task>(project, ["show", id]);
      if (!current.ok) return { saved, result: current };
      const task = current.data;
      if (task.status !== "draft" || task.draftDiscussion?.phase !== automatic) {
        return { saved, result: cliFailure("CHAT_CHANGED", "The draft discussion changed.") };
      }
      if (automatic === "running") {
        const result = await callCli<Task>(project, ["draft-discussion", id], {
          revision: task.revision, phase: "failed", reason: discussionFailure,
        });
        return { saved, result };
      }
      reply = await callCli<Task>(project, ["draft-discussion", id], { revision: task.revision, phase: "running" });
      if (!reply.ok) return { saved, result: reply };
      discussionStarted = true;
      replyingTasks.add(key);
      notifyRunChange(project);
      const configured = task.execution ?? readBoardSettings(runtimeLocation(project)).executor;
      if (configured?.effort) ({ model, effort } = { model: configured.model, effort: configured.effort });
      else {
        const models = await chatModels(app.getPath("userData"), project);
        const chosen = configured ? models.find(entry => entry.id === configured.model) :
          models.find(entry => entry.default) ?? models[0];
        if (!chosen?.id || !chosen.effort) throw new Error(t("ui.the_task_model_is_unavailable_cc563f3b"));
        ({ id: model, effort } = chosen);
      }
      scratch = await mkdtemp(join(tmpdir(), "ai-taskboard-chat-"));
      directories.add(scratch);
    } else if (retryAt === undefined) {
      const sources = [];
      for (const [index, file] of files.entries()) {
        if (file.link) { sources.push({ path: file.link.path, name: file.name, link: file.link }); continue; }
        const path = join(scratch!, "upload-" + index);
        const suffix = imageExtensions.get(file.type);
        const name = file.name.trim();
        await writeFile(path, Buffer.from(file.bytes));
        sources.push({ path, name: suffix && !imageTypes.has(extname(name).toLowerCase()) ? name + suffix : name });
      }
      signal.throwIfAborted();
      reply = await callCli<Task>(project, ["chat", id], { text, model, effort, attachmentSources: sources });
      saved = reply.ok;
      if (saved) notify({ type: "saved" });
    } else {
      reply = await callCli<Task>(project, ["show", id]);
    }
    if (!reply.ok) return { saved, result: reply };
    signal.throwIfAborted();
    const task = reply.data;
    const last = task.history.findLastIndex(entry => entry.chat);
    const message = task.history[last];
    if (!automatic && (message?.actor !== "user" || retryAt !== undefined && last !== retryAt)) {
      return { saved, result: cliFailure("CHAT_CHANGED", t("ui.this_message_is_no_longer_awaiting_a_reply_6ec519ec")) };
    }
    if (!active) replyingTasks.add(key);
    notifyRunChange(project);
    const activeFiles = new Set(message?.chat?.files);
    const inspectDraft = task.status === "draft";
    const images: string[] = [];
    const attachments = [];
    for (const [index, file] of task.attachments.entries()) {
      let path = join(project, ".tasks", "attachments", id, file.file);
      const extension = extname(file.name).toLowerCase();
      const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
      if (file.link && !inspectDraft) {
        try { path = verifyFileLink(file.link); attachments.push({ id: file.file, name: file.name, bytes: file.bytes, path, link: file.link }); }
        catch (error) { attachments.push({ id: file.file, name: file.name, error: (error as Error).message }); }
        continue;
      }
      if (inspectDraft || activeFiles.has(file.file)) {
        path = join(scratch!, "attachment-" + index + safeExtension);
        const copy = await callCli(project, ["attachment", "read", id], {
          file: file.file, destination: path, ...(file.link ? { snapshot: true } : {}),
        });
        if (!copy.ok) {
          if (!inspectDraft) return { saved, result: copy };
          attachments.push({ id: file.file, name: file.name, error: copy.error.message });
          continue;
        }
        if (imageTypes.has(safeExtension)) images.push(path);
      }
      attachments.push({ id: file.file, name: file.name, path, bytes: file.bytes, ...(file.link ? { linked: true } : {}) });
    }
    const context = inspectDraft ? await Promise.all((task.dependencies ?? []).map(async dependency => {
      const result = await callCli<Task>(project, ["show", dependency, "--compact"]);
      return result.ok ? { id: dependency, title: result.data.title, status: result.data.status,
        description: result.data.description, criteria: result.data.criteria, summary: result.data.summary } :
        { id: dependency, error: result.error.message };
    })) : undefined;
    const prompt = JSON.stringify({
      task: { id, title: task.title, status: task.status, description: task.description,
        criteria: task.criteria, openQuestions: task.questions, tags: task.tags, priority: task.priority,
        subtasks: task.subtasks, dependencies: task.dependencies, milestone: task.milestone, dueDate: task.dueDate,
        schedule: task.schedule, workingDirectory: task.workingDirectory, execution: task.execution, expertTeam: task.expertTeam,
        summary: task.summary, nextStep: task.nextStep },
      dependencyContext: context,
      history: (automatic ? task.history : task.history.slice(0, last)).map(event => ({
        actor: event.actor, action: event.action, text: event.text, from: event.from, to: event.to, files: event.chat?.files,
      })),
      subsequentEvents: automatic ? undefined : task.history.slice(last + 1),
      attachments,
      latestUserMessage: automatic ? undefined : { text: message.text ?? "", files: message.chat?.files ?? [] },
    });
    signal.throwIfAborted();
    if (active) {
      // A finished turn must not silently turn a steering message into another run.
      if (activeAgents.get(key) !== active) throw new Error(t("ui.the_agent_finished_before_receiving_this_message_88246090"));
      // The request owns its staging files until it hands them to the active turn.
      active.directories.add(scratch!);
      directories.delete(scratch!);
      const undo = active.updateMessage?.(task, last);
      try { await active.control.steer(prompt, images); }
      catch (error) { undo?.(); throw error; }
      return { saved, result: { ok: true as const, data: task } };
    }
    const replyStarted = performance.now();
    let replyTo = last;
    let runAction = taskChatActions(project, task, message?.text ?? "", () => notify({ type: "changed" }));
    const ready = Promise.withResolvers<AgentControl>();
    void ready.promise.catch(() => {});
    activeAgents.set(key, { directories, chatWindow, draftDiscussion: automatic ? true : undefined, control: {
      steer: async (text, images) => (await ready.promise).steer(text, images),
      interrupt: async () => (await ready.promise).interrupt(),
    }, updateMessage: (latest, index) => {
      if (index < replyTo) return () => {};
      const previousIndex = replyTo, previousAction = runAction;
      replyTo = index;
      runAction = taskChatActions(project, latest, latest.history[index].text ?? "", () => notify({ type: "changed" }));
      return () => { if (replyTo === index) { replyTo = previousIndex; runAction = previousAction; } };
    } });
    const answer = await writer.run(() => replyToTask(app.getPath("userData"), project, { model, effort }, prompt, images,
      text => notify({ type: "commentary", text }),
      (name, args) => runAction(name, args),
      scratch!, maxAttachmentBytes - task.attachments.reduce((sum, file) => sum + (file.link ? 0 : file.bytes), 0),
      report => saveTaskTokenUsage(project, id, "discussion", report),
      control => ready.resolve(control), signal, id, items => {
        streamed = true;
        notify({ type: "run", items });
      }, automatic === undefined ? undefined : "initial")).finally(() => ready.reject(new Error("The agent session ended.")));
    if ("interrupted" in answer) return { saved, result: { ok: true as const, data: task } };
    signal.throwIfAborted();
    const result = await callCli<Task>(project, ["chat", id], {
      ...answer, actor: "agent", model, effort, replyTo, durationMs: Math.round(performance.now() - replyStarted),
      ...(automatic ? { draftDiscussion: true, revision: task.revision } : {}),
    });
    if (result.ok) discussionStarted = false;
    else discussionFailure = result.error.message;
    return { saved, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    discussionFailure = message;
    return { saved, result: cliFailure("CHAT_FAILED", message.slice(0, 1500)) };
  } finally {
    if (discussionStarted) {
      try {
        const current = await callCli<Task>(project, ["show", id, "--compact"]);
        if (current.ok && current.data.status === "draft" && current.data.draftDiscussion?.phase === "running") {
          await callCli(project, ["draft-discussion", id], {
            revision: current.data.revision, phase: "failed", reason: discussionFailure || t("draft_discussion.interrupted"),
          });
        }
      } catch (error) { console.warn("Could not save the draft discussion failure.", error); }
    }
    if (streamed) notify({ type: "run", items: [] });
    if (!active) {
      activeAgents.delete(key);
      const wasReplying = replyingTasks.delete(key);
      for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      chatRuns.delete(key);
      taskOperations.delete(key);
      writer();
      if (!automatic) scheduleAgentWork();
      if (wasReplying) notifyRunChange(project);
    } else {
      if (scratch && directories.has(scratch)) {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
      writer();
      steering?.delete(operation);
      if (!steering?.size) steeringOperations.delete(key);
    }
    operation.finish();
  }
}

ipcMain.handle("chat:send", async (event, id: unknown, request: unknown) => {
  const project = stateOf(event).board?.project;
  const input = request as Partial<ChatRequest> | undefined;
  if (!project || typeof id !== "string" || !/^T-\d{4,}$/.test(id) || !input ||
      typeof input.model !== "string" || !input.model.trim() || typeof input.effort !== "string" || !input.effort.trim() ||
      typeof input.text !== "string" || !Array.isArray(input.files) || !input.files.every(isPastedFile) ||
      (input.retryAt !== undefined && (!Number.isSafeInteger(input.retryAt) || input.retryAt < 0)) ||
      (input.retryAt === undefined && !input.text.trim() && !input.files.length)) {
    return { saved: false, result: cliFailure("INVALID_INPUT", t("ui.choose_a_task_a_model_and_a_message_847c6007")) };
  }
  if (input.files.reduce((total, file) => total + file.bytes.byteLength, 0) > maxAttachmentBytes) {
    return { saved: false, result: cliFailure("ATTACHMENT_LIMIT", t("ui.attachments_are_limited_to_64_mib_per_task_ae680c16")) };
  }
  return sendChat(project, id, input as ChatRequest, update => {
    if (update.type === "run") return publishRunActivity(project, id, update.items);
    if (!event.sender.isDestroyed()) event.sender.send("chat:update", { project, id, ...update });
  }, undefined, event.sender.id);
});

function runDraftDiscussion(project: string, id: string, phase: NonNullable<Task["draftDiscussion"]>["phase"]) {
  return sendChat(project, id, { model: "", effort: "", text: "", files: [] }, update => {
    if (update.type === "run") publishRunActivity(project, id, update.items);
  }, phase);
}

ipcMain.handle("chat:retry-draft-discussion", async (event, id: unknown) => {
  const project = stateOf(event).board?.project;
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  return (await runDraftDiscussion(project, id, "failed")).result;
});

type ManagerQuestion = { id: string; text: string; options: string[]; approval?: true };
type ManagerRun = {
  id: string;
  startedAt: number;
  phase: "starting" | "waiting" | "running";
  lane: "chat" | "work" | "maintenance";
  item?: Pick<RunActivity, "type" | "title" | "text" | "status">;
};
type ManagerRequest = {
  settingsChanged?: () => void;
  managerRun?: ManagerRun;
  stop?: () => Promise<void>;
  sendNow?: (text: string, files: PastedFile[], messageId?: string) => Promise<void>;
  goal?: (action: BoardGoalAction) => Promise<BoardGoal | null>;
  goalRunning?: boolean;
  changingGoal?: boolean;
  reviewing?: Set<string>;
  items?: BoardActivity[];
  publishRun?: () => void;
  wakeGoal?: () => void;
  automationEvent?: (event: { error: string }) => void;
  automationChanged?: (board: Board) => void;
  question?: { view: ManagerQuestion; settle: (answer: string | null) => void };
};
const boardRequests = new Map<string, ManagerRequest>();
const boardWorkRequests = new Map<string, ManagerRequest>();
const backgroundManagerRequests = new Map<string, ManagerRequest>();
enableSharedRuns();
const agentSlots = createAgentSlots(true);
type ExecutorContinuation = { afterDisconnect?: boolean; withoutProgress?: boolean };
const deferredExecutors = new Map<string, { project: string; id: string; revision: number; continuation?: ExecutorContinuation }>();
const autoBoards = new WeakMap<BoardWatch, {
  running: boolean; milestonesAt: number; dates: Map<number, string | null>; milestonesError?: string;
  launches: Set<string>; integrations: Set<string>; notices: Set<string>;
}>();
let schedulingAgentWork = false;

function scheduleAutoBoard(watch: BoardWatch) {
  const { project } = watch.board;
  if (isManual(watch.board.settings) || (!watch.board.settings.autoMode && !watch.board.tasks.some(task => task.status === "ready" && task.launchRequested)) || subscriptions.get(project) !== watch || closingProjects.has(project)) return;
  let state = autoBoards.get(watch);
  if (!state) {
    state = { running: false, milestonesAt: 0, dates: new Map(), launches: new Set(), integrations: new Set(), notices: new Set() };
    autoBoards.set(watch, state);
  }
  if (state.running) return;
  state.running = true;
  const queue = state;
  const failed = (error: string) => {
    broadcastBoardChat(project, "orchestrator-review-error", { error });
    boardWorkRequests.get(projectIdentity(project))?.automationEvent?.({ error });
    boardRequests.get(projectIdentity(project))?.automationEvent?.({ error });
  };
  void (async () => {
    // Read again before every decision; watch snapshots can lag a CLI write.
    for (;;) {
      if (closingProjects.has(project) || subscriptions.get(project) !== watch) return;
      const current = await callCli<Board>(project, ["list", "--compact"]);
      if (!current.ok) { failed(current.error.message); return; }
      const board = current.data;
      if (isManual(board.settings)) return;
      const controls = board.settings.autoMode ? board.settings.autoQueue : undefined;
      const reviewMode = boardReviewMode(board.settings);
      const planned = (task: Board["tasks"][number]) => !board.settings.requireExpertPlans || task.mergeRepair ||
        (task.expertWorkPlanned && (task.schedule || reviewMode === "human" || task.expertReviewPlanned));
      const queued = board.settings.autoMode ? board.tasks : board.tasks.filter(task => task.launchRequested);
      if (!board.settings.autoMode && !queued.some(task => task.status === "ready")) return;
      const eligibleTasks = queued.filter(planned);
      const key = projectIdentity(project);
      if (board.settings.autoMode && boardReviewMode(board.settings) === "reviewer") {
        const task = board.tasks.find(task => task.status === "review" && !task.acceptanceRepair && task.reviewApproved && !executorBusy(project, task.id) &&
          !watch.reviewerRuns.has(task.id) && !queue.integrations.has(task.id + ":" + task.revision));
        if (task) {
          const attempt = task.id + ":" + task.revision;
          queue.integrations.add(attempt);
          const review = await callCli<{ revision: number; targetHead: string | null; message?: string; stale: boolean;
            reviewerApproval?: { targetHead: string | null } }>(project, ["review", task.id, "--compact"]);
          if (!review.ok) { failed(review.error.message); continue; }
          if (review.data.stale) { failed(task.id + ": submission changed"); continue; }
          if (review.data.reviewerApproval?.targetHead !== review.data.targetHead) {
            const release = reserveAgent(project, "reviewer", "review:" + task.id);
            if (!release) { queue.integrations.delete(attempt); return; }
            watch.reviewerRuns.set(task.id, release.run(() => reviewSubmission(watch, task.id, 4)).finally(async () => {
              try {
                const checked = await callCli<{ targetHead: string | null; reviewerApproval?: { targetHead: string | null } }>(project, ["review", task.id, "--compact"]);
                if (checked.ok && checked.data.reviewerApproval?.targetHead === checked.data.targetHead) queue.integrations.delete(attempt);
              } finally {
                watch.reviewerRuns.delete(task.id); release(); publishReviewActivity(project);
              }
            }));
            continue;
          }
          const accepted = await callCli(project, ["accept", task.id, "--compact"], {
            autoMode: true, actor: "manager", reviewMode: "reviewer", revision: review.data.revision,
            targetHead: review.data.targetHead, ...(review.data.message ? { message: review.data.message } : {}),
          });
          if (!accepted.ok) {
            if (["BOARD_BUSY", "TARGET_CHANGED", "AUTO_MODE_DISABLED", "AUTO_REVIEW_DISABLED", "REVIEW_MODE_CHANGED"].includes(accepted.error.code)) queue.integrations.delete(attempt);
            else failed(task.id + ": " + accepted.error.message);
            if (["BOARD_BUSY", "AUTO_MODE_DISABLED", "AUTO_REVIEW_DISABLED", "REVIEW_MODE_CHANGED"].includes(accepted.error.code)) return;
          }
          continue;
        }
      }
      // Address exceptions only. Routine dispatch and successful integration never need a manager turn.
      const notices = (board.managerInbox ?? []).filter(message => ["question", "decision", "block"].includes(message.kind) &&
        !queue.notices.has(message.id + ":" + message.sequence));
      const tab = [...watch.tabs].find(tab => !tab.window.isDestroyed());
      const needsPlan = controls?.paused ? [] : queued.filter(task =>
        ((task.status === "ready" && !controls?.held.includes(task.id) && !planned(task) && !task.unfinishedDependencies?.length) ||
         (task.status === "review" && board.settings.requireExpertPlans && reviewMode !== "human" && !task.expertReviewPlanned && !task.acceptanceRepair)) &&
        !queue.notices.has("expert-plan:" + task.id + ":" + task.revision)).slice(0, 4);
      const addressed = board.settings.autoMode ? notices : [];
      if ((addressed.length || needsPlan.length) && tab && !boardWorkRequests.has(key) &&
          !backgroundManagerRequests.has(key) && agentSlots.available(key, "manager", board.settings.taskLimits)) {
        const noticeKeys = [...addressed.map(notice => notice.id + ":" + notice.sequence),
          ...needsPlan.map(task => "expert-plan:" + task.id + ":" + task.revision)];
        for (const notice of noticeKeys) queue.notices.add(notice);
        const prompt = "AI Taskboard queue: handle these addressed notices without a goal. " + JSON.stringify(addressed) +
          (needsPlan.length ? "\nThese existing cards need specialist plans. Read each card and use expert_plan to save the missing work or review phase. Do not approve, start or accept a card in this planning request. " +
            JSON.stringify(needsPlan.map(({ id, status, revision }) => ({ id, status, revision }))) : "");
        void runBoardRequest(tab.window.webContents, board, prompt, [], false, false, undefined, undefined, undefined, true)
          .then(result => {
            if (!result.ok && result.error.code === "BOARD_REQUEST_IN_PROGRESS") {
              for (const notice of noticeKeys) queue.notices.delete(notice);
            } else if (!result.ok) failed(result.error.message);
            else if (result.data?.error) failed(result.data.error);
          })
          .catch(error => failed((error as Error).message));
      }
      if (controls?.paused) return;
      const available = {
        executor: agentSlots.available(key, "executor", board.settings.taskLimits),
        reviewer: agentSlots.available(key, "reviewer", board.settings.taskLimits),
      };
      if (!eligibleTasks.some(task => task.status === "ready" && available[task.mergeRepair ? "reviewer" : "executor"])) return;
      if (eligibleTasks.some(task => task.status === "ready" && task.milestone) && Date.now() - queue.milestonesAt >= 60_000) {
        queue.milestonesAt = Date.now();
        const milestones = await callCli<{ repository: string; milestones: { number: number; due_on: string | null }[] }>(project, ["milestones"]);
        if (!milestones.ok) { queue.milestonesError = milestones.error.message; failed(milestones.error.message); return; }
        queue.milestonesError = undefined;
        queue.dates = new Map(milestones.data.milestones.map(entry => [entry.number, entry.due_on]));
        continue; // A deadline, setting or card may have changed during the network request.
      }
      if (queue.milestonesError && eligibleTasks.some(task => task.status === "ready" && task.milestone)) return;
      const task = nextReadyTask(eligibleTasks, queue.dates, id => {
        const candidate = board.tasks.find(task => task.id === id)!;
        return !available[candidate.mergeRepair ? "reviewer" : "executor"] || executorBusy(project, id) ||
          queue.launches.has(id + ":" + candidate.revision);
      }, Date.now(), controls);
      if (!task) return;
      const attempt = task.id + ":" + task.revision;
      queue.launches.add(attempt);
      const result = await launchTask(project, task.id, undefined, false, task.revision, undefined, Boolean(task.schedule), false, false,
        Boolean(board.settings.autoMode), false, controls?.revision ?? 0);
      if (!result.ok) {
        if (["BOARD_BUSY", "REVISION_CONFLICT", "INVALID_TRANSITION", "LAUNCH_IN_PROGRESS", "CHAT_BUSY", "EXECUTOR_LIMIT", "REVIEWER_LIMIT",
            "PROJECT_CLOSING", "DEPENDENCIES_INCOMPLETE", "AUTO_MODE_DISABLED", "AUTO_QUEUE_PAUSED", "AUTO_QUEUE_CHANGED"].includes(result.error.code)) {
          queue.launches.delete(attempt);
          return; // Retry on the next event/tick, never spin on the same snapshot.
        }
        if (task.launchRequested) { queue.launches.delete(attempt); failed(task.id + ": " + result.error.message); return; }
        await callCli(project, ["block", task.id, "--compact"], { revision: task.revision, allowUnstarted: true,
          reason: result.error.message, condition: t("ui.fix_the_launch_error_and_unblock_the_task_9eea19ab") });
      }
    }
  })().catch(error => failed((error as Error).message)).finally(() => { queue.running = false; });
}

function scheduleAgentWork() {
  if (schedulingAgentWork) return;
  schedulingAgentWork = true;
  setImmediate(() => {
    schedulingAgentWork = false;
    try {
      for (const watch of subscriptions.values()) {
        for (const entry of agentSlots.entries(watch.board.project)) {
          if (entry.kind === "queue" && entry.task && entry.revision !== undefined)
            deferredExecutors.set(watch.board.project + "\0" + entry.task, {
              project: watch.board.project, id: entry.task, revision: entry.revision, continuation: entry.continuation });
        }
      }
      for (const [key, pending] of deferredExecutors) {
        const { project, id, revision, continuation } = pending;
        const watch = subscriptions.get(project);
        const task = watch?.board.tasks.find(task => task.id === id);
        // request-changes can finish before the watch receives its new revision.
        if (watch && task && task.revision < revision) continue;
        if (!watch || closingProjects.has(project)) {
          deferredExecutors.delete(key);
          continue;
        }
        if (!task || task.status !== "in_progress" || task.revision !== revision) {
          deferredExecutors.delete(key);
          agentSlots.defer(project, id);
          notifyRunChange(project);
          continue;
        }
        const role = task.mergeRepair ? "reviewer" : "executor";
        if (!agentSlots.available(projectIdentity(project), role, watch.board.settings?.taskLimits) || executorBusy(project, id)) continue;
        deferredExecutors.delete(key);
        notifyRunChange(project);
        const failed = (error: string) => broadcastBoardChat(project, "orchestrator-review-error", { error: id + " · " + error });
        void launchTask(project, id, undefined, false, revision, continuation).then(result => {
          if (!result.ok && ["EXECUTOR_LIMIT", "REVIEWER_LIMIT"].includes(result.error.code)) {
            deferredExecutors.set(key, pending);
            agentSlots.defer(project, id, pending);
            notifyRunChange(project);
            return;
          }
          if (!result.ok && !["REVISION_CONFLICT", "INVALID_TRANSITION"].includes(result.error.code)) failed(result.error.message);
        }).catch(error => failed((error as Error).message));
      }
      for (const watch of subscriptions.values()) {
        scheduleAutoReview(watch);
        scheduleAutoBoard(watch);
        scheduleDraftDiscussions(watch);
      }
    } catch (error) { console.error(error); }
  });
}

function scheduleDraftDiscussions({ board }: BoardWatch) {
  const { project, tasks } = board;
  if (isManual(board.settings) || closingProjects.has(project)) return;
  const writers = new Set(agentSlots.entries(project).filter(entry => entry.kind !== "queue").map(entry => entry.task));
  for (const task of tasks) {
    const phase = task.draftDiscussion?.phase;
    if (task.status !== "draft" || (phase !== "queued" && phase !== "running") || writers.has(task.id)) continue;
    void runDraftDiscussion(project, task.id, phase).catch(error => console.warn("Could not run draft discussion", error));
  }
}

function reserveAgent(project: string, role: AgentRole, task?: string) {
  agentSlots.remember(project);
  // A tool call can race the watch snapshot after CLI settings were saved.
  const overrides = readBoardSettings(runtimeLocation(project)).taskLimits;
  const release = agentSlots.acquire(projectIdentity(project), role, overrides, task);
  if (!release) return;
  return Object.assign(() => {
    release();
    scheduleAgentWork();
    void callCli(project, ["maintain"]).catch(error => console.warn("Private lifecycle maintenance deferred", error));
  }, { run: release.run });
}

function taskRunLimit(role: "executor" | "reviewer") {
  if (role === "reviewer") return cliFailure("REVIEWER_LIMIT", t("ui.all_reviewer_slots_on_this_board_are_occupied_re_74def719"));
  return cliFailure("EXECUTOR_LIMIT", t("ui.all_executor_slots_on_this_board_are_occupied_re_59a47721"));
}

const acceptanceWork = new Set<string>();
async function continueAcceptance(project: string, task: Task) {
  const key = project + "\0" + task.id;
  if (returningDrafts.has(key) || acceptanceWork.has(key) || executorBusy(project, task.id)) return;
  acceptanceWork.add(key);
  try {
    let result: CliReply<unknown>;
    if (task.acceptanceRepair?.phase === "queued") {
      const watch = subscriptions.get(project);
      const tab = watch && [...watch.tabs].find(tab => !tab.window.isDestroyed());
      if (!watch || !tab) return;
      result = await runBoardRequest(tab.window.webContents, watch.board,
        "Resolve the pending acceptance conflict yourself as board manager. " + JSON.stringify({ id: task.id,
          worktree: task.git?.worktree, acceptanceRepair: task.acceptanceRepair }) +
        " Read the current card with show --compact; use the AI Taskboard CLI with --project " + project +
        " for preview, submit or block. Do not launch another agent.", [], false, false, undefined, undefined, undefined, false, task);
      if (result.ok && !returningDrafts.has(key)) {
        const current = await callCli<Task>(project, ["show", task.id]);
        if (current.ok && current.data.acceptanceRepair?.phase === "running") {
          const response = result.data as { error?: string; answer?: string } | undefined;
          await callCli(project, ["accept", task.id], { revision: current.data.revision,
            repairFailure: response?.error || response?.answer || "The manager ended repair without submitting checked results." });
        }
      }
    } else if (task.acceptanceRepair?.phase === "checking") {
      const review = await callCli<{ targetHead: string; revision: number }>(project, ["review", task.id, "--compact"]);
      if (!review.ok) result = review;
      else result = await callCli(project, ["accept", task.id, "--compact"], {
        actor: "user", continueRepair: true, revision: review.data.revision, targetHead: review.data.targetHead,
      });
    } else if (task.acceptanceRepair?.phase === "running") {
      result = await callCli(project, ["accept", task.id], { revision: task.revision,
        repairFailure: "The repair process ended before submitting checked results. Inspect its saved activity and worktree before retrying." });
    } else return;
    if (!returningDrafts.has(key) && !result.ok && !["BOARD_BUSY", "TARGET_CHANGED", "REVISION_CONFLICT", "CHAT_BUSY", "LAUNCH_IN_PROGRESS", "REVIEWER_LIMIT", "BOARD_REQUEST_IN_PROGRESS"].includes(result.error.code)) {
      const current = await callCli<Task>(project, ["show", task.id]);
      if (current.ok && current.data.acceptanceRepair) await callCli(project, ["accept", task.id], {
        revision: current.data.revision, repairFailure: result.error.message });
      broadcastBoardChat(project, "orchestrator-review-error", { error: task.id + ": " + result.error.message });
    }
  } finally { acceptanceWork.delete(key); }
}

const maintenanceWork = new Set<string>();
async function scheduleMaintenance(project: string, watch: BoardWatch) {
  if (maintenanceWork.has(project)) return;
  maintenanceWork.add(project);
  try {
    const jobs = await callCli<MaintenanceJob[]>(project, ["maintenance"]);
    const tab = [...watch.tabs].find(tab => !tab.window.isDestroyed());
    if (!jobs.ok || !tab) return;
    for (const job of jobs.data) {
      const result = await runBoardRequest(tab.window.webContents, watch.board,
        "Repair the assigned private lifecycle maintenance fault. Use --project " + project + " for the task CLI.",
        [], false, false, undefined, undefined, undefined, false, undefined, job);
      if (!result.ok) break; // Persisted queue remains pending when the shared pool/context is occupied.
    }
  } finally { maintenanceWork.delete(project); }
}

function scheduleRecurringTasks(now = Date.now()) {
  for (const [project, watch] of subscriptions) {
    if (!watch.tabs.size || closingProjects.has(project)) continue;
    if (isManual(watch.board.settings)) continue;
    void scheduleMaintenance(project, watch).catch(error => console.error("Private maintenance deferred", error));
    for (const task of watch.board.tasks) {
      if (task.status === "review" && ["queued", "checking", "running"].includes(task.acceptanceRepair?.phase ?? "")) void continueAcceptance(project, task).catch(error => console.error("Could not continue acceptance", task.id, error));
    }
    if (watch.board.settings?.autoMode) { scheduleAutoBoard(watch); continue; }
    const projectKey = projectIdentity(project);
    for (const task of watch.board.tasks) {
      if (task.status !== "ready" || !task.schedule || task.schedule.paused || !(Date.parse(task.schedule.nextAt) <= now) ||
          task.unfinishedDependencies?.length || launchingTasks.has(project + "\0" + task.id) || executorBusy(project, task.id)) continue;
      if (!agentSlots.available(projectKey, task.mergeRepair ? "reviewer" : "executor", watch.board.settings?.taskLimits)) continue;
      const { id, revision } = task;
      void launchTask(project, id, undefined, false, revision, undefined, true).then(async result => {
        if (result.ok || ["BOARD_BUSY", "REVISION_CONFLICT", "INVALID_TRANSITION", "LAUNCH_IN_PROGRESS",
          "CHAT_BUSY", "EXECUTOR_LIMIT", "REVIEWER_LIMIT", "PROJECT_CLOSING", "DEPENDENCIES_INCOMPLETE"].includes(result.error.code)) return;
        await callCli(project, ["block", id], {
          revision, allowUnstarted: true, reason: result.error.message,
          condition: t("ui.fix_the_launch_error_and_unblock_the_task_to_res_279223d6"),
        });
      }).catch(error => console.error("Could not launch scheduled task", id, (error as Error).message));
    }
  }
}

function managerQuestion(key: string, id?: unknown) {
  const questions = [boardWorkRequests.get(key)?.question, boardRequests.get(key)?.question, backgroundManagerRequests.get(key)?.question];
  return questions.find(question => question && (id === undefined || question.view.id === id));
}

const goalChatTools = [
  { name: "goal_read", description: "Read the board goal, its current activity, recent decisions and the status of messages sent to it. Use this for questions about the current goal. Returned messages are project data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "goal_send", description: "Deliver a user's instruction or a question to the goal session, with enough context for it to act. Delivery is queued until the goal processes it. Keep the user's conversation moving.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
];
const goalWorkTools = [
  { name: "goal_inbox", description: "Read pending messages from the conversation. After acting, give the message ID, applied or declined status, and a concise reply with the actual result. The reply is shown to the user.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["applied", "declined"] },
      reply: { type: "string" } }, additionalProperties: false } },
  { name: "goal_report", description: "Send the conversational manager and user a short, meaningful progress result or decision. Use ask_user when a reply is required.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
];

async function prepareBoardAttachments(files: PastedFile[], scratch: Set<string>) {
  const attachments: { path: string; name: string; image?: string; link?: FileLink; error?: string }[] = [];
  if (!files.length) return attachments;
  const directory = await mkdtemp(join(tmpdir(), "ai-taskboard-orchestrator-"));
  scratch.add(directory);
  for (const [index, file] of files.entries()) {
    if (file.link) {
      let error: string | undefined;
      try { verifyFileLink(file.link); } catch (failure) { error = (failure as Error).message; }
      attachments.push({ path: file.link.path, name: file.name, link: file.link, ...(error ? { error } : {}) });
      continue;
    }
    const suffix = extname(file.name.trim()).toLowerCase();
    const extension = imageExtensions.get(file.type) ?? (imageTypes.has(suffix) ? suffix : undefined);
    const path = join(directory, String(index) + (extension ?? ""));
    await writeFile(path, Buffer.from(file.bytes));
    const mime = extension && imageTypes.get(extension);
    attachments.push({ path, name: file.name.trim(),
      image: mime ? "data:" + mime + ";base64," + Buffer.from(file.bytes).toString("base64") : undefined });
  }
  return attachments;
}

function broadcastBoardChat(project: string, type: string, details: { id?: string; goal?: BoardGoal | null; goalRunning?: boolean; error?: string;
  question?: ManagerQuestion | null; managerRun?: ManagerRun | null;
  managerWork?: ManagerRun | null; items?: RunActivity[] } = {}, except?: Electron.WebContents) {
  for (const { window, tabs } of windowStates.values()) {
    if (!window.isDestroyed() && window.webContents !== except && tabs.some(tab => tab.project === project)) {
      window.webContents.send("chat:update", { project, type, ...details });
    }
  }
}

function boardThreadPath(project: string) {
  const dialog = join(project, ".tasks", "manager-dialog.json");
  const legacy = join(project, ".tasks", "orchestrator.json");
  return existsSync(legacy) ? legacy : dialog;
}

type QueuedBoardMessage = {
  id: string; draft: string; goal: boolean; created: number; failed?: boolean;
  files: { name: string; type: string; bytes: string; link?: FileLink }[];
};

function readQueuedMessage(path: string) {
  try { return readJson(path) as QueuedBoardMessage; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function queuedFiles(job: QueuedBoardMessage): PastedFile[] {
  return job.files.map(file => ({ ...file, bytes: Uint8Array.from(Buffer.from(file.bytes, "base64")).buffer }));
}

ipcMain.handle("board:queue", async (event, project: string, action: unknown, id?: unknown, draft?: unknown,
  goal?: unknown, files?: unknown) => {
  const state = stateOf(event);
  const board = state.project === project ? state.board :
    windowStates.get(state.window.webContents.id)?.tabs.find(tab => tab.board?.project === project)?.board;
  if (!board) return cliFailure("BOARD_NOT_FOUND", t("errors.7b7b2fc6a65615f0"));
  const directory = join(board.project, ".tasks", "manager-queue");
  try {
    if (existsSync(directory)) storageDirectory(directory);
    if (action === "list") {
      if (!existsSync(directory)) return { ok: true, data: [] };
      const jobs = readdirSync(directory).filter(name => name.endsWith(".json")).flatMap(name => {
        const job = readQueuedMessage(join(directory, name));
        return job ? [{ ...job, files: queuedFiles(job) }] : [];
      });
      return { ok: true, data: jobs.sort((left, right) => left.created - right.created || left.id.localeCompare(right.id)) };
    }
    if (action === "add" && id === undefined) id = randomUUID();
    if (typeof id !== "string" || !codexThreadPattern.test(id)) return cliFailure("INVALID_INPUT", t("errors.9784747447fcf118"));
    const path = join(directory, id + ".json");
    if (action === "remove" || action === "retry" || (action === "edit" && typeof draft === "string")) {
      const error = runtimeTransaction(board.project, () => {
        if (action === "remove") { rmSync(path, { force: true }); return; }
        const job = readQueuedMessage(path);
        if (!job) return;
        if (action === "retry") { writeJson(path, { ...job, failed: undefined }); return; }
        if (!(draft as string).trim() && (job.goal || !job.files.length)) return cliFailure("INVALID_INPUT", t("errors.e10b22707db91d58"));
        writeJson(path, { ...job, draft });
      });
      if (error) return error;
    } else if (action === "add" && typeof draft === "string" && typeof goal === "boolean" &&
        Array.isArray(files) && files.every(isPastedFile) && (draft.trim() || (!goal && files.length)) &&
        files.reduce((total, file) => total + file.bytes.byteLength, 0) <= maxAttachmentBytes) {
      storageDirectory(directory, true);
      writeJson(path, { id, draft, goal, created: Date.now(),
        files: files.map(file => ({ name: file.name, type: file.type, ...(file.link ? { link: file.link } : {}), bytes: Buffer.from(file.bytes).toString("base64") })) });
    } else return cliFailure("INVALID_INPUT", t("errors.ef091a00af0e1a46"));
    broadcastBoardChat(project, "orchestrator-queue", {}, event.sender);
    return { ok: true, data: action === "add" ? id : null };
  } catch (error) {
    return cliFailure("BOARD_QUEUE_FAILED", (error as Error).message);
  }
});

function readBoardThread(path: string) {
  if (!existsSync(path)) return;
  const stored = readJson(path) as { provider?: unknown; id?: unknown; history?: "local"; goal?: BoardGoal | null; goalId?: string } | null;
  if (stored?.provider !== "codex" || typeof stored.id !== "string" || !codexThreadPattern.test(stored.id)) {
    throw new Error(t("ui.invalid_saved_orchestrator_chat_ea530ebe"));
  }
  return { provider: stored.provider, id: stored.id, history: stored.history, goal: stored.goal, goalId: stored.goalId };
}

function saveBoardGoal(path: string, goal: BoardGoal | null) {
  try {
    const thread = readBoardThread(path);
    const snapshot = goal && { objective: goal.objective, status: goal.status };
    if (thread && JSON.stringify(thread.goal) !== JSON.stringify(snapshot)) {
      writeJson(path, { ...thread, goal: snapshot });
    }
  } catch (error) {
    console.warn("Could not save the manager goal locally.", (error as Error).message);
  }
}

ipcMain.handle("board:history", async (event, project?: string, cursor: unknown = null, view: unknown = "chat") => {
  const state = stateOf(event);
  const board = project === undefined || state.board?.project === project ? state.board :
    windowStates.get(state.window.webContents.id)?.tabs.find(tab => tab.board?.project === project)?.board;
  if (!board) return cliFailure("BOARD_NOT_FOUND", t("errors.7b7b2fc6a65615f0"));
  if ((cursor !== null && typeof cursor !== "string") || (view !== "chat" && view !== "work" && view !== "live")) {
    return cliFailure("INVALID_INPUT", t("errors.3dd06744fca3e722"));
  }
  project = board.project;
  try {
    const key = projectIdentity(project);
    const entries = agentSlots.entries(project);
    const shared = entries.find(entry => entry.task === "manager:context")?.state;
    const background = entries.find(entry => entry.task === "manager:background")?.state;
    const live = shared?.live?.items ?? [];
    if (view === "live") return { ok: true, data: {
      dialogue: managerChatItems(boardRequests.get(key)?.items ?? (shared?.lane === "chat" ? live : [])).slice(-45),
      work: managerWorkItems(boardWorkRequests.get(key)?.items ?? (shared?.lane === "work" ? live :
        backgroundManagerRequests.get(key)?.items ?? background?.live?.items ?? []), "work").slice(-80),
      chat: managerWorkItems(boardRequests.get(key)?.items ?? (shared?.lane === "chat" ? live : [])).slice(-45),
      reviewers: Object.fromEntries([...(subscriptions.get(project)?.reviewerRuns.keys() ?? [])].map(id =>
        [id, reviewerActivity(board.project, id)])),
    } };
    const saved = readBoardThread(boardThreadPath(project));
    const data = await readManagerView(project, cursor, view, saved && saved.history !== "local" ?
      next => readBoardHistory(app.getPath("userData"), project, saved.id, next) : undefined);
    const goalRunning = Boolean(boardWorkRequests.get(key)?.goalRunning ?? shared?.goalRunning);
    return { ok: true, data: { turns: [], nextCursor: null, ...data,
      goal: saved?.goal !== undefined ? saved.goal : (data && "goal" in data ? data.goal : undefined),
      model: data?.model ?? board.settings.manager?.model, goalRunning } };
  } catch (error) {
    return cliFailure("BOARD_HISTORY_FAILED", (error as Error).message);
  }
});

ipcMain.handle("board:readManagerMessages", (event, project: unknown, ids: unknown) => {
  const { board, project: selected } = stateOf(event);
  if (!board || project !== selected) return cliFailure("BOARD_NOT_FOUND", t("errors.d8626c12a856ce5b"));
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 512)) {
    return cliFailure("INVALID_INPUT", t("errors.234ebe383363e12e"));
  }
  try {
    if (readManagerMessages(board.project, ids)) publishManagerUnread(board.project);
    return { ok: true, data: managerUnread(board.project) };
  } catch (error) {
    return cliFailure("BOARD_HISTORY_FAILED", (error as Error).message);
  }
});

ipcMain.handle("board:taskRunHistory", async (event, id: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  const task = await callCli<Task>(project, ["show", id]);
  if (!task.ok) return task;
  const { codexThreadId, history } = task.data;
  if (!codexThreadId || !codexThreadPattern.test(codexThreadId)) return { ok: true, data: {} };
  try {
    return { ok: true, data: await readTaskRunHistory(app.getPath("userData"), project, codexThreadId, history) };
  } catch (error) {
    return cliFailure("TASK_HISTORY_FAILED", (error as Error).message);
  }
});

ipcMain.handle("board:reviewerChat", (event, id: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  try {
    return { ok: true, data: readReviewerChat(project, id) };
  } catch (error) {
    return cliFailure("REVIEWER_CHAT_FAILED", (error as Error).message);
  }
});

ipcMain.handle("board:stopOrchestrator", async event => {
  const project = stateOf(event).board?.project;
  const request = project && boardRequests.get(projectIdentity(project));
  const stop = request && !request.changingGoal && request.stop;
  if (!stop) return cliFailure("CHAT_NOT_RUNNING", t("ui.the_agent_is_no_longer_running_72c32478"));
  request.changingGoal = true;
  try {
    request.question?.settle(null);
    await stop();
    return { ok: true, data: null };
  } catch (error) {
    return cliFailure("CHAT_STOP_FAILED", (error as Error).message);
  } finally {
    request.changingGoal = false;
  }
});

ipcMain.handle("board:answerQuestion", (event, id: unknown, answer: unknown) => {
  const project = stateOf(event).board?.project;
  const pending = project && typeof id === "string" ? managerQuestion(projectIdentity(project), id) : undefined;
  if (!pending || id !== pending.view.id) return cliFailure("QUESTION_CLOSED",
    t("ui.this_question_is_closed_82e54086"));
  if (pending.view.approval && answer !== null && !pending.view.options.some(option => option === answer)) {
    return cliFailure("INVALID_INPUT", t("ui.choose_an_approval_decision_b7e4dc8b"));
  }
  if (answer !== null && (typeof answer !== "string" || !answer.trim() || answer.length > 4000)) {
    return cliFailure("INVALID_INPUT", t("ui.enter_an_answer_up_to_4_000_characters_bd9ab88b"));
  }
  pending.settle(typeof answer === "string" ? answer.trim() : null);
  return { ok: true, data: null } as const;
});

ipcMain.handle("board:goal", async (event, kind: unknown, objective: unknown) => {
  const project = stateOf(event).board?.project;
  if (!project || (kind !== "pause" && kind !== "clear" && (kind !== "edit" || typeof objective !== "string" || !objective.trim()))) {
    return cliFailure("INVALID_INPUT", t("ui.choose_an_action_for_the_project_goal_43bfd434"));
  }
  const action: BoardGoalAction = kind === "edit" ? { kind, objective: (objective as string).trim() } : { kind };
  const key = projectIdentity(project);
  const running = boardWorkRequests.get(key);
  if (running && (!running.goal || running.changingGoal)) {
    return cliFailure("BOARD_REQUEST_IN_PROGRESS", t("ui.the_project_manager_is_connecting_or_changing_th_eb7d3eec"));
  }
  const operation = running ?? {};
  const writer = running ? undefined : agentSlots.claim(project, "manager:context");
  if (!running && !writer) return cliFailure("BOARD_REQUEST_IN_PROGRESS", t("ui.the_agent_is_already_handling_a_request_72b4da49"));
  operation.changingGoal = true;
  if (!running) boardWorkRequests.set(key, operation);
  try {
    const binding = boardThreadPath(project);
    const id = readBoardThread(binding)?.id;
    if (!id) return cliFailure("INVALID_INPUT", t("ui.there_is_no_saved_goal_67c98597"));
    if (kind === "pause" || kind === "clear") running?.question?.settle(null);
    const goal = running?.goal ? await running.goal(action) : await updateBoardGoal(app.getPath("userData"), project, id, action);
    if (!running) {
      saveBoardGoal(binding, goal);
      broadcastBoardChat(project, "orchestrator-goal", { goal, goalRunning: false });
    }
    return { ok: true, data: goal };
  } catch (error) {
    return cliFailure("BOARD_GOAL_FAILED", (error as Error).message);
  } finally {
    operation.changingGoal = false;
    if (!running) boardWorkRequests.delete(key);
    writer?.();
  }
});

ipcMain.handle("board:request", async (event, request: unknown, files: unknown = [], project?: string, goal: unknown = false,
  immediate: unknown = false, messageId?: unknown, goalRunId?: unknown) => {
  const state = stateOf(event);
  const board = project === undefined || state.board?.project === project ? state.board :
    windowStates.get(state.window.webContents.id)?.tabs.find(tab => tab.board?.project === project)?.board;
  if (goalRunId !== undefined) {
    const work = board && boardWorkRequests.get(projectIdentity(board.project));
    if (immediate !== true || typeof goalRunId !== "string" || !work?.goalRunning || work.managerRun?.id !== goalRunId) {
      return cliFailure("CHAT_NOT_RUNNING", t("ui.the_manager_has_no_active_reply_the_message_is_s_1148c98d"));
    }
  }
  return runBoardRequest(event.sender, board, request, files, goal, immediate, messageId,
    undefined, undefined, false, undefined, undefined, typeof goalRunId === "string" ? goalRunId : undefined);
});

async function runBoardRequest(sender: Electron.WebContents, board: Board | undefined, request: unknown, files: unknown = [],
  goal: unknown = false, immediate: unknown = false, messageId?: unknown, reviewIds?: string[], expectedReviewMode?: ReviewMode, autoNotice = false, repairTask?: Task, cleanupJob?: MaintenanceJob, goalRunId?: string) {
  if (!board || typeof request !== "string" || typeof immediate !== "boolean" || (immediate && goal !== false) || !Array.isArray(files) ||
      (messageId !== undefined && (typeof messageId !== "string" || !codexThreadPattern.test(messageId))) ||
      !files.every(isPastedFile) || (goal === "resume" ? Boolean(request.trim() || files.length) :
        typeof goal !== "boolean" || (!request.trim() && (goal || !files.length)))) {
    return cliFailure("INVALID_INPUT", t("ui.enter_a_request_on_an_open_board_3f8d0084"));
  }
  const queuedPath = typeof messageId === "string" ? join(board.project, ".tasks", "manager-queue", messageId + ".json") : undefined;
  const delivered = () => {
    if (!queuedPath) return;
    try {
      storageDirectory(dirname(queuedPath));
      runtimeTransaction(board.project, () => rmSync(queuedPath, { force: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not remove a delivered manager message.", error);
    }
  };
  const broadcastMaintenanceSafe: typeof broadcastBoardChat = (...args) => { if (!cleanupJob) broadcastBoardChat(...args); };
  const projectKey = projectIdentity(board.project);
  const background = Boolean(reviewIds || autoNotice || repairTask || cleanupJob);
  const lane = goal || background ? "work" : "chat";
  const requests = background ? backgroundManagerRequests : goal ? boardWorkRequests : boardRequests;
  const context = background ? "manager:background" : "manager:context";
  if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > maxAttachmentBytes) {
    return cliFailure("ATTACHMENT_LIMIT", t("ui.attachments_are_limited_to_64_mib_per_task_ae680c16"));
  }
  if (queuedPath && !existsSync(queuedPath)) {
    return immediate ? { ok: true as const, data: null } :
      { ok: true as const, data: { answer: "", changes: [] } };
  }
  if (immediate) {
    const current = (goalRunId ? boardWorkRequests : boardRequests).get(projectKey);
    if (!current?.sendNow || current.changingGoal) {
      return cliFailure("CHAT_NOT_RUNNING", t("ui.the_manager_has_no_active_reply_the_message_is_s_1148c98d"));
    }
    try {
      await current.sendNow(request.trim(), files, typeof messageId === "string" ? messageId : undefined);
      return { ok: true as const, data: null };
    } catch (error) {
      return cliFailure("CHAT_SEND_FAILED", (error as Error).message);
    }
  }
  const busy = background ? backgroundManagerRequests.has(projectKey) :
    boardRequests.has(projectKey) || boardWorkRequests.has(projectKey);
  if (busy) return cliFailure("BOARD_REQUEST_IN_PROGRESS", t("ui.the_agent_is_already_handling_a_request_72b4da49"));
  if (closingProjects.has(board.project)) return cliFailure("PROJECT_CLOSING", t("ui.the_project_is_closing_beb637fb"));
  const writer = agentSlots.claim(board.project, context);
  if (!writer) return cliFailure("BOARD_REQUEST_IN_PROGRESS", t("ui.the_agent_is_already_handling_a_request_72b4da49"));
  // Another window may have delivered, edited or removed the message before this claim.
  let queued: QueuedBoardMessage | undefined;
  try {
    if (queuedPath) {
      queued = readQueuedMessage(queuedPath);
      if (queued && hasManagerMessage(board.project, queued.id, queued.created)) {
        delivered();
        queued = undefined;
      }
    }
  } catch (error) {
    writer();
    return cliFailure("BOARD_QUEUE_FAILED", (error as Error).message);
  }
  if (queuedPath && !queued) {
    writer();
    return { ok: true as const, data: { answer: "", changes: [] } };
  }
  if (queued?.failed) {
    writer();
    return cliFailure("BOARD_QUEUE_FAILED", t("ui.not_sent_28bb3764"));
  }
  const managerReviewId = repairTask?.id ?? (expectedReviewMode === "manager" ? reviewIds?.[0] : undefined);
  const managerReviewKey = managerReviewId ? board.project + "\0" + managerReviewId : undefined;
  const reviewTask = repairTask?.id ?? (cleanupJob ? (cleanupJob.task ? "review:" + cleanupJob.task : "maintenance:" + cleanupJob.id) : undefined) ??
    (managerReviewId ? "review:" + managerReviewId : undefined);
  const repairSlot = reviewTask && !(managerReviewKey && returningDrafts.has(managerReviewKey))
    ? reserveAgent(board.project, "reviewer", reviewTask) : undefined;
  if (reviewTask && !repairSlot) { writer(); return taskRunLimit("reviewer"); }
  if (cleanupJob) {
    const claim = await callCli<{ claimed: boolean }>(board.project, ["maintenance"], { action: "claim", id: cleanupJob.id, owner: process.pid });
    if (!claim.ok || !claim.data.claimed) { repairSlot?.(); writer(); return cliFailure("MAINTENANCE_BUSY", "Maintenance is already claimed."); }
  }
  const release = Object.assign(() => { repairSlot?.(); writer(); }, {
    run: <T>(callback: () => T) => writer.run(() => repairSlot ? repairSlot.run(callback) : callback()),
  });
  const project = board.project;
  const operation = beginOperation(project, cleanupJob
    ? [t("ui.checking_worktree_cleanup_1f82f9a8"), cleanupJob.task].filter(Boolean).join(" · ")
    : [t("ui.project_manager_48697fa0"), repairTask?.id ?? reviewIds?.join(", ")].filter(Boolean).join(" · "));
  const signal = operation.controller.signal;
  if (managerReviewKey) managerReviewOperations.set(managerReviewKey, operation);
  const startedAt = Date.now();
  const managerRun: ManagerRun = { id: randomUUID(), phase: "starting", startedAt, lane: cleanupJob ? "maintenance" : lane };
  const running: ManagerRequest = { managerRun };
  requests.set(projectKey, running);
  let live: NonNullable<import("./board-runtime.ts").RuntimeEntry["state"]>["live"];
  let liveTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  let stopAutomation = () => {};
  const broadcastRun = () => {
    if (!background) broadcastBoardChat(project, "orchestrator-run", goal
      ? { managerWork: running.managerRun ?? null } : { managerRun: running.managerRun ?? null });
    if (background || (goal && !running.managerRun)) {
      for (const { active, tabs } of windowStates.values()) {
        if (tabs.some(tab => tab.project === project)) send(active);
      }
    }
  };
  const publishRun = running.publishRun = (updateWindows = true) => {
    agentSlots.update(project, context, running.managerRun
      ? { ...running.managerRun, goalRunning: running.goalRunning, reviewing: [...running.reviewing ?? []], live } : undefined);
    if (updateWindows) broadcastRun();
  };
  const setRunPhase = (phase: ManagerRun["phase"]) => {
    if (managerRun.phase === phase) return;
    managerRun.phase = phase;
    publishRun();
  };
  function publishLiveActivity() {
    liveTimer = undefined;
    const recent = items.slice(-45);
    // Keep runtime reads small when command output contains a large attachment or transcript.
    let remaining = 128 * 1024;
    const snapshot = recent.reverse().filter(item => (remaining -= JSON.stringify(item).length) >= 0).reverse();
    live = { sequence: (live?.sequence ?? 0) + 1, items: snapshot };
    try { publishRun(false); }
    catch (error) { console.warn("Could not share live manager activity.", (error as Error).message); }
  }
  function showLatestActivity() {
    activityTimer = undefined;
    if (lane === "chat") broadcastBoardChat(project, "orchestrator", { items: managerChatItems(items) });
    if (lane === "work" || managerWorkItems(items).length) {
      broadcastMaintenanceSafe(project, "orchestrator-work-activity");
    }
    const live = items.findLast(item => item.status === "inProgress");
    const item = live && { type: live.type, status: live.status, title: live.title,
      text: live.type === "reasoning" ? live.text.slice(-4096) : "" };
    if (!cleanupJob && JSON.stringify(managerRun.item) !== JSON.stringify(item)) {
      managerRun.item = item;
      broadcastRun();
    }
  }
  const reviewing = running.reviewing = new Set<string>();
  function startReview(ids: string[]) {
    const previousSize = reviewing.size;
    for (const id of ids) reviewing.add(id);
    if (reviewing.size !== previousSize) publishReviewActivity(project);
  }
  function endReview() {
    if (!reviewing.size) return;
    reviewing.clear();
    publishReviewActivity(project);
  }
  const changes: BoardChange[] = [];
  let requestText = queued?.draft.trim() ?? request.trim();
  let pendingAction: Promise<unknown> = Promise.resolve();
  const scratch = new Set<string>();
  let sendingNow: Promise<void> | undefined;
  const steering = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
  const deliveredMessages = new Set<string>();
  let waitWork = new AbortController();
  let items: BoardActivity[] = [];
  let historyMessage: { at?: string; text: string; files: { url?: string; name: string; link?: FileLink; size?: number; error?: string }[]; clientId?: string } | undefined;
  let historyModel: string | undefined;
  let historyAccepted = false;
  const saveHistory = () => {
    if (cleanupJob) {
      try {
        const root = join(project, ".tasks", "maintenance-runs");
        storageDirectory(root, true);
        writeJson(join(root, cleanupJob.id.replaceAll(":", "-") + ".json"), { job: cleanupJob.id, startedAt, items });
      } catch (error) { console.warn("Private maintenance diagnostic could not be saved", error); }
      return;
    }
    if (!(historyAccepted && historyMessage) && !items.length) return;
    try {
      const changed = saveManagerHistory(project, startedAt, managerRun.id, {
        message: historyAccepted ? historyMessage : undefined, items,
        model: historyModel, durationMs: Date.now() - startedAt, lane, goalId: goal ? goalId : undefined,
      });
      if (changed) publishManagerUnread(project);
    } catch (error) {
      console.warn("Could not save manager chat history.", (error as Error).message);
    }
  };
  let threadId: string | undefined;
  let goalId: string | undefined;
  let cancelledWhileWaiting = false;
  let acceptedMessage = false;
  let goalSet = false;
  let activeGoal: BoardGoal | undefined;
  let goalWork = new AbortController();
  const notify = (type: string, details: { at?: string; items?: RunActivity[]; model?: string; goal?: BoardGoal | null; goalRunning?: boolean } = {}) => {
    if (cleanupJob) return;
    if (lane === "work" && type !== "orchestrator-goal") return;
    if (!sender.isDestroyed()) sender.send("chat:update", { project: board.project, type, ...details });
  };
  function publishGoal(details: { goal?: BoardGoal | null; goalRunning: boolean }) {
    notify("orchestrator-goal", details);
    broadcastMaintenanceSafe(project, "orchestrator-goal", details, sender);
  }
  function publishGoalNotice(text: string, actor: "agent" | "user" = "agent") {
    const id = randomUUID();
    const changed = saveManagerHistory(project, Date.now(), id, actor === "user" ? { lane: "notice", goalId, items: [],
      message: { text, files: [], at: new Date().toISOString() } } : { lane: "notice", goalId,
      items: [{ id, at: new Date().toISOString(), type: "agentMessage", title: "", phase: "final_answer", text, status: "completed" }] });
    if (changed) publishManagerUnread(project);
    broadcastMaintenanceSafe(project, "orchestrator-history");
  }
  async function askUser(args: unknown, approval = false): Promise<CliReply> {
    signal.throwIfAborted();
    if (running.changingGoal) return cliFailure("QUESTION_CLOSED", t("errors.e39a8618c13d7aae"));
    const { question, options = [] } = (args ?? {}) as { question?: unknown; options?: unknown };
    if (typeof question !== "string" || !question.trim() || question.length > (approval ? 24_000 : 2000) ||
        !Array.isArray(options) || options.length > 4 ||
        !options.every(option => typeof option === "string" && option.trim() && option.length <= 200)) {
      return cliFailure("INVALID_INPUT", t("errors.d0e2f3f2f0678a26"));
    }
    if (running.question) return cliFailure("QUESTION_PENDING", t("errors.5f7a0da1567491bc"));
    const view: ManagerQuestion = { id: randomUUID(), text: question.trim(), options: [...new Set(options.map(option => option.trim()))],
      ...(approval ? { approval: true } : {}) };
    const response = Promise.withResolvers<string | null>();
    let notification: Notification | undefined;
    function settle(answer: string | null) {
      if (running.question?.view !== view) return;
      running.question = undefined;
      response.resolve(answer);
      notification?.close();
      broadcastMaintenanceSafe(project, "orchestrator-question", { question: managerQuestion(projectKey)?.view ?? null });
    }
    running.question = { view, settle };
    // Leave time to deliver the response before the MCP call's 140-second deadline.
    const timeout = setTimeout(() => settle(null), 120_000);
    const aborted = () => settle(null);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      if (goal && !approval) publishGoalNotice(t("ui.question_from_the_goal_8b2d2caf") + "\n\n" + view.text);
      broadcastMaintenanceSafe(project, "orchestrator-question", { question: managerQuestion(projectKey)?.view ?? null });
      const windows = [...windowStates.values()].filter(({ window, tabs }) =>
        !window.isDestroyed() && tabs.some(tab => tab.board?.project === project));
      if (windows.length && !windows.some(({ window, active }) => window.isFocused() &&
          active.board?.project === project) && Notification.isSupported()) {
        notification = new Notification({ title: t("ui.project_manager_ae7410e8") + basename(project),
          body: view.text.length > 200 ? view.text.slice(0, 199) + "…" : view.text });
        notification.on("click", () => {
          if (running.question?.view !== view) return;
          const target = windows.find(({ window, tabs }) => !window.isDestroyed() &&
            tabs.some(tab => tab.board?.project === project));
          const tab = target?.tabs.find(tab => tab.board?.project === project);
          if (!target || !tab) return;
          if (target.window.isMinimized()) target.window.restore();
          target.window.show();
          activateTab(target, tab);
          target.window.focus();
        });
        notification.show();
      }
      const answer = await response.promise;
      if (goal && answer && !approval) publishGoalNotice(answer, "user");
      return { ok: true, data: { question: view.text, answer } };
    } finally {
      settle(null);
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
    }
  }
  try {
    publishRun();
    if (repairTask) {
      const started = await callCli(project, ["start", repairTask.id, "--compact"], { revision: repairTask.revision, resolveConflicts: true });
      if (!started.ok) return started;
      requestText += "\nAssigned repair context: " + JSON.stringify(started.data);
      startReview([repairTask.id]);
    }
    const binding = boardThreadPath(project);
    const stored = background ? undefined : readBoardThread(binding);
    threadId = stored?.id;
    goalId = goal === true ? randomUUID() : stored?.goalId ?? stored?.id;
    if (goal === "resume" && !threadId) return cliFailure("INVALID_INPUT", t("ui.there_is_no_saved_goal_67c98597"));
    const settings = await callCli<BoardSettings>(board.project, ["settings"]);
    if (!settings.ok) return settings;
    const settingsNotices = settingsDelivery(project, background ? "background" : lane, () => syncSettingsNotices(project, agentSlots.inherited(project)));
    let initialSettings;
    while (!initialSettings) {
      try { initialSettings = settingsNotices.initial(); }
      catch (error) {
        if ((error as { code?: string }).code !== "BOARD_BUSY") throw error;
        await wait(250, undefined, { signal });
      }
    }
    const reviewMode = boardReviewMode(settings.data);
    if (expectedReviewMode && reviewMode !== expectedReviewMode) {
      return cliFailure("REVIEW_MODE_CHANGED", t("errors.5842130646fd0b88"));
    }
    const instructions = cleanupJob ? boardInstructions.replace("Do not edit files, run project code, or change Git state yourself.", "Diagnose and repair only the assigned internal maintenance fault yourself.") +
      " This is a private maintenance run with manager authority charged to the shared reviewer pool. No goal, user messages, notifications or product cards. " +
      "Do not launch agents or change task status. Read the private maintenance diagnostic and inspect ownership, active runtime users, exact absolute paths and Git registration before mutation. " +
      "Retry transient locks/access errors without force or weakening ACLs. Preserve unknown user data with the established saved-changes mechanism and required evidence as individual board attachments/artifacts. " +
      "For node_modules, reproduce dependencies from the tracked lockfile in a dedicated system temp directory using npm ci --ignore-scripts, compare every relative file and SHA-256, " +
      "and remove only matching reproducible dependency files after verifying no active users. Unknown/changed files must remain; never archive dependencies. Clean your temp directory. " +
      "Then call task_cleanup for the original closed card or the maintain CLI for migration/legacy attachments. Never force git worktree remove. " +
      "If safe repair is impossible, keep the private diagnostic and end; automatic retries retain the job. Do not ask the user. Assigned job: " + JSON.stringify(cleanupJob) : repairTask ? boardInstructions.replace("Do not edit files, run project code, or change Git state yourself.", "For this acceptance repair, edit and check only the assigned task worktree.") +
      " This turn repairs one user's pending acceptance as board manager. Do the repair yourself; do not launch an executor or reviewer. " +
      "Work only in the assigned task worktree. Read the current card and acceptanceRepair.targetHead, merge that target without destructive Git operations, " +
      "resolve conflicts without changing requirements, run required project checks, then preview and submit with the task CLI. Keep review throughout. " +
      "Use block with a reason and condition for failed checks, missing access, or a product decision. Do not accept directly; the board resumes the persisted user request after checked submission. "
      : reviewIds ? autoReviewInstructions : (isManual(settings.data) ? manualContext(settings.data) + "\n" + russianWriting : boardInstructions) + (autoNotice ?
      " Handle only the specified expert plans, addressed executor questions, blockers or integration failures in this short run. Do not create or resume a goal. " +
      "Read manager_inbox, handle the specified notices and acknowledge them with manager_ack. Do not retry an unchanged blocker. " +
      "For a merge conflict, organize repair with task_start resolveConflicts:true in the same card and worktree without asking permission to start repair. " +
      "Require a new submission and review after repair; human acceptance stays with the user. Do not perform routine dispatch or accept human-mode submissions. " : "") + (
      !isManual(settings.data) && reviewMode === "human" ? " " + manualReviewInstructions : "") + (goal ?
      " You run the board goal in the background. Read goal_inbox at the start of each turn, before waiting, " +
      "and when notified. Apply user directions, then confirm or decline with goal_inbox and a factual reply. " +
      "Use goal_report for decisions and milestones. In goal mode, progress text shows up in Work Activity and does not open an answer form. If a user decision is necessary, call ask_user directly instead of putting a question in progress text and calling task_wait. Approve clear drafts covered by the user's goal without asking again." :
      background ? "" : " You are the user's conversational manager. When asked about the goal, read goal_read. Direct messages can steer the active dialogue turn. " +
      "For user instructions affecting its running work, use goal_send and report them as queued until the goal confirms. " +
      "The goal handles its incoming executor and reviewer mail. Use board tools for the user's direct requests.");
    const reviewTaskTools = reviewMode === "reviewer"
      ? new Set([...autoReviewTaskTools, "manager_ack", "task_cancel", "task_start"]) : autoReviewTaskTools;
    const stages = reviewMode === "manager" ? phaseStageReporter(project, "review") : undefined;
    const mcpTools: BoardMcpTool[] = boardMcpTools.filter(({ name }) =>
      (name !== "expert_stage" || reviewMode === "manager") &&
      (!cleanupJob || ["board_list", "task_show", "task_cleanup_status", "task_cleanup", "project_path", "project_sha256"].includes(name)) &&
      (!isManual(settings.data) || ["expert_list", "expert_context", "expert_skill", "board_list", "task_show", "task_create", "task_update", "task_comment", "tag_set_color", "ask_user"].includes(name)) &&
      (reviewIds || cleanupJob || !["project_path", "project_sha256"].includes(name)) &&
      (!reviewIds || autoReviewReadTools.has(name) || reviewTaskTools.has(name)) &&
      (name !== "task_accept" || reviewMode !== "human") &&
      (!repairTask || !["task_start", "task_start_batch", "task_accept", "task_request_changes", "task_return_to_draft"].includes(name)));
    if (!reviewIds && !cleanupJob) mcpTools.push(...(goal ? goalWorkTools : background ? [] : goalChatTools), githubReadTool);
    const attachments = await prepareBoardAttachments(queued ? queuedFiles(queued) : files, scratch);
    if (!reviewIds && !autoNotice && goal !== "resume") {
      historyMessage = {
        at: new Date().toISOString(),
        text: requestText,
        files: attachments.flatMap(file => file.image || file.link ? [{ name: file.name, ...(file.image ? { url: file.image } : {}), ...(file.link ? { link: file.link, size: file.link.size, error: file.error } : {}) }] : []),
        clientId: typeof messageId === "string" ? messageId : undefined,
      };
    }
    let imageIndex = 0;
    const unread = cleanupJob || reviewIds || (!goal && boardWorkRequests.get(projectKey)?.goalRunning) ? [] :
      (subscriptions.get(project)?.board ?? board).managerInbox ?? [];
    const priorChat = lane === "chat" && !threadId ? readManagerHistory(project, null, "chat")?.turns.slice(-8)
      .flatMap(turn => turn.lane === "notice" ? [] : [{
        user: turn.messages.map(message => message.text).join("\n").slice(-1200),
        manager: turn.items.findLast(item => item.type === "agentMessage" && item.phase !== "commentary")?.text.slice(-1200),
      }]) : undefined;
    const attachmentContext = attachments.length || unread.length || priorChat?.length ? JSON.stringify({
      ...(attachments.length ? { attachments: attachments.map(({ name, image, path, link, error }, index) => ({
        id: index + 1, name, ...(link ? { path, link, error } : {}), image: Boolean(image), ...(image ? { imageIndex: ++imageIndex } : {}),
      })), fallbackLanguage: t("ui.english_e7d843ef") } : {}),
      unreadBoardMessages: unread.length || undefined,
      previousConversation: priorChat?.length ? priorChat : undefined,
    }) : undefined;
    const runAction = boardActions(board.project, attachments, changes, signal,
      (id, revision, { reason, targetHead, reviewMode, newThread, resolveConflicts } = {}) => reason ?
        launchTask(board.project, id, { input: { revision, reason, targetHead, reviewMode, actor: "manager" } }) :
        launchTask(board.project, id, undefined, newThread ? "manager" : false, revision, undefined, false, resolveConflicts),
      () => activeGoal && threadId ? { threadId, objective: activeGoal.objective, signal: goalWork.signal } : undefined,
      id => executorBusy(board.project, id), listener => observeBoardTasks(board, listener), async (id, sequence) => {
        const agent = activeAgents.get(board.project + "\0" + id);
        if (!agent) return false;
        await agent.control.steer(`AI Taskboard: the project manager sent message ${sequence} for ${id}. ` +
          `Use messages ${id} --stdin with afterSequence set to the last manager message you read in this chat. ` +
          `If no prior sequence is known, run messages ${id}.`, []);
        return true;
      }, deliveredMessages, () => waitWork.signal, undefined, undefined,
      (id, revision) => id === managerReviewId
        ? Promise.resolve(cliFailure("CHAT_BUSY", "Return this task from its card or the manager chat after this automatic review ends."))
        : returnTaskToDraft(board.project, id, revision, "manager"));
    const run = async (name: string, args: unknown): Promise<CliReply> => {
      try {
        if (name === "task_set_executor_access") return await setTaskExecutorAccess(app.getPath("userData"), board.project, args);
        const result = await runAction(name, args);
        if (name === "task_show" && result.ok && !reviewIds) {
          const task = result.data as Task;
          return { ok: true, data: { ...task, executorFullAccess: executorFullAccess(app.getPath("userData"), board.project, task) } };
        }
        return result;
      } catch (error) { return cliFailure("ACTION_FAILED", (error as Error).message); }
    };
    function goalAction(name: string, args: unknown): CliReply | undefined {
      if (reviewIds || !(goal ? goalWorkTools : goalChatTools).some(tool => tool.name === name)) return;
      const { text, id, status, reply } = (args ?? {}) as Record<string, unknown>;
      const saved = readBoardThread(boardThreadPath(project));
      const scope = saved?.goalId ?? saved?.id;
      const work = boardWorkRequests.get(projectKey);
      if (name === "goal_read") {
        const current = subscriptions.get(project)?.board ?? board;
        const active = work?.goalRunning ? work.items : undefined;
        const history = saved?.goal ? readManagerHistory(project)?.turns ?? [] : [];
        const recent = active?.length ? active : history.flatMap(turn =>
          turn.goalId && turn.goalId !== scope ? [] : managerWorkItems(turn.items, turn.lane));
        const notices = history.filter(turn => turn.lane === "notice" && turn.goalId === scope).slice(-6).map(turn => ({
            report: turn.items[0]?.text.slice(0, 1500), userReply: turn.messages[0]?.text.slice(0, 1500),
          }));
        return { ok: true, data: { goal: saved?.goal ?? null, running: work?.goalRunning === true,
          currentAction: work?.managerRun?.item, recent: recent.filter(item =>
            item.messages?.length || item.taskChanges?.length || item.type === "agentMessage" || item.type === "reasoning")
            .slice(-8).map(({ type, title, text, messages, taskChanges }) => ({
              type, title, text: text.slice(-1000), messages: messages?.slice(-3).map(message =>
                ({ ...message, text: message.text.slice(0, 1000) })), taskChanges,
            })),
          tasks: (current?.tasks ?? []).filter(({ status }) => ["in_progress", "review", "blocked"].includes(status))
            .slice(0, 20).map(({ id, title, status }) => ({ id, title, status,
              working: executorBusy(project, id) || work?.reviewing?.has(id) || subscriptions.get(project)?.reviewerRuns.has(id) || false })),
          messages: scope && saved?.goal ? goalMessages(project, scope).slice(-20) : [],
          notices,
        } };
      }
      if (!scope || !saved?.goal || (goal && goalId !== scope)) {
        return cliFailure("GOAL_NOT_FOUND", t("errors.b8f9fec76b5968a1"));
      }
      if (name === "goal_inbox") {
        if (id === undefined && status === undefined && reply === undefined) {
          return { ok: true, data: goalMessages(project, scope).filter(message => message.status === "pending").slice(0, 20) };
        }
        if (typeof id !== "string" || (status !== "applied" && status !== "declined") ||
            typeof reply !== "string" || !reply.trim() || reply.length > 4000) {
          return cliFailure("INVALID_INPUT", t("errors.409e77852acbf704"));
        }
        const message = goalMessages(project, scope, { id, status, reply: reply.trim() });
        if (!message) return cliFailure("GOAL_MESSAGE_CLOSED", t("errors.fdc1298c4460b8d8"));
        publishGoalNotice(t(status === "applied" ? "goal.applied" : "goal.declined") + "\n\n" + message.reply);
        return { ok: true, data: message };
      }
      if (typeof text !== "string" || !text.trim() || text.length > 4000) return cliFailure("INVALID_INPUT",
        t("errors.499ff15e65ec05d9"));
      if (name === "goal_report") {
        publishGoalNotice(text.trim());
        return { ok: true, data: null };
      }
      if (saved.goal.status === "complete") return cliFailure("GOAL_NOT_RUNNING", t("errors.890377d10e87f9fa"));
      if (work?.changingGoal) return cliFailure("BOARD_REQUEST_IN_PROGRESS", t("errors.c2e4313d7df12342"));
      const message = goalMessages(project, scope, { text: text.trim() });
      if (work?.goalRunning) work.wakeGoal?.();
      return { ok: true, data: message };
    }
    const response = await release.run(() => replyToBoard(app.getPath("userData"), board.project,
      goal === "resume" ? "" : requestText || t("ui.see_attachments_863aa6f1"),
      attachments.flatMap(file => file.image ? [file.image] : []),
      async (name, args) => {
        if (reviewIds && !autoReviewReadTools.has(name)) {
          const input = args as { id?: string; messages?: { id?: string }[] } | null;
          const ids = name === "manager_ack" && Array.isArray(input?.messages)
            ? input.messages.map(entry => entry?.id) : [input?.id];
          if (!ids.length || ids.some(id => !id || !reviewIds.includes(id)) || !reviewTaskTools.has(name)) {
            return Promise.resolve(cliFailure("INVALID_INPUT", t("errors.65287892d17f9b5f")));
          }
        }
        if (name === "ask_user") return askUser(args);
        if (name === githubReadTool.name) return readBoardGitHub(board.project, args);
        if (name.startsWith("goal_")) {
          try { return goalAction(name, args) ?? cliFailure("INVALID_INPUT", t("errors.63a61aea5ed6f41a")); }
          catch (error) { return cliFailure("ACTION_FAILED", (error as Error).message); }
        }
        if (name === "task_wait" && goal && goalId && goalMessages(project, goalId).some(message => message.status === "pending")) {
          return { ok: true, data: { goalMessagesPending: true, instruction: "Read goal_inbox before waiting." } };
        }
        // Starts can overlap, but they must see any board edits queued before them.
        const independent = name === "task_wait" || name === "task_start" || name === "task_start_batch" || name === "task_review";
        const pending = name === "task_wait" ? run(name, args) : pendingAction.then(() =>
          name === "expert_stage" && stages ? stages.report(args) : run(name, args));
        if (!independent) pendingAction = pending;
        return pending.then(result => {
          if (reviewIds || cleanupJob) return result;
          if (name === "task_review" && result.ok) {
            const { id, reviewMode, stale } = result.data as { id: string; reviewMode: string; stale: boolean };
            if (!stale && reviewMode !== "reviewer" && !signal.aborted && requests.get(projectKey) === running) startReview([id]);
          }
          if (name === "task_wait" && goal && goalId && goalMessages(project, goalId).some(message => message.status === "pending")) {
            return { ...result, goalMessagesPending: true };
          }
          if (name === "manager_inbox" || name === "task_wait" || name === "manager_ack") return result;
          const unread = !goal && boardWorkRequests.get(projectKey)?.goalRunning ? [] :
            (subscriptions.get(board.project)?.board ?? board).managerInbox ?? [];
          const attention = unread.filter(({ id, sequence, kind }) =>
            needsManagerAttention(kind) && !deliveredMessages.has(id + "\0" + sequence));
          return attention.length ? { ...result, unreadBoardAttention: {
            count: attention.length,
            messages: attention.slice(0, 5).map(({ id, sequence, kind }) => ({ id, sequence, kind })),
            action: "Read manager_inbox for executor questions, blockers, submissions and review decisions.",
          } } : result;
        });
      }, cleanupJob ? boardTools.filter(tool => ["board_list", "task_show"].includes(tool.name)) : reviewIds ? [] : isManual(settings.data) ? boardTools.filter(tool => ["board_list", "task_show", "task_create", "task_update", "tag_set_color", "ask_user"].includes(tool.name)) : boardTools, instructions + "\n" + initialSettings.text, signal, {
        id: threadId,
        separateTurn: reviewIds ? true : undefined,
        role: cleanupJob || repairTask ? "reviewer" : "manager",
        access: reviewIds ? undefined : managerAccess(app.getPath("userData"), project),
        confirmApproval: cleanupJob ? async () => false : reviewIds ? undefined : async details => {
          if (signal.aborted || requests.get(projectKey) !== running) return false;
          const allow = t("ui.allow_once_8539a30b");
          const result = await askUser({ question: details, options: [allow, t("ui.deny_ffcf9a77")] }, true);
          return !signal.aborted && result.ok && (result.data as { answer: string | null }).answer === allow;
        },
        settings: settings.data.manager,
        attachmentContext,
        mcpTools,
        observeProvider: stages?.observe,
        goal: goal === true ? requestText : undefined,
        resumeGoal: goal === "resume",
        readOnly: Boolean(reviewIds),
        onGoalSet: () => {
          goalSet = true;
          if (goal === true) {
            const saved = readBoardThread(binding);
            if (saved) writeJson(binding, { ...saved, goalId });
            acceptedMessage = true;
            historyAccepted = true;
            saveHistory();
            notify("orchestrator-message-time", { at: historyMessage?.at });
            delivered();
            if (typeof messageId === "string") broadcastMaintenanceSafe(project, "orchestrator-work-accepted", { id: messageId });
          }
        },
        messageId: typeof messageId === "string" ? messageId : undefined,
        onMessage: id => {
          if (id === messageId) {
            acceptedMessage = true;
            historyAccepted = true;
            saveHistory();
            notify("orchestrator-message-time", { at: historyMessage?.at });
            delivered();
          }
          if (steering.has(id)) saveHistory();
          steering.get(id)?.resolve(true);
        },
        onGoal: updatedGoal => {
          if (!goal) return;
          saveBoardGoal(binding, updatedGoal);
          activeGoal = updatedGoal?.status === "active" ? updatedGoal : undefined;
          if (activeGoal && goalWork.signal.aborted) goalWork = new AbortController();
          if (!activeGoal) goalWork.abort();
          const goalRunning = Boolean(activeGoal);
          running.goalRunning = goalRunning;
          publishRun(false);
          publishGoal({ goal: updatedGoal, goalRunning });
        },
        onGoalControl: control => { if (goal) running.goal = control; },
        onTurnEnded: () => { endReview(); saveHistory(); },
        onTokenUsage: async report => {
          if (cleanupJob?.task) return saveTaskTokenUsage(project, cleanupJob.task, "reviewer", report);
          if (cleanupJob) return;
          if (repairTask) return saveTaskTokenUsage(project, repairTask.id, "reviewer", report);
          const saved = await callCli(project, ["manager-usage"], report);
          if (!saved.ok) console.warn("Could not save manager token usage (%s).", saved.error.code);
        },
        title: t("ui.project_manager_for_3f3547d6") + (basename(board.project) || board.project),
        save: id => {
          if (!background) writeJson(binding, { ...readBoardThread(binding), provider: "codex", id, history: "local" });
          threadId = id;
        },
        onActivity: activity => {
          items = activity;
          if (!cleanupJob) {
            running.items = activity;
            liveTimer ??= setTimeout(publishLiveActivity, 500);
          }
          activityTimer ??= setTimeout(showLatestActivity, 100);
        },
        onWaiting: waiting => {
          running.stop = waiting ? async () => {
            cancelledWhileWaiting = true;
            operation.controller.abort();
          } : undefined;
          notify(waiting ? "orchestrator-waiting" : "orchestrator-sending");
          setRunPhase(waiting ? "waiting" : "starting");
        },
        onControl: (control, model) => {
          settingsNotices.acknowledge(initialSettings.sequence);
          running.settingsChanged = () => {
            void settingsNotices.flush(async text => {
              await control.steer(text + "\nМодель текущего запуска: " + JSON.stringify(model ?? "определяется провайдером") +
                "; рассуждение этого запуска: " + JSON.stringify(settings.data.manager?.effort ?? "по умолчанию провайдера") + ".", []);
              waitWork.abort();
              waitWork = new AbortController();
            }).catch(error => console.warn("Settings delivery deferred until next run.", (error as Error).message));
          };
          running.settingsChanged();
          historyModel = model;
          running.stop = () => control.interrupt();
          setRunPhase("running");
          if (reviewIds) {
            startReview(reviewIds);
            notify("orchestrator-ready", { model });
            return;
          }
          if (!cleanupJob && !repairTask) {
            stopAutomation();
            const automation = automationDelivery(text => control.steer(text, []), () => {
              waitWork.abort();
              waitWork = new AbortController();
            }, signal);
            running.automationEvent = event => automation.event(event);
            const observeAutomation = (snapshot: Board) => {
              const entries = agentSlots.entries(project);
              automation.observe(snapshot, id => ({
                running: executorBusy(project, id),
                reviewing: subscriptions.get(project)?.reviewerRuns.has(id) ||
                  entries.some(entry => entry.kind === "slot" && entry.role === "reviewer" && entry.task === "review:" + id),
              }));
            };
            running.automationChanged = observeAutomation;
            stopAutomation = () => { automation.dispose(); running.automationEvent = undefined; running.automationChanged = undefined; };
            observeAutomation(subscriptions.get(project)?.board ?? { ...board, settings: settings.data });
          }
          if (goal) {
            running.wakeGoal = () => {
              waitWork.abort();
              waitWork = new AbortController();
              void control.steer("AI Taskboard: new user directions are available. Read goal_inbox.", []).catch(() => {});
            };
          }
          if (background) return;
          running.sendNow = (text, files, messageId) => {
            if (sendingNow) throw new Error(t("ui.a_message_is_already_being_sent_ed690319"));
            sendingNow = (async () => {
              const prepared = await prepareBoardAttachments(files, scratch);
              signal.throwIfAborted();
              let imageIndex = 0;
              const firstAttachment = attachments.length;
              const prompt = prepared.length ? JSON.stringify({ latestUserMessage: {
                text, attachments: prepared.map(({ name, image, path, link, error }, index) => ({
                  id: firstAttachment + index + 1, name, ...(link ? { path, link, error } : {}), ...(image ? { imageIndex: ++imageIndex } : {}),
                })),
              } }) : text;
              // Make the new files available to any tool call triggered by this message.
              attachments.push(...prepared);
              const receipt = messageId ? Promise.withResolvers<boolean>() : undefined;
              if (messageId && receipt) steering.set(messageId, receipt);
              try {
                await control.steer(prompt, prepared.flatMap(file => file.image ? [file.image] : []), messageId);
              } catch (error) {
                attachments.length = firstAttachment;
                throw error;
              }
              waitWork.abort();
              waitWork = new AbortController();
              if (receipt && !await receipt.promise) {
                throw new Error(t("ui.the_active_reply_ended_before_the_message_was_de_d8eae951"));
              }
              if (messageId) {
                const path = join(project, ".tasks", "manager-queue", messageId + ".json");
                runtimeTransaction(project, () => rmSync(path, { force: true }));
              }
            })().finally(() => {
              if (messageId) steering.delete(messageId);
              sendingNow = undefined;
            });
            return sendingNow;
          };
          notify("orchestrator-ready", { model });
        },
      }));
    await pendingAction;
    signal.throwIfAborted();
    if ("interrupted" in response) return { ok: true as const, data: {
      answer: "", items: lane === "chat" ? managerChatItems(items) : items, changes, error: t("ui.reply_stopped_c7fee9e0"), id: threadId,
      keepQueued: Boolean(queuedPath && !acceptedMessage),
    } };
    const goalNotice = {
      paused: t("ui.goal_paused_be134ecc"),
      blocked: t("ui.goal_blocked_438409c7"),
      usageLimited: t("ui.codex_reached_its_usage_limit_391a3158"),
      budgetLimited: t("ui.the_goal_reached_its_token_budget_48c79e0d"),
      cleared: t("ui.goal_cleared_5abf5e63"),
      active: undefined,
      complete: undefined,
    };
    const error = response.goalStatus && goalNotice[response.goalStatus];
    historyAccepted = true;
    historyModel = response.model ?? historyModel;
    if (response.text && !items.some(item => item.type === "agentMessage" && item.phase !== "commentary")) {
      items = [...items, { id: managerRun.id, at: new Date().toISOString(), type: "agentMessage", title: "", phase: "final_answer",
        text: response.text, status: "completed" }];
    }
    if (!error && queuedPath && !acceptedMessage) {
      acceptedMessage = true;
      saveHistory();
      delivered();
    }
    return { ok: true as const, data: { answer: response.text, items: lane === "chat" ? managerChatItems(items) : items, changes, model: response.model, error, id: threadId,
      keepQueued: Boolean(queuedPath && error && !acceptedMessage) } };
  } catch (error) {
    await pendingAction;
    if (cancelledWhileWaiting) return cliFailure("BOARD_WAIT_CANCELLED", "");
    const message = t("ui.could_not_complete_the_board_request_91ea559c") + "\n" + (error instanceof Error ? error.message : String(error)).slice(0, 1500);
    if (goalSet || changes.length || acceptedMessage) {
      if (changes.length) delivered();
      return { ok: true as const, data: { answer: "", items: lane === "chat" ? managerChatItems(items) : items, changes, error: goalSet ? t("ui.the_goal_is_saved_in_the_codex_chat_this_run_end_5bbc3859") + "\n" + message : message, id: threadId, keepQueued: Boolean(queuedPath && !acceptedMessage && !changes.length) } };
    }
    return cliFailure("CODEX_BOARD_REQUEST_FAILED", message);
  } finally {
    clearTimeout(liveTimer);
    clearTimeout(activityTimer);
    stopAutomation();
    if (cleanupJob) {
      try { await callCli(project, ["maintenance"], { action: "release", id: cleanupJob.id, owner: process.pid }); }
      catch (error) { console.warn("Private maintenance release deferred", error); }
    }
    saveHistory();
    endReview();
    running.question?.settle(null);
    running.sendNow = undefined;
    if (reviewIds) operation.controller.abort();
    goalWork.abort();
    waitWork.abort();
    for (const receipt of steering.values()) receipt.resolve(false);
    await sendingNow?.catch(() => {});
    for (const directory of scratch) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    if (queuedPath && !acceptedMessage) {
      try {
        runtimeTransaction(project, () => {
          const pending = readQueuedMessage(queuedPath);
          if (pending) writeJson(queuedPath, { ...pending, failed: true });
        });
      } catch (error) { console.warn("Could not save the queued message failure.", error); }
    }
    requests.delete(projectKey);
    release?.();
    if (managerReviewKey) managerReviewOperations.delete(managerReviewKey);
    if (running.goalRunning) publishGoal({ goalRunning: false });
    running.managerRun = undefined;
    broadcastRun();
    operation.finish();
    if (threadId || historyAccepted || items.length) {
      broadcastMaintenanceSafe(project, "orchestrator-work-history");
      if (lane === "chat") broadcastMaintenanceSafe(project, "orchestrator-history");
    }
    const watch = subscriptions.get(board.project);
    if (watch) setImmediate(() => scheduleAutoReview(watch));
  }
}

function scheduleAutoReview(watch: BoardWatch) {
  if (isManual(watch.board.settings)) return;
  if (subscriptions.get(watch.board.project) !== watch) return;
  const mode = boardReviewMode(watch.board.settings);
  const { project, tasks } = watch.board;
  if (mode === "human") {
    watch.reviewAttempts.clear();
    watch.integrationAttempts.clear();
    if (watch.reviewReports.size) {
      watch.reviewReports.clear();
      saveReviewReports(project, watch.reviewReports);
    }
    return;
  }
  const openIds = new Set(tasks.filter(task => task.status !== "done" && task.status !== "cancelled").map(task => task.id));
  const reportCount = watch.reviewReports.size;
  for (const id of watch.reviewReports.keys()) {
    if (!openIds.has(id)) watch.reviewReports.delete(id);
  }
  if (watch.reviewReports.size !== reportCount) saveReviewReports(project, watch.reviewReports);
  const submissions = tasks.filter(task => task.status === "review");
  const submittedIds = new Set(submissions.map(task => task.id));
  for (const id of watch.reviewAttempts.keys()) {
    if (!submittedIds.has(id)) watch.reviewAttempts.delete(id);
  }
  for (const id of watch.integrationAttempts.keys()) {
    if (!submittedIds.has(id)) watch.integrationAttempts.delete(id);
  }
  const projectKey = projectIdentity(project);
  const overrides = watch.board.settings?.taskLimits;
  const managerAvailable = agentSlots.available(projectKey, "manager", overrides) > 0 && !backgroundManagerRequests.has(projectKey);
  if (closingProjects.has(project) || (mode === "manager" && (watch.reviewerRuns.size || !managerAvailable))) return;
  const tab = [...watch.tabs].find(tab => !tab.window.isDestroyed());
  if (!tab) return;
  const managerBatchSize = 4;
  const capacity = agentSlots.available(projectKey, "reviewer", overrides);
  const available = mode === "reviewer" ? capacity : Math.min(1, capacity);
  const reviewAttempt = (task: Task & { reviewDecision?: number }) => mode + ":" + task.revision + ":" + (task.reviewDecision ?? 0);
  const ready = submissions.filter(task => !task.acceptanceRepair && !watch.reviewerRuns.has(task.id) &&
    (!watch.board.settings.requireExpertPlans || task.expertReviewPlanned) &&
    (mode !== "reviewer" || !task.reviewApproved) &&
    watch.reviewAttempts.get(task.id) !== reviewAttempt(task) &&
    ((mode === "reviewer" && task.reviewHasCommit) || !executorBusy(project, task.id))).slice(0, available);
  for (const task of ready) watch.reviewAttempts.set(task.id, reviewAttempt(task));
  let ids = ready.map(task => task.id);
  let prompt: string;
  if (mode === "reviewer") {
    for (const id of ids) {
      const release = reserveAgent(project, "reviewer", "review:" + id);
      if (!release) { watch.reviewAttempts.delete(id); continue; }
      watch.reviewerRuns.set(id, release.run(() => reviewSubmission(watch, id, 4)).finally(() => {
        watch.reviewerRuns.delete(id);
        release();
        publishReviewActivity(project);
      }));
    }
    if (ready.length) publishReviewActivity(project);
    if (watch.board.settings.autoMode) { scheduleAutoBoard(watch); return; }
    if (!managerAvailable) return;
    const approvals = (watch.board.managerInbox ?? []).filter(({ id, kind, sequence }) =>
      kind === "review-approve" && watch.integrationAttempts.get(id) !== sequence).slice(0, managerBatchSize);
    for (const { id, sequence } of approvals) watch.integrationAttempts.set(id, sequence);
    ids = approvals.map(({ id }) => id);
    prompt = t("ui.ai_taskboard_the_reviewer_approved_these_submiss_7b01f774") + approvals.map(({ id, sequence }) => id + " (" + sequence + ")").join(", ");
  } else {
    prompt = t("ui.ai_taskboard_automatic_review_follow_the_board_s_d65f54d4") + ids.join(", ");
  }
  if (!ids.length) return;
  const failed = (error: string) => broadcastBoardChat(project, "orchestrator-review-error", { error });
  void runBoardRequest(tab.window.webContents, watch.board, prompt, [], false, false, undefined, ids, mode).then(result => {
    if (!result.ok) {
      if (["MANAGER_LIMIT", "REVIEWER_LIMIT", "BOARD_REQUEST_IN_PROGRESS"].includes(result.error.code)) {
        for (const id of ids) { watch.reviewAttempts.delete(id); watch.integrationAttempts.delete(id); }
      } else if (result.error.code !== "REVIEW_MODE_CHANGED") failed(result.error.message);
    } else if (result.data?.error) failed(result.data.error);
  }).catch(error => failed((error as Error).message));
}

async function reviewSubmission(watch: BoardWatch, id: string, retryLimit: number) {
  const { board: { project }, reviewReports: reports } = watch;
  const key = project + "\0" + id;
  if (returningDrafts.has(key)) return;
  const operation = beginOperation(project, t("ui.reviewer_50c42665") + " · " + id);
  const { signal } = operation.controller;
  reviewOperations.set(key, operation);
  const waitForExecutor = async (revision: number) => {
    signal.throwIfAborted();
    if (!executorBusy(project, id)) return true;
    const ready = Promise.withResolvers<boolean>();
    const updated = (board: Board) => {
      const task = board.tasks.find(task => task.id === id);
      if (!task || task.revision > revision || (task.revision === revision && task.status !== "review") ||
          boardReviewMode(board.settings) !== "reviewer") ready.resolve(false);
      else if (!executorBusy(project, id)) ready.resolve(true);
    };
    const unsubscribe = observeBoardTasks(watch.board, updated);
    const abort = () => ready.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      updated(watch.board);
      return await ready.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
  };
  let usage: TokenUsageReport | undefined;
  const review = boardActions(project, [], [], signal, async () => cliFailure("INVALID_INPUT", t("errors.6c4fab5f39631a35")),
    () => undefined, id => executorBusy(project, id), () => () => {}, async () => false, undefined, () => signal,
    (settings, context, call, reviewSignal, submissionSequence) => {
      const startedAtMs = Date.now();
      const started = performance.now();
      return withReviewerChat(project, id, () => broadcastBoardChat(project, "reviewer-chat", { id }), async onActivity => {
        const records: TokenUsageReport["records"] = [];
        const trackUsage = async (report: TokenUsageReport) => {
          records.push(...report.records);
          usage = {
            ...report, records: [...records],
            ...(submissionSequence > 0 ? {
              reviewTiming: { submissionSequence, startedAtMs, durationMs: Math.round(performance.now() - started) },
            } : {}),
          };
        };
        let firstPass: RunActivity[] = [];
        const evidence = JSON.parse(context);
        const initial = await reviewWithCodex(app.getPath("userData"), project, settings, context, reviewerTools, call, reviewSignal,
          trackUsage, id, items => { firstPass = items; onActivity(items); }, evidence.reviewTeam, evidence.targetHead);
        const candidate = initial as Partial<ReviewReport> | null;
        if (settings?.model !== defaultBoardAgents.reviewer.model || candidate?.needsHuman !== false ||
            (!candidate.verifyRisk && !candidate.findings?.length)) return initial;
        reviewSignal.throwIfAborted();
        const verification: RunActivity = { id: "review-verification", type: "agentMessage", title: "",
          text: t("ui.independent_confirmation_gpt_6_1_sol_715d9f57"),
          status: "completed", phase: "commentary" };
        const previous = [...firstPass, verification];
        onActivity(previous);
        return reviewWithCodex(app.getPath("userData"), project, reviewVerifier,
          JSON.stringify({ ...evidence, candidateReview: candidate }), reviewerTools, call, reviewSignal,
          trackUsage, id, items => onActivity([...previous, ...items]), evidence.reviewTeam, evidence.targetHead);
      });
    }, reports);
  const notify = (error: string) => {
    if (!signal.aborted) broadcastBoardChat(project, "orchestrator-review-error", { error: id + " · " + error });
  };
  try {
    // The manager can advance the target while this reviewer is reading.
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const previous = reports.get(id);
      const early = executorBusy(project, id);
      let result = await review("task_review", { id });
      if (early && result.ok && (result.data as { stale: boolean }).stale) {
        // A running executor can still clean up its worktree after committing.
        if (!(await waitForExecutor((result.data as { revision: number }).revision))) return;
        result = await review("task_review", { id });
      }
      if (!result.ok) {
        if (!["INVALID_TRANSITION", "REVISION_CONFLICT"].includes(result.error.code)) notify(result.error.message);
        return;
      }
      const { reviewMode, stale, revision, targetHead, reviewer } = result.data as {
        reviewMode: string; stale: boolean; revision: number; targetHead: string | null;
        reviewer?: ReviewReport;
      };
      if (reviewMode !== "reviewer") return;
      if (stale) {
        notify(t("ui.the_submission_changed_submit_it_again_38ed8598"));
        return;
      }
      if (!reviewer) return;
      if (reports.get(id) !== previous) saveReviewReports(project, reports);
      if (!(await waitForExecutor(revision)) || executorBusy(project, id)) return;
      signal.throwIfAborted();
      const input = { revision, targetHead, reviewMode, actor: "reviewer", reviewerUsage: usage };
      const needsMoreEvidence = !reviewer.findings.length && (!reviewer.evidence.length || reviewer.evidence.includes(null));
      const recordDecision = () => {
        if (reviewer.needsHuman || needsMoreEvidence) {
          return callCli(project, ["review-note", id, "--compact"], { ...input, summary: reviewer.summary });
        }
        if (reviewer.findings.length) {
          return launchTask(project, id, { input: { ...input, reason: reviewer.findings.join("\n\n") } });
        }
        return callCli(project, ["review-approve", id, "--compact"], { ...input, summary: reviewer.summary, evidence: reviewer.evidence });
      };
      let decided = await recordDecision();
      // BOARD_BUSY means the command never started. Keep the report and retry the write.
      for (let retry = 0; retry < 2 && !decided.ok && decided.error.code === "BOARD_BUSY"; retry++) {
        signal.throwIfAborted();
        if (executorBusy(project, id)) return;
        decided = await recordDecision();
      }
      if (decided.ok) {
        usage = undefined;
        return;
      }
      if (decided.error.code === "TARGET_CHANGED") {
        if (usage) await saveTaskTokenUsage(project, id, "reviewer", usage);
        usage = undefined;
        continue;
      }
      if (!["REVIEW_MODE_CHANGED", "AUTO_REVIEW_DISABLED", "REVISION_CONFLICT", "INVALID_TRANSITION"].includes(decided.error.code)) {
        notify(decided.error.message);
      }
      return;
    }
    notify(t("ui.the_target_branch_kept_changing_during_review_b111fe46"));
  } catch (error) {
    if (!signal.aborted) notify((error as Error).message);
  } finally {
    try {
      if (usage) await saveTaskTokenUsage(project, id, "reviewer", usage);
    } finally {
      reviewOperations.delete(key);
      operation.finish();
    }
  }
}
ipcMain.handle("board:create", async (event, type: unknown) => {
  if (type !== "agent" && type !== "manual") return cliFailure("INVALID_INPUT", "Выберите тип доски в приложении.");
  return pickProject(stateOf(event), type);
});
ipcMain.handle("board:recent", async (event, path: unknown) => {
  const state = stateOf(event);
  if (typeof path !== "string" || !recentBoards.includes(path)) throw new Error("Unknown recent board.");
  await openProject(state, path);
});
ipcMain.handle("app:checkUpdates", async event => {
  stateOf(event);
  try {
    return { ok: true, data: await checkForUpdates(app.getVersion()) };
  } catch (error) {
    return cliFailure("UPDATE_CHECK_FAILED", error instanceof Error ? error.message : String(error));
  }
});
ipcMain.handle("appearance:themes", event => {
  stateOf(event);
  return Object.entries(themes).map(([id, [label]]) => [id, label]);
});
ipcMain.handle("agents:limits", (event, value: unknown) => {
  stateOf(event);
  if (value === undefined) {
    const project = stateOf(event).project;
    return { ok: true, data: project ? agentSlots.inherited(project) : agentSlots.limits };
  }
  const limits = parseAgentLimits(value);
  if (!limits) return cliFailure("INVALID_INPUT", t("ui.enter_non_negative_whole_numbers_for_the_limits_e203cc5b"));
  try {
    const profile = app.getPath("userData");
    mkdirSync(profile, { recursive: true });
    writeJson(join(profile, "task-limits.json"), limits);
  } catch {
    return cliFailure("STORAGE_ERROR", t("ui.could_not_save_agent_limits_a463f6f4"));
  }
  agentSlots.configure(limits);
  for (const project of subscriptions.keys()) {
    syncSettingsNotices(project, limits);
    const key = projectIdentity(project);
    boardRequests.get(key)?.settingsChanged?.();
    boardWorkRequests.get(key)?.settingsChanged?.();
    backgroundManagerRequests.get(key)?.settingsChanged?.();
  }
  scheduleAgentWork();
  return { ok: true, data: limits };
});
ipcMain.handle("appearance:theme", (event, value: unknown) => {
  stateOf(event);
  if (!isTheme(value)) return cliFailure("INVALID_INPUT", t("errors.d755399674e3ddba"));
  try {
    const profile = app.getPath("userData");
    mkdirSync(profile, { recursive: true });
    writeJson(join(profile, "appearance.json"), { theme: value, language: localization.state().preference });
  } catch {
    return cliFailure("STORAGE_ERROR", t("ui.could_not_save_the_theme_ca7fcde8"));
  }
  theme = value;
  nativeTheme.themeSource = themes[theme][1];
  for (const state of windowStates.values()) {
    if (!state.window.isDestroyed()) state.window.webContents.send("appearance:changed", theme);
  }
  return { ok: true, data: theme };
});
ipcMain.handle("appearance:language", (event, value: unknown) => {
  stateOf(event);
  if (typeof value !== "string" || (value !== "system" && !Object.hasOwn(localization.names, value))) return cliFailure("INVALID_INPUT", t("errors.b6d1bc895676e4dc"));
  try {
    const profile = app.getPath("userData");
    mkdirSync(profile, { recursive: true });
    writeJson(join(profile, "appearance.json"), { theme, language: value });
  } catch { return cliFailure("STORAGE_ERROR", t("settings.save_language_error")); }
  localization.select(value, app.getPreferredSystemLanguages());
  for (const state of windowStates.values()) if (!state.window.isDestroyed()) send(state.active);
  return { ok: true, data: localization.state() };
});
const windowsDictations = new Map<number, ReturnType<typeof startWindowsDictation>>();
ipcMain.handle("chat:windowsSpeech", async (event, action: unknown, language: unknown) => {
  stateOf(event);
  const id = event.sender.id;
  const current = windowsDictations.get(id);
  if (action === "cancel" || action === "stop") {
    if (!current) return;
    if (action === "cancel") {
      windowsDictations.delete(id);
      current.cancel();
      return;
    }
    current.stop();
    const text = await current.result;
    if (windowsDictations.get(id) === current) windowsDictations.delete(id);
    return text;
  }
  if (process.platform !== "win32" || (language !== "en" && language !== "ru")) return false;
  if (action !== "start" || current) return false;
  const speech = startWindowsDictation(language);
  windowsDictations.set(id, speech);
  const cancel = () => speech.cancel();
  event.sender.once("destroyed", cancel);
  void speech.result.then(() => {
    event.sender.removeListener("destroyed", cancel);
  });
  const ready = await speech.ready;
  if (!ready && windowsDictations.get(id) === speech) windowsDictations.delete(id);
  return ready;
});
ipcMain.handle("chat:transcribeVoice", async (event, samples: unknown, language: unknown) => {
  stateOf(event);
  if (!(samples instanceof Float32Array) ||
      !samples.length || samples.length > 16_000 * 125 || (language !== "en" && language !== "ru")) {
    return cliFailure("INVALID_INPUT", t("ui.invalid_voice_recording_908ead70"));
  }
  try {
    const text = await transcribeVoice(samples, language, join(app.getPath("userData"), "speech-models"));
    return { ok: true, data: text };
  } catch {
    return cliFailure("DICTATION_UNAVAILABLE", t("ui.could_not_transcribe_the_recording_the_first_use_0a91c70e"));
  }
});
ipcMain.handle("board:command", async (event, command: unknown, id: unknown, input: unknown) => {
  const state = stateOf(event);
  const args = typeof command === "string" ? commands.get(command) : undefined;
  if (!state.project || !args) return cliFailure("INVALID_INPUT", t("errors.38d774058da8c2d9"));
  if (id !== undefined && (typeof id !== "string" || !/^T-\d{4,}$/.test(id))) {
    return cliFailure("INVALID_INPUT", t("errors.348bfdc9c1444510"));
  }
  if (command === "request-changes" && typeof id === "string") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return cliFailure("INVALID_INPUT", t("errors.7eb1d9b31d77bace"));
    return launchTask(state.project, id, { input: { ...input as Record<string, unknown>, actor: "user" } });
  }
  if (command === "cleanup" && typeof id === "string") {
    const key = state.project + "\0" + id;
    if (launchingTasks.has(key) || runningTasks.has(key) || chatRuns.has(key)) {
      return cliFailure("CHAT_BUSY", t("errors.3a88847aa64c6f13"));
    }
  }
  if (command === "return-to-draft" && typeof id === "string") {
    return returnTaskToDraft(state.project, id, (input as { revision?: unknown } | null)?.revision, "user");
  }
  if (command === "show" && typeof id === "string") {
    const project = state.project;
    const result = await callCli<Task>(project, [...args, id], input);
    if (!result.ok) return result;
    return { ok: true, data: { ...result.data, executorFullAccess: executorFullAccess(app.getPath("userData"), project, result.data) } };
  }
  if (args[0] !== "git") input = { ...(input as Record<string, unknown> ?? {}), actor: "user" };
  const selection = state.selection;
  const result = await callCli<Board>(state.project, id === undefined ? args : [...args, id], input);
  if (command === "init" && result.ok && selection === state.selection && !state.window.isDestroyed()) {
    bind(state, result.data);
    state.error = undefined;
    send(state);
  }
  return result;
});

ipcMain.handle("codex:executionModels", async event => {
  const { project } = stateOf(event);
  if (!project) return cliFailure("INVALID_INPUT", t("errors.4085abbcfe2579c4"));
  try {
    return { ok: true, data: await executionModels(app.getPath("userData"), project) };
  } catch (error) {
    return cliFailure("CODEX_MODELS_UNAVAILABLE", (error as Error).message);
  }
});

ipcMain.handle("codex:taskAccess", async (event, project: unknown, id: unknown, createdAt: unknown, fullAccess: unknown) => {
  const state = stateOf(event);
  if (!state.project || project !== state.project || typeof id !== "string" || !taskIdPattern.test(id) ||
      typeof createdAt !== "string" || typeof fullAccess !== "boolean") {
    return cliFailure("INVALID_INPUT", t("errors.40dc1c7bb99bed75"));
  }
  const current = await callCli<Task>(state.project, ["show", id, "--compact"]);
  if (!current.ok) return current;
  if (stateOf(event).project !== project || current.data.createdAt !== createdAt ||
      ["done", "cancelled"].includes(current.data.status)) {
    return cliFailure("INVALID_INPUT", t("ui.reopen_the_current_task_before_changing_access_162bbf4f"));
  }
  if (executorBusy(project, id)) return cliFailure("CHAT_BUSY", t("ui.stop_the_agent_before_changing_access_0673c019"));
  return { ok: true, data: executorFullAccess(app.getPath("userData"), project, current.data, fullAccess) };
});

ipcMain.handle("board:saveAttachment", async (event, id: unknown, file: unknown, name: unknown) => {
  const state = stateOf(event);
  if (!state.project || typeof id !== "string" || !/^T-\d{4,}$/.test(id) ||
      typeof file !== "string" || typeof name !== "string") return cliFailure("INVALID_INPUT", t("errors.86ceb194927d805b"));
  const project = state.project;
  const card = await callCli<Task>(project, ["show", id, "--compact"]);
  if (!card.ok) return card;
  if (card.data.attachments.find(entry => entry.file === file)?.link) {
    const linked = await callCli<{ path: string }>(project, ["attachment", "read", id], { file });
    if (!linked.ok) return linked;
    const error = await shell.openPath(linked.data.path);
    return error ? cliFailure("ATTACHMENT_UNAVAILABLE", error) : { ok: true, data: null };
  }
  const result = await dialog.showSaveDialog(state.window, { defaultPath: basename(name.replaceAll("\\", "/")) });
  if (result.canceled || !result.filePath) return { ok: true, data: null };
  return callCli(project, ["attachment", "read", id], { file, destination: result.filePath });
});

ipcMain.handle("board:attachmentPreview", async (event, id: unknown, file: unknown) => {
  const project = stateOf(event).project;
  if (!project || typeof id !== "string" || !/^T-\d{4,}$/.test(id) || typeof file !== "string") return null;
  const result = await callCli<{ name: string; base64: string }>(project, ["attachment", "read", id], { file });
  if (!result.ok) return null;
  const type = imageTypes.get(extname(result.data.name).toLowerCase());
  return type ? "data:" + type + ";base64," + result.data.base64 : null;
});

async function taskRunImage(event: IpcMainInvokeEvent, id: unknown, path: unknown) {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id) || typeof path !== "string") return null;
  const task = await callCli<Task>(project, ["show", id]);
  if (!task.ok) return null;
  return readRunImage(project, task.data, runActivityByTask.get(project + "\0" + id) ?? [], path);
}

ipcMain.handle("board:runImagePreview", async (event, id: unknown, path: unknown) => {
  const image = await taskRunImage(event, id, path);
  return image ? "data:" + image.type + ";base64," + image.data.toString("base64") : null;
});

ipcMain.handle("board:saveRunImage", async (event, id: unknown, path: unknown) => {
  const image = await taskRunImage(event, id, path);
  if (!image) return cliFailure("IMAGE_UNAVAILABLE", t("ui.image_unavailable_f6c21e43"));
  const result = await dialog.showSaveDialog(stateOf(event).window, { defaultPath: image.name });
  if (result.canceled || !result.filePath) return { ok: true, data: null };
  try {
    await writeFile(result.filePath, image.data);
    return { ok: true, data: null };
  } catch {
    return cliFailure("STORAGE_ERROR", t("ui.could_not_save_the_image_b9361004"));
  }
});

ipcMain.handle("chat:openLink", async (_event, value: unknown) => {
  if (typeof value !== "string") return;
  const url = URL.parse(value);
  if (url && ["https:", "http:", "mailto:"].includes(url.protocol)) await shell.openExternal(url.href);
});

ipcMain.handle("board:readMarkdown", async (event, id: unknown, link: unknown, source: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof link !== "string" || (source !== undefined && typeof source !== "string") ||
      (id !== undefined && (typeof id !== "string" || !taskIdPattern.test(id)))) {
    return cliFailure("INVALID_INPUT", t("errors.0e8f1bc3cbc5c184"));
  }
  let base = project;
  if (typeof id === "string") {
    const task = await callCli<Task>(project, ["show", id]);
    if (!task.ok) return task;
    base = task.data.git?.worktree ?? project;
  }
  try {
    return { ok: true, data: await readMarkdownFile(base, link, source, project) };
  } catch (error) {
    const message = (error as Error).message === "MARKDOWN_TOO_LARGE"
      ? t("ui.the_file_exceeds_4_mib_5fc9491b")
      : t("ui.could_not_open_the_file_check_its_path_and_acces_fb6cdc80");
    return cliFailure("MARKDOWN_UNAVAILABLE", message);
  }
});

ipcMain.handle("board:openWorktree", async (event, id: unknown) => {
  const state = stateOf(event);
  if (!state.project || typeof id !== "string" || !/^T-\d{4,}$/.test(id)) return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  const result = await callCli<Task>(state.project, ["show", id]);
  if (!result.ok) return result;
  const path = result.data.git?.worktree;
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
    return cliFailure("WORKTREE_MISSING", t("errors.c13748685b56008b"));
  }
  const error = await shell.openPath(path);
  return error ? cliFailure("WORKTREE_MISSING", error) : { ok: true, data: null };
});

ipcMain.handle("board:revealArtifact", async (event, id: unknown, source: unknown, sha256: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id) ||
      typeof source !== "string" || typeof sha256 !== "string") {
    return cliFailure("INVALID_INPUT", t("errors.c378d9253d0ab224"));
  }
  const result = await callCli<Task>(project, ["show", id]);
  if (!result.ok) return result;
  const artifact = result.data.artifacts?.find(entry => entry.source === source && entry.sha256 === sha256);
  if (!artifact) return cliFailure("ARTIFACT_UNAVAILABLE", t("errors.9636a209df141e13"));
  try {
    if (!(await lstat(dirname(artifact.file))).isDirectory() || !(await lstat(artifact.file)).isFile()) {
      return cliFailure("ARTIFACT_UNAVAILABLE", t("errors.9636a209df141e13"));
    }
    shell.showItemInFolder(artifact.file);
    return { ok: true, data: null };
  } catch (error) {
    return cliFailure("ARTIFACT_UNAVAILABLE", (error as Error).message);
  }
});

const launchingTasks = new Set<string>();
const runningTasks = new Set<string>();
const runActivityByTask = new Map<string, RunActivity[]>();

function executorBusy(project: string, id: string) {
  const key = project + "\0" + id;
  return launchingTasks.has(key) || runningTasks.has(key) || chatRuns.has(key) || agentSlots.busy(project, id);
}

function publishRunActivity(project: string, id: string, items: RunActivity[],
  savedRun?: { sequence: number; items: RunActivity[]; durationMs: number }) {
  const key = project + "\0" + id;
  if (items.length) runActivityByTask.set(key, items);
  else runActivityByTask.delete(key);
  for (const state of windowStates.values()) {
    if (state.active.project === project && !state.window.isDestroyed()) {
      state.window.webContents.send("chat:update", { project, id, type: "run", items, savedRun });
    }
  }
}

function notifyRunChange(project: string) {
  const watch = subscriptions.get(project);
  if (watch) {
    for (const requests of [boardRequests, boardWorkRequests]) requests.get(projectIdentity(project))?.automationChanged?.(watch.board);
    for (const listener of watch.listeners) listener(watch.board, true);
    scheduleAutoReview(watch);
  }
  for (const state of windowStates.values()) {
    if (state.tabs.some(tab => tab.project === project)) send(state.active);
  }
}

async function recordRunFailure(project: string, id: string, reason: string, condition?: string, revision?: number) {
  const result = await callCli<Task>(project, ["block", id], {
    reason,
    revision,
    condition: condition ?? t("ui.resolve_the_reported_issue_and_resume_the_task_2b49bf6d"),
  });
  if (!result.ok && result.error.code !== "INVALID_TRANSITION" && result.error.code !== "REVISION_CONFLICT") return result.error.message;
}

type LaunchState = Pick<Task, "acceptanceRepair" | "id" | "title" | "status" | "revision" | "createdAt" | "codexThreadId" | "blocked" | "summary" | "nextStep"> & { mergeRepair?: true };

async function launchTask(project: string, id: string, revisionRequest?: { input: Record<string, unknown> },
  newThread: false | "user" | "manager" = false, revision?: number,
  continuation: ExecutorContinuation = {}, scheduled = false, resolveConflicts = false, resumeWithFullAccess = false, autoMode = false, manual = false, autoQueueRevision?: number): Promise<CliReply<LaunchState>> {
  if (isManual(readBoardSettings(runtimeLocation(project)))) return cliFailure("MANUAL_BOARD", "На обычной доске исполнители недоступны.");
  const key = project + "\0" + id;
  if (returningDrafts.has(key)) return cliFailure("CHAT_BUSY", "This task is being returned to draft.");
  if (launchingTasks.has(key)) return cliFailure("LAUNCH_IN_PROGRESS", t("errors.07f5f719b5d5f6c5"));
  if (executorBusy(project, id)) return cliFailure("CHAT_BUSY", t("ui.wait_for_the_chat_reply_or_stop_the_agent_first_22c53959"));
  if (closingProjects.has(project)) return cliFailure("PROJECT_CLOSING", t("ui.the_project_is_closing_beb637fb"));
  const operation = beginOperation(project, t("ui.executor_92197b27") + " · " + id);
  const signal = operation.controller.signal;
  launchingTasks.add(key);
  taskOperations.set(key, operation);
  void operation.done.then(() => {
    if (taskOperations.get(key) === operation) taskOperations.delete(key);
  });
  const activity = new Map<string, RunActivity>();
  const runStarted = performance.now();
  let prepared = false;
  let monitoring = false;
  let release: (() => void) | undefined;
  let updateTimer: NodeJS.Timeout | undefined;
  const publish = () => {
    updateTimer = undefined;
    publishRunActivity(project, id, runLog(activity));
  };
  const saveActivity = async () => {
    clearTimeout(updateTimer);
    if (prepared && signal.aborted) {
      activity.set("project-closed", {
        id: "project-closed", type: "error", status: "interrupted", title: "",
        text: t("ui.the_project_was_closed_ef8bc05a"),
      });
    }
    const items = runLog(activity);
    if (!items.length) return;
    const durationMs = Math.round(performance.now() - runStarted);
    const saved = await callCli<{ runLogSequence?: number }>(project, ["run-log", id, "--compact"], { entries: items, durationMs });
    if (saved.ok) {
      const sequence = saved.data.runLogSequence;
      publishRunActivity(project, id, [], sequence === undefined ? undefined : { sequence, items, durationMs });
    }
    else publishRunActivity(project, id, [
      { id: "save-error", type: "error", title: "", text: saved.error.message, status: "failed" },
    ]);
  };
  try {
    const known = !revisionRequest && !newThread && revision !== undefined
      ? subscriptions.get(project)?.board.tasks.find(task => task.id === id && task.revision === revision &&
        (task.status === "ready" || task.status === "in_progress"))
      : undefined;
    let current: CliReply<LaunchState> = revisionRequest
      ? await callCli<LaunchState>(project, ["request-changes", id, "--compact"], { ...revisionRequest.input, launchDetails: true })
      : known ? { ok: true, data: known }
        : await callCli<LaunchState>(project, ["show", id, "--compact"], { launchDetails: true });
    if (!current.ok) return current;
    if (current.data.acceptanceRepair) return cliFailure("ACCEPTANCE_PENDING", "The board manager handles this pending acceptance in its existing context.");
    prepared = Boolean(revisionRequest);
    const role = current.data.mergeRepair || (resolveConflicts && current.data.status === "review") ? "reviewer" : "executor";
    const releaseSlot = reserveAgent(project, role, id);
    release = releaseSlot;
    if (!releaseSlot) {
      if (!revisionRequest) return taskRunLimit(role);
      deferredExecutors.set(key, { project, id, revision: current.data.revision });
      agentSlots.defer(project, id, { revision: current.data.revision });
      scheduleAgentWork();
      return current;
    }
    deferredExecutors.delete(key);
    agentSlots.defer(project, id);
    const client = await configuredCodex(app.getPath("userData"));
    if (!client) {
      const reason = t("ui.choose_the_codex_executable_in_settings_06a08a7e");
      if (prepared) throw new Error(reason);
      return cliFailure("CODEX_UNAVAILABLE", reason);
    }
    if (newThread) {
      if (revision !== undefined && current.data.revision !== revision) {
        return cliFailure("REVISION_CONFLICT", t("ui.the_task_changed_read_the_current_revision_befor_1dce8f11"));
      }
      if (current.data.status !== "blocked" || !current.data.codexThreadId ||
          !/already has an active writer/i.test(current.data.blocked?.reason ?? "")) {
        return cliFailure("INVALID_INPUT", t("ui.a_new_chat_is_available_when_the_task_is_blocked_d4f5f684"));
      }
      if (newThread === "manager") {
        const previous = current.data.codexThreadId;
        let safeToReplace = false;
        try {
          const turn = await readLastTaskTurn(app.getPath("userData"), project, previous, signal);
          // A fresh App Server can label an unfinished turn from another process as interrupted.
          safeToReplace = Boolean(turn && Number.isFinite(turn.completedAt) &&
            ["completed", "interrupted", "failed"].includes(turn.status));
        } catch (error) {
          if (!missingCodexThread((error as Error).message, previous)) {
            return cliFailure("CODEX_THREAD_STATUS_UNAVAILABLE", (error as Error).message);
          }
          safeToReplace = true;
        }
        if (!safeToReplace) {
          return cliFailure("CODEX_TURN_UNFINISHED", t("ui.the_last_turn_in_the_previous_chat_has_no_record_76facfac"));
        }
      }
    }
    const missingThread = current.data.status === "blocked" &&
      missingCodexThread(current.data.blocked?.reason, current.data.codexThreadId);
    if (resumeWithFullAccess && (current.data.status !== "blocked" ||
        !executorFullAccess(app.getPath("userData"), project, current.data))) {
      return cliFailure("INVALID_INPUT", t("ui.choose_full_access_in_the_blocked_task_before_co_976e5686"));
    }
    signal.throwIfAborted();
    if (newThread || missingThread || resumeWithFullAccess) {
      current = await callCli<LaunchState>(project, ["resume", id, "--compact"], {
        launchDetails: true, actor: manual ? "user" : "agent",
        revision: revision ?? current.data.revision,
        reason: resumeWithFullAccess
          ? t("ui.the_user_continued_the_task_with_full_access_22faf317")
          : missingThread
          ? t("ui.retrying_after_codex_could_not_find_the_saved_ch_893b7408")
          : newThread === "manager"
            ? t("ui.the_project_manager_requested_continuation_in_a__121b1302")
            : t("ui.the_user_chose_to_continue_in_a_new_codex_chat_3484ac0c"),
      });
      if (!current.ok) return current;
      revision = current.data.revision;
      prepared = true;
    }
    signal.throwIfAborted();
    const started = await callCli<{ task: LaunchState & ExecutorTask } & ({ worktree: string } | { cwd: string })>(project, ["start", id, "--compact"],
      { revision: revision ?? current.data.revision, actor: manual ? "user" : "agent", launchDetails: true, ...(scheduled ? { scheduled } : {}),
        ...(autoMode ? { autoMode: true, autoQueueRevision } : {}),
        ...(resolveConflicts ? { resolveConflicts } : {}),
        ...(process.platform === "win32" && client.windowsSandbox === "elevated" ? { isolatedWorktree: true } : {}) });
    if (!started.ok) {
      if (prepared && started.error.code !== "BOARD_BUSY") throw new Error(started.error.message);
      return started;
    }
    prepared = true;
    signal.throwIfAborted();
    const desktopProfile = app.getPath("userData");
    const task = { ...started.data.task, fullAccess: executorFullAccess(desktopProfile, project, started.data.task),
      ...(newThread ? { codexThreadId: undefined } : {}) };
    let linked: LaunchState = started.data.task;
    const cwd = "cwd" in started.data ? started.data.cwd : started.data.worktree;
    const run = await releaseSlot.run(() => startCodexRun(client, project, cwd, task, item => {
      activity.set(item.id, item);
      updateTimer ??= setTimeout(publish, 80);
    }, report => saveTaskTokenUsage(project, id, role, report), signal, async codexThreadId => {
      if (linked.codexThreadId === codexThreadId) return;
      const previousCodexThreadId = linked.codexThreadId;
      // Preserve edits made while Codex was starting and link the chat before it can run.
      const saved = await callCli<LaunchState>(project, ["update", id, "--compact"], {
        codexThreadId, actor: "user", launchDetails: true,
        ...(previousCodexThreadId ? { previousCodexThreadId,
          note: (newThread ? t("ui.continued_in_a_new_chat_previous_chat_6e40fb2d") :
            t("ui.codex_could_not_find_the_previous_chat_continued_726501de")) +
            "`" + previousCodexThreadId + "`" } : {}),
      });
      if (!saved.ok) throw Object.assign(new Error(saved.error.message), {
        code: saved.error.code === "BOARD_BUSY" ? "BOARD_BUSY" : "CODEX_LINK_FAILED",
      });
      linked = saved.data;
    }, desktopProfile));
    const { threadId: codexThreadId, completion } = run;
    const directories = new Set<string>();
    let stopRequested = false;
    activeAgents.set(key, { control: { ...run, interrupt: () => {
      stopRequested = true;
      return run.interrupt();
    } }, directories });
    monitoring = true;
    runningTasks.add(key);
    notifyRunChange(project);
    let retry: { revision: number; reason: string; continuation: ExecutorContinuation } | undefined;
    void completion.then(async outcome => {
      const reason = outcome?.reason;
      const items = [...activity.values()];
      // Some tool rejections reach the agent's reply but do not fail the App Server turn.
      const detail = items.findLast(item => item.type === "agentMessage" && item.status === "completed" && item.text.trim())?.text
        ?? items.findLast(item => item.type === "commandExecution" && ["failed", "declined"].includes(item.status))?.text;
      const incomplete = t("ui.the_executor_ended_the_turn_without_submitting_o_257660c6");
      const rejected = items.findLast(item => item.type === "autoApprovalReview" && ["denied", "timedOut"].includes(item.status));
      const timedOut = rejected?.status === "timedOut";
      const reviewOutcome = timedOut ? t("ui.access_review_timed_out_f75f5c3b") :
        t("ui.access_denied_by_auto_review_31f82227");
      const reconnect = outcome?.disconnected && !continuation.afterDisconnect;
      const accessGranted = !task.fullAccess && !signal.aborted && !stopRequested && executorFullAccess(desktopProfile, project, task);
      let unfinishedRevision: number | undefined;
      if ((accessGranted || reconnect || (!outcome && !task.schedule)) && !signal.aborted && !stopRequested && (!rejected || accessGranted)) {
        const current = await callCli<LaunchState>(project, ["show", id, "--compact"], { launchDetails: true });
        if (current.ok) {
          if (current.data.status === "review" && current.data.acceptanceRepair?.phase === "running" && current.data.codexThreadId === codexThreadId) {
            await callCli(project, ["accept", id], { revision: current.data.revision, repairFailure: reason ?? detail ?? incomplete });
            await saveActivity();
            return;
          }
          if (current.data.status !== "in_progress" || current.data.codexThreadId !== codexThreadId) {
            await saveActivity();
            return;
          }
          unfinishedRevision = current.data.revision;
          const progressed = current.data.summary !== task.summary || current.data.nextStep !== task.nextStep;
          if (!stopRequested && !signal.aborted && (accessGranted || reconnect || progressed || !continuation.withoutProgress)) {
            const nextContinuation = accessGranted ? {} : reconnect
              ? { ...continuation, afterDisconnect: true } : { withoutProgress: !progressed };
            retry = { revision: unfinishedRevision, continuation: nextContinuation,
              reason: accessGranted ? t("ui.continuing_with_access_granted_by_the_board_2a1188f9") : reason ?? incomplete };
          }
        }
        if (retry && reconnect && !accessGranted) {
          activity.set("connection-lost", {
            id: "connection-lost", type: "error", status: "failed", title: "",
            text: t("ui.the_codex_connection_closed_the_board_will_try_t_29d2f180"),
          });
        }
      }
      if (outcome?.interrupted && !accessGranted && !signal.aborted && !stopRequested && !rejected) {
        activity.set("codex-interrupted", {
          id: "codex-interrupted", type: "error", status: "interrupted", title: "",
          text: t("ui.codex_interrupted_the_run_f6f244bf") + "\n\n" + outcome.reason,
        });
      }
      await saveActivity();
      if (retry || signal.aborted || returningDrafts.has(key) || (outcome?.interrupted && !stopRequested && !rejected)) return;
      if (task.schedule && !outcome && !stopRequested && !rejected) {
        const current = await callCli<LaunchState>(project, ["show", id, "--compact"], { launchDetails: true });
        if (current.ok && current.data.status === "in_progress" && current.data.codexThreadId === codexThreadId) {
          const result = await callCli(project, ["progress", id, "--compact"], {
            revision: current.data.revision, nextStep: "",
            summary: detail?.trim().slice(0, 2000) || t("ui.scheduled_run_completed_ee52171e"),
          });
          if (!result.ok && !["INVALID_TRANSITION", "REVISION_CONFLICT"].includes(result.error.code)) {
            publishRunActivity(project, id, [{ id: "schedule-error", type: "error", title: "", text: result.error.message, status: "failed" }]);
          }
        }
        return;
      }
      const condition = stopRequested ? t("ui.resume_the_task_to_continue_the_interrupted_run_f31481d2") : rejected && (timedOut ? t("ui.resume_the_task_to_retry_the_access_review_388c6653") :
        t("ui.provide_the_required_resource_in_an_allowed_loca_15b60720"));
      const summary = detail?.trim().slice(0, 2000);
      const diagnostic = stopRequested ? t("ui.the_user_stopped_the_agent_b9949d62") : rejected ? [
        [reviewOutcome, rejected.title.slice(0, 1000)].filter(Boolean).join(" — "), rejected.text.slice(0, 1500), reason, summary,
      ].filter(Boolean).join("\n\n") : reason ?? [incomplete, summary].filter(Boolean).join("\n\n");
      const failure = await recordRunFailure(project, id, diagnostic, condition, unfinishedRevision);
      if (failure) publishRunActivity(project, id, [
        { id: "block-error", type: "error", title: "", text: failure, status: "failed" },
      ]);
    }).finally(async () => {
      activeAgents.delete(key);
      for (const directory of directories) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      runningTasks.delete(key);
      launchingTasks.delete(key);
      releaseSlot();
      try {
        if (retry && !signal.aborted && !stopRequested && !closingProjects.has(project)) {
          const resumed = await launchTask(project, id, undefined, false, retry.revision, retry.continuation);
          if (!signal.aborted && !resumed.ok) {
            if (["EXECUTOR_LIMIT", "REVIEWER_LIMIT"].includes(resumed.error.code) && subscriptions.has(project)) {
              deferredExecutors.set(key, { project, id, revision: retry.revision, continuation: retry.continuation });
              agentSlots.defer(project, id, retry);
              scheduleAgentWork();
            } else if (!["REVISION_CONFLICT", "CHAT_BUSY", "LAUNCH_IN_PROGRESS", "BOARD_BUSY", "EXECUTOR_LIMIT", "REVIEWER_LIMIT"].includes(resumed.error.code)) {
              await recordRunFailure(project, id, retry.reason + "\n\n" + resumed.error.message, undefined, retry.revision);
            }
          }
        } else if (retry && !signal.aborted && !returningDrafts.has(key)) {
          const reason = stopRequested ? t("ui.the_user_stopped_the_agent_b9949d62") :
            retry.reason;
          await recordRunFailure(project, id, reason, undefined, retry.revision);
        }
      } finally {
        notifyRunChange(project);
        operation.finish();
      }
    });
    return { ok: true, data: linked };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "BOARD_BUSY") return cliFailure(code, (error as Error).message);
    const busy = code === "CODEX_THREAD_BUSY";
    const reason = busy ? t("ui.this_codex_chat_is_already_open_in_another_proce_9d6a0201") + "\n\n" + (error as Error).message : (error as Error).message;
    await saveActivity();
    const condition = busy ? t("ui.continue_in_the_existing_chat_or_stop_work_there_635dd251") : undefined;
    const failure = prepared && !signal.aborted ? await recordRunFailure(project, id, reason, condition) : undefined;
    // The feedback was saved even when starting its follow-up run failed.
    if (revisionRequest && prepared && !failure) return callCli<LaunchState>(project, ["show", id, "--compact"], { launchDetails: true });
    return cliFailure(code === "CODEX_THREAD_BUSY" || code === "CODEX_LINK_FAILED" ? code : "CODEX_LAUNCH_FAILED",
      [reason, failure].filter(Boolean).join("\n"));
  } finally {
    if (!monitoring) {
      launchingTasks.delete(key);
      release?.();
      notifyRunChange(project);
      operation.finish();
    }
  }
}

ipcMain.handle("board:launchTask", async (event, id: unknown, options: unknown = {}) => {
  const { project, window } = stateOf(event);
  const input = options as { newThread?: unknown; resumeWithFullAccess?: unknown } | null;
  if (!project || typeof id !== "string" || !taskIdPattern.test(id) || !input || typeof input !== "object" ||
      (input.newThread !== undefined && typeof input.newThread !== "boolean") ||
      (input.resumeWithFullAccess !== undefined && typeof input.resumeWithFullAccess !== "boolean") ||
      (input.newThread && input.resumeWithFullAccess)) {
    return cliFailure("INVALID_INPUT", t("errors.f6cce3ef8b13aaf9"));
  }
  if (input.newThread) {
    const current = await callCli<LaunchState>(project, ["show", id, "--compact"], { launchDetails: true });
    if (!current.ok) return current;
    if (current.data.status !== "blocked" || !current.data.codexThreadId ||
        !/already has an active writer/i.test(current.data.blocked?.reason ?? "")) {
      return cliFailure("INVALID_INPUT", t("ui.reopen_the_current_task_before_retrying_d2ee7142"));
    }
    const choice = await dialog.showMessageBox(window, {
      type: "question", title: "AI Taskboard",
      message: t("ui.continue_in_a_new_codex_chat_d36dfa6d"),
      detail: t("ui.stop_any_work_in_the_previous_chat_first_the_new_671b34f1"),
      buttons: [t("ui.cancel_4c6dcc32"), t("ui.continue_in_a_new_chat_7364ce62")],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (choice.response !== 1) return { ok: true, data: null };
  }
  return launchTask(project, id, undefined, input.newThread ? "user" : false, undefined, undefined, false, false, input.resumeWithFullAccess === true, false, true);
});

const readProviderLimits = providerLimitSource(() => readCodexLimits(app.getPath("userData")));
function resetProviderLimits() {
  readProviderLimits.invalidate();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("providers:changed");
}
ipcMain.handle("providers:limits", event => { stateOf(event); return readProviderLimits(); });
ipcMain.handle("codex:status", event => {
  stateOf(event);
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:managerAccess", (event, project: unknown, mode: unknown) => {
  const state = stateOf(event);
  if (!state.project || project !== state.project || !isManagerAccess(mode)) {
    return cliFailure("INVALID_INPUT", t("errors.0d4392c03d4c38ec"));
  }
  const selected = managerAccess(app.getPath("userData"), state.project, mode);
  for (const window of windowStates.values()) {
    if (window.active.project === state.project) send(window.active);
  }
  return { ok: true as const, data: selected };
});
ipcMain.handle("codex:choose", async event => {
  const state = stateOf(event);
  const choice = await dialog.showOpenDialog(state.window, {
    title: t("ui.choose_the_codex_executable_3324a3c6"),
    properties: ["openFile"],
    ...(process.platform === "win32" ? { filters: [{ name: "Codex", extensions: ["exe"] }] } : {}),
  });
  if (!choice.canceled && choice.filePaths[0]) {
    setCodexExecutable(app.getPath("userData"), choice.filePaths[0]);
    resetProviderLimits();
  }
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:auto", event => {
  stateOf(event);
  setCodexExecutable(app.getPath("userData"));
  resetProviderLimits();
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:windowsSandbox", (event, mode: unknown) => {
  stateOf(event);
  const profile = app.getPath("userData");
  setCodexWindowsSandbox(profile, mode);
  return codexStatus(profile);
});
app.setName("AI Taskboard");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const state = [...windowStates.values()][0];
    if (state) {
      if (state.window.isMinimized()) state.window.restore();
      state.window.focus();
    } else if (app.isReady()) createWindow();
  });
  void app.whenReady().then(() => {
    if (process.platform === "win32") app.setAppUserModelId("org.aitaskboard.desktop");
    const trustedFrame = (id: number | undefined, url: string | undefined, mainFrame: boolean) =>
      id !== undefined && windowStates.has(id) && mainFrame && url === html.href;
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
      trustedFrame(contents?.id, details.requestingUrl ?? contents?.getURL(), details.isMainFrame) &&
      (permission === "clipboard-sanitized-write" || (permission === "media" && details.mediaType === "audio")));
    session.defaultSession.setPermissionRequestHandler((contents, permission, respond, details) => {
      respond(trustedFrame(contents.id, details.requestingUrl ?? contents.getURL(), details.isMainFrame) &&
        (permission === "clipboard-sanitized-write" || (permission === "media" && "mediaTypes" in details &&
          details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio")));
    });
    const markdownSource = createRequire(import.meta.url).resolve("markdown-it/browser");
    protocol.handle("taskboard-assets", request => request.url === markdownAsset
      ? new Response(readFileSync(markdownSource, "utf8"), { headers: { "Content-Type": "text/javascript; charset=utf-8" } })
      : new Response(null, { status: 404 }));
    localization.select("system", app.getPreferredSystemLanguages());
    loadTheme();
    try {
      const limits = parseAgentLimits(readJson(join(app.getPath("userData"), "task-limits.json")));
      if (limits) agentSlots.configure(limits);
    } catch {
      // The application defaults also cover a missing or unreadable preference.
    }
    loadRecentBoards();
    Menu.setApplicationMenu(null);
    setInterval(scheduleRecurringTasks, 10_000).unref();
    // Runtime changes do not change card revisions. Poll as a fallback across
    // profiles and after owner death, then wake the ordinary queues.
    setInterval(() => {
      for (const watch of subscriptions.values()) {
        const project = watch.board.project;
        try {
          const entries = agentSlots.entries(project);
          const context = entries.find(entry => entry.task === "manager:context");
          const background = entries.find(entry => entry.task === "manager:background");
          const live = context?.owner !== process.pid ? context?.state?.live : undefined;
          const backgroundLive = background?.owner !== process.pid ? background?.state?.live : undefined;
          const stamp = (name: string) => statSync(join(project, ".tasks", name), { throwIfNoEntry: false })?.mtimeMs ?? 0;
          const previous = watch.shared;
          const next = watch.shared = {
            runtime: JSON.stringify(entries, (key, value) => key === "live" ? undefined : value),
            context: context?.id,
            activity: [live && context!.id + ":" + live.sequence,
              backgroundLive && background!.id + ":" + backgroundLive.sequence].join("|"),
            queue: stamp("manager-queue"),
            history: stamp("manager-chat"),
            unread: stamp("manager-unread.json"),
          };
          if (previous?.runtime !== next.runtime) {
            notifyRunChange(project);
          } else if (previous?.unread !== next.unread) {
            publishManagerUnread(project);
          }
          if (previous?.history !== next.history || (previous?.context && previous.context !== next.context)) {
            broadcastBoardChat(project, "orchestrator-history");
            broadcastBoardChat(project, "orchestrator-work-history");
          }
          if (previous?.activity !== next.activity) {
            if (live && context?.state?.lane === "chat") {
              broadcastBoardChat(project, "orchestrator", { items: managerChatItems(live.items) });
            }
            broadcastBoardChat(project, "orchestrator-work-activity");
          }
          if (previous?.queue !== next.queue) {
            broadcastBoardChat(project, "orchestrator-queue");
          }
        } catch (error) { console.error(error); }
      }
      scheduleAgentWork();
    }, 1000).unref();
    if (customTitleBar) {
      nativeTheme.on("updated", () => {
        for (const { window } of windowStates.values()) {
          if (!window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay());
        }
      });
    }
    const option = process.argv.indexOf("--project");
    if (option !== -1 && process.argv[option + 1]) createWindow([process.argv[option + 1]]);
    else {
      let saved = [] as ReturnType<typeof savedWindows>;
      try { saved = savedWindows(readJson(join(app.getPath("userData"), "project-tabs.json"))); } catch {}
      // Open all saved windows before asynchronous board loading starts saving snapshots.
      restoringSession = true;
      const restored = saved.map(state => createWindow(state.projects, state.active));
      if (!saved.length) restored.push(createWindow());
      void Promise.all(restored.map(state => state.ready)).finally(() => {
        restoringSession = false;
        saveSession();
      });
    }
    app.on("activate", () => { if (!windowStates.size) createWindow(); });
  });
  let quitPending = false;
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    void (async () => {
      for (const state of windowStates.values()) {
        if (state.closing || !await confirmProjectClose(state, state.tabs)) return;
      }
      saveSession();
      quitting = true;
      app.quit();
    })().finally(() => { quitPending = false; });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
