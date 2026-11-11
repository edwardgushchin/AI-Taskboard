const chatDrafts = new Map();
let chatCatalog;

function chatEventLabel(action) {
  const labels = {
    create: ["Created the task", "Создал задачу"], update: ["Updated the task", "Обновил задачу"],
    approve: ["Approved the task", "Утвердил задачу"], start: ["Started work", "Начал работу"],
    progress: ["Updated progress", "Обновил ход работы"], block: ["Blocked the task", "Заблокировал задачу"],
    resume: ["Resumed work", "Продолжил работу"], submit: ["Submitted for review", "Сдал на проверку"],
    accept: ["Accepted the task", "Принял задачу"], cancel: ["Cancelled the task", "Отменил задачу"],
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

function taskChat(task) {
  const project = frame.project;
  const key = project + "\0" + task.id;
  const lastChatIndex = task.history.findLastIndex(event => event.chat);
  const last = task.history[lastChatIndex];
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
  for (const event of events) {
    const conversation = ["chat", "comment", "questions"].includes(event.action);
    const entry = element("li", undefined, "chat-entry");
    entry.dataset.actor = event.actor;
    entry.classList.toggle("chat-event", !conversation);
    const meta = element("div", undefined, "chat-meta");
    const author = event.actor === "user" ? language("You", "Вы") : language("Agent", "Агент");
    const date = element("time", shortDate(event.at));
    date.dateTime = event.at;
    meta.append(element("strong", author), date);
    entry.append(meta);
    if (!conversation) {
      const status = lanes.find(([code]) => code === event.to);
      entry.append(element("p", chatEventLabel(event.action) + (status ? " · " + language(status[1], status[2]) : ""), "chat-action"));
    }
    if (event.text) entry.append(element("p", event.text, "chat-text"));
    for (const id of event.chat?.files ?? []) {
      const file = files.get(id);
      if (file) entry.append(taskAttachmentButton(task.id, file, "quiet"));
    }
    list.append(entry);
  }
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
  const retry = button(language("Retry reply", "Повторить ответ"), () => submit(lastChatIndex), "quiet");
  const reload = button(language("Reload models", "Загрузить модели снова"), () => {
    chatCatalog = undefined;
    return loadModels();
  }, "quiet");
  options.append(context, selection, picker, microphone);
  controls.append(attach, options, send);
  composer.append(input, fileInput, pendingFiles, controls, feedback, retry, reload);
  area.append(composer);

  let models = [];
  let loadError = "";
  function sync() {
    const working = Boolean(draft.pending);
    input.readOnly = working;
    attach.disabled = microphone.disabled = working;
    model.disabled = effort.disabled = working || !models.length;
    selection.disabled = model.disabled;
    modelLabel.textContent = model.selectedOptions[0]?.textContent ?? "";
    effortLabel.textContent = model.value ? effort.selectedOptions[0]?.textContent ?? "" : "";
    controlLabelForIcon(selection, [modelLabel.textContent, effortLabel.textContent].filter(Boolean).join(" · "));
    send.disabled = working || !model.value || !effort.value || (!draft.text.trim() && !draft.files.length);
    retry.hidden = !last?.chat || last.actor !== "user" || working;
    retry.disabled = !model.value || !effort.value;
    reload.hidden = working || !loadError;
    feedback.textContent = working ? language("Codex is replying…", "Codex отвечает…") : draft.error || loadError;
    feedback.hidden = !feedback.textContent;
    pendingFiles.hidden = !draft.files.length;
    pendingFiles.replaceChildren(...draft.files.map((file, index) => {
      const row = element("li");
      const remove = button("×", () => { draft.files.splice(index, 1); sync(); input.focus(); }, "quiet");
      remove.disabled = working;
      remove.setAttribute("aria-label", language("Remove ", "Удалить ") + file.name);
      row.append(icon("attachment"), element("span", file.name), remove);
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
    if (draft.pending || !newFiles.length) return;
    const total = task.attachments.reduce((sum, file) => sum + file.bytes, 0) +
      [...draft.files, ...newFiles].reduce((sum, file) => sum + file.size, 0);
    if (total > 64 * 1024 * 1024) {
      draft.error = language("Attachments are limited to 64 MiB per task.", "Лимит вложений на задачу — 64 МиБ.");
    } else {
      draft.files.push(...newFiles);
      draft.error = "";
    }
    sync();
  }

  async function submit(retryAt) {
    if (draft.pending || !model.value || !effort.value || (retryAt === undefined && send.disabled)) return;
    draft.pending = true;
    draft.error = "";
    draft.scroll = undefined;
    sync();
    try {
      const files = retryAt === undefined ? await Promise.all(draft.files.map(async file => ({
        name: file.name, type: file.type, bytes: await file.arrayBuffer(),
      }))) : [];
      const { saved, result } = await api.chatSend(task.id, {
        model: draft.model, effort: draft.effort, text: draft.text, files, retryAt,
      });
      if (saved && retryAt === undefined) {
        draft.text = "";
        draft.files = [];
      }
      if (!result.ok) draft.error = boardError(result.error);
    } catch (error) {
      draft.error = error.message;
    } finally {
      draft.pending = false;
      if (frame.project === project && sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
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
  void loadModels();
  return area;
}

function controlLabelForIcon(control, label) {
  control.title = label;
  control.setAttribute("aria-label", label);
}
