const chatMarkdown = window.markdownit?.({ breaks: true, linkify: true, html: false });

const sourceLocation = new RegExp(sourceFile.source.replace(/\$$/, ":[1-9]\\d*(?::\\d+)?$"), "i");
const fullDigest = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const shortCommit = /^[0-9a-f]{4,39}$/i;
const commitContext = /(?:^|[^\p{L}\p{N}_])(?:commit|коммит[а-яё]*)[\s:—–=-]*$/iu;
const reportSentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

function localDocumentLink(value) {
  try {
    const path = decodeURIComponent(value);
    return !/[\0-\x1f\x7f]/.test(path) &&
      (!/^[a-z][a-z\d+.-]*:/i.test(path) || /^(?:file:|[a-z]:[\\/])/i.test(path)) &&
      (/\.(?:md|markdown|txt|log|json)(?::\d+(?::\d+)?)?(?:#.*)?$/i.test(path) || sourceLocation.test(path));
  } catch { return false; }
}

if (chatMarkdown) {
  const web = url => /^https?:\/\//i.test(url);
  const inlineImage = url => /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url);
  chatMarkdown.validateLink = url => web(url) || /^mailto:/i.test(url) || inlineImage(url) || localDocumentLink(url);
  const parseDestination = chatMarkdown.helpers.parseLinkDestination;
  chatMarkdown.helpers = { ...chatMarkdown.helpers };
  chatMarkdown.helpers.parseLinkDestination = (text, start, max) => {
    // Preserve Windows backslashes and accept spaces in local document paths.
    const angle = text[start] === "<";
    let end = start + (angle ? 1 : 0);
    let depth = 0;
    for (; end < max; end++) {
      const char = text[end];
      if (char === "\n" || char === "\r" || (angle && char === ">")) break;
      if (!angle && char === "(" && ++depth > 32) break;
      if (!angle && char === ")" && depth-- === 0) break;
    }
    const path = text.slice(start + (angle ? 1 : 0), end).trimEnd();
    if (depth <= 0 && (!angle || text[end] === ">") && localDocumentLink(path)) {
      return { ok: true, str: path, pos: angle ? end + 1 : start + path.length };
    }
    return parseDestination(text, start, max);
  };
  const image = chatMarkdown.renderer.rules.image;
  chatMarkdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const src = token.attrGet("src");
    if (!web(src) && !inlineImage(src)) return chatMarkdown.utils.escapeHtml(token.content);
    token.attrSet("loading", "lazy");
    token.attrSet("referrerpolicy", "no-referrer");
    return image(tokens, index, options, env, renderer);
  };
  chatMarkdown.core.ruler.before("text_join", "restore_markdown_paths", state => {
    for (const block of state.tokens) {
      if (block.type !== "inline") continue;
      const tokens = block.children;
      for (let index = tokens.length - 3; index >= 0; index--) {
        const link = tokens[index];
        if (link.type !== "link_open" || link.markup !== "linkify" || !/^mailto:/i.test(link.attrGet("href"))) continue;
        const label = tokens[index + 1];
        if (!/[\\/].*\.(?:md|markdown)$/i.test(label.content) || !localDocumentLink(label.content)) continue;
        // Rejoin the plain path with adjacent text before the local link pass.
        tokens.splice(index, 3, label);
      }
    }
  });
  chatMarkdown.core.ruler.after("text_join", "local_markdown_links", state => {
    // Match unquoted paths in prose, with optional line/column and heading suffixes.
    const references = /(^|[\s([{<>"'«“‘;,])((?:file:\/\/\/(?:[a-z]:\/)?|[a-z]:[\\/])?[\p{L}\p{M}\p{N}_.%+@~\\/-]+\.(?:markdown|md|txt|log|json)(?::\d+(?::\d+)?)?(?:#[\p{L}\p{M}\p{N}_%.~-]*[\p{L}\p{M}\p{N}_%~-])?)(?=$|[\s)\]}<>"'»”’,;!?]|[.:](?=$|[\s)\]}<>"'»”’,;!?]))/giu;
    for (const block of state.tokens) {
      if (block.type !== "inline") continue;
      let inLink = false;
      block.children = block.children.flatMap(token => {
        if (token.type === "link_open") inLink = true;
        if (token.type === "link_close") inLink = false;
        if (token.type !== "text" || inLink) return [token];

        const parts = [];
        const appendText = content => {
          if (!content) return;
          const text = new state.Token("text", "", 0);
          text.content = content;
          parts.push(text);
        };
        let cursor = 0;
        for (const match of token.content.matchAll(references)) {
          const [, prefix, path] = match;
          if (!/\.(?:md|markdown)(?:[:#]|$)/i.test(path) &&
              !(state.env.coordination && /[\\/]/.test(path))) continue;
          if (!localDocumentLink(path)) continue;
          const target = decodeURIComponent(path.split("#", 1)[0]).replace(/:\d+(?::\d+)?$/, "");
          if (/^(?:file:\/\/)?[\\/]{2}/i.test(target)) continue;
          appendText(token.content.slice(cursor, match.index + prefix.length));
          const link = new state.Token("link_open", "a", 1);
          link.attrSet("href", chatMarkdown.normalizeLink(path));
          link.attrSet("title", path);
          parts.push(link);
          appendText(target.split(/[\\/]/).pop());
          parts.push(new state.Token("link_close", "a", -1));
          cursor = match.index + match[0].length;
        }
        if (cursor === 0) return [token];
        appendText(token.content.slice(cursor));
        return parts;
      });
    }
  });
  const location = String.raw`(?:[a-zA-Z]:[\\/]|\/)?(?:[\p{L}\p{N}_.@%-]+[\\/])*[\p{L}\p{N}_.@%-]+\.[a-zA-Z][a-zA-Z0-9]*:\d+(?::\d+)?`;
  const identifier = String.raw`[a-zA-Z_]\w*`;
  const generic = String.raw`<[\w., ?]+>`;
  const patterns = [
    `(?<location>${location})`,
    String.raw`(?:${identifier}\.)*${identifier}(?:${generic})?\([\w., ?-]*\)`,
    String.raw`(?:${identifier}\.)+${identifier}(?:${generic})?`,
    String.raw`[A-Z]\w*(?:${generic}|\?)`,
    String.raw`null|true|false|undefined|0x[\da-fA-F]+`,
  ];
  const agentReferences = new RegExp(String.raw`(?<![\p{L}\p{N}_.\\/:])(?:${patterns.join("|")})(?![\p{L}\p{N}_\\/])`, "gu");
  const digest = /(?<![\p{L}\p{N}_.%/\\-])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![\p{L}\p{N}_%/\\-]|\.[\p{L}\p{N}])/u;
  const reportReferences = new RegExp(digest.source + "|" + agentReferences.source, "gu");
  chatMarkdown.core.ruler.after("local_markdown_links", "chat_references", state => {
    const reference = /(?<![\p{L}\p{N}_.\/%\\-])(?:T-\d{4,}|v?\d+\.\d+\.\d+(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?|[\da-fA-F]{64}|[\da-fA-F]{4,40})(?![\p{L}\p{N}_\/%\\-]|\.[\p{L}\p{N}])/gu;
    for (const block of state.tokens) {
      if (block.type !== "inline") continue;
      let inLink = false;
      let prefix = "";
      block.children = block.children.flatMap(token => {
        const before = prefix;
        prefix += token.content;
        if (token.type === "link_open") inLink = true;
        if (token.type === "link_close") inLink = false;
        if (inLink || !["text", "code_inline"].includes(token.type)) return [token];
        const parts = [];
        let cursor = 0;
        for (const match of token.content.matchAll(reference)) {
          const value = match[0];
          if (shortCommit.test(value) && !commitContext.test(before + token.content.slice(0, match.index))) continue;
          if (token.type === "code_inline" && value !== token.content) continue;
          if (match.index > cursor) {
            const text = new state.Token("text", "", 0);
            text.content = token.content.slice(cursor, match.index);
            parts.push(text);
          }
          const type = /^T-/.test(value) ? "chat_task" : fullDigest.test(value) || shortCommit.test(value) ? "code_inline" : "chat_version";
          const part = new state.Token(type, type === "code_inline" ? "code" : "", 0);
          part.content = value;
          parts.push(part);
          cursor = match.index + value.length;
        }
        if (!parts.length) return [token];
        if (cursor < token.content.length) {
          const text = new state.Token("text", "", 0);
          text.content = token.content.slice(cursor);
          parts.push(text);
        }
        return parts;
      });
    }
  });
  chatMarkdown.renderer.rules.chat_task = (tokens, index) => {
    const id = chatMarkdown.utils.escapeHtml(tokens[index].content);
    return `<a class="chat-task-reference" href="#${id}" data-task="${id}"><i class="icon codicon codicon-symbol-number" aria-hidden="true"></i>${id}</a>`;
  };
  chatMarkdown.renderer.rules.chat_version = (tokens, index) =>
    `<span class="chat-version"><i class="icon codicon codicon-milestone" aria-hidden="true"></i>${chatMarkdown.utils.escapeHtml(tokens[index].content)}</span>`;
  chatMarkdown.core.ruler.after("local_markdown_links", "agent_inline_code", state => {
    if (!state.env.agent) return;
    for (const block of state.tokens) {
      if (block.type !== "inline") continue;
      let inLink = false;
      block.children = block.children.flatMap(token => {
        if (token.type === "link_open") inLink = true;
        if (token.type === "link_close") inLink = false;
        if (token.type !== "text" || inLink) return [token];
        const parts = [];
        let cursor = 0;
        for (const match of token.content.matchAll(state.env.report ? reportReferences : agentReferences)) {
          const [value] = match;
          const before = new state.Token("text", "", 0);
          before.content = token.content.slice(cursor, match.index);
          const code = new state.Token("code_inline", "code", 0);
          code.content = value;
          parts.push(before);
          if (match.groups.location && /[\\/]/.test(value) && sourceLocation.test(value) && localDocumentLink(value)) {
            const link = new state.Token("link_open", "a", 1);
            link.attrSet("href", chatMarkdown.normalizeLink(value));
            link.attrSet("title", value);
            code.content = decodeURIComponent(value).split(/[\\/]/).pop();
            parts.push(link, code, new state.Token("link_close", "a", -1));
          } else parts.push(code);
          cursor = match.index + value.length;
        }
        if (!parts.length) return [token];
        const after = new state.Token("text", "", 0);
        after.content = token.content.slice(cursor);
        return [...parts, after];
      });
    }
  });
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

function showCoordinationCommands(block) {
  const shellCommand = /^(?:&[ \t]+(?:['"$.]|\w)|(?:pwsh|powershell|dotnet|git|npm|node|python3?|bash|sh|cmd)(?:\.exe)?[ \t]+\S)/i;
  for (const code of block.querySelectorAll("p > code")) {
    const before = code.previousSibling;
    const after = code.nextSibling;
    const introduced = before?.nodeType === Node.TEXT_NODE && before.textContent.trimEnd().endsWith(":");
    const onOwnLine = (!before || before.nodeName === "BR") &&
      (!after || after.nodeName === "BR" || (after.nodeType === Node.TEXT_NODE && /^[.!?]?[ \t]*$/.test(after.textContent)));
    if (!(introduced || onOwnLine) || !shellCommand.test(code.textContent.trimStart())) continue;
    const paragraph = code.parentElement;
    const rest = element("p");
    while (code.nextSibling) rest.append(code.nextSibling);
    // A sentence-ending period after inline code belongs to the prose, not the command.
    if (rest.firstChild?.nodeType === Node.TEXT_NODE) {
      rest.firstChild.textContent = rest.firstChild.textContent.replace(/^(?:[.!?](?=\s|$))?[ \t]*/, "");
      if (!rest.firstChild.textContent) rest.firstChild.remove();
    }
    if (rest.firstChild?.nodeName === "BR") rest.firstChild.remove();
    if (before?.nodeName === "BR") before.remove();
    const pre = element("pre");
    paragraph.after(pre);
    pre.append(code);
    if (rest.hasChildNodes()) pre.after(rest);
    if (!paragraph.textContent.trim()) paragraph.remove();
  }
}

function addCodeCopy(pre, code) {
  const wrapper = element("div", undefined, "chat-code-block");
  const toolbar = element("div", undefined, "chat-code-toolbar");
  const copy = button("", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      copyIcon.classList.replace("codicon-copy", "codicon-check");
      controlLabelForIcon(copy, () => t("ui.copied_copy_code_again_b2b609e4"));
    } catch {
      controlLabelForIcon(copy, () => t("ui.could_not_copy_select_the_code_or_retry_3ed46a84"));
      copyIcon.classList.replace("codicon-check", "codicon-copy");
    }
  }, "quiet chat-code-copy");
  const copyIcon = element("i", undefined, "icon codicon codicon-copy");
  copyIcon.setAttribute("aria-hidden", "true");
  copy.append(copyIcon);
  controlLabelForIcon(copy, () => t("ui.copy_code_968ce1d3"));
  toolbar.append(copy);
  pre.before(wrapper);
  wrapper.append(toolbar, pre);
}

function showCoordinationEvidence(block) {
  block.normalize();
  // Start a new paragraph at an explicit evidence label followed by a file and checksum.
  for (const link of block.querySelectorAll(":scope > p > a")) {
    const before = link.previousSibling;
    const after = link.nextSibling;
    const checksum = after?.nextSibling;
    if (before?.nodeType !== Node.TEXT_NODE || !/^,\s*SHA-?256\s+/i.test(after?.textContent ?? "") ||
        checksum?.nodeName !== "CODE" || checksum.textContent.length !== 64 || !fullDigest.test(checksum.textContent)) continue;
    const paragraph = link.parentElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.setEndBefore(link);
    const prefix = range.toString();
    const label = /(?:^|[.!?]\s+)((?:Журнал|Дневник|Отч[её]т|Log|Worklog|Report)\s[^.!?]*$)/iu.exec(prefix);
    if (!label) continue;
    let offset = prefix.length - label[1].length;
    if (!offset) continue;
    let start = paragraph.firstChild;
    while (start && offset >= start.textContent.length) {
      offset -= start.textContent.length;
      start = start.nextSibling;
    }
    if (!start || start.nodeType !== Node.TEXT_NODE) continue;
    start = start.splitText(offset);
    const evidence = element("p");
    while (start.nextSibling) evidence.append(start.nextSibling);
    evidence.prepend(start);
    paragraph.after(evidence);
  }
}

function formatReportReferences(block) {
  for (const code of block.querySelectorAll(":not(pre, a) > code")) {
    const value = code.textContent;
    if ((!fullDigest.test(value) && !shortCommit.test(value)) || code.closest("a, pre")) continue;
    const range = document.createRange();
    range.selectNodeContents(code.closest("p, li, td") ?? code.parentElement);
    range.setEndBefore(code);
    const prefix = range.toString();
    const short = shortCommit.test(value);
    if (short && !commitContext.test(prefix)) continue;
    const labelBefore = /(?:^|[^\p{L}\p{N}_])(SHA-?\d+|checksum|контрольн\S*\s+сумм\S*|commit|коммит\S*)[\s:—–=-]*$/iu.exec(prefix)?.[1] ?? "";
    const fileBefore = /(?:^|\s)(?:\S+\.[\p{L}\p{N}]+|(?:file|файл)\s+[^:\n]+)[\s:：=—–-]*$/iu.test(prefix);
    const commit = short || /^(?:commit|коммит)/iu.test(labelBefore) ||
      (value.length === 40 && !labelBefore && !fileBefore);
    const label = short ? t("ui.copy_hash") : t("ui.copy_full_hash_725de55a");
    const copy = button("", async () => {
      try {
        await navigator.clipboard.writeText(value);
        icon.classList.replace("codicon-copy", "codicon-check");
        bindLocalized(copy, "aria-label", () => t("ui.copied_243d5f98") + label, true);
      } catch {
        icon.classList.replace("codicon-check", "codicon-copy");
        bindLocalized(copy, "aria-label", () => t("ui.copy_failed_retry_eeb3cc51"), true);
      }
    }, "quiet chat-digest");
    const icon = element("i", undefined, "icon codicon codicon-copy");
    icon.setAttribute("aria-hidden", "true");
    copy.title = value;
    copy.setAttribute("aria-label", label + " " + value);
    code.textContent = commit ? value.slice(0, 7) : value;
    code.replaceWith(copy);
    copy.append(code, icon);
  }
}

function foldTechnicalDetails(block, title = /^(?:Technical details|Технические детали)$/i, className = "chat-report-details", requirePrevious = true) {
  for (const heading of block.querySelectorAll(":scope > :is(h1, h2, h3, h4, h5, h6)")) {
    if (heading.parentElement !== block || (requirePrevious && !heading.previousElementSibling) ||
        !title.test(heading.textContent.trim())) continue;
    const level = Number(heading.tagName[1]);
    const details = element("details", undefined, className);
    const content = element("div", undefined, "chat-report-body");
    while (heading.nextElementSibling) {
      const next = heading.nextElementSibling;
      const nextHeading = /^H([1-6])$/.exec(next.tagName);
      if (nextHeading && Number(nextHeading[1]) <= level) break;
      content.append(next);
    }
    if (!content.childElementCount) continue;
    const summary = element("summary");
    summary.append(...heading.childNodes);
    details.append(summary, content);
    heading.replaceWith(details);
  }
}

function splitLongReportParagraphs(block) {
  for (const paragraph of block.querySelectorAll(":scope > p")) {
    const text = paragraph.textContent;
    if (text.length < 360 || paragraph.querySelector("br, img, input")) continue;
    let endOfBlock = text.length;
    for (const { index } of [...reportSentences.segment(text)].reverse()) {
      if (index < 160 || endOfBlock - index < 160) continue;
      let offset = index;
      const node = [...paragraph.childNodes].find(child => {
        if (offset < child.textContent.length) return true;
        offset -= child.textContent.length;
        return false;
      });
      if (!node || (offset > 0 && node.nodeType !== Node.TEXT_NODE)) continue;
      const range = document.createRange();
      if (offset === 0) range.setStartBefore(node);
      else range.setStart(node, offset);
      range.setEnd(paragraph, paragraph.childNodes.length);
      const next = element("p");
      next.append(range.extractContents());
      paragraph.after(next);
      endOfBlock = index;
    }
  }
}

function showHexColors(block) {
  const hexColor = /(?<![\p{L}\p{M}\p{N}_#/%\\])#[0-9a-f]{6}(?![\p{L}\p{M}\p{N}_#]|[./\\][\p{L}\p{N}])/giu;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const matches = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.data.includes("#") || node.parentElement.closest("a, pre, button")) continue;
    const colors = [...node.data.matchAll(hexColor)];
    if (colors.length) matches.push({ node, colors });
  }
  for (const { node, colors } of matches) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const { 0: color, index } of colors) {
      fragment.append(node.data.slice(offset, index));
      const label = element("span", color, "chat-hex-color");
      label.style.setProperty("--chat-hex", color);
      fragment.append(label);
      offset = index + color.length;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
}

function chatText(text, context = { taskId: taskInSheet?.id }) {
  const block = element("div", undefined, "chat-text");
  if (!chatMarkdown) {
    block.innerText = text;
    return block;
  }
  const agent = context.agent || context.coordination;
  const report = agent && !context.source;
  block.classList.toggle("chat-agent-text", Boolean(report));
  block.innerHTML = chatMarkdown.render(text, { agent, report: report || context.coordination, coordination: context.coordination });
  if (context.coordination) {
    showCoordinationCommands(block);
    showCoordinationEvidence(block);
  }
  if (report) {
    foldTechnicalDetails(block);
    splitLongReportParagraphs(block);
  }
  formatReportReferences(block);
  for (const code of block.querySelectorAll("pre > code")) addCodeCopy(code.parentElement, code);
  if (!context.source) showHexColors(block);
  block.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute("href");
    if (link.dataset.task) {
      void protect(() => showTask(link.dataset.task))();
    } else if (localDocumentLink(href)) {
      void protect(() => openMarkdownPreview(href, context))();
    } else {
      void protect(() => api.openLink(href))();
    }
  });
  return block;
}

async function openMarkdownPreview(value, context) {
  const focus = document.activeElement;
  const dialog = element("dialog", undefined, "markdown-preview");
  const label = t("ui.document_preview_9653cffc");
  dialog.setAttribute("aria-label", label);
  const header = element("header", undefined, "sheet-header");
  const title = element("h2", label);
  const close = button("", () => dialog.close(), "quiet");
  close.append(icon("close"));
  controlLabelForIcon(close, () => t("ui.close_preview_c54f8606"));
  header.append(title, close);
  const content = element("div", undefined, "markdown-preview-content");
  content.tabIndex = 0;
  const status = element("p", () => t("ui.loading_document_5f66a116"), "muted");
  status.setAttribute("role", "status");
  content.append(status);
  dialog.append(header, content);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (focus?.isConnected) focus.focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  try {
    const result = await api.readMarkdown(context.taskId, value, context.source);
    if (!dialog.open) return;
    if (!result.ok) throw new Error(boardError(result.error));
    const file = result.data;
    title.textContent = file.name;
    title.title = file.path;
    const path = element("p", file.path, "markdown-preview-path muted");
    const markdown = /\.(?:md|markdown)$/i.test(file.name);
    const preview = markdown ? chatText(file.text, { ...context, source: file.path }) : element("div", undefined, "chat-text");
    let target;
    if (!markdown) {
      const lines = file.line ? file.text.split("\n") : [];
      const pre = element("pre");
      if (file.line && file.line <= lines.length) {
        const index = file.line - 1;
        target = element("mark", lines[index], "source-line");
        pre.append(index ? lines.slice(0, index).join("\n") + "\n" : "", target,
          index + 1 < lines.length ? "\n" + lines.slice(index + 1).join("\n") : "");
        title.textContent += ":" + file.line;
      } else pre.textContent = file.text;
      preview.append(pre);
    }
    dialog.setAttribute("aria-label", title.textContent);
    content.replaceChildren(path, preview);
    target?.scrollIntoView({ block: "center", inline: "nearest" });
  } catch (error) {
    if (dialog.open) status.textContent = error.message;
  }
}
