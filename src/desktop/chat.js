const chatDrafts = new Map();
let chatCatalog;
const chatMarkdown = window.markdownit?.({ breaks: true, linkify: true, html: false });
if (chatMarkdown) {
  const web = url => /^https?:\/\//i.test(url);
  const inlineImage = url => /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url);
  chatMarkdown.validateLink = url => web(url) || /^mailto:/i.test(url) || inlineImage(url);
  const image = chatMarkdown.renderer.rules.image;
  chatMarkdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const src = token.attrGet("src");
    if (!web(src) && !inlineImage(src)) return chatMarkdown.utils.escapeHtml(token.content);
    token.attrSet("loading", "lazy");
    token.attrSet("referrerpolicy", "no-referrer");
    return image(tokens, index, options, env, renderer);
  };
  chatMarkdown.core.ruler.after("inline", "task_checkboxes", state => {
    for (let i = 2; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "inline" || state.tokens[i - 1].type !== "paragraph_open" ||
          state.tokens[i - 2].type !== "list_item_open") continue;
      const first = token.children?.[0];
      const marker = first?.type === "text" && /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content);
      if (!marker || !/^\[[ xX]\](?:[ \t]+|$)/.test(token.content)) continue;
      first.content = first.content.slice(marker[0].length);
      const checkbox = new state.Token("task_checkbox", "input", 0);
      checkbox.markup = marker[1];
      token.children.unshift(checkbox);
    }
  });
  chatMarkdown.renderer.rules.task_checkbox = (tokens, index) =>
    "<input type=\"checkbox\" disabled" + (tokens[index].markup === " " ? "" : " checked") + "> ";
}

function chatText(text) {
  const block = element("div", undefined, "chat-text");
  if (!chatMarkdown) {
    block.innerText = text;
    return block;
  }
  block.innerHTML = chatMarkdown.render(text);
  block.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    void protect(() => api.openLink(link.href))();
  });
  return block;
}

const chatPreviews = new IntersectionObserver(entries => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    chatPreviews.unobserve(target);
    if (!target.isConnected) continue;
    const { task, file, path } = target.dataset;
    const preview = path ? api.runImagePreview(task, path) : api.attachmentPreview(task, file);
    void preview.then(src => {
      if (src && target.isConnected) showChatPreview(target, src);
      else if (path && target.isConnected) unavailableRunImage(target);
    }).catch(() => { if (path && target.isConnected) unavailableRunImage(target); });
  }
});

function unavailableRunImage(tile) {
  const label = language("Image unavailable: ", "Изображение недоступно: ") + tile.querySelector("span").textContent;
  tile.querySelector("span").textContent = label;
  controlLabelForIcon(tile, label);
}

function runImageFile(item) {
  if (item.type !== "imageView" || item.status !== "completed") return;
  try {
    const path = JSON.parse(item.text)?.path;
    if (typeof path === "string" && path.trim() && !path.includes("\0")) {
      return { file: path, name: path.replaceAll("\\", "/").split("/").pop() };
    }
  } catch { /* Keep incomplete or unrecognized results as text. */ }
}

function showChatPreview(tile, src) {
  const preview = element("img");
  preview.alt = "";
  const release = () => { if (src.startsWith("blob:")) URL.revokeObjectURL(src); };
  preview.onload = () => {
    release();
    const list = tile.closest(".chat-log");
    const atBottom = list && list.scrollHeight - list.clientHeight - list.scrollTop <= 8;
    tile.prepend(preview);
    tile.classList.add("has-preview");
    if (tile.dataset.file) {
      const name = tile.querySelector("span").textContent;
      controlLabelForIcon(tile, language("Preview ", "Просмотреть ") + name);
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
  };
  preview.onerror = () => { release(); if (tile.dataset.path) unavailableRunImage(tile); };
  preview.src = src;
}

function renderChatTurn(list, draft) {
  const turn = list.querySelector(".chat-turn");
  const atBottom = draft.scroll === undefined;
  turn.hidden = draft.pending !== "replying";
  turn.replaceChildren(...(draft.commentary ?? []).map(text => chatText(text)));
  if (!turn.hidden) {
    const thinking = element("p", language("Thinking…", "Думаю…"), "chat-thinking");
    thinking.setAttribute("role", "status");
    turn.append(thinking);
  }
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function readableRunCommand(command) {
  // Codex quotes Windows argv for display, escaping quotes and backslashes.
  const quoted = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
  const match = new RegExp(`^(${quoted}) -Command (${quoted})$`, "i").exec(command);
  if (!match) return command;
  try {
    const parse = value => JSON.parse(value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t"));
    const executable = parse(match[1]);
    if (!/^[A-Z]:\\.*\\(?:pwsh|powershell)\.exe$/i.test(executable)) return command;
    const script = parse(match[2]);
    // Decode JSON only inside complete literal here-strings. Backslashes in code
    // and ordinary messages are content, not another transport encoding layer.
    return script.replace(/(^|\r?\n)@'\r?\n([\s\S]*?)\r?\n'@(?=\s|$)/g, (source, prefix, json) => {
      try {
        const value = JSON.parse(json);
        if (!value || typeof value !== "object") return source;
        return prefix + "@'\n" + JSON.stringify(value, null, 2) + "\n'@";
      } catch {
        return source;
      }
    });
  } catch {
    return command;
  }
}

function activityKind(item) {
  if (["imageView", "imageGeneration"].includes(item.type) || /(?:view_image|open_image|image_view)/i.test(item.title)) return "image";
  return ({ commandExecution: "command", fileChange: "edit", webSearch: "search", reasoning: "reasoning" })[item.type] ?? "tool";
}

function activityCount(count, english, russian) {
  const form = new Intl.PluralRules(frame.russian ? "ru" : "en").select(count);
  return count + " " + (frame.russian ? (russian[{ one: 0, few: 1, many: 2 }[form] ?? 2]) : english[count === 1 ? 0 : 1]);
}

function activityState(items) {
  const failed = items.filter(item => ["failed", "declined", "denied", "timedOut", "aborted"].includes(item.status)).length;
  const running = items.filter(item => item.status === "inProgress").length;
  return {
    code: failed ? "failed" : running ? "running" : "completed",
    text: [failed ? language("Failed: ", "Ошибок: ") + failed : "", running ? language("Running: ", "Выполняется: ") + running : ""].filter(Boolean).join(" · "),
  };
}

function activitySummary(detail, label, preview, kind, state) {
  const summary = element("summary");
  const title = element("span", undefined, "chat-run-label");
  title.append(element("span", label));
  const compact = preview.replace(/\s+/g, " ").trim();
  if (compact) title.append(element("span", " " + compact.slice(0, 180) + (compact.length > 180 ? "…" : ""), "chat-run-preview"));
  summary.append(icon(({ command: "terminal", edit: "edit", image: "images", search: "search", reasoning: "thought", tool: "tool" })[kind]), title);
  if (state.text) summary.append(element("span", state.text, "chat-run-state"));
  summary.append(icon("chevron"));
  detail.dataset.state = state.code;
  detail.append(summary);
}

function renderRunActivity(container, items, completed = false, durationMs, taskId) {
  const previous = new Map([...container.querySelectorAll("details")].map(entry => [entry.dataset.item, entry.open]));
  const previousImages = new Map([...container.querySelectorAll(".chat-run-item")].map(entry =>
    [entry.dataset.item, entry.querySelector(".chat-run-images")?.querySelector("button")]));
  const focusedImage = [...previousImages.values()].find(tile => tile?.contains(document.activeElement));
  const focused = container.contains(document.activeElement) ? document.activeElement.closest("details")?.dataset.item : undefined;
  const nodes = [];
  const images = taskId ? items.map(runImageFile).filter(Boolean) : [];
  const finalItems = new Set();
  if (completed) {
    for (const item of items) {
      if (item.type === "agentMessage" && item.phase === "final_answer" && item.text.trim()) finalItems.add(item);
    }
    // Older logs have no phase. Their last completed message is the final reply.
    if (!finalItems.size && !items.some(item => item.type === "agentMessage" && item.phase)) {
      const last = items.findLast(item => item.type === "agentMessage" && item.status === "completed" && item.text.trim());
      if (last) finalItems.add(last);
    }
  }
  let operations = [];
  function operation(item) {
    const kind = activityKind(item);
    const labels = {
      command: ["Ran command", "Выполнена команда"], edit: ["Edited files", "Изменены файлы"],
      image: ["Viewed image", "Просмотр изображения"], search: ["Searched the web", "Поиск в интернете"],
      reasoning: ["Reasoning summary", "Сводка размышлений"], tool: ["Used tool", "Вызов инструмента"],
    };
    const detail = element("details", undefined, "chat-run-item");
    detail.dataset.item = "item:" + item.id;
    detail.open = previous.get(detail.dataset.item) ?? false;
    const state = activityState([item]);
    const label = state.code === "running" ? language("In progress", "Выполняется") :
      state.code === "failed" ? language("Action failed", "Ошибка действия") :
      item.type === "imageGeneration" ? language("Generated image", "Создано изображение") : language(...labels[kind]);
    // Only shorten the visible preview; the original command remains available below.
    const command = item.type === "commandExecution" ? readableRunCommand(item.title) : item.title;
    const preview = command.replace(/^(?:"[^"\r\n]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+-Command\s+/i, "");
    const approvalLabels = {
      inProgress: ["Reviewing access", "Проверка доступа"],
      approved: ["Access approved", "Доступ одобрен"],
      denied: ["Access denied", "Доступ отклонён"],
      timedOut: ["Access review timed out", "Время проверки доступа истекло"],
      aborted: ["Access review cancelled", "Проверка доступа отменена"],
    };
    const approvalLabel = item.type === "autoApprovalReview" && Object.hasOwn(approvalLabels, item.status) ? approvalLabels[item.status] : undefined;
    activitySummary(detail, approvalLabel ? language(...approvalLabel) : label, preview, kind, state);
    const image = taskId && runImageFile(item);
    if (image) {
      detail.open = previous.get(detail.dataset.item) ?? true;
      const tiles = element("div", undefined, "chat-attachments chat-run-images");
      let tile = previousImages.get(detail.dataset.item);
      if (!tile || tile.dataset.path !== image.file || tile.dataset.task !== taskId) {
        tile = button("", () => openImagePreview(taskId, tile.imageFiles, tile.imageFiles.findIndex(file => file.file === image.file),
          tile.querySelector("img")?.src, {
            preview: file => api.runImagePreview(taskId, file.file),
            save: file => api.saveRunImage(taskId, file.file),
          }), "quiet chat-attachment");
        controlLabelForIcon(tile, language("View ", "Просмотреть ") + image.name);
        tile.append(icon("images"), element("span", image.name));
        tile.dataset.task = taskId;
        tile.dataset.path = image.file;
        chatPreviews.observe(tile);
      }
      tile.imageFiles = images;
      tiles.append(tile);
      detail.append(tiles);
      return detail;
    }
    if (command) detail.append(element("pre", command, "chat-run-command"));
    detail.append(element("pre", item.text || language("No output.", "Нет вывода."), "chat-run-output"));
    if (command !== item.title) {
      const original = element("details", undefined, "chat-run-original");
      original.dataset.item = "item:" + item.id + "/original";
      original.open = previous.get(original.dataset.item) ?? false;
      original.append(element("summary", language("Original command", "Исходная команда")), element("pre", item.title));
      detail.append(original);
    }
    return detail;
  }
  function flush() {
    if (!operations.length) return;
    if (operations.length === 1) nodes.push(operation(operations[0]));
    else {
      const group = element("details", undefined, "chat-run-group");
      group.dataset.item = "group:" + operations[0].id;
      group.open = previous.get(group.dataset.item) ?? operations.some(item => previous.get("item:" + item.id));
      const kinds = [...new Set(operations.map(activityKind))];
      const names = {
        command: [["command", "commands"], ["команда", "команды", "команд"]],
        edit: [["file edit", "file edits"], ["изменение файлов", "изменения файлов", "изменений файлов"]],
        image: [["image view", "image views"], ["просмотр изображения", "просмотра изображений", "просмотров изображений"]],
        search: [["search", "searches"], ["поиск", "поиска", "поисков"]],
        tool: [["tool call", "tool calls"], ["вызов инструмента", "вызова инструментов", "вызовов инструментов"]],
      };
      const counts = kinds.map(kind => activityCount(operations.filter(item => activityKind(item) === kind).length, ...names[kind])).join(" · ");
      const label = activityCount(operations.length, ["action", "actions"], ["действие", "действия", "действий"]);
      activitySummary(group, label, "· " + counts, kinds.length === 1 ? kinds[0] : "tool", activityState(operations));
      const children = element("div", undefined, "chat-run-children");
      children.append(...operations.map(operation));
      group.append(children);
      nodes.push(group);
    }
    operations = [];
  }
  for (const item of items) {
    if (finalItems.has(item)) continue;
    if (["agentMessage", "plan", "truncated", "error", "reasoning"].includes(item.type)) {
      flush();
      if (item.type === "agentMessage" || item.type === "plan") nodes.push(chatText(item.text));
      else if (item.type === "reasoning") nodes.push(operation(item));
      else nodes.push(element("p", item.type === "error" ? item.text : language("Earlier activity exceeded the log limit.", "Ранние события не поместились в журнал."), item.type === "error" ? "chat-run-error" : "muted"));
    } else operations.push(item);
  }
  flush();
  if (completed && nodes.length) {
    const work = element("details", undefined, "chat-work");
    work.dataset.item = "work";
    work.open = previous.get("work") ?? false;
    let label = language("Completed", "Выполнено");
    if (Number.isSafeInteger(durationMs) && durationMs >= 0) {
      const seconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(seconds / 60);
      label = language("Completed in ", "Выполнено за ") +
        (minutes ? minutes + language("m ", " мин ") : "") + seconds % 60 + language("s", " с");
    }
    activitySummary(work, label, "", "reasoning", activityState(items));
    const chronology = element("div", undefined, "chat-run-body");
    chronology.append(...nodes);
    work.append(chronology);
    nodes.splice(0, nodes.length, work);
  }
  for (const item of finalItems) {
    const final = element("div", undefined, "chat-run-final");
    final.append(chatText(item.text));
    nodes.push(final);
  }
  container.replaceChildren(...nodes);
  container.hidden = items.length === 0;
  if (focusedImage && container.contains(focusedImage)) focusedImage.focus({ preventScroll: true });
  else if (focused) [...container.querySelectorAll("details")].find(entry => entry.dataset.item === focused)?.querySelector("summary")?.focus({ preventScroll: true });
}

function updateChat({ project, id, type, text, items }) {
  const open = frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === id;
  if (type === "run" && frame.project === project) {
    (frame.runActivity ??= {})[id] = items;
    const list = open && body.querySelector(".chat-log");
    if (list) {
      const atBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 8;
      renderRunActivity(list.querySelector(".chat-run-live"), items, false, undefined, id);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
    return;
  }
  const draft = chatDrafts.get(project + "\0" + id);
  if (!draft?.pending) return;
  if (type === "saved" && draft.pending === "saving") {
    draft.text = "";
    draft.files = [];
    draft.pending = "replying";
    if (open) void protect(() => showTask(id))();
  } else if (type === "changed") {
    if (open) void protect(() => showTask(id))();
  } else if (type === "commentary") {
    draft.commentary.push(text);
    const list = open && body.querySelector(".chat-log");
    if (list) renderChatTurn(list, draft);
  }
}

function chatEventLabel(action) {
  const labels = {
    create: ["Created the task", "Создал задачу"], update: ["Updated the task", "Обновил задачу"],
    approve: ["Approved the task", "Утвердил задачу"], start: ["Started work", "Начал работу"],
    "return-to-draft": ["Returned the task to draft", "Вернул задачу в черновик"],
    progress: ["Updated progress", "Обновил ход работы"], block: ["Blocked the task", "Заблокировал задачу"],
    pause: ["Paused work", "Приостановил работу"],
    resume: ["Resumed work", "Продолжил работу"], submit: ["Submitted for review", "Сдал на проверку"],
    accept: ["Accepted the task", "Принял задачу"], cancel: ["Cancelled the task", "Отменил задачу"],
    cover: ["Changed the card cover", "Сменил превью карточки"],
    "request-changes": ["Requested changes", "Вернул на доработку"], attach: ["Attached a file", "Добавил файл"],
  };
  return Object.hasOwn(labels, action) ? language(...labels[action]) : action;
}

function reasoningName(effort) {
  const labels = {
    none: ["None", "Нет"], minimal: ["Minimal", "Минимальное"], low: ["Low", "Низкое"], medium: ["Medium", "Среднее"],
    high: ["High", "Высокое"], xhigh: ["Very high", "Очень высокое"], max: ["Max", "Максимальное"], ultra: ["Ultra", "Ультра"],
  };
  return Object.hasOwn(labels, effort) ? language(...labels[effort]) : effort;
}

function chatEventAttachments(event, files) {
  if (event.action !== "attach") return (event.chat?.files ?? []).map(id => files.get(id)).filter(Boolean);
  if (event.attachment !== undefined) return [files.get(event.attachment)].filter(Boolean);
  // Older attachment events recorded only a filename. Never guess between namesakes.
  const matches = [...files.values()].filter(file => file.name === event.text);
  return matches.length === 1 ? matches : [];
}

function taskChat(task) {
  const project = frame.project;
  const key = project + "\0" + task.id;
  const last = task.history.findLast(event => event.chat);
  const latestReply = task.history.findLast(event => event.chat && event.actor === "agent")?.chat;
  let draft = chatDrafts.get(key);
  if (!draft) {
    draft = { text: "", files: [], model: last?.chat?.model, effort: last?.chat?.effort };
    chatDrafts.set(key, draft);
  }
  const area = element("section", undefined, "task-chat");
  const heading = element("h3", language("Agent chat", "Чат с агентом"));
  heading.id = "task-chat-heading";
  area.setAttribute("aria-labelledby", heading.id);
  const header = element("div", undefined, "chat-header");
  const usage = latestReply?.usage;
  const percent = usage ? Math.min(100, Math.round(100 * usage.used / usage.limit)) : undefined;
  const context = element("span", undefined, "chat-context");
  context.title = usage
    ? language("Context", "Контекст") + " " + percent + "% · " + usage.used.toLocaleString() + " / " + usage.limit.toLocaleString() + language(" tokens", " токенов")
    : language("Context usage will appear after the first reply.", "Расход контекста появится после первого ответа.");
  if (percent !== undefined) {
    context.style.setProperty("--context-used", percent + "%");
    context.setAttribute("role", "meter");
    context.setAttribute("aria-label", language("Context", "Контекст"));
    context.setAttribute("aria-valuenow", String(percent));
  } else {
    context.setAttribute("role", "img");
    context.setAttribute("aria-label", context.title);
  }
  header.append(heading);
  area.append(header);
  const list = element("ol", undefined, "chat-log");
  list.setAttribute("aria-label", language("Messages", "Сообщения"));
  list.tabIndex = 0;
  const files = new Map(task.attachments.map(file => [file.file, file]));
  const events = [...task.history];
  if (task.questions.length) events.splice(1, 0, {
    at: task.createdAt, actor: "agent", action: "questions", text: task.questions.join("\n\n"),
  });
  const locale = frame.russian ? "ru" : undefined;
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  let day;
  let lastMessage;
  for (const event of events) {
    if (event.chat) lastMessage = event;
    const timestamp = new Date(event.at);
    const eventDay = Number.isNaN(+timestamp) ? "" : dayFormat.format(timestamp);
    if (eventDay && eventDay !== day) {
      day = eventDay;
      const divider = element("li", undefined, "chat-day");
      divider.append(element("span", day));
      list.append(divider);
    }
    if (event.run?.length) {
      const log = element("li", undefined, "chat-run");
      renderRunActivity(log, event.run, true, event.durationMs, task.id);
      list.append(log);
      continue;
    }
    if (event.chat?.commentary?.length) {
      const commentary = element("li", undefined, "chat-run");
      renderRunActivity(commentary, event.chat.commentary.map((text, index) => ({
        id: String(index), type: "agentMessage", phase: "commentary", title: "", text, status: "completed",
      })), true, event.durationMs);
      list.append(commentary);
    }
    const conversation = ["chat", "comment", "questions"].includes(event.action);
    const attachments = chatEventAttachments(event, files);
    const author = event.actor === "user" ? language("You", "Вы") : language("Agent", "Агент");
    const date = element("time", eventDay ? timeFormat.format(timestamp) : event.at, "chat-time");
    date.dateTime = event.at;
    date.title = shortDate(event.at);
    if (!conversation) {
      const status = lanes.find(([code]) => code === event.to);
      const service = element("li", undefined, "chat-entry chat-event");
      service.append(element("span", author, "chat-author"),
        element("span", chatEventLabel(event.action) + (status ? " · " + language(status[1], status[2]) : ""), "chat-action"), date);
      list.append(service);
      if (!event.text && !attachments.length) continue;
      // A chat edit can quote the pending request as its audit note.
      if (event.action === "update" && event.actor === "user" &&
          lastMessage?.actor === "user" && event.text === lastMessage.text) continue;
    }
    const entry = element("li", undefined, "chat-entry");
    entry.dataset.actor = event.actor;
    entry.append(element("span", author, "chat-author"));
    if (attachments.length) {
      const images = attachments.filter(isImageAttachment);
      const tiles = element("div", undefined, "chat-attachments");
      for (const file of attachments) {
        const tile = button("", async () => {
          const index = images.indexOf(file);
          if (index >= 0) {
            openImagePreview(task.id, images, index, tile.querySelector("img")?.src);
            return;
          }
          const result = await api.saveAttachment(task.id, file.file, file.name);
          if (!result.ok) notice(boardError(result.error));
        }, "quiet chat-attachment");
        const label = isImageAttachment(file) ? language("View ", "Просмотреть ") : language("Save ", "Сохранить ");
        controlLabelForIcon(tile, label + file.name);
        tile.replaceChildren(icon("attachment"), element("span", file.name));
        if (isImageAttachment(file)) {
          tile.dataset.task = task.id;
          tile.dataset.file = file.file;
          chatPreviews.observe(tile);
        }
        tiles.append(tile);
      }
      entry.append(tiles);
    }
    if (event.text && !(event.action === "attach" && attachments.length)) entry.append(chatText(event.text));
    entry.append(conversation ? date : date.cloneNode(true));
    list.append(entry);
  }
  const liveRun = element("li", undefined, "chat-run chat-run-live");
  renderRunActivity(liveRun, frame.runActivity?.[task.id] ?? [], false, undefined, task.id);
  list.append(liveRun, element("li", undefined, "chat-turn"));
  renderChatTurn(list, draft);
  area.append(list);
  requestAnimationFrame(() => { list.scrollTop = draft.scroll ?? list.scrollHeight; });
  list.addEventListener("scroll", () => {
    draft.scroll = list.scrollHeight - list.clientHeight - list.scrollTop > 8 ? list.scrollTop : undefined;
  });
  if (["done", "cancelled"].includes(task.status)) {
    if (latestReply) header.append(element("span", latestReply.model, "muted"));
    header.append(context);
    return area;
  }

  const composer = element("form", undefined, "chat-composer");
  const input = element("textarea");
  input.id = "task-chat-input";
  input.rows = 3;
  input.value = draft.text;
  input.placeholder = language("Message the agent…", "Написать агенту…");
  input.setAttribute("aria-label", input.placeholder);
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const pendingFiles = element("ul", undefined, "draft-attachments");
  const controls = element("div", undefined, "chat-controls");
  const model = element("select");
  model.setAttribute("aria-label", language("Model", "Модель"));
  model.autofocus = true;
  const effort = element("select");
  effort.setAttribute("aria-label", language("Reasoning effort", "Уровень рассуждения"));
  const options = element("div", undefined, "chat-options");
  const picker = element("div", undefined, "chat-picker");
  picker.popover = "auto";
  picker.append(model, effort);
  const selection = element("button", undefined, "chat-selection");
  selection.type = "button";
  selection.popoverTargetElement = picker;
  const modelLabel = element("span", undefined, "chat-model-label");
  const effortLabel = element("span", undefined, "chat-effort-label");
  selection.append(modelLabel, effortLabel);
  const feedback = element("p", undefined, "chat-status");
  feedback.setAttribute("role", "status");
  const send = element("button", language("Send", "Отправить"), "button primary");
  send.type = "submit";
  const attach = button("", () => fileInput.click(), "quiet chat-icon");
  attach.append(icon("attachment"));
  controlLabelForIcon(attach, language("Attach files", "Прикрепить файлы"));
  const microphone = button("", () => {
    input.focus();
    feedback.textContent = api.isWindows
      ? language("Press Win+H to start Windows voice typing.", "Нажмите Win+H для голосового ввода Windows.")
      : language("Start system dictation while this field is focused.", "Включите системную диктовку, пока фокус в поле ввода.");
    feedback.hidden = false;
  }, "quiet chat-icon");
  microphone.append(icon("microphone"));
  controlLabelForIcon(microphone, language("Voice input", "Голосовой ввод"));
  const reload = button(language("Reload models", "Загрузить модели снова"), () => {
    chatCatalog = undefined;
    return loadModels();
  }, "quiet");
  options.append(context, selection, picker, microphone);
  controls.append(attach, options, send);
  composer.append(pendingFiles, input, fileInput, controls, feedback, reload);
  area.append(composer);

  let models = [];
  let loadError = "";
  function sync() {
    const working = Boolean(draft.pending);
    input.readOnly = draft.pending === "saving";
    attach.disabled = microphone.disabled = input.readOnly;
    model.disabled = effort.disabled = working || !models.length;
    selection.disabled = model.disabled;
    modelLabel.textContent = model.selectedOptions[0]?.textContent ?? "";
    effortLabel.textContent = model.value ? effort.selectedOptions[0]?.textContent ?? "" : "";
    controlLabelForIcon(selection, [modelLabel.textContent, effortLabel.textContent].filter(Boolean).join(" · "));
    send.disabled = working || !model.value || !effort.value || (!draft.text.trim() && !draft.files.length);
    reload.hidden = working || !loadError;
    feedback.textContent = draft.error || loadError;
    feedback.hidden = !feedback.textContent;
    for (const remove of pendingFiles.querySelectorAll("button")) remove.disabled = input.readOnly;
  }

  function renderPendingFiles() {
    pendingFiles.hidden = !draft.files.length;
    pendingFiles.replaceChildren(...draft.files.map((file, index) => {
      const row = element("li", undefined, "chat-attachment");
      row.title = file.name;
      const remove = button("×", () => {
        draft.files.splice(index, 1);
        renderPendingFiles();
        sync();
        input.focus();
      }, "quiet");
      remove.disabled = draft.pending === "saving";
      remove.setAttribute("aria-label", language("Remove ", "Удалить ") + file.name);
      row.append(icon("attachment"), element("span", file.name), remove);
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) showChatPreview(row, URL.createObjectURL(file));
      return row;
    }));
  }

  function setEffort() {
    const selected = models.find(entry => entry.id === model.value);
    if (!selected) return;
    const options = selected.efforts.length ? selected.efforts : [selected.effort];
    effort.replaceChildren(...options.map(value => new Option(reasoningName(value), value)));
    effort.value = options.includes(draft.effort) ? draft.effort : selected.effort;
    if (!effort.value) effort.selectedIndex = 0;
    draft.model = model.value;
    draft.effort = effort.value;
    sync();
  }

  async function loadModels() {
    models = [];
    model.replaceChildren(new Option(language("Loading models…", "Загрузка моделей…"), ""));
    loadError = "";
    sync();
    chatCatalog ??= api.chatModels().catch(error => ({ ok: false, error: { message: error.message } }));
    const result = await chatCatalog;
    if (!area.isConnected) return;
    if (!result.ok || !result.data.length) {
      chatCatalog = undefined;
      loadError = result.ok ? language("No models available.", "Нет доступных моделей.") : boardError(result.error);
      model.replaceChildren(new Option(language("Model unavailable", "Модель недоступна"), ""));
      sync();
      return;
    }
    models = result.data;
    model.replaceChildren(...models.map(entry => new Option(entry.name, entry.id)));
    model.value = models.find(entry => entry.id === draft.model)?.id ??
      (models.find(entry => entry.default) ?? models[0]).id;
    setEffort();
  }

  function addFiles(newFiles) {
    if (draft.pending === "saving" || !newFiles.length) return;
    const total = task.attachments.reduce((sum, file) => sum + file.bytes, 0) +
      [...draft.files, ...newFiles].reduce((sum, file) => sum + file.size, 0);
    if (total > 64 * 1024 * 1024) {
      draft.error = language("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ.");
    } else {
      draft.files.push(...newFiles);
      draft.error = "";
      renderPendingFiles();
    }
    sync();
  }

  async function submit() {
    if (send.disabled) return;
    draft.pending = "saving";
    draft.commentary = [];
    draft.error = "";
    draft.scroll = undefined;
    sync();
    renderChatTurn(list, draft);
    try {
      const files = await Promise.all(draft.files.map(async file => ({
        name: file.name, type: file.type, bytes: await file.arrayBuffer(),
      })));
      if (!area.isConnected || frame.project !== project) return;
      const { saved, result } = await api.chatSend(task.id, {
        model: draft.model, effort: draft.effort, text: draft.text, files,
      });
      if (saved && draft.pending === "saving") {
        draft.text = "";
        draft.files = [];
      }
      if (!result.ok) draft.error = boardError(result.error);
    } catch (error) {
      draft.error = error.message;
    } finally {
      draft.pending = undefined;
      draft.commentary = [];
      if (frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
    }
  }

  input.addEventListener("input", () => { draft.text = input.value; sync(); });
  input.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  input.addEventListener("paste", event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    addFiles(files);
  });
  fileInput.addEventListener("change", () => { addFiles(Array.from(fileInput.files)); fileInput.value = ""; });
  model.addEventListener("change", () => { draft.effort = undefined; setEffort(); });
  effort.addEventListener("change", () => { draft.effort = effort.value; sync(); });
  composer.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  renderPendingFiles();
  void loadModels();
  return area;
}

function controlLabelForIcon(control, label) {
  control.title = label;
  control.setAttribute("aria-label", label);
}
