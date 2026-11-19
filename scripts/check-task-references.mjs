// Real font, Markdown renderer, mouse/keyboard routing and page zoom in Chromium.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { electronCheck } from './electron-check.mjs';

const { scratch, artifacts } = electronCheck(import.meta.url, 'task-references', 60_000);
const { app, BrowserWindow } = await import('electron');
const read = name => readFileSync(new URL('../src/desktop/' + name, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const before = process.argv.includes('--before');
app.setPath('userData', join(scratch, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
try {
  const win = new BrowserWindow({ show: true, width: 800, height: 650, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<main id="samples"></main>');
  const font = readFileSync(new URL('../src/desktop/vendor/codicons/codicon.ttf', import.meta.url)).toString('base64');
  await win.webContents.insertCSS(read('themes.css') + read('vendor/codicons/codicon.css').replace('./codicon.ttf', 'data:font/ttf;base64,' + font) + read('styles.css') +
    'body { display:block; overflow:auto; } #samples { padding:24px; } .sample.board-chat { position:static; display:block; visibility:visible; opacity:1; overflow:visible; transition:none; height:auto; width:auto; max-height:none; margin-bottom:16px; }');
  const ev = code => win.webContents.executeJavaScript(code);
  win.webContents.debugger.attach('1.3');
  await ev(`${readFileSync(require.resolve('markdown-it/browser'), 'utf8')}
    ${read('source-files.cjs')}
    const element = (tag, text, cls) => { const el = document.createElement(tag); if(text) el.textContent=text; if(cls) el.className=cls; return el; };
    let taskInSheet = {id:'T-0086'};
    let opened = [];
    const showTask = id => opened.push(id);
    const protect = fn => fn;
    ${read('markdown.js')}
    const samples = document.querySelector('#samples');
    for (const text of ['До T-0071, после.', 'T-0071: начало абзаца.', 'Конец абзаца T-0071.', '**До T-0071, после.**', '*До T-0071, после.*', 'Узкая строка с задачей T-0071, и продолжением.', 'Версия 0.1.0-alpha, после.', '**Версия 0.1.0-alpha, после.**']) {
      const row = element('section', undefined, 'sample board-chat'); row.append(chatText(text, {})); samples.append(row);
    }
    const plain = element('section', undefined, 'sample board-chat'); plain.append(chatText('До номера, после.', {})); samples.append(plain);
    const globalIcon = element('i', undefined, 'icon codicon codicon-symbol-number'); globalIcon.id='global'; samples.append(globalIcon);
    void 0;`);
  const results = [];
  for (const theme of ['dark', 'light']) for (const width of [800, 320]) for (const zoom of [1, 1.25, 1.5]) {
    win.setSize(width, 800);
    win.webContents.setZoomFactor(zoom);
    await ev(`
      document.documentElement.dataset.palette = '${theme}';
      document.fonts.ready;
    `);
    await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId:root.nodeId, selector:'.chat-task-reference' });
    await win.webContents.debugger.sendCommand('CSS.enable');
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:['hover'] });
    await ev('new Promise(r=>setTimeout(r,200))');
    assert.equal(await ev(`document.querySelector('.chat-task-reference').matches(':hover')`), true);
    if (!before) assert.equal(await ev(`(() => { const a=document.querySelector('.chat-task-reference'), s=getComputedStyle(a); return s.borderBottomStyle==='solid' && s.borderBottomColor===s.color && s.textDecorationLine==='none'; })()`), true);
    const metrics = await ev(`(() => {
      const refs = [...document.querySelectorAll('.chat-task-reference')];
      const icons = [...document.querySelectorAll('.chat-task-reference > .icon, .chat-version > .icon')];
      const first = icons[0], s = getComputedStyle(first);
      return { icon: {width:s.width,height:s.height,font:s.fontSize,verticalAlign:s.verticalAlign,gap:s.marginInlineEnd},
        line: refs[0].closest('p').getBoundingClientRect().height, plainLine: document.querySelectorAll('.sample p')[8].getBoundingClientRect().height,
        intact: refs.every(a => { const r=document.createRange(); r.selectNodeContents(a.lastChild); return a.textContent==='T-0071' && a.dataset.task==='T-0071' && a.getAttribute('href')==='#T-0071' && r.getClientRects().length === 1 && a.getBoundingClientRect().width < innerWidth; }),
        font: icons.every(i => getComputedStyle(i,'::before').fontFamily==='codicon' && i.getAttribute('aria-hidden')==='true'),
        global: getComputedStyle(document.querySelector('#global')).width,
        versions: icons.filter(i=>i.classList.contains('codicon-milestone')).map(i=>({width:getComputedStyle(i).width,height:getComputedStyle(i).height})),
        noOverflow: document.documentElement.scrollWidth <= innerWidth };
    })()`);
    assert.ok(metrics.intact && metrics.font && metrics.noOverflow);
    assert.equal(metrics.global, '16px');
    const backdrop = theme === "dark" ? "rgb(27, 29, 40)" : "rgb(238, 241, 247)";
    assert.equal(await ev("getComputedStyle(document.body).backgroundColor"), backdrop, `${theme} reference backdrop`);
    if (!before) { assert.equal(metrics.icon.width, metrics.icon.font); assert.equal(metrics.icon.height, metrics.icon.font); assert.equal(metrics.line, metrics.plainLine); }
    results.push({theme,width,zoom,...metrics});
    writeFileSync(join(artifacts, `${theme}-${width}-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses:[] });
    if (!before) {
      await ev('new Promise(r=>setTimeout(r,200))');
      assert.equal(await ev(`getComputedStyle(document.querySelector('.chat-task-reference')).borderBottomColor === 'rgba(0, 0, 0, 0)'`), true);
    }
  }
  win.webContents.setZoomFactor(1);
  win.show();
  win.focus();
  await ev(`document.querySelector('.chat-task-reference').focus()`);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await ev('new Promise(r=>setTimeout(r,50))');
  assert.deepEqual(await ev('opened'), ['T-0071']);
  assert.equal(await ev(`document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`), true);
  await ev('new Promise(r=>setTimeout(r,200))');
  if (!before) assert.equal(await ev(`getComputedStyle(document.activeElement).borderBottomColor === getComputedStyle(document.activeElement).color`), true);
  for (const theme of ['dark', 'light']) {
    await ev(`
      document.documentElement.dataset.palette = '${theme}';
      new Promise(resolve => setTimeout(resolve, 200));
    `);
    writeFileSync(join(artifacts, `focus-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  // Click the glyph itself: event.target must route through its enclosing anchor.
  const point = await ev(`(() => { const r=document.querySelector('.chat-task-reference > .icon').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
  win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  await ev('new Promise(r=>setTimeout(r,50))');
  assert.deepEqual(await ev('opened'), ['T-0071','T-0071']);
  writeFileSync(join(artifacts, 'metrics.json'), JSON.stringify({electron:process.versions.electron,chrome:process.versions.chrome,before,results,mouseAndEnter:true,focusVisible:true}, null, 2));
  console.log('PASS: 12 theme/width/zoom combinations; full ID, font, overflow, global icons, mouse, Enter, focus');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { app.exit(process.exitCode ?? 0); }
});

