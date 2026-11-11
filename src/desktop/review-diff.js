function diffLanguage(header) {
  // Git quotes special paths and can append a tab after an unquoted path with spaces.
  const extension = /\.(html?|xhtml|xml|svg|css|[cm]?js)(?:"|\t)?$/i.exec(header)?.[1].toLowerCase();
  if (!extension) return undefined;
  if (extension === "css") return "css";
  return extension.endsWith("js") ? "javascript" : "markup";
}

function highlightDiffLines(rows, language) {
  const grammar = globalThis.Prism?.languages[language];
  if (!grammar || !rows.length) return;
  const source = rows.map(({ text }) => text.slice(1)).join("\n");
  let line = 0;
  function renderToken(token, type) {
    if (typeof token === "string") {
      const parts = token.split("\n");
      parts.forEach((part, index) => {
        if (index) line++;
        const destination = rows[line].syntax;
        if (!part || !destination) return;
        if (type) {
          const span = document.createElement("span");
          span.className = "syntax-" + type;
          span.textContent = part;
          destination.append(span);
        } else {
          destination.append(part);
        }
      });
    } else if (Array.isArray(token)) {
      token.forEach(child => renderToken(child, type));
    } else {
      renderToken(token.content, token.type);
    }
  }
  renderToken(Prism.tokenize(source, grammar));
}

function renderReviewDiff(patch) {
  const pre = document.createElement("pre");
  pre.className = "review-diff";
  pre.tabIndex = 0;
  const code = document.createElement("code");
  const lines = patch.split("\n");
  let oldLanguage, newLanguage;
  let oldRemaining = 0, newRemaining = 0;
  let oldRows = [], newRows = [];

  function finishHunk() {
    highlightDiffLines(oldRows, oldLanguage);
    highlightDiffLines(newRows, newLanguage);
    oldRows = [];
    newRows = [];
  }

  lines.forEach((text, index) => {
    const row = document.createElement("span");
    const prefix = text[0];
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (inHunk && (prefix === "+" || prefix === "-" || prefix === " ")) {
      const marker = document.createElement("span");
      marker.className = "diff-marker";
      marker.textContent = prefix;
      row.append(marker);
      const syntax = document.createElement("span");
      const rowInfo = { text, syntax };
      if (prefix !== "+") {
        oldRemaining--;
        // Tokenize old context for deleted lines, while rendering the new context.
        oldRows.push(prefix === "-" ? rowInfo : { text });
      }
      if (prefix !== "-") {
        newRemaining--;
        newRows.push(rowInfo);
      }
      const language = prefix === "-" ? oldLanguage : newLanguage;
      if (!globalThis.Prism?.languages[language]) syntax.textContent = text.slice(1);
      row.append(syntax);
      if (prefix !== " ") row.className = prefix === "+" ? "diff-added" : "diff-removed";
    } else {
      row.textContent = text;
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
      if (hunk) {
        finishHunk();
        oldRemaining = Number(hunk[1] ?? 1);
        newRemaining = Number(hunk[2] ?? 1);
        row.className = "diff-hunk";
      } else if (text.startsWith("diff --git ")) {
        finishHunk();
        oldLanguage = newLanguage = undefined;
        row.className = "diff-header";
      } else if (text.startsWith("--- ")) {
        oldLanguage = diffLanguage(text);
        row.className = "diff-header";
      } else if (text.startsWith("+++ ")) {
        newLanguage = diffLanguage(text);
        row.className = "diff-header";
      } else {
        row.className = "diff-meta";
      }
    }
    // Keep the original diff intact when users select and copy it.
    if (index < lines.length - 1) row.append("\n");
    if (text || index < lines.length - 1) code.append(row);
  });
  finishHunk();
  pre.append(code);
  return pre;
}
