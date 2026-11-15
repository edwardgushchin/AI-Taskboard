const api = window.taskboard;
const byId = id => document.getElementById(id);
let frame = {};
let projectGeneration = 0;
let archiveView = false;
let sheetKind = "";
let taskInSheet;
let taskSheetRequest = 0;
let focusBeforeSheet;
let boardTags = new Map();
let lanePreferences = {};
let cardCoverCache = new Map();
let boardCards = new Map();
let boardLanes = new Map();
const boardViews = new Map();
const sheet = byId("sheet");
const body = byId("sheet-body");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const language = (english, russian) => frame.russian ? russian : english;
const lanes = [
  ["draft", "Draft", "Черновик"], ["ready", "Ready", "Готово к работе"],
  ["in_progress", "In progress", "В работе"], ["blocked", "Blocked", "Заблокировано"],
  ["review", "In review", "На проверке"], ["done", "Done", "Завершено"],
  ["cancelled", "Cancelled", "Отменено"],
];

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function icon(name) {
  const aliases = {
    images: "files", thought: "lightbulb", tool: "tools", board: "layout",
    plus: "add", chevron: "chevron-up", dependency: "link", attachment: "attach",
    stop: "debug-stop", microphone: "mic", "git-user": "account", notifications: "bell", "git-tag": "tag", chat: "comment-discussion",
  };
  const item = element("i", undefined, "icon codicon codicon-" + (aliases[name] ?? name));
  item.setAttribute("aria-hidden", "true");
  return item;
}

let displayedBoardError;
const dismissedBoardErrors = new Map();

function windowNotice(message, context, boardErrorKey) {
  displayedBoardError = boardErrorKey;
  byId("notice-context").textContent = context ?? "";
  byId("notice-message").textContent = message ?? "";
  byId("notice").hidden = !message;
  controlLabelForIcon(byId("notice-close"), language("Dismiss notification", "Скрыть уведомление"));
}

function notice(message, context) {
  if (!sheet.open) {
    if (message || !displayedBoardError) windowNotice(message, context ?? "AI Taskboard");
    return;
  }
  const target = byId("sheet-notice");
  target.textContent = message || "";
  target.hidden = !message;
}

function syncBoardNotice(projectChanged) {
  const { project, error, tabs } = frame;
  if (Array.isArray(tabs)) {
    for (const path of dismissedBoardErrors.keys()) {
      if (path !== project && !tabs.some(tab => tab.path === path)) dismissedBoardErrors.delete(path);
    }
  }
  if (!error) {
    dismissedBoardErrors.delete(project);
    if (projectChanged || displayedBoardError) windowNotice();
    return;
  }
  const key = JSON.stringify([project, error.operation, error.code, error.message, frame.russian]);
  if (key === displayedBoardError) return;
  if (key === dismissedBoardErrors.get(project)) {
    if (projectChanged || displayedBoardError) windowNotice();
    return;
  }
  dismissedBoardErrors.delete(project);
  const operations = {
    refresh: language("Board refresh", "Обновление доски"),
    open: language("Opening project", "Открытие проекта"),
    create: language("Creating board", "Создание доски"),
    "save-session": language("Saving tabs", "Сохранение вкладок"),
  };
  const operation = operations[error.operation] ?? language("Project", "Проект");
  const message = error.operation === "refresh" && error.code === "BOARD_BUSY"
    ? language("The board is busy. Updates will retry automatically.", "Доска занята. Обновление повторится автоматически.")
    : boardError(error);
  windowNotice(message, [operation, projectName()].filter(Boolean).join(" · "), key);
}

function projectName() {
  return frame.tabs?.find(tab => tab.path === frame.project)?.name ?? frame.project?.split(/[\\/]/).at(-1);
}

function boardError(error) {
  if (error.code === "BOARD_BUSY") {
    return language("The board is busy with another operation. Try again in a moment.",
      "Доска занята другой операцией. Повторите через несколько секунд.");
  }
  if (error.code === "ARTIFACT_LIMIT") {
    return language("This task can keep up to 64 MiB and 64 artifact entries. Select the files needed for review.",
      "На задачу можно сохранить до 64 МиБ и 64 записей артефактов. Выберите файлы, нужные для проверки.");
  }
  if (error.code === "ARTIFACT_DIRECTORY") {
    return [language("Select individual files needed for review.", "Укажите отдельные файлы, нужные для проверки."),
      error.details?.path].filter(Boolean).join("\n");
  }
  if (error.code === "ARTIFACT_UNAVAILABLE") {
    return language("This review file is no longer available.", "Этот файл проверки больше недоступен.");
  }
  const gitMessages = {
    STALE_REPOSITORY: language("The branch changed. Retry with its current revision.", "Ветка изменилась. Повторите действие для её текущей ревизии."),
    GIT_WORKTREE_REQUIRED: language("Open a repository with a main worktree.", "Откройте репозиторий с основной рабочей копией."),
    WORKING_DIRECTORY_UNAVAILABLE: language("The selected working directory is unavailable or points somewhere else.",
      "Рабочая папка недоступна или теперь указывает на другое место."),
    GIT_COMMIT_REQUIRED: language("Select a branch with a commit first.", "Сначала выберите ветку хотя бы с одним коммитом."),
    REMOTE_EXISTS: language("The origin remote already exists. Manage it with your Git tools.", "Удалённый репозиторий origin уже настроен. Используйте свои инструменты Git для работы с ним."),
    GITHUB_UNAVAILABLE: language("Install GitHub CLI (gh) and sign in with gh auth login.", "Установите GitHub CLI (gh) и войдите в аккаунт командой gh auth login."),
    GITHUB_REMOTE_REQUIRED: language("Use a milestone from the GitHub repository configured as origin.", "Выберите веху из репозитория GitHub, настроенного как origin."),
    GITHUB_MILESTONES_FAILED: language("Could not load GitHub milestones. Check your connection and repository access in GitHub CLI.", "Не удалось загрузить вехи GitHub. Проверьте соединение и доступ к репозиторию в GitHub CLI."),
    GITHUB_PUBLISH_FAILED: language("GitHub publication failed. Check your connection and permissions. Any created repository and origin were preserved; inspect them before retrying.", "Не удалось опубликовать репозиторий в GitHub. Проверьте соединение и права доступа. Если репозиторий и origin были созданы, они сохранены; проверьте их перед повтором."),
    GITHUB_PUSH_FAILED: language("The repository and origin were created, but the push failed. Check Git authentication and push the branch with your Git tools.", "Репозиторий и origin созданы, но отправить коммиты не удалось. Проверьте авторизацию Git и отправьте ветку своими инструментами Git."),
  };
  if (gitMessages[error.code]) return [gitMessages[error.code], error.details?.output].filter(Boolean).join("\n");
  if (error.code === "DEPENDENCIES_INCOMPLETE") {
    return language("Complete the dependencies first.", "Сначала завершите зависимости.") + " " +
      (error.details?.dependencies ?? []).join(", ");
  }
  if (error.code === "DEPENDENCY_CYCLE") {
    return language("A task cannot depend on itself, directly or indirectly.",
      "Задача не может зависеть от себя напрямую или через другие задачи.");
  }
  if (error.code === "BOARD_NOT_FOUND") {
    return language("No board in the selected folder. Choose another folder or create a board.",
      "В выбранной папке нет доски. Выберите другую папку или создайте доску.");
  }
  if (error.code === "GIT_UNAVAILABLE") {
    return language("Install Git 2.38 or newer, then reopen the project.", "Установите Git 2.38 или новее, затем откройте проект снова.");
  }
  const { output, path, paths } = error.details ?? {};
  const files = Array.isArray(paths) ? paths.join("\n") : undefined;
  const message = error.code === "MERGE_CONFLICT"
    ? language("The task conflicts with the target branch. Ask the agent to resolve the conflicts and resubmit.",
      "Изменения задачи конфликтуют с целевой веткой. Поручите агенту разрешить конфликты и повторно сдать задачу.")
    : error.code === "LOCAL_CHANGES_CONFLICT"
    ? language("The task conflicts with local changes. The target worktree was left untouched.",
      "Задача конфликтует с локальными правками. Целевая копия осталась без изменений.")
    : error.code === "WORKTREE_ACCESS_DENIED"
    ? language("Close programs using the worktree or restore access, then retry cleanup.",
      "Закройте программы, использующие рабочую копию, или восстановите доступ, затем повторите уборку.")
    : error.code === "RESTORE_CONFLICT"
    ? language("Could not restore the changes. The backup is still available.", "Не удалось восстановить правки. Сохранённая копия доступна.")
    : error.message;
  return [message, path, files, output].filter(value => typeof value === "string" && value.length)
    .join("\n").slice(0, 4000);
}

function protect(callback) {
  return (...args) => { Promise.resolve().then(() => callback(...args)).catch(error => notice(error.message)); };
}

function button(label, click, kind = "") {
  const item = element("button", label, ("button " + kind).trim());
  item.type = "button";
  item.addEventListener("click", protect(click));
  return item;
}

async function checkUpdates() {
  openSheet("updates", language("AI Taskboard updates", "Обновления AI Taskboard"));
  const status = element("p", language("Checking for updates…", "Проверяем наличие обновлений…"));
  status.setAttribute("role", "status");
  const retry = button(language("Check again", "Проверить снова"), run);
  retry.id = "updates-retry";
  const content = element("section", undefined, "sheet-section");
  content.id = "updates-result";
  body.append(status, content, retry);
  async function run() {
    retry.disabled = true;
    content.replaceChildren();
    status.textContent = language("Checking for updates…", "Проверяем наличие обновлений…");
    try {
      const result = await api.checkUpdates();
      if (!content.isConnected) return;
      if (!result.ok) throw new Error(result.error.message);
      const { currentVersion, sourceUrl, status: outcome, latest } = result.data;
      content.append(element("p", language("Installed version: ", "Установленная версия: ") + currentVersion));
      status.textContent = outcome === "available"
        ? language("A new version is available: ", "Доступна новая версия: ") + latest.version +
          (latest.prerelease ? language(" (prerelease)", " (предварительная)") : "")
        : outcome === "empty" ? language("No releases are published for this update channel yet.", "Для этого канала обновлений пока нет опубликованных выпусков.")
          : language("You have the latest version of AI Taskboard.", "У вас последняя версия AI Taskboard.");
      if (outcome === "available") {
        const release = button(language("Open release…", "Открыть выпуск…"), () => api.openLink(latest.url), "primary");
        release.id = "updates-open-release";
        content.append(release, element("p", language("Choose a download for your system on the release page. Install it manually.",
          "Выберите пакет для своей системы на странице выпуска и установите его вручную."), "muted"));
      }
      content.append(button(language("All releases…", "Все выпуски…"), () => api.openLink(sourceUrl), "quiet"));
    } catch {
      if (!content.isConnected) return;
      status.textContent = language("Could not check for updates. Check your connection and try again.",
        "Не удалось проверить обновления. Проверьте соединение и повторите попытку.");
    } finally {
      if (retry.isConnected) retry.disabled = false;
    }
  }
  await run();
}

function openSettingsMenu(last = false) {
  const trigger = byId("app-settings");
  const menu = byId("settings-menu");
  if (menu.matches(":popover-open")) {
    menu.hidePopover();
    return;
  }
  const app = button(language("AI Taskboard settings…", "Настройки AI Taskboard…"), () => {
    menu.hidePopover();
    trigger.focus();
    settings();
  });
  const board = button(language("Board settings…", "Настройки доски…"), () => {
    menu.hidePopover();
    trigger.focus();
    boardSettings();
  });
  board.disabled = !frame.board;
  const updates = button(language("Check for updates…", "Проверить наличие обновлений…"), () => {
    menu.hidePopover();
    trigger.focus();
    return checkUpdates();
  });
  for (const [index, item] of [app, board, updates].entries()) {
    item.className = "app-menu-item";
    item.id = ["settings-menu-app", "settings-menu-board", "settings-menu-updates"][index];
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-disabled", String(item.disabled));
    item.tabIndex = -1;
  }
  const separator = element("hr");
  separator.setAttribute("role", "separator");
  menu.setAttribute("aria-label", language("Settings and updates", "Настройки и обновления"));
  menu.replaceChildren(app, board, separator, updates);
  menu.showPopover({ source: trigger });
  const anchor = trigger.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(anchor.right, innerWidth - menu.offsetWidth - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(anchor.bottom - menu.offsetHeight, innerHeight - menu.offsetHeight - 4)) + "px";
  (last ? updates : app).focus();
}

function mountAppMenu() {
  const bar = byId("app-menu");
  bar.setAttribute("aria-label", language("Application menu", "Меню приложения"));
  const groups = [
    ["File", "Файл", [
      ["new-window", "New window", "Новое окно", "N"],
      ["create-project", "Create project…", "Создать проект…"],
      ["open-project", "Open project…", "Открыть проект…", "O"],
      ["open-recent", "Open recent", "Открыть последнее"],
      ["close-tab", "Close project", "Закрыть проект", "W"],
      ["close-window", "Close window", "Закрыть окно", "Shift+W"],
      ["settings", "Application settings…", "Настройки приложения…", ","],
      ["board-settings", "Board settings…", "Настройки доски…"],
      ["quit", "Exit", "Выход"],
    ]],
    ["Edit", "Правка", [
      ["undo", "Undo", "Отменить", "Z"],
      ["redo", "Redo", "Повторить", api.isMac ? "Shift+Z" : "Y"],
      ["cut", "Cut", "Вырезать", "X"],
      ["copy", "Copy", "Копировать", "C"],
      ["paste", "Paste", "Вставить", "V"],
      ["select-all", "Select all", "Выделить всё", "A"],
    ]],
    ["View", "Вид", [
      ["archive-view", "Archive", "Архив"],
      ["zoom-in", "Zoom in", "Увеличить", "+"],
      ["zoom-out", "Zoom out", "Уменьшить", "-"],
      ["reset-zoom", "Reset zoom", "Сбросить масштаб", "0"],
      ["fullscreen", "Full screen", "Полноэкранный режим", "F11"],
    ]],
    ["Help", "Справка", [
      ["about", "About AI Taskboard", "О программе"],
    ]],
  ];
  const shortcuts = new Map();
  let active;
  let previousFocus;
  let recentMenu;

  function close() {
    if (!active) return;
    if (recentMenu) { recentMenu.popup.hidden = true; recentMenu.trigger.setAttribute("aria-expanded", "false"); }
    active.popup.hidden = true;
    active.trigger.setAttribute("aria-expanded", "false");
    active = undefined;
  }

  function open(menu, index = 0) {
    close();
    active = menu;
    menu.popup.hidden = false;
    menu.trigger.setAttribute("aria-expanded", "true");
    menu.items.at(index).focus();
  }

  const run = protect(action => {
    if (action === "open-recent") {
      const popup = recentMenu.popup;
      popup.replaceChildren();
      for (const recent of frame.recentBoards ?? []) {
        const item = button("", () => {
          close();
          return api.openRecent(recent.path);
        });
        item.className = "app-menu-item";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        item.append(element("span", recent.name), element("small", recent.path));
        popup.append(item);
      }
      if (!popup.childElementCount) {
        const empty = button(language("No recent projects", "Нет недавних проектов"), () => {});
        empty.className = "app-menu-item";
        empty.setAttribute("role", "menuitem");
        empty.setAttribute("aria-disabled", "true");
        popup.append(empty);
      }
      popup.hidden = false;
      recentMenu.trigger.setAttribute("aria-expanded", "true");
      popup.firstElementChild.focus();
      return;
    }
    if (action === "archive-view" && !frame.board) return;
    if (active) {
      const trigger = active.trigger;
      close();
      (previousFocus?.isConnected ? previousFocus : trigger).focus();
    }
    if (action === "archive-view") {
      archiveView = !archiveView;
      byId("filters").open = false;
      render();
      return;
    }
    if (action === "settings") return settings();
    if (action === "board-settings") return boardSettings();
    if (action === "create-project") return api.createBoard();
    return api.menuAction(action);
  });

  const menus = groups.map(([english, russian, commands], index) => {
    const group = element("div", undefined, "app-menu-group");
    group.setAttribute("role", "none");
    const label = language(english, russian);
    const trigger = element("button", label, "app-menu-trigger");
    trigger.type = "button";
    trigger.tabIndex = index === 0 ? 0 : -1;
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const popup = element("div", undefined, "app-menu-popup");
    popup.hidden = true;
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", label);
    const items = commands.map(([action, en, ru, shortcut]) => {
      const item = button("", () => run(action));
      item.className = "app-menu-item";
      item.tabIndex = -1;
      item.setAttribute("role", action === "archive-view" ? "menuitemcheckbox" : "menuitem");
      if (action === "archive-view") item.id = "archive-menu-item";
      if (action === "board-settings") item.id = "board-settings-menu-item";
      if (action === "settings") item.id = "app-settings-menu-item";
      item.append(element("span", language(en, ru)));
      if (shortcut) {
        shortcuts.set(shortcut, action);
        const prefix = shortcut === "F11" ? "" : api.isMac ? "⌘" : "Ctrl+";
        item.append(element("kbd", prefix + shortcut));
      }
      if (action === "open-recent") {
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        item.append(element("span", "›"));
        const container = element("div", undefined, "app-menu-submenu-trigger");
        const submenu = element("div", undefined, "app-menu-popup app-menu-submenu");
        submenu.hidden = true;
        submenu.setAttribute("role", "menu");
        submenu.setAttribute("aria-label", language(en, ru));
        container.append(item, submenu);
        popup.append(container);
        recentMenu = { trigger: item, popup: submenu };
      } else popup.append(item);
      return item;
    });
    const menu = { group, trigger, popup, items };
    trigger.addEventListener("click", () => {
      if (active === menu) close();
      else open(menu);
    });
    group.append(trigger, popup);
    bar.append(group);
    return menu;
  });

  document.addEventListener("pointerdown", event => {
    if (!bar.contains(event.target)) close();
  });
  document.addEventListener("focusin", event => {
    if (!bar.contains(event.target)) {
      close();
      previousFocus = event.target;
      return;
    }
    const focused = menus.find(menu => menu.group.contains(event.target));
    for (const menu of menus) menu.trigger.tabIndex = menu === focused ? 0 : -1;
  });
  bar.addEventListener("keydown", event => {
    if (recentMenu && !recentMenu.popup.hidden && recentMenu.popup.contains(event.target)) {
      const items = [...recentMenu.popup.children];
      if (["Escape", "ArrowLeft"].includes(event.key)) {
        recentMenu.popup.hidden = true;
        recentMenu.trigger.setAttribute("aria-expanded", "false");
        recentMenu.trigger.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const index = items.indexOf(event.target);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      } else if (event.key !== "Tab") return;
      else close();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target === recentMenu?.trigger && event.key === "ArrowRight") {
      event.preventDefault();
      run("open-recent");
      return;
    }
    const index = menus.findIndex(menu => menu.group.contains(event.target));
    const menu = menus[index];
    if (!menu) return;
    if (event.key === "Escape" || event.key === "Tab") {
      if (!active) return;
      close();
      menu.trigger.focus();
      if (event.key === "Tab") return;
      event.stopPropagation();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const next = menus[(index + offset + menus.length) % menus.length];
      if (active) open(next);
      else next.trigger.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const itemIndex = menu.items.indexOf(event.target);
      if (itemIndex < 0) open(menu, offset === 1 ? 0 : -1);
      else menu.items[(itemIndex + offset + menu.items.length) % menu.items.length].focus();
    } else if (active && (event.key === "Home" || event.key === "End")) {
      menu.items.at(event.key === "Home" ? 0 : -1).focus();
    } else return;
    event.preventDefault();
  });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.altKey || event.isComposing) return;
    if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      bar.querySelector('.app-menu-trigger[tabindex="0"]').focus();
      return;
    }
    const modifier = api.isMac ? event.metaKey : event.ctrlKey;
    if (!modifier && event.key !== "F11") return;
    const key = event.code.startsWith("Key") ? event.code.slice(3) : event.key;
    if (event.shiftKey && key !== "Z" && key !== "W" && key !== "+") return;
    const shortcut = key === "=" ? "+" : event.shiftKey && ["Z", "W"].includes(key) ? "Shift+" + key : key;
    const action = !api.isMac && shortcut === "Shift+Z" ? "redo" : shortcuts.get(shortcut);
    if (!action) return;
    event.preventDefault();
    if (!event.repeat) run(action);
  });
  bar.hidden = false;
}

async function command(action, id, input) {
  const generation = projectGeneration;
  const result = await api.command(action, id, input);
  if (generation !== projectGeneration) return undefined;
  if (!result.ok) {
    const actions = {
      update: ["Editing task", "Редактирование задачи"], approve: ["Approving task", "Утверждение задачи"],
      "return-to-draft": ["Returning task to draft", "Возврат задачи в черновик"],
      "attachment-cover": ["Changing task cover", "Смена обложки задачи"],
      comment: ["Adding comment", "Добавление комментария"], cancel: ["Cancelling task", "Отмена задачи"],
      "request-changes": ["Requesting changes", "Возврат на доработку"], review: ["Reviewing task", "Проверка задачи"],
      accept: ["Accepting task", "Приёмка задачи"], "cleanup-status": ["Checking worktree cleanup", "Проверка уборки рабочей копии"],
      "restore-changes": ["Restoring changes", "Восстановление правок"], settings: ["Saving board settings", "Сохранение настроек доски"],
      "tag-create": ["Creating tag", "Создание тега"], "tag-color": ["Changing tag color", "Изменение цвета тега"],
      "tag-assign": ["Editing tags", "Редактирование тегов"],
      milestones: ["Loading GitHub milestones", "Загрузка вех GitHub"], milestone: ["Changing GitHub milestone", "Смена вехи GitHub"],
    };
    const label = actions[action] ?? ["Board action", "Действие с доской"];
    notice(boardError(result.error), [language(...label), id, projectName()].filter(Boolean).join(" · "));
    return undefined;
  }
  notice();
  return result.data;
}

function openSheet(kind, title) {
  if (kind !== "task") taskSheetRequest++;
  chatPreviews.disconnect();
  sheetKind = kind;
  byId("sheet-title").textContent = title;
  body.replaceChildren();
  byId("sheet-notice").hidden = true;
  if (!sheet.open) {
    const branches = byId("git-branches");
    if (branches.matches(":popover-open")) branches.hidePopover();
    focusBeforeSheet = document.activeElement;
    sheet.show();
    byId("app-content").inert = true;
    document.querySelector(".status-bar").inert = true;
  }
}

function section(title, content, target = body) {
  if (content === undefined || content === "" || (Array.isArray(content) && !content.length)) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", title));
  if (Array.isArray(content)) {
    const list = element("ul");
    for (const value of content) {
      const item = element("li");
      item.append(value instanceof Node ? value : chatText(value));
      list.append(item);
    }
    area.append(list);
  } else area.append(chatText(content));
  target.append(area);
}

function taskDescription(text, taskId) {
  if (!text) return;
  const area = element("section", undefined, "sheet-section task-sheet-description");
  const content = chatText(text, { taskId });
  foldTechnicalDetails(content, /^Диагностика и связанные файлы$/, "task-description-details", false);
  area.append(element("h3", language("Description", "Описание")), content);
  body.append(area);
}

function cardDescription(text) {
  if (!chatMarkdown) return element("span", text, "task-description");
  // A template stays inert: no links, images or controls enter the card button.
  const template = document.createElement("template");
  template.innerHTML = chatMarkdown.render(text);
  for (const image of template.content.querySelectorAll("img")) image.replaceWith(image.alt);
  return element("span", template.content.textContent.trim(), "task-description");
}

function checkCommandLabel(command) {
  if (/\btools[\\/]wiki[\\/]/i.test(command)) {
    return /test_generate\.py/i.test(command) ? language("Documentation generator tests", "Тесты генератора документации") :
      language("Generated documentation", "Сгенерированная документация");
  }
  if (/\btools[\\/]coverage[\\/]/i.test(command)) return language("API coverage", "Покрытие API");
  if (/^dotnet build\b/i.test(command)) {
    const configuration = command.match(/\s(?:-c|--configuration)\s+([\w.-]+)/i)?.[1];
    return language("Build", "Сборка") + (configuration ? " · " + configuration : "");
  }
  if (/^dotnet format\b/i.test(command)) {
    const project = command.match(/(?:^|[\s"'\\/])([^\s"'\\/]+)\.csproj\b/i)?.[1];
    return language("Code formatting", "Форматирование кода") + (project ? " · " + project : "");
  }
  if (/^git diff --check\b/i.test(command)) return /;\s*rg\b/i.test(command) ?
    language("Diff and text search", "Проверка diff и поиск по тексту") : language("Diff whitespace", "Пробелы в diff");
  const script = command.match(/(?:^|[\s\\/])([\w.-]+)\.(?:ps1|py|sh)\b/i)?.[1];
  if (script?.startsWith("test_")) return language("Tests", "Тесты") + " · " + script.slice(5).replaceAll("_", " ");
  const suite = command.match(/\$env:\w+\s*=\s*["']([^"']+)["']/gi);
  if (suite?.length && /\bdotnet\b/i.test(command)) {
    const variants = suite.map(value => value.match(/["']([^"']+)["']/)[1]).filter(value => !/[\\/]/.test(value));
    return language("Test run", "Прогон тестов") + (variants.length ? " · " + variants.join(" / ") : "");
  }
  if (/^dotnet test\b/i.test(command)) return language(".NET tests", "Тесты .NET");
  if (script) return language("Script", "Скрипт") + " · " + script.replaceAll("_", " ");
  if (/^(?:\$env:|& |dotnet |git |rg |npm |node |python[3]? |pwsh |powershell |bash |cargo |pytest\b|\.\.?[\\/])/i.test(command)) {
    return language("Command", "Команда") + " · " + command.split(/\s+/, 2).join(" ").slice(0, 48);
  }
}

function showSubmissionResult(result, target = body) {
  if (!result) return;
  section(language("Result", "Результат"), result.summary, target);
  if (result.checks?.length) {
    const area = element("section", undefined, "sheet-section task-checks");
    area.append(element("h3", language("Checks", "Проверки")));
    for (const value of result.checks) {
      const parts = value.match(/^([\s\S]+?)\n(?:Command|Команда):\s*([\s\S]+)$/i);
      const statement = (parts?.[1] ?? value).trim();
      const outcome = statement.match(/^([\s\S]+?)(?:\s+[-–—]\s+|:\s*)(pass(?:ed)?|fail(?:ed)?|skipped|not run|пройден[аоы]?|не пройден[аоы]?|пропущен[аоы]?|не запускал[аи]?)(?:\s*([;:.—–-])\s*([\s\S]*))?$/i);
      const name = outcome?.[1] ?? statement;
      const commandLabel = !parts && outcome ? checkCommandLabel(name) : undefined;
      const status = outcome?.[2].toLowerCase();
      const passed = status && /^(?:pass|пройден)/.test(status);
      const failed = status && /^(?:fail|не пройден)/.test(status);
      const command = parts?.[2] ?? (commandLabel && value);
      const row = element(command ? "details" : "div", undefined, "task-check");
      const line = element(command ? "summary" : "div", undefined, "task-check-line");
      if (command) {
        const arrow = element("i", undefined, "codicon codicon-chevron-right task-check-arrow");
        arrow.setAttribute("aria-hidden", "true");
        line.append(arrow);
      }
      const copy = element("span", undefined, "task-check-copy");
      copy.append(command || outcome ? element("span", commandLabel ?? name, "task-check-name") : chatText(name));
      if (outcome?.[4]) copy.append(element("span", outcome[4], "task-check-note"));
      line.append(copy);
      if (status) {
        const label = passed ? language("Passed", "Пройдено") : failed ? language("Failed", "Не пройдено") : language("Skipped", "Пропущено");
        const badge = element("span", label, "task-check-status");
        badge.dataset.outcome = passed ? "passed" : failed ? "failed" : "skipped";
        line.append(badge);
      }
      row.append(line);
      if (command) row.append(element("pre", command, "task-check-command"));
      area.append(row);
    }
    target.append(area);
  }
  section(language("Limitations", "Ограничения"), result.limitations, target);
}

const cardCovers = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    cardCovers.unobserve(target);
    if (!target.isConnected) continue;
    const image = target.querySelector(".task-card-cover");
    const { task, file } = image.dataset;
    const key = task + "\0" + file;
    const cache = cardCoverCache;
    const request = cache.get(key) ?? api.attachmentPreview(task, file);
    cache.set(key, request);
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    const discard = () => {
      if (cache.get(key) === request) cache.delete(key);
    };
    void request.then(src => {
      if (!src || src.length > 1_000_000) discard();
      if (src && image.isConnected) image.src = src;
    }).catch(discard);
  }
});

function selectedCover(task, images) {
  const explicit = images.find(file => file.file === task.coverAttachment);
  if (explicit) return explicit;
  // Both attachment commands append their files after the attachments saved at creation.
  const later = (task.history ?? []).reduce((total, event) => total +
    (event.action === "attach" ? 1 : event.chat?.files?.length ?? 0), 0);
  const attachments = task.attachments ?? [];
  const initial = attachments.slice(0, Math.max(0, task.initialAttachments ?? attachments.length - later));
  return initial.find(isImageAttachment);
}

const tagKey = name => name.trim().normalize().toLowerCase();

function tagBadge(name, color) {
  const badge = element("span", name, "tag");
  if (color) badge.style.setProperty("--tag-color", color);
  return badge;
}

function tagBadges(names) {
  const tags = new Map();
  for (const name of names) {
    const key = tagKey(name);
    if (!tags.has(key)) tags.set(key, boardTags.get(key) ?? { name });
  }
  return Array.from(tags.values(), tag => tagBadge(tag.name, tag.color));
}

function renderAgentRunStatus(target, task) {
  const review = frame.reviewingTasks?.[task.id];
  const label = review === "reviewer" ? language("Reviewer is reviewing", "Проверяет ревьюер") :
    review === "manager" ? language("Project manager is reviewing", "Проверяет менеджер проекта") :
    frame.runningTasks?.includes(task.id) ? language("Agent is working", "Агент работает") : "";
  if (label) {
    const spinner = target.querySelector(".agent-spinner") ?? icon("sync");
    spinner.classList.add("agent-spinner");
    spinner.removeAttribute("aria-hidden");
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", label);
    spinner.title = label;
    if (!spinner.parentNode) target.replaceChildren(spinner);
  } else {
    const text = frame.waitingTasks?.includes(task.id) ?
      language("Waiting for an available executor", "Ожидает свободного исполнителя") :
      task.status === "in_progress" && task.codexThreadId ?
      language("Board run inactive", "Запуск с доски не активен") : "";
    if (target.firstElementChild || target.textContent !== text) target.textContent = text;
  }
  target.hidden = !target.childNodes.length;
}

function shownStatus(task) {
  return task.status === "ready" && task.unfinishedDependencies?.length ? "blocked" : task.status;
}

function taskIndicator(name, count, label, className) {
  const indicator = element("span", undefined, "task-stat " + className);
  indicator.title = label + " · " + count;
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", indicator.title);
  indicator.append(icon(name), String(count));
  return indicator;
}

function explicitDependencyWait(reason) {
  const plain = reason.replace(/[`*]/g, "").trim();
  const wait = /^(?:задача\s+)?(?:ожидаю|ожидает|ожидается|ожидание|жду|жд[её]т|waiting for|awaiting)\s+/iu;
  if (!wait.test(plain)) return;
  const target = plain.replace(wait, "").replace(
    /^(?:(?:завершени[ея]|при[её]мки|слияния|completion of|acceptance of|merge of)\s+)?(?:задач[аиу]\s+|tasks?\s+)?/iu, "",
  ).replace(/[.!]$/, "");
  if (!/^(?:T-\d{4,}(?:\s*,\s*T-\d{4,})*|другую задачу|another task)$/iu.test(target)) return;
  return [...new Set(target.toUpperCase().match(/T-\d{4,}/g) ?? [])];
}

function dependencyBadge(ids, block) {
  const name = ids.length ? ids[0] + (ids.length > 1 ? " +" + (ids.length - 1) : "") : language("a task", "задачу");
  const badge = element("span", undefined, "task-dependency-message dependency-warning");
  badge.append(element("span", language("Waiting for", "Ожидает") + " " + name));
  badge.title = block ? block.reason + "\n\n" + block.condition :
    language("Waiting for completion of", "Ожидает завершения") + " " + ids.join(", ");
  return badge;
}

function blockerBanner({ reason, condition }) {
  const tokenUsageReason = legacyTokenUsageFailure(reason);
  if (tokenUsageReason) {
    reason = tokenUsageReason;
    condition = language("Resume the task in the same chat and worktree.",
      "Возобновите задачу в том же чате и рабочей копии.");
  } else if (/already has an active writer/i.test(reason)) {
    reason = language("This Codex chat is already open in another process.", "Этот чат Codex уже открыт в другом процессе.");
    condition = language("Continue in the existing chat, or stop work there and choose Continue in a new chat.",
      "Продолжите задачу в открытом чате или остановите там работу и нажмите «Продолжить в новом чате».");
  }
  const banner = element("span", undefined, "task-blocker");
  banner.append(
    element("strong", language("Why it is blocked", "Причина блокировки")),
    element("span", reason, "task-blocker-detail"),
    element("strong", language("How to continue", "Как продолжить")),
    element("span", condition, "task-blocker-detail"),
  );
  banner.title = reason + "\n\n" + condition;
  return banner;
}

function card(task) {
  const showCover = archiveView || frame.board.settings?.showCardPreviews !== false;
  const cover = showCover ? selectedCover(task, (task.attachments ?? []).filter(isImageAttachment)) : undefined;
  // Only visible card data belongs in this key: chat/log/revision updates must not rebuild it.
  const signature = JSON.stringify([frame.russian, task.title, task.description,
    task.tags?.map(name => boardTags.get(tagKey(name)) ?? { name }), cover?.file,
    frame.runningTasks?.includes(task.id) ?? false, frame.waitingTasks?.includes(task.id) ?? false,
    frame.reviewingTasks?.[task.id], task.status, Boolean(task.codexThreadId),
    task.unfinishedDependencies, task.blocked, task.subtasks?.map(entry => entry.done),
    task.attachments?.length, task.priority, task.milestone, task.schedule]);
  const previous = boardCards.get(task.id);
  if (previous?.signature === signature) return previous.node;
  const card = previous?.node ?? button("", () => showTask(task.id));
  const oldDetails = card.querySelector(".task-card-details");
  const oldImage = card.querySelector(".task-card-cover");
  if (oldDetails) cardCovers.unobserve(oldDetails);
  card.className = "task-card";
  card.dataset.state = task.status;
  if (task.priority && task.priority !== "normal") {
    card.dataset.priority = task.priority;
    card.setAttribute("aria-description", language("Priority", "Приоритет") + " · " + priorityName(task.priority));
  } else {
    delete card.dataset.priority;
    card.removeAttribute("aria-description");
  }
  const item = element("span", undefined, "task-card-details");
  const heading = element("span", undefined, "task-card-heading");
  heading.append(element("strong", task.title));
  if (task.status === "done") {
    const done = element("span", undefined, "task-done");
    done.setAttribute("role", "img");
    done.setAttribute("aria-label", language("Completed", "Завершено"));
    done.append(icon("check"));
    heading.append(done);
  }
  item.append(heading);
  const block = task.status === "blocked" ? task.blocked : undefined;
  const manualWait = block && explicitDependencyWait(block.reason);
  const waiting = manualWait?.length ? manualWait : task.unfinishedDependencies ?? [];
  if (manualWait || (waiting.length && ["ready", "blocked"].includes(task.status))) {
    item.append(dependencyBadge(waiting, manualWait ? block : undefined));
  } else if (task.description && task.status !== "blocked") {
    item.append(cardDescription(task.description));
  }
  if (task.tags?.length) {
    const tags = element("span", undefined, "task-tags");
    tags.append(...tagBadges(task.tags));
    item.append(tags);
  }
  if (cover) {
    const image = oldImage?.dataset.file === cover.file ? oldImage : element("img", undefined, "task-card-cover");
    if (image !== oldImage) {
      image.alt = "";
      image.hidden = true;
      image.dataset.task = task.id;
      image.dataset.file = cover.file;
      image.onload = () => {
        // Keep small covers at their native width; CSS crops tall covers before they become visible.
        image.style.width = image.naturalWidth + "px";
        image.hidden = false;
      };
    }
    item.append(image);
  }
  const meta = element("span", undefined, "task-meta");
  const identity = element("span", undefined, "task-identity");
  const id = element("span", undefined, "task-id task-stat");
  id.append(icon("symbol-number"), task.id);
  identity.append(id);
  if (task.milestone) {
    const { title, repository, number } = task.milestone;
    const badge = element("span", undefined, "task-milestone task-stat");
    badge.append(icon("milestone"), element("span", title, "task-milestone-label"));
    badge.title = language("GitHub milestone", "Веха GitHub") + " · " + title + " · " + repository + " #" + number;
    identity.append(badge);
  }
  if (task.schedule) {
    const badge = element("span", task.schedule.time ?? scheduleInterval(task.schedule.everyMinutes, "short"), "task-schedule");
    badge.title = scheduleLabel(task.schedule);
    badge.setAttribute("aria-label", badge.title);
    identity.append(badge);
  }
  meta.append(identity);
  const runStatus = element("span", undefined, "task-run-status");
  renderAgentRunStatus(runStatus, task);
  if (!runStatus.hidden) meta.append(runStatus);
  if (task.unfinishedDependencies?.length && task.status === "draft") {
    meta.append(taskIndicator("link", task.unfinishedDependencies.length,
      language("Unfinished dependencies", "Незавершённые зависимости"), "dependency-warning"));
  }
  if (block && !manualWait) {
    item.append(blockerBanner(block));
  }
  if (task.subtasks?.length) {
    const count = task.subtasks.filter(entry => entry.done).length + "/" + task.subtasks.length;
    const subtasks = element("span", undefined, "task-stat");
    subtasks.title = language("Subtasks", "Подзадачи") + " " + count;
    subtasks.append(icon("checklist"), count);
    meta.append(subtasks);
  }
  if (task.attachments?.length) {
    const attachments = element("span", undefined, "task-stat");
    attachments.title = language("Attachments", "Вложения") + " " + task.attachments.length;
    attachments.append(icon("attach"), String(task.attachments.length));
    meta.append(attachments);
  }
  item.append(meta);
  card.replaceChildren(item);
  boardCards.set(task.id, { node: card, signature });
  return card;
}

function syncChildren(target, children) {
  // Keep matching nodes in place; move connected cards without resetting their browser state.
  let cursor = target.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else if (child.isConnected && target.isConnected) target.moveBefore(child, cursor);
    else target.insertBefore(child, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    for (const details of cursor.querySelectorAll(".task-card-details")) cardCovers.unobserve(details);
    cursor.remove();
    cursor = next;
  }
  for (const child of children) {
    const image = child.querySelector(".task-card-cover");
    if (image && !image.getAttribute("src")) cardCovers.observe(image.parentElement);
  }
}

function resetBoardRendering() {
  cardCovers.disconnect();
  laneSizes.disconnect();
  boardCards.clear();
  boardLanes.clear();
  byId("lanes").replaceChildren();
  byId("archive-list").replaceChildren();
  byId("board-composer").firstChild?.dispose?.();
  byId("board-composer").replaceChildren();
}

function switchBoardRendering(previousProject, project) {
  cardCovers.disconnect();
  laneSizes.disconnect();
  const previousComposer = byId("board-composer").firstChild;
  previousComposer?.closeMentions?.();
  previousComposer?.cancelDictation?.();
  previousComposer?.closeQuestion?.();
  if (previousProject && (boardCards.size || boardLanes.size)) {
    boardViews.set(previousProject, {
      cards: boardCards, lanes: boardLanes, covers: cardCoverCache, preferences: lanePreferences,
      columns: [...byId("lanes").childNodes], archive: [...byId("archive-list").childNodes],
      composer: [...byId("board-composer").childNodes],
    });
  }
  const saved = boardViews.get(project);
  boardCards = saved?.cards ?? new Map();
  boardLanes = saved?.lanes ?? new Map();
  cardCoverCache = saved?.covers ?? new Map();
  byId("lanes").replaceChildren(...(saved?.columns ?? []));
  byId("archive-list").replaceChildren(...(saved?.archive ?? []));
  byId("board-composer").replaceChildren(...(saved?.composer ?? []));
  previousComposer?.syncPrompt?.();
  return saved?.preferences;
}

function codexTaskAction(task) {
  const generation = projectGeneration;
  const newThread = task.status === "blocked" && /already has an active writer/i.test(task.blocked?.reason ?? "");
  const missingThread = task.status === "blocked" && task.codexThreadId &&
    task.blocked?.reason === "no rollout found for thread id " + task.codexThreadId;
  if (task.status !== "ready" && task.status !== "in_progress" && !newThread && !missingThread) return null;
  const label = newThread ? language("Continue in a new chat", "Продолжить в новом чате") : missingThread || task.status === "in_progress" || task.git
    ? language("Continue", "Продолжить")
    : language("Send to work", "Передать в работу");
  const launch = button(label, async () => {
    launch.disabled = true;
    try {
      const result = await api.launchTask(task.id, newThread ? { newThread: true } : undefined);
      if (generation !== projectGeneration) return;
      if (!result.ok) notice(boardError(result.error),
        [language("Starting task", "Запуск задачи"), task.id, projectName()].join(" · "));
      else if (sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
    } finally {
      launch.disabled = Boolean(task.unfinishedDependencies?.length);
    }
  });
  launch.id = "task-launch";
  launch.hidden = frame.runningTasks?.includes(task.id) ?? false;
  launch.disabled = Boolean(task.unfinishedDependencies?.length);
  return launch;
}

function controlLabel(id, label) {
  const control = byId(id);
  const text = control.querySelector("span");
  if (text) text.textContent = label;
  control.title = label;
  control.setAttribute("aria-label", label);
}

function tagChoices(tags, selected) {
  return tags.map(([key, tag]) => {
    const row = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.value = key;
    input.checked = selected.has(key);
    row.append(input, tagBadge(tag.name, tag.color));
    return row;
  });
}

function lanePreferenceKey() {
  return "ai-taskboard:columns:" + frame.project;
}

function loadLanePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(lanePreferenceKey()));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

let laneFitFrame;
const laneSizes = new ResizeObserver(scheduleLaneFit);

function fitLanes(columns) {
  const board = byId("lanes");
  if (board.hidden || !board.clientHeight) return;
  const bottom = board.getBoundingClientRect().top + board.clientHeight;
  const composer = byId("board-composer").getBoundingClientRect();
  for (const lane of columns) {
    const bounds = lane.content.getBoundingClientRect();
    const overlapsComposer = bounds.left < composer.right && bounds.right > composer.left;
    const usableBottom = overlapsComposer ? Math.min(bottom, composer.top) : bottom;
    const visibleHeight = usableBottom - 8 - board.scrollTop - bounds.top;
    lane.tools.fit(visibleHeight * 1.5);
  }
}

function scheduleLaneFit() {
  if (laneFitFrame !== undefined) return;
  laneFitFrame = requestAnimationFrame(() => {
    laneFitFrame = undefined;
    fitLanes(boardLanes.values());
  });
}

function laneTools(state, title, tasks, total, count, content) {
  const saved = lanePreferences[state];
  const selected = new Set(Array.isArray(saved?.tags) ? saved.tags.filter(key => boardTags.has(key)) : []);
  const priorities = ["low", "normal", "high", "urgent"];
  const priority = element("select");
  priority.append(new Option(language("Any priority", "Любой приоритет"), ""),
    ...priorities.map(value => new Option(priorityName(value), value)));
  priority.value = priorities.includes(saved?.priority) ? saved.priority : "";
  let collapsed = saved?.collapsed === true;
  const persist = () => {
    lanePreferences[state] = { tags: [...selected], priority: priority.value, collapsed };
    try {
      localStorage.setItem(lanePreferenceKey(), JSON.stringify({ ...loadLanePreferences(), [state]: lanePreferences[state] }));
    } catch {
      // Preferences stay in this window.
    }
  };
  const toolbar = element("div", undefined, "lane-toolbar");
  const filter = element("details", undefined, "lane-filter");
  const summary = element("summary", undefined, "button quiet");
  const filterLabel = language("Column menu: ", "Меню колонки: ") + title;
  const filterCount = element("span", undefined, "count");
  summary.append(icon("more"), filterCount);
  const options = element("div", undefined, "lane-filter-options");
  const priorityLabel = element("label", undefined, "lane-priority");
  priorityLabel.append(element("span", language("Priority", "Приоритет")), priority);
  const resetLabel = language("Reset column filter", "Сбросить фильтр колонки");
  const reset = button(resetLabel, clearFilters, "quiet");
  options.append(priorityLabel);
  options.append(...tagChoices([...boardTags].sort(([, a], [, b]) => a.name.localeCompare(b.name)), selected));
  options.append(reset);
  filter.append(summary, options);
  options.addEventListener("change", () => {
    selected.clear();
    for (const checkbox of options.querySelectorAll("input:checked")) selected.add(checkbox.value);
    persist();
    updateCards();
  });
  function clearFilters() {
    priority.value = "";
    selected.clear();
    for (const checkbox of options.querySelectorAll("input:checked")) checkbox.checked = false;
    persist();
    updateCards();
    summary.focus();
  }
  const toggle = button("", () => {
    collapsed = !collapsed;
    persist();
    updateCollapse();
    filter.open = false;
    summary.focus();
  }, "quiet lane-collapse");
  toggle.append(icon("chevron"));
  const toggleText = element("span");
  toggle.append(toggleText);
  toggle.setAttribute("aria-controls", content.id);
  function updateCollapse() {
    content.hidden = collapsed;
    if (!collapsed) scheduleLaneFit();
    const label = (collapsed ? language("Expand ", "Развернуть колонку ") : language("Collapse ", "Свернуть колонку ")) + title;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggleText.textContent = collapsed ? language("Expand column", "Развернуть колонку") : language("Collapse column", "Свернуть колонку");
  }
  let empty;
  let matching = [];
  let visibleLimit = 4;
  let manualLimit = 0;
  const more = button("", () => {
    const firstNew = visibleLimit;
    manualLimit = visibleLimit + 4;
    visibleLimit = manualLimit;
    renderBatch();
    if (!more.isConnected) content.children[firstNew]?.focus();
  }, "quiet lane-more");
  function updateCards() {
    matching = tasks.filter(task => (!priority.value || task.priority === priority.value) &&
      (!selected.size || task.tags.some(name => selected.has(tagKey(name)))));
    visibleLimit = Math.max(visibleLimit, focusedCardPosition());
    renderBatch();
    scheduleLaneFit();
    const active = selected.size + Number(Boolean(priority.value));
    const label = matching.length === total ? String(total) : matching.length + language(" of ", " из ") + total;
    if (count.textContent !== label) count.textContent = label;
    if (filterCount.textContent !== String(active)) filterCount.textContent = active;
    filterCount.hidden = active === 0;
    reset.hidden = active === 0;
    summary.title = filterLabel;
    summary.setAttribute("aria-label", active ? filterLabel + " (" + active + ")" : filterLabel);
  }
  function renderBatch() {
    const children = matching.slice(0, visibleLimit).map(card);
    if (matching.length > visibleLimit) {
      const remaining = matching.length - visibleLimit;
      const noun = { one: "задача", few: "задачи", many: "задач", other: "задачи" }[new Intl.PluralRules("ru").select(remaining)];
      more.textContent = language("Show " + remaining + " more tasks", "Ещё " + remaining + " " + noun);
      children.push(more);
    }
    const filtered = selected.size || priority.value;
    if (!matching.length && (total || filtered)) {
      if (!empty) {
        empty = element("div", undefined, "lane-filter-empty");
        empty.append(element("p", language("No matching tasks", "Нет подходящих карточек"), "muted"),
          button(resetLabel, clearFilters, "quiet"));
      }
      empty.querySelector("button").hidden = !filtered;
      children.push(empty);
    }
    syncChildren(content, children);
  }
  function focusedCardPosition() {
    const focused = document.activeElement;
    if (focused?.parentElement !== content || !focused.classList.contains("task-card")) return 0;
    return matching.findIndex(task => boardCards.get(task.id)?.node === focused) + 1;
  }
  function fit(availableHeight) {
    if (collapsed || !matching.length) return;
    const focused = document.activeElement;
    const firstNew = visibleLimit;
    const minimum = Math.min(matching.length, Math.max(1, manualLimit, focusedCardPosition()));
    const fits = () => content.getBoundingClientRect().height <= availableHeight;
    const limit = Math.min(matching.length, Math.max(visibleLimit, minimum));
    if (visibleLimit !== limit) {
      visibleLimit = limit;
      renderBatch();
    }
    while (visibleLimit > minimum && !fits()) {
      visibleLimit--;
      renderBatch();
    }
    while (visibleLimit < matching.length && fits()) {
      visibleLimit++;
      renderBatch();
      if (fits()) continue;
      visibleLimit--;
      renderBatch();
      break;
    }
    if (focused === more && !more.isConnected) content.children[firstNew]?.focus({ preventScroll: true });
  }
  updateCards();
  updateCollapse();
  options.append(toggle);
  toolbar.append(filter);
  return { toolbar, fit, update(nextTasks, nextTotal) {
    tasks = nextTasks;
    total = nextTotal;
    updateCards();
  } };
}

function taskChangeTime(task) {
  const updated = Date.parse(task.updatedAt);
  if (Number.isFinite(updated)) return updated;
  const fallback = Date.parse(task.createdAt ?? task.closedAt);
  return Number.isFinite(fallback) ? fallback : -Infinity;
}

function recentlyUpdatedFirst(a, b) {
  return taskChangeTime(b) - taskChangeTime(a) ||
    b.id.localeCompare(a.id, "en", { numeric: true });
}

function cardLayoutChanges(previousBoard, tasks) {
  const previousTasks = new Map(previousBoard.tasks.map(task => [task.id, task]));
  const archivedIds = new Set(previousBoard.archived.map(task => task.id));
  const affected = new Set();
  const added = [];
  for (const task of tasks) {
    const previous = previousTasks.get(task.id);
    const from = previous && shownStatus(previous);
    const to = shownStatus(task);
    if (from === to) {
      if (taskChangeTime(previous) !== taskChangeTime(task)) affected.add(to);
      continue;
    }
    if (from !== undefined) affected.add(from);
    else if (!archivedIds.has(task.id)) added.push(task.id);
    affected.add(to);
  }
  return { affectedLanes: [...affected].map(state => boardLanes.get(state)).filter(Boolean), added };
}

function captureCardMoves(affectedLanes) {
  const moves = [];
  for (const { content } of affectedLanes) {
    if (content.hidden) continue;
    for (const node of content.children) {
      if (!node.classList.contains("task-card")) continue;
      const before = node.getBoundingClientRect();
      if (before.width) moves.push({ node, content, before, offsetTop: node.offsetTop });
    }
  }
  return moves;
}

function animateCardMoves(moves) {
  // A neighbor can already be moving toward the same position when another task changes lanes.
  const moved = moves.filter(({ node, content, offsetTop }) => node.parentElement !== content || node.offsetTop !== offsetTop);
  // The starting rectangles include any in-flight motion. Measure the new layout without it.
  for (const { node } of moved) {
    node.getAnimations().find(animation => animation.id === "task-card-move")?.cancel();
  }
  const destinations = moved.flatMap(({ node, content, before }) => {
    const after = node.getBoundingClientRect();
    const x = before.left - after.left;
    const y = before.top - after.top;
    const zIndex = node.parentElement === content ? "auto" : "1";
    return after.width && (x || y) ? [{ node, x, y, zIndex }] : [];
  });
  for (const { node, x, y, zIndex } of destinations) {
    node.animate([
      { transform: `translate(${x}px, ${y}px)`, zIndex },
      { transform: "translate(0, 0)", zIndex },
    ], { id: "task-card-move", duration: 360, easing: "cubic-bezier(.22,.8,.25,1)", fill: "backwards" });
  }
}

function render(previousBoard) {
  document.documentElement.lang = frame.russian ? "ru" : "en";
  const board = frame.board;
  const noBoard = !board;
  const loading = Boolean(frame.loading || frame.restoring);
  byId("welcome").hidden = !noBoard || loading;
  byId("app-content").setAttribute("aria-busy", String(noBoard && loading));
  byId("workspace").hidden = noBoard;
  byId("archive-menu-item").setAttribute("aria-disabled", String(noBoard));
  byId("board-settings-menu-item").setAttribute("aria-disabled", String(noBoard));
  controlLabelForIcon(byId("app-settings"), language("Settings and updates", "Настройки и обновления"));
  byId("archive-menu-item").setAttribute("aria-checked", String(archiveView));
  if (!board) {
    resetBoardRendering();
    if (!loading) renderWelcome();
    return;
  }

  const ids = new Set([...board.tasks, ...board.archived].map(task => task.id));
  for (const [id, { node }] of boardCards) {
    if (ids.has(id)) continue;
    const details = node.querySelector(".task-card-details");
    if (details) cardCovers.unobserve(details);
    boardCards.delete(id);
  }

  byId("workspace").setAttribute("aria-label", archiveView ? language("Archive", "Архив") : language("Task board", "Доска задач"));
  byId("lanes").hidden = archiveView;
  byId("archive-list").hidden = !archiveView;
  byId("board-composer").hidden = archiveView;
  if (!byId("board-composer").firstChild) byId("board-composer").append(draftComposer());
  const composer = byId("board-composer").firstChild;
  composer.localize();
  composer.updateManagerRun(frame.managerRun);
  composer.updateManagerWork(frame.managerWork);
  composer.syncManagerUnread(frame.managerUnread);
  if (!archiveView) {
    composer.loadSuggestions();
    composer.revealPinned();
  }
  composer.syncPrompt();
  composer.updateQuestion(frame.managerQuestion);
  if (archiveView) {
    const tasks = [...board.archived].sort(recentlyUpdatedFirst);
    syncChildren(byId("archive-list"), tasks.length ? tasks.map(card) :
      [element("p", language("No archived tasks found.", "Архивных задач не найдено."), "muted")]);
    return;
  }
  const visible = [...board.tasks].sort(recentlyUpdatedFirst);
  const { affectedLanes, added } = previousBoard && !reducedMotion.matches && !document.hidden ?
    cardLayoutChanges(previousBoard, visible) : { affectedLanes: [], added: [] };
  const moves = captureCardMoves(affectedLanes);
  const focused = document.activeElement;
  const toolsKey = JSON.stringify([frame.russian, [...boardTags]]);
  const columns = lanes.map(([state, english, russian]) => {
    const tasks = visible.filter(task => shownStatus(task) === state);
    let lane = boardLanes.get(state);
    if (!lane) {
      const column = element("section", undefined, "lane");
      column.dataset.state = state;
      const header = element("div", undefined, "lane-header");
      const content = element("div", undefined, "lane-cards");
      content.id = "lane-cards-" + state;
      column.append(header, content);
      lane = { column, header, content };
      boardLanes.set(state, lane);
    }
    const title = language(english, russian);
    const total = tasks.length;
    if (lane.toolsKey !== toolsKey) {
      const heading = element("h2", undefined, "lane-title");
      heading.title = title;
      const count = element("span", undefined, "count");
      heading.append(element("span", title), count);
      lane.tools = laneTools(state, title, tasks, total, count, lane.content);
      lane.header.replaceChildren(heading, lane.tools.toolbar);
      lane.toolsKey = toolsKey;
    } else lane.tools.update(tasks, total);
    return lane.column;
  });
  const boardViewport = byId("lanes");
  syncChildren(boardViewport, columns);
  laneSizes.observe(boardViewport);
  laneSizes.observe(byId("board-composer"));
  for (const lane of boardLanes.values()) laneSizes.observe(lane.column);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  // An incoming card can temporarily push a visible neighbor out of the current batch.
  if (affectedLanes.length) fitLanes(affectedLanes);
  animateCardMoves(moves);
  for (const id of added) {
    const node = boardCards.get(id)?.node;
    if (!node?.getClientRects().length) continue;
    node.animate([{ opacity: 0 }, { opacity: 1 }],
      { id: "task-card-enter", duration: 280, easing: "ease-out", fill: "backwards" });
  }
}

function renderWelcome() {
  const loading = Boolean(frame.loading);
  byId("welcome").setAttribute("aria-busy", String(loading));
  byId("welcome-start").textContent = language("Start", "Запуск");
  byId("welcome-recent").textContent = language("Recent boards", "Последние доски");
  controlLabel("welcome-create", language("Create board", "Создать доску"));
  controlLabel("welcome-open", language("Open existing board", "Открыть существующую доску"));
  byId("welcome-create").disabled = loading;
  byId("welcome-open").disabled = loading;
  const recent = frame.recentBoards ?? [];
  byId("recent-empty").hidden = recent.length > 0;
  byId("recent-empty").textContent = language("No recent boards yet.", "Пока нет недавних досок.");
  byId("recent-boards").replaceChildren(...recent.map(({ name, path }) => {
    const row = element("li");
    const open = button("", () => api.openRecent(path), "welcome-link recent-board");
    open.disabled = loading;
    open.append(element("span", name), element("span", path, "muted"));
    row.append(open);
    return row;
  }));
}

const lineList = value => value.split("\n").map(line => line.trim()).filter(Boolean);
const shortDate = value => new Date(value).toLocaleString(frame.russian ? "ru" : undefined);
const priorityName = value => ({
  low: language("Low", "Низкий"), normal: language("Normal", "Обычный"),
  high: language("High", "Высокий"), urgent: language("Urgent", "Срочный"),
})[value] || value;

function form(kind, title, fields, label, submit) {
  openSheet(kind, title);
  const form = element("form", undefined, "form");
  const inputs = {};
  for (const field of fields) {
    const row = element("label", field.label);
    const input = element(field.type === "area" ? "textarea" : field.options ? "select" : "input");
    if (field.options) {
      for (const [value, label] of field.options) {
        const option = element("option", label);
        option.value = value;
        input.append(option);
      }
    } else if (field.type !== "area") input.type = field.type || "text";
    input.name = field.name;
    if (field.type === "number") input.min = "0";
    input.required = Boolean(field.required);
    if (field.type === "checkbox") {
      input.checked = Boolean(field.value);
      row.classList.add("form-checkbox");
      row.prepend(input);
    } else {
      input.value = field.value ?? "";
      row.append(input);
    }
    inputs[field.name] = input;
    form.append(row);
  }
  const save = element("button", label, "button primary");
  save.type = "submit";
  form.append(save);
  const saveFields = protect(async () => {
    try {
      await submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) =>
        [key, input.type === "checkbox" ? input.checked : input.value])));
    } finally { save.disabled = false; }
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    saveFields();
  });
  body.append(form);
  return form;
}

function managerQuestionDialog(question, trigger) {
  const dialog = element("dialog", undefined, "sheet manager-question");
  const title = element("h2", language("Question from the project manager", "Вопрос менеджера проекта"));
  title.id = "manager-question-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const close = button("", () => dialog.close(), "quiet icon-button");
  close.append(icon("close"));
  controlLabelForIcon(close, language("Close question", "Закрыть вопрос"));
  const header = element("header", undefined, "sheet-header");
  header.append(title, close);
  const form = element("form", undefined, "sheet-body form");
  const prompt = element("p", question.text, "manager-question-text");
  prompt.id = "manager-question-text";
  dialog.setAttribute("aria-describedby", prompt.id);
  const choices = element("div", undefined, "manager-question-options");
  const label = element("label", language("Your answer", "Ваш ответ"));
  const input = element("textarea");
  input.maxLength = 4000;
  label.append(input);
  const error = element("p", "", "chat-status");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = element("div", undefined, "sheet-actions");
  const submit = element("button", language("Send answer", "Отправить ответ"), "button primary");
  submit.type = "submit";
  const skip = button(language("Skip question", "Пропустить вопрос"), () => send(null), "quiet");
  actions.append(submit, skip);
  const options = question.options.map(value => button(value, () => send(value), "quiet"));
  choices.append(...options);
  const controls = [close, skip, ...options];
  let sending = false;
  const validate = () => { submit.disabled = sending || !input.value.trim(); };
  async function send(answer) {
    if (sending || !dialog.open) return;
    sending = true;
    for (const control of controls) control.disabled = true;
    input.readOnly = true;
    error.hidden = true;
    validate();
    try {
      const result = await api.answerBoardQuestion(question.id, answer);
      if (!result.ok) throw new Error(boardError(result.error));
      if (dialog.open) dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      sending = input.readOnly = false;
      for (const control of controls) control.disabled = false;
      validate();
    }
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (input.value.trim()) void send(input.value.trim());
  });
  input.addEventListener("input", validate);
  validate();
  form.append(prompt);
  if (options.length) form.append(choices);
  form.append(label, error, actions);
  dialog.append(header, form);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger.isConnected && !trigger.hidden) trigger.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const activityRowKey = id => id.replace(/^final:/, "message:").replace(/^group:/, "item:");

function chatViewport(list) {
  const rows = "[data-item], [data-chat-anchor]";
  const key = row => row.dataset.chatAnchor ?? activityRowKey(row.dataset.item);
  const rowBounds = row => (row.matches("details") ? row.firstElementChild ?? row : row).getBoundingClientRect();
  const visible = row => row.checkVisibility({ visibilityProperty: true });
  const hasViewport = () => list.clientHeight && visible(list);
  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight <= 1;
  let position = { end: true, top: 0, anchors: [] };
  let restoredTop;
  function remember() {
    if (!hasViewport()) return;
    const top = list.getBoundingClientRect().top;
    const end = atEnd();
    const anchors = [];
    if (!end) {
      for (const row of list.querySelectorAll(rows)) {
        if (!visible(row)) continue;
        const bounds = rowBounds(row);
        if (bounds.height && bounds.bottom > top && bounds.top < top + list.clientHeight) {
          anchors.push({ node: row, key: key(row), offset: bounds.top - top });
          if (anchors.length === 4) break;
        }
      }
    }
    position = { end, top: list.scrollTop, anchors };
    restoredTop = list.scrollTop;
  }
  function restore() {
    if (!hasViewport()) return;
    if (position.end) list.scrollTop = list.scrollHeight;
    else {
      const candidates = [...list.querySelectorAll(rows)];
      let top = position.top;
      for (const anchor of position.anchors) {
        const connected = list.contains(anchor.node);
        const row = connected ? anchor.node : candidates.find(candidate => key(candidate) === anchor.key);
        if (!row) continue;
        if (!connected && !visible(row)) {
          for (let fold = row.parentElement.closest(".chat-work"); fold; fold = fold.parentElement.closest(".chat-work")) fold.open = true;
        }
        if (!visible(row) || !rowBounds(row).height) continue;
        top = list.scrollTop + rowBounds(row).top - list.getBoundingClientRect().top - anchor.offset;
        break;
      }
      list.scrollTop = top;
    }
    remember();
  }
  const resize = new ResizeObserver(restore);
  resize.observe(list);
  const observed = new Set();
  function observeRows() {
    const children = new Set(list.children);
    for (const child of observed) if (!children.has(child)) resize.unobserve(child);
    for (const child of children) if (!observed.has(child)) resize.observe(child);
    observed.clear();
    for (const child of children) observed.add(child);
  }
  list.addEventListener("scroll", () => {
    if (list.scrollTop !== restoredTop) remember();
  });
  return {
    atEnd,
    restore,
    remember,
    followEnd() {
      position.end = true;
      restore();
    },
    update(change) {
      remember();
      change();
      observeRows();
      restore();
    },
    dispose: () => resize.disconnect(),
  };
}

function draftComposer() {
  const project = frame.project;
  const files = [];
  const queued = [];
  let savingQueuedMessage = false;
  let sendingQueuedMessage = false;
  let active;
  let managerRun;
  let managerWork;
  let startingWork = false;
  let disposed = false;
  const editor = element("form", undefined, "board-draft");
  editor.id = "board-draft";
  editor.setAttribute("aria-busy", "false");
  const chat = element("section", undefined, "board-chat");
  chat.addEventListener("animationend", event => {
    if (event.animationName === "board-chat-enter") event.target.removeAttribute("data-enter");
    if (event.animationName === "board-chat-text-fade") event.target.classList.remove("chat-stream-fragment");
  });
  chat.id = "board-chat";
  const bar = element("div", undefined, "board-chat-bar");
  const resize = element("div", undefined, "board-chat-resize");
  resize.tabIndex = 0;
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-orientation", "horizontal");
  resize.setAttribute("aria-controls", chat.id);
  resize.append(element("span"));
  const preferencesKey = "taskboard.orchestrator:" + project;
  let preferences;
  try { preferences = JSON.parse(localStorage.getItem(preferencesKey)); } catch {}
  let pinned = preferences?.pinned === true;
  let height = Number.isFinite(preferences?.height) ? preferences.height : undefined;
  let prompts = [];
  let promptIndex = -1;
  let suggestionsLanguage;
  let waitingForChat = false;
  let canStop = false;
  let stopping = false;
  let goalMode = false;
  let dictation;
  const persist = () => {
    try { localStorage.setItem(preferencesKey, JSON.stringify({ pinned, height })); } catch {}
  };
  const pin = button("", () => {
    pinned = !pinned;
    editor.setAttribute("data-open", "");
    updatePin();
    syncPrompt();
    persist();
  }, "quiet board-chat-pin");
  const updatePin = () => {
    editor.toggleAttribute("data-pinned", pinned);
    pin.setAttribute("aria-pressed", String(pinned));
    pin.replaceChildren(icon(pinned ? "pinned" : "pin"));
    controlLabelForIcon(pin, pinned ? language("Unpin chat", "Открепить чат") : language("Pin chat", "Закрепить чат"));
  };
  const resizeChat = next => {
    const limit = Math.max(0, window.innerHeight - 160);
    const min = Math.min(160, limit);
    height = Math.round(Math.min(limit, Math.max(min, next)));
    editor.style.setProperty("--board-chat-height", height + "px");
    resize.setAttribute("aria-valuemin", String(Math.round(min)));
    resize.setAttribute("aria-valuemax", String(Math.round(limit)));
    resize.setAttribute("aria-valuenow", String(height));
  };
  if (height !== undefined) editor.style.setProperty("--board-chat-height", height + "px");
  resize.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const y = event.clientY;
    const initialHeight = chat.getBoundingClientRect().height;
    editor.setAttribute("data-resizing", "");
    resize.setPointerCapture(event.pointerId);
    resize.onpointermove = move => resizeChat(initialHeight + y - move.clientY);
  });
  const finishResize = () => {
    if (!editor.hasAttribute("data-resizing")) return;
    editor.removeAttribute("data-resizing");
    resize.onpointermove = null;
    persist();
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) resize.addEventListener(event, finishResize);
  resize.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resizeChat(chat.getBoundingClientRect().height + (event.key === "ArrowUp" ? 24 : -24));
    persist();
  });
  const views = element("div", undefined, "board-chat-views");
  const dialogueToggle = button("", () => showWork(false), "quiet board-dialogue-toggle");
  const workToggle = button("", () => showWork(true), "quiet board-work-toggle");
  dialogueToggle.setAttribute("aria-pressed", "true");
  workToggle.setAttribute("aria-pressed", "false");
  views.append(dialogueToggle, workToggle);
  bar.append(views, resize, pin);
  let currentGoal;
  let goalRunning = false;
  let goalRevision = 0;
  let changingGoal = false;
  const goalPanel = element("details", undefined, "board-goal");
  goalPanel.hidden = true;
  const goalSummary = element("summary");
  const goalHeading = element("span", undefined, "board-goal-heading");
  const goalStatus = element("span", undefined, "board-goal-status");
  goalStatus.setAttribute("role", "status");
  const goalTitle = element("span", undefined, "board-goal-title");
  goalHeading.append(icon("target"), goalStatus, goalTitle);
  goalSummary.append(goalHeading);
  const goalBody = element("div", undefined, "board-goal-body");
  const goalText = element("textarea");
  goalText.rows = 2;
  const goalError = element("div", undefined, "board-goal-error");
  goalError.setAttribute("role", "alert");
  const goalActions = element("div", undefined, "board-goal-actions");
  const saveGoal = button("", () => changeGoal("edit", goalText.value.trim()), "quiet");
  const pauseGoal = button("", () => changeGoal("pause"), "quiet");
  const resumeGoal = button("", () => {
    if (!currentGoal || resumeGoal.hidden || resumeGoal.disabled) return;
    goalError.textContent = "";
    void restoreQueue().then(() => {
      if (disposed || !currentGoal || resumeGoal.hidden || resumeGoal.disabled) return;
      const entry = element("div");
      entry.hidden = true;
      queued.unshift({ entry, status: element("span"), request: "", goal: "resume", submitted: [] });
      sendNext();
    }).catch(() => {});
  }, "quiet");
  const clearGoal = button("", () => changeGoal("clear"), "quiet danger");
  goalActions.append(saveGoal, pauseGoal, resumeGoal, clearGoal);
  goalBody.append(goalText, goalActions, goalError);
  goalPanel.append(goalSummary, goalBody);
  const goalLabels = {
    active: ["Active goal", "Активная цель"], paused: ["Goal paused", "Цель на паузе"],
    blocked: ["Goal blocked", "Цель заблокирована"], complete: ["Goal completed", "Цель выполнена"],
    usageLimited: ["Usage limit reached", "Достигнут лимит Codex"], budgetLimited: ["Token budget reached", "Исчерпан бюджет токенов"],
  };
  const syncGoal = () => {
    if (!currentGoal) return;
    const waitingToResume = currentGoal.status === "active" && !goalRunning;
    goalStatus.textContent = waitingToResume ? language("Goal awaiting continuation", "Цель ждёт продолжения") :
      language(...(goalLabels[currentGoal.status] ?? ["Goal", "Цель"]));
    goalPanel.dataset.status = waitingToResume ? "idle" : currentGoal.status;
    pauseGoal.hidden = currentGoal.status !== "active" || waitingToResume;
    resumeGoal.hidden = currentGoal.status === "complete" || !pauseGoal.hidden;
    resumeGoal.disabled = changingGoal || Boolean(managerWork) || startingWork;
    saveGoal.disabled = changingGoal || !goalText.value.trim() || goalText.value.trim() === currentGoal.objective;
    pauseGoal.disabled = clearGoal.disabled = changingGoal;
  };
  const showGoal = goal => {
    const wasEditing = currentGoal && goalText.value !== currentGoal.objective;
    if (!wasEditing || !goal) goalText.value = goal?.objective ?? "";
    currentGoal = goal;
    goalPanel.hidden = !goal;
    if (!goal) goalPanel.open = false;
    goalTitle.textContent = goal?.objective ?? "";
    goalTitle.title = goalTitle.textContent;
    syncGoal();
  };
  editor.updateGoal = (goal, running) => {
    goalRevision++;
    if (running !== undefined) goalRunning = running;
    if (goal !== undefined) showGoal(goal);
    else syncGoal();
  };
  goalText.addEventListener("input", syncGoal);
  async function changeGoal(kind, objective) {
    if (changingGoal) return;
    changingGoal = true;
    goalError.textContent = "";
    const revision = goalRevision;
    syncGoal();
    try {
      const result = await api.boardGoal(kind, objective);
      if (!result.ok) throw new Error(boardError(result.error));
      if (kind === "edit" && goalText.value.trim() === objective) goalText.value = result.data?.objective ?? "";
      if (revision === goalRevision) editor.updateGoal(result.data);
    } catch (error) {
      goalError.textContent = error.message;
    } finally {
      changingGoal = false;
      syncGoal();
    }
  }
  const log = element("div", undefined, "board-chat-log");
  const dialogueViewport = chatViewport(log);
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.tabIndex = 0;
  const unreadDivider = element("div", undefined, "board-chat-unread");
  let unread = new Set(frame.managerUnread ?? []);
  let readFrame;
  let readingMessages = false;
  function updateUnreadMessages() {
    let first;
    for (const bubble of log.querySelectorAll(".board-manager-message[data-message-id]")) {
      const read = !unread.has(bubble.dataset.messageId);
      bubble.dataset.read = String(read);
      if (!read && !first) first = bubble;
    }
    if (first && unreadDivider.nextElementSibling !== first) first.before(unreadDivider);
    return first;
  }
  function readVisibleMessages() {
    if (!api.readManagerMessages || !unread.size || readFrame || readingMessages) return;
    readFrame = requestAnimationFrame(async () => {
      readFrame = undefined;
      if (disposed || loadingHistory || !editor.isConnected || frame.project !== project || document.hidden ||
          !document.hasFocus() || document.querySelector("dialog:modal") || !editor.matches("[data-open], [data-pinned]") ||
          !log.checkVisibility({ visibilityProperty: true }) || !log.clientHeight) return;
      const viewport = log.getBoundingClientRect();
      const ids = [...log.querySelectorAll('.board-manager-message[data-read="false"]')].filter(bubble => {
        const bounds = bubble.getBoundingClientRect();
        return bounds.top >= viewport.top - 1 && bounds.top + Math.min(bounds.height, 28) <= viewport.bottom;
      }).slice(0, 200).map(bubble => bubble.dataset.messageId);
      if (!ids.length) return;
      readingMessages = true;
      try {
        const result = await api.readManagerMessages(project, ids);
        if (result.ok) {
          for (const id of ids) unread.delete(id);
          dialogueViewport.update(updateUnreadMessages);
        }
      } catch {
        // Leave the messages unread so the next viewport update can retry.
      } finally {
        readingMessages = false;
      }
    });
  }
  editor.syncManagerUnread = ids => {
    if (ids && (ids.length !== unread.size || ids.some(id => !unread.has(id)))) {
      unread = new Set(ids);
      dialogueViewport.update(updateUnreadMessages);
    }
    readVisibleMessages();
  };
  let positionNewDialogue = false;
  function showDialoguePosition() {
    if (positionNewDialogue && log.clientHeight && log.checkVisibility({ visibilityProperty: true })) {
      positionNewDialogue = false;
      if (updateUnreadMessages()) {
        log.scrollTop += unreadDivider.getBoundingClientRect().top - log.getBoundingClientRect().top;
        lastScrollTop = log.scrollTop;
        dialogueViewport.remember();
      } else dialogueViewport.followEnd();
    }
    readVisibleMessages();
  }
  const readObserver = new ResizeObserver(showDialoguePosition);
  readObserver.observe(log);
  const work = element("section", undefined, "board-chat-log board-work");
  const workViewport = chatViewport(work);
  work.hidden = true;
  work.tabIndex = 0;
  const workOverview = element("div", undefined, "board-work-overview");
  const workSaved = element("div", undefined, "board-work-timeline");
  const workLive = element("div", undefined, "board-work-timeline");
  const liveGoal = element("div", undefined, "chat-run");
  const liveChat = element("div", undefined, "chat-run");
  const workError = element("p", undefined, "muted");
  workError.hidden = true;
  const workOlder = button(language("Earlier activity", "Более ранние события"), () => void loadWork(workCursor), "quiet board-chat-older");
  workOlder.hidden = true;
  workLive.append(liveGoal, liveChat);
  work.append(workOverview, workOlder, workSaved, workLive, workError);
  let workCursor;
  let workLoading = false;
  let workReload = false;
  let workLivePending = false;
  let workLiveDirty = false;
  let liveWorkItems;
  let savedWorkItems = new Set();
  let hasWorkHistory = false;
  let loadedOlderWork = false;
  let activeReviewers = {};
  function renderWorkOverview() {
    if (work.hidden || frame.project !== project) return;
    const rows = [];
    const workStatus = item => item ? runningLabel(item).status : language("Working…", "Работает…");
    if (managerWork) {
      const time = managerWork.startedAt ? new Date(managerWork.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const detail = managerWork.phase === "running" ? workStatus(managerWork.item) :
        managerWork.phase === "waiting" ? language("Waiting for a session…", "Ждёт освобождения сеанса…") :
          language("Starting…", "Запускается…");
      const row = element("div", [language("Manager", "Менеджер"), detail, time].filter(Boolean).join(" · "), "board-work-row");
      row.dataset.chatAnchor = "overview:manager";
      rows.push(row);
    }
    const reviewing = frame.reviewingTasks ?? {};
    const ids = new Set([...(frame.runningTasks ?? []), ...Object.keys(reviewing)]);
    for (const id of ids) {
      const title = frame.board?.tasks.find(task => task.id === id)?.title;
      const link = button(id + (title ? " · " + title : ""), protect(async () => {
        await showTask(id);
        if (reviewing[id] !== "reviewer") return;
        const reviewer = byId("task-reviewer-chat");
        if (reviewer) {
          reviewer.open = true;
          reviewer.scrollIntoView({ block: "nearest" });
        }
      }), "quiet board-chat-task");
      const status = reviewing[id] === "reviewer" ? language("Reviewer", "Ревьюер") + " · " + workStatus(activeReviewers[id]?.item) :
        reviewing[id] === "manager" ? language("Manager is reviewing", "Менеджер проверяет") :
          language("Executor", "Исполнитель") + " · " + workStatus(frame.runActivity?.[id]?.findLast(item => item.status === "inProgress"));
      const row = element("div", undefined, "board-work-row");
      row.dataset.chatAnchor = "overview:" + id;
      row.append(link, element("span", status));
      rows.push(row);
    }
    if (!rows.length) rows.push(element("div", language("No active agents", "Сейчас агенты не работают"), "muted"));
    if (workOverview.textContent !== rows.map(row => row.textContent).join("")) {
      workViewport.update(() => workOverview.replaceChildren(...rows));
    }
  }
  function renderLiveWork() {
    if (!liveWorkItems) return;
    const seenMessages = new Set([...workSaved.querySelectorAll("[data-coordination-key]")].map(node => node.dataset.coordinationKey));
    const pending = items => items.filter(item => !savedWorkItems.has(item.id));
    renderActivity(liveGoal, pending(liveWorkItems.work), false, { seenMessages });
    renderActivity(liveChat, pending(liveWorkItems.chat), false, { seenMessages });
  }
  async function loadWork(cursor = null) {
    if (disposed || work.hidden) return;
    if (workLoading) {
      if (!cursor) workReload = true;
      return;
    }
    workLoading = true;
    workOlder.disabled = true;
    try {
      const result = await api.boardHistory(project, cursor, "work");
      if (disposed || work.hidden) return;
      if (!result.ok) throw new Error(boardError(result.error));
      if (!cursor && loadedOlderWork && !workViewport.atEnd()) {
        workReload = true;
        return;
      }
      const seen = new Set(cursor ? [...workSaved.querySelectorAll("[data-coordination-key]")].map(node => node.dataset.coordinationKey) : []);
      const page = document.createDocumentFragment();
      const saved = new Set(cursor ? savedWorkItems : []);
      const previous = !cursor && hasWorkHistory &&
        new Set([...work.querySelectorAll("[data-item]")].map(row => activityRowKey(row.dataset.item)));
      for (const turn of result.data.turns) {
        for (const { text, files, clientId, at } of turn.messages) page.append(chatMessage("user", text, files, false, false, clientId, at));
        if (!turn.items.length) continue;
        for (const item of turn.items) saved.add(item.id);
        const run = element("div", undefined, "chat-run");
        renderRunActivity(run, turn.items, true, turn.durationMs, undefined, { seenMessages: seen });
        if (previous) {
          for (const row of run.querySelectorAll("[data-item]")) {
            if (!previous.has(activityRowKey(row.dataset.item))) row.setAttribute("data-enter", "");
          }
        }
        for (const item of run.querySelectorAll("[data-coordination-key]")) seen.add(item.dataset.coordinationKey);
        if (!run.hidden) page.append(run);
      }
      workViewport.update(() => {
        if (cursor) workSaved.prepend(page);
        else workSaved.replaceChildren(page);
        loadedOlderWork = Boolean(cursor);
        savedWorkItems = saved;
        workCursor = result.data.nextCursor;
        workOlder.hidden = !workCursor;
        workError.hidden = true;
        renderLiveWork();
      });
      if (!hasWorkHistory) workViewport.followEnd();
      hasWorkHistory = true;
      editor.refreshWork();
    } catch (error) {
      if (!disposed) {
        workViewport.update(() => {
          workError.textContent = error.message;
          workError.hidden = false;
          renderLiveWork();
        });
      }
    } finally {
      workLoading = false;
      workOlder.disabled = false;
      if (workReload && (!loadedOlderWork || workViewport.atEnd())) {
        workReload = false;
        void loadWork();
      }
    }
  }
  function showWork(show) {
    if (show === !work.hidden) return;
    work.hidden = !show;
    log.hidden = show;
    dialogueToggle.setAttribute("aria-pressed", String(!show));
    workToggle.setAttribute("aria-pressed", String(show));
    if (!show) {
      dialogueViewport.restore();
      dialogueViewport.update(updateUnreadMessages);
      showDialoguePosition();
      return;
    }
    dialogueViewport.update(() => unreadDivider.remove());
    workViewport.restore();
    renderWorkOverview();
    editor.invalidateWork();
    editor.refreshWork();
  }
  editor.invalidateWork = () => {
    if (work.hidden) return;
    if (loadedOlderWork && !workViewport.atEnd()) workReload = true;
    else void loadWork();
  };
  work.addEventListener("scroll", () => {
    if (workReload && !workLoading && workViewport.atEnd()) {
      workReload = false;
      void loadWork();
    }
  });
  editor.refreshWork = async () => {
    if (disposed || work.hidden || !editor.matches("[data-open], [data-pinned]")) return;
    if (workLivePending) {
      workLiveDirty = true;
      return;
    }
    workLivePending = true;
    try {
      const result = await api.boardHistory(project, null, "live");
      if (disposed || work.hidden || !result.ok) return;
      activeReviewers = result.data.reviewers ?? {};
      renderWorkOverview();
      liveWorkItems = result.data;
      if (!workLoading) workViewport.update(renderLiveWork);
    } catch {
      // The next activity update will refresh the panel.
    } finally {
      workLivePending = false;
      if (workLiveDirty) {
        workLiveDirty = false;
        void editor.refreshWork();
      }
    }
  };
  const disclosures = new WeakMap();
  log.addEventListener("click", event => {
    const detail = event.target.closest("summary")?.parentElement;
    if (detail?.tagName !== "DETAILS" || reducedMotion.matches) return;
    event.preventDefault();
    const from = detail.getBoundingClientRect().height;
    const previous = disclosures.get(detail);
    previous?.animation.cancel();
    const open = previous ? !previous.open : !detail.open;
    detail.open = open;
    const to = detail.getBoundingClientRect().height;
    detail.open = true;
    const animation = detail.animate([
      { height: from + "px", overflow: "clip" },
      { height: to + "px", overflow: "clip" },
    ], { duration: 180, easing: "cubic-bezier(.2,.75,.25,1)" });
    disclosures.set(detail, { animation, open });
    animation.onfinish = () => {
      detail.open = open;
      disclosures.delete(detail);
    };
  });
  const greeting = element("p", undefined, "muted");
  const olderHistory = button("", () => loadOlderHistory(), "quiet board-chat-older");
  olderHistory.hidden = true;
  const queue = element("div", undefined, "board-chat-queue");
  queue.setAttribute("role", "list");
  log.append(olderHistory, greeting);
  chat.append(bar, goalPanel, log, work, queue);
  const input = element("textarea");
  input.name = "request";
  input.rows = 1;
  input.placeholder = " ";
  input.setAttribute("aria-controls", chat.id);
  const prompt = element("span", undefined, "draft-placeholder");
  prompt.setAttribute("aria-hidden", "true");
  const hint = element("p", undefined, "muted draft-hint");
  hint.id = "board-paste-hint";
  input.setAttribute("aria-describedby", hint.id);
  const controls = element("div", undefined, "draft-controls");
  const picker = element("input");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  const add = element("button", undefined, "button quiet draft-add");
  add.type = "button";
  add.append(icon("add"));
  const menu = element("div", undefined, "draft-add-menu");
  menu.popover = "auto";
  add.popoverTargetElement = menu;
  const menuHeading = element("div", undefined, "draft-menu-heading muted");
  const menuActions = element("div", undefined, "draft-menu-actions");
  const taskPicker = element("div", undefined, "draft-task-picker");
  taskPicker.hidden = true;
  const taskSearch = element("input");
  taskSearch.type = "search";
  const taskResults = element("div", undefined, "draft-task-results");
  taskPicker.append(taskSearch, taskResults);
  const menuItem = (glyph, onClick) => {
    const item = button("", onClick, "quiet draft-menu-item");
    item.append(icon(glyph), element("span"));
    return item;
  };
  const pickFiles = menuItem("file", () => {
    menu.hidePopover();
    picker.click();
  });
  const pickTasks = menuItem("tasklist", () => {
    menuActions.hidden = true;
    taskPicker.hidden = false;
    taskSearch.value = "";
    renderTaskResults();
    taskSearch.focus();
  });
  const pickGoal = menuItem("target", () => {
    menu.hidePopover();
    setGoalMode(!goalMode);
    input.focus();
  });
  menuActions.append(pickFiles, pickTasks, pickGoal);
  menu.append(menuHeading, menuActions, taskPicker);
  menu.addEventListener("beforetoggle", event => {
    if (event.newState !== "open") return;
    menuActions.hidden = false;
    taskPicker.hidden = true;
  });
  taskSearch.addEventListener("input", renderTaskResults);
  function findDraftTasks(query, limit) {
    query = query.trim().toLocaleLowerCase();
    const number = /^(?:t-)?(\d+)$/.exec(query)?.[1]?.replace(/^0+(?=\d)/, "");
    const tasks = [...(frame.board?.tasks ?? []), ...(frame.board?.archived ?? [])];
    if (number === undefined) return tasks.filter(task => (task.id + " " + task.title).toLocaleLowerCase().includes(query)).slice(0, limit);
    const shortId = task => task.id.slice(2).replace(/^0+(?=\d)/, "");
    const exact = tasks.filter(task => shortId(task) === number);
    const partial = tasks.filter(task => shortId(task) !== number && shortId(task).startsWith(number));
    return [...exact, ...partial].slice(0, limit);
  }
  function renderTaskResults() {
    const matches = findDraftTasks(taskSearch.value, 50);
    taskResults.replaceChildren(...matches.map(task => button(task.id + " · " + task.title, () => {
      menu.hidePopover();
      insertDraftText(task.id);
    }, "quiet draft-menu-item")));
    if (!matches.length) taskResults.append(element("p", language("No tasks found", "Задачи не найдены"), "draft-menu-heading muted"));
  }
  function insertDraftText(text, range) {
    const { start, end } = range ?? { start: input.selectionStart, end: input.selectionEnd };
    const leading = !range && start > 0 && /\S/.test(input.value[start - 1]) ? " " : "";
    const trailing = end === input.value.length || (!range && /\S/.test(input.value[end])) ? " " : "";
    input.setRangeText(leading + text + trailing, start, end, "end");
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const mentions = element("div", undefined, "draft-task-mentions draft-task-results");
  mentions.id = "board-task-mentions";
  mentions.popover = "manual";
  mentions.setAttribute("role", "listbox");
  let mention;
  let dismissedMention;
  let mentionIndex = 0;
  function closeMentions() {
    if (mentions.matches(":popover-open")) mentions.hidePopover();
    input.setAttribute("aria-controls", chat.id);
    input.removeAttribute("aria-activedescendant");
    mention = undefined;
  }
  editor.closeMentions = closeMentions;
  function highlightMention(index) {
    mentionIndex = index;
    for (const [i, option] of [...mentions.children].entries()) option.setAttribute("aria-selected", String(i === index));
    const option = mentions.children[index];
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  }
  function syncMentions(event) {
    if (event?.isComposing || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return closeMentions();
    const caret = input.selectionStart;
    const match = /(?:^|[\s(\[{])(@(?:t-?)?\d*)$/i.exec(input.value.slice(0, caret));
    if (!match) {
      dismissedMention = undefined;
      closeMentions();
      return;
    }
    const start = caret - match[1].length;
    const suffix = /^(?:t-?)?\d*(?![\p{L}\p{N}_-])/iu.exec(input.value.slice(caret));
    if (!suffix) return closeMentions();
    const end = caret + suffix[0].length;
    const key = start + ":" + input.value.slice(start, end);
    if (key === mention?.key) return;
    if (key === dismissedMention) return closeMentions();
    dismissedMention = undefined;
    const tasks = findDraftTasks(input.value.slice(start + 1, end), 8);
    if (!tasks.length) return closeMentions();
    mention = { key, start, end, tasks };
    mentions.replaceChildren(...tasks.map((task, index) => {
      const option = element("div", task.id + " · " + task.title, "draft-menu-item draft-mention-option");
      option.id = mentions.id + "-" + index;
      option.setAttribute("role", "option");
      option.addEventListener("pointerdown", event => event.preventDefault());
      option.addEventListener("click", () => chooseMention(index));
      return option;
    }));
    if (!mentions.matches(":popover-open")) mentions.showPopover();
    input.setAttribute("aria-controls", chat.id + " " + mentions.id);
    highlightMention(0);
  }
  function chooseMention(index) {
    if (!mention) return;
    const { start, end, tasks } = mention;
    closeMentions();
    insertDraftText(tasks[index].id, { start, end });
  }
  const microphone = button("", startDictation, "quiet draft-mic");
  microphone.append(icon("mic"));
  const voiceRow = element("div", undefined, "draft-voice-row");
  const waveform = element("canvas", undefined, "draft-voice-wave");
  waveform.setAttribute("aria-hidden", "true");
  const cancelVoice = button("", () => endDictation(dictation, "", true), "quiet draft-voice-cancel");
  cancelVoice.append(icon("close"));
  const stopVoice = button("", () => stopDictation(dictation), "quiet draft-voice-stop");
  stopVoice.append(icon("debug-stop"));
  stopVoice.disabled = true;
  voiceRow.append(cancelVoice, waveform, stopVoice);
  voiceRow.addEventListener("keydown", event => {
    if (event.key === "Escape") endDictation(dictation, "", true);
  });
  voiceRow.hidden = true;
  const voiceStatus = element("p", undefined, "draft-voice-status muted");
  voiceStatus.setAttribute("role", "status");
  voiceStatus.hidden = true;
  function voiceMessage(text) {
    voiceStatus.textContent = text;
    voiceStatus.hidden = !text;
  }
  function releaseMicrophone(recording) {
    clearTimeout(recording.timeout);
    cancelAnimationFrame(recording.animation);
    recording.stream?.getTracks().forEach(track => track.stop());
    recording.stream = undefined;
    if (recording.audio?.state !== "closed") void recording.audio?.close().catch(() => {});
    recording.audio = undefined;
  }
  function endDictation(recording, text = "", focus = false) {
    if (!recording || dictation !== recording) return;
    dictation = undefined;
    if (recording.windowsSpeech) void api.windowsSpeech("cancel").catch(() => {});
    if (recording.recorder?.state === "recording") recording.recorder.stop();
    releaseMicrophone(recording);
    editor.removeAttribute("data-dictating");
    stopVoice.disabled = true;
    voiceRow.hidden = true;
    voiceMessage(text);
    if (focus && editor.isConnected) input.focus({ preventScroll: true });
  }
  editor.cancelDictation = () => endDictation(dictation);
  function stopDictation(recording) {
    if (recording !== dictation || recording?.recorder?.state !== "recording") return;
    stopVoice.disabled = true;
    if (recording.windowsSpeech) recording.windowsText = api.windowsSpeech("stop").catch(() => undefined);
    if (document.activeElement === stopVoice) cancelVoice.focus({ preventScroll: true });
    recording.recorder.stop();
    voiceMessage(language("Transcribing…", "Распознаю речь…"));
  }
  function drawWaveform(recording, analyser) {
    const context = waveform.getContext("2d");
    const levels = new Uint8Array(analyser.fftSize);
    const history = [];
    let lastSample = -Infinity;
    const draw = now => {
      const width = waveform.clientWidth;
      const height = waveform.clientHeight;
      const scale = devicePixelRatio;
      if (waveform.width !== Math.round(width * scale) || waveform.height !== Math.round(height * scale)) {
        waveform.width = Math.round(width * scale);
        waveform.height = Math.round(height * scale);
      }
      const bars = Math.floor(width / 5);
      if (now - lastSample >= 35) {
        analyser.getByteTimeDomainData(levels);
        const rms = Math.sqrt(levels.reduce((sum, level) => sum + ((level - 128) / 128) ** 2, 0) / levels.length);
        history.push(rms);
        lastSample = now;
      }
      if (history.length > bars) history.splice(0, history.length - bars);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(waveform).color;
      for (let index = 0; index < bars; index++) {
        const level = history[history.length - bars + index] ?? 0;
        const size = Math.min(height, 2 + level * height * 5);
        context.fillRect(index * 5, (height - size) / 2, 2, size);
      }
      recording.animation = requestAnimationFrame(draw);
    };
    recording.animation = requestAnimationFrame(draw);
  }
  async function finishDictation(recording, chunks) {
    if (recording !== dictation) return;
    if (recording.windowsSpeech && !recording.windowsText) {
      recording.windowsText = api.windowsSpeech("stop").catch(() => undefined);
    }
    releaseMicrophone(recording);
    stopVoice.disabled = true;
    voiceMessage(language("Transcribing…", "Распознаю речь…"));
    const noSpeech = language("No speech detected.", "Речь не обнаружена.");
    const failed = language("Could not transcribe the recording.", "Не удалось распознать запись.");
    try {
      const nativeText = await recording.windowsText;
      if (recording !== dictation) return;
      if (nativeText) {
        endDictation(recording, "", true);
        insertDraftText(nativeText);
        return;
      }
      if (!chunks.length) return endDictation(recording, noSpeech, true);
      const decoder = new OfflineAudioContext(1, 1, 16_000);
      const audio = await decoder.decodeAudioData(await new Blob(chunks, { type: recording.recorder.mimeType }).arrayBuffer());
      if (recording !== dictation) return;
      const mix = new OfflineAudioContext(1, audio.length, 16_000);
      const source = mix.createBufferSource();
      source.buffer = audio;
      source.connect(mix.destination);
      source.start();
      const samples = (await mix.startRendering()).getChannelData(0);
      if (recording !== dictation) return;
      if (!samples.some(sample => Math.abs(sample) > .004)) return endDictation(recording, noSpeech, true);
      const result = await api.transcribeVoice(samples, recording.language);
      if (recording !== dictation) return;
      if (!result.ok) return endDictation(recording, boardError(result.error), true);
      endDictation(recording, result.data ? "" : noSpeech, true);
      if (result.data) insertDraftText(result.data);
    } catch {
      endDictation(recording, failed, true);
    }
  }
  async function startDictation() {
    if (dictation) return;
    const recording = { language: frame.russian ? "ru" : "en" };
    dictation = recording;
    closeMentions();
    voiceRow.hidden = false;
    stopVoice.disabled = true;
    editor.setAttribute("data-dictating", "");
    cancelVoice.focus({ preventScroll: true });
    voiceMessage(language("Opening microphone…", "Подключаю микрофон…"));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (dictation !== recording) return stream.getTracks().forEach(track => track.stop());
      recording.stream = stream;
      const recorder = recording.recorder = new MediaRecorder(stream);
      const audio = recording.audio = new AudioContext();
      void audio.resume().catch(() => {});
      const analyser = audio.createAnalyser();
      audio.createMediaStreamSource(stream).connect(analyser);
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => { void finishDictation(recording, chunks); };
      recorder.onerror = () => endDictation(recording,
        language("Microphone recording failed.", "Не удалось записать звук."), true);
      recorder.start();
      if (api.isWindows && api.windowsSpeech) {
        recording.windowsSpeech = true;
        void api.windowsSpeech("start", recording.language).catch(() => {});
      }
      stopVoice.disabled = false;
      stopVoice.focus({ preventScroll: true });
      voiceMessage(language("Recording…", "Запись…"));
      drawWaveform(recording, analyser);
      recording.timeout = setTimeout(() => stopDictation(recording), 120_000);
    } catch {
      endDictation(recording, language(
        "Could not access the microphone. Check your device and microphone permissions.",
        "Не удалось открыть микрофон. Проверьте устройство и разрешение на доступ к микрофону.",
      ), true);
    }
  }
  const goalChip = button("", () => {
    setGoalMode(false);
    input.focus();
  }, "quiet draft-goal-chip");
  const goalLabel = element("span");
  goalChip.append(icon("target"), goalLabel, icon("close"));
  const send = element("button", undefined, "button primary draft-send");
  send.type = "button";
  send.addEventListener("click", () => {
    if (hasDraft()) {
      editor.requestSubmit();
      return;
    }
    if (active && canStop && !stopping) void stopReply();
  });
  async function stopReply() {
    const request = active;
    stopping = true;
    syncAction();
    try {
      const result = await api.stopOrchestrator();
      if (!result.ok) throw new Error(boardError(result.error));
    } catch (error) {
      if (active !== request) return;
      stopping = false;
      syncAction();
      message(error.message);
    }
  }
  controls.append(microphone, send);
  const attachments = element("ul", undefined, "draft-attachments board-attachments");
  attachments.hidden = true;
  const progress = element("p", undefined, "draft-progress muted");
  progress.hidden = true;
  progress.setAttribute("role", "status");
  const defaultPrompt = () => language("Write to the project manager…", "Напишите менеджеру проекта…");
  const currentPrompt = () => prompts[promptIndex] ?? defaultPrompt();
  let promptAnimation;
  const showPrompt = () => {
    const status = !editor.matches("[data-open], [data-pinned]") && (active?.thinking.textContent || (managerWork &&
      runningLabel(managerWork.item).status));
    const suggestion = document.activeElement === input ? defaultPrompt() :
      promptAnimation ? promptAnimation.characters.slice(0, promptAnimation.length).join("") : currentPrompt();
    const text = status || (goalMode ? language("Describe the goal…", "Опишите цель…") : suggestion);
    if (prompt.textContent !== text) prompt.textContent = text;
  };
  const canAnimatePrompt = () => prompts.length > 0 && !reducedMotion.matches && !document.hidden &&
    editor.isConnected && editor.checkVisibility() && !goalMode && !input.value && !active &&
    !(managerWork && !editor.matches("[data-open], [data-pinned]")) && document.activeElement !== input;
  const segmenter = new Intl.Segmenter();
  const promptCharacters = () => Array.from(segmenter.segment(currentPrompt()), part => part.segment);
  let promptTimer;
  const pausePrompt = () => {
    clearTimeout(promptTimer);
    promptTimer = undefined;
    showPrompt();
  };
  const animatePrompt = () => {
    if (!canAnimatePrompt()) return pausePrompt();
    if (!promptAnimation) {
      const characters = promptCharacters();
      promptAnimation = { characters, length: characters.length, erasing: true };
    }
    const step = promptAnimation;
    step.length += step.erasing ? -1 : 1;
    let delay = step.erasing ? 16 : 26;
    if (step.erasing && step.length === 0) {
      promptIndex = (promptIndex + 1) % prompts.length;
      step.characters = promptCharacters();
      step.erasing = false;
      delay = 180;
    } else if (!step.erasing && step.length === step.characters.length) {
      promptAnimation = promptTimer = undefined;
      syncPrompt();
      return;
    }
    showPrompt();
    promptTimer = setTimeout(animatePrompt, delay);
  };
  const syncPrompt = () => {
    if (!canAnimatePrompt()) {
      if (reducedMotion.matches) {
        promptAnimation = undefined;
        if (promptIndex < 0 && prompts.length) promptIndex = 0;
      }
      pausePrompt();
      return;
    }
    if (promptTimer === undefined && (promptAnimation || promptIndex < 0 || prompts.length > 1)) {
      promptTimer = setTimeout(animatePrompt, promptAnimation ? 26 : promptIndex < 0 ? 3000 : 10000);
    }
    showPrompt();
  };
  editor.syncPrompt = syncPrompt;
  const loadSuggestions = () => {
    const locale = Boolean(frame.russian);
    if (suggestionsLanguage === locale) return;
    suggestionsLanguage = locale;
    prompts = [];
    promptIndex = -1;
    promptAnimation = undefined;
    pausePrompt();
    void api.boardSuggestions(project).then(result => {
      if (disposed || suggestionsLanguage !== locale) return;
      prompts = result;
      syncPrompt();
    }).catch(() => {});
  };
  const hasDraft = () => Boolean(input.value.trim() || (!goalMode && files.length));
  function setGoalMode(value) {
    goalMode = value;
    goalChip.hidden = !value;
    pickGoal.setAttribute("aria-pressed", String(value));
    syncPrompt();
    syncAction();
  }
  const syncAction = () => {
    const stop = Boolean(active) && !hasDraft();
    const mode = stop ? "stop" : "send";
    if (send.dataset.action !== mode) {
      send.dataset.action = mode;
      send.replaceChildren(icon(stop ? "stop-circle" : "arrow-up"));
      send.classList.toggle("quiet", stop);
      send.classList.toggle("primary", !stop);
    }
    send.disabled = stop ? !canStop || stopping : goalMode && !hasDraft();
    controlLabelForIcon(send, stop ? (waitingForChat ? language("Cancel sending", "Отменить отправку") :
      language("Stop reply", "Остановить ответ")) : language("Send request", "Отправить запрос"));
  };
  editor.localize = () => {
    if (promptTimer === undefined) showPrompt();
    updatePin();
    dialogueToggle.textContent = language("Dialogue", "Диалог");
    unreadDivider.textContent = language("New messages", "Новые сообщения");
    workToggle.textContent = language("Work activity", "Ход работы");
    work.setAttribute("aria-label", workToggle.textContent);
    workOlder.textContent = language("Earlier activity", "Более ранние события");
    goalText.setAttribute("aria-label", language("Goal objective", "Формулировка цели"));
    saveGoal.textContent = language("Save changes", "Сохранить изменения");
    pauseGoal.textContent = language("Pause", "Пауза");
    resumeGoal.textContent = language("Resume", "Возобновить");
    clearGoal.textContent = language("Clear goal", "Снять цель");
    syncGoal();
    input.setAttribute("aria-label", language("Message the project manager", "Сообщение менеджеру проекта"));
    chat.setAttribute("aria-label", language("Project manager chat", "Чат с менеджером проекта"));
    resize.setAttribute("aria-label", language("Chat height", "Высота чата"));
    greeting.textContent = language("Ask about the project or discuss what needs to change.", "Спросите о проекте или обсудите, что нужно изменить.");
    queue.setAttribute("aria-label", language("Message queue", "Очередь сообщений"));
    olderHistory.textContent = language("Load older messages", "Загрузить предыдущие сообщения");
    hint.textContent = language("Paste or attach files", "Вставьте или прикрепите файлы") + (api.isMac ? " (⌘V)." : " (Ctrl+V).");
    controlLabelForIcon(add, language("Add to message", "Добавить к сообщению"));
    controlLabelForIcon(microphone, language("Voice input", "Голосовой ввод"));
    controlLabelForIcon(cancelVoice, language("Cancel recording", "Отменить запись"));
    controlLabelForIcon(stopVoice, language("Stop and transcribe", "Остановить и распознать запись"));
    menuHeading.textContent = language("Add", "Добавить");
    pickFiles.lastElementChild.textContent = language("Files", "Файлы");
    pickTasks.lastElementChild.textContent = language("Tasks", "Задачи");
    pickGoal.lastElementChild.textContent = goalLabel.textContent = language("Goal mode", "Режим цели");
    controlLabelForIcon(goalChip, language("Exit goal mode", "Выйти из режима цели"));
    taskSearch.placeholder = language("Find a task…", "Найти задачу…");
    taskSearch.setAttribute("aria-label", taskSearch.placeholder);
    mentions.setAttribute("aria-label", language("Task suggestions", "Подсказки по задачам"));
    syncAction();
    attachments.setAttribute("aria-label", language("Attachments", "Вложения"));
  };
  editor.localize();
  setGoalMode(false);
  const field = element("div", undefined, "board-draft-field");
  let question;
  let questionDialog;
  let shownQuestionId;
  const openQuestion = () => {
    if (question && !questionDialog?.open) questionDialog = managerQuestionDialog(question, answer);
  };
  const answer = button("", openQuestion, "quiet manager-question-trigger");
  editor.closeQuestion = () => { if (questionDialog?.open) questionDialog.close(); };
  editor.updateQuestion = next => {
    if (question?.id !== next?.id) editor.closeQuestion();
    question = next;
    answer.hidden = !next;
    answer.textContent = language("Answer the manager", "Ответить менеджеру");
    if (next && shownQuestionId !== next.id && editor.isConnected) {
      shownQuestionId = next.id;
      openQuestion();
    }
  };
  editor.updateQuestion(undefined);
  const inputArea = element("div", undefined, "draft-input");
  inputArea.append(input, prompt);
  field.append(add, inputArea, controls, voiceRow, menu, mentions, picker, hint, goalChip, attachments, voiceStatus, progress);
  field.append(answer);
  editor.append(chat, field);
  const previewImages = (images, file) => openImagePreview(undefined, images, images.indexOf(file), file.url, {
    preview: image => image.url,
    save: image => {
      const link = element("a");
      link.href = image.url;
      link.download = image.name;
      link.click();
      return { ok: true };
    },
  });
  const chatMessage = (actor, text, files = [], animate = false, insert = true, clientId, at) => {
    greeting.hidden = true;
    const entry = element("div", undefined, "chat-entry");
    entry.dataset.actor = actor;
    if (actor === "user") entry.dataset.chatAnchor = "user:" + (clientId ?? JSON.stringify([text, files.map(file => file.name)]));
    if (actor === "agent") entry.classList.add("board-manager-message");
    entry.toggleAttribute("data-enter", animate);
    if (files.length) {
      const tiles = element("div", undefined, "chat-attachments");
      const images = files.filter(file => file.url);
      for (const file of files) {
        const tile = file.url ? button("", () => previewImages(images, file), "quiet chat-attachment") :
          element("span", undefined, "chat-attachment");
        if (file.url) {
          controlLabelForIcon(tile, language("View ", "Просмотреть ") + file.name);
          const img = element("img");
          img.alt = file.name;
          img.loading = "lazy";
          img.src = file.url;
          tile.append(img);
        } else tile.append(icon("attachment"), element("span", file.name));
        tiles.append(tile);
      }
      entry.append(tiles);
    }
    if (text) entry.append(actor === "agent" ? chatText(text, { agent: true }) : element("p", text, "chat-text"));
    appendChatTime(entry, at);
    if (insert) log.append(entry);
    return entry;
  };
  const message = text => {
    progress.textContent = text;
    progress.hidden = !text;
  };
  editor.reviewError = error => message(language("Automatic review was interrupted.", "Авторевью прервалось.") + "\n" + error);
  const busy = value => {
    if (!value) showPrompt();
    syncPrompt();
    editor.setAttribute("aria-busy", String(value));
    waitingForChat = false;
    canStop = stopping = false;
    syncAction();
  };
  editor.enableStop = () => {
    if (!active) return;
    canStop = true;
    syncAction();
  };
  const thinkingLabel = () => language("Thinking…", "Думаю…");
  const waitingLabel = () => language("Waiting for the Codex chat to become available…", "Жду освобождения чата Codex…");
  const showActivityStatus = (text, command = false) => {
    const label = active.thinking.firstElementChild;
    if (label.textContent === text && Boolean(label.querySelector(".codicon-terminal")) === command) return;
    label.replaceChildren(element("span", text, "chat-thinking-text"));
    if (command) label.prepend(icon("terminal"));
    showPrompt();
    if (!reducedMotion.matches) {
      active.statusAnimation?.cancel();
      active.statusAnimation = label.animate([{ opacity: .35, transform: "translateY(2px)" }, { opacity: 1, transform: "translateY(0)" }], {
        duration: 180, easing: "ease-out",
      });
    }
  };
  editor.setWaiting = waiting => {
    if (!active) return;
    waitingForChat = waiting;
    showActivityStatus(waiting ? waitingLabel() : thinkingLabel());
    canStop = waiting;
    syncAction();
  };
  const seenMessages = new Set();
  const rememberMessages = container => {
    for (const entry of container.querySelectorAll("[data-coordination-key]")) {
      seenMessages.add(entry.dataset.coordinationKey);
    }
  };
  const streamedText = new WeakMap();
  const fadeDuration = 240;
  const fadeStreamedText = (block, previous, now) => {
    const text = block.textContent.trimEnd();
    const oldText = previous?.text ?? "";
    let shared = 0;
    while (shared < oldText.length && text[shared] === oldText[shared]) shared++;
    const ranges = (previous?.ranges ?? []).filter(range => range.end <= shared && now - range.startTime < fadeDuration);
    // Markdown can reformat earlier characters when a closing delimiter arrives.
    const start = Math.max(shared, Math.min(oldText.length, text.length));
    if (start < text.length) ranges.push({ start, end: text.length, startTime: now });
    streamedText.set(block, { text, ranges });
    if (!ranges.length || reducedMotion.matches) return;

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let offset = 0;
    let index = 0;
    for (const node of nodes) {
      if (!node.length) continue;
      const end = offset + node.length;
      let tail = node;
      while (index < ranges.length && ranges[index].start < end) {
        const range = ranges[index];
        const left = Math.max(offset, range.start);
        const right = Math.min(end, range.end);
        if (left > offset) tail = tail.splitText(left - offset);
        const span = element("span", undefined, "chat-stream-fragment");
        span.style.animationDelay = (range.startTime - now) + "ms";
        const rest = right < end ? tail.splitText(right - left) : null;
        tail.before(span);
        span.append(tail);
        offset = right;
        tail = rest;
        if (right === range.end) index++;
        if (!tail) break;
      }
      offset = end;
    }
  };
  const renderActivity = (container, items, completed, context = { dialogue: true, seenMessages }) => {
    const messages = new Map();
    for (const child of container.querySelectorAll("[data-item]")) {
      const block = child.matches(".chat-text") ? child : child.matches(".chat-run-final, .board-manager-message") ? child.firstElementChild : undefined;
      const state = block && streamedText.get(block);
      if (state) messages.set(activityRowKey(child.dataset.item), state);
    }
    const previous = new Map([...container.querySelectorAll("[data-item]")].map(child =>
      [activityRowKey(child.dataset.item), child.getAnimations().find(animation => animation.animationName === "board-chat-enter")?.currentTime]));
    renderRunActivity(container, items, completed, undefined, undefined, {
      ...context, userMessage: ({ text, files, at }) => chatMessage("user", text, files, false, false, undefined, at),
    });
    if (completed && context.dialogue) rememberMessages(container);
    const now = performance.now();
    for (const child of container.querySelectorAll("[data-item]")) {
      const key = activityRowKey(child.dataset.item);
      if (child.matches(".chat-text, .chat-run-final, .board-manager-message")) {
        const block = child.matches(".chat-text") ? child : child.firstElementChild;
        if (messages.has(key)) fadeStreamedText(block, messages.get(key), now);
        else streamedText.set(block, { text: block.textContent.trimEnd(), ranges: [] });
      }
      if (child.parentElement.closest("[data-enter]")) continue;
      const elapsed = previous.get(key);
      if (previous.has(key) && !(elapsed >= 0 && elapsed < 220)) continue;
      child.setAttribute("data-enter", "");
      const animation = child.getAnimations()[0];
      if (animation && elapsed != null) animation.currentTime = elapsed;
    }
  };
  let loadingHistory;
  let historyLoaded = false;
  let hasDialogueHistory = false;
  let historyInvalidated = false;
  let loadingOlder = false;
  let historyGeneration = 0;
  let recentCursor;
  let olderCursor;
  let lastScrollTop = 0;
  const olderNodes = [];
  const previewUrls = [];
  const pendingPreviews = new Map();
  const previewSource = file => /^(?:image\/(?:png|jpeg|webp|gif))$/.test(file.type) || isImageAttachment(file);
  const releasePreview = file => {
    const url = pendingPreviews.get(file);
    if (url) URL.revokeObjectURL(url);
    pendingPreviews.delete(file);
  };
  const releaseSubmittedPreviews = submitted => {
    for (const file of submitted) {
      if (!files.includes(file) && !queued.some(job => job.submitted.includes(file))) releasePreview(file);
    }
  };
  const releaseMessagePreviews = messageFiles => {
    for (const { url } of messageFiles) {
      const index = previewUrls.indexOf(url);
      if (index === -1) continue;
      URL.revokeObjectURL(url);
      previewUrls.splice(index, 1);
    }
  };
  editor.dispose = () => {
    disposed = true;
    readObserver.disconnect();
    dialogueViewport.dispose();
    workViewport.dispose();
    editor.closeQuestion();
    editor.cancelDictation();
    queued.length = 0;
    pausePrompt();
    for (const url of previewUrls.splice(0)) URL.revokeObjectURL(url);
    for (const file of pendingPreviews.keys()) releasePreview(file);
  };
  function renderHistoryPage(turns) {
    const page = document.createDocumentFragment();
    const delivered = new Set();
    for (const turn of turns) {
      for (const { text, files, clientId, at } of turn.messages) {
        if (clientId && active?.id === clientId) continue;
        page.append(chatMessage("user", text, files, false, false, clientId, at));
        if (clientId) delivered.add(clientId);
      }
      const container = element("div", undefined, "chat-run");
      renderRunActivity(container, turn.items, true, turn.durationMs, undefined, { dialogue: true, seenMessages });
      rememberMessages(container);
      if (!container.hidden) page.append(container);
    }
    return { page, delivered };
  }
  const atEndOfHistory = dialogueViewport.atEnd;
  const canBrowseHistory = () => editor.isConnected && editor.matches("[data-open], [data-pinned]");
  function updateOlderHistory() {
    olderHistory.hidden = !olderCursor;
    olderHistory.disabled = loadingOlder;
  }
  function forgetOlderHistory() {
    historyGeneration++;
    for (const node of olderNodes.splice(0)) node.remove();
    olderCursor = recentCursor;
    seenMessages.clear();
    rememberMessages(log);
    updateOlderHistory();
  }
  async function loadOlderHistory(allowWhileOpening = false) {
    if (disposed || !olderCursor || (loadingHistory && !allowWhileOpening) || loadingOlder || !canBrowseHistory()) return;
    const cursor = olderCursor;
    const generation = historyGeneration;
    loadingOlder = true;
    updateOlderHistory();
    try {
      const result = await api.boardHistory(project, cursor);
      if (disposed || generation !== historyGeneration || !canBrowseHistory()) return;
      if (!result.ok) throw new Error(boardError(result.error));
      dialogueViewport.update(() => {
        const { page } = renderHistoryPage(result.data.turns);
        olderNodes.push(...page.children);
        greeting.after(page);
        updateUnreadMessages();
        olderCursor = result.data.nextCursor === cursor ? null : result.data.nextCursor;
        updateOlderHistory();
        greeting.hidden = log.childElementCount > 2;
      });
      lastScrollTop = log.scrollTop;
    } catch (error) {
      if (!disposed && generation === historyGeneration) message(error.message);
    } finally {
      loadingOlder = false;
      updateOlderHistory();
    }
  }
  const loadHistory = () => {
    if (!historyLoaded && !loadingHistory) {
      const revision = goalRevision;
      loadingHistory = api.boardHistory(project).then(async result => {
        if (!result.ok) throw new Error(boardError(result.error));
        if (disposed) return;
        if (revision === goalRevision) editor.updateGoal(result.data.goal, result.data.goalRunning);
        const oldImages = [...log.querySelectorAll(".chat-attachments img")];
        let delivered;
        dialogueViewport.update(() => {
          const previousReplies = new Set([...log.querySelectorAll("[data-message-id], .board-manager-message[data-item]")].map(node =>
            node.dataset.messageId ?? node.dataset.item.slice("message:".length)));
          historyGeneration++;
          olderNodes.length = 0;
          recentCursor = olderCursor = result.data.nextCursor;
          seenMessages.clear();
          const next = renderHistoryPage(result.data.turns);
          delivered = next.delivered;
          if (hasDialogueHistory) for (const reply of next.page.querySelectorAll("[data-message-id]")) {
            if (!previousReplies.has(reply.dataset.messageId)) reply.setAttribute("data-enter", "");
          }
          log.replaceChildren(olderHistory, greeting, next.page);
          if (active?.entry) log.append(active.entry);
          if (active) log.append(active.container, active.thinking);
          updateOlderHistory();
          greeting.hidden = log.childElementCount > 2;
          updateUnreadMessages();
        });
        await restoreQueue().catch(() => {});
        for (const job of [...queued]) {
          if (!delivered.has(job.id) || job.sending) continue;
          await queueStorage("remove", job.id);
          if (disposed || !queued.includes(job)) continue;
          queued.splice(queued.indexOf(job), 1);
          job.row.remove();
          releaseMessagePreviews(job.messageFiles);
          releaseSubmittedPreviews(job.submitted);
        }
        releaseMessagePreviews(oldImages.filter(image => !log.contains(image)).map(image => ({ url: image.src })));
        if (!disposed) {
          historyLoaded = true;
          if (!hasDialogueHistory) {
            hasDialogueHistory = true;
            while (unread.size && olderCursor && canBrowseHistory() && !log.hidden) {
              const shown = log.querySelectorAll('.board-manager-message[data-read="false"]').length;
              if (shown >= unread.size) break;
              const cursor = olderCursor;
              await loadOlderHistory(true);
              if (cursor === olderCursor) break;
            }
            positionNewDialogue = true;
          }
          requestAnimationFrame(showDialoguePosition);
        }
      }).finally(() => { loadingHistory = undefined; });
    }
    return loadingHistory;
  };
  const revealHistory = () => {
    if (historyLoaded) {
      dialogueViewport.restore();
      dialogueViewport.update(updateUnreadMessages);
    }
    void restoreQueue().catch(() => {});
    if (active && !active.shared) return;
    void loadHistory()?.catch(error => message(error.message));
  };
  const openChat = () => {
    if (editor.hasAttribute("data-open") && (historyLoaded || loadingHistory)) return;
    editor.setAttribute("data-open", "");
    syncPrompt();
    revealHistory();
    if (!work.hidden) {
      renderWorkOverview();
      editor.invalidateWork();
    }
  };
  editor.closeChat = () => {
    if (pinned || !editor.hasAttribute("data-open")) return;
    editor.removeAttribute("data-open");
    dialogueViewport.update(() => unreadDivider.remove());
    syncPrompt();
  };
  editor.revealPinned = () => { if (pinned && !loadingHistory && !historyLoaded) revealHistory(); };
  editor.invalidateHistory = () => {
    if (active && !active.shared) {
      historyInvalidated = true;
      return;
    }
    if (historyLoaded && !atEndOfHistory() && (olderNodes.length || loadingOlder)) {
      historyInvalidated = true;
      return;
    }
    historyInvalidated = false;
    historyLoaded = false;
    if (editor.matches("[data-open], [data-pinned]")) revealHistory();
  };
  log.addEventListener("scroll", () => {
    const top = log.scrollTop;
    const previous = lastScrollTop;
    lastScrollTop = top;
    if (!canBrowseHistory()) return;
    readVisibleMessages();
    if (top < previous && top <= 100) void loadOlderHistory();
    if (top > previous && atEndOfHistory()) {
      if (loadingOlder || olderNodes.length || olderCursor !== recentCursor) {
        dialogueViewport.update(forgetOlderHistory);
        lastScrollTop = log.scrollTop;
      }
      if (historyInvalidated && !active) editor.invalidateHistory();
    }
  });
  log.addEventListener("wheel", event => {
    if (event.deltaY < 0 && log.scrollTop === 0) void loadOlderHistory();
  }, { passive: true });
  field.addEventListener("click", event => {
    if (dictation || event.target.closest(".draft-controls, .draft-add, .draft-add-menu, .draft-task-mentions, .draft-goal-chip, .draft-attachments, .draft-progress")) return;
    openChat();
    if (event.target !== input) input.focus({ preventScroll: true });
  });
  for (const event of ["input", "focus", "blur"]) input.addEventListener(event, syncPrompt);
  input.addEventListener("input", syncAction);
  for (const event of ["input", "select", "click", "compositionend"]) input.addEventListener(event, syncMentions);
  input.addEventListener("blur", closeMentions);
  editor.loadSuggestions = loadSuggestions;
  const renderTurn = (turn, items, completed) => {
    turn.items = items;
    const timeline = turn.deliveries.size ? [...items] : items;
    // A delivery can replace the local bubble, but must follow activity already shown at send time.
    for (const [id, delivery] of turn.deliveries) {
      const index = timeline.findIndex(item => item.userMessage && item.id === id);
      if (index !== -1 && delivery.fallback) {
        releaseMessagePreviews(delivery.fallback.userMessage.files);
        delivery.fallback = undefined;
      }
      const after = timeline.findIndex(item => item.id === delivery.after);
      if (index === -1 && delivery.fallback) {
        timeline.splice(after + 1, 0, delivery.fallback);
      } else if (index !== -1 && index < after) {
        const [item] = timeline.splice(index, 1);
        timeline.splice(after, 0, item);
      }
    }
    turn.lastItem = timeline.at(-1)?.id;
    renderActivity(turn.container, completed ? timeline :
      timeline.filter(item => item.type !== "reasoning" || item.status !== "inProgress"), completed);
  };
  function runningLabel(running) {
    let status = thinkingLabel();
    let command = false;
    const boardWait = boardWaitStatus(running);
    if (boardWait) {
      status = boardWait;
    } else if (running?.type === "reasoning") {
      // Codex sends Markdown headings in its public reasoning summaries.
      const headings = [...running.text.matchAll(/^[ \t]*(?:\*\*([^*\r\n]{1,160})\*\*|#{1,6}[ \t]+([^\r\n]{1,160}))[ \t]*$/gm)];
      const heading = headings.at(-1);
      status = (heading?.[1] ?? heading?.[2])?.trim() || status;
    } else if (running?.type === "agentMessage") {
      status = language("Writing a reply…", "Пишу ответ…");
    } else if (running?.type === "plan") {
      status = language("Planning…", "Составляю план…");
    } else if (running?.type === "autoApprovalReview") {
      status = language("Reviewing access…", "Проверяю доступ…");
    } else if (running) {
      const kind = activityKind(running);
      const title = (kind === "command" ? readableRunCommand(running.title) : running.title).replace(/\s+/g, " ").trim();
      const labels = {
        command: ["Running a command…", "Выполняю команду…"],
        edit: ["Editing files…", "Изменяю файлы…"],
        image: ["Working with an image…", "Работаю с изображением…"],
        search: ["Searching the web…", "Ищу в интернете…"],
        tool: ["Using a tool…", "Использую инструмент…"],
      };
      const detailed = {
        command: ["Running ", "Выполняется "],
        search: ["Searching the web · ", "Поиск в интернете · "],
        tool: ["Using tool ", "Вызов инструмента "],
      };
      status = title && detailed[kind] ? language(...detailed[kind]) + title : language(...labels[kind]);
      command = kind === "command";
    }
    return { status, command };
  }
  function showRunningItem(running) {
    if (waitingForChat) return;
    const { status, command } = runningLabel(running);
    showActivityStatus(status, command);
  }
  editor.setMessageTime = at => {
    if (active?.entry && !active.entry.querySelector(".chat-time")) dialogueViewport.update(() => appendChatTime(active.entry, at));
  };
  editor.updateActivity = items => {
    if (!active) return;
    dialogueViewport.update(() => {
      showRunningItem(items.findLast(item => item.status === "inProgress"));
      renderTurn(active, items, false);
      updateUnreadMessages();
    });
    readVisibleMessages();
  };
  const pasteFiles = submitted => Promise.all(submitted.map(async file => ({
    name: file.name, type: file.type, bytes: await file.arrayBuffer(),
  })));
  const queueStorage = async (action, id, draft, goal, attachments) => {
    const result = await api.boardQueue(project, action, id, draft, goal, attachments);
    if (!result.ok) throw new Error(boardError(result.error));
    return result.data;
  };
  let restoredQueue;
  function restoreQueue() {
    restoredQueue ??= queueStorage("list").then(jobs => {
      if (disposed) return;
      for (const [index, { id, draft, goal, files }] of jobs.entries()) {
        enqueue(id, draft, goal, files.map(file => new File([file.bytes], file.name, { type: file.type })), index === 0);
      }
    }).catch(error => {
      restoredQueue = undefined;
      if (!disposed) message(error.message);
      throw error;
    });
    return restoredQueue;
  }
  function renderQueuedActions(job) {
    const { status } = job;
    status.replaceChildren();
    if (job.failed) status.append(element("span", language("Not sent", "Не отправлено"), "board-queued-failed"));
    if (job.failed) status.append(button(language("Retry", "Повторить"), async () => {
      await loadHistory()?.catch(() => {});
      if (!queued.includes(job)) return;
      job.failed = false;
      renderQueuedActions(job);
      sendNext();
    }, "quiet"));
    status.append(button(language("Edit", "Изменить"), () => editQueuedMessage(job), "quiet"));
    if (!job.goal) status.append(button(language("Send now", "Отправить сейчас"), () => sendQueuedNow(job), "quiet"));
    const remove = button("", async () => {
      if (!queued.includes(job) || job.sending || job.editing) return;
      job.sending = true;
      try {
        await queueStorage("remove", job.id);
      } catch (error) {
        if (!disposed) message(error.message);
        return;
      } finally {
        job.sending = false;
      }
      if (disposed || !queued.includes(job)) return;
      queued.splice(queued.indexOf(job), 1);
      job.row.remove();
      releaseMessagePreviews(job.messageFiles);
      releaseSubmittedPreviews(job.submitted);
      message("");
      sendNext();
    }, "quiet danger board-queued-remove");
    controlLabelForIcon(remove, language("Remove", "Удалить"));
    remove.append(icon("trash"));
    status.append(remove);
  }
  function editQueuedMessage(job) {
    if (!queued.includes(job) || job.editing || job.sending) return;
    job.editing = true;
    job.preview.hidden = true;
    const edit = element("textarea", undefined, "board-queued-edit");
    edit.value = job.draft;
    edit.setAttribute("aria-label", language("Edit queued message", "Редактировать сообщение в очереди"));
    job.status.before(edit);
    let saving = false;
    const finish = async save => {
      if (!job.editing || saving) return;
      if (save) {
        saving = true;
        edit.readOnly = saveButton.disabled = cancel.disabled = true;
        try {
          await queueStorage("edit", job.id, edit.value);
        } catch (error) {
          message(error.message);
          return;
        } finally {
          saving = edit.readOnly = cancel.disabled = false;
          validate();
        }
        job.draft = edit.value;
        job.request = edit.value.trim();
        updateQueuedPreview(job);
      }
      job.preview.hidden = false;
      job.editing = false;
      edit.remove();
      renderQueuedActions(job);
      sendNext();
      job.status.querySelector("button")?.focus({ preventScroll: true });
    };
    const saveButton = button(language("Save", "Сохранить"), () => finish(true), "quiet");
    const cancel = button(language("Cancel", "Отмена"), () => finish(false), "quiet");
    const validate = () => { saveButton.disabled = !edit.value.trim() && (job.goal || !job.submitted.length); };
    edit.addEventListener("input", validate);
    edit.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") finish(false);
        else if (!saveButton.disabled) finish(true);
      }
    });
    job.status.replaceChildren(saveButton, cancel);
    validate();
    edit.focus({ preventScroll: true });
  }
  async function sendQueuedNow(job) {
    if (disposed || sendingQueuedMessage || job.sending || job.editing || !queued.includes(job)) return;
    const turn = active;
    if (!turn) {
      await loadHistory()?.catch(() => {});
      if (disposed || !queued.includes(job) || job.sending || job.editing) return;
      if (active) return sendQueuedNow(job);
      queued.splice(queued.indexOf(job), 1);
      queued.unshift(job);
      job.failed = false;
      sendNext();
      return;
    }
    sendingQueuedMessage = true;
    job.sending = true;
    const delivery = { after: turn.lastItem };
    turn.deliveries.set(job.id, delivery);
    job.status.replaceChildren(element("span", language("Sending…", "Отправляется…")));
    message("");
    try {
      const pasted = await pasteFiles(job.submitted);
      if (disposed) return;
      const result = await api.boardRequest(job.request, pasted, project, false, true, job.id);
      if (disposed) return;
      if (!result.ok) throw new Error(boardError(result.error));
      queued.splice(queued.indexOf(job), 1);
      job.row.remove();
      if (turn.items.some(item => item.userMessage && item.id === job.id) || active !== turn) {
        releaseMessagePreviews(job.messageFiles);
      } else {
        delivery.fallback = { id: job.id, type: "userMessage", status: "completed", text: job.request, title: "",
          userMessage: { text: job.request, files: job.messageFiles } };
        dialogueViewport.update(() => renderTurn(turn, turn.items, false));
      }
      releaseSubmittedPreviews(job.submitted);
    } catch (error) {
      if (!turn.items.some(item => item.userMessage && item.id === job.id)) turn.deliveries.delete(job.id);
      if (!disposed) {
        renderQueuedActions(job);
        message(error.message);
      }
    } finally {
      job.sending = false;
      sendingQueuedMessage = false;
      sendNext();
    }
  }
  function beginTurn(id, entry, shared = false) {
    const container = element("div", undefined, "chat-run");
    const thinking = element("div", undefined, "chat-thinking");
    const label = element("span");
    label.append(element("span", thinkingLabel(), "chat-thinking-text"));
    thinking.append(label);
    const turn = { id, entry, container, thinking, shared, deliveries: new Map(), items: [] };
    active = turn;
    syncGoal();
    busy(true);
    message("");
    thinking.setAttribute("role", "status");
    thinking.setAttribute("data-enter", "");
    dialogueViewport.update(() => {
      if (entry) log.append(entry);
      greeting.hidden = true;
      log.append(container, thinking);
    });
    return turn;
  }
  editor.updateManagerRun = run => {
    if (run === undefined || disposed) return;
    managerRun = run;
    if (active && !active.shared) return;
    if (active && active.id !== run?.id) {
      dialogueViewport.update(() => {
        active.thinking.remove();
        // The following history refresh replaces these rows with the saved transcript.
        if (!active.container.childElementCount) active.container.remove();
      });
      active = undefined;
      busy(false);
      syncGoal();
      greeting.hidden = log.childElementCount > 2;
      if (!run) sendNext();
    }
    if (!run) return;
    if (!active) beginTurn(run.id, undefined, true);
    waitingForChat = run.phase === "waiting";
    canStop = run.phase !== "starting";
    if (waitingForChat) showActivityStatus(waitingLabel());
    else showRunningItem(run.item);
    syncAction();
  };
  editor.updateManagerWork = run => {
    if (disposed) return;
    if (run !== undefined) managerWork = run;
    workToggle.classList.toggle("working", Boolean(managerWork));
    syncPrompt();
    syncGoal();
    renderWorkOverview();
    if (!managerWork) sendWorkNext();
  };
  function sendWorkNext() {
    const next = queued.find(job => job.goal);
    if (disposed || startingWork || managerWork || !next || next.failed || next.editing || next.sending) return;
    startingWork = true;
    next.sending = true;
    next.status.textContent = language("Starting…", "Запускается…");
    syncGoal();
    void (async () => {
      const submitted = await pasteFiles(next.submitted);
      if (disposed) return;
      const result = await api.boardRequest(next.request, submitted, project, next.goal, false, next.id);
      if (!result.ok) throw new Error(boardError(result.error));
      if (result.data.error && result.data.keepQueued) throw new Error(result.data.error);
      removeWork(next);
      if (result.data.error) goalError.textContent = result.data.error;
    })().catch(error => {
      goalError.textContent = error.message;
      if (next.goal === "resume") {
        const index = queued.indexOf(next);
        if (index >= 0) queued.splice(index, 1);
      } else {
        next.failed = true;
        renderQueuedActions(next);
        message(error.message);
      }
    }).finally(() => {
      next.sending = false;
      startingWork = false;
      syncGoal();
      if (!disposed) sendWorkNext();
    });
  }
  function removeWork(job) {
    const index = queued.indexOf(job);
    if (index < 0) return;
    queued.splice(index, 1);
    job.row?.remove();
    releaseMessagePreviews(job.messageFiles ?? []);
    releaseSubmittedPreviews(job.submitted);
  }
  editor.acceptWork = id => {
    const job = queued.find(job => job.goal && job.id === id);
    if (job) removeWork(job);
  };
  function sendNext() {
    sendWorkNext();
    const next = queued.find(job => !job.goal);
    if (disposed || active || sendingQueuedMessage || !next || next.failed || next.editing || next.sending) return;
    queued.splice(queued.indexOf(next), 1);
    const { request, goal, submitted } = next;
    next.row?.remove();
    const entry = next.entry ?? chatMessage("user", request, next.messageFiles, true, false, next.id);
    const turn = beginTurn(next.id, entry);
    const { container, thinking } = turn;
    let accepted = false;
    void (async () => {
      void loadHistory()?.catch(() => {});
      const pasted = await pasteFiles(submitted);
      if (disposed) return;
      const result = await api.boardRequest(request, pasted, project, goal, false, next.id);
      if (!result.ok && result.error.code === "BOARD_WAIT_CANCELLED") return;
      if (!result.ok) throw new Error(boardError(result.error));
      const { answer, error, items = [], keepQueued } = result.data;
      accepted = !keepQueued;
      dialogueViewport.update(() => {
        renderTurn(turn, items, true);
        updateUnreadMessages();
        if (answer && !container.querySelector(".chat-run-final")) chatMessage("agent", answer, [], true, true, undefined, items.findLast(item => item.type === "agentMessage")?.at);
        if (error) chatMessage("agent", error, [], true);
      });
      readVisibleMessages();
      if (!editor.isConnected || frame.project !== project || sheet.open) return;
      archiveView = false;
      render();
    })().catch(error => {
      message(error.message);
    }).finally(() => {
      dialogueViewport.update(() => {
        thinking.remove();
        if (!container.childElementCount) container.remove();
      });
      active = undefined;
      busy(false);
      syncGoal();
      if (disposed) return;
      editor.updateManagerRun(managerRun);
      if (accepted) {
        releaseSubmittedPreviews(submitted);
        if ((historyInvalidated && atEndOfHistory()) || log.childElementCount - olderNodes.length - 2 > 120) {
          editor.invalidateHistory();
        }
        sendNext();
        return;
      }
      next.failed = true;
      queued.unshift(next);
      renderQueuedActions(next);
      entry.remove();
      queue.prepend(next.row);
    });
  }
  editor.addEventListener("submit", async event => {
    event.preventDefault();
    if (dictation || savingQueuedMessage || !hasDraft()) return;
    const draft = input.value;
    const goal = goalMode;
    const submitted = [...files];
    let id;
    savingQueuedMessage = true;
    try {
      await restoreQueue();
      id = await queueStorage("add", undefined, draft, goal, await pasteFiles(submitted));
    } catch (error) {
      if (!disposed) message(error.message);
      return;
    } finally {
      savingQueuedMessage = false;
    }
    if (disposed) return;
    if (input.value === draft) input.value = "";
    for (const file of submitted) {
      const index = files.indexOf(file);
      if (index === -1) continue;
      files.splice(index, 1);
      attachments.children[index]?.remove();
    }
    closeMentions();
    dismissedMention = undefined;
    attachments.hidden = !files.length;
    if (goalMode === goal) setGoalMode(false);
    enqueue(id, draft, goal, submitted);
    openChat();
    showWork(goal);
    sendNext();
    syncAction();
  });
  function updateQueuedPreview(job) {
    job.preview.textContent = job.request.replace(/\s+/g, " ") || job.messageFiles.map(file => file.name).join(", ");
    job.preview.title = job.preview.textContent.slice(0, 180);
  }
  function enqueue(id, draft, goal, submitted, failed = false) {
    const request = draft.trim();
    const messageFiles = submitted.map(file => {
      if (!previewSource(file)) return { name: file.name };
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      return { name: file.name, url };
    });
    const row = element("div", undefined, "board-queued-row");
    row.setAttribute("role", "listitem");
    row.append(icon(goal ? "target" : "tasklist"));
    const images = messageFiles.filter(file => file.url);
    if (images.length) {
      const thumbnail = button("", () => previewImages(images, images[0]), "quiet board-queued-thumbnail");
      controlLabelForIcon(thumbnail, language("View attachments", "Просмотреть вложения") + " · " + images.length);
      const image = element("img");
      image.src = images[0].url;
      image.alt = "";
      thumbnail.append(image);
      row.append(thumbnail);
    } else if (messageFiles.length) {
      row.append(icon("file"));
    }
    if (messageFiles.length) row.title = messageFiles.map(file => file.name).join("\n");
    const preview = element("span", undefined, "board-queued-preview");
    const status = element("div", undefined, "board-queued-status");
    row.append(preview, status);
    queue.append(row);
    const job = { id, row, preview, status, draft, request, goal, submitted, messageFiles, failed };
    queued.push(job);
    updateQueuedPreview(job);
    renderQueuedActions(job);
  }
  function addFiles(pasted) {
    if ([...files, ...pasted].reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) {
      message(language("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ."));
      return;
    }
    message("");
    for (const file of pasted) {
      files.push(file);
      const row = element("li", undefined, "board-attachment");
      const url = previewSource(file) ? pendingPreviews.get(file) ?? URL.createObjectURL(file) : undefined;
      if (url) pendingPreviews.set(file, url);
      const remove = button("", () => {
        files.splice(files.indexOf(file), 1);
        if (!files.includes(file)) releasePreview(file);
        row.remove();
        attachments.hidden = !files.length;
        syncAction();
        message("");
        input.focus();
      }, "quiet");
      remove.append(icon("close"));
      remove.setAttribute("aria-label", language("Remove ", "Удалить ") + file.name);
      row.title = file.name;
      if (url) {
        const view = button("", () => {
          const images = files.filter(file => pendingPreviews.has(file)).map(file => ({ name: file.name, url: pendingPreviews.get(file) }));
          previewImages(images, images.find(image => image.url === url));
        }, "quiet board-attachment-preview");
        controlLabelForIcon(view, language("View ", "Просмотреть ") + file.name);
        const thumbnail = element("img");
        thumbnail.src = url;
        thumbnail.alt = "";
        view.append(thumbnail);
        row.classList.add("board-attachment-image");
        row.append(view);
      } else row.append(icon("attachment"), element("span", file.name));
      remove.classList.add("board-attachment-remove");
      row.append(remove);
      attachments.append(row);
    }
    attachments.hidden = !files.length;
    syncAction();
  }
  picker.addEventListener("change", () => { addFiles([...picker.files]); picker.value = ""; });
  editor.addEventListener("dragover", event => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  editor.addEventListener("drop", event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  });
  input.addEventListener("paste", event => {
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (!pasted.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(pasted);
  });
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (mention && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      if (event.key === "Escape") {
        dismissedMention = mention.key;
        closeMentions();
      } else if (event.key === "Enter" || event.key === "Tab") {
        chooseMention(mentionIndex);
      } else {
        const count = mention.tasks.length;
        highlightMention((mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!hasDraft() && !editor.matches("[data-open], [data-pinned]")) openChat();
      else editor.requestSubmit();
    }
  });
  return editor;
}

function scheduleDay(weekday) {
  return new Date(Date.UTC(1970, 0, 4 + weekday)).toLocaleDateString(frame.russian ? "ru" : "en", { weekday: "long", timeZone: "UTC" });
}

function scheduleMonth(month, day) {
  return new Date(Date.UTC(2024, month - 1, day ?? 1)).toLocaleDateString(frame.russian ? "ru" : "en",
    { month: "long", ...(day === undefined ? {} : { day: "numeric" }), timeZone: "UTC" });
}

function scheduleInterval(minutes, unitDisplay) {
  const hours = minutes % 60 === 0;
  return new Intl.NumberFormat(frame.russian ? "ru" : "en", { style: "unit", unit: hours ? "hour" : "minute", unitDisplay })
    .format(hours ? minutes / 60 : minutes);
}

function scheduleLabel({ time, weekday, everyMinutes, dayOfMonth, month }) {
  if (everyMinutes === 60) return language("Every hour", "Каждый час");
  if (everyMinutes !== undefined) return language("Interval", "Интервал") + " · " + scheduleInterval(everyMinutes, "long");
  if (month !== undefined) return language("Yearly", "Ежегодно") + " · " + scheduleMonth(month, dayOfMonth) + " · " + time;
  if (dayOfMonth !== undefined) return language("Monthly", "Ежемесячно") + " · " +
    language("Day ", "Число ") + dayOfMonth + " · " + time;
  return (weekday === undefined ? language("Daily", "Ежедневно") : scheduleDay(weekday)) + " · " + time;
}

function taskEditor(task) {
  const canSetSchedule = ["draft", "ready", "blocked"].includes(task.status);
  const saved = task.schedule;
  const every = saved?.everyMinutes;
  const today = new Date();
  const mode = !saved ? "none" : every === 60 ? "hourly" : every !== undefined ? (every % 60 === 0 ? "hours" : "minutes") :
    saved.month !== undefined ? "yearly" : saved.dayOfMonth !== undefined ? "monthly" : saved.weekday === undefined ? "daily" : "weekly";
  const editor = form("editor", language("Edit task", "Редактировать задачу"), [
    { name: "title", label: language("Title", "Название"), required: true, value: task.title },
    { name: "description", label: language("Description", "Описание"), type: "area", value: task.description },
    { name: "criteria", label: language("Acceptance criteria, one per line", "Критерии приёмки, по одному на строку"), type: "area",
      value: task.criteria.join("\n") },
    { name: "tags", label: language("Tags, comma separated", "Теги через запятую"), value: task.tags.join(", ") },
    { name: "priority", label: language("Priority", "Приоритет"), value: task.priority,
      options: ["low", "normal", "high", "urgent"].map(value => [value, priorityName(value)]) },
    ...(canSetSchedule ? [
      { name: "scheduleMode", label: language("Schedule", "Расписание"), value: mode, options: [
        ["none", language("No schedule", "Без расписания")], ["hourly", language("Every hour", "Каждый час")],
        ["minutes", language("Every N minutes", "Каждые N минут")], ["hours", language("Every N hours", "Каждые N часов")],
        ["daily", language("Daily at a set time", "Ежедневно в заданное время")], ["weekly", language("Weekly at a set time", "Еженедельно в заданное время")],
        ["monthly", language("Monthly", "Ежемесячно")], ["yearly", language("Yearly", "Ежегодно")],
      ] },
      { name: "scheduleInterval", label: language("Interval", "Интервал"), type: "number", value: mode === "hours" ? every / 60 : mode === "minutes" ? every : 1 },
      { name: "scheduleTime", label: language("Local time", "Местное время"), type: "time", value: saved?.time ?? "" },
      { name: "scheduleDay", label: language("Day of week", "День недели"), value: String(saved?.weekday ?? today.getDay()),
        options: [1, 2, 3, 4, 5, 6, 0].map(day => [String(day), scheduleDay(day)]) },
      { name: "scheduleMonth", label: language("Month", "Месяц"), value: String(saved?.month ?? today.getMonth() + 1),
        options: Array.from({ length: 12 }, (_, index) => [String(index + 1), scheduleMonth(index + 1)]) },
      { name: "scheduleDate", label: language("Day of month", "Число месяца"), type: "number", value: saved?.dayOfMonth ?? today.getDate() },
    ] : []),
    { name: "note", label: language("Reason for change", "Причина изменения") },
  ], language("Save", "Сохранить"), async values => {
    const data = {
      title: values.title, description: values.description, criteria: lineList(values.criteria),
      tags: values.tags.split(",").map(tag => tag.trim()).filter(Boolean), priority: values.priority,
      actor: "user", revision: task.revision, ...(values.note ? { note: values.note } : {}),
    };
    if (canSetSchedule) {
      const { scheduleMode, scheduleTime, scheduleDay, scheduleMonth, scheduleDate, scheduleInterval: interval } = values;
      const schedule = {
        none: null, hourly: { everyMinutes: 60 }, minutes: { everyMinutes: Number(interval) }, hours: { everyMinutes: 60 * Number(interval) },
        daily: { time: scheduleTime }, weekly: { time: scheduleTime, weekday: Number(scheduleDay) },
        monthly: { time: scheduleTime, dayOfMonth: Number(scheduleDate) },
        yearly: { time: scheduleTime, dayOfMonth: Number(scheduleDate), month: Number(scheduleMonth) },
      }[scheduleMode];
      if (schedule?.time !== saved?.time || schedule?.weekday !== saved?.weekday || schedule?.everyMinutes !== saved?.everyMinutes ||
          schedule?.dayOfMonth !== saved?.dayOfMonth || schedule?.month !== saved?.month) {
        data.schedule = schedule;
      }
    }
    const updated = await command("update", task.id, data);
    if (updated) await showTask(updated.id);
  });
  if (!canSetSchedule) return;
  const { scheduleMode, scheduleInterval: interval, scheduleTime: time, scheduleDay: day, scheduleMonth: month, scheduleDate: date } = editor.elements;
  interval.min = "1";
  date.min = "1";
  const showFields = () => {
    const mode = scheduleMode.value;
    interval.parentElement.hidden = interval.disabled = mode !== "minutes" && mode !== "hours";
    time.parentElement.hidden = time.disabled = !["daily", "weekly", "monthly", "yearly"].includes(mode);
    day.parentElement.hidden = day.disabled = mode !== "weekly";
    month.parentElement.hidden = month.disabled = mode !== "yearly";
    date.parentElement.hidden = date.disabled = mode !== "monthly" && mode !== "yearly";
    date.max = mode === "yearly" ? String(new Date(2024, Number(month.value), 0).getDate()) : "31";
    interval.required = !interval.disabled;
    time.required = !time.disabled;
    date.required = !date.disabled;
  };
  scheduleMode.addEventListener("change", showFields);
  month.addEventListener("change", showFields);
  showFields();
}

async function editMilestone(task) {
  const project = frame.project;
  const generation = projectGeneration;
  const current = task.milestone;
  let repository = frame.board?.gitInfo?.githubRepository;
  const view = form("milestone", language("GitHub milestone", "Веха GitHub"), [{
    name: "milestone", label: language("Milestone", "Веха"), value: current ? "current" : "",
    options: [["", language("No milestone", "Без вехи")], ...(current ? [["current", current.title + " · " + current.repository]] : [])],
  }], language("Save", "Сохранить"), async values => {
    if (values.milestone === "current" || (!values.milestone && !current)) return showTask(task.id);
    const milestone = values.milestone ? { repository, number: Number(values.milestone) } : null;
    const saved = await command("milestone", task.id, { revision: task.revision, milestone });
    if (saved && frame.project === project && sheet.open && view.isConnected) await showTask(task.id);
  });
  const select = view.querySelector("select");
  const save = view.querySelector('[type="submit"]');
  const status = element("p", undefined, "muted");
  status.setAttribute("role", "status");
  save.before(status);
  if (!repository) {
    status.textContent = language("Configure a GitHub origin to choose another milestone.", "Чтобы выбрать другую веху, настройте origin на GitHub.");
    return;
  }
  status.textContent = language("Loading milestones…", "Загружаю вехи…");
  const result = await api.command("milestones").catch(error => ({ ok: false, error }));
  if (!view.isConnected || !sheet.open || projectGeneration !== generation) return;
  if (!result.ok) {
    status.textContent = boardError(result.error);
    return;
  }
  repository = result.data.repository;
  status.textContent = result.data.milestones.length ? repository :
    language("This repository has no milestones.", "В этом репозитории пока нет вех.");
  for (const entry of result.data.milestones) {
    if (current?.repository === repository && current.number === entry.number) {
      select.querySelector('[value="current"]').textContent = entry.title + " · " + repository;
      continue;
    }
    const closed = entry.state === "closed" ? language(" (closed)", " (закрыта)") : "";
    select.add(new Option(entry.title + " · #" + entry.number + closed, String(entry.number)));
  }
}

function editDependencies(task) {
  const dependencies = new Set(task.dependencies ?? []);
  const board = frame.board;
  const entries = [...board.tasks, ...board.archived].filter(candidate => candidate.id !== task.id);
  const editor = form("dependencies", language("Task dependencies", "Зависимости задачи"), [],
    language("Save", "Сохранить"), async () => {
      const saved = await command("update", task.id, {
        dependencies: [...dependencies], revision: task.revision, actor: "user",
      });
      if (saved) await showTask(saved.id);
    });
  const choices = element("fieldset", undefined, "dependency-choices");
  choices.append(element("legend", language("Complete before starting this task", "Завершить перед запуском задачи")));
  for (const candidate of entries) {
    const row = element("label", undefined, "dependency-option");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = dependencies.has(candidate.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) dependencies.add(candidate.id);
      else dependencies.delete(candidate.id);
    });
    row.append(checkbox, candidate.id + " · " + candidate.title);
    choices.append(row);
  }
  if (!entries.length) choices.append(element("p", language("No other tasks on this board.", "На доске нет других задач.")));
  editor.prepend(choices);
}

async function editExecution(task) {
  const title = language("Execution settings", "Параметры запуска");
  openSheet("execution", title);
  const loading = element("p", language("Loading models…", "Загрузка моделей…"), "muted");
  body.append(loading);
  const result = await api.executionModels();
  if (!sheet.open || !loading.isConnected) return;
  const models = result.ok ? result.data : [];
  const selected = task.execution?.model ?? "";
  const defaultLabel = language("Board default", "По умолчанию на доске");
  const canSetDirectory = !task.git && !task.codexThreadId && !task.history.some(event => event.action === "start");
  const modelOptions = [["", defaultLabel], ...models.map(model => [model.id, model.name])];
  if (selected && !models.some(model => model.id === selected)) {
    modelOptions.push([selected, selected + " · " + language("unavailable", "недоступна")]);
  }
  const editor = form("execution", title, [
    { name: "model", label: language("Model", "Модель"), value: selected, options: modelOptions },
    { name: "effort", label: language("Reasoning effort", "Уровень размышлений"), options: [] },
    ...(canSetDirectory ? [{ name: "workingDirectory", value: task.workingDirectory ?? "",
      label: language("Working directory (empty for a task worktree)", "Рабочая папка (пустое поле для отдельного worktree)") }] : []),
  ], language("Save", "Сохранить"), async ({ model, effort, workingDirectory }) => {
    if (model && !models.some(entry => entry.id === model)) {
      notice(language("Choose an available model.", "Выберите доступную модель."));
      return;
    }
    const saved = await command("update", task.id, {
      execution: model ? { model, effort: effort || undefined } : null,
      ...(canSetDirectory ? { workingDirectory: workingDirectory.trim() || null } : {}),
      revision: task.revision, actor: "user",
    });
    if (saved) await showTask(saved.id);
  });
  const [model, effort] = editor.querySelectorAll("select");
  function setEfforts(value) {
    const available = models.find(entry => entry.id === model.value)?.efforts ?? [];
    effort.replaceChildren(new Option(language("Provider default", "По умолчанию у провайдера"), ""),
      ...available.map(value => new Option(value, value)));
    effort.disabled = !available.length;
    if (available.includes(value)) effort.value = value;
  }
  model.addEventListener("change", () => setEfforts(""));
  setEfforts(task.execution?.effort);
  if (!result.ok) notice(boardError(result.error));
}

function editTaskTags(task) {
  const editor = form("task-tags", language("Edit tags", "Изменить теги") + " · " + task.id, [
    { name: "tags", label: language("Tags, comma separated", "Теги через запятую"), value: task.tags.join(", ") },
  ], language("Save", "Сохранить"), async ({ tags }) => {
    const saved = await command("tag-assign", task.id, {
      tags: tags.split(",").map(tag => tag.trim()).filter(Boolean), revision: task.revision,
    });
    if (saved && editor.isConnected && sheet.open) await showTask(task.id);
  });
  editor.querySelector("input").focus();
}

function openTaskSheet(task) {
  openSheet("task", task.id + (task.title ? " · " + task.title : ""));
  const runStatus = element("span", undefined, "task-agent-run muted");
  runStatus.id = "task-agent-run";
  renderAgentRunStatus(runStatus, task);
  byId("sheet-title").append(runStatus);
  const lane = lanes.find(([state]) => state === shownStatus(task));
  const status = lane ? language(lane[1], lane[2]) : task.status;
  const metadata = [status, task.priority && priorityName(task.priority), task.updatedAt && shortDate(task.updatedAt)].filter(Boolean);
  if (metadata.length) body.append(element("p", metadata.join(" · "), "muted"));
}

async function showTask(id) {
  const request = ++taskSheetRequest;
  const project = frame.project;
  const refresh = sheet.open && sheetKind === "task" && taskInSheet?.id === id;
  let loading;
  if (!refresh) {
    const preview = frame.board?.tasks.find(task => task.id === id) ??
      frame.board?.archived?.find(task => task.id === id) ?? { id };
    taskInSheet = undefined;
    openTaskSheet(preview);
    taskDescription(preview.description, id);
    loading = element("p", language("Loading task details…", "Загружаю детали задачи…"), "muted");
    loading.setAttribute("role", "status");
    body.append(loading);
    body.scrollTop = 0;
  }
  const result = await api.command("show", id).catch(error => ({ ok: false, error }));
  if (request !== taskSheetRequest || project !== frame.project || !sheet.open) return;
  if (!result.ok) {
    notice(boardError(result.error));
    if (loading) {
      loading.replaceWith(button(language("Retry loading", "Повторить загрузку"), () => showTask(id)));
    }
    return;
  }
  const task = result.data;
  const descriptionOpen = [...body.querySelectorAll(".task-description-details")].map(details => details.open);
  const scroll = refresh ? body.scrollTop : 0;
  const focusedChat = refresh && document.activeElement.id === "task-chat-input" ? document.activeElement : undefined;
  const openDetails = new Set(refresh ? [...body.querySelectorAll(".task-details[open]")].map(details => details.id) : []);
  taskInSheet = task;
  openTaskSheet(task);
  if (task.status === "blocked" && task.blocked) body.append(blockerBanner(task.blocked));
  if (task.status === "done" && task.cleanupAvailable) {
    body.append(element("p", language("Accepted · worktree retained", "Принято · рабочая копия сохранена"), "muted"));
  }
  savedChangesSection(task, task.savedChanges);
  if (task.tags.length) {
    const tags = element("div", undefined, "task-tags");
    tags.id = "task-sheet-tags";
    tags.append(...tagBadges(task.tags));
    body.append(tags);
  }
  if (task.milestone) {
    const { repository, number, title } = task.milestone;
    body.append(button(language("GitHub milestone", "Веха GitHub") + " · " + title,
      () => api.openLink("https://github.com/" + repository + "/milestone/" + number), "quiet task-milestone-link"));
  }
  taskDescription(task.description, id);
  body.querySelectorAll(".task-description-details").forEach((details, index) => {
    details.open = descriptionOpen[index] ?? false;
  });
  section(language("Acceptance criteria", "Критерии приёмки"), task.criteria);
  const stateLabel = (done, text) => {
    const label = element("div", undefined, "task-state-label");
    const state = icon(done ? "check" : "circle");
    state.removeAttribute("aria-hidden");
    state.setAttribute("role", "img");
    state.setAttribute("aria-label", done ? language("Completed", "Выполнено") : language("Pending", "Ожидает"));
    label.append(state, chatText(text));
    return label;
  };
  section(language("Subtasks", "Подзадачи"), task.subtasks.map(item => stateLabel(item.done, item.title)));
  if (task.status === "in_progress") section(language("Submission", "Сдача"), language("Result not submitted", "Результат не сдан"));
  section(language("Progress", "Ход работы"), task.summary);
  section(language("Next step", "Следующий шаг"), task.nextStep);
  if (task.dependencies?.length) {
    const waiting = new Set(task.unfinishedDependencies);
    const names = new Map([...(frame.board?.tasks ?? []), ...(frame.board?.archived ?? [])]
      .map(entry => [entry.id, entry.title]));
    const label = waiting.size ? language("Blocked by dependencies", "Заблокировано зависимостями") :
      language("Task dependencies", "Зависимости задачи");
    section(label, task.dependencies.map(id => stateLabel(!waiting.has(id),
      id + (names.has(id) ? " · " + names.get(id) : ""))));
  }
  if (task.execution) {
    section(language("Execution settings", "Параметры запуска"), task.execution.model + " · " +
      (task.execution.effort ?? language("Provider default", "По умолчанию у провайдера")));
  }
  if (task.schedule) {
    const schedule = [scheduleLabel(task.schedule)];
    if (task.status === "ready" && !task.unfinishedDependencies?.length) {
      schedule.push(language("Next run", "Следующий запуск") + " · " + shortDate(task.schedule.nextAt));
    }
    section(language("Schedule", "Расписание"), schedule);
  }
  showSubmissionResult(task.result);
  showTaskArtifacts(task, body, openDetails.has("task-review-files"));
  if (task.git) showTaskGit(task.git, openDetails.has("task-git"));
  if (task.attachments.length) {
    const images = task.attachments.filter(isImageAttachment);
    const previous = selectedCover(task, images)?.file ?? "";
    if ((images.length > 1 || (images.length === 1 && !previous)) && !frame.board?.archived.some(entry => entry.id === task.id)) {
      const label = element("label", undefined, "task-cover-setting");
      label.append(element("span", language("Card cover", "Превью карточки")));
      const picker = element("select");
      if (!previous) {
        const none = new Option(language("No cover", "Без превью"), "");
        none.disabled = true;
        picker.append(none);
      }
      picker.append(...images.map(file => new Option(file.name, file.file)));
      picker.value = previous;
      picker.addEventListener("change", protect(async () => {
        picker.disabled = true;
        try {
          const updated = await command("attachment-cover", task.id, { file: picker.value, revision: task.revision });
          if (updated && taskInSheet?.id === task.id && sheetKind === "task") await showTask(task.id);
          if (!updated) picker.value = previous;
        } finally {
          picker.disabled = false;
        }
      }));
      label.append(picker);
      body.append(label);
    }
    const chatFiles = new Set(task.history.flatMap(event => event.chat?.files ?? []));
    const downloads = element("div", undefined, "sheet-actions");
    for (const attachment of task.attachments.filter(file => !chatFiles.has(file.file))) {
      downloads.append(taskAttachmentButton(task.id, attachment));
    }
    if (downloads.childElementCount) body.append(downloads);
  }
  const actions = element("div", undefined, "sheet-actions");
  const act = async (name, input) => {
    const result = await command(name, task.id, { revision: task.revision, ...input });
    if (result) await showTask(task.id);
  };
  if (task.status === "draft") actions.append(button(language("Approve", "Утвердить"), () => act("approve"), "primary"));
  if (!frame.board?.archived.some(entry => entry.id === task.id) && (task.milestone || frame.board?.gitInfo?.githubRepository)) {
    actions.append(button(language("Milestone…", "Веха…"), () => editMilestone(task)));
  }
  if (task.status === "ready") actions.append(button(language("Return to draft", "Вернуть в черновик"), () => act("return-to-draft")));
  if (["draft", "ready"].includes(task.status)) {
    actions.append(button(language("Dependencies…", "Зависимости…"), () => editDependencies(task)));
    actions.append(button(language("Execution settings…", "Параметры запуска…"), () => editExecution(task)));
  }
  if (task.workingDirectory) {
    const directory = element("section", undefined, "sheet-section");
    const location = element("p", language("Working directory", "Рабочая папка") + " · ");
    location.append(element("code", task.workingDirectory));
    directory.append(location);
    body.append(directory);
  }
  if (task.status === "review") {
    const reviewLabel = task.result?.noChanges
      ? language("Review result", "Проверить результат")
      : language("Review changes", "Проверить изменения");
    actions.append(button(reviewLabel, () => showReview(task), "primary"));
    actions.append(button(language("Request changes", "Вернуть на доработку"), () => noteTask(task, "request-changes")));
  }
  if (task.git?.worktree) actions.append(button(language("Open worktree", "Открыть worktree"), async () => {
    const result = await api.openWorktree(task.id);
    if (!result.ok) notice(boardError(result.error));
  }));
  if (["done", "cancelled"].includes(task.status)) {
    actions.append(button(language("Edit tags", "Изменить теги"), () => editTaskTags(task)));
    if (task.cleanupAvailable) {
      actions.append(button(language("Worktree cleanup…", "Уборка рабочей копии…"), () => showCleanup(task)));
    }
  } else {
    actions.append(button(language("Edit", "Редактировать"), () => taskEditor(task)));
    actions.append(button(language("Cancel task", "Отменить задачу"), () => noteTask(task, "cancel"), "danger"));
  }
  const codexAction = codexTaskAction(task);
  if (codexAction) actions.append(codexAction);
  body.append(actions);
  if (task.status === "review" || task.history.some(event => event.actor === "reviewer" || event.action === "submit")) {
    body.append(reviewerChat(task, openDetails.has("task-reviewer-chat")));
  }
  body.append(taskChat(task));
  body.scrollTop = scroll;
  if (focusedChat && byId("task-chat-input")) {
    byId("task-chat-input").focus({ preventScroll: true });
    byId("task-chat-input").setSelectionRange(focusedChat.selectionStart, focusedChat.selectionEnd);
  }
}

function taskDetails(id, title, hint, open) {
  const details = element("details", undefined, "task-details");
  details.id = id;
  details.open = open;
  const header = element("summary", undefined, "task-details-header");
  const arrow = element("i", undefined, "codicon codicon-chevron-right");
  arrow.setAttribute("aria-hidden", "true");
  header.append(arrow, element("span", title));
  if (hint) header.append(element("span", hint, "task-details-hint"));
  details.append(header);
  return details;
}

function showTaskArtifacts(task, target = body, open = false) {
  if (!task.artifacts?.length) return;
  const count = activityCount(task.artifacts.length, ["file", "files"], ["файл", "файла", "файлов"]);
  const area = taskDetails("task-review-files", language("Review materials", "Материалы проверки"), count, open);
  const content = element("div", undefined, "task-details-content");
  const groups = [
    [/\.(?:json|xml|html?|md|txt)$/i, language("Reports and documents", "Отчёты и документы")],
    [/\.(?:log|out)$/i, language("Logs", "Журналы")],
    [/\.(?:ps1|sh|bat|cmd|py|mjs|js)$/i, language("Scripts", "Скрипты")],
    [/\.(?:sha256|sha512|sha1|md5)$/i, language("Checksums", "Контрольные суммы")],
    [/.*/, language("Other files", "Другие файлы")],
  ];
  const entries = task.artifacts.map(artifact => ({ ...artifact, name: artifact.source.split(/[\\/]/).at(-1) }));
  const byName = Map.groupBy(entries, entry => entry.name);
  const byGroup = Map.groupBy(entries, entry => groups.find(([pattern]) => pattern.test(entry.name)));
  const reveal = language("Show in folder", "Показать в папке");
  for (const group of groups) {
    const files = byGroup.get(group);
    if (!files) continue;
    const list = element("ul", undefined, "task-review-files");
    for (const { name, source, sha256 } of files) {
      const link = button("", async () => {
        const result = await api.revealArtifact(task.id, source, sha256);
        if (!result.ok) notice(boardError(result.error));
      }, "quiet task-review-file");
      link.title = source + "\nSHA-256 " + sha256;
      const label = element("span", name, "task-review-file-name");
      const matching = byName.get(name);
      if (matching.length > 1) {
        const directory = source.slice(0, -name.length);
        const repeatedPath = matching.filter(entry => entry.source === source).length > 1;
        const version = repeatedPath ? sha256.slice(0, 12) : "";
        label.append(element("small", [directory, version].filter(Boolean).join(" · ")));
      }
      link.append(label, element("span", reveal, "task-review-file-action"));
      const row = element("li");
      row.append(link);
      list.append(row);
    }
    content.append(element("h3", group[1]), list);
  }
  area.append(content);
  target.append(area);
}

function showTaskGit(git, open) {
  const area = taskDetails("task-git", language("Git details", "Сведения Git"),
    git.target?.replace(/^refs\/heads\//, ""), open);
  const info = element("dl", undefined, "task-details-content task-git-info");
  const fields = [
    [language("Target branch", "Целевая ветка"), git.target],
    [language("Task worktree", "Рабочая копия задачи"), git.worktree],
    [language("Submitted commit", "Сданный коммит"), git.submission?.sha],
    [language("Acceptance commit", "Коммит приёмки"), git.accepted],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const item = element("dd");
    item.append(element("code", value));
    info.append(element("dt", label), item);
  }
  if (!info.childElementCount) return;
  area.append(info);
  body.append(area);
}

async function showCleanup(task, draft = "", error) {
  const generation = projectGeneration;
  const status = await command("cleanup-status", task.id);
  if (!status || generation !== projectGeneration || taskInSheet?.id !== task.id || !sheet.open ||
      !["task", "cleanup"].includes(sheetKind)) return;
  if (!status.pending) return showTask(task.id);
  const fields = task.status === "done" && status.path ? [{
    name: "artifacts", type: "area", value: draft,
    label: language("Temporary evidence files to clear with the worktree (one relative path per line)",
      "Временные файлы проверки для уборки (один относительный путь на строку)"),
  }] : [];
  const editor = form("cleanup", language("Worktree cleanup", "Уборка рабочей копии"), fields,
    language("Retry cleanup", "Повторить уборку"), async ({ artifacts }) => {
      const paths = artifacts?.split("\n").map(path => path.trim()).filter(Boolean);
      const result = await api.command("cleanup", task.id, paths?.length ? { artifacts: paths } : {});
      if (generation !== projectGeneration || taskInSheet?.id !== task.id || sheetKind !== "cleanup" || !sheet.open) return;
      if (result.ok) await showTask(task.id);
      else await showCleanup(task, result.error.code === "DIRTY_WORKTREE" ? "" : artifacts, result.error);
    });
  const summary = element("section", undefined, "sheet-section");
  if (status.path) summary.append(element("p", status.path, "muted"));
  const reasons = {
    DIRTY_WORKTREE: language("Local files or changes are keeping this worktree in place.",
      "Рабочая копия сохранена из-за локальных файлов или изменений."),
    WORKTREE_LOCKED: language("The worktree is locked.", "Рабочая копия заблокирована."),
    TASK_BRANCH_CHANGED: language("The task branch changed after submission.", "Ветка задачи изменилась после сдачи."),
  };
  if (reasons[status.reason]) summary.append(element("p", reasons[status.reason]));
  if (status.entries.length) summary.append(element("pre", status.entries.join("\n")));
  editor.before(summary);
  if (error) notice(boardError(error));
}

function taskAttachmentButton(id, attachment, kind) {
  const download = button(attachment.name, async () => {
    const result = await api.saveAttachment(id, attachment.file, attachment.name);
    if (!result.ok) notice(boardError(result.error));
  }, kind);
  download.prepend(icon("cloud-download"));
  return download;
}

function noteTask(task, action) {
  const comment = action === "comment";
  form("note", comment ? language("Add comment", "Добавить комментарий") : language("Reason", "Причина"), [
    { name: "note", label: comment ? language("Comment", "Комментарий") : language("Reason", "Причина"), type: "area", required: true },
  ], language("Save", "Сохранить"), async ({ note }) => {
    const saved = await command(action, task.id, {
      revision: task.revision, actor: "user", [comment ? "text" : "reason"]: note,
    });
    if (saved) await showTask(task.id);
  });
}

function savedChangesSection(task, saved, pending = false) {
  if (!saved) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", language("Saved local changes", "Сохранённые локальные правки")));
  if (saved.restored) {
    area.append(element("p", language("Restored to ", "Восстановлены в папке ") + saved.restored.path));
  } else {
    const restore = async destination => {
      const result = await command("restore-changes", task.id, { revision: task.revision, destination });
      if (result) await showTask(task.id);
    };
    const actions = element("div", undefined, "sheet-actions");
    if (!pending) {
      const target = task.git.target.replace(/^refs\/heads\//, "");
      actions.append(button(language("Restore in ", "Восстановить в ") + target, () => restore("target")));
    }
    actions.append(button(language("Restore in a separate worktree", "Восстановить в отдельной рабочей копии"), () => restore("worktree")));
    area.append(actions);
  }
  body.append(area);
}

async function showAcceptedTask(task) {
  await showTask(task.id);
  const messages = [];
  if (task.localChangesWarning) messages.push(boardError(task.localChangesWarning));
  if (task.cleanupWarning && taskInSheet?.id === task.id && taskInSheet.cleanupAvailable) {
    messages.push(language("The task was accepted. Automatic cleanup is pending.",
      "Задача принята. Автоматическая уборка пока не завершена.") + "\n" + boardError(task.cleanupWarning));
  }
  if (messages.length) notice(messages.join("\n"));
}

async function showReview(task, messageDraft, acceptanceError) {
  const generation = projectGeneration;
  const review = await command("review", task.id);
  if (!review || generation !== projectGeneration) return;
  task = { ...task, revision: review.revision };
  if (review.noChanges) {
    const editor = form("review", language("Review result", "Проверка результата"), [], language("Accept", "Принять"), async () => {
      const accepted = await command("accept", task.id, { revision: review.revision });
      if (accepted && generation === projectGeneration) await showAcceptedTask(accepted);
    });
    section(language("Acceptance criteria", "Критерии приёмки"), task.criteria);
    showSubmissionResult(review.result);
    showTaskArtifacts(task);
    body.prepend(element("p", language("Submitted without Git changes.", "Сдано без изменений в Git."), "muted"));
    body.append(editor);
    if (review.stale) {
      notice(language("The task worktree changed. Submit it again.", "Рабочая копия изменилась. Сдайте задачу повторно."));
      editor.querySelector("button[type=submit]").disabled = true;
    }
    return;
  }
  const local = review.localChanges;
  const editor = form("review", language("Review changes", "Проверка изменений"), [
    { name: "message", label: language("Acceptance commit message", "Сообщение коммита приёмки"), type: "area",
      value: messageDraft ?? review.message, required: true },
  ], language("Accept", "Принять"), async ({ message }) => {
    const result = await api.command("accept", task.id, {
      revision: task.revision, targetHead: review.targetHead, message,
    });
    if (generation !== projectGeneration) return;
    if (result.ok) {
      await showAcceptedTask(result.data);
    } else {
      if (sheetKind === "review" && taskInSheet?.id === task.id) await showReview(task, message, result.error);
      else notice(boardError(result.error), [language("Accepting task", "Приёмка задачи"), task.id, projectName()].join(" · "));
    }
  });
  const diff = renderReviewDiff(review.diff);
  const caption = element("p", review.target + " · " + review.mode + " · " + review.submitted.slice(0, 12), "muted");
  body.prepend(caption, diff);
  const submittedResult = document.createDocumentFragment();
  showSubmissionResult(review.result, submittedResult);
  showTaskArtifacts(task, submittedResult);
  editor.before(submittedResult);
  if (local && !review.pending) {
    const overlap = new Set(local.overlaps);
    const changes = element("section", undefined, "sheet-section");
    changes.append(element("h3", language("Local changes in the target worktree", "Локальные правки в целевой копии")));
    changes.append(element("p", local.path, "muted"));
    const list = element("ul");
    for (const path of local.paths) {
      list.append(element("li", path + (overlap.has(path) ? language(" (also changed by the task)", " (затронут задачей)") : "")));
    }
    changes.append(list);
    changes.append(element("p", local.token
      ? language("Your local changes will remain in the worktree after acceptance.",
        "После приёмки локальные правки останутся в рабочей копии.")
      : language("The current Git state prevents automatic preservation.", "Текущее состояние Git мешает автоматически сохранить правки.")));
    editor.before(changes);
    if (!local.token) editor.querySelector("button[type=submit]").disabled = true;
  }
  savedChangesSection(task, review.savedChanges, review.pending);
  const conflict = review.merge?.status === "conflict" ? { code: "MERGE_CONFLICT", details: { paths: review.merge.paths } } :
    acceptanceError?.code === "MERGE_CONFLICT" && acceptanceError.details?.targetHead === review.targetHead ? acceptanceError : undefined;
  if (conflict) {
    const input = JSON.stringify({ revision: task.revision, resolveConflicts: true });
    const prompt = [
      language("Resolve conflicts in task ", "Разреши конфликты в задаче ") + task.id + ".",
      language("Use AI Taskboard ", "Вызови команду AI Taskboard ") + "start " + task.id + " --stdin " +
        language("with JSON input ", "с JSON на stdin ") + input + ".",
      language("Resolve the conflicts in the task worktree, run the checks and resubmit for review.",
        "Разреши конфликты в рабочей копии задачи, выполни проверки и повторно сдай результат."),
    ].join("\n");
    body.append(button(language("Copy request for agent", "Скопировать запрос для агента"), async () => {
      await navigator.clipboard.writeText(prompt);
      notice(language("Request copied.", "Запрос скопирован."));
    }));
  }
  if (review.stale && !review.pending) {
    notice(language("The task worktree changed. Submit it again.", "Рабочая копия изменилась. Сдайте задачу повторно."));
    body.querySelector("button[type=submit]").disabled = true;
  } else if (conflict || acceptanceError) notice(boardError(conflict ?? acceptanceError));
  body.append(button(language("Use an existing acceptance commit", "Указать существующий коммит приёмки"), () => {
    form("review", language("Existing acceptance commit", "Существующий коммит приёмки"), [
      { name: "commit", label: language("Full commit SHA", "Полный SHA коммита"), required: true },
    ], language("Verify and accept", "Проверить и принять"), async ({ commit }) => {
      const accepted = await command("accept", task.id, { revision: task.revision, commit });
      if (accepted) await showAcceptedTask(accepted);
    });
    body.prepend(element("p", review.target, "muted"));
  }));
}

function codexSettings() {
  const section = element("section", undefined, "provider-panel");
  section.append(element("h3", language("Codex model provider", "Провайдер моделей Codex")));
  const status = element("p", language("Checking Codex…", "Проверяем Codex…"), "muted");
  status.setAttribute("role", "status");
  const details = element("p", undefined, "muted");
  const actions = element("div", undefined, "sheet-actions");
  const choose = button(language("Choose executable…", "Выбрать файл…"), () => update(api.chooseCodex));
  const auto = button(language("Detect automatically", "Найти автоматически"), () => update(api.autoDetectCodex));
  const refresh = button(language("Refresh status", "Обновить статус"), () => update(api.codexStatus));
  actions.append(choose, auto, refresh);
  section.append(status, details, actions);
  body.append(section);

  async function update(load) {
    for (const item of actions.children) item.disabled = true;
    status.textContent = language("Checking Codex…", "Проверяем Codex…");
    try {
      const result = await load();
      const messages = {
        unavailable: language("Codex with App Server support was not found.", "Codex с поддержкой App Server не найден."),
        ready: language("Codex executable found.", "Исполняемый файл Codex найден."),
        error: language("Could not check Codex.", "Не удалось проверить Codex."),
      };
      status.textContent = messages[result.state] || messages.error;
      details.textContent = [result.clientPath ?? result.selectedPath, result.clientVersion ? "Codex " + result.clientVersion : "",
        result.error].filter(Boolean).join(" · ");
      auto.hidden = !result.selectedPath;
    } catch (error) {
      status.textContent = language("Could not check Codex.", "Не удалось проверить Codex.");
      details.textContent = error.message;
    } finally {
      for (const item of actions.children) item.disabled = false;
    }
  }

  void update(api.codexStatus);
}

function tagColorInput(value, label) {
  const control = element("span", undefined, "tag-color-input");
  const picker = element("input");
  picker.type = "color";
  picker.setAttribute("aria-label", label);
  const hex = element("input");
  hex.required = true;
  hex.pattern = "#[0-9a-fA-F]{6}";
  hex.spellcheck = false;
  hex.setAttribute("aria-label", label + " (HEX)");
  hex.title = "#RRGGBB";
  const set = color => {
    hex.value = color;
    picker.value = color;
  };
  set(value);
  hex.addEventListener("input", () => {
    if (hex.checkValidity()) picker.value = hex.value;
  });
  picker.addEventListener("change", () => {
    set(picker.value.toUpperCase());
    hex.dispatchEvent(new Event("change"));
  });
  control.append(hex, picker);
  return { control, hex, picker, set };
}

function renderTagSettings(panel) {
  const focusedTag = panel.contains(document.activeElement) ? document.activeElement.dataset.tag : undefined;
  const add = element("form", undefined, "tag-create");
  const name = element("input");
  name.required = true;
  name.placeholder = language("Tag name", "Название тега");
  name.setAttribute("aria-label", name.placeholder);
  const color = tagColorInput("#6747A9", language("New tag color", "Цвет нового тега"));
  const submit = element("button", language("Add tag", "Добавить тег"), "button");
  submit.type = "submit";
  add.append(name, color.control, submit);
  add.addEventListener("submit", event => {
    event.preventDefault();
    void protect(async () => {
      submit.disabled = true;
      try {
        if (await command("tag-create", undefined, { name: name.value, color: color.hex.value })) name.value = "";
      } finally { submit.disabled = false; }
    })();
  });
  panel.replaceChildren(element("h3", language("Board tags", "Теги доски")), add);
  const tags = [...boardTags.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const tag of tags) {
    const row = element("div", undefined, "tag-setting");
    const badge = tagBadge(tag.name, tag.color);
    const { control, hex, picker, set } = tagColorInput(tag.color, tag.name);
    hex.dataset.tag = tag.name;
    hex.addEventListener("keydown", event => {
      if (event.key === "Enter" && hex.reportValidity()) hex.blur();
    });
    hex.addEventListener("change", protect(async () => {
      if (!hex.reportValidity()) return;
      hex.disabled = picker.disabled = true;
      try {
        const saved = await command("tag-color", undefined, { name: tag.name, color: hex.value });
        set(saved?.color ?? tag.color);
        if (saved?.color) badge.style.setProperty("--tag-color", saved.color);
      } finally { hex.disabled = picker.disabled = false; }
    }));
    row.append(badge, control);
    panel.append(row);
    if (tag.name === focusedTag) hex.focus();
  }
}

function settings() {
  const roles = [
    ["executor", language("Executors", "Исполнители")],
    ["manager", language("Manager goals and background runs", "Цели и фоновые запуски менеджера")],
    ["reviewer", language("Reviewers", "Ревьюеры")],
  ];
  const editor = form("settings", language("Application settings", "Настройки приложения"),
    roles.map(([name, label]) => ({ name, label, type: "number", required: true })),
    language("Save limits", "Сохранить лимиты"), async values => {
      const result = await api.agentLimits(Object.fromEntries(Object.entries(values).map(([role, value]) => [role, Number(value)])));
      if (!result.ok) return notice(boardError(result.error));
      if (editor.isConnected) sheet.close();
    });
  editor.id = "agent-limits";
  editor.prepend(element("h3", language("Concurrent agents", "Параллельная работа агентов")),
    element("p", language("Defaults for each board. Board settings can override them. Use 0 for unlimited.",
      "Значения по умолчанию для каждой доски. Их можно переопределить в настройках доски. 0 — без ограничений."), "muted"));
  const inputs = [...editor.querySelectorAll('input[type="number"]')];
  const save = editor.querySelector('button[type="submit"]');
  for (const input of inputs) input.disabled = true;
  save.disabled = true;
  void api.agentLimits().then(result => {
    if (!editor.isConnected) return;
    if (!result.ok) return notice(boardError(result.error));
    for (const [index, [role]] of roles.entries()) {
      inputs[index].value = result.data[role];
      inputs[index].disabled = false;
    }
    save.disabled = false;
  }).catch(error => { if (editor.isConnected) notice(error.message); });
  appearanceSettings();
  codexSettings();
}

function boardSettings() {
  if (!frame.board) return;
  chatCatalog = undefined;
  const current = frame.board.settings;
  const reviewMode = current.reviewMode ?? (current.autoReview === true ? "reviewer" : "human");
  const defaultModel = language("Codex default", "По умолчанию в Codex");
  const roles = [
    ["manager", language("Project manager", "Менеджер проекта")],
    ["executor", language("Executor", "Исполнитель")],
    ["reviewer", language("Reviewer", "Ревьюер")],
  ];
  const agentFields = roles.map(([role]) => {
    const model = current[role]?.model ?? "";
    const effort = current[role]?.effort ?? "";
    return [
      { name: role + "Provider", label: language("Provider", "Провайдер"), value: current[role]?.provider ?? "codex",
        options: [["codex", "Codex"]] },
      { name: role + "Model", label: language("Model", "Модель"), value: model,
        options: model ? [[model, model]] : [["", defaultModel]] },
      { name: role + "Effort", label: language("Reasoning effort", "Уровень рассуждения"), value: effort,
        options: [[effort, effort ? reasoningName(effort) : defaultModel]] },
      { name: role + "Limit", type: "number", value: current.agentLimits?.[role],
        label: role === "manager" ? language("Concurrent background runs", "Лимит фоновых запусков")
          : language("Concurrent agents", "Лимит параллельной работы") },
    ];
  });
  let models = [];
  const editor = form("board-settings", language("Board settings", "Настройки доски") + " · " + projectName(), [
    { name: "name", label: language("Board name (blank uses folder name)", "Имя доски (пусто — имя папки)"), value: current.name },
    { name: "archive", label: language("Archive after days (blank disables)", "Архивировать через N дней (пусто — отключено)"),
      type: "number", value: current.archiveAfterDays },
    { name: "mode", label: language("Acceptance mode", "Режим приёмки"), value: current.integrationMode,
      options: [["merge", "Merge"], ["squash", "Squash"]] },
    { name: "showCardPreviews", label: language("Show previews on board cards", "Показывать превью на карточках"),
      type: "checkbox", value: current.showCardPreviews !== false },
    { name: "reviewMode", label: language("Who reviews tasks", "Кто проверяет задачи"),
      value: reviewMode, options: [
        ["human", language("Human", "Человек")],
        ["manager", language("Project manager", "Менеджер проекта")],
        ["reviewer", language("Reviewer", "Ревьюер")],
      ] },
    ...agentFields.flat(),
  ], language("Save settings", "Сохранить настройки"), async values => {
    const agents = {};
    const agentLimits = {};
    for (const [role, title] of roles) {
      if (values[role + "Limit"] !== "") agentLimits[role] = Number(values[role + "Limit"]);
      const { [role + "Provider"]: provider, [role + "Model"]: model, [role + "Effort"]: effort } = values;
      if (provider === (current[role]?.provider ?? "codex") && model === (current[role]?.model ?? "") &&
          effort === (current[role]?.effort ?? "")) continue;
      if (model && !models.some(entry => entry.id === model && (entry.effort === effort || entry.efforts.includes(effort)))) {
        notice(title + " · " + language("Choose an available model and reasoning effort.", "Выберите доступную модель и уровень рассуждения."));
        return;
      }
      agents[role] = model ? { provider, model, effort } : null;
    }
    if (await command("settings", undefined, {
      ...(values.name.trim() !== (current.name ?? "") ? { name: values.name } : {}),
      archiveAfterDays: values.archive === "" ? null : Number(values.archive), integrationMode: values.mode,
      showCardPreviews: values.showCardPreviews,
      ...(values.reviewMode !== reviewMode ? { reviewMode: values.reviewMode } : {}),
      ...(roles.some(([role]) => agentLimits[role] !== current.agentLimits?.[role]) ? { agentLimits } : {}),
      ...agents,
    })) sheet.close();
  });
  const [, review, ...selects] = editor.querySelectorAll("select");
  const reviewHint = element("small", undefined, "muted");
  const updateReviewHint = () => {
    reviewHint.textContent = {
      human: language("You decide whether to accept the task or return it.", "Вы принимаете задачу или возвращаете её на доработку."),
      manager: language("The project manager checks the submission and decides.", "Менеджер сам проверяет сдачу и принимает решение."),
      reviewer: language("The reviewer checks submissions. The manager decides when and whether to integrate approved work.", "Ревьюер проверяет сдачи. Менеджер решает, вливать ли согласованные изменения и когда."),
    }[review.value];
  };
  review.parentElement.append(reviewHint);
  review.addEventListener("change", updateReviewHint);
  updateReviewHint();
  const limits = roles.map(([role]) => editor.elements.namedItem(role + "Limit"));
  selects[0].parentElement.before(element("p", language(
    "An empty limit uses the application default. Use 0 for unlimited.",
    "Пустое поле лимита берёт значение из настроек приложения. 0 — без ограничений."), "muted"));
  void api.agentLimits().then(result => {
    if (!result.ok || !editor.isConnected) return;
    roles.forEach(([role], index) => { limits[index].placeholder = String(result.data[role]); });
  }).catch(() => {});
  const roleControls = roles.map(([role, title], index) => {
    const [provider, model, effort] = selects.slice(index * 3, index * 3 + 3);
    const group = element("fieldset", undefined, "board-agent-settings");
    provider.parentElement.before(group);
    group.append(element("legend", title), provider.parentElement, model.parentElement, effort.parentElement,
      limits[index].parentElement);
    const savedModel = current[role]?.model ?? "";
    const savedEffort = current[role]?.effort ?? "";
    const showEfforts = (saved = "") => {
      const selected = models.find(entry => entry.id === model.value);
      const options = [...new Set([...(selected?.efforts ?? []), selected?.effort].filter(Boolean))];
      if (saved && !options.includes(saved)) options.push(saved);
      effort.replaceChildren(...(options.length ? options.map(value => new Option(reasoningName(value), value)) :
        [new Option(defaultModel, "")]));
      effort.disabled = !selected || !options.length;
      effort.value = saved || selected?.effort || options[0] || "";
    };
    model.disabled = effort.disabled = true;
    model.addEventListener("change", () => showEfforts(model.value === savedModel ? savedEffort : ""));
    return () => {
      model.replaceChildren(new Option(defaultModel, ""), ...models.map(entry => new Option(entry.name, entry.id)));
      if (savedModel && !models.some(entry => entry.id === savedModel)) {
        model.append(new Option(savedModel + " · " + language("unavailable", "недоступна"), savedModel));
      }
      model.value = savedModel;
      model.disabled = !models.length && !savedModel;
      showEfforts(savedEffort);
    };
  });
  const modelStatus = element("p", language("Loading Codex models…", "Загрузка моделей Codex…"), "muted");
  modelStatus.setAttribute("role", "status");
  editor.lastElementChild.before(modelStatus);
  void Promise.resolve().then(() => api.chatModels()).catch(error => ({ ok: false, error: { message: error.message } })).then(result => {
    if (!editor.isConnected) return;
    models = result.ok ? result.data : [];
    roleControls.forEach(refresh => refresh());
    modelStatus.textContent = !result.ok ? boardError(result.error) : !models.length ?
      language("No Codex models available.", "Нет доступных моделей Codex.") : "";
    modelStatus.hidden = !modelStatus.textContent;
  });
  body.append(button(language("Check archives now", "Проверить архивацию"), () => command("archive")));
  const tags = element("section", undefined, "tag-settings");
  tags.id = "tag-settings";
  renderTagSettings(tags);
  body.append(tags);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const select = byId("theme-select");
  if (select) select.value = theme;
}

function appearanceSettings() {
  const panel = element("section", undefined, "appearance-panel");
  panel.append(element("h3", language("Appearance", "Оформление")));
  const label = element("label", language("Theme", "Тема"));
  const select = element("select");
  select.id = "theme-select";
  select.disabled = true;
  label.append(select);
  panel.append(label);
  body.prepend(panel);
  api.themes().then(themes => {
    const translated = {
      system: language("System", "Как в системе"),
      light: language("Light", "Светлая"),
      dark: language("Dark", "Тёмная"),
    };
    select.replaceChildren(...themes.map(([id, label]) => new Option(translated[id] ?? label, id)));
    select.value = frame.theme ?? "system";
    select.disabled = false;
  }).catch(error => notice(error.message));
  select.addEventListener("change", protect(async () => {
    select.disabled = true;
    try {
      const result = await api.setTheme(select.value);
      if (!result.ok) {
        select.value = frame.theme;
        notice(boardError(result.error));
      }
    } finally {
      select.disabled = false;
    }
  }));
}

let gitMenuRequest = 0;

async function gitCommand(action, input, project) {
  const result = await api.command("git-" + action, undefined, input);
  if (frame.project !== project) return;
  if (!result.ok) {
    const actions = {
      refs: ["Loading Git branches", "Загрузка веток Git"],
      create: ["Creating Git branch", "Создание ветки Git"],
      switch: ["Switching Git branch", "Переключение ветки Git"],
      detach: ["Checking out a Git revision", "Переход к ревизии Git"],
      publish: ["Publishing to GitHub", "Публикация в GitHub"],
      push: ["Pushing commits", "Отправка коммитов"],
    };
    const label = actions[action] ?? ["Git operation", "Операция Git"];
    notice(boardError(result.error), [language(...label), projectName()].filter(Boolean).join(" · "));
    return;
  }
  notice();
  return result.data;
}

function updateGitRevision(data) {
  const git = frame.board.gitInfo;
  const tracking = git?.branch === data.branch && git?.head === data.head ? git?.tracking : undefined;
  frame.board.gitInfo = { ...git, branch: data.branch, head: data.head, tracking };
  renderStatusBar(false);
}

function newGitBranch(snapshot, ref, project) {
  const editor = form("git-branch", language("Create new branch", "Создать новую ветку"), [
    { name: "name", label: language("Branch name", "Название ветки"), required: true },
  ], language("Create and switch", "Создать и переключиться"), async ({ name }) => {
    const data = await gitCommand("create", { head: snapshot.head, branch: snapshot.branch, ref, name }, project);
    if (!data || !editor.isConnected || frame.project !== project) return;
    updateGitRevision(data);
    sheet.close();
  });
  const source = ref ?? (snapshot.head ? snapshot.branch ?? "HEAD" : undefined);
  editor.prepend(element("p", source ? language("Create from: ", "Создать из: ") + source :
    language("Name for the first commit.", "Имя для первого коммита."), "muted"));
  editor.querySelector("input").focus();
}

function relativeCommitDate(value, now = Date.now()) {
  const seconds = (new Date(value).getTime() - now) / 1000;
  if (!Number.isFinite(seconds)) return "";
  if (Math.abs(seconds) < 60) return language("just now", "только что");
  const [unit, size] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]
    .find(([, size]) => Math.abs(seconds) >= size);
  return new Intl.RelativeTimeFormat(frame.russian ? "ru" : "en", { numeric: "auto", style: "short" })
    .format(Math.round(seconds / size), unit);
}

async function openGitBranches() {
  const menu = byId("git-branches");
  menu.setAttribute("aria-label", language("Branches and tags", "Ветки и теги"));
  const project = frame.project;
  const request = ++gitMenuRequest;
  menu.replaceChildren(element("p", language("Loading branches…", "Загрузка веток…"), "muted"));
  const data = await gitCommand("refs", undefined, project);
  if (!data || request !== gitMenuRequest || !menu.matches(":popover-open")) return;
  let mode = "switch";
  let busy = false;
  const search = element("input");
  search.type = "search";
  search.hidden = data.refs.length === 0;
  search.setAttribute("aria-label", language("Search branches and tags", "Поиск веток и тегов"));
  const action = (english, russian, symbol, click) => {
    const item = button("", click, "quiet git-menu-action");
    item.append(icon(symbol), element("span", language(english, russian)));
    return item;
  };
  const create = action("Create new branch…", "Создать новую ветку…", "plus", () => {
    if (!busy) newGitBranch(data, undefined, project);
  });
  const from = action("Create new branch from…", "Создать новую ветку из…", "plus", () => {
    mode = "create";
    draw();
    search.focus();
  });
  const detach = action("Checkout detached…", "Извлечь в отключённом режиме…", "git-branch", () => {
    mode = "detach";
    draw();
    search.focus();
  });
  const back = action("Back to branches", "Назад к веткам", "arrow-left", () => {
    mode = "switch";
    draw();
    search.focus();
  });
  const list = element("div", undefined, "git-ref-list");
  const choose = async ref => {
    if (busy) return;
    if (mode === "create") return newGitBranch(data, ref.ref, project);
    busy = true;
    for (const control of menu.querySelectorAll("button, input")) control.disabled = true;
    try {
      const next = await gitCommand(mode, { head: data.head, branch: data.branch, ref: ref.ref }, project);
      if (next && request === gitMenuRequest) {
        updateGitRevision(next);
        if (menu.matches(":popover-open")) menu.hidePopover();
      }
    } finally {
      busy = false;
      for (const control of menu.querySelectorAll("button, input")) control.disabled = false;
    }
  };
  function draw() {
    search.placeholder = mode === "create" ? language("Choose a starting branch or tag", "Выберите исходную ветку или тег")
      : mode === "detach" ? language("Choose a branch or tag for detached HEAD", "Выберите ветку или тег для detached HEAD")
      : language("Search branches and tags…", "Поиск веток и тегов…");
    create.hidden = mode !== "switch";
    from.hidden = detach.hidden = create.hidden || search.hidden;
    back.hidden = mode === "switch";
    const query = search.value.toLocaleLowerCase();
    const refs = data.refs.filter(ref => [ref.name, ref.sha, ref.author, ref.subject].some(value => value.toLocaleLowerCase().includes(query)));
    list.replaceChildren(...(refs.length ? refs.map(ref => {
      const entry = button("", () => choose(ref), "quiet git-ref");
      const current = !ref.tag && ref.name === data.branch;
      entry.setAttribute("aria-current", String(current));
      const heading = element("span", undefined, "git-ref-heading");
      const name = element("span", ref.name, "git-ref-name");
      const date = element("time", relativeCommitDate(ref.date), "git-ref-date");
      date.dateTime = ref.date;
      date.setAttribute("aria-label", new Date(ref.date).toLocaleString(frame.russian ? "ru" : undefined));
      heading.append(icon(ref.tag ? "git-tag" : "git-branch"), name);
      if (current) heading.append(icon("check"));
      heading.append(date);
      const detail = element("span", undefined, "git-ref-detail");
      detail.append(element("span", ref.author, "git-ref-author"), element("span", ref.sha.slice(0, 8), "git-ref-hash"),
        element("span", ref.subject, "git-ref-subject"));
      entry.append(heading, detail);
      return entry;
    }) : [element("p", search.hidden ? language("No branches or tags yet.", "Веток и тегов пока нет.") :
      language("No matching branches or tags.", "Подходящих веток и тегов нет."), "muted")]));
  }
  search.addEventListener("input", draw);
  menu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const controls = [...menu.querySelectorAll("input, button")].filter(item => !item.hidden && !item.disabled);
    const index = controls.indexOf(document.activeElement);
    event.preventDefault();
    controls.at((index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length)?.focus();
  }, { signal: gitMenuKeys.signal });
  menu.replaceChildren(search, create, from, detach, back, list);
  draw();
  (search.hidden ? create : search).focus();
}

let gitMenuKeys = new AbortController();
let publishingGit = false;
const gitPushes = new Map();

async function pushTrackedBranch() {
  const project = frame.project;
  const { branch, head, tracking } = frame.board?.gitInfo ?? {};
  if (!project || !branch || !head || !tracking || gitPushes.has(project)) return;
  gitPushes.set(project, branch);
  renderStatusBar(false);
  try {
    await gitCommand("push", { branch, head }, project);
  } finally {
    gitPushes.delete(project);
    if (frame.project === project) renderStatusBar(false);
  }
}

async function publishToGitHub() {
  if (publishingGit) return;
  const project = frame.project;
  const snapshot = await gitCommand("refs", undefined, project);
  if (!snapshot) return;
  const editor = form("git-publish", language("Publish to GitHub", "Опубликовать в GitHub"), [
    { name: "name", label: language("Repository name (or owner/name)", "Имя репозитория (или владелец/имя)"), required: true,
      value: project.split(/[\\/]/).at(-1).replace(/[^A-Za-z0-9_.-]/g, "-") },
    { name: "visibility", label: language("Visibility", "Доступ"), value: "private", options: [
      ["private", language("Private", "Приватный")], ["public", language("Public", "Публичный")],
    ] },
  ], language("Publish", "Опубликовать"), async ({ name, visibility }) => {
    publishingGit = true;
    byId("status-publish").disabled = true;
    const status = editor.querySelector("p");
    status.textContent = language("Publishing…", "Публикация…");
    try {
      const result = await gitCommand("publish", { head: snapshot.head, branch: snapshot.branch, name, visibility }, project);
      if (!result || !editor.isConnected || frame.project !== project) return;
      sheet.close();
      notice(language("Published to GitHub: ", "Опубликовано в GitHub: ") + result.remote);
    } finally {
      publishingGit = false;
      byId("status-publish").disabled = false;
      if (editor.isConnected) status.textContent = language("Publish branch: ", "Опубликовать ветку: ") + (snapshot.branch ?? "HEAD");
    }
  });
  editor.prepend(element("p", language("Publish branch: ", "Опубликовать ветку: ") + (snapshot.branch ?? "HEAD"), "muted"));
  editor.querySelector("input").focus();
}

let reviewNotifications = [];
let reviewNotificationKey = "";
let reviewNotificationRequest = 0;

function renderReviewNotifications(results = [], message = "") {
  const menu = byId("notifications");
  const statuses = new Map(results.map(entry => [entry.id, entry]));
  const labels = {
    clean: ["No Git conflicts", "Без конфликтов Git"],
    conflict: ["Git conflict", "Конфликт Git"],
    integrated: ["Already integrated in Git", "Уже в целевой ветке"],
    noChanges: ["Submitted without Git changes", "Сдано без изменений в Git"],
    pending: ["Git operation pending", "Ожидает завершения операции Git"],
    stale: ["Submission changed", "Сдача устарела"],
    unchecked: ["Git compatibility unchecked", "Совместимость Git не проверена"],
  };
  const rows = reviewNotifications.map(task => {
    const result = statuses.get(task.id);
    const status = result?.revision === task.revision ? result.status : undefined;
    const running = frame.runningTasks?.includes(task.id);
    return { ...task, status, running,
      rank: !running && ["clean", "noChanges"].includes(status) ? 0 : ["conflict", "stale", "pending"].includes(status) ? 2 : 1 };
  }).sort((a, b) => a.rank - b.rank || (a.at ?? "").localeCompare(b.at ?? ""));
  const focusedTask = menu.contains(document.activeElement) ? document.activeElement.dataset.reviewTask : undefined;
  const items = rows.map(task => {
    const open = button("", () => {
      menu.hidePopover();
      return showTask(task.id);
    }, "quiet notification-entry");
    open.dataset.reviewTask = task.id;
    const details = [task.status && Object.hasOwn(labels, task.status) && language(...labels[task.status]),
      task.reviewApproved && language("Approved by reviewer", "Согласовано ревьюером"),
      task.running && language("Executor still running", "Исполнитель ещё работает"), task.at && relativeCommitDate(task.at)];
    const detail = element("span", details.filter(Boolean).join(" · "));
    if (task.at) detail.title = shortDate(task.at);
    open.append(element("strong", task.id + " · " + task.title), detail);
    return open;
  });
  if (message || !items.length) {
    const status = element("p", message || language("No tasks in review.", "Нет задач на проверке."), "muted");
    status.setAttribute("role", "status");
    items.unshift(status);
  }
  menu.replaceChildren(...items);
  if (focusedTask) items.find(item => item.dataset.reviewTask === focusedTask)?.focus({ preventScroll: true });
}

async function refreshReviewNotifications() {
  const request = ++reviewNotificationRequest;
  if (!reviewNotifications.length) return renderReviewNotifications();
  renderReviewNotifications([], language("Checking Git compatibility…", "Проверяю совместимость с Git…"));
  const result = await api.command("review-queue").catch(error => ({ ok: false, error }));
  if (request !== reviewNotificationRequest || !byId("notifications").matches(":popover-open")) return;
  if (result.ok) renderReviewNotifications(result.data);
  else renderReviewNotifications([], boardError(result.error));
}

function renderActiveAgents() {
  const indicator = byId("status-agents");
  indicator.hidden = !frame.board;
  if (indicator.hidden) return;
  const reviewers = Object.values(frame.reviewingTasks ?? {}).filter(role => role === "reviewer").length;
  const managers = Number(Boolean(frame.managerRun)) + Number(Boolean(frame.managerWork));
  const count = (frame.runningTasks?.length ?? 0) + reviewers + managers;
  indicator.querySelector("span").textContent = count;
  indicator.title = language("Active agents", "Активные агенты") + " · " + count;
  indicator.setAttribute("aria-label", indicator.title);
}

function renderStatusBar(projectChanged) {
  renderActiveAgents();
  const { branch, head, user, tracking } = frame.board?.gitInfo ?? {};
  const revision = head ? branch ?? head.slice(0, 8) : branch && language("Before the first commit", "До первого коммита");
  for (const [id, value, label] of [
    ["status-branch", revision, head && branch ? language("Git branch", "Ветка Git") : "Git"],
    ["status-user", user, language("Git user", "Пользователь Git")],
  ]) {
    const item = byId(id);
    item.hidden = !value;
    item.title = value ? label + " · " + value : "";
    item.querySelector("span").textContent = value ?? "";
  }
  const status = byId("status-tracking");
  status.hidden = !branch || !head || !tracking;
  const pushingBranch = gitPushes.get(frame.project);
  status.disabled = pushingBranch !== undefined;
  const pushing = !status.hidden && pushingBranch === branch;
  status.setAttribute("aria-busy", String(pushing));
  if (!status.hidden) {
    const { behind, ahead } = tracking;
    status.querySelector("span").textContent = behind + "↓ " + ahead + "↑";
    status.title = (pushing ? language("Pushing commits…", "Отправка коммитов…") :
      status.disabled ? language("Another branch is being pushed", "Отправляется другая ветка") :
        language("Push to the upstream branch", "Отправить коммиты в отслеживаемую ветку")) + " · " +
      language("Behind ", "Отставание ") + behind + " · " + language("Ahead ", "Опережение ") + ahead;
    status.setAttribute("aria-label", status.title);
  }
  const publish = byId("status-publish");
  publish.hidden = !branch || !head || Boolean(tracking);
  publish.title = language("Publish to GitHub", "Опубликовать в GitHub");
  publish.setAttribute("aria-label", publish.title);
  if (projectChanged) {
    gitMenuRequest++;
    const branches = byId("git-branches");
    if (branches.matches(":popover-open")) branches.hidePopover();
  }
  const menu = byId("notifications");
  if (projectChanged && menu.matches(":popover-open")) menu.hidePopover();
  const bell = byId("status-notifications");
  const label = language("Review queue", "Очередь приёмки");
  const submitted = (frame.board?.tasks ?? []).filter(task => task.status === "review").map(task => {
    const at = task.submittedAt ?? task.history?.findLast(entry => entry.action === "submit" && entry.actor === "agent" && entry.to === "review")?.at;
    return { id: task.id, title: task.title, revision: task.revision, reviewApproved: task.reviewApproved, at };
  });
  bell.title = label;
  bell.setAttribute("aria-label", submitted.length ? label + " · " + submitted.length : label);
  const count = bell.querySelector(".count");
  count.textContent = submitted.length;
  count.hidden = !submitted.length;
  menu.setAttribute("aria-label", label);
  const key = JSON.stringify([frame.project, frame.russian, head, submitted, submitted.map(task => frame.runningTasks?.includes(task.id))]);
  if (reviewNotificationKey === key) return;
  reviewNotificationKey = key;
  reviewNotifications = submitted;
  if (menu.matches(":popover-open")) void refreshReviewNotifications();
}

let tabsSignature = "";
let draggedProject;

function clearTabDrop() {
  byId("project-tabs").querySelectorAll(".drop-before, .drop-after").forEach(tab => {
    tab.classList.remove("drop-before", "drop-after");
  });
}

function renderProjectTabs() {
  const bar = byId("project-tabs");
  const tabs = frame.tabs ?? [];
  const signature = JSON.stringify([tabs, frame.project, frame.russian]);
  if (signature === tabsSignature) return;
  tabsSignature = signature;
  const focused = bar.contains(document.activeElement) ? document.activeElement : undefined;
  const focusedPath = focused?.closest(".project-tab")?.dataset.project;
  const closeFocused = focused?.classList.contains("project-tab-close");
  bar.setAttribute("aria-label", language("Projects", "Проекты"));
  bar.hidden = !tabs.length;
  bar.replaceChildren(...tabs.map(tab => {
    const container = element("div", undefined, "project-tab");
    container.dataset.project = tab.path;
    container.setAttribute("role", "presentation");
    const select = button("", () => api.selectTab(tab.path), "project-tab-button");
    select.className = "project-tab-button";
    select.draggable = true;
    select.addEventListener("dragstart", event => {
      draggedProject = tab.path;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-taskboard-tab", tab.path);
    });
    select.addEventListener("dragend", () => {
      draggedProject = undefined;
      clearTabDrop();
    });
    container.addEventListener("dragover", event => {
      if (!draggedProject || draggedProject === tab.path) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearTabDrop();
      const rect = container.getBoundingClientRect();
      container.classList.add(event.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
      const bounds = bar.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) bar.scrollBy(0, -20);
      else if (event.clientY > bounds.bottom - 28) bar.scrollBy(0, 20);
    });
    container.addEventListener("dragleave", event => {
      if (!container.contains(event.relatedTarget)) container.classList.remove("drop-before", "drop-after");
    });
    container.addEventListener("drop", event => {
      if (!draggedProject) return;
      event.preventDefault();
      const project = draggedProject;
      const rect = container.getBoundingClientRect();
      draggedProject = undefined;
      clearTabDrop();
      const after = event.clientY >= rect.top + rect.height / 2;
      protect(() => api.reorderTab(project, tab.path, after))();
    });
    select.title = tab.path;
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(tab.path === frame.project));
    select.setAttribute("aria-controls", "workspace");
    select.setAttribute("aria-haspopup", "true");
    select.tabIndex = tab.path === frame.project ? 0 : -1;
    select.append(element("span", tab.name, "project-tab-name"));
    if (tab.unread) {
      select.setAttribute("aria-description", language("New manager messages", "Новые сообщения менеджера"));
      const dot = element("i", undefined, "icon codicon codicon-circle-filled project-tab-unread");
      dot.setAttribute("aria-hidden", "true");
      select.append(dot);
    }
    if (tab.detail) select.append(element("span", tab.detail, "project-tab-detail"));
    container.addEventListener("contextmenu", event => {
      event.preventDefault();
      const menu = byId("board-tab-menu");
      if (menu.matches(":popover-open")) menu.hidePopover();
      const open = button(language("Board settings…", "Настройки доски…"), protect(async () => {
        menu.hidePopover();
        if (frame.project !== tab.path) await api.selectTab(tab.path);
        if (frame.project === tab.path) boardSettings();
      }), "app-menu-item");
      menu.setAttribute("aria-label", language("Board menu", "Меню доски"));
      open.setAttribute("role", "menuitem");
      open.setAttribute("autofocus", "");
      menu.replaceChildren(open);
      menu.showPopover({ source: select });
      const anchor = select.getBoundingClientRect();
      menu.style.left = Math.max(0, Math.min(event.clientX || anchor.right, innerWidth - menu.offsetWidth)) + "px";
      menu.style.top = Math.max(0, Math.min(event.clientY || anchor.top, innerHeight - menu.offsetHeight)) + "px";
    });
    select.addEventListener("keydown", protect(async event => {
      const index = tabs.findIndex(entry => entry.path === tab.path);
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const after = event.key === "ArrowDown";
        const target = tabs[index + (after ? 1 : -1)];
        if (target) await api.reorderTab(tab.path, target.path, after);
        return;
      }
      let next;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else if (event.key === "Delete") {
        event.preventDefault();
        await api.closeTab(tab.path);
        bar.querySelector('[aria-selected="true"]')?.focus();
        return;
      } else return;
      event.preventDefault();
      await api.selectTab(tabs[next].path);
      bar.querySelector('[aria-selected="true"]')?.focus();
    }));
    const close = button("", () => api.closeTab(tab.path), "project-tab-close");
    close.className = "project-tab-close";
    close.append(icon("close"));
    close.setAttribute("aria-label", language("Close project ", "Закрыть проект ") + tab.name);
    close.title = close.getAttribute("aria-label");
    container.append(select, close);
    return container;
  }));
  if (focused) {
    const container = [...bar.children].find(item => item.dataset.project === focusedPath);
    const target = container?.querySelector(closeFocused ? ".project-tab-close" : ".project-tab-button")
      ?? bar.querySelector('[aria-selected="true"]');
    target?.focus();
  }
  bar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function update(next) {
  const previousProject = frame.project;
  const projectChanged = frame.project !== next.project;
  const previousBoard = projectChanged ? undefined : frame.board;
  const tagsChanged = JSON.stringify(frame.board?.tags) !== JSON.stringify(next.board?.tags);
  if ((projectChanged || frame.russian !== next.russian || Boolean(frame.board) !== Boolean(next.board)) &&
      byId("settings-menu").matches(":popover-open")) byId("settings-menu").hidePopover();
  frame = next;
  if (byId("app-header").hidden) {
    byId("app-header").classList.toggle("titlebar", api.customTitleBar);
    mountAppMenu();
    byId("app-header").hidden = false;
  }
  if (tagsChanged) boardTags = new Map((next.board?.tags ?? []).map(tag => [tagKey(tag.name), tag]));
  applyTheme(next.theme);
  renderStatusBar(projectChanged);
  renderProjectTabs();
  if (projectChanged) {
    projectGeneration++;
    taskSheetRequest++;
    lanePreferences = switchBoardRendering(previousProject, next.project) ?? loadLanePreferences();
    archiveView = false;
    if (sheet.open) sheet.close();
  }
  if (Array.isArray(next.tabs)) {
    const openProjects = new Set(next.tabs.map(tab => tab.path));
    for (const [project, view] of boardViews) {
      if (openProjects.has(project)) continue;
      view.composer[0]?.dispose?.();
      boardViews.delete(project);
    }
  }
  render(previousBoard);
  syncBoardNotice(projectChanged);
  const tagSettings = byId("tag-settings");
  if (tagsChanged && sheet.open && tagSettings) renderTagSettings(tagSettings);
  if (sheetKind === "task" && sheet.open && taskInSheet) {
    body.querySelector(".task-chat")?.syncAgentState?.();
    const runStatus = byId("task-agent-run");
    if (runStatus) renderAgentRunStatus(runStatus, taskInSheet);
    const launch = byId("task-launch");
    if (launch) launch.hidden = frame.runningTasks?.includes(taskInSheet.id) ?? false;
    if (tagsChanged) byId("task-sheet-tags")?.replaceChildren(...tagBadges(taskInSheet.tags));
    const task = frame.board?.tasks.find(entry => entry.id === taskInSheet.id);
    const archived = frame.board?.archived.find(entry => entry.id === taskInSheet.id);
    const cleaned = taskInSheet.cleanupAvailable && frame.board?.cleanedTasks?.includes(taskInSheet.id);
    if (cleaned || (task && (task.revision !== taskInSheet.revision ||
        (task.historyLength ?? task.history?.length) !== taskInSheet.history.length ||
        String(task.unfinishedDependencies) !== String(taskInSheet.unfinishedDependencies))) ||
        (archived && !task && (archived.status !== taskInSheet.status ||
          (archived.tags && JSON.stringify(archived.tags) !== JSON.stringify(taskInSheet.tags))))) {
      void protect(() => showTask(taskInSheet.id))();
    }
  }
}

byId("welcome-create").addEventListener("click", protect(() => api.createBoard()));
byId("git-branches").addEventListener("toggle", protect(event => {
  gitMenuKeys.abort();
  gitMenuKeys = new AbortController();
  if (event.newState === "open") return openGitBranches();
  gitMenuRequest++;
}));
byId("status-publish").addEventListener("click", protect(publishToGitHub));
byId("status-tracking").addEventListener("click", protect(pushTrackedBranch));
byId("app-settings").setAttribute("aria-haspopup", "menu");
byId("app-settings").setAttribute("aria-controls", "settings-menu");
byId("app-settings").setAttribute("aria-expanded", "false");
byId("app-settings").addEventListener("click", () => openSettingsMenu());
byId("app-settings").addEventListener("keydown", event => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  openSettingsMenu(event.key === "ArrowUp");
});
byId("settings-menu").addEventListener("beforetoggle", event => {
  byId("app-settings").setAttribute("aria-expanded", String(event.newState === "open"));
});
byId("settings-menu").addEventListener("toggle", event => {
  if (event.newState === "closed" && (document.activeElement === document.body ||
      event.currentTarget.contains(document.activeElement))) byId("app-settings").focus();
});
byId("settings-menu").addEventListener("keydown", event => {
  const menu = event.currentTarget;
  if (event.key === "Escape" || event.key === "Tab") {
    menu.hidePopover();
    byId("app-settings").focus();
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...menu.querySelectorAll("button:not(:disabled)")];
  const index = items.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus();
});
window.addEventListener("resize", () => {
  const menu = byId("settings-menu");
  if (menu.matches(":popover-open")) menu.hidePopover();
});
byId("notifications").addEventListener("toggle", event => {
  if (event.newState === "open") void refreshReviewNotifications();
  else reviewNotificationRequest++;
});
byId("welcome-open").addEventListener("click", protect(() => api.open()));
byId("notice-close").addEventListener("click", () => {
  if (displayedBoardError) dismissedBoardErrors.set(frame.project, displayedBoardError);
  windowNotice();
});
byId("close-sheet").addEventListener("click", () => sheet.close());
byId("lanes").addEventListener("click", () => byId("board-composer").firstChild?.closeChat(), { capture: true });
document.addEventListener("pointerdown", event => {
  for (const menu of document.querySelectorAll(".lane-filter[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    const menu = document.querySelector(".lane-filter[open]");
    if (menu) { menu.open = false; menu.querySelector("summary").focus(); }
  }
});
sheet.addEventListener("close", () => {
  if (sheet.open) return;
  chatPreviews.disconnect();
  taskSheetRequest++;
  sheetKind = "";
  taskInSheet = undefined;
  byId("app-content").inert = false;
  document.querySelector(".status-bar").inert = false;
  if (document.activeElement === document.body || sheet.contains(document.activeElement)) focusBeforeSheet?.focus();
  focusBeforeSheet = undefined;
});
api.subscribe(update);
api.onChatUpdate(updateChat);
window.addEventListener("focus", () => {
  const composer = byId("board-composer").firstChild;
  composer?.invalidateHistory?.();
  composer?.syncManagerUnread?.(frame.managerUnread);
});
const syncBoardPrompt = () => byId("board-composer").firstChild?.syncPrompt?.();
const syncManagerRead = () => byId("board-composer").firstChild?.syncManagerUnread?.(frame.managerUnread);
document.addEventListener("visibilitychange", () => {
  syncBoardPrompt();
  syncManagerRead();
});
document.addEventListener("close", syncManagerRead, true);
reducedMotion.addEventListener("change", syncBoardPrompt);
reducedMotion.addEventListener("change", () => {
  if (!reducedMotion.matches) return;
  for (const animation of byId("lanes").getAnimations({ subtree: true })) {
    if (animation.id === "task-card-move" || animation.id === "task-card-enter") animation.cancel();
  }
});
api.onTheme(theme => {
  frame.theme = theme;
  applyTheme(theme);
});
api.bootstrap().then(update).catch(error => notice(error.message, language("Application startup", "Запуск приложения")));
