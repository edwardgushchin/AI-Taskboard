const chatMarkdown = window.markdownit?.({ breaks: true, linkify: true, html: false });

function localMarkdownLink(value) {
  try {
    const path = decodeURIComponent(value);
    return !/[\0-\x1f\x7f]/.test(path) &&
      (!/^[a-z][a-z\d+.-]*:/i.test(path) || /^(?:file:|[a-z]:[\\/])/i.test(path)) &&
      /\.(?:md|markdown)(?::\d+(?::\d+)?)?(?:#.*)?$/i.test(path);
  } catch { return false; }
}

if (chatMarkdown) {
  const web = url => /^https?:\/\//i.test(url);
  const inlineImage = url => /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url);
  chatMarkdown.validateLink = url => web(url) || /^mailto:/i.test(url) || inlineImage(url) || localMarkdownLink(url);
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
    if (depth <= 0 && (!angle || text[end] === ">") && localMarkdownLink(path)) {
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
  chatMarkdown.core.ruler.after("text_join", "local_markdown_links", state => {
    // Match unquoted paths in prose, with optional line/column and heading suffixes.
    const references = /(^|[\s([{<>"'«“‘;,])((?:file:\/\/\/(?:[a-z]:\/)?|[a-z]:[\\/])?[\p{L}\p{M}\p{N}_.%+@~\\/-]+\.(?:markdown|md)(?::\d+(?::\d+)?)?(?:#[\p{L}\p{M}\p{N}_%.~-]*[\p{L}\p{M}\p{N}_%~-])?)(?=$|[\s)\]}<>"'»”’,;!?]|[.:](?=$|[\s)\]}<>"'»”’,;!?]))/giu;
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
          if (!localMarkdownLink(path)) continue;
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

function chatText(text, context = { taskId: taskInSheet?.id }) {
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
    const href = link.getAttribute("href");
    if (localMarkdownLink(href)) {
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
  dialog.setAttribute("aria-label", language("Markdown document", "Документ Markdown"));
  const header = element("header", undefined, "sheet-header");
  const title = element("h2", language("Markdown document", "Документ Markdown"));
  const close = button("×", () => dialog.close(), "quiet");
  controlLabelForIcon(close, language("Close preview", "Закрыть просмотр"));
  header.append(title, close);
  const content = element("div", undefined, "markdown-preview-content");
  content.tabIndex = 0;
  const status = element("p", language("Loading document…", "Загрузка документа…"), "muted");
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
    dialog.setAttribute("aria-label", file.name);
    const path = element("p", file.path, "markdown-preview-path muted");
    content.replaceChildren(path, chatText(file.text, { ...context, source: file.path }));
  } catch (error) {
    if (dialog.open) status.textContent = error.message;
  }
}
