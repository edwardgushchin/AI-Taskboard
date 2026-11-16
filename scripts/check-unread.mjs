// Real Chromium checks for the chat renderer, without opening a board or contacting Codex.
// Optional: --artifacts <screenshot directory>; --baseline reproduces the retry failure at HEAD.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "unread", 90000);
const { app, BrowserWindow } = await import("electron");
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const read = name => process.argv.includes("--baseline") && ["chat.js", "renderer.js"].includes(name)
  ? spawnSync("git", ["show", "HEAD:src/desktop/" + name], { cwd: root, encoding: "utf8", windowsHide: true }).stdout
  : readFileSync(join(root, "src", "desktop", name), "utf8");
const require = createRequire(import.meta.url);
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 850, height: 960, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  window.webContents.on("console-message", details => {
    if (details.level === "error") console.error(details.message);
  });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const codicon = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
  const iconStyles = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + codicon);
  await window.webContents.insertCSS(read("themes.css") + "\n" + iconStyles + "\n" + read("styles.css"));
  await window.webContents.executeJavaScript(`
    window.testImages = [];
    window.taskboard = {
      subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
      chatModels: async () => ({ ok: true, data: [{ id: 'test', name: 'Codex', efforts: ['high'], effort: 'high' }] }),
      attachmentPreview: async (_task, file) => window.testImages[Number(file)],
      saveAttachment: async () => ({ ok: true })
    };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${read("review-diff.js")}
    ${read("renderer.js")}
    void 0;
  `);
  const evaluate = (code, userGesture = false) => window.webContents.executeJavaScript(code, userGesture);
  const check = async (code, message) => assert.equal(await evaluate(code), true, message);
  const capture = async name => {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };

  window.show(); window.focus();
  await evaluate(`
    frame = { project: 'fixture', russian: true, managerUnread: ['answer'], tabs:[{path:'fixture',name:'T-0097 fixture',unread:true}] }; renderProjectTabs();
    document.querySelector('#welcome').hidden = true; byId('workspace').hidden = false;
    const reply = { id:'answer', type:'agentMessage', phase:'final_answer', status:'completed', title:'', text:'Fixture reply' };
    api.boardHistory = async () => ({ok:true,data:{turns:[{messages:[],items:[reply]}],nextCursor:null}});
    api.boardQueue = async () => ({ok:true,data:[]});
    let calls = 0, fail = true;
    api.readManagerMessages = async (_project, ids) => { calls++; if(fail) return {ok:false}; frame.managerUnread = frame.managerUnread.filter(id => !ids.includes(id)); frame.tabs[0].unread = !!frame.managerUnread.length; renderProjectTabs(); return {ok:true,data:frame.managerUnread}; };
    const manager = draftComposer(); byId('board-composer').replaceChildren(manager);
    manager.querySelector('.board-draft-field').click();
  `);
  await new Promise(resolve => setTimeout(resolve, 800));
  await check(`calls > 0 && frame.managerUnread.length === 1`, 'failed acknowledgement retains unread');
  await evaluate(`fail = false`);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await check(`frame.managerUnread.length === 0`, 'stationary viewport retries acknowledgement');
  await check(`!manager.querySelector('.board-chat-unread')`, 'divider disappears after last acknowledgement');
  await check(`!document.querySelector('.project-tab-unread')`, 'tab indicator clears');
  await capture('unread-cleared.png');
  await evaluate(`
    const run = element('div');
    renderRunActivity(run, [reply], false, undefined, undefined, {dialogue:true});
    if(run.querySelector('[data-message-id]')?.dataset.messageId !== 'answer') throw new Error('Live completed ID missing');
    renderRunActivity(run, [{...reply,status:'inProgress'}], false, undefined, undefined, {dialogue:true});
    if(run.querySelector('[data-message-id]')) throw new Error('Partial stream marked readable');
    renderRunActivity(run, [reply,{id:'steer',userMessage:{text:'Next request',files:[]},type:'userMessage',title:'',text:'',status:'completed'}], true, undefined, undefined, {dialogue:true,userMessage:()=>element('div')});
    const earlier = run.querySelector('[data-message-id="answer"]');
    if(!earlier || earlier.closest('.chat-work')) throw new Error('Earlier final reply is unreachable');
    manager.invalidateHistory();
  `);
  await new Promise(resolve => setTimeout(resolve, 250));
  await check(`!manager.querySelector('.board-chat-unread')`, 'history reload does not restore divider');

  await evaluate(`
    const log = manager.querySelector('.board-chat-log:not(.board-work)');
    const pause = () => new Promise(resolve => setTimeout(resolve, 650));
    const reset = () => { frame.managerUnread = ['answer']; manager.syncManagerUnread(frame.managerUnread); };
    let focused = true;
    document.hasFocus = () => focused;
    focused = false; reset();
  `);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'inactive window retains unread');
  await evaluate(`focused = true; log.hidden = true; reset()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'work/hidden dialogue retains unread');
  await evaluate(`log.hidden = false; manager.removeAttribute('data-open'); reset()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'closed dialogue retains unread');
  await evaluate(`manager.setAttribute('data-open',''); frame.project = 'other'; reset()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'background project retains unread');
  await evaluate(`frame.project = 'fixture'; manager.style.display = 'none'; reset()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'hidden window content retains unread');
  await evaluate(`
    manager.style.display = '';
    const bubble = log.querySelector('[data-message-id="answer"]');
    const filler = element('div'); filler.style.height = '1200px'; filler.style.flexShrink = '0'; log.append(filler);
    log.scrollTop = log.scrollHeight; reset();
  `);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.includes('answer')`, 'message above viewport retains unread');
  await evaluate(`
    filler.remove(); bubble.style.minHeight = '1000px'; log.scrollTop = 0; reset();
  `);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`!frame.managerUnread.includes('answer')`, 'long message is read when its beginning is visible');
  await evaluate(`
    bubble.style.minHeight = '';
    const held = Promise.withResolvers();
    api.readManagerMessages = async (_project, ids) => { calls++; await held.promise;
      frame.managerUnread = frame.managerUnread.filter(id => !ids.includes(id));
      return {ok:true,data:frame.managerUnread}; };
    reset();
  `);
  await new Promise(resolve => setTimeout(resolve, 150));
  await evaluate(`frame.managerUnread.push('new-unseen'); manager.syncManagerUnread(frame.managerUnread); held.resolve()`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await check(`frame.managerUnread.length === 1 && frame.managerUnread[0] === 'new-unseen'`, 'arrival during acknowledgement is preserved');
  await evaluate(`manager.dispose()`);

  console.log('Unread Chromium checks passed');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  window?.destroy(); app.exit(process.exitCode ?? 0);
});
