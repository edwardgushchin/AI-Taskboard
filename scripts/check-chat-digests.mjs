import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { electronCheck } from './electron-check.mjs';

const { scratch, artifacts } = electronCheck(import.meta.url, 'chat-digests', 180_000);
const { app, clipboard, nativeTheme } = await import('electron');
mkdirSync(join(scratch, 'profile'));
app.setPath('userData', join(scratch, 'profile'));
app.setPath('appData', scratch);
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
let window;
const loaded = new Promise(resolve => app.once('browser-window-created', (_, w) => {
  window = w;
  w.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
  w.webContents.once('did-finish-load', resolve);
}));
const baseline = process.argv[process.argv.indexOf('--baseline') + 1];
const before = process.argv.includes('--baseline');
const digest = '0123456789abcdef'.repeat(4);
const commit = 'abcdef0123456789'.repeat(2) + 'abcdef01';
const sample = 'Commit `' + commit + '`, **commit `' + commit + '`**, T-0089 [link](https://example.com).\n\nSHA-256 `' + digest + '` `' + digest + '`.\n\n**SHA-256 `' + digest + '`** and inline `' + 'path_segment_'.repeat(12) + '`.\n\n```text\n' + 'long_code_line_'.repeat(20) + '\n```';
const report = { before, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, cells: [], interactions: [] };
async function run() {
  try {
    await import('../src/desktop/main.ts');
    await loaded;
    window.webContents.setBackgroundThrottling(false);
    window.setMinimumSize(320, 300);
    window.show(); window.focus();
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    await evaluate('api.bootstrap().then(update)');
    if (before) {
      const css = execFileSync('git', ['show', baseline + ':src/desktop/styles.css'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
      await evaluate(`document.querySelector('link[href$="styles.css"]').remove(); void 0`);
      await window.webContents.insertCSS(css);
    }
    await evaluate(`(() => {
      const panel = element('section', undefined, 'board-chat');
      panel.style.cssText = 'position:fixed;inset:40px 0 0;height:auto;opacity:1;visibility:visible';
      const log = element('div', undefined, 'board-chat-log'); panel.append(log); document.body.append(panel);
      frame = { ...frame, project: 'digest-fixture', russian: false, runActivity: {} };
      document.querySelector('main').replaceChildren();
      window.digestSample = ${JSON.stringify(sample)};
      window.renderDigestFixture = mode => {
        log.replaceChildren();
        if (mode === 'history') {
          renderRunActivity(log, JSON.parse(JSON.stringify([{id:'digest',type:'agentMessage',phase:'final_answer',text:digestSample,status:'completed'}])), true, undefined, undefined, {dialogue:true});
        } else {
          renderRunActivity(log, [{id:'digest',type:'agentMessage',phase:'final_answer',text:digestSample,status:mode==='live'?'inProgress':'completed'}], mode==='completed', undefined, undefined, {dialogue:true});
          log.querySelectorAll('details').forEach(n => n.open = true);
        }
      };
      void 0;
    })()`);
    for (const theme of ['light', 'dark']) for (const width of [480, 1100]) for (const zoom of [1, 1.25, 1.5]) for (const mode of ['live', 'completed', 'history']) {
      nativeTheme.themeSource = theme;
      window.setSize(width, 900);
      window.webContents.setZoomFactor(zoom);
      await evaluate(`applyTheme('${theme}'); renderDigestFixture('${mode}'); document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      const geometry = await evaluate(`(() => {
        const log = document.querySelector('.board-chat-log');
        const rect = n => { const r=n.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height}; };
        const bubble = log.querySelector('.board-manager-message') ?? log;
        const bounds=rect(bubble);
        const overflow = [...log.querySelectorAll('.chat-digest, .chat-digest code, .chat-digest .icon, .chat-text p, .chat-code-block, pre, .chat-text a')].filter(n => {const r=rect(n);return r.left < bounds.left-1 || r.right > bounds.right+1}).map(n=>({class:n.className,rect:rect(n)}));
        const inline = [...log.querySelectorAll('.chat-text p code:not(.chat-digest code)')].flatMap(n => [...(() => {const r=document.createRange();r.selectNodeContents(n);return r.getClientRects()})()]).every(r=>r.right<=bounds.right+1);
        const buttons=[...log.querySelectorAll('.chat-digest')];
        return {bounds, overflow, inline, viewport:innerWidth, themeBackground:getComputedStyle(document.body).backgroundColor, scrollWidth:log.scrollWidth, clientWidth:log.clientWidth, digests:buttons.map(b=>({title:b.title,text:b.querySelector('code').textContent,height:rect(b).height,lineHeight:getComputedStyle(b).lineHeight,icon:rect(b.querySelector('.icon')),font:getComputedStyle(b).fontSize,background:getComputedStyle(b).backgroundColor})),preScroll:[...log.querySelectorAll('pre')].every(p=>p.scrollWidth>p.clientWidth)};
      })()`);
      report.cells.push({theme,width,zoom,mode,...geometry});
      if (!before) {
        assert.deepEqual(geometry.overflow, [], JSON.stringify(report.cells.at(-1)));
        assert.ok(geometry.inline);
        assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1);
        assert.ok(geometry.preScroll);
        assert.equal(geometry.digests.length, 5);
        assert.equal(geometry.digests.filter(d=>d.text===digest && d.title===digest).length, 3);
        assert.equal(geometry.digests.filter(d=>d.text===commit.slice(0,7) && d.title===commit).length, 2);
        assert.ok(geometry.digests[0].height <= parseFloat(geometry.digests[0].lineHeight) + 1);
        assert.equal(geometry.digests[0].icon.width, parseFloat(geometry.digests[0].font));
        assert.equal(geometry.digests[0].background, 'rgba(0, 0, 0, 0)');
      }
      if (mode === 'history' && zoom === 1) {
        writeFileSync(join(artifacts, `${before?'before':'after'}-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    if (!before) {
      window.webContents.setZoomFactor(1);
      await evaluate(`renderDigestFixture('history')`);
      for (const index of [0,2,3,4]) {
        await evaluate(`document.querySelectorAll('.chat-digest')[${index}].click(); new Promise(r=>setTimeout(r,50))`);
        assert.equal(await clipboard.readText(), index===0?commit:digest);
        assert.ok(await evaluate(`document.querySelectorAll('.chat-digest')[${index}].querySelector('.codicon-check') !== null`));
      }
      await evaluate(`document.querySelector('.chat-code-copy').click(); new Promise(r=>setTimeout(r,50))`);
      assert.equal((await clipboard.readText()).replaceAll('\r\n','\n'), 'long_code_line_'.repeat(20)+'\n');
      await evaluate(`window.originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = async () => {throw Error('synthetic denied')}; document.querySelector('.chat-digest').click(); new Promise(r=>setTimeout(r,50))`);
      assert.match(await evaluate(`document.querySelector('.chat-digest').getAttribute('aria-label')`), /failed/i);
      await evaluate(`navigator.clipboard.writeText = originalWrite; document.querySelector('.chat-digest').click(); new Promise(r=>setTimeout(r,50))`);
      assert.equal(await clipboard.readText(),commit);
      assert.ok(await evaluate(`document.querySelector('.chat-digest .codicon-check') !== null`));
      await evaluate(`document.querySelector('.chat-digest').focus()`);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await evaluate('new Promise(r=>requestAnimationFrame(r))');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await evaluate('new Promise(r=>setTimeout(r,100))');
      assert.equal(await evaluate(`document.activeElement.matches('.chat-digest:focus-visible') && getComputedStyle(document.activeElement).outlineStyle === 'solid'`),true);
      assert.equal(await clipboard.readText(),commit);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
      await evaluate('new Promise(r=>setTimeout(r,50))');
      assert.equal(await clipboard.readText(),commit);
      assert.equal(await evaluate(`document.querySelector('a[data-task="T-0089"]') !== null`),true);
      await evaluate(`(() => {const range=document.createRange();range.selectNodeContents(document.querySelectorAll('.chat-digest code')[2]);getSelection().removeAllRanges();getSelection().addRange(range)})()`);
      assert.equal(await evaluate('getSelection().toString()'),digest);
      writeFileSync(join(artifacts, 'after-selection.png'), (await window.webContents.capturePage()).toPNG());
      report.interactions.push('full clipboard values, copy/check, forced failure, Tab/Enter/Space, focus-visible, task link, code block copy');
    }
    writeFileSync(join(artifacts, before?'before.json':'after.json'), JSON.stringify(report,null,2)+'\n');
    console.log(`${report.cells.length} geometry cells; ${report.cells.filter(c=>c.overflow.length||!c.inline||c.scrollWidth>c.clientWidth+1).length} overflow cells; interactions: ${report.interactions.join(', ')}`);
  } catch (error) { console.error(error); process.exitCode=1; }
  finally { window?.destroy(); app.exit(process.exitCode??0); }
}
void run();
