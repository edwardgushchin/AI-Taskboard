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
    const { task, file, path, reviewer, managerImage } = target.dataset;
    const preview = managerImage ? api.managerImagePreview(managerImage) :
      path ? api.runImagePreview(task, path, task ? reviewer === "true" : undefined) : api.attachmentPreview(task, file);
    void preview.then(src => {
      if (src && target.isConnected) showChatPreview(target, src);
      else if ((path || managerImage) && target.isConnected) unavailableRunImage(target);
    }).catch(() => { if ((path || managerImage) && target.isConnected) unavailableRunImage(target); });
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
  preview.onerror = () => {
    release();
    if (tile.dataset.path || tile.dataset.managerImage) unavailableRunImage(tile);
  };
  preview.src = src;
}

function renderChatTurn(list, draft, items, taskId) {
  const turn = list.querySelector(".chat-turn");
  turn.hidden = items === undefined;
  const visible = (items ?? []).filter(item => !collaborationItem(item) && item.type !== "reasoning" &&
    (item.type !== "agentMessage" || item.text.trim()));
  if (visible.length) {
    renderRunActivity(turn, visible, false, undefined, taskId, { taskId, taskDiscussion: true });
  } else if (turn.hidden) {
    turn.replaceChildren();
  } else if (!turn.querySelector(".chat-thinking")) {
    const thinking = element("p", () => t("ui.thinking_14a886f3"), "chat-thinking");
    thinking.setAttribute("role", "status");
    turn.replaceChildren(thinking);
  }
  if (draft.scroll === undefined) list.scrollTop = list.scrollHeight;
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
const statusNoticeActions = new Set(["approve", "start", "block", "unblock", "submit", "request_changes", "return_to_draft", "accept", "cancel"]);

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

function goalTimeline(turns, live, pending = []) {
  const entries = new Map();
  for (const turn of turns) {
    for (const message of turn.messages) {
      const id = message.clientId ?? JSON.stringify([message.at, message.text, message.files]);
      entries.set(id, { id, at: message.at, userMessage: message });
    }
    for (const item of turn.items) {
      entries.set(item.id, item);
    }
  }
  for (const item of pending) {
    if (!entries.has(item.id)) {
      entries.set(item.id, item);
    }
  }
  for (const item of live) {
    const saved = entries.get(item.id);
    if (!saved || saved.status === "inProgress") {
      entries.set(item.id, { ...item, at: saved?.at ?? item.userMessage?.at ?? item.at });
    }
  }
  const time = item => Date.parse(item.at) || 0;
  return [...entries.values()].sort((left, right) => {
    const elapsed = time(left) - time(right);
    if (elapsed || left.id === right.id) return elapsed;
    return left.id < right.id ? -1 : 1;
  });
}

function renderRunActivity(container, items, completed = false, durationMs, taskId, context) {
  const messageContext = { ...(context ?? { taskId: taskId ?? taskInSheet?.id }), agent: true };
  const previous = new Map([...container.querySelectorAll("details")].map(entry => [entry.dataset.item, entry.open]));
  const previousFolds = new Map();
  if (context?.managerWork) {
    for (const fold of container.querySelectorAll(".chat-work")) {
      for (const action of fold.querySelectorAll(".chat-run-item")) {
        previousFolds.set(action.dataset.item, fold.open);
      }
    }
  }
  const previousImages = new Map([...container.querySelectorAll(".chat-run-item")].map(entry =>
    [entry.dataset.item, entry.querySelector(".chat-run-images")?.querySelector("button")]));
  const focusedImage = container.querySelector("[data-manager-image]:focus") ??
    [...previousImages.values()].find(tile => tile?.contains(document.activeElement));
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
  const viewedImages = new Map();
  if (taskId || context?.dialogue || context?.managerWork) {
    for (const item of items) {
      const image = runImageFile(item);
      if (image) viewedImages.set(item, image);
    }
  }
  const images = [...viewedImages.values()];
  const managerImages = new Map();
  const managerImageTiles = new Map([...container.querySelectorAll("[data-manager-image]")].map(tile =>
    [tile.dataset.managerImage + "\0" + tile.dataset.imagePlacement, tile]));
  const answers = new Map();
  const lastByTurn = new Map();
  if (context?.dialogue || context?.managerWork) {
    for (const item of items) {
      const key = item.providerTurnId;
      lastByTurn.set(key, item);
      if (item.type === "agentMessage" && item.phase === "final_answer" && item.text.trim()) {
        answers.set(key, item.id);
      }
      if (item.type !== "imageGeneration" || item.status !== "completed") {
        continue;
      }
      const series = managerImages.get(key) ?? new Map();
      const file = item.generatedImage?.file;
      const extension = file?.split(".").pop() ?? "png";
      series.set(item.id, { file, name: "generated-" + (series.size + 1) + "." + extension });
      managerImages.set(key, series);
    }
  }
  function generatedTiles(series, onlyId) {
    const tiles = element("div", undefined, "chat-attachments chat-run-images");
    const files = [...series.values()];
    for (const [id, image] of series) {
      if (onlyId !== undefined && id !== onlyId) {
        continue;
      }
      const placement = onlyId ?? "answer";
      let tile = managerImageTiles.get(image.file + "\0" + placement);
      if (!tile) {
        tile = button("", () => {
          const group = tile.imageFiles;
          openImagePreview(undefined, group, group.findIndex(file => file.file === image.file && file.name === image.name),
            tile.querySelector("img")?.src, {
              preview: file => file.file ? api.managerImagePreview(file.file) : null,
              save: file => api.saveManagerImage(file.file, file.name),
            });
        }, "quiet chat-attachment");
        tile.append(icon("images"), element("span", image.name));
        controlLabelForIcon(tile, () => t("ui.view_7aa05de3") + image.name);
        if (image.file) {
          tile.dataset.managerImage = image.file;
          tile.dataset.imagePlacement = placement;
          chatPreviews.observe(tile);
        } else {
          unavailableRunImage(tile);
        }
      }
      tile.imageFiles = files;
      tiles.append(tile);
    }
    return tiles;
  }
  function appendAnswerImages(entry, item) {
    if ((!context?.dialogue && !context?.managerWork) || answers.get(item.providerTurnId) !== item.id) {
      return;
    }
    const series = managerImages.get(item.providerTurnId);
    if (series) {
      entry.append(generatedTiles(series));
      entry.dataset.generatedAnswer = item.id;
    }
  }
  const finalItems = new Set();
  if (completed && !context?.managerWork) {
    const boundary = items.findLastIndex(item => item.userMessage);
    const finalSegment = boundary === -1 ? items : items.slice(boundary + 1);
    const finalTurnId = finalSegment.at(-1)?.providerTurnId;
    const finalTurn = finalSegment.filter(item => item.providerTurnId === finalTurnId);
    for (const item of finalTurn) {
      if (item.type === "agentMessage" && item.phase === "final_answer" && item.text.trim()) finalItems.add(item);
    }
    // Older logs have no phase. Their last completed message is the final reply.
    if (!finalItems.size && !finalTurn.some(item => item.type === "agentMessage" && item.phase)) {
      const last = finalTurn.findLast(item => item.type === "agentMessage" && item.status === "completed" && item.text.trim());
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
    const generated = managerImages.get(item.providerTurnId);
    if (generated?.has(item.id)) {
      detail.open = previous.get(detail.dataset.item) ?? true;
      detail.append(generatedTiles(generated, item.id));
      return detail;
    }
    const image = viewedImages.get(item);
    if (image) {
      detail.open = previous.get(detail.dataset.item) ?? true;
      const tiles = element("div", undefined, "chat-attachments chat-run-images");
      let tile = previousImages.get(detail.dataset.item);
      if (!tile || tile.dataset.path !== image.file || tile.dataset.task !== taskId) {
        tile = button("", () => openImagePreview(taskId, tile.imageFiles, tile.imageIndex,
          tile.querySelector("img")?.src, {
            preview: file => api.runImagePreview(taskId, file.file, context?.reviewer),
            save: file => api.saveRunImage(taskId, file.file, context?.reviewer),
          }), "quiet chat-attachment");
        controlLabelForIcon(tile, () => t("ui.view_7aa05de3") + image.name);
        tile.append(icon("images"), element("span", image.name));
        if (taskId) tile.dataset.task = taskId;
        tile.dataset.path = image.file;
        if (context?.reviewer) tile.dataset.reviewer = "true";
        chatPreviews.observe(tile);
      }
      tile.imageFiles = images;
      tile.imageIndex = images.indexOf(image);
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
  function appendUnansweredImages(turnId) {
    const series = managerImages.get(turnId);
    if (!series || answers.has(turnId)) {
      return;
    }
    flush();
    const tiles = generatedTiles(series);
    tiles.dataset.item = "images:" + [...series.keys()].at(-1);
    nodes.push(tiles);
  }
  let previousTurnId = items[0]?.providerTurnId;
  let previousItem;
  for (const item of items) {
    if (item.providerTurnId !== previousTurnId) {
      if (!context?.managerWork || lastByTurn.get(previousTurnId) === previousItem) {
        appendUnansweredImages(previousTurnId);
      }
      if (context?.managerWork) flush();
      previousTurnId = item.providerTurnId;
    }
    previousItem = item;
    if (finalItems.has(item)) continue;
    if (context?.dialogue && item.type === "imageGeneration") {
      continue;
    }
    if (item.type === "reasoning" && !item.text.trim()) continue;
    if (item.userMessage?.text?.startsWith("AI Taskboard queue: handle these addressed notices without a goal. [")) continue;
    if (item.userMessage && context?.userMessage) {
      flush();
      const entry = context.userMessage(item.userMessage, item.id);
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
    const showTaskEvent = item.taskChanges?.some(({ action }) =>
      visibleTaskActions.has(action) && !(context?.managerWork && statusNoticeActions.has(action)));
    if (["agentMessage", "plan", "truncated", "error", "reasoning"].includes(item.type)) {
      flush();
      if (item.type === "agentMessage" || item.type === "plan") {
        const message = chatText(item.text, messageContext);
        let entry = message;
        if (context?.taskDiscussion && item.type === "agentMessage") {
          entry = element("div", undefined, "chat-entry");
          entry.dataset.actor = "agent";
          entry.append(element("span", () => t("ui.agent_262834de"), "chat-author"), message);
        } else if (context?.dialogue && item.type === "agentMessage" && item.text.trim()) {
          entry = element("div", undefined, "board-manager-message");
          entry.append(message);
        }
        appendAnswerImages(entry, item);
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
  appendUnansweredImages(previousTurnId);
  flush();
  const boundaryKey = node => node.dataset.messageId || node.dataset.coordinationKey || node.dataset.generatedAnswer ||
    (node.dataset.item?.startsWith("images:") ? node.dataset.item : undefined) ||
    (context?.managerWork && node.dataset.item?.startsWith("message:") ? node.dataset.item : undefined) ||
    (node.dataset.actor === "user" || taskEventRows.has(node) ? node.dataset.item : undefined);
  const hasBoundaries = nodes.some(boundaryKey);
  function foldWork(batch, key, label) {
    const work = element("details", undefined, "chat-work");
    const first = batch.find(node => node.dataset.item)?.dataset.item;
    if (context?.managerWork && first) key = "work:" + activityRowKey(first);
    work.dataset.item = key;
    if (first) work.dataset.chatAnchor = "work:" + first;
    work.open = previous.get(key) ?? false;
    if (context?.managerWork && !previous.has(key)) {
      const actions = batch.flatMap(node => nodeActivities.get(node) ?? []);
      const previousState = actions.map(item => previousFolds.get("item:" + item.id)).find(open => open !== undefined);
      work.open = previousState ?? actions.some(item => context.liveIds.has(item.id));
    }
    activitySummary(work, label, "", "reasoning", activityState(
      hasBoundaries ? batch.flatMap(node => nodeActivities.get(node) ?? []) : items));
    const chronology = element("div", undefined, "chat-run-body");
    chronology.append(...batch);
    work.append(chronology);
    return work;
  }
  if (completed && nodes.length) {
    let label = () => {
      if (context?.managerWork) return t("ui.work_details_e9890a2e");
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
    appendAnswerImages(final, item);
    appendChatTime(final, item.at);
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

function updateChat({ project, id, type, text, items, savedRun, runThreadId, goal, goalId, goalRunning, goalResuming, goalResumeWaiting, error, question, managerRun, managerWork, at }) {
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
    else if (type === "orchestrator-goal") {
      composer?.updateGoal?.(goal, goalRunning, goalResuming, {
        goalId,
        goalResumeWaiting,
        goalResumeError: error,
        goalResumeEvent: goalResuming !== undefined,
      });
    }
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
    if (open) byId("task-review-history")?.refreshReview?.();
    return;
  }
  if (type === "discussion" && frame.project === project) {
    const activity = frame.discussionActivity ??= {};
    if (items) activity[id] = items;
    else delete activity[id];
    if (open) byId("task-side").firstElementChild?.updateDiscussion();
    return;
  }
  if (type === "run" && frame.project === project) {
    (frame.runActivity ??= {})[id] = items;
    (frame.runActivityThreads ??= {})[id] = runThreadId;
    byId("board-composer").firstChild?.updateManagerWork();
    if (open) {
      if (savedRun && savedRun.threadId === taskInSheet.codexThreadId && savedRun.sequence > taskInSheet.history.length) {
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

function collaborationItem(item) {
  return item.type === "collabAgentToolCall" || item.type === "subAgentActivity";
}

function taskWorkItem(item) {
  if (item.stageChild || collaborationItem(item)) return false;
  if (item.type === "error" && ["project-closed", "save-error", "discussion-launch-error", "schedule-error", "block-error"].includes(item.id)) {
    return false;
  }
  if (item.type !== "mcpToolCall" && item.type !== "dynamicToolCall") return true;
  const tool = item.title?.split(" / ").at(-1) ?? "";
  return !/^(team_(message|inbox|findings)|expert_(plan|stage|verify_skills))$/.test(tool);
}

function isTaskChatReplacement(event, task) {
  if (event.action !== "update" || event.actor !== "user") return false;
  if (event.previousCodexThreadId) return true;
  // Older launchers included the previous thread only in the update note.
  return task.codexServiceThreads?.some(id => id !== task.codexThreadId && event.text?.endsWith("`" + id + "`"));
}

function reviewerHistory(task, journal, decisions, onActivity) {
  const project = frame.project;
  const status = element("li", undefined, "muted");
  status.setAttribute("role", "status");
  status.hidden = true;
  journal.append(status);
  const nodes = new Map();
  let timer;
  let generation = 0;
  return () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (journal.isConnected && (onActivity || journal.closest("details")?.open)) void load();
    }, 200);
  };

  async function load() {
    const request = ++generation;
    try {
      const result = await api.reviewerChat(task.id);
      if (!journal.isConnected || project !== frame.project || request !== generation) return;
      if (!result.ok) throw new Error(boardError(result.error));
      const attempts = result.data;
      onActivity?.(attempts.flatMap(attempt => attempt.items));
      if (!journal.closest("details")?.open) return;
      const ids = new Set(attempts.map(attempt => attempt.id));
      for (const [id, node] of nodes) {
        if (ids.has(id)) continue;
        node.entry.remove();
        nodes.delete(id);
      }
      const history = decisions.map(({ entry }) => entry);
      for (const [index, attempt] of attempts.entries()) {
        let node = nodes.get(attempt.id);
        if (!node) {
          const entry = element("li", undefined, "chat-entry task-review-attempt");
          entry.dataset.actor = "reviewer";
          const label = element("span", undefined, "chat-coordination-header");
          const activity = element("div", undefined, "chat-run");
          const error = element("p", undefined, "chat-run-error");
          entry.append(label, activity, error);
          journal.insertBefore(entry, history.find(row => row.dataset.historyAt > attempt.at) ?? status);
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
          if (item.stageChild || collaborationItem(item)) return [];
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
      status.hidden = attempts.length > 0 || decisions.length > 0;
      if (!status.hidden) {
        bindLocalized(status, "textContent", () => t("ui.no_reviewer_messages_yet_25b5caaf"));
      }
    } catch (error) {
      if (!journal.isConnected || project !== frame.project || request !== generation) return;
      status.hidden = false;
      bindLocalized(status, "textContent", () => t("ui.could_not_load_reviewer_chat_5c01ba32") + error.message);
    }
  }
}

function collaborationData(item) {
  try { return JSON.parse(item.text) ?? {}; } catch { return {}; }
}

function stageWork(task, panels) {
  if (!panels?.size) return;
  const attempts = [];
  const active = new Map();
  for (const event of task.history) {
    const run = event.expertStageRun;
    if (!run) {
      // An open stage from an interrupted run cannot claim later activity.
      for (const [address, attempt] of active) {
        const phase = attempt.run.phase;
        const planChanged = event.action === "expert-plan" && (!event.expertPhase || event.expertPhase === phase);
        if (planChanged || event.action === "update" || (event.action === "progress" && event.to === "ready") ||
            ["start", "submit", "pause", "resume", "block", "cancel",
          "return-to-draft", "request-changes", "review-approve", "accept"].includes(event.action)) {
          attempt.until = event.at;
          active.delete(address);
        }
      }
      if (event.action === "expert-plan") {
        for (const attempt of attempts) {
          if (!event.expertPhase || event.expertPhase === attempt.run.phase) attempt.previousPlan = true;
        }
      }
      continue;
    }

    const address = run.phase + ":" + run.key;
    let attempt = active.get(address);
    if (run.state === "running" && run.agentId && attempt?.run.sessionId &&
        run.sessionId === attempt.run.sessionId && run.threadId === attempt.run.threadId &&
        run.targetHead === attempt.run.targetHead) {
      attempt.agentId = run.agentId;
      continue;
    }
    if (attempt) {
      attempt.until = event.at;
      active.delete(address);
    }
    if (run.state === "running" || !attempt ||
        (run.threadId && run.threadId !== attempt.run.threadId) || run.targetHead !== attempt.run.targetHead) {
      attempt = { address, run, agentId: run.agentId, at: event.at, activity: element("div", undefined, "chat-run") };
      attempts.push(attempt);
    }
    if (run.state === "running") active.set(address, attempt);
    else {
      attempt.finish = { run, at: event.at };
      attempt.agentId ??= run.agentId;
    }
  }

  function statusRow(run, at) {
    const row = element("div", undefined, "chat-entry chat-event");
    row.append(element("span", () => t("experts.stage_" + run.state), "chat-action"));
    appendChatTime(row, at);
    return row;
  }

  for (const [address, panel] of panels) {
    for (const attempt of attempts) {
      if (attempt.address !== address || attempt.previousPlan) continue;
      const { run, activity, finish } = attempt;
      if (run.state === "running") panel.append(statusRow(run, attempt.at), activity);
      if (!finish) continue;
      panel.append(statusRow(finish.run, finish.at));
      if (finish.run.result) panel.append(chatText(finish.run.result, { taskId: task.id, agent: true }));
      if (finish.run.fallback) panel.append(element("p", () => t("experts.local_execution") + " · " + finish.run.fallback, "muted"));
      for (const [name, evidence] of Object.entries(finish.run.outputs ?? {})) {
        panel.append(chatText(name + " · " + evidence, { taskId: task.id, agent: true }));
      }
    }
    if (!panel.hasChildNodes()) panel.append(element("p", () => t("experts.no_stage_activity"), "muted"));
  }

  function render(phase, items, saved = []) {
    const byAttempt = new Map();
    const unique = new Map();
    const savedItems = new Set(saved.map(item => item.threadId + "\0" + item.id));
    for (const item of [...saved, ...items]) {
      if (!item.stageSessionId && savedItems.has(item.threadId + "\0" + item.id)) continue;
      const key = item.stageSessionId + "\0" + item.threadId + "\0" + item.id;
      if (item.threadId && item.at && !unique.has(key)) unique.set(key, item);
    }
    const ordered = [...unique.values()].sort((first, second) => first.at.localeCompare(second.at));
    for (const item of ordered) {
      if (item.type === "truncated") continue;
      let matches = attempts.filter(({ run, agentId, at, until, previousPlan }) => !previousPlan &&
        run.state === "running" && run.phase === phase &&
        (item.stageChild ? agentId === item.threadId && Boolean(item.stageSessionId) : run.threadId === item.threadId) &&
        (item.stageSessionId ? item.stageSessionId === run.sessionId : Boolean(until)) &&
        item.at >= at && (!until || item.at < until));
      const collaboration = collaborationItem(item);
      if (collaboration && !item.stageChild) {
        const data = collaborationData(item);
        const receivers = Array.isArray(data.receiverThreadIds) ? data.receiverThreadIds : [];
        const ids = new Set([...receivers, ...Object.keys(data.agentsStates ?? {}),
          ...(data.agentThreadId ? [data.agentThreadId] : [])]);
        if (ids.size !== 1) continue;
        const [id] = ids;
        matches = matches.filter(attempt => attempt.agentId === id);
      }
      if (matches.length !== 1) continue;
      const [attempt] = matches;
      const plan = task.expertTeam[phase];
      const isLead = plan.stages.find(stage => stage.key === attempt.run.key)?.expertId === plan.lead;
      const local = isLead || Boolean(attempt.finish?.run.fallback);
      if (!item.stageChild && !collaboration && (!local || attempt.agentId)) continue;
      const log = byAttempt.get(attempt) ?? [];
      log.push(item);
      byAttempt.set(attempt, log);
    }
    for (const attempt of attempts) {
      if (attempt.run.phase !== phase || !attempt.activity.isConnected) continue;
      const log = byAttempt.get(attempt) ?? [];
      const snapshot = JSON.stringify(log);
      if (attempt.snapshot === snapshot) continue;
      attempt.snapshot = snapshot;
      renderRunActivity(attempt.activity, log, false, undefined, task.id, { taskId: task.id, reviewer: phase === "review" });
    }
  }

  const project = frame.project;
  const recent = {};
  let saved = {};
  let request;
  let dirty = false;
  function refresh() {
    if (!api.stageRunHistory || request) return;
    dirty = false;
    request = api.stageRunHistory(task.id).then(result => {
      if (!result.ok || project !== frame.project || ![...panels.values()].some(panel => panel.isConnected)) return;
      saved = result.data;
      for (const phase of ["work", "review"]) {
        render(phase, recent[phase] ?? [], saved[phase]);
      }
    }).catch(() => {
      // Keep available entries and the stage result if the journal cannot be read.
    }).finally(() => {
      request = undefined;
      if (dirty && project === frame.project && [...panels.values()].some(panel => panel.isConnected)) refresh();
    });
  }
  return (phase, items) => {
    recent[phase] = items;
    render(phase, items, saved[phase]);
    dirty = true;
    refresh();
  };
}

function taskChat(task, renderStageWork) {
  const project = frame.project;
  const key = project + "\0" + task.id;
  const latestReply = task.history.findLast(event => event.chat && event.actor === "agent")?.chat;
  let draft = chatDrafts.get(key);
  if (!draft) {
    draft = { text: "", files: [] };
    chatDrafts.set(key, draft);
  }
  if (draft.savedRun && (draft.savedRun.sequence <= task.history.length ||
      draft.savedRun.threadId !== task.codexThreadId)) delete draft.savedRun;
  const area = element("section", undefined, "task-chat");
  bindLocalized(area, "aria-label", () => t("ui.agent_chat_065b4b62"), true);
  const header = element("div", undefined, "chat-header");
  const tabs = element("div", undefined, "board-chat-views");
  header.append(tabs);
  area.append(header);
  const list = element("ol", undefined, "chat-log task-dialogue");
  bindLocalized(list, "aria-label", () => t("ui.messages_e8e13717"), true);
  list.tabIndex = 0;
  const work = element("ol", undefined, "chat-log task-work");
  work.hidden = true;
  bindLocalized(work, "aria-label", () => t("ui.work_activity_e01957b7"), true);
  work.tabIndex = 0;
  const savedWork = [];
  const savedStageItems = new Map();
  const files = new Map(task.attachments.map(file => [file.file, file]));
  const events = task.history.map((event, index) => ({ event, index }));
  if (task.questions.length) events.splice(1, 0, {
    event: { at: task.createdAt, actor: "agent", action: "questions", text: task.questions.join("\n\n") },
  });
  const missingRuns = new Map();
  const locale = localization.locale;
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const sessionStart = task.history.findLastIndex(event => isTaskChatReplacement(event, task));
  const savedItems = new Set();
  const addSavedItems = items => items.filter(item => {
    if (!taskWorkItem(item)) return false;
    if (item.type === "truncated") return true;
    if (savedItems.has(item.id)) return false;
    savedItems.add(item.id);
    return true;
  });
  let day;
  let lastMessage;
  let lastMessageIndex = -1;
  for (const { event, index } of events) {
    const returned = event.actor === "reviewer" && event.action === "request-changes";
    const conversation = ["chat", "comment", "questions"].includes(event.action) || returned;
    if (event.expertMessage) continue;

    if (renderStageWork && event.action === "run-log" && event.run?.length) savedStageItems.set(index, event.run);
    const executorEvent = event.action === "run-log" && event.actor === "agent" && index > sessionStart &&
      (!event.runThreadId || event.runThreadId === task.codexThreadId);
    if (executorEvent) {
      const log = element("li", undefined, "chat-run");
      log.hidden = true;
      if (event.run?.length) {
        const items = addSavedItems(event.run);
        if (items.length) {
          work.append(log);
          savedWork.push(() => renderRunActivity(log, items, true, event.durationMs, task.id));
        }
      } else if (task.codexThreadId && event.durationMs !== undefined) {
        work.append(log);
        missingRuns.set(index, { log, durationMs: event.durationMs });
      }
    }
    if (!conversation) continue;
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
    const attachments = chatEventAttachments(event, files);
    const author = () => event.actor === "manager" ? t("ui.project_manager_48697fa0") :
      event.actor === "reviewer" ? t("ui.reviewer_50c42665") :
      event.actor === "user" ? t("ui.you_05444001") : t("ui.agent_262834de");

    const entry = element("li", undefined, "chat-entry");
    entry.dataset.actor = event.actor;
    const coordination = returned || (event.actor === "manager" && event.text);
    if (coordination) entry.classList.add("chat-coordination");
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
      const text = event.text;
      entry.append(returned ? reviewerFindings(text, task.id) :
        chatText(text, { taskId: task.id, coordination, agent: event.action === "chat" && event.actor === "agent" }));
    }
    appendChatTime(entry, event.at);
    list.append(entry);
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
          const restoredItems = result.data[index] ?? [];
          if (renderStageWork && restoredItems.length) savedStageItems.set(index, restoredItems);
          const items = addSavedItems(restoredItems);
          if (!items.length) continue;
          renderRunActivity(log, items, true, durationMs, task.id);
          restored++;
          lastRestored = log;
        }
        renderLiveStageWork();
        renderLiveWork();
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
  const emptyWork = element("li", () => t("ui.no_task_work"), "muted");
  work.append(liveRun, emptyWork);
  list.append(element("li", undefined, "chat-turn"));
  area.append(list, work);

  let liveItems = [];
  function renderLiveStageWork() {
    if (!renderStageWork) return;
    const saved = [...savedStageItems.keys()].sort((a, b) => a - b).flatMap(index => savedStageItems.get(index));
    const savedIds = new Set(saved.map(item => item.threadId + "\0" + item.id));
    const live = (draft.savedRun?.items ?? liveItems).filter(item => !savedIds.has(item.threadId + "\0" + item.id));
    renderStageWork("work", [...saved, ...live]);
  }
  function renderLiveWork() {
    const follow = work.scrollHeight - work.clientHeight - work.scrollTop <= 8;
    // A save receipt can reach the window before its card history is refreshed.
    const saved = draft.savedRun;
    // Steered replies already arrive through the executor's run stream.
    // Standalone discussions run in a separate provider session.
    const threadId = frame.runActivityThreads?.[task.id];
    const executor = saved?.items ?? (threadId && threadId === task.codexThreadId ? liveItems : []);
    const seen = new Set();
    const items = executor.filter(item => {
      if (!taskWorkItem(item) || savedItems.has(item.id) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    renderRunActivity(liveRun, items, Boolean(saved), saved?.durationMs, task.id);
    emptyWork.hidden = [...work.children].some(row => row !== emptyWork && row !== workControls && !row.hidden);
    if (follow) work.scrollTop = work.scrollHeight;
  }
  area.updateRun = (items = []) => {
    liveItems = items;
    renderLiveStageWork();
    if (!work.hidden) renderLiveWork();
  };
  area.updateDiscussion = () => {
    const items = frame.discussionActivity?.[task.id];
    const savedReply = lastMessage?.actor === "agent" && items?.some(item =>
      item.type === "agentMessage" && item.phase === "final_answer" && item.at === lastMessage.at);
    renderChatTurn(list, draft, savedReply ? undefined : items, task.id);
  };
  area.updateRun(frame.runActivity?.[task.id]);
  area.updateDiscussion();

  const composer = element("form", undefined, "chat-composer");
  const input = element("textarea");
  input.id = "task-chat-input";
  input.rows = 2;
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
  const send = element("button", undefined, "button primary chat-send");
  send.type = "submit";
  const attach = button("", () => fileInput.click(), "quiet chat-add");
  attach.append(icon("add"));
  controlLabelForIcon(attach, () => t("ui.attach_files_792aed0d"));
  const microphone = button("", () => {
    input.focus();
    bindLocalized(feedback, "textContent", () => api.isWindows
      ? t("ui.press_win_h_to_start_windows_voice_typing_39244c53")
      : t("ui.start_system_dictation_while_this_field_is_focus_f77f00e3"));
    feedback.hidden = false;
  }, "quiet chat-mic");
  microphone.append(icon("mic"));
  controlLabelForIcon(microphone, () => t("ui.voice_input_a05b7480"));
  controls.append(attach, microphone, retryReply, send);
  composer.append(pendingFiles, input, fileInput, controls, feedback);
  if (task.status === "draft" && task.draftDiscussion && task.draftDiscussion.phase !== "running") {
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

  const views = [
    ["dialogue", "ui.dialogue_e154ab04", list],
    ["work", "ui.work_activity_e01957b7", work],
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
  }
  area.openDialogue = () => selectView("dialogue");
  selectView(draft.view === "team" || draft.view === "work" ? "work" : "dialogue");

  function working() { return Boolean(draft.pending || frame.runningTasks?.includes(task.id) || frame.replyingTasks?.includes(task.id)); }
  function stopping() { return working() && !draft.text.trim() && !draft.files.length; }
  function sync() {
    input.readOnly = Boolean(draft.saving);
    attach.disabled = microphone.disabled = input.readOnly;
    const stop = stopping();
    syncChatActionIcon(send, stop);
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

function syncChatActionIcon(control, stop) {
  const action = stop ? "stop" : "send";
  if (control.dataset.action === action) return;
  control.dataset.action = action;
  control.replaceChildren(icon(stop ? "stop-circle" : "arrow-up"));
  control.classList.toggle("quiet", stop);
  control.classList.toggle("primary", !stop);
}

function controlLabelForIcon(control, label) {
  if (typeof label === "function") {
    bindLocalized(control, "title", label);
    bindLocalized(control, "aria-label", label, true);
  } else { control.title = label; control.setAttribute("aria-label", label); }
}
