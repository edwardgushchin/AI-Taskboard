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
let selectedTaskId;
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
  if (["git-branch", "cloud-upload", "close", "add", "file", "arrow-up", "debug-stop", "tasklist", "target", "mic", "pin", "pinned"].includes(name)) {
    const item = element("i", undefined, "icon codicon codicon-" + name);
    item.setAttribute("aria-hidden", "true");
    return item;
  }
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
      ["open-project", "Open project…", "Открыть проект…", "O"],
      ["open-recent", "Open recent", "Открыть последнее"],
      ["close-tab", "Close project", "Закрыть проект", "W"],
      ["close-window", "Close window", "Закрыть окно", "Shift+W"],
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
    document.querySelector(".status-bar").inert = true;
  }
}

function section(title, content) {
  if (content === undefined || content === "" || (Array.isArray(content) && !content.length)) return;
  const area = element("section", undefined, "sheet-section");
  area.append(element("h3", title));
  if (Array.isArray(content)) {
    const list = element("ul");
    for (const value of content) {
      const item = element("li");
      item.append(chatText(value));
      list.append(item);
    }
    area.append(list);
  } else area.append(chatText(content));
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

function blockerBanner({ reason, condition }) {
  if (/already has an active writer/i.test(reason)) {
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
  return banner;
}

function card(task) {
  const showCover = archiveView || frame.board.settings?.showCardPreviews !== false;
  const cover = showCover ? selectedCover(task, (task.attachments ?? []).filter(isImageAttachment)) : undefined;
  // Only visible card data belongs in this key: chat/log/revision updates must not rebuild it.
  const signature = JSON.stringify([frame.russian, task.title, task.description,
    task.tags?.map(name => boardTags.get(tagKey(name)) ?? { name }), cover?.file,
    frame.runningTasks?.includes(task.id) ?? false, task.status, Boolean(task.codexThreadId),
    task.unfinishedDependencies?.length, task.blocked, task.subtasks?.map(entry => entry.done),
    task.attachments?.length, task.priority]);
  const previous = boardCards.get(task.id);
  if (previous?.signature === signature) return previous.node;
  const card = previous?.node ?? button("", () => showTask(task.id));
  const oldDetails = card.querySelector(".task-card-details");
  const oldImage = card.querySelector(".task-card-cover");
  if (oldDetails) cardCovers.unobserve(oldDetails);
  card.className = "task-card";
  card.dataset.state = task.status;
  card.dataset.selected = String(task.id === selectedTaskId);
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
  if (task.description && task.status !== "blocked") item.append(element("span", task.description, "task-description"));
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
      image.onload = () => { image.hidden = false; };
    }
    item.append(image);
  }
  const meta = element("span", undefined, "task-meta");
  meta.append(element("span", task.id, "task-id"));
  const runStatus = element("span", undefined, "task-run-status");
  renderAgentRunStatus(runStatus, task);
  if (!runStatus.hidden) meta.append(runStatus);
  if (task.unfinishedDependencies?.length && ["draft", "blocked"].includes(task.status)) {
    meta.append(taskIndicator("dependency", task.unfinishedDependencies.length,
      language("Unfinished dependencies", "Незавершённые зависимости"), "dependency-warning"));
  }
  if (task.status === "blocked" && task.blocked) {
    const banner = blockerBanner(task.blocked);
    banner.title = task.blocked.reason + "\n\n" + task.blocked.condition;
    item.append(banner);
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
    const priority = element("span", undefined, "task-priority task-stat");
    priority.append(icon("flag"), priorityName(task.priority));
    priority.dataset.priority = task.priority;
    meta.append(priority);
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
  boardCards.clear();
  boardLanes.clear();
  byId("lanes").replaceChildren();
  byId("archive-list").replaceChildren();
  byId("board-composer").firstChild?.dispose?.();
  byId("board-composer").replaceChildren();
  selectedTaskId = undefined;
}

function switchBoardRendering(previousProject, project) {
  cardCovers.disconnect();
  const previousComposer = byId("board-composer").firstChild;
  previousComposer?.closeMentions?.();
  previousComposer?.cancelDictation?.();
  if (previousProject && (boardCards.size || boardLanes.size)) {
    boardViews.set(previousProject, {
      cards: boardCards, lanes: boardLanes, covers: cardCoverCache, preferences: lanePreferences,
      columns: [...byId("lanes").childNodes], archive: [...byId("archive-list").childNodes],
      composer: [...byId("board-composer").childNodes], selectedTaskId,
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
  selectedTaskId = saved?.selectedTaskId;
  return saved?.preferences;
}

function openCodexTaskAction(task) {
  return button(language("Open Codex chat", "Открыть чат Codex"), async () => {
    const result = await api.openCodexThread(task.id);
    if (!result.ok) notice(boardError(result.error));
  });
}

function codexTaskAction(task) {
  const generation = projectGeneration;
  const newThread = task.status === "blocked" && /already has an active writer/i.test(task.blocked?.reason ?? "");
  if (task.status !== "ready" && task.status !== "in_progress" && !newThread) return null;
  const label = newThread ? language("Continue in a new chat", "Продолжить в новом чате") : task.status === "in_progress" || task.git
    ? language("Continue", "Продолжить")
    : language("Send to work", "Передать в работу");
  const launch = button(label, async () => {
    launch.disabled = true;
    try {
      const result = await api.launchTask(task.id, newThread ? { newThread: true } : undefined);
      if (generation !== projectGeneration) return;
      if (!result.ok) notice(boardError(result.error));
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
    const label = (collapsed ? language("Expand ", "Развернуть колонку ") : language("Collapse ", "Свернуть колонку ")) + title;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggleText.textContent = collapsed ? language("Expand column", "Развернуть колонку") : language("Collapse column", "Свернуть колонку");
  }
  let empty;
  let visibleLimit = 4;
  const more = button("", () => {
    visibleLimit += 4;
    updateCards();
    if (!more.isConnected) content.querySelectorAll(".task-card")[visibleLimit - 4]?.focus();
  }, "quiet lane-more");
  function updateCards() {
    const matching = tasks.filter(task => (!priority.value || task.priority === priority.value) &&
      (!selected.size || task.tags.some(name => selected.has(tagKey(name)))));
    const active = selected.size + Number(Boolean(priority.value));
    const children = matching.slice(0, visibleLimit).map(card);
    if (matching.length > visibleLimit) {
      const remaining = matching.length - visibleLimit;
      const noun = { one: "задача", few: "задачи", many: "задач", other: "задачи" }[new Intl.PluralRules("ru").select(remaining)];
      more.textContent = language("Show " + remaining + " more tasks", "Ещё " + remaining + " " + noun);
      children.push(more);
    }
    if (!matching.length && (total || active)) {
      if (!empty) {
        empty = element("div", undefined, "lane-filter-empty");
        empty.append(element("p", language("No matching tasks", "Нет подходящих карточек"), "muted"),
          button(resetLabel, clearFilters, "quiet"));
      }
      empty.querySelector("button").hidden = !active;
      children.push(empty);
    }
    syncChildren(content, children);
    const label = matching.length === total ? String(total) : matching.length + language(" of ", " из ") + total;
    if (count.textContent !== label) count.textContent = label;
    if (filterCount.textContent !== String(active)) filterCount.textContent = active;
    filterCount.hidden = active === 0;
    reset.hidden = active === 0;
    summary.title = filterLabel;
    summary.setAttribute("aria-label", active ? filterLabel + " (" + active + ")" : filterLabel);
  }
  updateCards();
  updateCollapse();
  options.append(toggle);
  toolbar.append(filter);
  return { toolbar, update(nextTasks, nextTotal) {
    tasks = nextTasks;
    total = nextTotal;
    updateCards();
  } };
}

function newestTaskFirst(a, b) {
  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  return (Number.isFinite(bCreated) ? bCreated : -Infinity) -
    (Number.isFinite(aCreated) ? aCreated : -Infinity) ||
    b.id.localeCompare(a.id, "en", { numeric: true });
}

function render() {
  document.documentElement.lang = frame.russian ? "ru" : "en";
  const currentBoard = frame.board;
  // Project waiting tasks into the blocked lane while keeping their workflow status in the board data.
  const board = currentBoard && { ...currentBoard, tasks: currentBoard.tasks.map(task => {
    const status = shownStatus(task);
    return status === task.status ? task : { ...task, status };
  }) };
  const noBoard = !board;
  const loading = Boolean(frame.loading || frame.restoring);
  byId("welcome").hidden = !noBoard || loading;
  byId("loading").hidden = !noBoard || !loading;
  byId("loading").textContent = language("Loading projects…", "Загрузка проектов…");
  byId("app-content").setAttribute("aria-busy", String(noBoard && loading));
  byId("workspace").hidden = noBoard;
  byId("archive-menu-item").setAttribute("aria-disabled", String(noBoard));
  byId("archive-menu-item").setAttribute("aria-checked", String(archiveView));
  if (frame.error) notice(boardError(frame.error));
  else if (!sheet.open) notice();
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
  if (!archiveView) {
    composer.loadSuggestions();
    composer.revealPinned();
  }
  composer.syncPrompt();
  if (archiveView) {
    const tasks = board.archived;
    syncChildren(byId("archive-list"), tasks.length ? tasks.map(card) :
      [element("p", language("No archived tasks found.", "Архивных задач не найдено."), "muted")]);
    return;
  }
  const visible = [...board.tasks].sort(newestTaskFirst);
  const focused = document.activeElement;
  const toolsKey = JSON.stringify([frame.russian, [...boardTags]]);
  const columns = lanes.map(([state, english, russian]) => {
    const tasks = visible.filter(task => task.status === state);
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
    const total = board.tasks.filter(task => task.status === state).length;
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
  syncChildren(byId("lanes"), columns);
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
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

function draftComposer() {
  const project = frame.project;
  const files = [];
  const queued = [];
  let active;
  let disposed = false;
  const editor = element("form", undefined, "board-draft");
  editor.id = "board-draft";
  const chat = element("section", undefined, "board-chat");
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
  bar.append(resize, pin);
  let currentGoal;
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
    if (active || queued.length || changingGoal) return;
    goalError.textContent = "";
    const entry = element("div");
    entry.hidden = true;
    queued.push({ entry, status: element("span"), request: "", goal: "resume", submitted: [] });
    sendNext();
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
    goalStatus.textContent = language(...(goalLabels[currentGoal.status] ?? ["Goal", "Цель"]));
    goalPanel.dataset.status = currentGoal.status;
    pauseGoal.hidden = currentGoal.status !== "active";
    resumeGoal.hidden = currentGoal.status === "complete" || (currentGoal.status === "active" && Boolean(active));
    resumeGoal.disabled = changingGoal || Boolean(active) || queued.length > 0;
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
  editor.updateGoal = goal => {
    goalRevision++;
    showGoal(goal);
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
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.tabIndex = 0;
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
  const queue = element("div", undefined, "board-chat-queue");
  log.append(greeting, queue);
  chat.append(bar, goalPanel, log);
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
  const currentPrompt = () => prompts[promptIndex] ??
    language("Write to the project manager…", "Напишите менеджеру проекта…");
  const showPrompt = () => { prompt.textContent = goalMode ? language("Describe the goal…", "Опишите цель…") : currentPrompt(); };
  const canAnimatePrompt = () => prompts.length > 0 && !reducedMotion.matches && !document.hidden &&
    editor.isConnected && editor.checkVisibility() && !goalMode && !input.value && !active && !input.matches(":focus");
  const segmenter = new Intl.Segmenter();
  const promptCharacters = () => Array.from(segmenter.segment(currentPrompt()), part => part.segment);
  let promptTimer;
  const pausePrompt = () => {
    clearTimeout(promptTimer);
    promptTimer = undefined;
    showPrompt();
  };
  const animatePrompt = () => {
    let characters = promptCharacters();
    let length = characters.length;
    let erasing = true;
    const step = () => {
      if (!canAnimatePrompt()) return pausePrompt();
      length += erasing ? -1 : 1;
      prompt.textContent = characters.slice(0, length).join("");
      if (erasing && length === 0) {
        promptIndex = (promptIndex + 1) % prompts.length;
        characters = promptCharacters();
        erasing = false;
        promptTimer = setTimeout(step, 180);
      } else if (!erasing && length === characters.length) {
        promptTimer = undefined;
        syncPrompt();
      } else {
        promptTimer = setTimeout(step, erasing ? 16 : 26);
      }
    };
    step();
  };
  const syncPrompt = () => {
    if (!canAnimatePrompt()) {
      if (reducedMotion.matches && promptIndex < 0 && prompts.length) promptIndex = 0;
      pausePrompt();
    } else if (promptTimer === undefined && (promptIndex < 0 || prompts.length > 1)) {
      promptTimer = setTimeout(animatePrompt, promptIndex < 0 ? 3000 : 10000);
    }
  };
  editor.syncPrompt = syncPrompt;
  const loadSuggestions = () => {
    const locale = Boolean(frame.russian);
    if (suggestionsLanguage === locale) return;
    suggestionsLanguage = locale;
    prompts = [];
    promptIndex = -1;
    pausePrompt();
    void api.boardSuggestions().then(result => {
      if (suggestionsLanguage !== locale) return;
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
      send.replaceChildren(icon(stop ? "debug-stop" : "arrow-up"));
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
  const inputArea = element("div", undefined, "draft-input");
  inputArea.append(input, prompt);
  field.append(add, inputArea, controls, voiceRow, menu, mentions, picker, hint, goalChip, attachments, voiceStatus, progress);
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
  const chatMessage = (actor, text, files = [], animate = false) => {
    greeting.hidden = true;
    const entry = element("div", undefined, "chat-entry");
    entry.dataset.actor = actor;
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
    if (text) entry.append(actor === "agent" ? chatText(text, {}) : element("p", text, "chat-text"));
    log.insertBefore(entry, queue);
    if (animate) scrollChat();
    return entry;
  };
  // Opening can reveal the log after messages arrived while it had no layout.
  let scrollFrame;
  const scrollChat = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      log.scrollTop = log.scrollHeight;
    });
  };
  const message = text => {
    progress.textContent = text;
    progress.hidden = !text;
  };
  const busy = value => {
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
  const showActivityStatus = text => {
    const label = active.thinking.firstElementChild;
    if (label.textContent === text) return;
    label.textContent = text;
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
    showActivityStatus(waiting
      ? language("Waiting for the Codex chat to become available…", "Жду освобождения чата Codex…")
      : thinkingLabel());
    canStop = waiting;
    syncAction();
  };
  const showChanges = (changes, animate = false) => {
    const labels = {
      create: language("Draft created", "Черновик создан"),
      update: language("Task updated", "Задача обновлена"),
      comment: language("Comment added", "Комментарий добавлен"),
      cancel: language("Task cancelled", "Задача отменена"),
      block: language("Task blocked", "Задача заблокирована"),
      unblock: language("Task unblocked", "Задача разблокирована"),
      start: language("Task started", "Задача запущена"),
      approve: language("Task approved", "Задача утверждена"),
      accept: language("Task accepted", "Задача принята"),
      request_changes: language("Changes requested", "Задача возвращена на доработку"),
    };
    for (const { id, title, action } of changes) {
      const entry = chatMessage("agent", undefined, [], animate);
      entry.classList.add("board-chat-change");
      const open = button(id + (title ? " · " + title : ""), () => showTask(id), "quiet board-chat-task");
      open.dataset.task = id;
      entry.append(element("span", labels[action]), open);
    }
  };
  const activity = () => {
    const container = element("div", undefined, "chat-run");
    log.insertBefore(container, queue);
    return container;
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
  const renderActivity = (container, items, completed) => {
    const messages = new Map();
    for (const child of container.querySelectorAll("[data-item]")) {
      const block = child.matches(".chat-text") ? child : child.matches(".chat-run-final") ? child.firstElementChild : undefined;
      const state = block && streamedText.get(block);
      if (state) messages.set(child.dataset.item.replace(/^final:/, "message:"), state);
    }
    const previous = new Map([...container.querySelectorAll("[data-item]")].map(child =>
      [child.dataset.item, child.getAnimations().find(animation => animation.animationName === "board-chat-enter")?.currentTime]));
    renderRunActivity(container, items, completed, undefined, undefined, {});
    const now = performance.now();
    for (const child of container.querySelectorAll("[data-item]")) {
      if (child.matches(".chat-text, .chat-run-final")) {
        const block = child.matches(".chat-text") ? child : child.firstElementChild;
        fadeStreamedText(block, messages.get(child.dataset.item.replace(/^final:/, "message:")), now);
        continue;
      }
      if (child.parentElement.closest("[data-enter]")) continue;
      const elapsed = previous.get(child.dataset.item);
      if (previous.has(child.dataset.item) && !(elapsed >= 0 && elapsed < 220)) continue;
      child.setAttribute("data-enter", "");
      const animation = child.getAnimations()[0];
      if (animation && elapsed != null) animation.currentTime = elapsed;
    }
  };
  let loadingHistory;
  let historyLoaded = false;
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
    editor.cancelDictation();
    queued.length = 0;
    pausePrompt();
    for (const url of previewUrls.splice(0)) URL.revokeObjectURL(url);
    for (const file of pendingPreviews.keys()) releasePreview(file);
  };
  const loadHistory = () => {
    if (!historyLoaded && !loadingHistory) {
      const revision = goalRevision;
      loadingHistory = api.boardHistory().then(result => {
        if (!result.ok) throw new Error(boardError(result.error));
        if (revision === goalRevision && result.data.goal !== undefined) showGoal(result.data.goal);
        const oldImages = [...log.querySelectorAll(".chat-attachments img")];
        log.replaceChildren(greeting, queue);
        greeting.hidden = false;
        for (const turn of result.data.turns) {
          for (const { text, files } of turn.messages) chatMessage("user", text, files);
          renderRunActivity(activity(), turn.items, true, turn.durationMs, undefined, {});
          showChanges(turn.changes);
        }
        if (active) queue.before(active.entry, active.container, active.thinking);
        releaseMessagePreviews(oldImages.filter(image => !log.contains(image)).map(image => ({ url: image.src })));
        greeting.hidden = log.childElementCount > 2 || queued.length > 0;
        historyLoaded = true;
        scrollChat();
      }).finally(() => { loadingHistory = undefined; });
    }
    return loadingHistory;
  };
  const revealHistory = () => {
    scrollChat();
    if (active) return;
    void loadHistory()?.then(scrollChat).catch(error => message(error.message));
  };
  const openChat = () => {
    if (editor.hasAttribute("data-open") && (historyLoaded || loadingHistory)) return;
    editor.setAttribute("data-open", "");
    revealHistory();
  };
  editor.closeChat = () => {
    if (!pinned) editor.removeAttribute("data-open");
  };
  editor.revealPinned = () => { if (pinned && !loadingHistory && !historyLoaded) revealHistory(); };
  editor.invalidateHistory = () => {
    historyLoaded = false;
    if (editor.matches("[data-open], [data-pinned]")) revealHistory();
  };
  field.addEventListener("click", event => {
    if (dictation || event.target.closest(".draft-controls, .draft-add, .draft-add-menu, .draft-task-mentions, .draft-goal-chip, .draft-attachments, .draft-progress")) return;
    openChat();
    if (event.target !== input) input.focus({ preventScroll: true });
  });
  for (const event of ["input", "focus", "blur"]) input.addEventListener(event, syncPrompt);
  input.addEventListener("input", syncAction);
  for (const event of ["input", "select", "click", "compositionend"]) input.addEventListener(event, syncMentions);
  input.addEventListener("blur", closeMentions);
  chat.addEventListener("transitionend", event => {
    if (event.target === chat && event.propertyName === "height" && editor.matches("[data-open], [data-pinned]")) scrollChat();
  });
  editor.loadSuggestions = loadSuggestions;
  editor.updateActivity = items => {
    if (!active) return;
    const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop <= 8;
    const running = items.findLast(item => item.status === "inProgress");
    let status = thinkingLabel();
    if (running?.type === "reasoning") {
      // Codex sends Markdown headings in its public reasoning summaries.
      const headings = [...running.text.matchAll(/^\s*\*\*([^*\r\n]{1,160})\*\*[^\S\r\n]*$/gm)];
      status = headings.at(-1)?.[1].trim() || status;
    } else if (running?.type === "agentMessage") {
      status = language("Writing a reply…", "Пишу ответ…");
    } else if (running?.type === "plan") {
      status = language("Planning…", "Составляю план…");
    } else if (running) {
      const labels = {
        command: ["Running a command…", "Выполняю команду…"],
        edit: ["Editing files…", "Изменяю файлы…"],
        image: ["Working with an image…", "Работаю с изображением…"],
        search: ["Searching the web…", "Ищу в интернете…"],
        tool: ["Using a tool…", "Использую инструмент…"],
      };
      status = language(...labels[activityKind(running)]);
    }
    if (!waitingForChat) showActivityStatus(status);
    renderActivity(active.container, items.filter(item => item.type !== "reasoning" || item.status !== "inProgress"), false);
    if (atBottom) scrollChat();
  };
  function sendNext() {
    const next = queued[0];
    if (disposed || active || !next || next.failed) return;
    queued.shift();
    const { entry, status, draft, request, goal, submitted, rows, messageFiles } = next;
    status.remove();
    queue.before(entry);
    const container = activity();
    const thinking = element("div", undefined, "chat-thinking");
    thinking.append(element("span", thinkingLabel()));
    active = { entry, container, thinking };
    syncGoal();
    busy(true);
    message("");
    thinking.setAttribute("role", "status");
    thinking.setAttribute("data-enter", "");
    queue.before(thinking);
    scrollChat();
    let accepted = false;
    void (async () => {
      await loadHistory()?.catch(() => {});
      const pasted = await Promise.all(submitted.map(async file => ({
        name: file.name, type: file.type, bytes: await file.arrayBuffer(),
      })));
      if (disposed) return;
      const result = await api.boardRequest(request, pasted, project, goal);
      if (!result.ok && result.error.code === "BOARD_WAIT_CANCELLED") return;
      if (!result.ok) throw new Error(boardError(result.error));
      accepted = true;
      const { answer, changes, error, items = [] } = result.data;
      renderActivity(container, items, true);
      if (answer && !container.querySelector(".chat-run-final")) chatMessage("agent", answer, [], true);
      showChanges(changes, true);
      if (error) chatMessage("agent", error, [], true);
      scrollChat();
      if (!editor.isConnected || frame.project !== project || sheet.open) return;
      archiveView = false;
      render();
    })().catch(error => {
      if (goal === "resume") goalError.textContent = error.message;
      else message(error.message);
    }).finally(() => {
      thinking.remove();
      if (!container.childElementCount) container.remove();
      active = undefined;
      busy(false);
      syncGoal();
      if (disposed) return;
      if (accepted) {
        releaseSubmittedPreviews(submitted);
        sendNext();
        return;
      }
      if (goal === "resume") {
        entry.remove();
        sendNext();
        return;
      }
      if (!input.value && !files.length && !queued.length && !goalMode) {
        input.value = draft;
        files.push(...submitted);
        attachments.replaceChildren(...rows);
        attachments.hidden = !rows.length;
        if (!container.childElementCount) {
          entry.remove();
          releaseMessagePreviews(messageFiles);
          greeting.hidden = log.childElementCount > 2;
        }
        setGoalMode(goal);
        return;
      }
      next.failed = true;
      queued.unshift(next);
      const retry = button(language("Retry", "Повторить"), () => {
        next.failed = false;
        sendNext();
      }, "quiet");
      const remove = button(language("Remove", "Удалить"), () => {
        queued.shift();
        entry.remove();
        releaseMessagePreviews(messageFiles);
        releaseSubmittedPreviews(submitted);
        message("");
        sendNext();
      }, "quiet");
      status.replaceChildren(element("span", language("Not sent", "Не отправлено")), retry, remove);
      entry.append(status);
      queue.prepend(entry);
    });
  }
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (dictation || !hasDraft()) return;
    const draft = input.value;
    const request = draft.trim();
    const goal = goalMode;
    const submitted = files.splice(0);
    const rows = [...attachments.children];
    input.value = "";
    closeMentions();
    dismissedMention = undefined;
    attachments.replaceChildren();
    attachments.hidden = true;
    setGoalMode(false);
    const messageFiles = submitted.map(file => {
      if (!previewSource(file)) return { name: file.name };
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      return { name: file.name, url };
    });
    const entry = chatMessage("user", request, messageFiles, true);
    const status = element("div", language("Queued", "В очереди"), "board-queued-status");
    entry.append(status);
    queue.append(entry);
    queued.push({ entry, status, draft, request, goal, submitted, rows, messageFiles });
    sendNext();
    syncAction();
  });
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
      const remove = button("×", () => {
        files.splice(files.indexOf(file), 1);
        if (!files.includes(file)) releasePreview(file);
        row.remove();
        attachments.hidden = !files.length;
        syncAction();
        message("");
        input.focus();
      }, "quiet");
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
  selectedTaskId = id;
  for (const [cardId, { node }] of boardCards) node.dataset.selected = String(cardId === id);
  notice();
  const sameTask = sheetKind === "task" && taskInSheet?.id === id;
  const scroll = sameTask ? body.scrollTop : 0;
  const focusedChat = sameTask && document.activeElement.id === "task-chat-input" ? document.activeElement : undefined;
  taskInSheet = task;
  openSheet("task", task.id + " · " + task.title);
  const runStatus = element("span", undefined, "task-agent-run muted");
  runStatus.id = "task-agent-run";
  renderAgentRunStatus(runStatus, task);
  byId("sheet-title").append(runStatus);
  const lane = lanes.find(([state]) => state === shownStatus(task));
  const status = lane ? language(lane[1], lane[2]) : task.status;
  body.append(element("p", status + " · " + priorityName(task.priority) + " · " + shortDate(task.updatedAt), "muted"));
  if (task.status === "blocked" && task.blocked) body.append(blockerBanner(task.blocked));
  savedChangesSection(task, task.savedChanges);
  if (task.tags.length) {
    const tags = element("div", undefined, "task-tags");
    tags.id = "task-sheet-tags";
    tags.append(...tagBadges(task.tags));
    body.append(tags);
  }
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
  if (task.cleanupWarning && taskInSheet?.id === task.id && taskInSheet.cleanupAvailable) {
    messages.push(language("The task was accepted. Automatic cleanup is pending.",
      "Задача принята. Автоматическая уборка пока не завершена.") + "\n" + boardError(task.cleanupWarning));
  }
  if (messages.length) notice(messages.join("\n"));
}

async function showReview(task, messageDraft) {
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
    section(language("Result", "Результат"), review.result.summary);
    section(language("Checks", "Проверки"), review.result.checks);
    section(language("Limitations", "Ограничения"), review.result.limitations);
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
  const defaultModel = language("Codex default", "По умолчанию в Codex");
  const managerModel = current.manager?.model ?? "";
  const managerEffort = current.manager?.effort ?? "";
  let models = [];
  const editor = form("settings", language("Board settings", "Настройки доски"), [
    { name: "archive", label: language("Archive after days (blank disables)", "Архивировать через N дней (пусто — отключено)"),
      type: "number", value: current.archiveAfterDays },
    { name: "mode", label: language("Acceptance mode", "Режим приёмки"), value: current.integrationMode,
      options: [["merge", "Merge"], ["squash", "Squash"]] },
    { name: "showCardPreviews", label: language("Show previews on board cards", "Показывать превью на карточках"),
      type: "checkbox", value: current.showCardPreviews !== false },
    { name: "managerModel", label: language("Project manager model", "Модель менеджера проекта"),
      value: managerModel, options: managerModel ? [[managerModel, managerModel]] : [["", defaultModel]] },
    { name: "managerEffort", label: language("Project manager reasoning effort", "Уровень рассуждения менеджера"),
      value: managerEffort, options: [[managerEffort, reasoningName(managerEffort)]] },
  ], language("Save settings", "Сохранить настройки"), async values => {
    const { managerModel: model, managerEffort: effort } = values;
    const changed = model !== managerModel || effort !== managerEffort;
    if (changed && model && !models.some(entry => entry.id === model && (entry.effort === effort || entry.efforts.includes(effort)))) {
      notice(language("Choose an available model and reasoning effort.", "Выберите доступную модель и уровень рассуждения."));
      return;
    }
    if (await command("settings", undefined, {
      archiveAfterDays: values.archive === "" ? null : Number(values.archive), integrationMode: values.mode,
      showCardPreviews: values.showCardPreviews,
      ...(changed ? { manager: model ? { model, effort } : null } : {}),
    })) sheet.close();
  });
  const [, model, effort] = editor.querySelectorAll("select");
  const modelStatus = element("p", language("Loading Codex models…", "Загрузка моделей Codex…"), "muted");
  modelStatus.setAttribute("role", "status");
  effort.parentElement.after(modelStatus);
  model.disabled = effort.disabled = true;
  const showEfforts = (saved = "") => {
    const selected = models.find(entry => entry.id === model.value);
    const options = [...new Set([...(selected?.efforts ?? []), selected?.effort].filter(Boolean))];
    if (saved && !options.includes(saved)) options.push(saved);
    effort.replaceChildren(...options.map(value => new Option(reasoningName(value), value)));
    effort.disabled = !selected || !options.length;
    effort.value = saved || selected?.effort || options[0] || "";
  };
  model.addEventListener("change", () => showEfforts(model.value === managerModel ? managerEffort : ""));
  void Promise.resolve().then(() => api.chatModels()).catch(error => ({ ok: false, error: { message: error.message } })).then(result => {
    if (!editor.isConnected) return;
    models = result.ok ? result.data : [];
    model.replaceChildren(new Option(defaultModel, ""), ...models.map(entry => new Option(entry.name, entry.id)));
    if (managerModel && !models.some(entry => entry.id === managerModel)) {
      model.append(new Option(managerModel + " · " + language("unavailable", "недоступна"), managerModel));
    }
    model.value = managerModel;
    model.disabled = !models.length && !managerModel;
    showEfforts(managerEffort);
    modelStatus.textContent = !result.ok ? boardError(result.error) : !models.length ?
      language("No Codex models available.", "Нет доступных моделей Codex.") : "";
    modelStatus.hidden = !modelStatus.textContent;
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

let tabsSignature = "";

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
    select.title = tab.path;
    select.setAttribute("role", "tab");
    select.setAttribute("aria-selected", String(tab.path === frame.project));
    select.setAttribute("aria-controls", "workspace");
    select.tabIndex = tab.path === frame.project ? 0 : -1;
    select.append(element("span", tab.name, "project-tab-name"));
    if (tab.detail) select.append(element("span", tab.detail, "project-tab-detail"));
    select.addEventListener("keydown", protect(async event => {
      const index = tabs.findIndex(entry => entry.path === tab.path);
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
  render();
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
    const archived = frame.board?.archived.some(entry => entry.id === taskInSheet.id);
    const cleaned = taskInSheet.cleanupAvailable && frame.board?.cleanedTasks?.includes(taskInSheet.id);
    if (cleaned || (task && (task.revision !== taskInSheet.revision ||
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
window.addEventListener("focus", () => byId("board-composer").firstChild?.invalidateHistory?.());
const syncBoardPrompt = () => byId("board-composer").firstChild?.syncPrompt?.();
document.addEventListener("visibilitychange", syncBoardPrompt);
reducedMotion.addEventListener("change", syncBoardPrompt);
api.onTheme(theme => {
  frame.theme = theme;
  applyTheme(theme);
});
api.bootstrap().then(update).catch(error => notice(error.message));
