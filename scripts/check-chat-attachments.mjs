// Render a real card in an isolated Electron window. Board access is read-only;
// save dialogs are replaced with a recorder and CLI exports go to the artifact folder.
// Usage: node scripts/check-chat-attachments.mjs --project <board> --task T-0041
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const require = createRequire(import.meta.url);
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "chat-attachments", 90_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const project = resolve(option("--project") ?? root);
const id = option("--task");
assert.match(id ?? "", /^T-\d{4,}$/);
const profile = join(scratch, "profile");
const downloads = join(scratch, "downloads");
mkdirSync(profile);
mkdirSync(downloads);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
function cli(args, input) {
  const result = spawnSync(process.env.TASKBOARD_CHECK_NODE, ["--disable-warning=ExperimentalWarning",
    join(root, "src", "cli", "main.ts"), "--project", project, "--json", ...args, ...(input ? ["--stdin"] : [])], {
    input: input ? JSON.stringify(input) : undefined, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reply = JSON.parse(result.stdout);
  assert.ok(reply.ok, JSON.stringify(reply.error));
  return reply.data;
}
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
const checks = [];
let window;
app.whenReady().then(async () => {
  const task = cli(["show", id]);
  const files = task.attachments.filter(file => /\.(png|jpe?g|gif|webp)$/i.test(file.name) &&
    task.history.some(event => event.action === "attach" &&
      (event.attachment === file.file || (event.attachment === undefined && event.text === file.name))));
  assert.ok(files.length, "the card must contain standalone image attachments");
  const images = Object.fromEntries(files.map(file => {
    const saved = cli(["attachment", "read", id], { file: file.file });
    return [file.file, "data:image/" + (/\.jpe?g$/i.test(file.name) ? "jpeg" : file.name.split(".").pop().toLowerCase()) + ";base64," + saved.base64];
  }));
  window = new BrowserWindow({ width: 1384, height: 1000, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await window.webContents.insertCSS(read("themes.css") + "\n" + read("styles.css"));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const check = async (code, label) => { assert.equal(await evaluate(code), true, label); checks.push(label); };
  const waitFor = code => evaluate(`new Promise((resolve, reject) => {
    const until = Date.now() + 5000;
    const poll = () => { if (${code}) resolve(); else if (Date.now() > until) reject(new Error('Timed out: ' + ${JSON.stringify(code)})); else setTimeout(poll, 16); }; poll(); })`);
  const capture = async name => {
    await window.webContents.capturePage();
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    // Hidden windows can lag behind layout by a compositor frame.
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  await evaluate(`
    window.fixtureTask = ${JSON.stringify(task)};
    window.fixtureImages = ${JSON.stringify(images)};
    window.saves = [];
    window.taskboard = {
      subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
      command: async () => ({ ok: true, data: window.fixtureTask }),
      attachmentPreview: async (_task, file) => file === window.failedFile ? null : window.fixtureImages[file],
      saveAttachment: async (task, file, name) => { window.saves.push({ task, file, name }); return { ok: true }; }
    };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${localizationFixture()}
    ${read("renderer.js")}
    frame = { project: ${JSON.stringify(project)}, russian: true, board: { tasks: [window.fixtureTask], archived: [] } };
    document.querySelector('#welcome').hidden = true;
    void 0;
  `);
  await evaluate("showTask(window.fixtureTask.id)");
  for (const theme of ["dark", "light"]) {
    nativeTheme.themeSource = theme;
    for (const width of [1384, 500]) {
      window.setSize(width, 1000);
      await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`);
      await check(`getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() === '${theme === "dark" ? "#222532" : "#fff"}'`,
        `native ${theme} theme is applied at ${width}`);
      for (const file of files) {
        const tile = `body.querySelector('.chat-attachment[data-file="${file.file}"]')`;
        await check(`!!${tile}`, file.name + " has an image tile");
        await evaluate(`${tile}.scrollIntoView({ block: 'center' })`);
        await waitFor(`${tile}.querySelector('img')?.naturalWidth > 0`);
        await check(`${tile}.classList.contains('has-preview') && ${tile}.getBoundingClientRect().width > 0`,
          file.name + ` thumbnail decodes at ${theme}/${width}`);
      }
      await check(`body.scrollWidth <= body.clientWidth + 1 && body.querySelector('.chat-log').scrollWidth <= body.querySelector('.chat-log').clientWidth + 1`,
        `no horizontal overflow at ${theme}/${width}`);
      await evaluate(`body.querySelector('.chat-attachment[data-file="${files[0].file}"]').scrollIntoView({ block: 'start' })`);
      await capture(`attachments-${theme}-${width}.png`);
    }
  }
  for (const file of files) {
    const tile = `body.querySelector('.chat-attachment[data-file="${file.file}"]')`;
    await evaluate(`${tile}.click()`);
    await waitFor(`document.querySelector('.image-preview-stage img:not([hidden])')?.naturalWidth > 0`);
    await check(`document.querySelector('.image-preview-header strong').textContent === ${JSON.stringify(file.name)} &&
      document.querySelector('.image-preview-stage img').src === window.fixtureImages['${file.file}']`, file.name + " opens in viewer");
    await evaluate(`document.querySelector('[aria-label="Увеличить"]').click();
      [...document.querySelectorAll('.image-preview button')].find(button => button.textContent === 'Сохранить').click()`);
    await check(`window.saves.at(-1).file === '${file.file}' && parseInt(document.querySelector('.image-preview-toolbar output').value) > 0`,
      file.name + " zooms and saves the correct attachment");
    await capture("viewer-" + file.name);
    await evaluate(`document.querySelector('.image-preview').close();
      [...body.querySelectorAll('.sheet-actions button')].find(button => button.textContent.startsWith(${JSON.stringify(file.name + " / ")})).click()`);
    await check(`window.saves.at(-1).file === '${file.file}'`, file.name + " remains downloadable from card");
    const destination = join(downloads, file.file);
    cli(["attachment", "read", id], { file: file.file, destination });
    assert.equal(createHash("sha256").update(readFileSync(destination)).digest("hex"), file.sha256);
    checks.push(file.name + " CLI download matches SHA-256 " + file.sha256 + ": " + destination);
  }
  await evaluate(`sheet.close(); showTask(window.fixtureTask.id)`);
  for (const file of files) {
    await evaluate(`body.querySelector('.chat-attachment[data-file="${file.file}"]').scrollIntoView({ block: 'center' })`);
    await waitFor(`body.querySelector('.chat-attachment[data-file="${file.file}"] img')?.naturalWidth > 0`);
  }
  checks.push("all image previews reload after reopening the real card");
  const missing = files[0];
  await evaluate(`window.failedFile = '${missing.file}'; sheet.close(); showTask(window.fixtureTask.id)`);
  await evaluate(`body.querySelector('.chat-attachment[data-file="${missing.file}"]').click()`);
  await waitFor(`document.querySelector('.image-preview-status').textContent.includes(${JSON.stringify(missing.name)})`);
  await check(`document.querySelector('.image-preview').open && !document.querySelector('.image-preview-stage img:not([hidden])')`,
    "unavailable images keep a usable viewer with the filename and error");
  assert.deepEqual(cli(["show", id]), task);
  checks.push("the source card, its status, history and revision remain unchanged");
  writeFileSync(join(artifacts, "results.json"), JSON.stringify({ platform: process.platform, electron: process.versions.electron,
    task: id, files, checks: checks.length, passed: checks }, null, 2));
  console.log(`${checks.length} attachment Chromium checks passed`);
  if (keepArtifacts) console.log("Artifacts: " + artifacts);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
