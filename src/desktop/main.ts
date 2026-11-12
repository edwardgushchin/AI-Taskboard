import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { bundled, callCli, cliChild, cliFailure, entry } from "./cli.ts";
import { codexStatus, composeDraft, installCodex, setCodexExecutable, skillLaunch } from "./codex.ts";
import { chatModels, replyToTask } from "./codex-chat.ts";
import { taskChatActions } from "./chat-actions.ts";
import type { CodexStatus } from "./codex.ts";
import type { CliReply } from "./cli.ts";
import { executionModels } from "./codex-models.ts";
import type { ArchiveLink, BoardSettings, BoardTag, RunActivity, Task } from "../cli/model.ts";
import { codexThreadPattern, maxAttachmentBytes, taskIdPattern } from "../cli/model.ts";
import { readJson, writeJson } from "../cli/storage.ts";
import { configuredCodex } from "./codex.ts";
import { startCodexRun } from "./codex-run.ts";
import { runLog } from "./run-activity.ts";
import { normalizeRecentBoards, readRecentBoards, rememberRecentBoard } from "./recent-boards.ts";

interface Board {
  project: string;
  settings: BoardSettings;
  tags: BoardTag[];
  tasks: Task[];
  archived: (ArchiveLink & { id: string })[];
}

interface WindowState {
  window: BrowserWindow;
  project?: string;
  board?: Board;
  error?: { code: string; message: string };
  loading?: boolean;
  drafting?: boolean;
  selection: number;
}

interface BoardWatch {
  windows: Set<WindowState>;
  board: Board;
  stop: () => void;
}

const html = new URL("./index.html", import.meta.url);
const markdownAsset = "taskboard-assets://vendor/markdown-it.js";
protocol.registerSchemesAsPrivileged([{ scheme: "taskboard-assets", privileges: { standard: true, secure: true } }]);
const customTitleBar = process.platform === "win32";
const titleBarHeight = 36;
const windowStates = new Map<number, WindowState>();
const subscriptions = new Map<string, BoardWatch>();
const commands = new Map<string, string[]>([
  ["init", ["init"]], ["list", ["list"]], ["show", ["show"]], ["update", ["update"]],
  ["comment", ["comment"]],
  ["approve", ["approve"]], ["review", ["review"]], ["accept", ["accept"]],
  ["return-to-draft", ["return-to-draft"]],
  ["restore-changes", ["restore-changes"]],
  ["attachment-cover", ["attachment", "cover"]],
  ["request-changes", ["request-changes"]], ["cancel", ["cancel"]], ["cleanup", ["cleanup"]],
  ["settings", ["settings"]], ["archive", ["archive", "sweep"]], ["doctor", ["doctor"]],
  ["tag-color", ["tag", "set"]],
  ["tag-create", ["tag", "ensure"]],
]);

let russian = false;
const lang = (english: string, translated: string) => russian ? translated : english;
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

function rememberBoard(path: string, current: WindowState): void {
  try {
    recentBoards = rememberRecentBoard(app.getPath("appData"), app.getPath("userData"), path);
  } catch {
    recentBoards = normalizeRecentBoards([path, ...recentBoards]);
  }
  for (const state of windowStates.values()) {
    if (state !== current) send(state);
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
    const preference = readJson(join(app.getPath("userData"), "appearance.json")) as { theme?: unknown };
    if (isTheme(preference?.theme)) theme = preference.theme;
  } catch {
    // A missing or unreadable preference falls back to the system setting.
  }
  nativeTheme.themeSource = themes[theme][1];
}

function stateOf(event: IpcMainInvokeEvent): WindowState {
  const state = windowStates.get(event.sender.id);
  if (!state || !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== html.href) {
    throw new Error("Unexpected application frame.");
  }
  return state;
}

function frame(state: WindowState) {
  return {
    project: state.project, board: state.board, error: state.error, loading: state.loading, russian, theme,
    runningTasks: state.board?.tasks.filter(task => runningTasks.has(state.project + "\0" + task.id)).map(task => task.id),
    runActivity: Object.fromEntries(state.board?.tasks.flatMap(task => {
      const log = runActivityByTask.get(state.project + "\0" + task.id);
      return log ? [[task.id, log]] : [];
    }) ?? []),
    recentBoards: recentBoards.map(path => ({ name: basename(path) || path, path })),
  };
}

function send(state: WindowState): void {
  if (!state.window.isDestroyed()) {
    state.window.webContents.send("board:changed", frame(state));
    state.window.setTitle(state.project ? basename(state.project) + " · AI Taskboard" : "AI Taskboard");
  }
}

function unbind(state: WindowState): void {
  if (!state.board) return;
  const project = state.board.project;
  const watch = subscriptions.get(project);
  watch?.windows.delete(state);
  if (watch && !watch.windows.size) {
    watch.stop();
    subscriptions.delete(project);
  }
}

function subscribe(project: string, board: Board): BoardWatch {
  const windows = new Set<WindowState>();
  let child: ReturnType<typeof cliChild> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let startedArchiveSweep = false;
  const watch: BoardWatch = {
    windows, board,
    stop: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearInterval(sweep);
      child?.kill();
    },
  };
  const archive = () => { void callCli(project, ["archive", "sweep"]); };
  const sweep = setInterval(archive, 24 * 60 * 60 * 1000);
  const launch = () => {
    if (stopped) return;
    const active = cliChild(project, ["watch"]);
    child = active;
    const lines = createInterface({ input: active.stdout });
    active.stderr.resume();
    lines.on("line", line => {
      if (stopped) return;
      let result: CliReply<Board>;
      try { result = JSON.parse(line); }
      catch { result = cliFailure("CLI_UNAVAILABLE", "The CLI returned an invalid board snapshot."); }
      if (result.ok) watch.board = result.data;
      for (const state of windows) {
        if (result.ok) state.board = result.data;
        state.error = result.ok ? undefined : result.error;
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
      for (const state of windows) {
        state.error = { code: "WATCH_STOPPED", message: lang("Updates paused. Reconnecting…", "Обновления приостановлены. Переподключение…") };
        send(state);
      }
      retry = setTimeout(launch, 1500);
    });
  };
  launch();
  return watch;
}

function bind(state: WindowState, board: Board): void {
  if (state.board?.project !== board.project) unbind(state);
  state.project = board.project;
  let watch = subscriptions.get(board.project);
  if (!watch) {
    watch = subscribe(board.project, board);
    subscriptions.set(board.project, watch);
  }
  watch.windows.add(state);
  state.board = watch.board;
  rememberBoard(board.project, state);
}

async function openProject(state: WindowState, project: string, create = false): Promise<void> {
  const selection = ++state.selection;
  unbind(state);
  state.project = project;
  state.board = undefined;
  state.error = undefined;
  state.loading = true;
  send(state);
  const result = existsSync(project) ? await callCli<Board>(project, [create ? "init" : "list"], create ? { git: true } : undefined)
    : cliFailure("PROJECT_UNAVAILABLE", lang("The folder is unavailable.", "Папка недоступна."));
  if (state.selection !== selection || state.window.isDestroyed()) return;
  state.loading = false;
  if (result.ok) bind(state, result.data);
  else state.error = result.error;
  send(state);
}

async function pickProject(state: WindowState, create = false): Promise<void> {
  const result = await dialog.showOpenDialog(state.window, {
    title: create ? lang("Create board", "Создать доску") : lang("Open existing board", "Открыть существующую доску"),
    defaultPath: state.project && existsSync(state.project) ? state.project : undefined,
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths[0] && !state.window.isDestroyed()) {
    await openProject(state, result.filePaths[0], create);
  }
}

function createWindow(initial?: string): WindowState {
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
  const state: WindowState = { window, selection: 0 };
  windowStates.set(id, state);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.once("closed", () => {
    unbind(state);
    windowStates.delete(id);
  });
  void window.loadFile(fileURLToPath(html)).then(() => {
    if (initial) void openProject(state, initial);
  });
  return state;
}

const menuActions: Record<string, (state: WindowState) => unknown> = {
  "new-window": () => createWindow(),
  "open-project": pickProject,
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
    detail: lang("A local task board for software projects.", "Локальная доска задач для программных проектов."),
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
ipcMain.handle("board:open", async event => pickProject(stateOf(event)));

interface PastedFile {
  name: string;
  type: string;
  bytes: ArrayBuffer;
}

function isPastedFile(file: unknown): file is PastedFile {
  if (!file || typeof file !== "object") return false;
  const { name, type, bytes } = file as Partial<PastedFile>;
  return typeof name === "string" && Boolean(name.trim()) && typeof type === "string" && bytes instanceof ArrayBuffer;
}

const imageExtensions = new Map([
  ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/webp", ".webp"], ["image/gif", ".gif"],
]);
const imageTypes = new Map([...imageExtensions].map(([type, suffix]) => [suffix, type]));
imageTypes.set(".jpeg", "image/jpeg");
const chatRuns = new Set<string>();

ipcMain.handle("chat:models", async event => {
  const project = stateOf(event).board?.project;
  if (!project) return cliFailure("BOARD_NOT_FOUND", "Open a board first.");
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

type ChatUpdate = { type: "saved" | "changed" } | { type: "commentary"; text: string };

async function sendChat(project: string, id: string, request: ChatRequest, notify: (update: ChatUpdate) => void) {
  const key = project + "\0" + id;
  if (chatRuns.has(key)) {
    return { saved: false, result: cliFailure("CHAT_BUSY", lang("The agent is already replying to this task.", "Агент уже отвечает в этой задаче.")) };
  }
  chatRuns.add(key);
  let scratch: string | undefined;
  let saved = request.retryAt !== undefined;
  try {
    const { model, effort, text, files, retryAt } = request;
    scratch = await mkdtemp(join(tmpdir(), "ai-taskboard-chat-"));
    let reply: CliReply<Task>;
    if (retryAt === undefined) {
      const sources = [];
      for (const [index, file] of files.entries()) {
        const path = join(scratch, "upload-" + index);
        const suffix = imageExtensions.get(file.type);
        const name = file.name.trim();
        await writeFile(path, Buffer.from(file.bytes));
        sources.push({ path, name: suffix && !imageTypes.has(extname(name).toLowerCase()) ? name + suffix : name });
      }
      reply = await callCli<Task>(project, ["chat", id], { text, model, effort, attachmentSources: sources });
      saved = reply.ok;
      if (saved) notify({ type: "saved" });
    } else {
      reply = await callCli<Task>(project, ["show", id]);
    }
    if (!reply.ok) return { saved, result: reply };
    const task = reply.data;
    const last = task.history.findLastIndex(entry => entry.chat);
    const message = task.history[last];
    if (["done", "cancelled"].includes(task.status) || message?.actor !== "user" ||
        (retryAt !== undefined && last !== retryAt)) {
      return { saved, result: cliFailure("CHAT_CHANGED", lang("This message is no longer awaiting a reply.", "Это сообщение больше не ожидает ответа.")) };
    }
    const activeFiles = new Set(message.chat?.files);
    const images = [];
    const attachments = [];
    for (const [index, file] of task.attachments.entries()) {
      let path = join(project, ".tasks", "attachments", id, file.file);
      if (activeFiles.has(file.file)) {
        const extension = extname(file.name).toLowerCase();
        const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
        path = join(scratch, "attachment-" + index + safeExtension);
        const copy = await callCli(project, ["attachment", "read", id], { file: file.file, destination: path });
        if (!copy.ok) return { saved, result: copy };
        if (imageTypes.has(safeExtension)) images.push(path);
      }
      attachments.push({ id: file.file, name: file.name, path });
    }
    const prompt = JSON.stringify({
      task: { id, title: task.title, status: task.status, description: task.description,
        criteria: task.criteria, openQuestions: task.questions, tags: task.tags, priority: task.priority,
        subtasks: task.subtasks, dependencies: task.dependencies, summary: task.summary, nextStep: task.nextStep },
      history: task.history.slice(0, last).map(event => ({
        actor: event.actor, action: event.action, text: event.text, from: event.from, to: event.to, files: event.chat?.files,
      })),
      subsequentEvents: task.history.slice(last + 1),
      attachments,
      latestUserMessage: { text: message.text ?? "", files: message.chat?.files ?? [] },
    });
    const answer = await replyToTask(app.getPath("userData"), project, { model, effort }, prompt, images,
      text => notify({ type: "commentary", text }),
      taskChatActions(project, task, message.text ?? "", () => notify({ type: "changed" })),
      scratch, maxAttachmentBytes - task.attachments.reduce((sum, file) => sum + file.bytes, 0));
    const result = await callCli<Task>(project, ["chat", id], { ...answer, actor: "agent", model, effort, replyTo: last });
    return { saved, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { saved, result: cliFailure("CHAT_FAILED", message.slice(0, 1500)) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    chatRuns.delete(key);
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
    return { saved: false, result: cliFailure("INVALID_INPUT", lang("Choose a task, a model, and a message.", "Выберите задачу и модель, напишите сообщение.")) };
  }
  if (input.files.reduce((total, file) => total + file.bytes.byteLength, 0) > maxAttachmentBytes) {
    return { saved: false, result: cliFailure("ATTACHMENT_LIMIT", lang("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ.")) };
  }
  return sendChat(project, id, input as ChatRequest, update => {
    if (!event.sender.isDestroyed()) event.sender.send("chat:update", { project, id, ...update });
  });
});

ipcMain.handle("board:draft", async (event, request: unknown, files: unknown = []) => {
  const state = stateOf(event);
  const board = state.board;
  if (!board || typeof request !== "string" || !Array.isArray(files) ||
      !files.every(isPastedFile) || (!request.trim() && !files.length)) {
    return cliFailure("INVALID_INPUT", lang("Describe the task on an open board.", "Опишите задачу на открытой доске."));
  }
  if (state.drafting) return cliFailure("DRAFT_IN_PROGRESS", lang("The agent is already preparing a draft.", "Агент уже готовит черновик."));
  if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > maxAttachmentBytes) {
    return cliFailure("ATTACHMENT_LIMIT", lang("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ."));
  }
  state.drafting = true;
  let scratch: string | undefined;
  try {
    const attachments = [];
    if (files.length) {
      scratch = await mkdtemp(join(tmpdir(), "ai-taskboard-paste-"));
      for (const [index, file] of files.entries()) {
        const extension = imageExtensions.get(file.type);
        const path = join(scratch, String(index) + (extension ?? ""));
        await writeFile(path, Buffer.from(file.bytes));
        attachments.push({ path, name: file.name.trim(), image: extension !== undefined });
      }
    }
    const draft = await composeDraft(
      app.getPath("userData"), request.trim(), board.tags.map(tag => tag.name), attachments, lang("English", "Russian"),
    );
    if (!draft) return cliFailure("CODEX_UNAVAILABLE",
      lang("Choose a Codex executable in Settings → Codex integration.", "Выберите Codex в разделе «Настройки → Интеграция с Codex»."));
    return await callCli<Task>(board.project, ["create"], {
      ...draft, actor: "agent", attachmentSources: attachments.map(({ path, name }) => ({ path, name })),
    });
  } catch {
    return cliFailure("CODEX_DRAFT_FAILED", lang(
      "Codex could not prepare a draft. Check that Codex is up to date and you are signed in, then retry.",
      "Codex не смог подготовить черновик. Проверьте версию Codex и вход в аккаунт, затем повторите попытку.",
    ));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    state.drafting = false;
  }
});
ipcMain.handle("board:create", async event => pickProject(stateOf(event), true));
ipcMain.handle("board:recent", async (event, path: unknown) => {
  const state = stateOf(event);
  if (typeof path !== "string" || !recentBoards.includes(path)) throw new Error("Unknown recent board.");
  await openProject(state, path);
});
ipcMain.handle("appearance:themes", event => {
  stateOf(event);
  return Object.entries(themes).map(([id, [label]]) => [id, label]);
});
ipcMain.handle("appearance:theme", (event, value: unknown) => {
  stateOf(event);
  if (!isTheme(value)) return cliFailure("INVALID_INPUT", "Choose an available theme.");
  try {
    const profile = app.getPath("userData");
    mkdirSync(profile, { recursive: true });
    writeJson(join(profile, "appearance.json"), { theme: value });
  } catch {
    return cliFailure("STORAGE_ERROR", lang("Could not save the theme.", "Не удалось сохранить тему."));
  }
  theme = value;
  nativeTheme.themeSource = themes[theme][1];
  for (const state of windowStates.values()) {
    if (!state.window.isDestroyed()) state.window.webContents.send("appearance:changed", theme);
  }
  return { ok: true, data: theme };
});
ipcMain.handle("board:command", async (event, command: unknown, id: unknown, input: unknown) => {
  const state = stateOf(event);
  const args = typeof command === "string" ? commands.get(command) : undefined;
  if (!state.project || !args) return cliFailure("INVALID_INPUT", "Choose a project and a board action.");
  if (id !== undefined && (typeof id !== "string" || !/^T-\d{4,}$/.test(id))) {
    return cliFailure("INVALID_INPUT", "Invalid task number.");
  }
  if (command === "request-changes" && typeof id === "string") {
    return launchTask(state.project, id, { input });
  }
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
  if (!project) return cliFailure("INVALID_INPUT", "Choose a project.");
  try {
    return { ok: true, data: await executionModels(app.getPath("userData"), project) };
  } catch (error) {
    return cliFailure("CODEX_MODELS_UNAVAILABLE", (error as Error).message);
  }
});

ipcMain.handle("board:saveAttachment", async (event, id: unknown, file: unknown, name: unknown) => {
  const state = stateOf(event);
  if (!state.project || typeof id !== "string" || !/^T-\d{4,}$/.test(id) ||
      typeof file !== "string" || typeof name !== "string") return cliFailure("INVALID_INPUT", "Choose an attachment.");
  const project = state.project;
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

ipcMain.handle("chat:openLink", async (_event, value: unknown) => {
  if (typeof value !== "string") return;
  const url = URL.parse(value);
  if (url && ["https:", "http:", "mailto:"].includes(url.protocol)) await shell.openExternal(url.href);
});

ipcMain.handle("board:openWorktree", async (event, id: unknown) => {
  const state = stateOf(event);
  if (!state.project || typeof id !== "string" || !/^T-\d{4,}$/.test(id)) return cliFailure("INVALID_INPUT", "Choose a task.");
  const result = await callCli<Task>(state.project, ["show", id]);
  if (!result.ok) return result;
  const path = result.data.git?.worktree;
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
    return cliFailure("WORKTREE_MISSING", "The worktree folder is unavailable.");
  }
  const error = await shell.openPath(path);
  return error ? cliFailure("WORKTREE_MISSING", error) : { ok: true, data: null };
});

const launchingTasks = new Set<string>();
const runningTasks = new Set<string>();
const runActivityByTask = new Map<string, RunActivity[]>();

function publishRunActivity(project: string, id: string, items: RunActivity[]) {
  const key = project + "\0" + id;
  if (items.length) runActivityByTask.set(key, items);
  else runActivityByTask.delete(key);
  for (const state of windowStates.values()) {
    if (state.project === project && !state.window.isDestroyed()) {
      state.window.webContents.send("chat:update", { project, id, type: "run", items });
    }
  }
}

function notifyRunChange(project: string) {
  for (const state of windowStates.values()) {
    if (state.project === project) send(state);
  }
}

async function recordRunFailure(project: string, id: string, reason: string) {
  const result = await callCli<Task>(project, ["block", id], {
    reason,
    condition: lang("Resolve the reported issue and resume the task.", "Устраните указанную причину и возобновите задачу."),
  });
  if (!result.ok && result.error.code !== "INVALID_TRANSITION") return result.error.message;
}

async function launchTask(project: string, id: string, revisionRequest?: { input: unknown }) {
  const key = project + "\0" + id;
  if (launchingTasks.has(key)) return cliFailure("LAUNCH_IN_PROGRESS", "This task is already being launched.");
  launchingTasks.add(key);
  const activity = new Map<string, RunActivity>();
  let updateTimer: NodeJS.Timeout | undefined;
  const publish = () => {
    updateTimer = undefined;
    publishRunActivity(project, id, runLog(activity));
  };
  const saveActivity = async () => {
    clearTimeout(updateTimer);
    const items = runLog(activity);
    if (!items.length) return;
    const saved = await callCli<Task>(project, ["run-log", id], { entries: items });
    if (saved.ok) publishRunActivity(project, id, []);
    else publishRunActivity(project, id, [
      ...items, { id: "save-error", type: "error", title: "", text: saved.error.message, status: "failed" },
    ]);
  };
  let prepared = false;
  let monitoring = false;
  try {
    const current = await callCli<Task>(project, [revisionRequest ? "request-changes" : "show", id], revisionRequest?.input);
    if (!current.ok) return current;
    prepared = Boolean(revisionRequest);
    const client = await configuredCodex(app.getPath("userData"));
    if (!client) {
      const reason = lang("Connect Codex in settings.", "Подключите Codex в настройках.");
      if (prepared) throw new Error(reason);
      return cliFailure("CODEX_UNAVAILABLE", reason);
    }
    const started = await callCli<{ task: Task; worktree: string }>(project, ["start", id], { revision: current.data.revision });
    if (!started.ok) {
      if (prepared) throw new Error(started.error.message);
      return started;
    }
    prepared = true;
    const { threadId: codexThreadId, completion } = await startCodexRun(client, project, started.data.worktree, started.data.task, item => {
      activity.set(item.id, item);
      updateTimer ??= setTimeout(publish, 80);
    });
    monitoring = true;
    runningTasks.add(key);
    notifyRunChange(project);
    // Preserve edits made while Codex was starting.
    const saved = started.data.task.codexThreadId ? { ok: true as const, data: started.data.task } :
      await callCli<Task>(project, ["update", id], { codexThreadId, actor: "user" });
    void completion.then(async reason => {
      await saveActivity();
      const items = [...activity.values()];
      // Some tool rejections reach the agent's reply but do not fail the App Server turn.
      const detail = items.findLast(item => item.type === "agentMessage" && item.status === "completed" && item.text.trim())?.text
        ?? items.findLast(item => item.type === "commandExecution" && ["failed", "declined"].includes(item.status))?.text;
      const incomplete = lang("The agent finished without submitting the task or recording progress.",
        "Агент завершил сеанс без сдачи задачи или записи прогресса.");
      const failure = await recordRunFailure(project, id, reason ?? [incomplete, detail?.trim().slice(0, 2000)].filter(Boolean).join("\n\n"));
      if (failure) publishRunActivity(project, id, [
        ...runLog(activity), { id: "block-error", type: "error", title: "", text: failure, status: "failed" },
      ]);
    }).finally(() => {
      runningTasks.delete(key);
      launchingTasks.delete(key);
      notifyRunChange(project);
    });
    if (saved.ok) return saved;
    return cliFailure("CODEX_LINK_FAILED", saved.error.message + "\n" + "codex://threads/" + codexThreadId);
  } catch (error) {
    const reason = (error as Error).message;
    await saveActivity();
    const failure = prepared ? await recordRunFailure(project, id, reason) : undefined;
    return cliFailure("CODEX_LAUNCH_FAILED", [reason, failure].filter(Boolean).join("\n"));
  } finally {
    if (!monitoring) launchingTasks.delete(key);
  }
}

ipcMain.handle("board:launchTask", async (event, id: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) {
    return cliFailure("INVALID_INPUT", "Choose a task.");
  }
  return launchTask(project, id);
});

ipcMain.handle("board:openCodexThread", async (event, id: unknown) => {
  const { project } = stateOf(event);
  if (!project || typeof id !== "string" || !taskIdPattern.test(id)) return cliFailure("INVALID_INPUT", "Choose a task.");
  const result = await callCli<Task>(project, ["show", id]);
  if (!result.ok) return result;
  const thread = result.data.codexThreadId;
  if (!thread || !codexThreadPattern.test(thread)) return cliFailure("CODEX_THREAD_MISSING", "This task has no Codex chat.");
  const url = "codex://threads/" + thread;
  try {
    await shell.openExternal(url);
    return { ok: true, data: null };
  } catch {
    return cliFailure("CODEX_OPEN_FAILED", lang("Could not open Codex.", "Не удалось открыть Codex.") + "\n" + url);
  }
});

let codexInstallation: Promise<CodexStatus> | undefined;
ipcMain.handle("codex:status", event => {
  stateOf(event);
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:choose", async event => {
  const state = stateOf(event);
  const choice = await dialog.showOpenDialog(state.window, {
    title: lang("Choose the Codex executable", "Выберите исполняемый файл Codex"),
    properties: ["openFile"],
    ...(process.platform === "win32" ? { filters: [{ name: "Codex", extensions: ["exe"] }] } : {}),
  });
  if (!choice.canceled && choice.filePaths[0]) setCodexExecutable(app.getPath("userData"), choice.filePaths[0]);
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:auto", event => {
  stateOf(event);
  setCodexExecutable(app.getPath("userData"));
  return codexStatus(app.getPath("userData"));
});
ipcMain.handle("codex:install", event => {
  stateOf(event);
  codexInstallation ??= installCodex(app.getPath("userData"), skillLaunch(bundled, entry), app.getVersion())
    .finally(() => { codexInstallation = undefined; });
  return codexInstallation;
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
    const markdownSource = createRequire(import.meta.url).resolve("markdown-it/browser");
    protocol.handle("taskboard-assets", request => request.url === markdownAsset
      ? new Response(readFileSync(markdownSource, "utf8"), { headers: { "Content-Type": "text/javascript; charset=utf-8" } })
      : new Response(null, { status: 404 }));
    russian = app.getLocale().toLowerCase().startsWith("ru");
    loadTheme();
    loadRecentBoards();
    Menu.setApplicationMenu(null);
    if (customTitleBar) {
      nativeTheme.on("updated", () => {
        for (const { window } of windowStates.values()) {
          if (!window.isDestroyed()) window.setTitleBarOverlay(titleBarOverlay());
        }
      });
    }
    const option = process.argv.indexOf("--project");
    createWindow(option === -1 ? undefined : process.argv[option + 1]);
    app.on("activate", () => { if (!windowStates.size) createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
