// Check the shared icon entry point, bundled font and preview controls in Chromium.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { electronCheck } from "./electron-check.mjs";

const root = new URL("../", import.meta.url);
const read = file => readFileSync(new URL(file, root), "utf8");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "icons", 60_000);
const { app, BrowserWindow } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
let window;
app.whenReady().then(async () => {
try {
  window = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const html = read("src/desktop/index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  assert.doesNotMatch(html, /<svg|<use|×/);
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const font = readFileSync(new URL("src/desktop/vendor/codicons/codicon.ttf", root));
  const css = read("src/desktop/vendor/codicons/codicon.css");
  // All CSS code points must resolve to nonzero glyph IDs in the actual bundled TTF.
  let cmap;
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const at = 12 + i * 16;
    if (font.toString("ascii", at, at + 4) === "cmap") cmap = font.readUInt32BE(at + 8);
  }
  let table;
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
    const at = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    if (font.readUInt16BE(at) === 4) table = at;
  }
  assert.ok(table, "font has a BMP cmap");
  const count = font.readUInt16BE(table + 6) / 2;
  for (const match of css.matchAll(/content: "\\([a-f0-9]+)"/g)) {
    const cp = parseInt(match[1], 16);
    let glyph = 0;
    for (let i = 0; i < count; i++) {
      const end = font.readUInt16BE(table + 14 + 2 * i);
      const start = font.readUInt16BE(table + 16 + 2 * count + 2 * i);
      if (cp < start || cp > end) continue;
      const delta = font.readInt16BE(table + 16 + 4 * count + 2 * i);
      const offsetAt = table + 16 + 6 * count + 2 * i;
      const offset = font.readUInt16BE(offsetAt);
      glyph = offset ? font.readUInt16BE(offsetAt + offset + 2 * (cp - start)) : (cp + delta) & 65535;
      if (offset && glyph) glyph = (glyph + delta) & 65535;
      break;
    }
    assert.ok(glyph, "bundled glyph U+" + match[1]);
  }
  await window.webContents.insertCSS(read("src/desktop/themes.css") + css.replace("./codicon.ttf", "data:font/ttf;base64," + font.toString("base64")) + read("src/desktop/styles.css"));
  await window.webContents.insertCSS('#icon-gallery { position: fixed; inset: 40px 10px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; background: var(--bg); z-index: 10; }');
  const require = createRequire(import.meta.url);
  await window.webContents.executeJavaScript(`
    window.taskboard = { subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}) };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${["image-preview.js", "markdown.js", "chat.js", "review-diff.js", "renderer.js"].map(f => read("src/desktop/" + f)).join("\n")}
    void 0;
  `);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const names = [...css.matchAll(/\.codicon-([\w-]+)::before/g)].map(m => m[1]);
  const aliases = ["images", "thought", "tool", "board", "plus", "chevron", "dependency", "attachment", "stop", "microphone", "git-user", "notifications", "git-tag", "chat"];
  for (const theme of ["dark", "light"]) {
    const result = await evaluate(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify("github-" + theme)};
      const gallery = element('section');
      gallery.id = 'icon-gallery';
      for (const name of ${JSON.stringify([...names, ...aliases])}) {
        const row = button(name, () => {});
        row.prepend(icon(name)); gallery.append(row);
      }
      document.body.append(gallery);
      await document.fonts.ready;
      const valid = [...document.querySelectorAll('.icon')].every(node => {
        const style = getComputedStyle(node, '::before');
        return node.classList.contains('codicon') && style.fontFamily === 'codicon' &&
          style.content !== 'none' && style.content !== 'normal' && node.getAttribute('aria-hidden') === 'true';
      });
      const menu = element('button'); menu.className = 'app-menu-item'; menu.setAttribute('aria-checked', 'true');
      gallery.append(menu);
      const checked = getComputedStyle(menu, '::after').fontFamily === 'codicon';
      return valid && checked;
    })()`);
    assert.equal(result, true, theme + " static, shared and CSS icons");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (keepArtifacts) writeFileSync(join(artifacts, "icons-" + theme + ".png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.getElementById('icon-gallery').remove()`);
  }
  for (const russian of [false, true]) {
    await evaluate(`frame = { russian: ${russian} }; openImagePreview('test', [{name:'one.png'}, {name:'two.png'}], 0, null, {preview: async () => null, save: async () => ({ok:true})}); void 0`);
    assert.deepEqual(await evaluate(`(() => {
      const dialog = document.querySelector('.image-preview');
      const controls = [...dialog.querySelectorAll('button:has(.icon)')];
      controls.forEach(button => button.focus());
      return { count: controls.length, named: controls.every(button => button.getAttribute('aria-label') && !button.disabled), focused: dialog.contains(document.activeElement) };
    })()`), { count: 5, named: true, focused: true }, "preview controls have localized names and keyboard focus");
    await evaluate(`new Promise(resolve => { const dialog = document.querySelector('.image-preview'); dialog.addEventListener('close', () => resolve()); dialog.close(); })`);
  }
  console.log(`Icon checks passed: ${names.length} CSS glyphs in TTF; ${aliases.length} aliases; dark/light; English/Russian preview controls.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
}
});
