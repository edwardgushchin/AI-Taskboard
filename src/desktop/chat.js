function appendChatTime(entry, at) {
  if (typeof at !== "string" || !at.trim()) return;
  const value = new Date(at);
  if (Number.isNaN(+value)) return;
  const locale = localization.locale;
  const time = element("time", () => new Intl.DateTimeFormat(localization.locale, {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(value), "chat-time");
  time.dateTime = at;
  bindLocalized(time, "title", () => new Intl.DateTimeFormat(localization.locale, { dateStyle: "full", timeStyle: "long" }).format(value));
  bindLocalized(time, "aria-label", () => new Intl.DateTimeFormat(localization.locale, { dateStyle: "full", timeStyle: "long" }).format(value), true);
  entry.append(time);
  return time;
}

const chatDrafts = new Map();
let chatCatalog;
const chatPreviews = new IntersectionObserver(entries => {
  for (const { isIntersecting, target } of entries) {
    if (!isIntersecting) continue;
    chatPreviews.unobserve(target);
    if (!target.isConnected) continue;
    const { task, file, path, reviewer } = target.dataset;
    const preview = path ? api.runImagePreview(task, path, reviewer === "true") : api.attachmentPreview(task, file);
    void preview.then(src => {
      if (src && target.isConnected) showChatPreview(target, src);
      else if (path && target.isConnected) unavailableRunImage(target);
    }).catch(() => { if (path && target.isConnected) unavailableRunImage(target); });
  }
});

function unavailableRunImage(tile) {
  const label = t("ui.image_unavailable_024abc1d") + tile.querySelector("span").textContent;
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
      controlLabelForIcon(tile, () => t("ui.preview_bb99ff84") + name);
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
  turn.replaceChildren();
  if (!turn.hidden) {
    const thinking = element("p", () => t("ui.thinking_14a886f3"), "chat-thinking");
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
  return t("ui.waiting_for_a_board_update_c5ce9808");
}

function activityCount(count, kind) {
  return t("activity." + kind, { count });
}

function activityState(items) {
  const failed = items.filter(item => ["failed", "declined", "denied", "timedOut", "aborted"].includes(item.status)).length;
  const running = items.filter(item => item.status === "inProgress").length;
  return {
    code: failed ? "failed" : running ? "running" : "completed",
    text: () => [failed ? t("ui.failed_e2d9e6f1") + failed : "", running ? t("ui.running_25f4c99f") + running : ""].filter(Boolean).join(" · "),
  };
}

function activitySummary(detail, label, preview, kind, state) {
  const summary = element("summary");
  const title = element("span", undefined, "chat-run-label");
  title.append(element("span", label));
  const compactText = () => (typeof preview === "function" ? preview() : preview).replace(/\s+/g, " ").trim();
  if (compactText()) title.append(element("span", () => { const compact = compactText(); return " " + compact.slice(0, 180) + (compact.length > 180 ? "…" : ""); }, "chat-run-preview"));
  summary.append(icon(({ command: "terminal", edit: "edit", image: "images", search: "search", reasoning: "thought", tool: "tool" })[kind]), title);
  if (typeof state.text === "function" ? state.text() : state.text) summary.append(element("span", state.text, "chat-run-state"));
  summary.append(icon("chevron"));
  detail.dataset.state = state.code;
  detail.append(summary);
}

const taskChangeLabels = {
  create: ["ui.draft_created_643a6b84"], update: ["ui.task_updated_14ff772e"],
  comment: ["ui.comment_added_2322db33"], cancel: ["ui.task_cancelled_d8ca4852"],
  block: ["ui.task_blocked_2a3a359f"], unblock: ["ui.task_unblocked_9a6c3578"],
  start: ["ui.task_started_888ca190"], approve: ["ui.task_approved_b9a6d14e"],
  accept: ["ui.task_accepted_c7c75e62"], request_changes: ["ui.changes_requested_ef2e2c25"],
  return_to_draft: ["ui.returned_the_task_to_draft_0224ff4e"],
  milestone: ["ui.milestone_updated_02dacc38"],
};
const visibleTaskActions = new Set(["comment", "approve", "start", "block", "unblock", "request_changes", "return_to_draft", "accept", "cancel"]);
const statusNoticeActions = new Set(["approve", "start", "block", "unblock", "submit", "request_changes", "accept", "cancel"]);

function reconcileWorkTransitions(work) {
  const notices = new Map();
  for (const notice of work.querySelectorAll("[data-status-notice]")) {
    const key = notice.dataset.statusNotice;
    if (!notices.has(key)) notices.set(key, []);
    notices.get(key).push(Date.parse(notice.dataset.statusAt));
  }
  for (const result of work.querySelectorAll("[data-status-result]")) {
    const at = Date.parse(result.dataset.statusAt);
    const through = Math.max(at, Date.parse(result.dataset.statusThrough) || at);
    const matches = notices.get(result.dataset.statusResult) ?? [];
    result.hidden = matches.filter(time => time >= at && time <= through).length === 1;
  }
}

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
      command: ["ui.ran_command_e1621f9d"], edit: ["ui.edited_files_78139502"],
      image: ["ui.viewed_image_cbd308a2"], search: ["ui.searched_the_web_6fb3e52c"],
      reasoning: ["ui.reasoning_summary_62e07716"], tool: ["ui.used_tool_d30853ac"],
    };
    const detail = element("details", undefined, "chat-run-item");
    nodeActivities.set(detail, [item]);
    detail.dataset.item = "item:" + item.id;
    detail.open = previous.get(detail.dataset.item) ?? Boolean(context?.reviewer && kind === "reasoning");
    const state = activityState([item]);
    const label = state.code === "running" ? t("ui.in_progress_15929530") :
      state.code === "failed" ? t("ui.action_failed_0dcd9696") :
      item.type === "imageGeneration" ? t("ui.generated_image_07d5dbeb") : t(...labels[kind]);
    // Only shorten the visible preview; the original command remains available below.
    const command = item.type === "commandExecution" ? readableRunCommand(item.title) : item.title;
    const preview = command.replace(/^(?:"[^"\r\n]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)\s+-Command\s+/i, "");
    const approvalLabels = {
      inProgress: ["ui.reviewing_access_b77978b1"],
      approved: ["ui.access_approved_2536d83b"],
      denied: ["ui.access_denied_590c4f9d"],
      timedOut: ["ui.access_review_timed_out_06d1a3f6"],
      aborted: ["ui.access_review_cancelled_225f3019"],
    };
    const approvalLabel = item.type === "autoApprovalReview" && Object.hasOwn(approvalLabels, item.status) ? approvalLabels[item.status] : undefined;
    const taskChanges = item.taskChanges ?? [];
    const noticeChanges = context?.managerWork && statusNoticeActions.has(taskChanges[0]?.action);
    const changeLabel = noticeChanges ? undefined : taskChangeLabels[taskChanges[0]?.action];
    const summaryLabel = !noticeChanges && taskChanges.length > 1 && taskChanges[0].action === "start" ? t("ui.tasks_started_50af3215") :
      changeLabel ? t(...changeLabel) : approvalLabel ? t(...approvalLabel) : label;
    const taskPreview = noticeChanges ? "" : taskChanges.map(({ id }) => id).join(", ");
    activitySummary(detail, summaryLabel, taskPreview || preview, kind, state);
    const image = taskId && runImageFile(item);
    if (image) {
      detail.open = previous.get(detail.dataset.item) ?? true;
      const tiles = element("div", undefined, "chat-attachments chat-run-images");
      let tile = previousImages.get(detail.dataset.item);
      if (!tile || tile.dataset.path !== image.file || tile.dataset.task !== taskId) {
        tile = button("", () => openImagePreview(taskId, tile.imageFiles, tile.imageFiles.findIndex(file => file.file === image.file),
          tile.querySelector("img")?.src, {
            preview: file => api.runImagePreview(taskId, file.file, context?.reviewer),
            save: file => api.saveRunImage(taskId, file.file, context?.reviewer),
          }), "quiet chat-attachment");
        controlLabelForIcon(tile, () => t("ui.view_7aa05de3") + image.name);
        tile.append(icon("images"), element("span", image.name));
        tile.dataset.task = taskId;
        tile.dataset.path = image.file;
        if (context?.reviewer) tile.dataset.reviewer = "true";
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
      if (noticeChanges) appendChatTime(detail, item.at);
    }
    if (command) detail.append(element("pre", command, "chat-run-command"));
    detail.append(element("pre", () => item.text || t("ui.no_output_868de65b"), "chat-run-output"));
    if (command !== item.title) {
      const original = element("details", undefined, "chat-run-original");
      original.dataset.item = "item:" + item.id + "/original";
      original.open = previous.get(original.dataset.item) ?? false;
      original.append(element("summary", () => t("ui.original_command_40a5f550")), element("pre", item.title));
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
      const counts = () => kinds.map(kind => activityCount(operations.filter(item => activityKind(item) === kind).length, kind)).join(" · ");
      const label = () => activityCount(operations.length, "action");
      activitySummary(group, label, () => "· " + counts(), kinds.length === 1 ? kinds[0] : "tool", activityState(operations));
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
    if (item.userMessage?.text?.startsWith("AI Taskboard queue: handle these addressed notices without a goal. [")) continue;
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
        const direction = message.actor === "manager" ? t("ui.manager_executor_31a479f6") :
          message.actor === "reviewer" ? (returned ? t("ui.reviewer_manager_bba0652d") :
            t("ui.reviewer_manager_approved_e196cfdc")) :
          t("ui.executor_manager_f5311347");
        const heading = element("div", undefined, "chat-coordination-header");
        heading.append(element("span", direction), button(message.id, () => showTask(message.id), "quiet board-chat-task"));
        if (returned) heading.append(element("span", () => t("ui.changes_requested_086dd071"), "chat-review-status"));
        entry.append(heading, returned ? reviewerFindings(message.text, message.id) :
          chatText(message.text, { taskId: message.id, coordination: true }));
        appendChatTime(entry, message.at);
        nodes.push(entry);
      }
    }
    if (item.messagesOnly) continue;
    if (context?.managerWork) for (const change of item.taskChanges ?? []) {
      if (!statusNoticeActions.has(change.action)) continue;
      flush();
      const row = element("div", undefined, "chat-entry chat-event");
      row.dataset.item = "status:" + item.id + ":" + change.id;
      row.dataset.statusResult = change.id + "/" + change.status;
      if (item.at) row.dataset.statusAt = item.at;
      if (item.completedAt) row.dataset.statusThrough = item.completedAt;
      const label = taskChangeLabels[change.action];
      row.append(element("span", () => label ? t(...label) : t("status." + change.status)), " ",
        button(change.id, () => showTask(change.id), "quiet board-chat-task"));
      appendChatTime(row, item.at ?? item.completedAt);
      taskEventRows.add(row);
      nodes.push(row);
    }
    const showTaskEvent = item.taskChanges?.some(({ action }) =>
      visibleTaskActions.has(action) && !(context?.managerWork && statusNoticeActions.has(action)));
    if (["agentMessage", "plan", "truncated", "error", "reasoning"].includes(item.type)) {
      flush();
      if (item.type === "agentMessage" || item.type === "plan") {
        const message = chatText(item.text, messageContext);
        const entry = context?.dialogue && item.type === "agentMessage" && item.text.trim()
          ? element("div", undefined, "board-manager-message") : message;
        if (entry !== message) entry.append(message);
        if (item.type === "agentMessage") appendChatTime(entry, item.at);
        entry.dataset.item = "message:" + item.id;
        if (context?.dialogue && item.type === "agentMessage" && item.phase === "final_answer" &&
            item.status === "completed" && item.text.trim()) entry.dataset.messageId = item.id;
        nodes.push(entry);
      }
      else if (item.type === "reasoning") nodes.push(operation(item));
      else nodes.push(element("p", () => item.type === "error" ? item.text : t("ui.earlier_activity_exceeded_the_log_limit_030e2178"), item.type === "error" ? "chat-run-error" : "muted"));
    } else if (showTaskEvent) {
      flush();
      const row = operation(item);
      nodes.push(row);
      taskEventRows.add(row);
    } else operations.push(item);
  }
  flush();
  const boundaryKey = node => node.dataset.messageId || node.dataset.coordinationKey ||
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
    let label = () => {
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) return t("ui.completed_a863c619");
      const seconds = Math.floor(durationMs / 1000), minutes = Math.floor(seconds / 60);
      const unit = (value, name) => new Intl.NumberFormat(localization.locale, {style:"unit",unit:name,unitDisplay:"short"}).format(value);
      return t("ui.completed_in_93ef340c") + (minutes ? unit(minutes, "minute") + " " : "") + unit(seconds % 60, "second");
    };
    let batch = [];
    let key = "work";
    for (const node of nodes.splice(0)) {
      const boundary = boundaryKey(node);
      if (boundary) {
        if (batch.length) nodes.push(foldWork(batch, key, label));
        batch = [];
        key = "work:" + boundary;
        label = () => t("ui.work_details_e9890a2e");
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
    appendChatTime(final, item.at);
    if (context?.managerWork && item.statusTransition && item.at) {
      final.dataset.statusNotice = item.statusTransition.task + "/" + item.statusTransition.status;
      final.dataset.statusAt = item.at;
    }
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

function updateChat({ project, id, type, text, items, savedRun, goal, goalRunning, error, question, managerRun, managerWork, at }) {
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
    else if (type === "orchestrator-queue") composer?.refreshQueue?.();
    else if (type === "orchestrator-work-activity") composer?.refreshWork?.();
    else if (type === "orchestrator-work-history") composer?.invalidateWork?.();
    else if (type === "orchestrator-work-accepted") composer?.acceptWork?.(id);
    else if (type === "orchestrator-goal") composer?.updateGoal?.(goal, goalRunning);
    else if (type === "orchestrator-review-error") composer?.reviewError?.(error, id);
    else if (type === "orchestrator-ready") composer?.enableStop?.();
    else if (type === "orchestrator-message-time") composer?.setMessageTime?.(at);
    else if (type === "orchestrator-waiting" || type === "orchestrator-sending") composer?.setWaiting?.(type === "orchestrator-waiting");
    else composer?.invalidateHistory?.();
    return;
  }
  const open = frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === id;
  if (type === "reviewer-chat") {
    if (frame.project === project) byId("board-composer").firstChild?.refreshWork();
    if (open) byId("task-side").firstElementChild?.refreshReview();
    return;
  }
  if (type === "run" && frame.project === project) {
    (frame.runActivity ??= {})[id] = items;
    byId("board-composer").firstChild?.updateManagerWork();
    if (open) {
      if (savedRun && savedRun.sequence > taskInSheet.history.length) {
        const draft = chatDrafts.get(project + "\0" + id);
        if (draft) draft.savedRun = savedRun;
      }
      byId("task-side").firstElementChild?.updateRun(items);
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
    if (open) byId("task-side").firstElementChild?.updateDiscussion();
  }
}

function legacyTokenUsageFailure(reason) {
  if (reason?.startsWith("Could not save task token usage:")) {
    return t("ui.the_previous_run_was_interrupted_while_saving_to_28925e5b");
  }
}

function chatEventLabel(action) {
  const labels = {
    create: ["ui.created_the_task_834cf85a"], update: ["ui.updated_the_task_c7fa8e4b"],
    approve: ["ui.approved_the_task_52081998"], start: ["ui.started_work_86e3b286"],
    "return-to-draft": ["ui.returned_the_task_to_draft_0224ff4e"],
    progress: ["ui.updated_progress_fde6405d"], block: ["ui.blocked_the_task_c97388fb"],
    checklist: ["ui.updated_progress_fde6405d"],
    pause: ["ui.paused_work_5608a24c"],
    resume: ["ui.resumed_work_8bc90aaa"], submit: ["ui.submitted_for_review_99b989f4"],
    accept: ["ui.accepted_the_task_f6df7973"], cancel: ["ui.cancelled_the_task_07a3cdd4"],
    cover: ["ui.changed_the_card_cover_c445cf83"],
    "request-changes": ["ui.requested_changes_480ce0d7"], attach: ["ui.attached_a_file_f4ead942"],
    "review-note": ["ui.left_on_review_8da49b68"],
    "review-approve": ["ui.approved_the_submission_04c4f1df"],
    "expert-plan": ["experts.plan_event"], "expert-stage": ["experts.stage_event"],
  };
  return Object.hasOwn(labels, action) ? t(...labels[action]) : action;
}

function reasoningName(effort) {
  const labels = {
    none: ["ui.none_643e51f5"], minimal: ["ui.minimal_2a7a811b"], low: ["ui.low_94c1f5ae"], medium: ["ui.medium_7f640a23"],
    high: ["ui.high_0949bbee"], xhigh: ["ui.very_high_bc783636"], max: ["ui.max_b409d5a5"], ultra: ["ui.ultra_b4cfa729"],
  };
  return Object.hasOwn(labels, effort) ? t(...labels[effort]) : effort;
}

function chatEventAttachments(event, files) {
  if (event.action !== "attach") return (event.chat?.files ?? []).map(id => files.get(id)).filter(Boolean);
  if (event.attachment !== undefined) return [files.get(event.attachment)].filter(Boolean);
  // Older attachment events recorded only a filename. Never guess between namesakes.
  const matches = [...files.values()].filter(file => file.name === event.text);
  return matches.length === 1 ? matches : [];
}

function reviewerChat(task, work, tail, decisions, onCollaboration) {
  const project = frame.project;
  const status = element("li", undefined, "muted");
  status.setAttribute("role", "status");
  status.hidden = true;
  work.insertBefore(status, tail);
  const nodes = new Map();
  let timer;
  let generation = 0;
  return () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (work.isConnected) void load();
    }, 200);
  };

  async function load() {
    const request = ++generation;
    try {
      const result = await api.reviewerChat(task.id);
      if (!work.isConnected || project !== frame.project || request !== generation) return;
      if (!result.ok) throw new Error(boardError(result.error));
      const follow = !work.hidden && work.scrollHeight - work.clientHeight - work.scrollTop <= 8;
      const attempts = result.data;
      onCollaboration(attempts.flatMap(attempt => attempt.items.filter(collaborationItem)));
      const ids = new Set(attempts.map(attempt => attempt.id));
      for (const [id, node] of nodes) {
        if (ids.has(id)) continue;
        node.entry.remove();
        nodes.delete(id);
      }
      const history = [...work.children].filter(entry => entry.dataset.historyAt);
      for (const [index, attempt] of attempts.entries()) {
        let node = nodes.get(attempt.id);
        if (!node) {
          const entry = element("li", undefined, "chat-entry task-review-attempt");
          entry.dataset.actor = "reviewer";
          const label = element("span", undefined, "chat-coordination-header");
          const activity = element("div", undefined, "chat-run");
          const error = element("p", undefined, "chat-run-error");
          entry.append(label, activity, error);
          work.insertBefore(entry, history.find(row => row.dataset.historyAt > attempt.at) ?? status);
          node = { entry, label, activity, error };
          nodes.set(attempt.id, node);
        }
        if (node.finished && node.index === index) continue;
        node.index = index;
        node.finished = attempt.durationMs !== undefined;
        bindLocalized(node.label, "textContent", () => t("ui.reviewer_50c42665") + " #" + (index + 1) +
          " · " + t(node.finished ? "ui.completed_a863c619" : "ui.in_progress_15929530") + " · " + shortDate(attempt.at));
        node.error.textContent = attempt.error ?? "";
        node.error.hidden = !attempt.error;
        node.report = undefined;
        const items = attempt.items.flatMap(item => {
          if (collaborationItem(item)) return [];
          if (item.type !== "agentMessage" || item.phase === "commentary") return [item];
          if (item.status !== "completed") return [];
          node.report = undefined;
          try {
            const { summary, findings, evidence } = JSON.parse(item.text);
            if (typeof summary !== "string") return [item];
            const reportFindings = Array.isArray(findings) ? findings.filter(text => typeof text === "string") : [];
            node.report = { summary: summary.trim(), reason: reportFindings.join("\n\n").trim() };
            const notes = reportFindings.map(text => "- " + text).join("\n");
            const checks = Array.isArray(evidence) ? evidence.flatMap((text, index) =>
              typeof text === "string" ? [(index + 1) + ". " + text] : []).join("\n") : "";
            return [{ ...item, text: [summary, notes, checks].filter(Boolean).join("\n\n") }];
          } catch { return [item]; }
        });
        renderRunActivity(node.activity, items, false, undefined, task.id, { reviewer: true });
      }
      const matched = new Set();
      for (const { entry, event, submittedAt } of decisions) {
        const attempt = attempts.findLast(attempt => attempt.at >= submittedAt && attempt.at <= event.at);
        const node = attempt && nodes.get(attempt.id);
        // Keep the card's decision event and hide only the text also shown in its attempt.
        const reportText = event.action === "request-changes" ? node?.report?.reason : node?.report?.summary;
        entry.hidden = Boolean(node?.finished && !attempt.error && !matched.has(attempt.id) &&
          reportText === event.text.trim());
        if (entry.hidden) matched.add(attempt.id);
      }
      status.hidden = true;
      if (follow) work.scrollTop = work.scrollHeight;
    } catch (error) {
      if (!work.isConnected || project !== frame.project || request !== generation) return;
      status.hidden = false;
      bindLocalized(status, "textContent", () => t("ui.could_not_load_reviewer_chat_5c01ba32") + error.message);
    }
  }
}

function collaborationItem(item) {
  return item.type === "collabAgentToolCall" || item.type === "subAgentActivity";
}

function collaborationData(item) {
  try { return JSON.parse(item.text) ?? {}; } catch { return {}; }
}

function teamActivity(task, item, details, agents) {
  const operation = item.type === "subAgentActivity" ? { started: "spawn", interacted: "interaction", completed: "completed" }[details.kind] :
    { spawnAgent: "spawn", sendInput: "send", wait: "wait", closeAgent: "close", resumeAgent: "resume", followupTask: "resume" }[details.tool ?? item.title];
  if (!operation) return;
  const ids = [...new Set([...(details.receiverThreadIds ?? []), ...Object.keys(details.agentsStates ?? {}),
    ...(details.agentThreadId ? [details.agentThreadId] : [])])];
  const active = operation === "wait" && !ids.length && details.startedAtMs ? [...agents.values()].filter(agent =>
    agent.startedAtMs && agent.startedAtMs <= details.startedAtMs && (!agent.firstCompletion || agent.firstCompletion >= details.startedAtMs)) : [];
  const labels = [...new Set(ids.map(id => agents.get(id)?.name ?? t("experts.unnamed_agent")))];
  const expand = Boolean(details.prompt || Object.values(details.agentsStates ?? {}).some(state => state?.message));
  const row = element(expand ? "details" : "div", undefined, "expert-agent-event");
  const summary = element(expand ? "summary" : "div", undefined, "expert-agent-event-line");
  const glyph = operation === "completed" ? "check" : operation === "wait" ? "debug-pause" :
    operation === "send" || operation === "interaction" ? "comment-discussion" : "hubot";
  const caption = element("span", undefined, "expert-agent-caption");
  caption.append(element("strong", () => t("experts.agent_" + operation)));
  if (labels.length) caption.append(element("span", labels.join(", "), "muted"));
  else if (active.length) caption.append(element("span", () => t("experts.active_at_wait") + " " +
    [...new Set(active.map(agent => agent.name))].join(", "), "muted"));
  else if (operation === "wait") caption.append(element("span", () => t("experts.wait_target_unavailable"), "muted"));
  const model = details.model && [details.model, details.reasoningEffort && reasoningName(details.reasoningEffort)].filter(Boolean).join(" · ");
  if (model) caption.append(element("span", model, "muted"));
  const state = activityState([item]);
  if (state.code === "running" || state.code === "failed") caption.append(element("span", state.text, "muted"));
  summary.append(icon(glyph), caption);
  appendChatTime(summary, item.at);
  row.dataset.agentCall = item.id;
  row.append(summary);
  for (const status of Object.values(details.agentsStates ?? {})) {
    if (typeof status?.message === "string" && status.message) row.append(chatText(status.message, { taskId: task.id, agent: true }));
  }
  if (typeof details.prompt === "string") row.append(chatText(details.prompt, { taskId: task.id, agent: true }));
  return row;
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
  if (draft.savedRun?.sequence <= task.history.length) delete draft.savedRun;
  const area = element("section", undefined, "task-chat");
  const heading = element("h3", () => t("ui.agent_chat_065b4b62"));
  heading.id = "task-chat-heading";
  area.setAttribute("aria-labelledby", heading.id);
  const header = element("div", undefined, "chat-header");
  const tabs = element("div", undefined, "board-chat-views");
  header.append(heading, tabs);
  area.append(header);
  const list = element("ol", undefined, "chat-log task-dialogue");
  bindLocalized(list, "aria-label", () => t("ui.messages_e8e13717"), true);
  list.tabIndex = 0;
  const work = element("ol", undefined, "chat-log task-work");
  work.hidden = true;
  bindLocalized(work, "aria-label", () => t("ui.work_activity_e01957b7"), true);
  work.tabIndex = 0;
  const team = element("div", undefined, "chat-log task-team");
  team.hidden = true;
  bindLocalized(team, "aria-label", () => t("experts.team"), true);
  team.tabIndex = 0;
  const teamLog = element("div", undefined, "task-team-activity");
  const savedTeam = [];
  const savedWork = [];
  const files = new Map(task.attachments.map(file => [file.file, file]));
  const events = task.history.map((event, index) => ({ event, index }));
  if (task.questions.length) events.splice(1, 0, {
    event: { at: task.createdAt, actor: "agent", action: "questions", text: task.questions.join("\n\n") },
  });
  const missingRuns = new Map();
  const locale = localization.locale;
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const reviewDecisions = [];
  let submittedAt = "";
  let submissionRow;
  const savedRunItems = new Set();
  let day;
  let lastMessage;
  let lastMessageIndex = -1;
  for (const { event, index } of events) {
    if (event.action === "submit") submittedAt = event.at;
    if (event.action === "start" || (event.to && event.to !== "review")) submissionRow = undefined;
    const returned = event.actor === "reviewer" && event.action === "request-changes";
    const conversation = ["chat", "comment", "questions"].includes(event.action) || returned;
    if (event.expertMessage) continue;
    const appendWork = row => {
      row.dataset.historyAt = event.at;
      work.append(row);
    };
    if (event.chat) {
      lastMessage = event;
      lastMessageIndex = index;
    }
    const timestamp = new Date(event.at);
    const eventDay = !event.at || Number.isNaN(+timestamp) ? "" : dayFormat.format(timestamp);
    if (conversation && eventDay && eventDay !== day) {
      day = eventDay;
      const divider = element("li", undefined, "chat-day");
      divider.append(element("span", () => new Intl.DateTimeFormat(localization.locale, { dateStyle: "medium" }).format(timestamp)));
      list.append(divider);
    }
    if (event.action === "run-log" || event.run?.length) {
      const log = element("li", undefined, "chat-run");
      if (event.run?.length) {
        savedTeam.push(...event.run.filter(collaborationItem));
        const activity = event.action === "chat" ? event.run.filter(item => item.phase !== "final_answer") : event.run;
        savedWork.push(() => renderRunActivity(log, activity.filter(item => !collaborationItem(item)), true, event.durationMs, task.id));
        appendWork(log);
      } else if (task.codexThreadId && event.durationMs !== undefined) {
        log.hidden = true;
        appendWork(log);
        missingRuns.set(index, { log, durationMs: event.durationMs });
      }
      if (event.action === "run-log") {
        // The turn that submitted the card can finish saving after review has started.
        // Keep the history index for restoration and use the submission only for placement.
        if (submissionRow && log.parentNode === work) {
          for (const item of event.run ?? []) savedRunItems.add(item.id);
          log.dataset.historyAt = submissionRow.dataset.historyAt;
          work.insertBefore(log, submissionRow);
          submissionRow = undefined;
        }
        continue;
      }
    }
    if (!event.run?.length && event.chat?.commentary?.length) {
      const commentary = element("li", undefined, "chat-run");
      savedWork.push(() => renderRunActivity(commentary, event.chat.commentary.map((text, index) => ({
        id: String(index), type: "agentMessage", phase: "commentary", title: "", text, status: "completed",
      })), true, event.durationMs));
      appendWork(commentary);
    }
    const attachments = chatEventAttachments(event, files);
    const author = () => event.actor === "manager" ? t("ui.project_manager_48697fa0") :
      event.actor === "reviewer" ? t("ui.reviewer_50c42665") :
      event.actor === "user" ? t("ui.you_05444001") : t("ui.agent_262834de");

    if ((!conversation || returned) && event.action !== "coordination") {
      const status = lanes.find(([code]) => code === event.to);
      const service = element("li", undefined, "chat-entry chat-event");
      const stage = event.expertStageRun;
      const label = () => stage ? [
        expertStageLabel(task, stage.phase, stage.key) ?? t("experts.stage_event"),
        t("experts.stage_" + stage.state),
      ].join(" · ") : event.expertSkill ? [
        t(event.expertSkill.source === "plan" ? "experts.skill_preloaded" : "experts.skill_loaded"),
        event.expertSkill.name, event.expertSkill.expertId,
      ].join(" · ") : chatEventLabel(event.action) + (status ? " · " + t(status[1]) : "");
      service.append(element("span", author, "chat-author"), element("span", label, "chat-action"));
      appendChatTime(service, event.at);
      appendWork(service);
      if (event.action === "submit" && event.actor === "agent") submissionRow = service;
      if (!event.text && !attachments.length) continue;
      // A chat edit can quote the pending request as its audit note.
      if (event.action === "update" && event.actor === "user" &&
          lastMessage?.actor === "user" && event.text === lastMessage.text) continue;
    }
    const entry = element("li", undefined, "chat-entry");
    entry.dataset.actor = event.actor;
    const coordination = returned || event.action === "coordination" || (event.actor === "manager" && event.text);
    if (coordination) entry.classList.add("chat-coordination");
    const label = () => event.action === "coordination" && event.actor === "agent" ? t("ui.executor_92197b27") : author();
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
        const label = file.link || isImageAttachment(file) ? t("ui.view_7aa05de3") : t("ui.save_ceeee51c");
        if (file.link) tile.title = file.link.path;
        controlLabelForIcon(tile, label + file.name);
        tile.replaceChildren(icon("attachment"), element("span", file.name), element("small", " / " + file.bytes + " B"));
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
    appendChatTime(entry, event.at);
    if (returned && event.text) {
      const fallback = element("li", undefined, "chat-entry chat-coordination");
      fallback.dataset.actor = event.actor;
      fallback.append(element("span", author, "chat-author"), reviewerFindings(event.text, task.id));
      appendChatTime(fallback, event.at);
      appendWork(fallback);
      reviewDecisions.push({ entry: fallback, event, submittedAt });
    }
    if (event.actor === "reviewer" && event.text && !attachments.length &&
        ["review-approve", "review-note"].includes(event.action)) {
      reviewDecisions.push({ entry, event, submittedAt });
    }
    if (conversation) list.append(entry);
    else appendWork(entry);
  }
  const workControls = element("li", undefined, "task-work-controls");
  if (missingRuns.size) {
    const status = element("span", undefined, "muted");
    status.setAttribute("role", "status");
    const load = button(() => t("ui.load_codex_activity_4ba86e2d"), async () => {
      load.disabled = true;
      bindLocalized(status, "textContent", () => t("ui.loading_4f987027"));
      try {
        const result = await api.taskRunHistory(task.id);
        if (!area.isConnected || frame.project !== project) return;
        if (!result.ok) throw new Error(boardError(result.error));
        let restored = 0;
        let lastRestored;
        for (const [index, { log, durationMs }] of missingRuns) {
          const items = result.data[index];
          if (!items?.length) continue;
          savedTeam.push(...items.filter(collaborationItem));
          renderRunActivity(log, items.filter(item => !collaborationItem(item)), true, durationMs, task.id);
          if (items.length) {
            restored++;
            lastRestored = log;
          }
        }
        renderTeam();
        if (restored) load.remove();
        bindLocalized(status, "textContent", () => restored === missingRuns.size ? "" : restored
          ? t("ui.some_runs_are_unavailable_in_the_saved_codex_cha_7d8bfad3")
          : t("ui.no_activity_for_these_runs_in_the_saved_codex_ch_261837a1"));
        if (lastRestored) {
          lastRestored.querySelector(".chat-work > summary")?.focus({ preventScroll: true });
          lastRestored.scrollIntoView({ block: "nearest" });
        }
      } catch (error) {
        bindLocalized(status, "textContent", () => t("ui.could_not_load_the_codex_activity_5cf03362") + error.message);
      } finally {
        load.disabled = false;
      }
    }, "quiet");
    workControls.append(load, status);
  }
  if (workControls.childElementCount) work.prepend(workControls);
  const liveRun = element("li", undefined, "chat-run chat-run-live");
  const progress = element("li", undefined, "chat-run");
  if (submissionRow) work.insertBefore(liveRun, submissionRow);
  else work.append(liveRun);
  work.append(progress);
  const refreshReview = task.status === "review" || task.history.some(event => event.actor === "reviewer" || event.action === "submit")
    ? reviewerChat(task, work, submissionRow ? progress : liveRun, reviewDecisions, items => { reviewTeam = items; renderTeam(); }) : undefined;
  list.append(element("li", undefined, "chat-turn"));
  renderChatTurn(list, draft);
  area.append(list, work, team);

  let liveTeam = [];
  let reviewTeam = [];
  let renderedTeam;
  let teamRoleNames;
  let loadingTeamRoles = false;
  function renderTeam() {
    if (team.hidden) return;
    if (!loadingTeamRoles && task.expertTeam) {
      loadingTeamRoles = true;
      void expertRoleNames(project).then(names => {
        if (!team.isConnected) return;
        teamRoleNames = names;
        renderedTeam = undefined;
        renderTeam();
      });
    }
    const items = [...savedTeam, ...liveTeam, ...reviewTeam];
    const byId = new Map(items.map(item => [item.id, item]));
    const snapshot = JSON.stringify([...byId.values()]);
    if (snapshot === renderedTeam) return;
    renderedTeam = snapshot;
    const opened = new Set([...teamLog.querySelectorAll("details[open]")].map(row => row.dataset.agentCall));
    const plan = Object.values(task.expertTeam ?? {}).flatMap(phase => phase.stages);
    const roleAndStage = stage => [teamRoleNames?.get(stage.expertId), stage.title].filter(Boolean).join(" · ");
    const agents = new Map();
    for (const stages of Object.values(task.expertStageStatus ?? {})) for (const stage of stages) {
      if (stage.run?.agentId) agents.set(stage.run.agentId, { name: roleAndStage(stage) });
    }
    const activity = [...byId.values()].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
      .map(item => [item, collaborationData(item)]);
    for (const [item, data] of activity) {
      if (item.type !== "subAgentActivity" || !data.agentThreadId) continue;
      const key = data.agentPath?.split("/").at(-1);
      const matching = plan.filter(stage => stage.key === key || stage.expertId === key);
      const agent = agents.get(data.agentThreadId) ?? {
        name: matching.length === 1 ? roleAndStage(matching[0]) : key?.replaceAll("-", " ") || t("experts.unnamed_agent"),
      };
      if (data.kind === "started") agent.startedAtMs ??= data.startedAtMs;
      if (data.kind === "completed") agent.firstCompletion ??= data.completedAtMs;
      agents.set(data.agentThreadId, agent);
    }
    const rows = [];
    for (const [item, data] of activity) {
      const row = teamActivity(task, item, data, agents);
      if (!row) continue;
      if (row.tagName === "DETAILS") row.open = opened.has(item.id);
      rows.push(row);
    }
    if (!rows.length) rows.push(element("p", () => t("experts.no_agent_activity"), "muted"));
    teamLog.replaceChildren(...rows);
  }
  let liveItems = [];
  function renderLiveWork() {
    const follow = work.scrollHeight - work.clientHeight - work.scrollTop <= 8;
    // A save receipt can reach the window before its card history is refreshed.
    const saved = draft.savedRun;
    const items = saved?.items ?? liveItems;
    renderRunActivity(liveRun, items.filter(item => !collaborationItem(item) && !savedRunItems.has(item.id) &&
      (submissionRow || saved || item.phase !== "final_answer")), Boolean(saved), saved?.durationMs, task.id);
    if (follow) work.scrollTop = work.scrollHeight;
  }
  area.updateRun = (items = []) => {
    liveItems = items;
    liveTeam = items.filter(collaborationItem);
    if (!work.hidden) renderLiveWork();
    area.updateDiscussion();
    renderTeam();
  };
  area.updateDiscussion = () => {
    renderChatTurn(list, draft);
    const commentary = frame.runActivity?.[task.id]?.some(item => item.phase === "commentary") ? [] : draft.commentary ?? [];
    progress.replaceChildren(...commentary.map(text => chatText(text, { taskId: task.id, agent: true })));
    progress.hidden = !commentary.length;
  };
  area.updateRun(frame.runActivity?.[task.id]);

  const composer = element("form", undefined, "chat-composer");
  const input = element("textarea");
  input.id = "task-chat-input";
  input.rows = 3;
  input.value = draft.text;
  bindLocalized(input, "placeholder", () => t("ui.message_the_agent_a84e2133"));
  input.setAttribute("aria-label", input.placeholder);
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const pendingFiles = element("ul", undefined, "draft-attachments");
  const controls = element("div", undefined, "chat-controls");
  const feedback = element("p", undefined, "chat-status");
  feedback.setAttribute("role", "status");
  const retryReply = button(() => t("task_chat.retry_reply"), () => {
    if (!retryReply.disabled) void submit(lastMessageIndex);
  }, "quiet chat-retry-reply");
  const send = element("button", undefined, "button primary chat-icon chat-send");
  send.type = "submit";
  const attach = button("", () => fileInput.click(), "quiet chat-icon chat-add");
  attach.append(icon("add"));
  controlLabelForIcon(attach, () => t("ui.attach_files_792aed0d"));
  const microphone = button("", () => {
    input.focus();
    bindLocalized(feedback, "textContent", () => api.isWindows
      ? t("ui.press_win_h_to_start_windows_voice_typing_39244c53")
      : t("ui.start_system_dictation_while_this_field_is_focus_f77f00e3"));
    feedback.hidden = false;
  }, "quiet chat-icon chat-mic");
  microphone.append(icon("mic"));
  controlLabelForIcon(microphone, () => t("ui.voice_input_a05b7480"));
  controls.append(attach, microphone, retryReply, send);
  composer.append(pendingFiles, input, fileInput, controls, feedback);
  if (task.status === "draft" && task.draftDiscussion) {
    const { phase, reason } = task.draftDiscussion;
    const discussion = element("div", undefined, "chat-status");
    discussion.setAttribute("role", "status");
    discussion.append(element("span", () => t("draft_discussion." + phase, { reason })));
    if (phase === "failed") {
      const retry = button(() => t("draft_discussion.retry"), async () => {
        retry.disabled = true;
        draft.error = "";
        try {
          const result = await api.retryDraftDiscussion(task.id);
          if (!result.ok) draft.error = boardError(result.error);
        } catch (error) { draft.error = error.message; }
        finally {
          retry.disabled = false;
          if (frame.project === project && sheet.open && sheetKind === "task" && taskInSheet?.id === task.id) await showTask(task.id);
        }
      }, "quiet");
      discussion.append(" ", retry);
    }
    composer.prepend(discussion);
  }
  area.append(composer);

  if (!manualBoard()) {
    const agents = element("details", undefined, "expert-agent-history");
    agents.open = draft.agentHistoryOpen ?? false;
    agents.addEventListener("toggle", () => {
      if (agents.isConnected) draft.agentHistoryOpen = agents.open;
    });
    agents.append(element("summary", () => t("experts.subagents")), teamLog);
    team.append(agents, expertTeamMail(task));
  }
  const views = [
    ["dialogue", "ui.dialogue_e154ab04", list], ["work", "ui.work_activity_e01957b7", work],
    ...(!manualBoard() ? [["team", "experts.team", team]] : []),
  ].map(([name, label, panel]) => {
    const control = button(() => t(label), () => selectView(name), "quiet");
    control.setAttribute("aria-controls", panel.id = "task-chat-" + name);
    tabs.append(control);
    panel.addEventListener("scroll", () => {
      if (panel.hidden) return;
      (draft.viewScroll ??= {})[name] = panel.scrollHeight - panel.clientHeight - panel.scrollTop > 8 ? panel.scrollTop : undefined;
      if (name === "dialogue") draft.scroll = draft.viewScroll[name];
    });
    return { name, control, panel };
  });
  function selectView(name) {
    draft.view = name;
    composer.hidden = name !== "dialogue";
    for (const view of views) {
      view.panel.hidden = view.name !== name;
      view.control.setAttribute("aria-pressed", String(!view.panel.hidden));
      if (!view.panel.hidden) requestAnimationFrame(() => {
        if (!view.panel.hidden) view.panel.scrollTop = draft.viewScroll?.[name] ?? view.panel.scrollHeight;
      });
    }
    if (name === "work") {
      for (const render of savedWork.splice(0)) render();
      renderLiveWork();
    }
    if (name === "team") renderTeam();
    area.refreshReview();
  }
  area.refreshReview = () => { if (draft.view !== "dialogue") refreshReview?.(); };
  area.openReviewer = () => selectView("work");
  selectView(views.some(view => view.name === draft.view) ? draft.view : "dialogue");

  function working() { return Boolean(draft.pending || frame.runningTasks?.includes(task.id) || frame.replyingTasks?.includes(task.id)); }
  function stopping() { return working() && !draft.text.trim() && !draft.files.length; }
  function sync() {
    input.readOnly = Boolean(draft.saving);
    attach.disabled = microphone.disabled = input.readOnly;
    const stop = stopping();
    send.replaceChildren(icon(stop ? "stop" : "play"));
    controlLabelForIcon(send, () => stop ? t("ui.stop_agent_f50db092") : t("ui.send_message_173c4807"));
    send.disabled = Boolean(draft.saving || draft.stopping) || (!stop && !draft.text.trim() && !draft.files.length);
    retryReply.hidden = lastMessage?.actor !== "user" || working() ||
      Boolean(frame.board?.archived?.some(card => card.id === task.id));
    retryReply.disabled = retryReply.hidden || Boolean(draft.saving || draft.stopping);
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
      const remove = button("", () => {
        draft.files.splice(index, 1);
        renderPendingFiles();
        sync();
        input.focus();
      }, "quiet");
      remove.disabled = Boolean(draft.saving);
      remove.append(icon("close"));
      bindLocalized(remove, "aria-label", () => t("ui.remove_07d1de5b") + file.name, true);
      row.append(icon("attachment"), element("span", file.name), element("small", " / " + file.size + " B"), remove);
      if (!file.link && file.size <= 64 * 1024 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) showChatPreview(row, URL.createObjectURL(file));
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
      if (configured && !model) throw new Error(t("ui.the_task_model_is_unavailable_cc563f3b"));
      if (!model?.id || !model.effort) throw new Error(t("ui.no_models_available_f15531d2"));
      return { model: model.id, effort: model.effort };
    } catch (error) {
      if (chatCatalog === catalog) chatCatalog = undefined;
      throw error;
    }
  }

  function addFiles(newFiles) {
    if (draft.saving || !newFiles.length) return;
    draft.files.push(...newFiles);
    draft.error = "";
    renderPendingFiles();
    sync();
  }

  async function submit(retryAt) {
    const retrying = retryAt !== undefined;
    if (!retrying && send.disabled) return;
    if (!retrying && stopping()) {
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
      const { model, effort } = retrying ? lastMessage.chat : await discussionSettings();
      const files = retrying ? [] : await Promise.all(draft.files.map(file => api.filePayload(file)));
      if (!area.isConnected || frame.project !== project) return;
      const { saved, result } = await api.chatSend(task.id, {
        model, effort, text: retrying ? "" : text, files, ...(retrying ? { retryAt } : {}),
      });
      if (saved && !retrying && draft.saving === submission) {
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
  if (typeof label === "function") {
    bindLocalized(control, "title", label);
    bindLocalized(control, "aria-label", label, true);
  } else { control.title = label; control.setAttribute("aria-label", label); }
}
