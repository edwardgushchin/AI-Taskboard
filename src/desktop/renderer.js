const api = window.taskboard;
const byId = id => document.getElementById(id);
let frame = {};
let archiveView = false;
let sheetKind = "";
let taskInSheet;
let taskSheetRequest = 0;
let focusBeforeSheet;
let boardTags = new Map();
let lanePreferences = {};
const cardCoverCache = new Map();
const sheet = byId("sheet");
const body = byId("sheet-body");

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
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const use = document.createElementNS(namespace, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "#icon-" + name);
  svg.append(use);
  return svg;
}

function notice(message) {
  const target = sheet.open ? byId("sheet-notice") : byId("notice");
  target.textContent = message || "";
  target.hidden = !message;
}

function boardError(error) {
  const gitMessages = {
    STALE_REPOSITORY: language("The current branch changed. Reopen the Git menu and retry.", "Текущая ветка изменилась. Откройте меню Git заново и повторите действие."),
    GIT_WORKTREE_REQUIRED: language("Open a repository with a main worktree.", "Откройте репозиторий с основной рабочей копией."),
    GIT_COMMIT_REQUIRED: language("Select a branch with a commit first.", "Сначала выберите ветку хотя бы с одним коммитом."),
    REMOTE_EXISTS: language("The origin remote already exists. Manage it with your Git tools.", "Удалённый репозиторий origin уже настроен. Используйте свои инструменты Git для работы с ним."),
    GITHUB_UNAVAILABLE: language("Install GitHub CLI (gh) and sign in with gh auth login.", "Установите GitHub CLI (gh) и войдите в аккаунт командой gh auth login."),
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

function mountAppMenu() {
  const bar = byId("app-menu");
  bar.setAttribute("aria-label", language("Application menu", "Меню приложения"));
  const groups = [
    ["File", "Файл", [
      ["new-window", "New window", "Новое окно", "N"],
      ["open-project", "Open project folder…", "Открыть папку проекта…", "O"],
      ["close-window", "Close window", "Закрыть окно", "W"],
      ["settings", "Settings…", "Настройки…", ","],
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

  function close() {
    if (!active) return;
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
    return action === "settings" ? settings() : api.menuAction(action);
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
      item.append(element("span", language(en, ru)));
      if (shortcut) {
        shortcuts.set(shortcut, action);
        const prefix = shortcut === "F11" ? "" : api.isMac ? "⌘" : "Ctrl+";
        item.append(element("kbd", prefix + shortcut));
      }
      popup.append(item);
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
    if (event.shiftKey && key !== "Z" && key !== "+") return;
    const shortcut = key === "=" ? "+" : event.shiftKey && key === "Z" ? "Shift+Z" : key;
    const action = !api.isMac && shortcut === "Shift+Z" ? "redo" : shortcuts.get(shortcut);
    if (!action) return;
    event.preventDefault();
    if (!event.repeat) run(action);
  });
  bar.hidden = false;
}

async function command(action, id, input) {
  const result = await api.command(action, id, input);
  if (!result.ok) {
    notice(boardError(result.error));
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
    byId("board-actions").inert = true;
    document.querySelector(".status-bar").inert = true;
  }
}

function section(title, content) {
  if (content === undefined || content === "" || (Array.isArray(content) && !content.length)) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", title));
  if (Array.isArray(content)) {
    const list = element("ul");
    for (const value of content) list.append(element("li", value));
    area.append(list);
  } else area.append(element("p", content));
  body.append(area);
}

const cardCovers = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    cardCovers.unobserve(target);
    if (!target.isConnected) continue;
    const image = target.querySelector(".task-card-cover");
    const { task, file } = image.dataset;
    const key = task + "\0" + file;
    const request = cardCoverCache.get(key) ?? api.attachmentPreview(task, file);
    cardCoverCache.set(key, request);
    if (cardCoverCache.size > 32) cardCoverCache.delete(cardCoverCache.keys().next().value);
    const discard = () => {
      if (cardCoverCache.get(key) === request) cardCoverCache.delete(key);
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
  const initial = attachments.slice(0, Math.max(0, attachments.length - later));
  return initial.find(isImageAttachment);
}

const tagKey = name => name.trim().normalize().toLowerCase();

function tagBadge(name, color, customColor) {
  const badge = element("span", name, "tag");
  if (color) badge.dataset.color = color;
  if (customColor) badge.style.setProperty("--tag-color", customColor);
  return badge;
}

function tagBadges(names) {
  const tags = new Map();
  for (const name of names) {
    const key = tagKey(name);
    if (!tags.has(key)) tags.set(key, boardTags.get(key) ?? { name });
  }
  return Array.from(tags.values(), tag => tagBadge(tag.name, tag.color, tag.customColor));
}

function renderAgentRunStatus(target, task) {
  target.replaceChildren();
  if (frame.runningTasks?.includes(task.id)) {
    const spinner = element("span", undefined, "agent-spinner");
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", language("Agent is working", "Агент работает"));
    target.append(spinner);
  } else if (task.status === "in_progress" && task.codexThreadId) {
    target.textContent = language("Board run inactive", "Запуск с доски не активен");
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

function card(task) {
  const card = element("article", undefined, "task-card");
  const item = button("", () => showTask(task.id), "");
  item.className = "task-card-details";
  if (task.tags?.length) {
    const tags = element("span", undefined, "task-tags");
    tags.append(...tagBadges(task.tags));
    item.append(tags);
  }
  item.append(element("strong", task.title));
  const cover = selectedCover(task, (task.attachments ?? []).filter(isImageAttachment));
  if (cover) {
    const image = element("img", undefined, "task-card-cover");
    image.alt = "";
    image.hidden = true;
    image.dataset.task = task.id;
    image.dataset.file = cover.file;
    image.onload = () => { image.hidden = false; };
    item.prepend(image);
    cardCovers.observe(item);
  }
  const meta = element("span", undefined, "task-meta");
  meta.append(element("span", task.id, "task-id"));
  const runStatus = element("span");
  renderAgentRunStatus(runStatus, task);
  if (!runStatus.hidden) meta.append(runStatus);
  if (task.unfinishedDependencies?.length && ["draft", "blocked"].includes(task.status)) {
    meta.append(taskIndicator("dependency", task.unfinishedDependencies.length,
      language("Unfinished dependencies", "Незавершённые зависимости"), "dependency-warning"));
  }
  if (task.status === "blocked" && task.blocked) {
    meta.append(taskIndicator("error", 1, language("Execution error", "Ошибка выполнения"), "task-error"));
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
    attachments.append(icon("attachment"), String(task.attachments.length));
    meta.append(attachments);
  }
  if (task.priority) {
    const priority = element("span", priorityName(task.priority), "task-priority");
    priority.dataset.priority = task.priority;
    meta.append(priority);
  }
  item.append(meta);
  card.append(item);
  if (task.status === "ready" && task.codexThreadId) card.append(openCodexTaskAction(task));
  return card;
}

function openCodexTaskAction(task) {
  return button(language("Open Codex chat", "Открыть чат Codex"), async () => {
    const result = await api.openCodexThread(task.id);
    if (!result.ok) notice(boardError(result.error));
  });
}

function codexTaskAction(task) {
  if (task.status !== "ready" && (task.status !== "in_progress" || task.codexThreadId)) return null;
  const launch = button(language("Send to work", "Передать в работу"), async () => {
    launch.disabled = true;
    try {
      const result = await api.launchTask(task.id);
      if (!result.ok) notice(boardError(result.error));
      else if (sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
    } finally {
      launch.disabled = Boolean(task.unfinishedDependencies?.length);
    }
  });
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

function filterOptions(id, options, label) {
  const select = byId(id);
  const previous = select.value;
  select.replaceChildren(...[["", label], ...options].map(([value, name]) => new Option(name, value)));
  if (options.some(([value]) => value === previous)) select.value = previous;
  return select.value;
}

function tagFilters() {
  const list = byId("tag-filter");
  const selected = new Set(Array.from(list.querySelectorAll(":checked"), input => input.value));
  const focused = list.contains(document.activeElement) ? document.activeElement.value : undefined;
  const scroll = list.scrollTop;
  const tags = [...boardTags].sort(([, a], [, b]) => a.name.localeCompare(b.name));
  list.replaceChildren(...tagChoices(tags, selected));
  [...list.querySelectorAll("input")].find(input => input.value === focused)?.focus({ preventScroll: true });
  list.scrollTop = scroll;
  list.parentElement.hidden = tags.length === 0;
  return [...selected].filter(key => boardTags.has(key));
}

function tagChoices(tags, selected) {
  return tags.map(([key, tag]) => {
    const row = element("label");
    const input = element("input");
    input.type = "checkbox";
    input.value = key;
    input.checked = selected.has(key);
    row.append(input, tagBadge(tag.name, tag.color, tag.customColor));
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
  const summary = element("summary", undefined, "button quiet icon-button");
  const filterLabel = language("Filter ", "Фильтр колонки ") + title;
  const filterCount = element("span", undefined, "count");
  summary.append(icon("filter"), filterCount);
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
  }, "quiet lane-collapse");
  toggle.setAttribute("aria-controls", content.id);
  function updateCollapse() {
    content.hidden = collapsed;
    toggle.textContent = collapsed ? "+" : "−";
    const label = (collapsed ? language("Expand ", "Развернуть колонку ") : language("Collapse ", "Свернуть колонку ")) + title;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }
  function updateCards() {
    const matching = tasks.filter(task => (!priority.value || task.priority === priority.value) &&
      (!selected.size || task.tags.some(name => selected.has(tagKey(name)))));
    const active = selected.size + Number(Boolean(priority.value));
    for (const old of content.querySelectorAll(".task-card-details")) cardCovers.unobserve(old);
    content.replaceChildren(...matching.map(card));
    if (!matching.length && (total || active)) {
      const empty = element("div", undefined, "lane-filter-empty");
      empty.append(element("p", language("No matching tasks", "Нет подходящих карточек"), "muted"));
      if (active) empty.append(button(resetLabel, clearFilters, "quiet"));
      content.append(empty);
    }
    count.textContent = matching.length === total ? String(total) : matching.length + language(" of ", " из ") + total;
    filterCount.textContent = active;
    filterCount.hidden = active === 0;
    reset.hidden = active === 0;
    summary.title = filterLabel;
    summary.setAttribute("aria-label", active ? filterLabel + " (" + active + ")" : filterLabel);
  }
  updateCards();
  updateCollapse();
  toolbar.append(filter, toggle);
  return toolbar;
}

function render() {
  cardCovers.disconnect();
  document.documentElement.lang = frame.russian ? "ru" : "en";
  const currentBoard = frame.board;
  // Project waiting tasks into the blocked lane while keeping their workflow status in the board data.
  const board = currentBoard && { ...currentBoard, tasks: currentBoard.tasks.map(task => {
    const status = shownStatus(task);
    return status === task.status ? task : { ...task, status };
  }) };
  const noBoard = !board;
  byId("welcome").hidden = !noBoard;
  byId("workspace").hidden = noBoard;
  byId("board-actions").hidden = noBoard;
  byId("archive-menu-item").setAttribute("aria-disabled", String(noBoard));
  byId("archive-menu-item").setAttribute("aria-checked", String(archiveView));
  if (frame.error) notice(boardError(frame.error));
  else if (!sheet.open) notice();
  if (!board) {
    renderWelcome();
    return;
  }

  byId("workspace").setAttribute("aria-label", archiveView ? language("Archive", "Архив") : language("Task board", "Доска задач"));
  controlLabel("create", language("Create task", "Создать задачу"));
  byId("search-hint").textContent = language("Search tasks…", "Поиск задач…");
  byId("search").setAttribute("aria-label", language("Search tasks", "Поиск задач"));
  byId("lanes").hidden = archiveView;
  byId("archive-list").hidden = !archiveView;
  byId("priority-filter-label").textContent = language("Priority", "Приоритет");
  byId("priority-filter-label").parentElement.hidden = archiveView;
  byId("tag-filter-label").textContent = language("Tags", "Теги");
  const priorities = ["low", "normal", "high", "urgent"].map(value => [value, priorityName(value)]);
  const priority = archiveView ? "" : filterOptions("priority-filter", priorities, language("Any priority", "Любой приоритет"));
  const tags = tagFilters();
  const filterCount = Number(Boolean(priority)) + tags.length;
  const filterToggle = byId("filter-toggle");
  filterToggle.title = language("Filters", "Фильтры");
  filterToggle.setAttribute("aria-label", filterCount ? filterToggle.title + " (" + filterCount + ")" : filterToggle.title);
  byId("filter-count").hidden = filterCount === 0;
  byId("filter-count").textContent = filterCount;
  const query = tagKey(byId("search").value);
  const matches = task => (!priority || task.priority === priority) &&
    tags.every(key => task.tags?.some(name => tagKey(name) === key)) &&
    [task.id, task.title, ...(task.tags ?? [])].some(value => tagKey(value).includes(query));
  if (archiveView) {
    const tasks = board.archived.filter(matches);
    byId("archive-list").replaceChildren(...(tasks.length ? tasks.map(card) :
      [element("p", language("No archived tasks found.", "Архивных задач не найдено."), "muted")]));
    return;
  }
  const visible = board.tasks.filter(matches);
  const columns = lanes.map(([state, english, russian]) => {
    const tasks = visible.filter(task => task.status === state);
    const column = element("section", undefined, "lane");
    column.dataset.state = state;
    const title = language(english, russian);
    const heading = element("h2", title, "lane-title");
    const count = element("span", undefined, "count");
    heading.append(count);
    const content = element("div", undefined, "lane-cards");
    content.id = "lane-cards-" + state;
    const header = element("div", undefined, "lane-header");
    const total = board.tasks.filter(task => task.status === state).length;
    header.append(heading, laneTools(state, title, tasks, total, count, content));
    column.append(header, content);
    return column;
  });
  byId("lanes").replaceChildren(...columns);
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
    if (field.type === "number") input.min = "0";
    input.required = Boolean(field.required);
    input.value = field.value ?? "";
    inputs[field.name] = input;
    row.append(input);
    form.append(row);
  }
  const save = element("button", label, "button primary");
  save.type = "submit";
  form.append(save);
  form.addEventListener("submit", protect(async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      await submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    } finally { save.disabled = false; }
  }));
  body.append(form);
  return form;
}

function newTaskDraft() {
  const project = frame.project;
  const files = [];
  const hint = element("p", api.isMac
    ? language("Paste files or screenshots with ⌘V.", "Вставьте файлы или скриншоты через ⌘V.")
    : language("Paste files or screenshots with Ctrl+V.", "Вставьте файлы или скриншоты через Ctrl+V."), "muted");
  hint.id = "draft-paste-hint";
  const attachments = element("ul", undefined, "draft-attachments");
  attachments.hidden = true;
  attachments.setAttribute("aria-label", language("Attachments", "Вложения"));
  const progress = element("p", language("The agent is preparing a draft…", "Агент готовит черновик…"), "muted");
  progress.hidden = true;
  progress.setAttribute("role", "status");
  const editor = form("new-task", language("New task", "Новая задача"), [
    { name: "request", label: language("What needs to be done?", "Что нужно сделать?"), type: "area", required: true },
  ], language("Create draft", "Создать черновик"), async ({ request }) => {
    notice();
    progress.hidden = false;
    input.readOnly = true;
    for (const button of attachments.querySelectorAll("button")) button.disabled = true;
    try {
      const pasted = await Promise.all(files.map(async file => ({
        name: file.name, type: file.type, bytes: await file.arrayBuffer(),
      })));
      const result = await api.draft(request, pasted);
      if (!editor.isConnected || !sheet.open || frame.project !== project) return;
      if (!result.ok) {
        notice(boardError(result.error));
        return;
      }
      archiveView = false;
      render();
      await showTask(result.data.id);
    } finally {
      progress.hidden = true;
      input.readOnly = false;
      for (const button of attachments.querySelectorAll("button")) button.disabled = false;
    }
  });
  editor.append(progress);
  const input = editor.querySelector("textarea");
  input.setAttribute("aria-describedby", hint.id);
  editor.querySelector("[type=submit]").before(hint, attachments);
  input.addEventListener("paste", event => {
    if (input.readOnly) return;
    const pasted = Array.from(event.clipboardData?.files ?? []);
    if (!pasted.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    if ([...files, ...pasted].reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) {
      notice(language("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ."));
      return;
    }
    notice();
    for (const file of pasted) {
      files.push(file);
      const row = element("li");
      const remove = button("×", () => {
        if (input.readOnly) return;
        files.splice(files.indexOf(file), 1);
        row.remove();
        attachments.hidden = input.required = !files.length;
        notice();
        input.focus();
      }, "quiet");
      remove.setAttribute("aria-label", language("Remove ", "Удалить ") + file.name);
      row.append(icon("attachment"), element("span", file.name), remove);
      attachments.append(row);
    }
    input.required = attachments.hidden = false;
  });
  input.focus();
}

function taskEditor(task) {
  form("editor", language("Edit task", "Редактировать задачу"), [
    { name: "title", label: language("Title", "Название"), required: true, value: task.title },
    { name: "description", label: language("Description", "Описание"), type: "area", value: task.description },
    { name: "criteria", label: language("Acceptance criteria, one per line", "Критерии приёмки, по одному на строку"), type: "area",
      value: task.criteria.join("\n") },
    { name: "tags", label: language("Tags, comma separated", "Теги через запятую"), value: task.tags.join(", ") },
    { name: "priority", label: language("Priority", "Приоритет"), value: task.priority,
      options: ["low", "normal", "high", "urgent"].map(value => [value, priorityName(value)]) },
    { name: "note", label: language("Reason for change", "Причина изменения") },
  ], language("Save", "Сохранить"), async values => {
    const data = {
      title: values.title, description: values.description, criteria: lineList(values.criteria),
      tags: values.tags.split(",").map(tag => tag.trim()).filter(Boolean), priority: values.priority,
      actor: "user", revision: task.revision, ...(values.note ? { note: values.note } : {}),
    };
    const saved = await command("update", task.id, data);
    if (saved) await showTask(saved.id);
  });
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
  const defaultLabel = language("Provider default", "По умолчанию у провайдера");
  const modelOptions = [["", defaultLabel], ...models.map(model => [model.id, model.name])];
  if (selected && !models.some(model => model.id === selected)) {
    modelOptions.push([selected, selected + " · " + language("unavailable", "недоступна")]);
  }
  const editor = form("execution", title, [
    { name: "model", label: language("Model", "Модель"), value: selected, options: modelOptions },
    { name: "effort", label: language("Reasoning effort", "Уровень размышлений"), options: [] },
  ], language("Save", "Сохранить"), async ({ model, effort }) => {
    if (model && !models.some(entry => entry.id === model)) {
      notice(language("Choose an available model.", "Выберите доступную модель."));
      return;
    }
    const saved = await command("update", task.id, {
      execution: model ? { model, effort: effort || undefined } : null,
      revision: task.revision, actor: "user",
    });
    if (saved) await showTask(saved.id);
  });
  const [model, effort] = editor.querySelectorAll("select");
  function setEfforts(value) {
    const available = models.find(entry => entry.id === model.value)?.efforts ?? [];
    effort.replaceChildren(new Option(defaultLabel, ""), ...available.map(value => new Option(value, value)));
    effort.disabled = !available.length;
    if (available.includes(value)) effort.value = value;
  }
  model.addEventListener("change", () => setEfforts(""));
  setEfforts(task.execution?.effort);
  if (!result.ok) notice(boardError(result.error));
}

async function showTask(id) {
  const request = ++taskSheetRequest;
  const project = frame.project;
  const result = await api.command("show", id);
  if (request !== taskSheetRequest || project !== frame.project) return;
  if (!result.ok) {
    notice(boardError(result.error));
    return;
  }
  const task = result.data;
  notice();
  const sameTask = sheetKind === "task" && taskInSheet?.id === id;
  const scroll = sameTask ? body.scrollTop : 0;
  const focusedChat = sameTask && document.activeElement.id === "task-chat-input" ? document.activeElement : undefined;
  taskInSheet = task;
  openSheet("task", task.id + " · " + task.title);
  const lane = lanes.find(([state]) => state === shownStatus(task));
  const status = lane ? language(lane[1], lane[2]) : task.status;
  body.append(element("p", status + " · " + priorityName(task.priority) + " · " + shortDate(task.updatedAt), "muted"));
  savedChangesSection(task, task.savedChanges);
  if (task.tags.length) {
    const tags = element("div", undefined, "task-tags");
    tags.id = "task-sheet-tags";
    tags.append(...tagBadges(task.tags));
    body.append(tags);
  }
  const runStatus = element("p", undefined, "muted");
  runStatus.id = "task-agent-run";
  renderAgentRunStatus(runStatus, task);
  body.append(runStatus);
  section(language("Description", "Описание"), task.description);
  section(language("Acceptance criteria", "Критерии приёмки"), task.criteria);
  section(language("Subtasks", "Подзадачи"), task.subtasks.map(item => (item.done ? "✓ " : "○ ") + item.title));
  if (task.status === "in_progress") section(language("Submission", "Сдача"), language("Result not submitted", "Результат не сдан"));
  section(language("Progress", "Ход работы"), task.summary);
  section(language("Next step", "Следующий шаг"), task.nextStep);
  if (task.dependencies?.length) {
    const waiting = new Set(task.unfinishedDependencies);
    const names = new Map([...(frame.board?.tasks ?? []), ...(frame.board?.archived ?? [])]
      .map(entry => [entry.id, entry.title]));
    const label = waiting.size ? language("Blocked by dependencies", "Заблокировано зависимостями") :
      language("Task dependencies", "Зависимости задачи");
    section(label, task.dependencies.map(id => (waiting.has(id) ? "○ " : "✓ ") +
      id + (names.has(id) ? " · " + names.get(id) : "")));
  }
  if (task.execution) {
    section(language("Execution settings", "Параметры запуска"), task.execution.model + " · " +
      (task.execution.effort ?? language("Provider default", "По умолчанию у провайдера")));
  }
  if (task.blocked) section(language("Blocker", "Причина блокировки"), [task.blocked.reason, task.blocked.condition]);
  if (task.result) {
    section(language("Result", "Результат"), task.result.summary);
    section(language("Checks", "Проверки"), task.result.checks);
    section(language("Limitations", "Ограничения"), task.result.limitations);
  }
  if (task.git) {
    section("Git", [task.git.target, task.git.worktree, task.git.submission?.sha, task.git.accepted].filter(Boolean));
  }
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
  if (task.status === "ready") actions.append(button(language("Return to draft", "Вернуть в черновик"), () => act("return-to-draft")));
  if (["draft", "ready"].includes(task.status)) {
    actions.append(button(language("Dependencies…", "Зависимости…"), () => editDependencies(task)));
    actions.append(button(language("Execution settings…", "Параметры запуска…"), () => editExecution(task)));
  }
  if (task.status === "review") {
    actions.append(button(language("Review changes", "Проверить изменения"), () => showReview(task), "primary"));
    actions.append(button(language("Request changes", "Вернуть на доработку"), () => noteTask(task, "request-changes")));
  }
  if (task.git?.worktree) actions.append(button(language("Open worktree", "Открыть worktree"), async () => {
    const result = await api.openWorktree(task.id);
    if (!result.ok) notice(boardError(result.error));
  }));
  if (["done", "cancelled"].includes(task.status)) {
    if (task.cleanupAvailable) {
      const label = task.status === "done"
        ? language("Remove worktree and branch", "Убрать рабочую копию и ветку")
        : language("Remove worktree", "Убрать рабочую копию");
      actions.append(button(label, () => act("cleanup")));
    }
  } else {
    actions.append(button(language("Edit", "Редактировать"), () => taskEditor(task)));
    actions.append(button(language("Cancel task", "Отменить задачу"), () => noteTask(task, "cancel"), "danger"));
  }
  const codexAction = codexTaskAction(task);
  if (codexAction) actions.append(codexAction);
  if (task.codexThreadId) actions.append(openCodexTaskAction(task));
  body.append(actions);
  body.append(taskChat(task));
  body.scrollTop = scroll;
  if (focusedChat && byId("task-chat-input")) {
    byId("task-chat-input").focus({ preventScroll: true });
    byId("task-chat-input").setSelectionRange(focusedChat.selectionStart, focusedChat.selectionEnd);
  }
}

function taskAttachmentButton(id, attachment, kind) {
  return button("↓ " + attachment.name, async () => {
    const result = await api.saveAttachment(id, attachment.file, attachment.name);
    if (!result.ok) notice(boardError(result.error));
  }, kind);
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
  if (task.cleanupWarning) {
    messages.push(language("The task was accepted. Cleanup needs attention.",
      "Задача принята. Завершите уборку рабочей копии и ветки.") + "\n" + boardError(task.cleanupWarning));
  }
  if (messages.length) notice(messages.join("\n"));
}

async function showReview(task, messageDraft) {
  const review = await command("review", task.id);
  if (!review) return;
  task = { ...task, revision: review.revision };
  const local = review.localChanges;
  const editor = form("review", language("Review changes", "Проверка изменений"), [
    { name: "message", label: language("Acceptance commit message", "Сообщение коммита приёмки"), type: "area",
      value: messageDraft ?? review.message, required: true },
  ], language("Accept", "Принять"), async ({ message }) => {
    const result = await api.command("accept", task.id, {
      revision: task.revision, targetHead: review.targetHead, message,
    });
    if (result.ok) {
      await showAcceptedTask(result.data);
    } else {
      if (sheetKind === "review" && taskInSheet?.id === task.id) {
        await showReview(task, message);
        if (result.error.code === "MERGE_CONFLICT" && sheetKind === "review" && taskInSheet?.id === task.id) {
          const start = "start " + task.id + " --stdin";
          const input = JSON.stringify({ revision: task.revision, resolveConflicts: true });
          const prompt = [
            language("Resolve conflicts in task ", "Разреши конфликты в задаче ") + task.id + ".",
            language("Use AI Taskboard ", "Вызови команду AI Taskboard ") + start + " " +
              language("with JSON input ", "с JSON на stdin ") + input + ".",
            language("Resolve the conflicts in the task worktree, run the checks and resubmit for review.",
              "Разреши конфликты в рабочей копии задачи, выполни проверки и повторно сдай результат."),
          ].join("\n");
          body.append(button(language("Copy request for agent", "Скопировать запрос для агента"), async () => {
            await navigator.clipboard.writeText(prompt);
            notice(language("Request copied.", "Запрос скопирован."));
          }));
        }
      }
      notice(boardError(result.error));
    }
  });
  const diff = renderReviewDiff(review.diff);
  const caption = element("p", review.target + " · " + review.mode + " · " + review.submitted.slice(0, 12), "muted");
  body.prepend(caption, diff);
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
  if (review.stale && !review.pending) {
    notice(language("The task worktree changed. Submit it again.", "Рабочая копия изменилась. Сдайте задачу повторно."));
    body.querySelector("button[type=submit]").disabled = true;
  }
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
  const section = element("section", undefined, "integration-panel");
  section.append(element("h3", language("Codex integration", "Интеграция с Codex")));
  const status = element("p", language("Checking Codex…", "Проверяем Codex…"), "muted");
  status.setAttribute("role", "status");
  const details = element("p", undefined, "muted");
  const actions = element("div", undefined, "sheet-actions");
  const install = button(language("Connect Codex", "Подключить Codex"), () => update(api.installCodex), "primary");
  install.id = "connect-codex";
  const choose = button(language("Choose executable…", "Выбрать файл…"), () => update(api.chooseCodex));
  const auto = button(language("Detect automatically", "Найти автоматически"), () => update(api.autoDetectCodex));
  const refresh = button(language("Refresh status", "Обновить статус"), () => update(api.codexStatus));
  actions.append(install, choose, auto, refresh);
  section.append(status, details, actions);
  body.append(section);

  async function update(load) {
    for (const item of actions.children) item.disabled = true;
    status.textContent = language("Checking Codex…", "Проверяем Codex…");
    try {
      const result = await load();
      const messages = {
        unavailable: language("Codex with plugin support was not found.", "Codex с поддержкой плагинов не найден."),
        ready: language("Codex is available.", "Codex найден."),
        installed: language("Installed. Open a new Codex chat to load the skills.", "Плагин установлен. Откройте новый чат Codex, чтобы загрузить навыки."),
        disabled: language("The plugin is installed and disabled.", "Плагин установлен и отключён."),
        conflict: language("The plugin name is in use by a different source.", "Имя плагина уже используется другим источником."),
        error: language("Codex did not confirm the connection.", "Codex не подтвердил подключение."),
      };
      status.textContent = messages[result.state] || messages.error;
      details.textContent = [result.clientPath, result.clientVersion ? "Codex " + result.clientVersion : "",
        result.pluginVersion ? "AI Taskboard " + result.pluginVersion : "", result.error].filter(Boolean).join(" · ");
      install.textContent = result.state === "installed"
        ? language("Reconnect Codex", "Переподключить Codex") : language("Connect Codex", "Подключить Codex");
      install.disabled = !["ready", "installed", "disabled", "error"].includes(result.state) ||
        (result.state === "error" && !result.clientPath);
      auto.hidden = !result.selectedPath;
    } catch (error) {
      status.textContent = language("Could not check Codex.", "Не удалось проверить Codex.");
      details.textContent = error.message;
    } finally {
      for (const item of [choose, auto, refresh]) item.disabled = false;
    }
  }

  void update(api.codexStatus);
}

function renderTagSettings(panel) {
  const focusedTag = panel.contains(document.activeElement) ? document.activeElement.dataset.tag : undefined;
  const add = element("form", undefined, "tag-create");
  const name = element("input");
  name.required = true;
  name.placeholder = language("Tag name", "Название тега");
  name.setAttribute("aria-label", name.placeholder);
  const color = element("input");
  color.type = "color";
  color.value = "#6747a9";
  color.setAttribute("aria-label", language("New tag color", "Цвет нового тега"));
  const submit = element("button", language("Add tag", "Добавить тег"), "button");
  submit.type = "submit";
  add.append(name, color, submit);
  add.addEventListener("submit", event => {
    event.preventDefault();
    void protect(async () => {
      submit.disabled = true;
      try {
        if (await command("tag-create", undefined, { name: name.value, color: color.value })) name.value = "";
      } finally { submit.disabled = false; }
    })();
  });
  panel.replaceChildren(element("h3", language("Board tags", "Теги доски")), add);
  const theme = getComputedStyle(document.documentElement);
  const tags = [...boardTags.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const tag of tags) {
    const row = element("label", undefined, "tag-setting");
    const badge = tagBadge(tag.name, tag.color, tag.customColor);
    const picker = element("input");
    picker.type = "color";
    picker.dataset.tag = tag.name;
    const previous = tag.customColor ?? theme.getPropertyValue("--" + tag.color).trim();
    picker.value = previous;
    picker.addEventListener("change", protect(async () => {
      picker.disabled = true;
      try {
        const saved = await command("tag-color", undefined, { name: tag.name, color: picker.value });
        picker.value = saved?.customColor ?? previous;
        if (saved?.customColor) badge.style.setProperty("--tag-color", saved.customColor);
      } finally { picker.disabled = false; }
    }));
    row.append(badge, picker);
    panel.append(row);
    if (tag.name === focusedTag) picker.focus();
  }
}

function settings() {
  chatCatalog = undefined;
  if (!frame.board) {
    openSheet("settings", language("Settings", "Настройки"));
    body.append(element("p", language("Open a project to configure its board.", "Откройте проект, чтобы настроить доску.")));
    appearanceSettings();
    codexSettings();
    return;
  }
  const current = frame.board.settings;
  form("settings", language("Board settings", "Настройки доски"), [
    { name: "archive", label: language("Archive after days (blank disables)", "Архивировать через N дней (пусто — отключено)"),
      type: "number", value: current.archiveAfterDays },
    { name: "mode", label: language("Acceptance mode", "Режим приёмки"), value: current.integrationMode,
      options: [["merge", "Merge"], ["squash", "Squash"]] },
  ], language("Save settings", "Сохранить настройки"), async values => {
    if (await command("settings", undefined, {
      archiveAfterDays: values.archive === "" ? null : Number(values.archive), integrationMode: values.mode,
    })) sheet.close();
  });
  body.append(button(language("Check archives now", "Проверить архивацию"), () => command("archive")));
  const tags = element("section", undefined, "tag-settings");
  tags.id = "tag-settings";
  renderTagSettings(tags);
  body.append(tags);
  appearanceSettings();
  codexSettings();
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
    notice(boardError(result.error));
    return;
  }
  notice();
  return result.data;
}

function updateGitRevision(data) {
  frame.board.gitInfo = { ...frame.board.gitInfo, branch: data.branch, head: data.head };
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
  editor.prepend(element("p", language("Create from: ", "Создать из: ") + (ref ?? snapshot.branch ?? "HEAD"), "muted"));
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
    create.hidden = from.hidden = detach.hidden = mode !== "switch";
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
    }) : [element("p", language("No matching branches or tags.", "Подходящих веток и тегов нет."), "muted")]));
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
  search.focus();
}

let gitMenuKeys = new AbortController();
let publishingGit = false;

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

function renderStatusBar(projectChanged) {
  const { branch, head, user } = frame.board?.gitInfo ?? {};
  for (const [id, value, label] of [
    ["status-branch", branch ?? head?.slice(0, 8), language("Git branch", "Ветка Git")],
    ["status-user", user, language("Git user", "Пользователь Git")],
  ]) {
    const item = byId(id);
    item.hidden = !value;
    item.title = value ? label + " · " + value : "";
    item.querySelector("span").textContent = value ?? "";
  }
  const publish = byId("status-publish");
  publish.hidden = !branch && !head;
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
  const label = language("Notifications", "Уведомления");
  const submitted = (frame.board?.tasks ?? []).filter(task => task.status === "review").flatMap(task => {
    const event = task.history.findLast(entry => entry.action === "submit" && entry.actor === "agent" && entry.to === "review");
    return event ? [{ id: task.id, title: task.title, at: event.at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
  bell.title = label;
  bell.setAttribute("aria-label", submitted.length ? label + " · " + submitted.length : label);
  const count = bell.querySelector(".count");
  count.textContent = submitted.length;
  count.hidden = !submitted.length;
  menu.setAttribute("aria-label", label);
  const entries = JSON.stringify([frame.russian, submitted]);
  if (menu.dataset.entries === entries) return;
  menu.dataset.entries = entries;
  menu.replaceChildren(...(submitted.length ? submitted.map(task => {
    const open = button("", () => {
      menu.hidePopover();
      return showTask(task.id);
    }, "quiet notification-entry");
    open.append(element("span", language("Agent completed a task", "Агент завершил задачу")),
      element("strong", task.id + " · " + task.title));
    return open;
  }) : [element("p", language("No new notifications.", "Новые уведомления отсутствуют."), "muted")]));
}

function update(next) {
  const projectChanged = frame.project !== next.project;
  const tagsChanged = JSON.stringify(frame.board?.tags) !== JSON.stringify(next.board?.tags);
  frame = next;
  if (byId("app-header").hidden) {
    byId("app-header").classList.toggle("titlebar", api.customTitleBar);
    mountAppMenu();
    byId("app-header").hidden = false;
  }
  if (tagsChanged) boardTags = new Map((next.board?.tags ?? []).map(tag => [tagKey(tag.name), tag]));
  applyTheme(next.theme);
  renderStatusBar(projectChanged);
  if (projectChanged) {
    lanePreferences = loadLanePreferences();
    cardCoverCache.clear();
    archiveView = false;
    byId("search").value = "";
    byId("filters").open = false;
    byId("priority-filter").value = "";
    byId("tag-filter").replaceChildren();
    if (sheet.open) sheet.close();
  }
  render();
  const tagSettings = byId("tag-settings");
  if (tagsChanged && sheet.open && tagSettings) renderTagSettings(tagSettings);
  if (sheetKind === "task" && sheet.open && taskInSheet) {
    const runStatus = byId("task-agent-run");
    if (runStatus) renderAgentRunStatus(runStatus, taskInSheet);
    if (tagsChanged) byId("task-sheet-tags")?.replaceChildren(...tagBadges(taskInSheet.tags));
    const task = frame.board?.tasks.find(entry => entry.id === taskInSheet.id);
    const archived = frame.board?.archived.some(entry => entry.id === taskInSheet.id);
    if ((task && (task.revision !== taskInSheet.revision ||
        String(task.unfinishedDependencies) !== String(taskInSheet.unfinishedDependencies))) ||
        (archived && !task && !["done", "cancelled"].includes(taskInSheet.status))) {
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
byId("welcome-open").addEventListener("click", protect(() => api.open()));
byId("close-sheet").addEventListener("click", () => sheet.close());
byId("search").addEventListener("input", render);
byId("filters").addEventListener("change", render);
document.addEventListener("pointerdown", event => {
  const filters = byId("filters");
  if (filters.open && !filters.contains(event.target)) filters.open = false;
});
document.addEventListener("keydown", event => {
  const filters = byId("filters");
  if (event.key === "Escape" && filters.open) {
    filters.open = false;
    filters.querySelector("summary").focus();
  }
  if (!sheet.open && frame.board && (event.ctrlKey || event.metaKey) && event.code === "KeyF") {
    event.preventDefault();
    byId("search").focus();
    byId("search").select();
  }
});
byId("create").addEventListener("click", newTaskDraft);
sheet.addEventListener("close", () => {
  if (sheet.open) return;
  chatPreviews.disconnect();
  taskSheetRequest++;
  sheetKind = "";
  taskInSheet = undefined;
  byId("app-content").inert = false;
  byId("board-actions").inert = false;
  document.querySelector(".status-bar").inert = false;
  if (document.activeElement === document.body || sheet.contains(document.activeElement)) focusBeforeSheet?.focus();
  focusBeforeSheet = undefined;
});
api.subscribe(update);
api.onChatUpdate(updateChat);
api.onTheme(theme => {
  frame.theme = theme;
  applyTheme(theme);
});
api.bootstrap().then(update).catch(error => notice(error.message));
