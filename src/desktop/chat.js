const chatDrafts = new Map();
let chatCatalog;
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
  turn.replaceChildren(...(draft.commentary ?? []).map(text => chatText(text, { taskId: taskInSheet?.id, agent: true })));
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

function boardWaitStatus(item) {
  if (item?.status !== "inProgress" || item.type !== "mcpToolCall" || item.title !== "ai_taskboard / task_wait") return;
  return language("Waiting for a board update…", "Жду обновления на доске…");
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

const taskChangeLabels = {
  create: ["Draft created", "Черновик создан"], update: ["Task updated", "Задача обновлена"],
  comment: ["Comment added", "Комментарий добавлен"], cancel: ["Task cancelled", "Задача отменена"],
  block: ["Task blocked", "Задача заблокирована"], unblock: ["Task unblocked", "Задача разблокирована"],
  start: ["Task started", "Задача запущена"], approve: ["Task approved", "Задача утверждена"],
  accept: ["Task accepted", "Задача принята"], request_changes: ["Changes requested", "Задача возвращена на доработку"],
  milestone: ["Milestone updated", "Веха обновлена"],
};
const visibleTaskActions = new Set(["comment", "approve", "start", "block", "unblock", "request_changes", "accept", "cancel"]);

function reviewerFindings(text, taskId) {
  const body = chatText(text, { taskId, coordination: true });
  const prefix = /^(?:\[(P\d+)\][ \t]*)?(?:((?:Критерий|Criterion)\s+\d+(?:\.\d+)*)[ \t]*[:—–][ \t]*)?/iu;
  let finding;
  for (const paragraph of [...body.children]) {
    const first = paragraph.firstChild;
    const match = paragraph.localName === "p" && first?.nodeType === Node.TEXT_NODE && prefix.exec(first.textContent);
    if (match?.[0]) {
      const [, priority, criterion] = match;
      finding = element("section", undefined, "chat-review-finding");
      const heading = element("div", undefined, "chat-review-finding-heading");
      if (criterion) heading.append(element("strong", criterion));
      if (priority) heading.append(element("span", priority, "chat-review-priority"));
      finding.append(heading);
      paragraph.before(finding);
      first.textContent = first.textContent.slice(match[0].length);
      if (!paragraph.textContent.trim() && !paragraph.children.length) {
        paragraph.remove();
        continue;
      }
    }
    finding?.append(paragraph);
  }
  return body;
}

function renderRunActivity(container, items, completed = false, durationMs, taskId, context) {
  const messageContext = { ...(context ?? { taskId: taskId ?? taskInSheet?.id }), agent: true };
  const previous = new Map([...container.querySelectorAll("details")].map(entry => [entry.dataset.item, entry.open]));
  const previousImages = new Map([...container.querySelectorAll(".chat-run-item")].map(entry =>
    [entry.dataset.item, entry.querySelector(".chat-run-images")?.querySelector("button")]));
  const focusedImage = [...previousImages.values()].find(tile => tile?.contains(document.activeElement));
  const focused = container.contains(document.activeElement) ? document.activeElement.closest("details")?.dataset.item : undefined;
  const focusedTask = focused && document.activeElement.matches(".board-chat-task") ? document.activeElement.dataset.task : undefined;
  const focusedMessage = container.contains(document.activeElement) ?
    document.activeElement.closest("[data-coordination-key]")?.dataset.coordinationKey : undefined;
  const copySelector = ".chat-code-copy, .chat-digest";
  const copyButton = document.activeElement.matches(copySelector) && container.contains(document.activeElement)
    ? document.activeElement : null;
  const copyItem = copyButton?.closest("[data-item]");
  const copyIndex = copyItem ? [...copyItem.querySelectorAll(copySelector)].indexOf(copyButton) : -1;
  const nodes = [];
  const seen = new Set(context?.seenMessages);
  const nodeActivities = new Map();
  const taskEventRows = new Set();
  const images = taskId ? items.map(runImageFile).filter(Boolean) : [];
  const finalItems = new Set();
  if (completed) {
    const boundary = items.findLastIndex(item => item.userMessage);
    const finalSegment = boundary === -1 ? items : items.slice(boundary + 1);
    for (const item of finalSegment) {
      if (item.type === "agentMessage" && item.phase === "final_answer" && item.text.trim()) finalItems.add(item);
    }
    // Older logs have no phase. Their last completed message is the final reply.
    if (!finalItems.size && !finalSegment.some(item => item.type === "agentMessage" && item.phase)) {
      const last = finalSegment.findLast(item => item.type === "agentMessage" && item.status === "completed" && item.text.trim());
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
    nodeActivities.set(detail, [item]);
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
    const taskChanges = item.taskChanges ?? [];
    const changeLabel = taskChangeLabels[taskChanges[0]?.action];
    const summaryLabel = taskChanges.length > 1 && taskChanges[0].action === "start" ? language("Tasks started", "Задачи запущены") :
      changeLabel ? language(...changeLabel) : approvalLabel ? language(...approvalLabel) : label;
    const taskPreview = taskChanges.map(({ id }) => id).join(", ");
    activitySummary(detail, summaryLabel, taskPreview || preview, kind, state);
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
    if (taskChanges.length) {
      const links = element("div", undefined, "chat-run-task-links");
      for (const { id, title } of taskChanges) {
        const open = button(id + (title ? " · " + title : ""), () => showTask(id), "quiet board-chat-task");
        open.dataset.task = id;
        links.append(open);
      }
      detail.append(links);
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
      nodeActivities.set(group, operations);
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
    if (item.type === "reasoning" && !item.text.trim()) continue;
    if (item.userMessage && context?.userMessage) {
      flush();
      const entry = context.userMessage(item.userMessage);
      entry.dataset.item = "user:" + item.id;
      nodes.push(entry);
      continue;
    }
    if (item.messages?.length) {
      for (const message of item.messages) {
        const key = message.id + "/" + message.sequence;
        if (seen.has(key)) continue;
        seen.add(key);
        flush();
        const entry = element("div", undefined, "chat-entry chat-coordination");
        entry.dataset.actor = message.actor;
        entry.dataset.coordinationKey = key;
        entry.dataset.item = "coordination:" + key;
        const returned = message.actor === "reviewer" && message.kind === "request-changes";
        const direction = message.actor === "manager" ? language("Manager → Executor", "Менеджер → Исполнитель") :
          message.actor === "reviewer" ? (returned ? language("Reviewer → Manager", "Ревьюер → Менеджер") :
            language("Reviewer → Manager · Approved", "Ревьюер → Менеджер · Согласовано")) :
          language("Executor → Manager", "Исполнитель → Менеджер");
        const heading = element("div", undefined, "chat-coordination-header");
        heading.append(element("span", direction), button(message.id, () => showTask(message.id), "quiet board-chat-task"));
        if (returned) heading.append(element("span", language("Changes requested", "Возврат на доработку"), "chat-review-status"));
        entry.append(heading, returned ? reviewerFindings(message.text, message.id) :
          chatText(message.text, { taskId: message.id, coordination: true }));
        nodes.push(entry);
      }
    }
    if (item.messagesOnly) continue;
    const showTaskEvent = item.taskChanges?.some(({ action }) => visibleTaskActions.has(action));
    const reason = item.taskChanges?.[0]?.reason;
    if (["agentMessage", "plan", "truncated", "error", "reasoning"].includes(item.type)) {
      flush();
      if (item.type === "agentMessage" || item.type === "plan") {
        const message = chatText(item.text, messageContext);
        const entry = context?.dialogue && item.type === "agentMessage" && item.text.trim()
          ? element("div", undefined, "board-manager-message") : message;
        if (entry !== message) entry.append(message);
        entry.dataset.item = "message:" + item.id;
        nodes.push(entry);
      }
      else if (item.type === "reasoning") nodes.push(operation(item));
      else nodes.push(element("p", item.type === "error" ? item.text : language("Earlier activity exceeded the log limit.", "Ранние события не поместились в журнал."), item.type === "error" ? "chat-run-error" : "muted"));
    } else if (showTaskEvent || reason) {
      flush();
      const row = operation(item);
      nodes.push(row);
      if (showTaskEvent) taskEventRows.add(row);
      if (reason) {
        const note = element("p", reason, "chat-text");
        note.dataset.item = "reason:" + item.id;
        nodes.push(note);
        if (showTaskEvent) taskEventRows.add(note);
      }
    } else operations.push(item);
  }
  flush();
  const boundaryKey = node => node.dataset.coordinationKey ||
    (node.dataset.actor === "user" || taskEventRows.has(node) ? node.dataset.item : undefined);
  const hasBoundaries = nodes.some(boundaryKey);
  function foldWork(batch, key, label) {
    const work = element("details", undefined, "chat-work");
    work.dataset.item = key;
    const first = batch.find(node => node.dataset.item)?.dataset.item;
    if (first) work.dataset.chatAnchor = "work:" + first;
    work.open = previous.get(key) ?? false;
    activitySummary(work, label, "", "reasoning", activityState(
      hasBoundaries ? batch.flatMap(node => nodeActivities.get(node) ?? []) : items));
    const chronology = element("div", undefined, "chat-run-body");
    chronology.append(...batch);
    work.append(chronology);
    return work;
  }
  if (completed && nodes.length) {
    let label = language("Completed", "Выполнено");
    if (Number.isSafeInteger(durationMs) && durationMs >= 0) {
      const seconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(seconds / 60);
      label = language("Completed in ", "Выполнено за ") +
        (minutes ? minutes + language("m ", " мин ") : "") + seconds % 60 + language("s", " с");
    }
    let batch = [];
    let key = "work";
    for (const node of nodes.splice(0)) {
      const boundary = boundaryKey(node);
      if (boundary) {
        if (batch.length) nodes.push(foldWork(batch, key, label));
        batch = [];
        key = "work:" + boundary;
        label = language("Work details", "Ход работы");
        nodes.push(node);
      } else batch.push(node);
    }
    if (batch.length) nodes.push(foldWork(batch, key, label));
  }
  for (const item of finalItems) {
    const final = element("div", undefined, "chat-run-final");
    final.dataset.item = "final:" + item.id;
    if (context?.dialogue) {
      final.classList.add("board-manager-message");
      final.dataset.messageId = item.id;
    }
    final.append(chatText(item.text, messageContext));
    nodes.push(final);
  }
  const reportCounts = new Map();
  for (const node of nodes) {
    for (const detail of node.querySelectorAll(".chat-report-details")) {
      const key = detail.parentElement.closest("[data-item]")?.dataset.item;
      if (!key) continue;
      const index = reportCounts.get(key) ?? 0;
      reportCounts.set(key, index + 1);
      detail.dataset.item = "report:" + key + ":" + index;
      detail.open = previous.get(detail.dataset.item) ?? false;
    }
  }
  container.replaceChildren(...nodes);
  container.hidden = nodes.length === 0;
  if (copyItem) {
    [...container.querySelectorAll("[data-item]")].find(node => node.dataset.item === copyItem.dataset.item)
      ?.querySelectorAll(copySelector)[copyIndex]?.focus({ preventScroll: true });
  } else if (focusedMessage && !focused) {
    nodes.find(node => node.dataset.coordinationKey === focusedMessage)
      ?.querySelector("button")?.focus({ preventScroll: true });
  } else if (focusedImage && container.contains(focusedImage)) focusedImage.focus({ preventScroll: true });
  else if (focused) {
    const detail = [...container.querySelectorAll("details")].find(entry => entry.dataset.item === focused);
    const taskLink = focusedTask && [...(detail?.querySelectorAll(".board-chat-task") ?? [])].find(link => link.dataset.task === focusedTask);
    (taskLink || detail?.querySelector("summary"))?.focus({ preventScroll: true });
  }
}

function updateChat({ project, id, type, text, items, goal, goalRunning, error, question, managerRun, managerWork }) {
  if (type === "orchestrator-question") {
    if (frame.project === project) {
      frame.managerQuestion = question;
      byId("board-composer").firstChild?.updateQuestion(question);
    }
    return;
  }
  if (type.startsWith("orchestrator")) {
    const composer = frame.project === project ? byId("board-composer").firstChild : boardViews.get(project)?.composer[0];
    if (type === "orchestrator") composer?.updateActivity?.(items);
    else if (type === "orchestrator-run") {
      if (managerRun !== undefined) {
        if (frame.project === project) frame.managerRun = managerRun;
        composer?.updateManagerRun(managerRun);
      }
      if (managerWork !== undefined) {
        if (frame.project === project) frame.managerWork = managerWork;
        composer?.updateManagerWork(managerWork);
      }
      if (frame.project === project) renderActiveAgents();
    }
    else if (type === "orchestrator-work-activity") composer?.refreshWork?.();
    else if (type === "orchestrator-work-history") composer?.invalidateWork?.();
    else if (type === "orchestrator-work-accepted") composer?.acceptWork?.(id);
    else if (type === "orchestrator-goal") composer?.updateGoal?.(goal, goalRunning);
    else if (type === "orchestrator-review-error") composer?.reviewError?.(error);
    else if (type === "orchestrator-ready") composer?.enableStop?.();
    else if (type === "orchestrator-waiting" || type === "orchestrator-sending") composer?.setWaiting?.(type === "orchestrator-waiting");
    else composer?.invalidateHistory?.();
    return;
  }
  const open = frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === id;
  if (type === "reviewer-chat") {
    if (frame.project === project) byId("board-composer").firstChild?.refreshWork();
    if (open) byId("task-reviewer-chat")?.refresh();
    return;
  }
  if (type === "run" && frame.project === project) {
    (frame.runActivity ??= {})[id] = items;
    byId("board-composer").firstChild?.updateManagerWork();
    const list = open && body.querySelector(".task-chat .chat-log");
    if (list) {
      const atBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 8;
      renderRunActivity(list.querySelector(".chat-run-live"), items, false, undefined, id);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }
    return;
  }
  const draft = chatDrafts.get(project + "\0" + id);
  if (type === "saved") {
    if (draft?.saving) {
      draft.text = "";
      draft.files = [];
      draft.saving = undefined;
      draft.pending = "replying";
    }
    if (open) void protect(() => showTask(id))();
  } else if (type === "changed") {
    if (open) void protect(() => showTask(id))();
  } else if (type === "commentary" && draft?.pending) {
    (draft.commentary ??= []).push(text);
    const list = open && body.querySelector(".task-chat .chat-log");
    if (list) renderChatTurn(list, draft);
  }
}

function legacyTokenUsageFailure(reason) {
  if (reason?.startsWith("Could not save task token usage:")) {
    return language("The previous run was interrupted while saving token statistics.",
      "Предыдущий запуск прервался при записи статистики токенов.");
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
    "review-note": ["Left on review", "Оставил на проверке"],
    "review-approve": ["Approved the submission", "Согласовал сдачу"],
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

function reviewerChat(task, open) {
  const project = frame.project;
  const legacy = task.history.filter(event => event.actor === "reviewer" && event.text &&
    ["review-note", "review-approve", "request-changes"].includes(event.action));
  const details = taskDetails("task-reviewer-chat", language("Reviewer chat", "Чат ревьюера"), "", open);
  const content = element("div", undefined, "task-details-content");
  const status = element("p", undefined, "muted");
  status.setAttribute("role", "status");
  const log = element("ol", undefined, "chat-log");
  log.setAttribute("aria-label", language("Reviewer messages", "Сообщения ревьюера"));
  log.tabIndex = 0;
  log.hidden = true;
  content.append(status, log);
  details.append(content);
  const nodes = new Map();
  let timer;
  let generation = 0;
  const refresh = () => {
    if (!details.open || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (details.isConnected && details.open) void load();
    }, 200);
  };
  details.refresh = refresh;
  details.addEventListener("toggle", refresh);

  async function load() {
    const request = ++generation;
    if (log.hidden) status.textContent = language("Loading…", "Загружаю…");
    try {
      const result = await api.reviewerChat(task.id);
      if (!details.isConnected || project !== frame.project || request !== generation) return;
      if (!result.ok) throw new Error(boardError(result.error));
      const { scrollHeight, clientHeight, scrollTop } = log;
      const attempts = result.data;
      for (const [id, node] of nodes) {
        if (attempts.some(attempt => attempt.id === id)) continue;
        node.entry.remove();
        nodes.delete(id);
      }
      for (const attempt of attempts) {
        let node = nodes.get(attempt.id);
        if (!node) {
          const entry = element("li", undefined, "chat-entry");
          const label = element("span", undefined, "chat-author");
          const activity = element("div", undefined, "chat-run");
          const error = element("p", undefined, "muted");
          entry.append(label, activity, error);
          log.append(entry);
          node = { entry, label, activity, error };
          nodes.set(attempt.id, node);
        }
        if (node.finished) continue;
        node.finished = attempt.durationMs !== undefined;
        node.label.textContent = shortDate(attempt.at) + " · " + (node.finished ?
          language("Reviewer", "Ревьюер") : language("Reviewing", "Ревьюер проверяет"));
        node.error.textContent = attempt.error ?? "";
        node.error.hidden = !attempt.error;
        const items = attempt.items.flatMap(item => {
          if (item.type !== "agentMessage" || item.phase === "commentary") return [item];
          if (item.status !== "completed") return [];
          try {
            const { summary, findings, evidence } = JSON.parse(item.text);
            if (typeof summary !== "string") return [item];
            const notes = Array.isArray(findings) ? findings.map(text => "- " + text).join("\n") : "";
            const checks = Array.isArray(evidence) ? evidence.flatMap((text, index) =>
              typeof text === "string" ? [(index + 1) + ". " + text] : []).join("\n") : "";
            return [{ ...item, text: [summary, notes, checks].filter(Boolean).join("\n\n") }];
          } catch { return [item]; }
        });
        renderRunActivity(node.activity, items, node.finished, attempt.durationMs, undefined, { taskId: task.id });
      }
      if (!attempts.length && legacy.length && !log.childElementCount) {
        for (const event of legacy) {
          const entry = element("li", undefined, "chat-entry");
          entry.append(element("span", shortDate(event.at), "chat-author"),
            event.action === "request-changes" ? reviewerFindings(event.text, task.id) :
              chatText(event.text, { taskId: task.id, agent: true }));
          log.append(entry);
        }
      }
      if (attempts.length) {
        for (const entry of [...log.children]) {
          if (!entry.querySelector(".chat-run")) entry.remove();
        }
      }
      log.hidden = !log.childElementCount;
      status.textContent = log.hidden ? language("No reviewer messages yet.", "Сообщений ревьюера пока нет.") :
        attempts.length ? "" : language("Saved review decisions", "Сохранённые решения по проверке");
      status.hidden = !status.textContent;
      if (scrollHeight - clientHeight - scrollTop <= 8) log.scrollTop = log.scrollHeight;
    } catch (error) {
      if (!details.isConnected || request !== generation) return;
      status.hidden = false;
      status.textContent = language("Could not load reviewer chat. ", "Не удалось загрузить чат ревьюера. ") + error.message;
    }
  }
  return details;
}

function taskChat(task) {
  const project = frame.project;
  const key = project + "\0" + task.id;
  const latestReply = task.history.findLast(event => event.chat && event.actor === "agent")?.chat;
  let draft = chatDrafts.get(key);
  if (!draft) {
    draft = { text: "", files: [] };
    chatDrafts.set(key, draft);
  }
  const area = element("section", undefined, "task-chat");
  const heading = element("h3", language("Agent chat", "Чат с агентом"));
  heading.id = "task-chat-heading";
  area.setAttribute("aria-labelledby", heading.id);
  const header = element("div", undefined, "chat-header");
  header.append(heading);
  area.append(header);
  const list = element("ol", undefined, "chat-log");
  list.setAttribute("aria-label", language("Messages", "Сообщения"));
  list.tabIndex = 0;
  const files = new Map(task.attachments.map(file => [file.file, file]));
  const events = task.history.map((event, index) => ({ event, index }));
  if (task.questions.length) events.splice(1, 0, {
    event: { at: task.createdAt, actor: "agent", action: "questions", text: task.questions.join("\n\n") },
  });
  const missingRuns = new Map();
  const locale = frame.russian ? "ru" : undefined;
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  let day;
  let lastMessage;
  for (const { event, index } of events) {
    if (event.chat) lastMessage = event;
    const timestamp = new Date(event.at);
    const eventDay = Number.isNaN(+timestamp) ? "" : dayFormat.format(timestamp);
    if (eventDay && eventDay !== day) {
      day = eventDay;
      const divider = element("li", undefined, "chat-day");
      divider.append(element("span", day));
      list.append(divider);
    }
    if (event.action === "run-log") {
      const log = element("li", undefined, "chat-run");
      if (event.run?.length) {
        renderRunActivity(log, event.run, true, event.durationMs, task.id);
        list.append(log);
      } else if (task.codexThreadId && event.durationMs !== undefined) {
        log.hidden = true;
        list.append(log);
        missingRuns.set(index, { log, durationMs: event.durationMs });
      }
      continue;
    }
    if (event.chat?.commentary?.length) {
      const commentary = element("li", undefined, "chat-run");
      renderRunActivity(commentary, event.chat.commentary.map((text, index) => ({
        id: String(index), type: "agentMessage", phase: "commentary", title: "", text, status: "completed",
      })), true, event.durationMs);
      list.append(commentary);
    }
    const conversation = ["chat", "comment", "questions", "coordination"].includes(event.action);
    const attachments = chatEventAttachments(event, files);
    const author = event.actor === "manager" ? language("Project manager", "Менеджер проекта") :
      event.actor === "reviewer" ? language("Reviewer", "Ревьюер") :
      event.actor === "user" ? language("You", "Вы") : language("Agent", "Агент");
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
    const returned = event.actor === "reviewer" && event.action === "request-changes";
    const coordination = returned || event.action === "coordination" || (event.actor === "manager" && event.text);
    if (coordination) entry.classList.add("chat-coordination");
    const label = event.action === "coordination" && event.actor === "agent" ? language("Executor", "Исполнитель") : author;
    entry.append(element("span", label, "chat-author"));
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
    if (event.text && !(event.action === "attach" && attachments.length)) {
      const text = event.action === "block" ? legacyTokenUsageFailure(event.text) ?? event.text : event.text;
      entry.append(returned ? reviewerFindings(text, task.id) :
        chatText(text, { taskId: task.id, coordination, agent: event.action === "chat" && event.actor === "agent" }));
    }
    entry.append(conversation ? date : date.cloneNode(true));
    list.append(entry);
  }
  if (missingRuns.size) {
    const status = element("span", undefined, "muted");
    status.setAttribute("role", "status");
    const load = button(language("Load Codex activity", "Загрузить ход работы из Codex"), async () => {
      load.disabled = true;
      status.textContent = language("Loading…", "Загружаю…");
      try {
        const result = await api.taskRunHistory(task.id);
        if (!area.isConnected || frame.project !== project) return;
        if (!result.ok) throw new Error(boardError(result.error));
        let restored = 0;
        let lastRestored;
        for (const [index, { log, durationMs }] of missingRuns) {
          const items = result.data[index];
          if (!items?.length) continue;
          renderRunActivity(log, items, true, durationMs, undefined, { taskId: task.id });
          if (!log.hidden) {
            restored++;
            lastRestored = log;
          }
        }
        if (restored) load.remove();
        status.textContent = restored === missingRuns.size ? "" : restored
          ? language("Some runs are unavailable in the saved Codex chat.", "Часть запусков недоступна в сохранённом чате Codex.")
          : language("No activity for these runs in the saved Codex chat.", "В сохранённом чате Codex нет данных об этих запусках.");
        if (lastRestored) {
          lastRestored.querySelector(".chat-work > summary")?.focus({ preventScroll: true });
          lastRestored.scrollIntoView({ block: "nearest" });
        }
      } catch (error) {
        status.textContent = language("Could not load the Codex activity. ", "Не удалось загрузить ход работы из Codex. ") + error.message;
      } finally {
        load.disabled = false;
      }
    }, "quiet");
    header.append(load, status);
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
  const feedback = element("p", undefined, "chat-status");
  feedback.setAttribute("role", "status");
  const send = element("button", undefined, "button primary chat-icon chat-send");
  send.type = "submit";
  const attach = button("", () => fileInput.click(), "quiet chat-icon chat-add");
  attach.append(icon("add"));
  controlLabelForIcon(attach, language("Attach files", "Прикрепить файлы"));
  const microphone = button("", () => {
    input.focus();
    feedback.textContent = api.isWindows
      ? language("Press Win+H to start Windows voice typing.", "Нажмите Win+H для голосового ввода Windows.")
      : language("Start system dictation while this field is focused.", "Включите системную диктовку, пока фокус в поле ввода.");
    feedback.hidden = false;
  }, "quiet chat-icon chat-mic");
  microphone.append(icon("mic"));
  controlLabelForIcon(microphone, language("Voice input", "Голосовой ввод"));
  controls.append(attach, microphone, send);
  composer.append(pendingFiles, input, fileInput, controls, feedback);
  area.append(composer);

  function working() { return Boolean(draft.pending || frame.runningTasks?.includes(task.id)); }
  function stopping() { return working() && !draft.text.trim() && !draft.files.length; }
  function sync() {
    input.readOnly = Boolean(draft.saving);
    attach.disabled = microphone.disabled = input.readOnly;
    const stop = stopping();
    send.replaceChildren(icon(stop ? "stop" : "play"));
    controlLabelForIcon(send, stop ? language("Stop agent", "Остановить агента") : language("Send message", "Отправить сообщение"));
    send.disabled = Boolean(draft.saving || draft.stopping) || (!stop && !draft.text.trim() && !draft.files.length);
    feedback.textContent = draft.error ?? "";
    feedback.hidden = !feedback.textContent;
    for (const remove of pendingFiles.querySelectorAll("button")) remove.disabled = input.readOnly;
  }

  area.syncAgentState = sync;

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
      remove.disabled = Boolean(draft.saving);
      remove.setAttribute("aria-label", language("Remove ", "Удалить ") + file.name);
      row.append(icon("attachment"), element("span", file.name), remove);
      if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) showChatPreview(row, URL.createObjectURL(file));
      return row;
    }));
  }

  async function discussionSettings() {
    const configured = task.execution ?? frame.board?.settings?.executor;
    if (configured?.effort) return configured;
    if (chatCatalog?.project !== project) {
      chatCatalog = { project, request: api.chatModels() };
    }
    const catalog = chatCatalog;
    try {
      const result = await catalog.request;
      if (!result.ok) throw new Error(boardError(result.error));
      const model = configured ? result.data.find(entry => entry.id === configured.model) :
        (result.data.find(entry => entry.default) ?? result.data[0]);
      if (configured && !model) throw new Error(language("The task model is unavailable.", "Модель задачи недоступна."));
      if (!model?.id || !model.effort) throw new Error(language("No models available.", "Нет доступных моделей."));
      return { model: model.id, effort: model.effort };
    } catch (error) {
      if (chatCatalog === catalog) chatCatalog = undefined;
      throw error;
    }
  }

  function addFiles(newFiles) {
    if (draft.saving || !newFiles.length) return;
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
    if (stopping()) {
      draft.stopping = true;
      draft.error = "";
      sync();
      try {
        const result = await api.chatStop(task.id);
        if (!result.ok) draft.error = boardError(result.error);
      } catch (error) { draft.error = error.message; }
      finally {
        draft.stopping = false;
        sync();
        if (frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
      }
      return;
    }
    const submission = {};
    (draft.requests ??= new Set()).add(submission);
    draft.saving = submission;
    draft.pending ??= "saving";
    draft.commentary ??= [];
    draft.error = "";
    draft.scroll = undefined;
    const text = draft.text;
    sync();
    renderChatTurn(list, draft);
    try {
      const { model, effort } = await discussionSettings();
      const files = await Promise.all(draft.files.map(async file => ({
        name: file.name, type: file.type, bytes: await file.arrayBuffer(),
      })));
      if (!area.isConnected || frame.project !== project) return;
      const { saved, result } = await api.chatSend(task.id, {
        model, effort, text, files,
      });
      if (saved && draft.saving === submission) {
        draft.text = "";
        draft.files = [];
      }
      if (!result.ok) draft.error = boardError(result.error);
    } catch (error) {
      draft.error = error.message;
    } finally {
      draft.requests.delete(submission);
      if (draft.saving === submission) draft.saving = undefined;
      if (!draft.requests.size) {
        draft.pending = undefined;
        draft.commentary = [];
      }
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
  composer.addEventListener("submit", event => { event.preventDefault(); void submit(); });
  renderPendingFiles();
  sync();
  return area;
}

function controlLabelForIcon(control, label) {
  control.title = label;
  control.setAttribute("aria-label", label);
}
