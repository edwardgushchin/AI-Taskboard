import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import { readFileSync } from "node:fs";
import { version as osVersion, release as osRelease } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import localization from "./localization.cjs";
import { repositoryUrl } from "./updates.ts";

const title = "AI Taskboard";
const openDialogs = new WeakMap<BrowserWindow, BrowserWindow>();
const t = localization.text;

function buildMetadata(): { commit?: string; date?: string; dirty?: boolean } {
  if (app.isPackaged) {
    try {
      const { taskboardBuild } = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
      return {
        commit: typeof taskboardBuild?.commit === "string" ? taskboardBuild.commit : undefined,
        date: typeof taskboardBuild?.date === "string" ? taskboardBuild.date : undefined,
        dirty: taskboardBuild?.dirty === true,
      };
    } catch {
      // Packages built before build metadata was introduced can still open the dialog.
    }
  }
  return {};
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function showAbout(parent: BrowserWindow) {
  const existing = openDialogs.get(parent);
  if (existing) {
    existing.focus();
    return;
  }

  const build = buildMetadata();
  const unavailable = t("about.no_build_metadata");
  const commitLabel = t(build.dirty ? "about.base_commit" : "about.commit");
  let commit = build.commit || unavailable;
  if (build.dirty) {
    commit += ` (${t("about.local_changes")})`;
  }
  const rows = [
    [t("about.version"), app.getVersion()],
    [commitLabel, commit],
    [t("about.build_date"), build.date || unavailable],
    ["Electron", process.versions.electron],
    ["Chromium", process.versions.chrome],
    ["Node.js", process.versions.node],
    ["V8", process.versions.v8],
    [t("about.os"), `${osVersion()} ${osRelease()}`],
    [t("about.architecture"), process.arch],
    [t("about.author"), "Eduard Gushchin"],
    [t("about.repository"), repositoryUrl],
  ];
  const summary = [title, ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  const rowHtml = rows.map(([label, value]) => {
    const text = escapeHtml(value);
    const content = value === repositoryUrl ? `<a href="${text}">${text}</a>` : text;
    return `
      <div class="row">
        <dt>${escapeHtml(label)}</dt>
        <dd>${content}</dd>
      </div>`;
  }).join("\n");
  const themeStyles = readFileSync(new URL("./themes.css", import.meta.url), "utf8");
  const html = `<!doctype html>
<html lang="${localization.locale}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${title}</title>
  <style>
    ${themeStyles}
    :root {
      font: 14px/1.4 "Segoe UI", system-ui, sans-serif;
      color: var(--text);
      background: var(--panel);
    }
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      margin: 0;
    }
    main {
      flex: 1;
      overflow: auto;
      padding: 20px;
    }
    h1 {
      margin: 1px 0 12px;
      font-size: 20px;
      font-weight: 600;
    }
    dl {
      display: grid;
      gap: 4px;
      margin: 0;
    }
    .row {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 8px;
    }
    dt { font-weight: 600; }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    a { color: var(--blue); }
    footer {
      display: flex;
      justify-content: end;
      gap: 8px;
      padding: 10px 20px;
      border-top: 1px solid var(--border);
      background: var(--toolbar);
    }
    button {
      font: inherit;
      font-weight: 600;
      min-width: 76px;
      padding: 4px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      background: var(--panel);
      cursor: pointer;
    }
    button:hover {
      background: color-mix(in srgb, var(--text) 8%, var(--panel));
    }
    #close {
      color: var(--accent-text);
      background: var(--accent);
      border-color: var(--accent);
    }
    #close:hover {
      background: color-mix(in srgb, var(--accent-text) 10%, var(--accent));
    }
    :focus-visible {
      outline: 2px solid var(--blue);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <dl>${rowHtml}</dl>
  </main>
  <footer>
    <button id="copy">${escapeHtml(t("ui.copy_47162712"))}</button>
    <button id="close" autofocus>OK</button>
  </footer>
</body>
</html>`;

  const window = new BrowserWindow({
    parent,
    modal: true,
    title,
    useContentSize: true,
    width: 520,
    height: 400,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL("./about-preload.cjs", import.meta.url)),
    },
  });
  openDialogs.set(parent, window);
  window.once("closed", () => openDialogs.delete(parent));
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === repositoryUrl) {
      void shell.openExternal(repositoryUrl).catch(() => {
        if (!window.isDestroyed()) {
          void dialog.showMessageBox(window, {
            type: "error",
            title,
            message: t("about.repository_error"),
            detail: repositoryUrl,
          });
        }
      });
    }
  });
  window.webContents.ipc.on("about:copy", () => clipboard.writeText(summary));
  window.webContents.ipc.on("about:close", () => window.close());
  try {
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    if (!window.isDestroyed()) window.show();
  } catch (error) {
    if (window.isDestroyed()) return;
    window.destroy();
    throw error;
  }
}
