// Check the shared icon entry point, bundled font and preview controls in Chromium.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { electronCheck, localizationFixture } from "./electron-check.mjs";

const root = new URL("../", import.meta.url);
const read = file => readFileSync(new URL(file, root), "utf8");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "icons", 120_000);
const { app, BrowserWindow } = await import("electron");
app.setPath("userData", join(scratch, "profile"));
app.disableHardwareAcceleration();
let window;
app.whenReady().then(async () => {
try {
  window = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
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
    ${localizationFixture()}
    ${["image-preview.js", "source-files.cjs", "markdown.js", "chat.js", "review-diff.js", "renderer.js"].map(f => read("src/desktop/" + f)).join("\n")}
    void 0;
  `);
  const evaluate = code => window.webContents.executeJavaScript(code);
  const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async name => {
    await paint();
    if (keepArtifacts) writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  window.webContents.debugger.attach("1.3");
  const names = [...css.matchAll(/\.codicon-([\w-]+)::before/g)].map(m => m[1]);
  const aliases = ["images", "thought", "tool", "board", "plus", "chevron", "dependency", "attachment", "stop", "microphone", "git-user", "notifications", "git-tag", "chat"];
  for (const theme of ["dark", "light"]) {
    const backdrop = theme === "dark" ? "rgb(27, 29, 40)" : "rgb(238, 241, 247)";
    const result = await evaluate(`(async () => {
      document.documentElement.dataset.palette = '${theme}';
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
    assert.equal(await evaluate("getComputedStyle(byId('icon-gallery')).backgroundColor"), backdrop, `${theme} gallery background`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (keepArtifacts) writeFileSync(join(artifacts, "icons-" + theme + ".png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(`document.getElementById('icon-gallery').remove()`);
  }
  for (const russian of [false, true]) {
    await evaluate(`localization.select(${russian} ? 'ru' : 'en'); frame = { russian: ${russian} }; openImagePreview('test', [{name:'one.png'}, {name:'two.png'}], 0, null, {preview: async () => null, save: async () => ({ok:true})}); void 0`);
    assert.deepEqual(await evaluate(`(() => {
      const dialog = document.querySelector('.image-preview');
      const controls = [...dialog.querySelectorAll('button:has(.icon)')];
      controls.forEach(button => button.focus());
      return { count: controls.length, named: controls.every(button => button.getAttribute('aria-label') && !button.disabled), focused: dialog.contains(document.activeElement) };
    })()`), { count: 5, named: true, focused: true }, "preview controls have localized names and keyboard focus");
    await evaluate(`new Promise(resolve => { const dialog = document.querySelector('.image-preview'); dialog.addEventListener('close', () => resolve()); dialog.close(); })`);
  }
  // Exercise the shared status entry point for both callers and every active role.
  const spinnerResults = [];
  for (const theme of ["dark", "light"]) {
    await evaluate(`document.documentElement.dataset.palette = '${theme}'`);
    console.log("Checking returned conditions: " + theme);
    for (const motion of ["no-preference", "reduce"]) {
      await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: motion }],
      });
      assert.equal(await evaluate(`(() => {
        for (const russian of [false, true]) {
          localization.select(russian ? 'ru' : 'en');
          const language = (en, ru) => russian ? ru : en;
          for (const caller of ['task-stat task-run-status', 'task-run-status']) {
            const target = element('span', undefined, caller);
            document.body.append(target);
            const task = { id: 'T-0001', status: 'in_progress', codexThreadId: 'test' };
            for (const role of ['agent', 'reviewer', 'manager']) {
              frame = { russian, runningTasks: role === 'agent' ? [task.id] : [],
                reviewingTasks: role === 'agent' ? {} : { [task.id]: role } };
              renderAgentRunStatus(target, task);
              const glyph = target.firstElementChild;
              const expected = role === 'agent' ? language('Agent is working', 'Агент работает') :
                role === 'reviewer' ? language('Reviewer is reviewing', 'Проверяет ревьюер') :
                language('Project manager is reviewing', 'Проверяет менеджер проекта');
              const style = getComputedStyle(glyph);
              if (!glyph.matches('.codicon-sync.agent-spinner') || glyph.hasAttribute('aria-hidden') ||
                  glyph.getAttribute('role') !== 'status' || glyph.getAttribute('aria-label') !== expected ||
                  glyph.title !== expected || style.borderTopWidth !== '0px' ||
                  style.fontSize !== '12px' || style.width !== (target.matches('.task-stat') ? '14px' : '12px') ||
                  style.height !== '12px' ||
                  getComputedStyle(glyph, '::before').fontFamily !== 'codicon' ||
                  (style.animationName === 'none') !== ${motion === "reduce"}) return false;
              renderAgentRunStatus(target, task);
              if (target.firstElementChild !== glyph) return false;
            }
            frame.runningTasks = []; frame.reviewingTasks = {};
            renderAgentRunStatus(target, task);
            if (target.querySelector('.agent-spinner') || target.hidden || !target.textContent) return false;
            renderAgentRunStatus(target, { id: task.id, status: 'done' });
            if (!target.hidden || target.textContent) return false;
            target.remove();
          }
        }
        return true;
      })()`), true, `${theme}/${motion}: active roles, reuse, idle and stopped in board/card callers`);
      for (const width of [1000, 720]) {
        window.setContentSize(width, 600);
        await paint();
        for (const [role, label] of [["agent", "Agent is working"], ["reviewer", "Reviewer is reviewing"],
          ["manager", "Project manager is reviewing"]]) {
          for (const multiline of [false, true]) {
            const metrics = await evaluate(`(() => {
              localization.select('en');
              const task = { id: 'T-0001', status: 'in_progress',
                title: ${multiline
                  ? "'Verify the active task indicator next to the heading as the title wraps across several lines in the open task window'"
                  : "'Verify the task indicator'"} };
              frame = { russian: false, runningTasks: ${role === "agent"} ? [task.id] : [],
                reviewingTasks: { [task.id]: ${JSON.stringify(role)} } };
              openTaskSheet(task);
              const title = byId('sheet-title'), glyph = title.querySelector('.agent-spinner');
              const style = getComputedStyle(glyph);
              const range = document.createRange();
              range.selectNode(title.firstChild);
              const lines = [...range.getClientRects()], last = lines.at(-1);
              const animation = glyph.getAnimations()[0];
              if (animation) {
                animation.pause();
                animation.currentTime = 100;
              }
              const bounds = glyph.getBoundingClientRect();
              const header = title.getBoundingClientRect();
              const close = byId('close-sheet').getBoundingClientRect();
              return { fontSize: style.fontSize, width: style.width, height: style.height,
                titleSize: getComputedStyle(title).fontSize, lines: lines.length,
                gap: bounds.left - last.right,
                offset: Math.abs((bounds.top + bounds.bottom - last.top - last.bottom) / 2),
                inside: bounds.top >= header.top - .5 && bounds.bottom <= header.bottom + .5 &&
                  bounds.right <= header.right && bounds.right < close.left,
                label: glyph.getAttribute('aria-label'), role: glyph.getAttribute('role'),
                spinning: style.animationName === 'agent-spin' };
            })()`);
            const scenario = `${theme}/${width}/${motion}/${role}/${multiline ? "wrapped" : "single"}`;
            spinnerResults.push({ scenario, ...metrics });
            assert.deepEqual([metrics.fontSize, metrics.width, metrics.height], Array(3).fill(metrics.titleSize), scenario);
            assert.equal(metrics.lines > 1, multiline, scenario);
            assert.ok(metrics.gap >= 3 && metrics.gap <= 9 && metrics.offset <= 4 && metrics.inside, scenario);
            assert.equal(metrics.role, "status", scenario);
            assert.equal(metrics.label, label, scenario);
            assert.equal(metrics.spinning, motion === "no-preference", scenario);
            if (role === "agent" && motion === "reduce" && width === (multiline ? 720 : 1000)) {
              await capture(`task-spinner-${theme}-${width}-${multiline ? "wrapped" : "single"}.png`);
            }
          }
        }
      }
      await evaluate("byId('close-sheet').click()");
      await paint();
    }
    window.setContentSize(1000, 800);
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    // Real manager submit/stop workflow, independent of unrelated chat layout assertions.
    for (const russian of [false, true]) {
      console.log(`Checking manager Stop: ${theme}/${russian ? "ru" : "en"}`);
      await evaluate(`(async () => {
        localization.select(${russian} ? 'ru' : 'en'); frame = { project: 'icon-fixture', russian: ${russian}, runningTasks: [] };
        const turn = Promise.withResolvers();
        const ready = Promise.withResolvers();
        window.iconStopCalls = 0;
        api.boardHistory = async () => ({ ok: true, data: { turns: [] } });
        api.boardQueue = async (_project, action) => ({ ok: true, data: action === 'list' ? [] : 'request' });
        api.boardRequest = () => { iconManager.enableStop(); ready.resolve(); return turn.promise; };
        api.stopOrchestrator = async () => { iconStopCalls++; turn.resolve({ ok: true, data: {} }); return { ok: true }; };
        window.iconManager = draftComposer();
        byId('board-composer').replaceChildren(iconManager);
        byId('workspace').hidden = false;
        iconManager.querySelector('.draft-input textarea').value = 'Check icons';
        iconManager.requestSubmit();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Manager fixture did not start: ' +
            iconManager.textContent + '; valid=' + iconManager.checkValidity())), 3000);
          ready.promise.then(() => { clearTimeout(timer); resolve(); });
        });
      })()`);
      await paint();
      assert.equal(await evaluate(`(() => {
        const button = iconManager.querySelector('.draft-send');
        button.focus();
        const glyph = button.querySelector('.codicon-stop-circle');
        const rect = button.getBoundingClientRect(), bounds = glyph.getBoundingClientRect();
        const style = getComputedStyle(button);
        return !button.disabled && button.getAttribute('aria-label') === (${russian} ? 'Остановить ответ' : 'Stop reply') &&
          document.activeElement === button && rect.width === 28 && rect.height === 28 &&
          bounds.width === 22 && bounds.height === 22 && Math.abs(bounds.left - rect.left - 3) < .1 &&
          Math.abs(bounds.top - rect.top - 3) < .1 &&
          getComputedStyle(glyph, '::before').content.includes(String.fromCharCode(0xeba5)) &&
          style.backgroundColor === ${JSON.stringify(theme === "dark" ? "rgb(191, 189, 182)" : "rgb(61, 61, 58)")} &&
          style.color === ${JSON.stringify(theme === "dark" ? "rgb(38, 42, 48)" : "rgb(255, 255, 255)")};
      })()`), true, `${theme}/${russian ? "ru" : "en"}: manager Stop font, contrast, geometry and keyboard focus`);
      if (russian) await capture(`manager-stop-${theme}.png`);
      await evaluate(`iconManager.querySelector('.draft-send').click()`);
      await paint();
      assert.equal(await evaluate(`iconStopCalls === 1 && iconManager.querySelector('.draft-send').matches('[data-action="send"]') && !!iconManager.querySelector('.codicon-arrow-up')`),
        true, "focused manager Stop action restores Send");
      await evaluate(`iconManager.dispose(); iconManager.remove()`);
    }
    // Use the real tab renderer and key handlers with a local project-selection adapter.
    await evaluate(`
      frame = { project: 'first', russian: true, tabs: [
        { path: 'first', name: 'Первая доска' }, { path: 'second', name: 'Вторая доска', unread: true } ] };
      api.selectTab = async path => { frame.project = path; renderProjectTabs(); };
      api.closeTab = async path => {
        frame.tabs = frame.tabs.filter(tab => tab.path !== path);
        if (frame.project === path) frame.project = frame.tabs[0]?.path;
        renderProjectTabs();
      };
      renderProjectTabs(); void 0;
    `);
    assert.equal(await evaluate(`[...byId('project-tabs').querySelectorAll('.project-tab-close')].every(button =>
      button.getAttribute('aria-label').startsWith('Закрыть проект ') &&
      getComputedStyle(button.querySelector('.codicon-close'), '::before').fontFamily === 'codicon') &&
      !!byId('project-tabs').querySelector('.codicon-circle-filled')`), true, theme + ": tab close/unread font and names");
    for (const [key, project] of [["ArrowRight", "second"], ["ArrowLeft", "first"], ["End", "second"], ["Home", "first"], ["ArrowDown", "second"], ["ArrowUp", "first"]]) {
      await evaluate(`byId('project-tabs').querySelector('[aria-selected="true"]').focus()`);
      await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
      await paint();
      assert.equal(await evaluate(`frame.project === ${JSON.stringify(project)} && document.activeElement.getAttribute('aria-selected') === 'true'`), true, theme + ": " + key);
    }
    await capture(`tabs-${theme}.png`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))`);
    await paint();
    assert.equal(await evaluate(`frame.tabs.length === 1 && frame.project === 'second' && document.activeElement.getAttribute('aria-selected') === 'true'`), true, theme + ": Delete closes selected tab and focuses next");
    await evaluate(`byId('project-tabs').querySelector('.project-tab-close').focus()`);
    await evaluate(`document.activeElement.click()`);
    await paint();
    assert.equal(await evaluate(`!frame.tabs.length && byId('project-tabs').hidden`), true, theme + ": focused close button closes last tab");
  }
  console.log(`Icon checks passed: ${names.length} CSS glyphs in TTF; ${aliases.length} aliases; dark/light; English/Russian preview controls.`);
  console.log(`Task heading spinner checks passed: ${spinnerResults.length} scenarios on Electron ${process.versions.electron}.`);
  if (keepArtifacts) writeFileSync(join(artifacts, "task-spinner-report.json"), JSON.stringify({
    electron: process.versions.electron, node: process.versions.node, platform: process.platform, scenarios: spinnerResults,
  }, null, 2));
  console.log('Returned criteria passed: agent/reviewer/manager status in both callers and motion modes; manager Stop action/focus; tabs arrows/Home/End/Delete and close action/focus; dark/light.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
}
});
