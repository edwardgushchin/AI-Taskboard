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
const shortIds = ['190cb97', 'ABCDEF12', 'abcd', '1'.repeat(39)];
const sample = 'Commit `' + commit + '`, **commit `' + commit + '`**, T-0089 [link](https://example.com).\n\nSHA-256 `' + digest + '` `' + digest + '`.\n\n**SHA-256 `' + digest + '`** and inline `' + 'path_segment_'.repeat(12) + '`.\n\n```text\n' + 'long_code_line_'.repeat(20) + '\n```' +
  '\n\nКоммит 190cb97; **commit** `ABCDEF12`; commit abcd; коммит `' + shortIds[3] + '`.\n\n' +
  '190cb97 1234567 decafbad; commit src/190cb97; commit 190cb97.txt; commit [190cb97](https://example.com); commit `git show 190cb97`.\n\n```text\nКоммит 190cb97\n```';
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
        const context = mode.startsWith('task-') ? {taskId:'T-0141'} : {dialogue:true};
        mode = mode.replace('task-', '');
        if (mode === 'history') {
          renderRunActivity(log, JSON.parse(JSON.stringify([{id:'digest',type:'agentMessage',phase:'final_answer',text:digestSample,status:'completed'}])), true, undefined, undefined, context);
        } else {
          renderRunActivity(log, [{id:'digest',type:'agentMessage',phase:'final_answer',text:digestSample,status:mode==='live'?'inProgress':'completed'}], mode==='completed', undefined, undefined, context);
        }
        log.querySelectorAll('details').forEach(n => n.open = true);
      };
      void 0;
    })()`);
    for (const theme of ['light', 'dark']) for (const width of [480, 1100]) for (const zoom of [1, 1.25, 1.5]) for (const mode of ['live', 'completed', 'history', 'task-live', 'task-completed', 'task-history']) {
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
        return {bounds, overflow, inline, viewport:innerWidth, themeBackground:getComputedStyle(document.body).backgroundColor, scrollWidth:log.scrollWidth, clientWidth:log.clientWidth, digests:buttons.map(b=>({title:b.title,text:b.querySelector('code').textContent,height:rect(b).height,lineHeight:getComputedStyle(b).lineHeight,icon:rect(b.querySelector('.icon')),font:getComputedStyle(b).fontSize,background:getComputedStyle(b).backgroundColor})),preScroll:log.querySelector('pre').scrollWidth>log.querySelector('pre').clientWidth};
      })()`);
      report.cells.push({theme,width,zoom,mode,...geometry});
      if (!before) {
        assert.deepEqual(geometry.overflow, [], JSON.stringify(report.cells.at(-1)));
        assert.ok(geometry.inline);
        assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1);
        assert.ok(geometry.preScroll);
        assert.equal(geometry.digests.length, 9);
        assert.deepEqual(geometry.digests.slice(5).map(d => [d.text, d.title]), shortIds.map(id => [id.slice(0, 7), id]));
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
    // Cover the cascade outside the board dialogue, including description code backgrounds.
    report.alignment = [];
    for (const theme of ['light', 'dark']) for (const width of [480, 1100]) for (const zoom of [1, 1.25, 1.5]) for (const context of ['task', 'description', 'coordination']) for (const state of ['copy', 'check']) {
      nativeTheme.themeSource = theme;
      window.setSize(width, 900);
      window.webContents.setZoomFactor(zoom);
      await evaluate(`(() => {
        applyTheme('${theme}');
        const log = document.querySelector('.board-chat-log');
        const wrapper = element('section', undefined, '${context}' === 'description' ? 'sheet-section task-sheet-description' : '${context}' === 'coordination' ? 'chat-entry chat-coordination' : 'chat-entry');
        wrapper.dataset.actor = 'agent';
        log.replaceChildren(wrapper);
        wrapper.append(chatText(digestSample, {agent:${context !== 'description'}, coordination:${context === 'coordination'}}));
        if ('${state}' === 'check') wrapper.querySelectorAll('.codicon-copy').forEach(n=>n.classList.replace('codicon-copy','codicon-check'));
      })()`);
      await evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
      const rows = await evaluate(`(() => [...document.querySelectorAll('.chat-digest')].map(b => {
        const c=b.querySelector('code'), i=b.querySelector('.icon'), s=getComputedStyle(b), cs=getComputedStyle(c);
        const cr=c.getBoundingClientRect(), ir=i.getBoundingClientRect(), br=b.getBoundingClientRect();
        return {text:c.textContent, lineHeight:parseFloat(getComputedStyle(c).lineHeight), topDelta:ir.top-cr.top, iconHeight:ir.height, height:br.height, gap:ir.left-cr.right, left:cr.left-br.left, right:br.right-ir.right, codePadding:cs.padding, background:cs.backgroundColor};
      }))()`);
      report.alignment.push({theme,width,zoom,context,state,rows});
      if (!before) assert.equal(rows.length, 9);
      if (!before) for (const r of rows) {
        assert.ok(Math.abs(r.topDelta) < 1, JSON.stringify(r));
        assert.ok(Math.abs(r.iconHeight-r.lineHeight) < 1, JSON.stringify(r));
        assert.ok(Math.abs(r.left-r.right) < 1, JSON.stringify(r));
        assert.ok(r.gap > 2 && r.gap < 6, JSON.stringify(r));
        assert.equal(r.codePadding, '0px');
        assert.equal(r.background, 'rgba(0, 0, 0, 0)');
        if(r.text.length===7) assert.ok(r.height <= r.lineHeight+1);
      }
      if (zoom===1 && context==='description') writeFileSync(join(artifacts, `${before?'before':'after'}-alignment-${theme}-${width}-${state}.png`), (await window.webContents.capturePage()).toPNG());
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
      assert.equal(await evaluate(`document.querySelector('.chat-digest').getAttribute('aria-label') === t('ui.copy_failed_retry_eeb3cc51')`), true);
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
      for (let index = 0; index < shortIds.length; index++) {
        const selector = `document.querySelectorAll('.chat-digest')[${index + 5}]`;
        await evaluate(`${selector}.focus()`);
        await clipboard.clear();
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
        window.webContents.sendInputEvent({type:'char',keyCode:'\r'});
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
        await evaluate('new Promise(r=>setTimeout(r,50))');
        assert.equal(await clipboard.readText(), shortIds[index]);
        assert.equal(await evaluate(`${selector}.title`), shortIds[index]);
        assert.equal(await evaluate(`${selector}.getAttribute('aria-label').includes(t('ui.copy_full_hash_725de55a'))`), false);
        await clipboard.clear();
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
        await evaluate('new Promise(r=>setTimeout(r,50))');
        assert.equal(await clipboard.readText(), shortIds[index]);
      }
      report.interactions.push('short IDs: original tooltip and clipboard, Enter/Space, no full-SHA promise');
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
