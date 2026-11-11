import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bundled, callCli, cliChild, cliFailure, entry } from "./cli.ts";
import { codexStatus, composeDraft, installCodex, setCodexExecutable, skillLaunch } from "./codex.ts";
import type { CodexStatus } from "./codex.ts";
import type { CliReply } from "./cli.ts";
import type { ArchiveLink, BoardSettings, BoardTag, Task } from "../cli/model.ts";
import { maxAttachmentBytes } from "../cli/model.ts";
import { readJson, writeJson } from "../cli/storage.ts";

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
const windowStates = new Map<number, WindowState>();
const subscriptions = new Map<string, BoardWatch>();
const commands = new Map<string, string[]>([
  ["init", ["init"]], ["list", ["list"]], ["show", ["show"]], ["update", ["update"]],
  ["comment", ["comment"]],
  ["approve", ["approve"]], ["review", ["review"]], ["accept", ["accept"]],
  ["restore-changes", ["restore-changes"]],
  ["request-changes", ["request-changes"]], ["cancel", ["cancel"]], ["cleanup", ["cleanup"]],
  ["settings", ["settings"]], ["archive", ["archive", "sweep"]], ["doctor", ["doctor"]],
  ["tag-color", ["tag", "set"]],
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
  return { project: state.project, board: state.board, error: state.error, loading: state.loading, russian, theme };
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
}

async function openProject(state: WindowState, project: string): Promise<void> {
  const selection = ++state.selection;
  unbind(state);
  state.project = project;
  state.board = undefined;
  state.error = undefined;
  state.loading = true;
  send(state);
  const result = await callCli<Board>(project, ["list"]);
  if (state.selection !== selection || state.window.isDestroyed()) return;
  state.loading = false;
  if (result.ok) bind(state, result.data);
  else state.error = result.error;
  send(state);
}

async function pickProject(state: WindowState): Promise<void> {
  const result = await dialog.showOpenDialog(state.window, { properties: ["openDirectory"] });
  if (!result.canceled && result.filePaths[0]) await openProject(state, result.filePaths[0]);
}

function createWindow(initial?: string): WindowState {
  const window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 720, minHeight: 540,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
    title: "AI Taskboard",
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

ipcMain.handle("board:bootstrap", event => frame(stateOf(event)));
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

ipcMain.handle("board:draft", async (event, request: unknown, files: unknown = []) => {
  const state = stateOf(event);
  const board = state.board;
  if (!board || typeof request !== "string" || !Array.isArray(files) ||
      !files.every(isPastedFile) || (!request.trim() && !files.length)) {
    return cliFailure("INVALID_INPUT", lang("Describe the task on an open board.", "Опишите задачу на открытой доске."));
  }
  if (state.drafting) return cliFailure("DRAFT_IN_PROGRESS", lang("Codex is already preparing a draft.", "Codex уже готовит черновик."));
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
  const selection = state.selection;
  const result = await callCli<Board>(state.project, id === undefined ? args : [...args, id], input);
  if (command === "init" && result.ok && selection === state.selection && !state.window.isDestroyed()) {
    bind(state, result.data);
    state.error = undefined;
    send(state);
  }
  return result;
});

ipcMain.handle("board:attach", async (event, id: unknown, revision: unknown) => {
  const state = stateOf(event);
  if (!state.project || typeof id !== "string" || !/^T-\d{4,}$/.test(id)) {
    return cliFailure("INVALID_INPUT", "Choose a task.");
  }
  const project = state.project;
  const result = await dialog.showOpenDialog(state.window, { properties: ["openFile"] });
  if (result.canceled || !result.filePaths[0]) return { ok: true, data: null };
  return callCli(project, ["attachment", "add", id], { path: result.filePaths[0], actor: "user", revision });
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
    russian = app.getLocale().toLowerCase().startsWith("ru");
    loadTheme();
    Menu.setApplicationMenu(null);
    const option = process.argv.indexOf("--project");
    createWindow(option === -1 ? undefined : process.argv[option + 1]);
    app.on("activate", () => { if (!windowStates.size) createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
