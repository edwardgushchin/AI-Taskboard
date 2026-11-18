// Production renderer in isolated Chromium; synthetic API, no model or real board writes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { electronCheck, localizationFixture } from "./electron-check.mjs";
const { scratch, artifacts } = electronCheck(import.meta.url, "experts", 90_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow } = require("electron");
app.setPath("userData", join(scratch, "profile"));
const read = name => readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8");
const catalog = JSON.parse(readFileSync(new URL("../src/experts/catalog.json", import.meta.url)));
const experts = catalog.map(id => {
  const base = new URL("../src/experts/builtin/" + id + "/", import.meta.url);
  const data = JSON.parse(readFileSync(new URL("expert.json", base)));
  return { ...data, prompt: readFileSync(new URL("system.md", base), "utf8"),
    skills: data.skills.map(skill => skill.file ? { id: skill.id, name: skill.name, content: readFileSync(new URL(skill.file, base), "utf8") } : skill) };
});
const checks = []; const errors = []; let window; let status = 1;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width: 1100, height: 900, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    window.webContents.on("console-message", message => { if (message.level === "error") errors.push(message.message); });
    const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "")
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    const page = join(scratch, "experts.html"); writeFileSync(page, html); await window.loadFile(page);
    const font = readFileSync(new URL("../src/desktop/vendor/codicons/codicon.ttf", import.meta.url)).toString("base64");
    await window.webContents.insertCSS(read("themes.css") + read("styles.css") +
      read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + font));
    const evaluate = code => window.webContents.executeJavaScript(code);
    const check = async (code, name) => { assert.equal(await evaluate(code), true, name); checks.push(name); };
    const settled = () => evaluate("new Promise(r => setTimeout(r, 60))");
    await evaluate(`
      window.taskboard = { subscribe() {}, onChatUpdate() {}, onTheme() {}, bootstrap: () => new Promise(() => {}),
        chatModels: async () => ({ok:true,data:[]}), boardHistory: async () => ({ok:true,data:{turns:[]}}), boardQueue: async () => ({ok:true,data:[]}) };
      ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
      ${read("source-files.cjs")} ${read("markdown.js")} ${read("chat.js")} ${read("review-diff.js")}
      ${localizationFixture()} ${read("renderer.js")}
      window.catalog = ${JSON.stringify(experts)};
      window.calls = [];
      window.parentCard = {id:'T-0001',title:'Команда спринта',revision:1,status:'draft',expertStages:[],history:[],criteria:[],questions:[],subtasks:[],attachments:[],tags:[],description:'',summary:'',nextStep:''};
      frame = {project:'Agent board fixture',board:{project:'Agent board fixture',
        settings:{boardType:'agent', integrationMode:'merge', reviewMode:'reviewer'},tasks:[parentCard],archived:[],tags:[]}};
      api.taskLimits = async () => ({ok:true,data:{executor:1,reviewer:1}});
      api.command = async (action,id,input={}) => {
        calls.push({action,id,input:structuredClone(input)});
        if(action==='experts')return {ok:true,data:catalog.map(({id,name,group,enabled,revision,skills})=>({id,name,group,enabled,revision,skills}))};
        if(action==='expert-get')return {ok:true,data:structuredClone(catalog.find(e=>e.id===input.expertId))};
        if(action==='expert-save'){const value={...input,revision:(input.revision||0)+1}; const old=catalog.findIndex(e=>e.id===value.id);if(old<0)catalog.push(value);else catalog[old]=value;return {ok:true,data:value};}
        if(action==='update'){Object.assign(parentCard,input);return {ok:true,data:parentCard};}
        if(action==='expert-plan')return {ok:true,data:{}};
        if(action==='show')return {ok:true,data:structuredClone(parentCard)};
        return {ok:true,data:[]};
      };
      window.uiReady = expertSettings(); void 0;
    `);
    await evaluate("uiReady");
    await check("document.querySelectorAll('.expert-list > button').length === 220", "all 220 specializations are searchable in settings");
    await evaluate("document.querySelector('.expert-search').value='qa-engineer'; document.querySelector('.expert-search').dispatchEvent(new Event('input')); void 0;");
    await check("document.querySelectorAll('.expert-list > button').length === 1", "search narrows the catalogue to the chosen expert");
    await evaluate("document.querySelector('.expert-list > button').click(); void 0;"); await settled();
    await check("body.querySelector('[name=prompt]').value.includes('QA') && body.querySelectorAll('.expert-skill').length > 1", "role editor shows its system prompt and skills");
    writeFileSync(join(artifacts, "expert-editor.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate("body.querySelector('[name=prompt]').value='Собственные правила QA'; body.querySelector('form').requestSubmit(); void 0;"); await settled();
    await check("calls.some(c=>c.action==='expert-save' && c.input.prompt==='Собственные правила QA' && c.input.revision===1)", "saving edits carries the expected package revision");
    await evaluate("editExpert(undefined,catalog); body.querySelector('[name=name]').value='Новый эксперт'; body.querySelector('[name=group]').value='Свои'; body.querySelector('[name=prompt]').value='Проверь исходные данные'; body.querySelector('form').requestSubmit(); void 0;"); await settled();
    await check("catalog.length===221 && catalog.at(-1).id.startsWith('custom-')", "custom experts are added without provider installation");
    await evaluate("parentCard.expertStages=[{key:'analysis',taskId:'T-0002',title:'Анализ',expertId:'business-analyst'}]; parentCard.history=[{at:new Date().toISOString(),text:'Нужен выбор рынка <img src=x>',messageKind:'question',expertMessage:{from:'T-0002',to:'owner'}}]; openSheet('expert-team','Команда'); expertTeamSection(parentCard); body.append(expertTeamMail(parentCard)); void 0;");
    await check("body.querySelectorAll('.expert-message').length===1 && !body.querySelector('.expert-message img')", "human questions are visible and message HTML remains inert");
    writeFileSync(join(artifacts, "expert-team.png"), (await window.webContents.capturePage()).toPNG());
    await check("!body.querySelector('.task-team-mail button, .task-team-mail textarea')", "expert conversation is read-only for the operator");
    await evaluate(`Object.assign(parentCard, { description: 'Saved draft', approvalRequirements: ['work', 'review'] }); showTask(parentCard.id);`);
    await check(`body.querySelector('.expert-approval-requirements')?.textContent.includes(t("experts.missing_work")) &&
      body.querySelector('.expert-approval-requirements')?.textContent.includes(t("experts.missing_review")) &&
      ![...body.querySelectorAll('button')].some(button => button.textContent === t("ui.approve_535c27a7"))`, "old draft explains both missing leads and prevents approval");
    window.setContentSize(800, 760);
    await evaluate("frame.board.settings.requireExpertPlans = false; boardSettings(); void 0;"); await settled();
    await check("sheet.open && !body.querySelector('[name=requireExpertPlans]')", "legacy settings show no expert plan switch");
    writeFileSync(join(artifacts, "expert-plan-settings.png"), (await window.webContents.capturePage()).toPNG());
    await check("[...body.querySelectorAll('[name$=Limit]')].map(input=>input.placeholder).join(',')==='1,1' && !body.querySelector('[name=managerLimit]')", "board settings inherit one work task and one review task");
    await evaluate("body.querySelector('[name=executorLimit]').value='2'; body.querySelector('[name=reviewerLimit]').value='0'; body.querySelector('form').requestSubmit(); void 0;"); await settled();
    await check("calls.some(c=>c.action==='settings' && c.input.taskLimits?.executor===2 && c.input.taskLimits?.reviewer===0)", "board settings save phase-specific task limits");
    assert.deepEqual(errors, []); checks.push("no renderer errors"); status = 0;
  } catch (error) { console.error(error); errors.push(error.stack); }
  finally {
    writeFileSync(join(artifacts, "ui-checks.json"), JSON.stringify({ result: status === 0 ? "passed" : "failed", checks, errors,
      electron: process.versions.electron, chromium: process.versions.chrome }, null, 2));
    window?.destroy(); console.log("Expert UI checks:", checks.length); app.exit(status);
  }
});
