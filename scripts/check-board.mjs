// Real Chromium regression checks for board refreshes, with a local fixture and no Codex calls.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck, localizationFixture } from "./electron-check.mjs";
import { checkShowMore } from "./check-show-more.mjs";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const require = createRequire(import.meta.url);
const cardSpacingOnly = process.argv.includes("--card-spacing");
const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "board",
  process.argv.includes("--settings-only") ? 300_000 : 180_000);
const { app, BrowserWindow, nativeTheme } = await import("electron");
const profile = join(scratch, "profile");
mkdirSync(profile);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const read = name => readFileSync(join(root, "src", "desktop", name), "utf8");
let window;
let checks = 0;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1380, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
  const html = read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*>/g, "").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const iconFont = readFileSync(join(root, "src/desktop/vendor/codicons/codicon.ttf")).toString("base64");
  const iconStyles = read("vendor/codicons/codicon.css").replace("./codicon.ttf", "data:font/ttf;base64," + iconFont);
  await window.webContents.insertCSS(read("themes.css") + "\n" + iconStyles + "\n" + read("styles.css"));
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate(`document.fonts.load('16px codicon')`);
  const hover = async selector => {
    const point = await evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    return point;
  };
  const click = async selector => {
    const point = await hover(selector);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await evaluate(`settle()`);
  };
  const clickBoard = () => click("#lanes .lane-title");
  const clickManagerField = () => click(".draft-input textarea");
  const capture = async name => {
    // Hidden windows can paint a transition one compositor frame behind layout.
    await window.webContents.capturePage();
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  const check = async (code, message) => {
    assert.equal(await evaluate(code), true, message);
    checks++;
  };
  await check(`document.querySelector('#welcome').hidden`, "welcome is hidden before the first project snapshot");
  await check(`!/Загрузка проектов|Loading projects/.test(document.body.innerText)`, "initial HTML has no projects loading label");
  await evaluate(`
    window.previewCalls = 0;
    const savedQueue = new Map();
    window.taskboard = {
      subscribe(callback) { window.pushBoard = next => { window.taskboardLocalization.select(next.russian === false ? 'en' : 'ru'); callback({...next, localization: window.taskboardLocalization.state()}); }; }, onChatUpdate(callback) { window.pushChat = callback; }, onTheme() {},
      boardHistory: async (_project, _cursor, view) => ({ ok: true, data: view === 'live'
        ? { work: [], chat: [] } : { turns: [], model: "gpt-board-test" } }),
      taskLimits: async () => ({ ok: true, data: { executor: 3, manager: 1, reviewer: 1 } }),
      boardQueue: async (project, action, id, draft, goal, files) => {
        const jobs = savedQueue.get(project) ?? new Map();
        savedQueue.set(project, jobs);
        if (action === 'list') return { ok: true, data: [...jobs.values()] };
        if (action === 'add') {
          id = 'message-' + (jobs.size + 1) + '-' + Math.random();
          jobs.set(id, { id, draft, goal, files });
        } else if (action === 'edit') jobs.get(id).draft = draft;
        else if (action === 'remove') jobs.delete(id);
        return { ok: true, data: id };
      },
      bootstrap: () => new Promise((_resolve, reject) => { window.rejectBootstrap = reject; }),
      attachmentPreview: async (_task, file) => {
        window.previewCalls++;
        if (file === 'missing.png') throw new Error('Unavailable preview');
        const preview = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#507e9b"/><text x="20" y="70" fill="white" font-size="24">Task preview</text></svg>');
        if (file === 'delayed.png') return new Promise(resolve => { window.releasePreview = () => resolve(preview); });
        return preview;
      }
    };
    ${readFileSync(require.resolve("markdown-it/browser"), "utf8")}
    ${read("image-preview.js")}
    ${read("review-diff.js")}
    ${read("source-files.cjs")}
    ${read("markdown.js")}
    ${read("chat.js")}
    ${localizationFixture()}
    ${read("renderer.js")}
    void 0;
  `);
  await evaluate(`
    const task = (id, title, extra = {}) => ({ id, title, status: 'ready', revision: 1, priority: 'normal',
      createdAt: '2026-11-01T12:00:00.000Z', updatedAt: extra.createdAt ?? '2026-11-01T12:00:00.000Z',
      tags: [], subtasks: [], attachments: [], history: [], questions: [], ...extra });
    const fixture = { project: 'board-fixture', russian: true, theme: 'dark', runningTasks: [],
      board: { settings: { archiveAfterDays: 90, integrationMode: 'merge' },
        tags: [{ name: 'UI', color: '#91B6F9' }], archived: [], tasks: [
        task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
        task('T-0002', 'Обновляемая карточка', { tags: ['UI'], createdAt: '2026-11-02T12:00:00.000Z' })
      ] } };
    const push = () => window.pushBoard(structuredClone(fixture));
    const lane = state => document.querySelector('.lane[data-state="' + state + '"]');
    const findCard = id => [...document.querySelectorAll('.task-card')].find(node => node.querySelector('.task-id').textContent === id);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const waitFor = predicate => new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => predicate() ? resolve() : Date.now() > deadline ? reject(new Error('Timed out waiting for ' + predicate)) : setTimeout(poll, 16);
      poll();
    });
    window.pushBoard({ russian: true, restoring: true });
    void 0;
  `);
  if (process.argv.includes("--show-more")) {
    await checkShowMore({ window, evaluate, check, click, capture, artifacts, root });
    console.log(`Show More Chromium checks passed: ${checks}`);
    return;
  }
  if (process.argv.includes("--subtask-fill")) {
    const { checkSubtaskFill } = await import("./check-subtask-fill.mjs");
    await checkSubtaskFill({ window, evaluate, check, artifacts, root });
    return;
  }
  if (cardSpacingOnly) {
    window.setContentSize(1280, 800);
    await evaluate(`
      const fullCard = {
        status: 'in_progress', priority: 'high',
        description: 'Review the spacing of the description, tags, preview and progress.',
        tags: ['Interface', 'Cards', 'Electron', 'Keyboard access', 'LongUnbrokenTagForWrapping'],
        milestone: { title: 'Release 0.1.0', repository: 'example/board', number: 1 },
        attachments: [{ file: 'cover.png', name: 'cover.png' }],
        subtasks: [{ title: 'Layout', done: true }, { title: 'Verify', done: false }],
      };
      fixture.board.tasks = [
        task('T-0100', 'Check a long title and metadata in a narrow card', fullCard),
        task('T-0101', 'Card with hidden preview', {
          ...fullCard, status: 'review',
          milestone: { ...fullCard.milestone, title: 'Very long milestone title requiring an ellipsis' },
          attachments: [{ file: 'missing.png', name: 'missing.png' }],
        }),
        task('T-0102', 'Card without progress', { ...fullCard, status: 'ready', subtasks: [] }),
        task('T-0103', 'Short card', { status: 'draft' }),
      ];
      fixture.runningTasks = ['T-0100', 'T-0101'];
      fixture.waitingTasks = ['T-0102'];
      window.taskboard.command = async () => new Promise(() => {});
      push();
      waitFor(() => findCard('T-0100')?.querySelector('.task-card-cover:not([hidden])')?.naturalWidth > 0 &&
        findCard('T-0102')?.querySelector('.task-card-cover:not([hidden])')?.naturalWidth > 0 &&
        window.previewCalls >= 3);
    `);
    const report = [
      `${process.platform}/${process.arch}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; Node ${process.versions.node}`,
      "Command: node scripts/check-board.mjs --card-spacing --artifacts .tasks/qa",
    ];
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      const panel = theme === "dark" ? "rgb(34, 37, 50)" : "rgb(255, 255, 255)";
      await evaluate(`
        applyTheme(${JSON.stringify(theme)});
        waitFor(() => getComputedStyle(findCard('T-0100')).backgroundColor === ${JSON.stringify(panel)});
      `);
      for (const narrow of [false, true]) {
        await evaluate(`
          document.querySelectorAll('.task-card').forEach(node => {
            node.style.width = ${JSON.stringify(narrow ? "120px" : "")};
          });
          settle();
        `);
        const measurement = await evaluate(`(() => {
          const assertLayout = (condition, detail) => { if (!condition) throw new Error(detail); };
          const near = (a, b) => Math.abs(a - b) < 0.05;
          const rect = node => node.getBoundingClientRect();
          assertLayout(innerWidth === 1280 && innerHeight === 800, '1280x800 viewport');
          const expected = [6, 5, 5, 2];
          return fixture.board.tasks.map(({ id }, index) => {
            const card = findCard(id);
            const details = card.querySelector('.task-card-details');
            const bounds = rect(details);
            const blocks = [...details.children].filter(node => !node.hidden);
            const first = rect(blocks[0]);
            const last = rect(blocks.at(-1));
            const left = first.left - bounds.left;
            const right = bounds.right - first.right;
            const gaps = blocks.slice(1).map((node, i) => rect(node).top - rect(blocks[i]).bottom);
            assertLayout(blocks.length === expected[index], id + ': visible blocks');
            assertLayout(!${narrow} || rect(card).width === 120, id + ': narrow width');
            assertLayout(near(left, right) && near(left, 8.96) &&
              near(first.top - bounds.top, 11) && near(bounds.bottom - last.bottom, 11), id + ': equal padding');
            assertLayout(gaps.every(gap => near(gap, 10)), id + ': block gaps ' + gaps);
            assertLayout(blocks.every(node => near(rect(node).left, first.left) &&
              near(rect(node).right, first.right)), id + ': common edges');
            const meta = card.querySelector('.task-meta');
            const tags = card.querySelector('.task-tags');
            for (const group of [tags, meta, card.querySelector('.task-card-footer')].filter(Boolean)) {
              const style = getComputedStyle(group);
              assertLayout(style.rowGap === '4px' && style.columnGap === '6px', id + ': group gaps');
              const boxes = [...group.children].map(rect);
              boxes.forEach((a, i) => {
                assertLayout(a.left >= first.left - 0.05 && a.right <= first.right + 0.05, id + ': group overflow');
                assertLayout(boxes.slice(i + 1).every(b => a.right <= b.left || b.right <= a.left ||
                  a.bottom <= b.top || b.bottom <= a.top), id + ': group overlap');
              });
            }
            const tagRows = tags ? new Set([...tags.children].map(node => rect(node).top)).size : 0;
            if (${narrow} && tags) assertLayout(tagRows > 1, id + ': tags wrap');
            const spinner = card.querySelector('.agent-spinner');
            if (index < 2) assertLayout(spinner?.getAttribute('role') === 'status' &&
              spinner.getAttribute('aria-label') && meta.querySelector('.task-id').textContent === id &&
              meta.querySelector('.task-milestone').title && meta.lastElementChild.textContent === '1',
              id + ': metadata and accessible running indicator');
            if (id === 'T-0102') {
              const queued = card.querySelector('.task-card-footer .task-queue-indicator');
              assertLayout(queued?.getAttribute('aria-label') && rect(queued).left >= rect(meta).right,
                id + ': accessible queue indicator beside metadata');
            }
            const milestone = meta.querySelector('.task-milestone-label');
            const themeStyles = getComputedStyle(card);
            assertLayout(themeStyles.backgroundColor === ${JSON.stringify(panel)}, id + ': theme panel color');
            assertLayout(themeStyles.borderRadius ===
              getComputedStyle(document.documentElement).getPropertyValue('--surface-radius').trim(), id + ': theme radius');
            assertLayout(card.scrollWidth <= card.clientWidth && meta.scrollWidth <= meta.clientWidth, id + ': overflow');
            return {
              id, width: rect(card).width, padding: [11, left, 11, right], gaps, tagRows,
              groupGap: getComputedStyle(meta).gap, panel: themeStyles.backgroundColor,
              milestoneTruncated: milestone ? milestone.scrollWidth > milestone.clientWidth : null,
              spinnerWrapped: spinner ? rect(spinner).top >= rect(meta).bottom : null,
            };
          });
        })()`);
        report.push(`${theme}, ${narrow ? "narrow" : "board"}: ${JSON.stringify(measurement)}`);
        if (keepArtifacts && (!narrow || theme === "dark")) {
          await capture(`card-spacing-${narrow ? "narrow" : theme}.png`);
        }
      }
    }
    window.show();
    window.focus();
    window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await evaluate(`findCard('T-0100').focus(); settle()`);
    await check(`document.activeElement === findCard('T-0100') &&
      getComputedStyle(findCard('T-0100')).outlineStyle === 'solid'`, "card has visible keyboard focus");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await evaluate(`waitFor(() => sheet.open)`);
    report.push("Keyboard focus visible; Enter opens the task sheet.");
    report.push("Linux and macOS were not run. This change uses shared renderer HTML and CSS.");
    if (keepArtifacts) writeFileSync(join(artifacts, "card-spacing-check.txt"), report.join("\n") + "\n");
    console.log(report.join("\n"));
    return;
  }
  for (const russian of [true, false]) {
    for (const state of [{ restoring: true }, { loading: true }]) {
      await evaluate(`window.pushBoard(${JSON.stringify({ russian, ...state })}); void 0`);
      await check(`byId('welcome').hidden && byId('workspace').hidden &&
        !/Загрузка проектов|Loading projects/.test(byId('app-content').innerText) &&
        byId('app-content').getAttribute('aria-busy') === 'true'`,
        `loading stays blank without flashing welcome (${russian ? 'ru' : 'en'}, ${Object.keys(state)[0]})`);
    }
    await evaluate(`window.pushBoard({ russian: ${russian} }); void 0`);
    await check(`!byId('welcome').hidden && byId('workspace').hidden &&
      byId('app-content').getAttribute('aria-busy') === 'false'`, "welcome appears after confirming no board is open");
  }
  await evaluate(`window.pushBoard({ russian: true, restoring: true }); void 0`);
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "project-tabs-loading.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`window.rejectBootstrap(new Error('Bootstrap fixture failure')); settle()`);
  await check(`!byId('notice').hidden && byId('notice-message').textContent === 'Bootstrap fixture failure' &&
    byId('notice-context').textContent.includes('Запуск приложения')`, "startup failure keeps its message with the application context");
  await evaluate(`byId('notice-close').click(); void 0`);
  await evaluate(`push(); void 0`);
  await check(`byId('welcome').hidden && !byId('workspace').hidden && byId('app-content').getAttribute('aria-busy') === 'false'`, "a restored board replaces the loading state");
  if (process.argv.includes("--experts-only")) {
    await evaluate(`
      const completed = { key: 'verify', expertId: 'qa-engineer', title: 'Verify outcomes', inputs: ['Scope'],
        outputs: ['Proof'], dependsOn: [], criteria: ['Check evidence'] };
      const spawn = { id: 'child-call', type: 'collabAgentToolCall', title: 'spawnAgent',
        text: JSON.stringify({ receiverThreadIds: ['child-session'], prompt: 'Verify the evidence' }), status: 'completed' };
      const native = { id: 'native-spawn', type: 'subAgentActivity', at: '2026-11-18T00:00:00Z',
        text: JSON.stringify({ kind: 'started', agentThreadId: 'child-session', agentPath: '/root/verify',
          model: 'gpt-6.1-sol', reasoningEffort: 'high', startedAtMs: 1000 }), status: 'completed' };
      const wait = { id: 'native-wait', type: 'collabAgentToolCall', title: 'wait', at: '2026-11-18T00:00:01Z',
        text: JSON.stringify({ tool: 'wait', receiverThreadIds: [], agentsStates: {}, startedAtMs: 2000 }), status: 'completed' };
      const planned = task('T-0001', 'Expert plan', { status: 'draft', approvalRequirements: ['review'],
        executorFullAccess: true,
        subtasks: [{ title: 'Verify keyboard focus', done: false }],
        result: { summary: 'Ready for QA', checks: ['JavaScript — passed, Node 24', 'Keyboard — failed. Focus leaves the form', 'Device — skipped'] },
        expertTeam: { work: { lead: 'product-owner', reason: 'The lead owns scope and QA owns verification.', stages: [completed] },
          review: { lead: 'qa-engineer', stages: [completed] } },
        expertStageStatus: { work: [{ ...completed, state: 'done', run: {
          state: 'done', agentId: 'child-session', result: 'Verified native output', outputs: { Proof: 'Evidence recorded' }
        } }] },
        history: [
          { actor: 'user', action: 'chat', text: 'Keep this in dialogue', chat: {} },
          { actor: 'agent', action: 'chat', text: 'Answer in dialogue', chat: {},
            run: [{ id: 'summary', type: 'reasoning', title: '', text: 'Saved work summary', status: 'completed' }] },
          { actor: 'agent', action: 'coordination', at: '2026-11-18T00:00:01Z', text: 'Hand off evidence', expertMessage: { from: 'work:verify', to: 'review:verify' } },
          { actor: 'agent', action: 'expert-stage', expertStageRun: { phase: 'work', key: 'verify', state: 'done' } },
          { actor: 'agent', action: 'expert-skill', expertSkill: { source: 'plan', expertId: 'product-owner', skillId: 'workflow', name: 'Workflow' } },
          { actor: 'agent', action: 'run-log', run: [spawn, native, wait] },
        ],
      });
      fixture.board.tasks = [planned];
      window.taskboard.command = async action => ({ ok: true, data: action === 'experts' ?
        [{ id: 'product-owner', name: 'Product Owner' }, { id: 'qa-engineer', name: 'QA Engineer' }] : structuredClone(planned) });
      window.taskboard.themes = async () => [];
      window.taskboard.codexStatus = async () => ({ state: 'unavailable' });
      window.taskboard.chatModels = async () => ({ ok: true, data: [] });
      push();
      showTask(planned.id);
      void 0;
    `);
    await evaluate(`waitFor(() => body.querySelector('.expert-team'))`);
    await check(`body.querySelector('.expert-team').textContent.includes('The lead owns scope and QA owns verification.') &&
      body.querySelector('.expert-team').textContent.includes('Verified native output') &&
      body.querySelector('.expert-team').textContent.includes('Evidence recorded')`, 'card renders the saved specialist result');
    await evaluate(`waitFor(() => body.querySelector('.expert-lead').textContent.includes('Product Owner'))`);
    await check(`(() => {
      const pane = byId('task-side').getBoundingClientRect();
      const card = body.getBoundingClientRect();
      return pane.left >= card.right && Math.abs(pane.top - card.top) < 1 &&
        body.querySelectorAll('.expert-phase').length === 2 && body.querySelectorAll('.expert-stage').length === 2 &&
        body.querySelector('.expert-approval-requirements').textContent.includes('ответственного за ревью') &&
        !body.textContent.includes('Режим запуска') &&
        ![...body.querySelectorAll('button')].some(button => ['Утвердить', 'Веха…', 'Редактировать', 'Параметры запуска…',
          'Зависимости…', 'Доступ исполнителя…', 'Назначить ответственного за работу', 'Добавить этап ревью'].includes(button.textContent));
    })()`, 'two panes show both expert phases and stop incomplete approval and direct edits');
    await check(`byId('task-chat-dialogue').checkVisibility() &&
      byId('task-chat-dialogue').textContent.includes('Answer in dialogue') &&
      !byId('task-chat-dialogue').textContent.includes('Saved work summary') &&
      !byId('task-chat-dialogue').textContent.includes('Hand off evidence') &&
      byId('task-chat-input').checkVisibility()`, 'the dialogue contains actual messages and its composer');
    await evaluate(`
      const laneButton = name => document.querySelector('#task-side [aria-controls="task-chat-' + name + '"]');
      laneButton('work').click();
      updateChat({ project: fixture.project, id: planned.id, type: 'run', items: [
        { id: 'live-summary', type: 'reasoning', title: '', text: 'Current work summary', status: 'inProgress' }
      ] });
      settle();
    `);
    await check(`byId('task-chat-work').checkVisibility() && byId('task-chat-input').closest('form').hidden &&
      /Current work summary/.test(byId('task-chat-work').textContent) && /Saved work summary/.test(byId('task-chat-work').textContent) &&
      byId('task-chat-work').textContent.includes('Verify outcomes · Завершён') &&
      byId('task-chat-work').textContent.includes('Скил подготовлен для контекста · Workflow') &&
      !/Answer in dialogue|expert-stage/.test(byId('task-chat-work').textContent)`, 'work history names the stage and separates live activity from dialogue');
    await evaluate(`laneButton('team').click(); settle()`);
    await evaluate(`waitFor(() => byId('task-chat-team').querySelector('.expert-author')?.textContent === 'QA Engineer')`);
    await check(`(() => {
      const team = byId('task-chat-team');
      const bubble = team.querySelector('.expert-message');
      return team.checkVisibility() && bubble.querySelector('.expert-avatar').textContent === 'QA' &&
        bubble.querySelector('time').dateTime === '2026-11-18T00:00:01Z' &&
        bubble.querySelector('.expert-bubble').textContent.includes('Hand off evidence') &&
        !team.querySelector('form, textarea, [type=submit]') && !bubble.querySelector('button') &&
        byId('task-chat-input').closest('form').hidden;
    })()`, 'team conversation has a named avatar, bubble, timestamp and no composer or reply');
    await evaluate(`byId('task-chat-team').querySelector('.expert-agent-history > summary').click(); settle()`);
    await check(`(() => {
      const wait = byId('task-chat-team').querySelector('[data-agent-call="native-wait"]');
      const started = byId('task-chat-team').querySelector('[data-agent-call="native-spawn"]');
      return wait.checkVisibility() && wait.textContent.includes('В этот момент работали QA Engineer · Verify outcomes') &&
        started.textContent.includes('gpt-6.1-sol') && started.textContent.includes('Verify outcomes') &&
        !wait.textContent.includes('child-session');
    })()`, 'App Server v2 events correlate a named agent with wait and show the reported model');
    await check(`(() => {
      const target = document.createElement('div');
      showSubmissionResult(planned.result, target);
      const totals = [...target.querySelectorAll('.task-check-counts [data-outcome]')];
      return totals.map(node => node.dataset.outcome).join() === 'passed,failed,skipped' &&
        target.querySelector('.task-check-note').textContent === 'Node 24';
    })()`, 'operator sees result counts and a comma-separated legacy result is parsed');
    await check(`(() => {
      const target = document.createElement('div');
      renderRunActivity(target, [{ id: 'notice', type: 'userMessage', userMessage: {
        text: 'AI Taskboard queue: handle these addressed notices without a goal. [{"id":"T-0001"}]'
      }, status: 'completed', title: '', text: '' }], true);
      return !target.textContent.includes('AI Taskboard queue');
    })()`, 'historical automatic notice payload is hidden');
    await check(`findCard(planned.id).querySelectorAll('.task-subtask-progress > span:not(.is-done)').length === 1 &&
      findCard(planned.id).getAttribute('aria-description').endsWith(t('ui.subtasks_b409bda5') + ' 0/1')`,
    'the task has one unchecked item');
    await evaluate(`planned.status = 'in_progress'; planned.subtasks[0].done = true; planned.revision++; push(); settle()`);
    await check(`findCard(planned.id).querySelectorAll('.task-subtask-progress > .is-done').length === 1 &&
      findCard(planned.id).getAttribute('aria-description').endsWith(t('ui.subtasks_b409bda5') + ' 1/1') &&
      [...body.querySelectorAll('.task-state-label .codicon-check')].some(icon => icon.parentElement.textContent.includes('Verify keyboard focus'))`,
    'a board update refreshes checklist progress while the task is open');
    window.setContentSize(710, 820);
    await evaluate(`settle()`);
    await check(`byId('task-side').getBoundingClientRect().top >= body.getBoundingClientRect().bottom`, 'on a narrow screen the chat moves below the card');
    window.setContentSize(1380, 900);
    if (keepArtifacts) writeFileSync(join(artifacts, "task-card-team.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate(`boardSettings(); settle()`);
    await check(`!body.querySelector('[name="requireExpertPlans"]')`, 'board settings have no expert plan switch');
    console.log(`Expert team Chromium checks passed: ${checks}`);
    return;
  }
  if (process.argv.includes("--repair-only")) {
    for (const theme of ["dark", "light"]) for (const phase of ["queued", "running", "checking", "failed"]) {
      nativeTheme.themeSource = theme;
      await evaluate(`
        fixture.theme = ${JSON.stringify(theme)};
        fixture.board.tasks = [task('T-0001', 'Ремонт приёмки', { status: 'review', mergeRepair: true,
          acceptanceRepair: { phase: ${JSON.stringify(phase)}, targetHead: 'a'.repeat(40), attempts: 1,
            message: 'fix: integrate result', reason: ${phase === "failed" ? "'Required check failed'" : "undefined"} } })];
        push(); void 0;
      `);
      await evaluate(`showReview(fixture.board.tasks[0]); settle()`);
      await check(`sheet.open && sheetKind === 'review' && body.querySelector('form button[type=submit]') !== null`, 'repair phase shows cancellation');
      await check(`lane('review').querySelectorAll('.task-card').length === 1 && lane('in_progress').querySelectorAll('.task-card').length === 0`, 'repair remains in review');
      await capture(`repair-${theme}-${phase}.png`);
    }
    await evaluate(`Object.assign(window.taskboard, { themes: async () => [], codexStatus: async () => ({ state: "unavailable" }), chatModels: async () => ({ ok: true, data: [] }) }); settings(); settle()`);
    await check(`!body.querySelector('[name="manager"]') && !!body.querySelector('[name="reviewer"]')`, 'manager has no application limit control');
    await capture('manager-application-settings.png');
    await evaluate(`boardSettings(); settle()`);
    await check(`!body.querySelector('[name="managerLimit"]') && !!body.querySelector('[name="reviewerLimit"]') && !!body.querySelector('[name="managerModel"]')`, 'board retains manager model without manager limit');
    await capture('manager-board-settings.png');
    console.log(`Acceptance repair Chromium checks passed: ${checks}`);
    return;
  }
  if (process.argv.includes("--return-to-draft-only")) {
    await evaluate(`
      const returned = task('T-0139', 'Return fixture', { status: 'ready' });
      const findReturn = () => [...body.querySelectorAll('button')].find(button => button.textContent === 'Вернуть в черновик');
      let lastReturn, rejectReturn = false;
      window.taskboard.command = async (action, id, input) => {
        if (action === 'return-to-draft') {
          lastReturn = { id, revision: input.revision };
          if (rejectReturn) return { ok: false, error: { code: 'CHAT_BUSY', message: 'Fixture writer is active' } };
          returned.status = 'draft';
          returned.revision++;
          push();
        }
        return { ok: true, data: structuredClone(returned) };
      };
      fixture.board.tasks = [returned];
      const showReturn = async status => {
        returned.status = status; push();
        await showTask(returned.id);
      };
      showReturn('ready');
    `);
    for (const status of ["ready", "in_progress", "blocked", "review", "cancelled", "done", "draft"]) {
      await evaluate(`showReturn(${JSON.stringify(status)})`);
      await check(`Boolean(findReturn()) === ${!["done", "draft"].includes(status)}`, status + " return action");
    }
    await evaluate(`rejectReturn = true; showReturn('in_progress')`);
    await capture('return-active-card.png');
    await evaluate(`findReturn().click(); waitFor(() => document.body.textContent.includes('Fixture writer is active'))`);
    await check(`taskInSheet.status === 'in_progress'`, 'writer failure leaves current state visible');
    await evaluate(`rejectReturn = false; findReturn().click(); waitFor(() => taskInSheet?.status === 'draft')`);
    await check(`lastReturn.id === returned.id && lastReturn.revision === returned.revision - 1`, 'return uses the current card revision');
    window.setContentSize(710, 820);
    await capture('returned-draft-narrow.png');
    console.log(`Return to draft Chromium checks passed: ${checks}`);
    return;
  }
  if (process.argv.includes("--cleanup-only")) {
    await evaluate(`
      const accepted = task('T-0138', 'Completed cleanup fixture', { status: 'done', cleanupAvailable: true,
        git: { worktree: 'saved-worktree' }, artifacts: [{ source: 'required.log', sha256: 'saved' }] });
      fixture.board.tasks = [accepted]; push();
      window.taskboard.command = async () => ({ ok: true, data: structuredClone(accepted) });
      showAcceptedTask({ ...accepted, cleanupWarning: { code: 'DIRTY_WORKTREE', message: 'private cleanup failure' } }); void 0;
    `);
    await evaluate(`waitFor(() => taskInSheet?.id === 'T-0138')`);
    await check(`!document.body.textContent.includes('private cleanup failure') && !body.querySelector('.task-blocker')`, 'cleanup errors produce no notice or card banner');
    await check(`!body.textContent.includes('Принято · рабочая копия сохранена') && taskInSheet.status === 'done'`, 'completed status is independent of pending cleanup');
    await check(`body.querySelector('#task-review-files summary').textContent.includes('1 файл')`, 'required evidence remains available');
    await evaluate(`fixture.board.tasks[0].cleanupAvailable = false; delete fixture.board.tasks[0].git.worktree; showTask('T-0138'); void 0`);
    await evaluate(`waitFor(() => taskInSheet?.cleanupAvailable === false)`);
    await check(`body.querySelector('#task-review-files summary').textContent.includes('1 файл')`, 'evidence remains after cleanup');
    await check(`![...body.querySelectorAll('button')].some(button => button.textContent === 'Уборка рабочей копии…')`, 'maintenance needs no manual cleanup control');
    await capture('cleanup-done.png');
    console.log('Cleanup Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--reviewer-human-only")) {
    await evaluate(`
      fixture.board.settings.reviewMode = 'reviewer-human';
      fixture.board.settings.reviewModeVersion = 1;
      const hybridTask = task('T-0096', 'Проверка результата', { status: 'review', criteria: ['Результат проверен'],
        result: { summary: 'Результат сохранён', checks: ['Проверено'], noChanges: {} } });
      fixture.board.tasks = [hybridTask];
      window.taskboard.command = async action => ({ ok: true, data: action === 'review' ? {
        revision: hybridTask.revision, noChanges: true, targetHead: null, result: hybridTask.result,
        reviewMode: 'reviewer-human', reviewModeVersion: 1, awaitingHumanAcceptance: hybridTask.reviewApproved === true
      } : hybridTask });
      push(); void 0;
    `);
    await check(`findCard('T-0096').querySelector('.task-run-status').textContent === 'Ожидает одобрения ревьюера'`, 'reviewing in Russian');
    await evaluate(`showReview(hybridTask)`);
    await check(`body.querySelector('button[type=submit]').disabled`, 'acceptance requires approval');
    await evaluate(`hybridTask.reviewApproved = true; push(); settle()`);
    await evaluate(`waitFor(() => !body.querySelector('button[type=submit]').disabled)`);
    await check(`body.textContent.includes('Ожидает приёмки человеком') && !body.querySelector('button[type=submit]').disabled`, 'open review clears the gate after approval');
    await capture('reviewer-human-approved-ru.png');
    await evaluate(`sheet.close(); fixture.russian = false; push(); void 0`);
    await check(`findCard('T-0096').querySelector('.task-run-status').textContent === 'Awaiting human acceptance'`, 'approved card remains in review in English');
    await capture('reviewer-human-board-en.png');
    await evaluate(`boardSettings(); settle()`);
    await check(`body.querySelector('[name=reviewMode]').selectedOptions[0].textContent === 'Review + human'`, 'saved mode selected in board settings');
    await check(`body.querySelector('[name=reviewMode]').parentElement.querySelector('small').textContent.includes('You decide')`, 'settings explain the human decision');
    await capture('reviewer-human-settings-en.png');
    await evaluate(`
      sheet.close();
      Object.assign(hybridTask, { result: { summary: 'Delivered', checks: ['Checked'] }, reviewApproved: false });
      window.taskboard.command = async (action, id, fields) => {
        if (action === 'accept') { window.recoveryRequest = { id, fields }; return { ok: false, error: { code: 'FIXTURE', message: 'Recorded recovery request' } }; }
        return { ok: true, data: { revision: hybridTask.revision, result: hybridTask.result, targetHead: 'a'.repeat(40),
          reviewMode: 'reviewer-human', reviewModeVersion: 2, pending: true, pendingModeChanged: true,
          target: 'refs/heads/main', mode: 'squash', submitted: 'b'.repeat(40), message: 'feat: fixture', diff: '' } };
      };
      showReview(hybridTask);
    `);
    await check(`body.querySelector('button[type=submit]').disabled`, 'interrupted acceptance disables integration after a mode change');
    await capture('reviewer-human-recovery-en.png');
    await evaluate(`[...body.querySelectorAll('button')].find(button => button.textContent === 'Recover interrupted acceptance').click(); settle()`);
    await check(`window.recoveryRequest.id === hybridTask.id && window.recoveryRequest.fields.cancelPending === true &&
      window.recoveryRequest.fields.revision === hybridTask.revision`, 'recovery action pins the current revision');
    console.log('Reviewer-human Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--run-status-only")) {
    await evaluate(`
      const queuedTask = task('T-0096', 'Проверка ожидания', { status: 'in_progress',
        codexThreadId: 'saved-thread', attachments: [{ file: 'notes.txt', name: 'notes.txt' }],
        subtasks: [{ title: 'Проверка', done: false }],
        milestone: { title: 'Очень длинная веха '.repeat(12), repository: 'example/board', number: 1 } });
      fixture.board.tasks = [queuedTask]; fixture.waitingTasks = [queuedTask.id];
      push(); void 0;
    `);
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await evaluate(`waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'})`);
      for (const width of [320, 200, 136]) {
        for (const locale of ['ru', 'en']) {
          await evaluate(`
            fixture.theme = ${JSON.stringify(theme)};
            fixture.russian = ${locale === 'ru'};
            push();
            findCard('T-0096').style.width = '${width}px';
            void 0;
          `);
          const label = locale === 'ru' ? 'В очереди' : 'Waiting for an available executor';
          await check(`(() => {
            const card = findCard('T-0096');
            const footer = card.querySelector('.task-card-footer');
            const status = footer?.querySelector('.task-run-status');
            const indicator = status?.querySelector('.task-queue-indicator');
            const meta = footer?.querySelector('.task-meta');
            if (!indicator || !meta) return false;
            const statusRect = status.getBoundingClientRect();
            const footerRect = footer.getBoundingClientRect();
            const metaRect = meta.getBoundingClientRect();
            return card.querySelectorAll('.task-run-status').length === 1 &&
              indicator.getAttribute('role') === 'img' &&
              indicator.getAttribute('aria-label') === ${JSON.stringify(label)} &&
              indicator.title === ${JSON.stringify(label)} &&
              !card.innerText.includes(indicator.title) &&
              statusRect.left >= metaRect.right && statusRect.right === footerRect.right &&
              statusRect.bottom === footerRect.bottom && statusRect.top < metaRect.bottom &&
              card.scrollWidth <= card.clientWidth + 1 && meta.scrollWidth <= meta.clientWidth + 1 &&
              meta.querySelector('.task-id')?.textContent === 'T-0096' &&
              meta.querySelector('.task-milestone-label')?.textContent === queuedTask.milestone.title &&
              meta.querySelector('.codicon-attach')?.parentElement.textContent === '1';
          })()`, `queued indicator beside metadata: ${theme}, ${width}px, ${locale}`);
          if (keepArtifacts && theme === 'light' && locale === 'ru') {
            await capture(`waiting-${width}.png`);
          }
        }
      }
    }
    await evaluate(`fixture.russian = true; fixture.quotaTasks = ['T-0096']; push(); void 0`);
    await check(`!findCard('T-0096').querySelector('.task-queue-indicator') &&
      findCard('T-0096').querySelector('.task-run-status').textContent === quotaLabel()`, 'quota takes precedence over waiting');
    await evaluate(`fixture.quotaTasks = []; fixture.waitingTasks = []; push(); void 0`);
    await check(`!findCard('T-0096').querySelector('.task-queue-indicator') &&
      findCard('T-0096').querySelector('.task-run-status').textContent === 'Запуск с доски не активен'`,
    'dequeue replaces the indicator with inactive status');
    await evaluate(`fixture.waitingTasks = ['T-0096']; fixture.runningTasks = ['T-0096']; push(); void 0`);
    for (const width of [320, 136]) {
      await evaluate(`findCard('T-0096').style.width = '${width}px'; void 0`);
      await check(`(() => {
        const card = findCard('T-0096');
        const details = card.querySelector('.task-card-details');
        const footer = details.lastElementChild;
        const meta = footer.querySelector('.task-meta');
        const status = footer.querySelector('.task-run-status');
        const spinner = status?.querySelector('.agent-spinner');
        const s = status?.getBoundingClientRect(), m = meta?.getBoundingClientRect();
        const f = footer.getBoundingClientRect();
        const progress = details.querySelector('.task-subtask-progress');
        const bar = progress?.firstElementChild;
        const b = bar?.getBoundingClientRect();
        return footer.classList.contains('task-card-footer') && details.querySelectorAll('.task-run-status').length === 1 &&
          !status.querySelector('.task-queue-indicator') && spinner?.getAttribute('role') === 'status' &&
          spinner.getAttribute('aria-label') === t('ui.agent_is_working_28ccd334') &&
          (s.left >= m.right || s.top >= m.bottom) && s.right === f.right && s.bottom === f.bottom &&
          progress?.children.length === 1 && progress.nextElementSibling === footer &&
          !bar.classList.contains('is-done') && b.left === f.left && b.right === f.right && b.height === 6 &&
          card.getAttribute('aria-description') === t('ui.subtasks_b409bda5') + ' 0/1' &&
          !card.innerText.includes('0/1') &&
          card.scrollWidth <= card.clientWidth + 1 && meta.scrollWidth <= meta.clientWidth + 1 &&
          [...meta.children].every(node => node.getBoundingClientRect().right <= m.right + 1) &&
          meta.querySelector('.task-id')?.textContent === 'T-0096' &&
          meta.querySelector('.codicon-attach')?.parentElement.textContent === '1';
      })()`, `accessible active indicator in the bottom right with full metadata at ${width}px`);
      if (keepArtifacts) await capture(`running-${width}.png`);
    }
    await evaluate(`
      window.taskboard.command = async () => ({ ok: true, data: structuredClone(queuedTask) });
      showTask(queuedTask.id);
    `);
    await check(`(() => {
      const title = byId('sheet-title');
      const spinner = title.querySelector('#task-agent-run .agent-spinner');
      if (!spinner) return false;
      const style = getComputedStyle(spinner);
      return spinner.getAttribute('aria-label') === t('ui.agent_is_working_28ccd334') &&
        style.fontSize === getComputedStyle(title).fontSize &&
        style.width === style.fontSize && style.height === style.fontSize;
    })()`, 'open task title retains the accessible title-sized indicator');
    if (keepArtifacts) await capture('running-open-task.png');
    await evaluate(`fixture.runningTasks = []; fixture.reviewingTasks = { 'T-0096': 'reviewer' }; push(); void 0`);
    await check(`!!findCard('T-0096').querySelector('.agent-spinner')`, 'active review takes precedence over waiting');
    await evaluate(`fixture.reviewingTasks = {}; fixture.board.tasks[0].mergeRepair = {}; fixture.board.tasks[0].revision++; push(); void 0`);
    await check(`!byId('task-agent-run')?.querySelector('.agent-spinner')`, 'open task title clears the indicator when activity ends');
    await check(`findCard('T-0096').querySelector('.task-run-status').textContent === t('ui.waiting_for_a_reviewer_slot_8918dd95')`, 'repair queue retains reviewer waiting label');
    await evaluate(`
      fixture.waitingTasks = [];
      delete queuedTask.mergeRepair;
      queuedTask.status = 'ready';
      queuedTask.revision++;
      push();
      void 0;
    `);
    await check(`findCard('T-0096').querySelector('.task-card-details').lastElementChild.classList.contains('task-meta') &&
      !findCard('T-0096').querySelector('.task-run-status, .task-card-footer')`, 'inactive card has no extra row when status has no run label');
    await evaluate(`sheet.close(); settle()`);
    if (keepArtifacts) await capture('inactive-136.png');
    await evaluate(`delete queuedTask.milestone; queuedTask.attachments = []; queuedTask.subtasks = [];
      queuedTask.status = 'ready'; queuedTask.revision++; fixture.runningTasks = ['other-task'];
      push(); void 0`);
    await check(`!findCard('T-0096').querySelector('.task-run-status')`, 'occupied slots alone do not imply waiting');
    await evaluate(`fixture.waitingTasks = ['T-0096']; push(); void 0`);
    await check(`!!findCard('T-0096').querySelector('.task-card-footer .task-queue-indicator')`,
      'ready task without optional metadata has the same footer indicator');
    console.log('Run status Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--scroll-only")) {
    await evaluate(`
      fixture.board.tasks = Array.from({ length: 40 }, (_, i) => task('S-' + i, 'Scroll task ' + i,
        { description: Array(80).fill('Long task content.').join('\\n\\n'), criteria: [] }));
      window.taskboard.command = async (_action, id) => ({ ok: true,
        data: structuredClone(fixture.board.tasks.find(task => task.id === id)) });
      push();
      void 0;
    `);
    await evaluate(`(async () => {
      while (lane('ready').querySelector('.lane-more')) {
        lane('ready').querySelector('.lane-more').click();
        await settle();
      }
    })()`);
    for (const close of ['button', 'Escape']) for (const scroll of [false, true]) for (const refresh of [false, true]) {
      await evaluate(`
        findCard('S-0').focus();
        byId('lanes').scrollTop = 400;
        window.scrollBaseline = byId('lanes').scrollTop;
        showTask('S-5');
        waitFor(() => taskInSheet?.id === 'S-5').then(settle);
      `);
      await check(`scrollBaseline > 0 && byId('lanes').scrollTop === scrollBaseline`, 'opening retains board scroll');
      if (scroll) {
        await evaluate(`body.scrollTop = body.scrollHeight; settle()`);
        await check(`body.scrollTop > 0 && byId('lanes').scrollTop === scrollBaseline`, 'sheet scroll is independent');
      }
      if (refresh) await evaluate(`fixture.board.tasks[6].title += '!'; fixture.board.tasks[6].revision++; push(); settle()`);
      if (close === 'button') await click('#close-sheet');
      else {
        window.webContents.focus();
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      }
      await evaluate(`waitFor(() => !sheet.open).then(settle)`);
      await check(`byId('lanes').scrollTop === scrollBaseline && document.activeElement === findCard('S-0')`,
        `close restores focus without scrolling: ${close}, sheet scroll=${scroll}, refresh=${refresh}`);
    }
    console.log('Sheet scroll Chromium checks passed: ' + checks + ' (8 combinations)');
    return;
  }
  if (process.argv.includes("--schedule-pause-only")) {
    await evaluate(`
      fixture.board.tasks[1].schedule = { everyMinutes: 60, nextAt: '2000-01-01T00:00:00Z' };
      window.taskboard.command = async (action, id, input) => {
        const task = fixture.board.tasks.find(task => task.id === id);
        if (action === 'show') return {ok:true,data:{...task,criteria:[]}};
        if (action !== 'update') throw Error(action);
        if (input.revision !== task.revision) throw Error('stale revision');
        task.schedule.paused = input.schedulePaused;
        task.revision++; push(); return {ok:true,data:task};
      }; push(); showTask('T-0002');
    `);
    await evaluate(`waitFor(() => document.querySelector('.sheet-actions')).then(settle)`);
    for (const rule of [{ everyMinutes: 60 }, { time: '09:00' }]) {
      for (const russian of [true, false]) for (const theme of ['dark', 'light']) {
        nativeTheme.themeSource = theme;
        await evaluate(`fixture.russian = ${russian}; fixture.theme = '${theme}'; fixture.board.tasks[1].schedule = { ...${JSON.stringify(rule)}, nextAt: '2000-01-01T00:00:00Z' }; push(); showTask('T-0002')`);
        await evaluate(`settle()`);
        for (const paused of [true, false, true]) {
          await evaluate(`[...document.querySelectorAll('.sheet-actions button')].find(b => b.textContent === t('${paused ? 'ui.pause_schedule' : 'ui.resume_schedule'}')).click(); waitFor(() => fixture.board.tasks[1].schedule.paused === ${paused}).then(settle)`);
          await check(`(() => { const badge = findCard('T-0002').querySelector('.task-schedule');
            const detail = body.querySelector('.task-schedule-pause');
            if (!${paused}) return !badge.querySelector('.codicon-debug-pause') && !detail && badge.textContent === ${rule.time ? JSON.stringify(rule.time) : "scheduleInterval(60, 'short')"};
            return [badge, detail].every(node => node && node.textContent === '' && node.getAttribute('role') === 'img' &&
              node.title.includes(t('ui.schedule_paused')) && node.getAttribute('aria-label') === node.title &&
              node.querySelector('.codicon-debug-pause')?.getAttribute('aria-hidden') === 'true' &&
              getComputedStyle(node.querySelector('.codicon-debug-pause'), '::before').content.codePointAt(1) === 60113);
          })()`, 'pause is a Codicons glyph with a tooltip and accessible name in card and details; resume restores timing');
          await check(`byId('sheet-body').textContent.includes(t('${paused ? 'ui.resume_schedule' : 'ui.pause_schedule'}'))`, 'details offer the inverse action');
          await check(`fixture.board.tasks[1].schedule.${rule.time ? "time === '09:00'" : 'everyMinutes === 60'} && fixture.board.tasks[1].status === 'ready'`, 'schedule action retains rule and status');
        }
        if (russian && rule.time) await capture('schedule-paused-' + theme + '.png');
      }
    }
    await capture('schedule-paused.png');
    console.log('Schedule Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--auto-only")) {
    await evaluate(`window.taskboard.command = async (action, id, input) => {
      if (action === 'settings') { Object.assign(fixture.board.settings, input); push(); return {ok:true,data:fixture.board.settings}; }
      if (action === 'show') return {ok:true,data:{...fixture.board.tasks.find(task => task.id === id), criteria:[]}};
      if (action === 'update') { Object.assign(fixture.board.tasks.find(task => task.id === id), input); push(); return {ok:true,data:fixture.board.tasks.find(task => task.id === id)}; }
      throw new Error('Unexpected action: ' + action);
    }; void 0`);
    await check(`byId('status-auto-mode').getAttribute('aria-pressed') === 'false'`, "automatic mode is visibly off by default");
    await click('#status-auto-mode');
    await check(`byId('status-auto-mode').getAttribute('aria-pressed') === 'true' && fixture.board.settings.autoMode === true`, "the toggle persists the enabled setting through the board command");
    await capture('auto-mode-on.png');
    await evaluate(`push(); void 0`);
    await check(`byId('status-auto-mode').getAttribute('aria-pressed') === 'true'`, "a restored board snapshot retains the mode");
    await click('#status-auto-mode');
    await check(`byId('status-auto-mode').getAttribute('aria-pressed') === 'false'`, "the toggle turns automatic mode off");
    await evaluate(`fixture.board.tasks[1].unfinishedDependencies = ['T-0001']; push(); void 0`);
    await check(`lane('ready').contains(findCard('T-0002')) && findCard('T-0002').querySelector('.task-dependency-message').textContent.includes('T-0001')`, "dependency waiting retains the ready column and explanation");
    await evaluate(`showTask('T-0002')`);
    await check(`byId('task-launch').disabled`, "manual launch is disabled while dependencies are unfinished");
    await evaluate(`taskEditor({...fixture.board.tasks[1],criteria:[]}); void 0`);
    await check(`document.querySelector('input[name="dueDate"]').type === 'date'`, "task editing exposes a calendar deadline");
    await evaluate(`(() => { const input = document.querySelector('input[name="dueDate"]'); input.value = '2026-11-20'; input.form.requestSubmit(); })()`);
    await evaluate(`waitFor(() => fixture.board.tasks[1].dueDate === '2026-11-20')`);
    await check(`findCard('T-0002').textContent.includes('2026-11-20')`, "saving a deadline updates the visible card");
    console.log('Automatic mode Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--subtasks-only")) {
    window.setContentSize(1280, 800);
    await evaluate(`
      const progressTask = fixture.board.tasks[0];
      progressTask.title = 'Прогресс подзадач';
      fixture.board.tasks[1].title = 'Карточка без подзадач';
      progressTask.priority = 'high';
      progressTask.subtasks = ['Первая', 'Вторая', 'Третья'].map(title => ({ title, done: false }));
      const progressCard = findCard(progressTask.id);
      const progress = () => progressCard.querySelector('.task-subtask-progress');
      const meta = () => progressCard.querySelector('.task-meta');
      const bars = () => [...progress().children];
      const fitsInOneRow = states => {
        const row = progress().getBoundingClientRect();
        const segments = bars();
        const rects = segments.map(bar => bar.getBoundingClientRect());
        return segments.length === states.length && rects[0].left === row.left &&
          Math.abs(rects.at(-1).right - row.right) <= 1 &&
          row.bottom <= meta().getBoundingClientRect().top &&
          segments.every((bar, index) => {
            const rect = rects[index];
            return bar.classList.contains('is-done') === states[index] &&
              rect.top === row.top && rect.height === 6 && rect.width > 0 &&
              Math.abs(rect.width - rects[0].width) <= 0.1 &&
              (index === 0 || rect.left > rects[index - 1].right);
          });
      };
      const segmentColor = bar => {
        const context = document.createElement('canvas').getContext('2d');
        context.fillStyle = getComputedStyle(bar).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const activeAccent = () => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        progressCard.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return accent;
      };
      push();
      waitFor(() => progressCard.querySelector('.task-card-cover')?.naturalWidth > 0);
    `);
    const cdp = window.webContents.debugger;
    cdp.attach("1.3");
    const axCard = async () => {
      const { result } = await cdp.sendCommand("Runtime.evaluate", { expression: "progressCard" });
      const { nodes } = await cdp.sendCommand("Accessibility.getPartialAXTree", { objectId: result.objectId });
      await cdp.sendCommand("Runtime.releaseObject", { objectId: result.objectId });
      return nodes[0];
    };
    for (const theme of ["light", "dark"]) for (const narrow of [false, true]) {
      nativeTheme.themeSource = theme;
      await evaluate(`
        fixture.theme = '${theme}';
        fixture.board.settings.showCardPreviews = true;
        byId('lanes').style.gridAutoColumns = '${narrow ? "120px" : ""}';
        progressTask.subtasks = ['Первая', 'Вторая', 'Третья'].map(title => ({ title, done: false }));
        push();
        waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"});
      `);
      const cardWidth = await evaluate("progressCard.getBoundingClientRect().width");
      if (narrow) assert.equal(cardWidth, 120);
      const neutral = theme === "light" ? [209, 213, 219] : [69, 73, 89];
      for (const states of [[false, false, false], [true, false, true], [false, true, true], [true, true, true]]) {
        const count = states.filter(Boolean).length;
        await evaluate(`
          progressTask.subtasks.forEach((entry, index) => {
            entry.done = ${JSON.stringify(states)}[index];
          });
          progressTask.revision++;
          push();
          settle().then(() => waitFor(() => progress().getAnimations({ subtree: true }).length === 0));
        `);
        await check(`(() => {
          const states = ${JSON.stringify(states)};
          const neutral = ${JSON.stringify(neutral)};
          const accent = activeAccent();
          const cover = progressCard.querySelector('.task-card-cover');
          return findCard(progressTask.id) === progressCard && fitsInOneRow(states) &&
            bars().every((bar, i) => {
              const color = getComputedStyle(bar).backgroundColor;
              if (states[i]) {
                const fill = getComputedStyle(bar, '::before');
                return fill.backgroundColor === accent && fill.transform === 'matrix(1, 0, 0, 1, 0, 0)';
              }
              return color !== accent && segmentColor(bar).every((channel, j) => Math.abs(channel - neutral[j]) <= 1);
            }) &&
            cover && !cover.hidden && cover.nextElementSibling === progress() && progress().nextElementSibling === meta() &&
            meta().scrollWidth <= meta().clientWidth && meta().querySelector('.task-id').textContent === progressTask.id &&
            meta().querySelector('.codicon-attach') && !meta().querySelector('.codicon-checklist') &&
            !progressCard.innerText.includes('${count}/3') && progress().getAttribute('aria-hidden') === 'true' &&
            progressCard.getAttribute('aria-description').includes(t('ui.priority_b114c9b5')) &&
            progressCard.getAttribute('aria-description').endsWith(t('ui.subtasks_b409bda5') + ' ${count}/3') &&
            !findCard('T-0002').querySelector('.task-subtask-progress');
        })()`, `ordered bars and unchanged metadata: ${theme}, ${cardWidth}px, ${states}`);
        const accessible = await axCard();
        assert.equal(accessible.role.value, "button");
        assert.match(accessible.description.value, new RegExp(`${count}/3$`));
        if (!narrow && states[0] && !states[1]) {
          const { accent, segments } = await evaluate(`({ accent: activeAccent(),
            segments: bars().map(bar => getComputedStyle(bar, bar.classList.contains('is-done') ? '::before' : null).backgroundColor) })`);
          console.log(`Progress colors (${theme}): --accent = ${accent}, segments = ${segments.join(" / ")}`);
          await capture(`progress-accent-${theme}.png`);
        }
      }
      await evaluate(`fixture.board.settings.showCardPreviews = false; push(); settle()`);
      await check(`!progressCard.querySelector('.task-card-cover') && progress().nextElementSibling === meta() &&
        fitsInOneRow([true, true, true])`,
        `progress remains above metadata without a cover: ${theme}`);
      await evaluate(`
        Object.assign(fixture.board.tasks[1], {
          title: 'Одна подзадача', subtasks: [{ title: 'Проверка', done: false }]
        });
        push(); settle();
      `);
      await check(`(() => {
        const card = findCard('T-0002');
        const row = card.querySelector('.task-subtask-progress');
        return row.children.length === 1 && row.firstElementChild.offsetWidth === row.offsetWidth &&
          card.getAttribute('aria-description').endsWith('0/1');
      })()`, `one subtask fills the row: ${theme}, ${cardWidth}px`);
      const many = Array.from({ length: 40 }, (_, index) => index % 3 !== 2);
      await evaluate(`
        progressTask.title = '40 подзадач';
        progressTask.subtasks = ${JSON.stringify(many)}.map((done, i) => ({ title: String(i), done }));
        push(); settle();
      `);
      await check(`fitsInOneRow(${JSON.stringify(many)}) && meta().scrollWidth <= meta().clientWidth`,
        `long checklist fits above metadata: ${theme}, ${cardWidth}px`);
      assert.match((await axCard()).description.value, /27\/40$/);
      if (narrow && theme === "dark") await capture("progress-narrow.png");
      await evaluate(`
        progressTask.title = 'Прогресс подзадач';
        progressTask.subtasks = progressTask.subtasks.slice(0, 3).map(entry => ({ ...entry, done: true }));
        fixture.board.tasks[1].title = 'Карточка без подзадач';
        fixture.board.tasks[1].subtasks = [];
        push(); settle();
      `);
      console.log(`Progress layout: ${theme}, content ${window.getContentSize().join("x")}, card ${cardWidth} CSS px. Counts 0, 1, 3, 40; live board snapshots; Chromium accessibility descriptions.`);
    }
    cdp.detach();
    await evaluate(`fixture.russian = false; push(); settle()`);
    await check(`progressCard.getAttribute('aria-description').endsWith('Subtasks 3/3')`, "progress description follows the locale");
    await evaluate(`
      progressTask.priority = 'normal'; progressTask.status = 'in_progress';
      fixture.runningTasks = [progressTask.id]; push(); settle();
    `);
    await check(`progressCard.querySelector('.task-run-status .agent-spinner') &&
      progress().getBoundingClientRect().bottom <= meta().getBoundingClientRect().top &&
      progressCard.getAttribute('aria-description') === 'Subtasks 3/3'`, "progress coexists with the active run indicator");
    await evaluate(`delete progressTask.subtasks; progressTask.priority = 'normal'; push(); settle()`);
    await check(`!progress() && !progressCard.hasAttribute('aria-description')`, "no progress for a card without subtasks");
    console.log("Subtask Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--covers-only")) {
    await evaluate(`
      const sizes = [[400, 8000], [800, 200], [40, 30], [80, 80]];
      const sources = sizes.map(([width, height]) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#e15858'; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#428bca'; ctx.fillRect(0, height / 2, width, height / 2);
        ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText(width + ' × ' + height + ' · TOP', 8, 24);
        ctx.strokeStyle = '#fff'; ctx.strokeRect(8, 36, 40, 40);
        return canvas.toDataURL();
      });
      window.taskboard.attachmentPreview = async (_task, file) => {
        window.previewCalls++;
        return new Promise(resolve => { window.releaseCover = () => resolve(sources[Number(file[0])]); });
      };
      fixture.tabs = [{ path: fixture.project, name: 'Covers' }, { path: 'cover-other', name: 'Other' }];
      const bounded = image => image.hidden || image.getBoundingClientRect().height <= 180;
      void 0;
    `);
    for (const theme of ['dark', 'light']) for (const width of [1380, 900]) {
      nativeTheme.themeSource = theme;
      window.setContentSize(width, 900);
      await evaluate(`waitFor(() => matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'})`);
      for (let shape = 0; shape < 4; shape++) {
        await evaluate(`
          fixture.theme = '${theme}';
          fixture.board.tasks = [task('T-0001', '${['Длинный скриншот', 'Широкое изображение', 'Маленькое изображение', 'Квадратное изображение'][shape]}', {
            attachments: [{ file: '${shape}-${theme}-${width}.png', name: 'image.png' }]
          })];
          window.releaseCover = null; push();
          waitFor(() => window.releaseCover);
        `);
        await check(`findCard('T-0001').querySelector('img').hidden && bounded(findCard('T-0001').querySelector('img'))`, 'delayed cover remains hidden and bounded');
        await evaluate(`
          window.oversizedFrame = false;
          window.monitorCover = () => {
            if (!bounded(findCard('T-0001').querySelector('img'))) window.oversizedFrame = true;
            if (!window.stopMonitor) requestAnimationFrame(window.monitorCover);
          };
          window.stopMonitor = false; window.monitorCover(); window.releaseCover();
          waitFor(() => !findCard('T-0001').querySelector('img').hidden);
        `);
        await evaluate(`settle()`);
        await check(`(() => {
          const image = findCard('T-0001').querySelector('img'), rect = image.getBoundingClientRect(), css = getComputedStyle(image);
          const parentCSS = getComputedStyle(image.parentElement);
          const expectedWidth = image.parentElement.clientWidth - parseFloat(parentCSS.paddingLeft) - parseFloat(parentCSS.paddingRight);
          return !window.oversizedFrame && bounded(image) && Math.abs(rect.width - expectedWidth) < 1 &&
            Math.abs(rect.height - Math.min(180, expectedWidth * image.naturalHeight / image.naturalWidth)) < 2 &&
            css.objectFit === 'cover' && css.objectPosition === '50% 0%' && css.borderRadius === '7px' &&
            findCard('T-0001').querySelector('.task-meta').getBoundingClientRect().top >= rect.bottom;
        })()`, 'full inner width, proportional cover crop at top, rounded border and footer (' + theme + ', ' + width + ', ' + shape + ')');
        await evaluate(`
          window.stopMonitor = true;
          window.savedCover = findCard('T-0001').querySelector('img'); window.savedCalls = window.previewCalls;
          fixture.board.tasks[0].title += ' · обновлено'; push();
          window.pushBoard({ ...fixture, project: 'cover-other', board: { ...fixture.board, tasks: [] } }); push();
          void 0;
        `);
        await check(`findCard('T-0001').querySelector('img') === window.savedCover && !window.savedCover.hidden &&
          bounded(window.savedCover) && window.previewCalls === window.savedCalls`, 'refresh and tab cache keep the decoded bounded cover without another request');
        if (keepArtifacts) await capture(`cover-${theme}-${width}-${shape}.png`);
      }
    }
    await evaluate(`
      openImagePreview('T-0001', [{ file: 'original.png', name: 'original.png' }], 0, sources[0]);
      waitFor(() => document.querySelector('.image-preview-stage img')?.naturalHeight === 8000);
    `);
    await evaluate(`document.querySelector('.image-preview-toolbar button[aria-label="Исходный размер"]').click(); settle()`);
    await check(`document.querySelector('.image-preview-stage img').getBoundingClientRect().height === 8000`, 'existing viewer still exposes the entire original at 1:1');
    await evaluate(`document.querySelector('.image-preview').close(); void 0`);
    await evaluate(`
      window.taskboard.attachmentPreview = async () => sources[0];
      fixture.project = 'cover-count';
      fixture.board.tasks = Array.from({ length: 20 }, (_, index) => task('T-' + String(index + 1).padStart(4, '0'), 'Card', {
        createdAt: index === 0 ? '2026-11-02T12:00:00.000Z' : '2026-11-01T12:00:00.000Z',
        attachments: index === 0 ? [{ file: 'long.png', name: 'long.png' }] : []
      }));
      push(); waitFor(() => !findCard('T-0001').querySelector('img').hidden);
    `);
    await evaluate(`settle()`);
    await check(`(() => {
      const content = lane('ready').querySelector('.task-card').parentElement;
      const board = byId('lanes');
      const available = board.getBoundingClientRect().bottom - 8 - content.getBoundingClientRect().top;
      return content.querySelectorAll('.task-card').length > 1 &&
        content.getBoundingClientRect().height <= available * 1.5 && bounded(findCard('T-0001').querySelector('img'));
    })()`, 'lane fitting uses the cropped height after asynchronous image loading');
    await evaluate(`
      window.taskboard.command = async () => ({ ok: true, data: fixture.board.tasks[0] });
      findCard('T-0001').focus(); void 0;
    `);
    await check(`document.activeElement === findCard('T-0001') && document.activeElement.tagName === 'BUTTON' &&
      document.activeElement.querySelector('img').alt === ''`, 'cover stays decorative inside the focusable card button');
    window.webContents.focus();
    await evaluate(`findCard('T-0001').focus(); settle()`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await evaluate(`waitFor(() => sheet.open)`);
    await check(`sheet.open && taskInSheet?.id === 'T-0001'`, 'Enter opens the covered card');
    console.log('Cover Chromium checks passed: ' + checks);
    return;
  }
  if (process.argv.includes("--agent-count-only")) {
    await evaluate(`
      const indicator = byId('status-agents');
      const bell = byId('status-notifications');
      const agentCount = () => indicator.querySelector('span').textContent;
      const reportManager = (project, sessions) => window.pushChat({ project, type: 'orchestrator-run', ...sessions });
      const run = { id: 'manager-run', phase: 'running' };
      void 0;
    `);
    await check(`!indicator.hidden && agentCount() === '0' &&
      indicator.getBoundingClientRect().right <= bell.getBoundingClientRect().left &&
      indicator.querySelector('.codicon-hubot') &&
      Math.abs(indicator.getBoundingClientRect().top + indicator.offsetHeight / 2 -
        (bell.getBoundingClientRect().top + bell.offsetHeight / 2)) < 1`,
      "the selected board shows zero beside the bell with both items vertically aligned");
    await evaluate(`
      fixture.runningTasks = ['T-0001'];
      fixture.reviewingTasks = { 'T-0001': 'reviewer', 'T-0002': 'manager', 'T-0003': 'manager' };
      fixture.managerWork = run;
      push();
      void 0;
    `);
    await check(`agentCount() === '3' && indicator.getAttribute('aria-label') === 'Активные агенты · 3'`,
      "overlapping execution and review count separately while the manager counts once for a batch of cards");
    await evaluate(`reportManager(fixture.project, { managerRun: { ...run, id: 'manager-chat' } }); void 0`);
    await check(`agentCount() === '4'`, "an active manager reply also counts without a board refresh");
    await evaluate(`reportManager(fixture.project, { managerWork: null }); void 0`);
    await check(`agentCount() === '3'`, "ending just one manager session decrements the count");
    await evaluate(`
      window.pushBoard({ ...fixture, runningTasks: [], reviewingTasks: {}, managerWork: null, managerRun: frame.managerRun });
      void 0;
    `);
    await check(`agentCount() === '1'`, "finishing an executor and a reviewer leaves the active manager reply counted");
    await evaluate(`
      window.pushBoard({ ...fixture, project: 'other-board', runningTasks: [], reviewingTasks: {}, managerWork: null,
        board: { ...fixture.board, project: 'other-board', tasks: [task('T-0001', 'Waiting', { status: 'review' })] } });
      reportManager(fixture.project, { managerRun: run });
      void 0;
    `);
    await check(`agentCount() === '0' && !indicator.hidden && bell.querySelector('.count').textContent === '1'`,
      "switching boards drops the previous count and a submission waiting for review only affects the bell");
    await evaluate(`window.pushBoard({ russian: true, theme: 'dark' }); void 0`);
    await check(`indicator.hidden && !bell.hidden`, "with no board open only the bell is visible");
    console.log("Agent count Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--updates-only")) {
    window.setContentSize(360, 700);
    for (const russian of [true, false]) for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await evaluate(`window.pushBoard({ russian: ${russian}, theme: '${theme}' });
        window.updateCalls = 0;
        window.updateOutcome = 'empty';
        window.releaseUrl = 'https://github.com/edwardgushchin/AI-Taskboard/releases/tag/v0.2.0';
        window.openedUpdateUrl = undefined;
        window.taskboard.openLink = async url => { openedUpdateUrl = url; };
        window.taskboard.checkUpdates = async () => {
          updateCalls++;
          if (updateOutcome === 'network') throw new Error('Offline');
          if (updateOutcome === 'http') return { ok: false, error: { message: 'GitHub HTTP 429' } };
          return { ok: true, data: { currentVersion: '0.1.0', sourceUrl: 'https://github.com/edwardgushchin/AI-Taskboard/releases',
            status: updateOutcome, latest: updateOutcome === 'available' ? { version: '0.2.0', prerelease: false, url: releaseUrl } : null } };
        }; void 0`);
      await click('#app-settings');
      await click('#settings-menu-updates');
      await evaluate(`waitFor(() => !byId('updates-retry').disabled)`);
      await check(`sheet.open && updateCalls === 1 && !byId('updates-open-release') &&
        body.textContent.includes(${JSON.stringify(russian ? 'пока нет опубликованных' : 'No releases are published')})`,
        `empty repository is distinct from a network error: ${russian}/${theme}`);
      if (keepArtifacts) await capture(`updates-empty-${theme}-${russian ? 'ru' : 'en'}.png`);
      for (const failure of ['network', 'http']) {
        await evaluate(`updateOutcome = '${failure}'; void 0`);
        await click('#updates-retry');
        await check(`!byId('updates-open-release') && !byId('updates-retry').disabled &&
          body.textContent.includes(${JSON.stringify(russian ? 'Не удалось проверить' : 'Could not check')})`, 'network and API errors allow retry');
      }
      if (keepArtifacts && theme === 'dark') await capture(`updates-error-${russian ? 'ru' : 'en'}.png`);
      await evaluate(`updateOutcome = 'available'; void 0`);
      await click('#updates-retry');
      await check(`updateCalls === 4 && !!byId('updates-open-release') && body.textContent.includes('0.2.0') && body.textContent.includes('0.1.0')`,
        'retry after an error finds a newer version and displays the installed version');
      if (keepArtifacts) await capture(`updates-available-${theme}-${russian ? 'ru' : 'en'}.png`);
      await click('#updates-open-release');
      await check(`openedUpdateUrl === releaseUrl && updateCalls === 4`, 'a new version opens its release page without installation');
      await evaluate(`window.taskboard.checkUpdates = async () => ({ ok: true, data: { currentVersion: '0.2.0-beta.2', status: 'available',
        latest: { version: '0.2.0-beta.10', prerelease: true, url: releaseUrl }, sourceUrl: releaseUrl } }); void 0`);
      await click('#updates-retry');
      await check(`body.textContent.includes('0.2.0-beta.10') && body.textContent.includes(${JSON.stringify(russian ? 'предварительная' : 'prerelease')})`,
        'prerelease updates are explicitly identified');
      await evaluate(`window.taskboard.checkUpdates = async () => ({ ok: true, data: {
        currentVersion: '0.2.0', status: 'current', latest: { version: '0.2.0' }, sourceUrl: releaseUrl } }); void 0`);
      await click('#updates-retry');
      await check(`!byId('updates-open-release') && body.textContent.includes(${JSON.stringify(russian ? 'последняя версия' : 'latest version')})`,
        'no update removes the previous download action');
      await evaluate(`window.taskboard.checkUpdates = () => new Promise(resolve => { window.finishUpdate = resolve; });
        byId('updates-retry').click(); void 0`);
      await check(`byId('updates-retry').disabled && !byId('updates-open-release')`, 'loading disables repeat checks and removes stale results');
      await evaluate(`sheet.close(); openSheet('other', 'Other panel'); body.textContent = 'Unchanged panel';
        window.finishUpdate({ ok: true, data: { status: 'empty', currentVersion: '0.1.0' } }); settle()`);
      await check(`body.textContent === 'Unchanged panel'`, 'a late check cannot replace a different panel');
      await evaluate(`sheet.close(); settle()`);
      await evaluate(`settle()`);
      await check(`document.activeElement === byId('app-settings')`, 'closing updates returns focus to the gear');
    }
    console.log("Updates Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--settings-only")) {
    await evaluate(`
      const projects = [{ path: 'board-fixture', name: 'Первая доска' }, { path: 'other-board', name: 'Вторая доска' }];
      const savedNames = new Map();
      const savedLimits = new Map();
      const savedManagerAccess = new Map();
      const openBoard = project => window.pushBoard({ ...fixture, project,
        managerAccess: savedManagerAccess.get(project) ?? 'auto',
        tabs: projects.map(tab => ({ ...tab, name: savedNames.get(tab.path) || tab.name })),
        board: { ...fixture.board, project, settings: { ...fixture.board.settings,
          name: savedNames.get(project), taskLimits: savedLimits.get(project) } } });
      const createProjectCalls = [];
      let limits = { executor: 1, reviewer: 1 };
      let windowsSandbox = 'mxc';
      const codexStatus = async () => ({ state: 'unavailable', windowsSandbox });
      Object.assign(window.taskboard, {
        createBoard: async () => { createProjectCalls.push(frame.project ?? null); },
        selectTab: async project => openBoard(project),
        setManagerAccess: async (project, mode) => {
          savedManagerAccess.set(project, mode);
          openBoard(project);
          return { ok: true, data: mode };
        },
        command: async (action, _id, values) => {
          if (action !== 'settings') throw Error('Unexpected command: ' + action);
          if (typeof values.name === 'string') savedNames.set(frame.project, values.name.trim());
          if (values.taskLimits) savedLimits.set(frame.project, values.taskLimits);
          openBoard(frame.project);
          return { ok: true, data: frame.board.settings };
        },
        taskLimits: async value => ({ ok: true, data: value ? limits = value : limits }),
        themes: async () => [],
        codexStatus,
        setCodexWindowsSandbox: async mode => { windowsSandbox = mode; return codexStatus(); },
        chatModels: async () => ({ ok: true, data: [] }),
      });
      const limitFields = () => [...byId('agent-limits').querySelectorAll('input')];
      const sandboxSelect = () => body.querySelector('.provider-panel select');
      const boardNameInput = () => byId('sheet-body').querySelector('form input[type="text"]');
      const boardLimit = role => body.querySelector('[name="' + role + 'Limit"]');
      const managerAccess = () => body.querySelector('[name="managerAccess"]');
      const gearBackground = () => getComputedStyle(byId('app-settings')).backgroundColor;
      const gearMatchesRail = () => gearBackground() === getComputedStyle(byId('project-tabs')).backgroundColor;
      const createProjectItem = () => [...byId('app-menu').querySelectorAll('.app-menu-item')]
        .find(item => item.textContent === 'Создать проект…');
      window.pushBoard({ russian: true, theme: 'dark' });
      void 0;
    `);
    await check(`byId('board-settings-menu-item').getAttribute('aria-disabled') === 'true' &&
      byId('app-settings').getBoundingClientRect().left < 40 && byId('app-settings').getBoundingClientRect().bottom > innerHeight - 65 &&
      getComputedStyle(byId('app-settings')).borderInlineEndWidth === '0px'`,
      "the gear has no divider without project tabs and board settings need a board");
    const welcomeGearBackground = await evaluate(`gearBackground()`);
    await hover('#app-settings');
    await check(`gearBackground() === ${JSON.stringify(welcomeGearBackground)} && gearBackground() === 'rgba(0, 0, 0, 0)'`,
      "hovering the gear on the welcome screen does not paint a background square");
    await click('#app-menu .app-menu-trigger');
    await evaluate(`createProjectItem().click(); settle()`);
    await evaluate(`body.querySelector('[data-board-type=agent]').click(); settle()`);
    await check(`createProjectCalls.length === 1 && createProjectCalls[0] === null`,
      "File invokes project creation from the welcome screen");
    await click('#app-settings');
    await check(`byId('settings-menu').matches(':popover-open') && !sheet.open &&
      byId('settings-menu-board').disabled && byId('settings-menu').querySelectorAll('[role="menuitem"]').length === 4`,
      "the gear opens the settings menu without a board and disables board settings");
    await click('#settings-menu-app');
    await evaluate(`waitFor(() => limitFields()[0].value === '1')`);
    await check(`limitFields().map(input => input.value).join(',') === '1,1' &&
      !!body.querySelector('.provider-panel') && !byId('tag-settings')`, "the gear menu opens shared settings even without an open board");
    await evaluate(`waitFor(() => !sandboxSelect().disabled && !sandboxSelect().parentElement.hidden)`);
    await check(`sandboxSelect().value === 'mxc'`, "Codex settings show the current Windows sandbox");
    await evaluate(`sandboxSelect().value = 'elevated'; sandboxSelect().dispatchEvent(new Event('change'));
      waitFor(() => !sandboxSelect().disabled && windowsSandbox === 'elevated')`);
    await evaluate(`limitFields()[0].value = '0'; byId('agent-limits').requestSubmit(); waitFor(() => !sheet.open)`);
    await click('#app-menu .app-menu-trigger');
    await click('#app-settings-menu-item');
    await evaluate(`waitFor(() => limitFields()[0].value === '0')`);
    await check(`limits.executor === 0 && limitFields()[1].value === '1'`, "File opens the same settings and zero is saved");
    await check(`sandboxSelect().value === 'elevated'`, "the Windows sandbox selection persists when settings reopen");
    await evaluate(`sheet.close(); openBoard('board-fixture'); void 0`);
    await check(`(() => {
      const tabs = byId('project-tabs');
      const gear = byId('app-settings');
      const tabsRect = tabs.getBoundingClientRect();
      const gearRect = gear.getBoundingClientRect();
      const gearStyle = getComputedStyle(gear);
      return tabsRect.right === gearRect.right && tabsRect.bottom === gearRect.top &&
        gearRect.bottom === document.querySelector('.status-bar').getBoundingClientRect().top &&
        gearStyle.borderInlineEndWidth === '1px' &&
        gearStyle.borderInlineEndColor === getComputedStyle(tabs).borderInlineEndColor;
    })()`, "the project tab divider continues beside the gear down to the status bar");
    await check(`gearMatchesRail()`, "the gear background matches the open board rail");
    await hover('#app-settings');
    await check(`gearMatchesRail() && byId('app-settings').matches(':hover')`, "the gear background stays matched on hover");
    await click('#app-menu .app-menu-trigger');
    await evaluate(`createProjectItem().click(); settle()`);
    await evaluate(`body.querySelector('[data-board-type=agent]').click(); settle()`);
    await check(`createProjectCalls[1] === 'board-fixture' && frame.project === 'board-fixture'`,
      "File invokes the same creation flow while a board is open");
    await click('#app-menu .app-menu-trigger');
    await click('#board-settings-menu-item');
    await check(`!!byId('tag-settings') && !byId('agent-limits') && sheet.textContent.includes('Первая доска')`,
      "File opens the selected board's settings");
    await evaluate(`waitFor(() => boardLimit('executor').placeholder === '0')`);
    await check(`boardLimit('executor').value === '' && boardLimit('reviewer').placeholder === '1'`,
      "board limits inherit per-role application defaults");
    await check(`managerAccess().value === 'auto' && managerAccess().closest('fieldset').textContent.includes('Менеджер проекта') &&
      [...managerAccess().options].map(option => option.text).join(',') === 'Запрашивать разрешение,Подтверждать за меня,Полный доступ'`,
      "manager settings show all three modes with automatic review selected by default");
    await evaluate(`boardLimit('executor').value = '2'; boardLimit('reviewer').value = '0';
      managerAccess().value = 'full';
      boardNameInput().form.requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`JSON.stringify(savedLimits.get('board-fixture')) === '{"executor":2,"reviewer":0}' &&
      limits.executor === 0 && limits.reviewer === 1`, "board overrides save without changing application defaults");
    await evaluate(`sheet.close(); byId('project-tabs').querySelector('[aria-selected="false"]').click(); settle()`);
    await click('#app-menu .app-menu-trigger');
    await click('#board-settings-menu-item');
    await check(`frame.project === 'other-board' && sheet.textContent.includes('Вторая доска') &&
      !!body.querySelector('.board-agent-settings') && !byId('agent-limits') &&
      boardLimit('executor').value === '' && boardLimit('reviewer').value === ''`, "File opens settings for the selected board");
    await check(`savedManagerAccess.get('board-fixture') === 'full' && managerAccess().value === 'auto'`,
      "manager full access saves for the selected board only");
    await evaluate(`boardNameInput().value = 'Выпуск 0.3'; boardNameInput().form.requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`byId('project-tabs').querySelector('[aria-selected=true] .project-tab-name').textContent === 'Выпуск 0.3' &&
      byId('project-tabs').querySelector('[aria-selected=false] .project-tab-name').textContent === 'Первая доска'`,
      "saving a name updates only the tab of that board");
    await evaluate(`boardSettings(); void 0`);
    await check(`boardNameInput().value === 'Выпуск 0.3'`, "reopening settings shows the saved board name");
    await evaluate(`boardNameInput().value = ''; boardNameInput().form.requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`byId('project-tabs').querySelector('[aria-selected=true] .project-tab-name').textContent === 'Вторая доска'`,
      "clearing the board name restores the folder name");
    await evaluate(`openBoard('board-fixture'); boardSettings(); void 0`);
    await check(`boardLimit('executor').value === '2' && boardLimit('manager') === null &&
      boardLimit('reviewer').value === '0'`, "saved overrides reopen including zero");
    await check(`managerAccess().value === 'full'`, "saved manager full access reopens enabled");
    await evaluate(`boardLimit('executor').value = ''; boardLimit('reviewer').value = '';
      managerAccess().value = 'ask';
      boardNameInput().form.requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`Object.keys(savedLimits.get('board-fixture')).length === 0`, "clearing overrides restores inheritance");
    await check(`savedManagerAccess.get('board-fixture') === 'ask'`, "manual approval can be selected");
    await evaluate(`sheet.close(); void 0`);
    const key = async keyCode => {
      keyCode = keyCode.replace(/^Arrow/, '');
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Return') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      if (keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await evaluate(`settle()`);
    };
    for (const theme of ['light', 'dark']) for (const russian of [false, true]) {
      nativeTheme.themeSource = theme;
      for (const width of [1380, 360]) for (const hasBoard of [false, true]) {
        window.setContentSize(width, 700);
        await evaluate(hasBoard ? `openBoard('board-fixture'); window.pushBoard({ ...frame, theme: '${theme}', russian: ${russian} }); void 0`
          : `window.pushBoard({ theme: '${theme}', russian: ${russian} }); void 0`);
        await click('#app-settings');
        await check(`byId('settings-menu').matches(':popover-open') &&
          byId('app-settings').getAttribute('aria-expanded') === 'true' &&
          document.activeElement === byId('settings-menu-app') &&
          byId('settings-menu-board').disabled === ${!hasBoard} &&
          !byId('settings-menu-updates').disabled &&
          byId('settings-menu-app').textContent === ${JSON.stringify(russian ? 'Настройки AI Taskboard…' : 'AI Taskboard settings…')} &&
          byId('settings-menu').querySelectorAll('[role="separator"]').length === 1`,
          `gear actions, labels and focus: ${theme}/${russian}/${width}/${hasBoard}`);
        await check(`(() => { const menu = byId('settings-menu'); const r = menu.getBoundingClientRect();
          const anchor = byId('app-settings').getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight &&
            Math.abs(r.bottom - anchor.bottom) <= 4 && menu.scrollWidth <= menu.clientWidth; })()`,
          `the anchored gear menu fits the viewport: ${theme}/${russian}/${width}/${hasBoard}`);
        if (keepArtifacts && width === 360) await capture(`settings-${theme}-${russian ? 'ru' : 'en'}-${hasBoard ? 'board' : 'welcome'}.png`);
        if (theme !== 'light' || russian || width !== 1380) {
          await evaluate(`byId('settings-menu').hidePopover(); settle()`);
          continue;
        }
        await key('End');
        await check(`document.activeElement === byId('settings-menu-updates')`,
          'End skips disabled menu actions');
        await key('ArrowDown');
        await check(`document.activeElement === byId('settings-menu-app')`, 'ArrowDown wraps to the first enabled action');
        await key('Escape');
        await check(`!byId('settings-menu').matches(':popover-open') && document.activeElement === byId('app-settings') &&
          byId('app-settings').getAttribute('aria-expanded') === 'false'`, 'Escape closes the menu and returns focus to the gear');
        await key('ArrowUp');
        await check(`document.activeElement === byId('settings-menu-updates')`,
          'ArrowUp opens the menu at its last enabled action');
        await key('Home');
        await key('ArrowDown');
        await check(`document.activeElement === byId('${hasBoard ? 'settings-menu-board' : 'settings-menu-updates'}')`,
          'ArrowDown skips board settings without a board');
        await key('ArrowUp');
        await check(`document.activeElement === byId('settings-menu-app')`, 'arrow navigation returns to the first action');
        await key('Tab');
        await check(`!byId('settings-menu').matches(':popover-open')`, 'Tab leaves and closes the menu');
        await click('#app-settings');
        window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: width - 12, y: 45 });
        window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: width - 12, y: 45 });
        await evaluate(`settle()`);
        await check(`!byId('settings-menu').matches(':popover-open') && document.activeElement === byId('app-settings')`,
          'clicking outside on a nonfocusable area closes the menu and restores focus');
        await evaluate(`byId('app-settings').focus(); void 0`);
        await key('Space');
        await check(`byId('settings-menu').matches(':popover-open')`, 'Space opens the gear menu');
        await key('Escape');
        await key('Return');
        await check(`byId('settings-menu').matches(':popover-open')`, 'Enter opens the gear menu');
        if (hasBoard) {
          await key('ArrowDown');
          await key('Return');
          await check(`sheet.open && !!byId('tag-settings') && !byId('agent-limits') && frame.project === 'board-fixture'`,
            'keyboard selection opens settings for the active board');
          await evaluate(`sheet.close(); settle()`);
          await check(`document.activeElement === byId('app-settings')`, 'closing board settings restores focus to the gear');
        } else {
          await key('Return');
          await evaluate(`waitFor(() => !!byId('agent-limits'))`);
          await check(`sheet.open && !byId('tag-settings')`, 'keyboard selection opens application settings without a board');
          await evaluate(`sheet.close(); settle()`);
        }
      }
    }
    await evaluate(`openBoard('board-fixture'); byId('app-settings').click(); openBoard('other-board'); void 0`);
    await check(`!byId('settings-menu').matches(':popover-open')`, 'switching tabs closes a menu for the previous board');
    await click('#app-settings');
    await click('#settings-menu-board');
    await check(`sheet.textContent.includes('Вторая доска') && frame.project === 'other-board'`,
      'reopening the gear menu uses the newly active board');
    console.log("Settings Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--reviewer-chat-only")) {
    await evaluate(`
      const reviewed = fixture.board.tasks[1];
      reviewed.status = 'review';
      reviewed.history.push({ action: 'review-approve', actor: 'reviewer', text: 'Сохранённое согласование.',
        at: reviewed.updatedAt });
      let attempts = [];
      let reviewerReads = 0;
      const work = () => byId('task-chat-work');
      const reviewRows = () => [...work().querySelectorAll('.task-review-attempt')];
      window.taskboard.command = async () => ({ ok: true, data: structuredClone(reviewed) });
      window.taskboard.chatModels = async () => ({ ok: true, data: [] });
      window.taskboard.reviewerChat = async () => {
        reviewerReads++;
        return { ok: true, data: structuredClone(attempts) };
      };
      push();
      showTask(reviewed.id);
      waitFor(work);
    `);
    await check(`reviewRows().length === 0 && reviewerReads === 0`, "the dialogue leaves review history unloaded");
    await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click();
      waitFor(() => reviewerReads === 1 && work().textContent.includes('Сохранённое согласование.'))`);
    await check(`reviewRows().length === 0`, "legacy decisions appear in the work feed without an attempt record");
    await evaluate(`
      const summary = { id: 'summary', title: '', type: 'reasoning', text: 'Сводка проверки', status: 'inProgress' };
      const live = { id: 'review-1', at: '2025-03-01T00:00:00.000Z', items: [
        { id: 'commentary', title: '', type: 'agentMessage', phase: 'commentary', text: 'Сверяю критерии.', status: 'completed' },
        summary,
        { id: 'tool', title: 'task_review_diff', type: 'dynamicToolCall', text: '[]', status: 'completed' }
      ] };
      attempts = [live];
      const publishReview = () => window.pushChat({ project: fixture.project, id: reviewed.id, type: 'reviewer-chat' });
      publishReview();
      waitFor(() => reviewRows()[0]?.textContent.includes('Сводка проверки'));
    `);
    await check(`getComputedStyle(reviewRows()[0].firstElementChild).clipPath === 'none' &&
      reviewRows()[0].firstElementChild.checkVisibility() && reviewRows()[0].textContent.includes('Ревьюер #1') &&
      reviewRows()[0].querySelector('[data-item="item:summary"] pre').checkVisibility() &&
      reviewRows()[0].textContent.includes('Сверяю критерии.') &&
      reviewRows()[0].textContent.includes('task_review_diff')`, "the open work feed shows a live summary, commentary and action");
    if (keepArtifacts) await capture("review-live.png");
    await evaluate(`
      live.durationMs = 1200;
      summary.status = 'completed';
      summary.text += ' завершена';
      live.items.push({ id: 'result', title: '', type: 'agentMessage', phase: 'final_answer', status: 'completed',
        text: JSON.stringify({ summary: 'Результат согласован.', findings: [], evidence: ['Критерий проверен.'], needsHuman: false }) });
      attempts.push({ id: 'review-2', at: '2025-03-02T00:00:00.000Z', durationMs: 900, items: [
        { ...summary, text: ' ' }, { ...live.items[2] }, { ...live.items[3], text: '{"summary":"Повторная проверка завершена."}' }
      ] });
      publishReview();
      waitFor(() => reviewRows().length === 2);
    `);
    await check(`reviewRows()[0].textContent.includes('Критерий проверен.') &&
      !reviewRows()[0].textContent.includes('needsHuman') &&
      reviewRows()[0].querySelectorAll('[data-item="item:summary"]').length === 1 &&
      [...reviewRows()[0].querySelector('.chat-run').children].map(node => node.dataset.item).join(',') ===
        'message:commentary,item:summary,item:tool,message:result' &&
      reviewRows()[1].textContent.includes('Ревьюер #2') && reviewRows()[1].textContent.includes('task_review_diff') &&
      reviewRows()[1].textContent.includes('Повторная проверка завершена.') &&
      !reviewRows()[1].querySelector('[data-item="item:summary"]')`, "completed attempts keep event order and show checks and outcome without a summary");
    await evaluate(`(async () => {
      sheet.close();
      chatDrafts.clear();
      reviewed.status = 'done';
      await showTask(reviewed.id);
      document.querySelector('[aria-controls="task-chat-work"]').click();
      await waitFor(() => reviewRows().length === 2);
      publishReview();
      await waitFor(() => reviewerReads >= 5);
    })()`);
    await check(`reviewRows().length === 2 && reviewRows()[0].textContent.includes('Сводка проверки завершена') &&
      reviewRows()[1].textContent.includes('Повторная проверка завершена.')`, "reopening and refreshing load each saved attempt once");
    if (keepArtifacts) await capture("review-reopened.png");
    console.log("Reviewer chat Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--markdown-links-only")) {
    await evaluate(`
      const documentPath = 'docs/coverage/classes/@GlobalScope.md';
      const cardWithDocument = fixture.board.tasks[1];
      cardWithDocument.description = 'Проверить error_string в ' + documentPath + '.';
      window.taskboard.command = async () => ({ ok: true, data: structuredClone(cardWithDocument) });
      window.taskboard.chatModels = async () => ({ ok: true, data: [] });
      const externalLinks = [];
      let openedDocument;
      window.taskboard.openLink = async url => { externalLinks.push(url); };
      window.taskboard.readMarkdown = async (id, link) => {
        openedDocument = { id, link };
        return { ok: true, data: { path: link, name: '@GlobalScope.md', text: '# GlobalScope' } };
      };
      push();
      showTask(cardWithDocument.id);
      waitFor(() => sheet.open && body.querySelector('.sheet-section .chat-text a'));
    `);
    await evaluate(`
      body.querySelector('.sheet-section .chat-text a').click();
      waitFor(() => document.querySelector('.markdown-preview .chat-text h1') || externalLinks.length);
    `);
    await check(`openedDocument?.id === cardWithDocument.id && openedDocument.link === documentPath &&
      document.querySelector('.markdown-preview h2').textContent === '@GlobalScope.md' && !externalLinks.length`,
      "a plain Markdown path containing @ opens the task's document preview");
    await evaluate(`document.querySelector('.markdown-preview').close(); settle()`);
    await check(`sheet.open && !document.querySelector('.markdown-preview')`, "closing the document returns to the task");
    console.log("Markdown link Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--git-status-only")) {
    await check(`byId('status-branch').hidden && byId('status-publish').hidden && byId('status-tracking').hidden`,
      "a board without a repository hides the Git controls");
    await evaluate(`
      fixture.board.gitInfo = { branch: 'master' };
      window.taskboard.command = async (action, _id, input) => {
        if (action === 'git-refs') return { ok: true, data: { branch: 'master', refs: [] } };
        if (action === 'git-create' && input.branch === 'master' && input.head === undefined && input.name === 'main') {
          return { ok: true, data: { branch: 'main', refs: [] } };
        }
        throw new Error('Unexpected Git operation');
      };
      push();
      byId('status-branch').click();
      waitFor(() => byId('git-branches').querySelector('.git-ref-list'));
    `);
    await check(`byId('status-branch').textContent === 'До первого коммита' && byId('status-publish').hidden &&
      byId('git-branches').textContent.includes('Веток и тегов пока нет.') &&
      byId('git-branches').querySelector('input').hidden &&
      [...byId('git-branches').querySelectorAll('button:not([hidden])')].map(button => button.textContent).join() === 'Создать новую ветку…'`,
      "an unborn HEAD has a distinct label and only the available Git action");
    await evaluate(`byId('git-branches').querySelector('button:not([hidden])').click(); waitFor(() => sheet.open)`);
    await check(`body.textContent.includes('Имя для первого коммита.') && !body.textContent.includes('master')`,
      "naming the first branch does not present the pending name as a source reference");
    await evaluate(`body.querySelector('form input').value = 'main'; body.querySelector('form').requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`byId('status-branch').textContent === 'До первого коммита'`, "renaming the unborn HEAD keeps the empty state");
    await evaluate(`fixture.board.gitInfo = { branch: 'main', head: '0123456789abcdef' }; push(); void 0`);
    await check(`byId('status-branch').textContent === 'main' && !byId('status-publish').hidden && byId('status-tracking').hidden`,
      "a branch without tracking shows the publication control");
    await evaluate(`
      const publicationCalls = [];
      window.taskboard.command = async (action, _id, input) => {
        if (action === 'git-refs') return { ok: true, data: fixture.board.gitInfo };
        publicationCalls.push({ action, input });
        return { ok: true, data: { remote: 'https://github.com/example/project' } };
      };
      byId('status-publish').click(); waitFor(() => sheet.open);
    `);
    await check(`body.querySelector('form input').value && body.textContent.includes('main')`,
      "publication still opens its repository form for the current branch");
    await evaluate(`body.querySelector('form').requestSubmit(); waitFor(() => !sheet.open)`);
    await check(`publicationCalls.length === 1 && publicationCalls[0].action === 'git-publish' &&
      publicationCalls[0].input.branch === 'main' && !byId('status-publish').disabled`,
      "publication submits the branch and restores its button without a user element");
    await evaluate(`fixture.board.gitInfo.tracking = { behind: 0, ahead: 19 }; push(); void 0`);
    await check(`!byId('status-tracking').hidden && byId('status-publish').hidden &&
      byId('status-tracking').textContent === '0↓ 19↑' &&
      byId('status-tracking').getAttribute('aria-label').includes('Опережение 19') &&
      getComputedStyle(byId('status-branch')).borderTopRightRadius === '0px' &&
      getComputedStyle(byId('status-tracking')).borderTopRightRadius === '4px'`,
      "a tracked branch shows behind and ahead in the reference order with an accessible label");
    await check(`(() => {
      const [icon, counts] = byId('status-tracking').children;
      const glyph = getComputedStyle(icon, '::before');
      return glyph.content === JSON.stringify(String.fromCodePoint(0xea77)) && glyph.fontFamily === 'codicon' &&
        icon.getBoundingClientRect().right < counts.getBoundingClientRect().left;
    })()`, "the circular Codicon arrows render to the left of the Git counts");
    await evaluate(`
      const pushButton = byId('status-tracking');
      const pushCalls = [];
      let finishPush;
      window.taskboard.command = async (action, id, input) => {
        pushCalls.push({ action, id, input });
        return new Promise(resolve => { finishPush = resolve; });
      };
      const spin = () => getComputedStyle(pushButton.querySelector('.codicon-sync')).animationName;
      void 0;
    `);
    await click('#status-tracking');
    await check(`pushButton.disabled && pushButton.getAttribute('aria-busy') === 'true' && spin() === 'agent-spin' &&
      pushCalls.length === 1 && pushCalls[0].action === 'git-push' && pushCalls[0].id === undefined &&
      pushCalls[0].input.branch === 'main' && pushCalls[0].input.head === fixture.board.gitInfo.head &&
      pushButton.textContent === '0↓ 19↑'`, "clicking the tracking button pushes the displayed branch tip and spins only the icon");
    await evaluate(`pushButton.click(); push(); settle()`);
    await check(`pushCalls.length === 1 && pushButton.disabled && spin() === 'agent-spin'`,
      "a board refresh preserves the running state and repeat clicks cannot start a second push");
    await evaluate(`
      window.pushBoard({ ...fixture, project: 'other-board' });
      void 0;
    `);
    await check(`!pushButton.disabled && spin() === 'none'`, "another project does not inherit the active push");
    await evaluate(`push(); void 0`);
    await check(`pushButton.disabled && spin() === 'agent-spin'`, "returning to the original board restores the spinner");
    window.webContents.debugger.attach();
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await check(`pushButton.disabled && pushButton.getAttribute('aria-busy') === 'true' && spin() === 'none'`,
      "reduced motion keeps the busy state without rotating the icon");
    window.webContents.debugger.detach();
    await evaluate(`finishPush({ ok: true, data: { branch: 'main' } }); waitFor(() => !pushButton.disabled)`);
    await check(`pushButton.getAttribute('aria-busy') === 'false' && spin() === 'none'`, "a successful push stops the spinner");
    await evaluate(`fixture.board.gitInfo.tracking = { behind: 0, ahead: 0 }; push(); void 0`);
    await check(`byId('status-tracking').textContent === '0↓ 0↑' && !byId('status-tracking').hidden`,
      "tracking remains visible when both counts are zero");
    await evaluate(`
      fixture.board.gitInfo.tracking = { behind: 1, ahead: 2 }; push();
      pushButton.click();
      waitFor(() => pushCalls.length === 2);
    `);
    await evaluate(`
      finishPush({ ok: false, error: { code: 'GIT_PUSH_FAILED', message: 'Rejected by the remote.' } });
      waitFor(() => !pushButton.disabled)
    `);
    await check(`spin() === 'none' && pushButton.textContent === '1↓ 2↑' &&
      !byId('notice').hidden && byId('notice').textContent.includes('Rejected by the remote.') &&
      byId('notice').textContent.includes('Отправка коммитов')`,
      "a rejected push restores the button and preserves the counts with a contextual error");
    await evaluate(`updateGitRevision({ branch: 'side', head: fixture.board.gitInfo.head }); void 0`);
    await check(`byId('status-tracking').hidden && byId('status-branch').textContent === 'side'`,
      "switching branches clears the previous counts until the watcher refreshes");
    await evaluate(`delete fixture.board.gitInfo.branch; push(); void 0`);
    await check(`byId('status-branch').textContent === '01234567' && byId('status-publish').hidden && byId('status-tracking').hidden`,
      "detached HEAD shows the commit hash and keeps the Git menu available");
    for (const theme of ["dark", "light"]) {
      for (const width of [1380, 760]) {
        window.setContentSize(width, 760);
        await evaluate(`fixture.theme = '${theme}'; void 0`);
        for (const git of [undefined, { branch: 'main' },
          { branch: 'main', head: '0123456789abcdef' },
          { head: '0123456789abcdef' },
          { branch: 'main', head: '0123456789abcdef', tracking: { behind: 1, ahead: 2 } }]) {
          await evaluate(`
            fixture.board.gitInfo = ${JSON.stringify(git)};
            if (fixture.board.gitInfo) fixture.board.gitInfo.user = 'Developer';
            push();
            window.pushBoard({ ...fixture, project: 'other-board' });
            push(); settle();
          `);
          await check(`document.documentElement.dataset.theme === '${theme}' &&
            !byId('status-user') && !document.querySelector('.status-bar .codicon-account') &&
            !document.querySelector('.status-bar').textContent.includes('Developer') &&
            document.querySelector('.status-activity').previousElementSibling.id === 'git-branches' &&
            (() => {
              const bar = document.querySelector('.status-bar').getBoundingClientRect();
              const group = document.querySelector('.status-repository').getBoundingClientRect();
              const bell = byId('status-notifications').getBoundingClientRect();
              return bar.bottom === innerHeight && bell.right <= innerWidth &&
                bell.left >= group.right && Math.abs(bell.top + bell.height / 2 - (bar.top + bar.height / 2)) <= 1;
            })()`, theme + ' ' + width + ': refresh and project switches retain aligned controls without a user or its spacing');
        }
        await capture('status-bar-' + theme + '-' + width + '.png');
      }
    }
    await evaluate(`byId('status-notifications').click(); settle()`);
    await check(`byId('notifications').matches(':popover-open')`, "the review notification menu still opens after refresh and project switches");
    console.log("Git status Chromium checks passed: " + checks);
    return;
  }
  window.webContents.debugger.attach();
  const emulateMotion = value => window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: value ? [{ name: "prefers-reduced-motion", value }] : [],
  });
  await emulateMotion("no-preference");
  await check(`!byId('lanes').getAnimations({ subtree: true }).some(animation => animation.id === 'task-card-enter')`,
    "restoring a board shows its existing cards immediately");
  await evaluate(`
    fixture.board.tasks.push(
      task('T-0096', 'В работе', { status: 'in_progress' }),
      task('T-0097', 'Завершено', { status: 'done' })
    );
    push();
    settle();
  `);
  await evaluate(`
    const movingCard = findCard('T-0002');
    const sourceNeighbor = findCard('T-0001');
    const destinationNeighbor = findCard('T-0096');
    const unrelatedCard = findCard('T-0097');
    const cardMove = (node = movingCard) => node.getAnimations().find(animation => animation.id === 'task-card-move');
    const near = (a, b) => Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1;
    const pauseAtStart = animation => {
      if (animation) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animation;
    };
    const moveCard = status => {
      fixture.board.tasks[1].status = status;
      push();
      return pauseAtStart(cardMove());
    };
    const origin = movingCard.getBoundingClientRect();
    const sourceOrigin = sourceNeighbor.getBoundingClientRect();
    const destinationOrigin = destinationNeighbor.getBoundingClientRect();
    const firstMove = moveCard('in_progress');
    const sourceShift = pauseAtStart(cardMove(sourceNeighbor));
    const destinationShift = pauseAtStart(cardMove(destinationNeighbor));
    void 0;
  `);
  await check(`Boolean(firstMove && lane('in_progress').contains(movingCard) && near(movingCard.getBoundingClientRect(), origin))`,
    "a status update moves the same card into its new column and animates from its previous position");
  await check(`Boolean(sourceShift && destinationShift &&
    near(sourceNeighbor.getBoundingClientRect(), sourceOrigin) && near(destinationNeighbor.getBoundingClientRect(), destinationOrigin))`,
    "neighbors in the source and destination columns start at their old positions");
  await check(`(() => {
    firstMove.currentTime = 120;
    sourceShift.currentTime = 120;
    destinationShift.currentTime = 120;
    const midway = movingCard.getBoundingClientRect();
    push();
    return midway.left > origin.left && midway.left < lane('in_progress').getBoundingClientRect().left &&
      sourceNeighbor.getBoundingClientRect().top < sourceOrigin.top &&
      destinationNeighbor.getBoundingClientRect().top > destinationOrigin.top &&
      cardMove() === firstMove && cardMove(sourceNeighbor) === sourceShift &&
      cardMove(destinationNeighbor) === destinationShift && !cardMove(unrelatedCard);
  })()`, "an ordinary refresh preserves live movement and leaves unrelated cards still");
  await check(`(() => {
    const midway = movingCard.getBoundingClientRect();
    const neighborMidway = destinationNeighbor.getBoundingClientRect();
    const nextMove = moveCard('review');
    const nextShift = pauseAtStart(cardMove(destinationNeighbor));
    return firstMove.playState === 'idle' && nextMove && lane('review').contains(movingCard) &&
      near(movingCard.getBoundingClientRect(), midway) && destinationShift.playState === 'idle' &&
      nextShift && near(destinationNeighbor.getBoundingClientRect(), neighborMidway);
  })() === true`, "a second status update continues both the card and its neighbor from their current positions");
  await check(`(() => {
    cardMove().finish();
    cardMove(destinationNeighbor).finish();
    cardMove(sourceNeighbor).finish();
    return !cardMove() && !cardMove(sourceNeighbor) && !cardMove(destinationNeighbor) &&
      near(destinationNeighbor.getBoundingClientRect(), destinationOrigin) &&
      Math.abs(movingCard.getBoundingClientRect().left - lane('review').getBoundingClientRect().left) < 1;
  })()`, "the animated card and its neighbors reach their new layout without lingering transforms");
  await evaluate(`moveCard('done'); void 0`);
  await emulateMotion("reduce");
  await evaluate(`settle()`);
  await check(`!cardMove() && !cardMove(unrelatedCard) && lane('done').contains(movingCard)`,
    "enabling reduced motion ends card and neighbor movement already in flight");
  await check(`moveCard('ready') === undefined && !cardMove(sourceNeighbor) && lane('ready').contains(movingCard)`,
    "reduced motion moves the card and its neighbors immediately");
  await emulateMotion("no-preference");
  await evaluate(`
    const enter = node => node.getAnimations().find(animation => animation.id === 'task-card-enter');
    const addReady = id => {
      fixture.board.tasks.push(task(id, 'Новая карточка', { createdAt: '2026-11-15T12:00:00.000Z' }));
      push();
      return findCard(id);
    };
    const readyOrigin = movingCard.getBoundingClientRect();
    const newCard = addReady('T-0098');
    const appearance = pauseAtStart(enter(newCard));
    const readyShift = pauseAtStart(cardMove());
    void 0;
  `);
  await check(`Boolean(appearance && getComputedStyle(newCard).opacity === '0' &&
    readyShift && lane('ready').contains(newCard) && near(movingCard.getBoundingClientRect(), readyOrigin) &&
    !cardMove(unrelatedCard) && !enter(unrelatedCard))`,
    "a new task fades in while existing cards start moving from their old positions");
  await check(`(() => {
    appearance.currentTime = 140;
    readyShift.currentTime = 140;
    push();
    const opacity = Number(getComputedStyle(newCard).opacity);
    return enter(newCard) === appearance && cardMove() === readyShift &&
      opacity > 0 && opacity < 1 && movingCard.getBoundingClientRect().top > readyOrigin.top;
  })()`, "a refresh preserves the card entrance and neighbors' movement mid-animation");
  await check(`(() => {
    appearance.finish();
    readyShift.finish();
    return !enter(newCard) && getComputedStyle(newCard).opacity === '1' && !cardMove();
  })()`, "the card is fully visible and its neighbor reaches the new position");
  await evaluate(`const nextEntrance = pauseAtStart(enter(addReady('T-0099'))); void 0`);
  await check(`Boolean(nextEntrance)`, "a subsequent creation starts a new entrance animation");
  await emulateMotion("reduce");
  await evaluate(`settle()`);
  await check(`nextEntrance.playState === 'idle' && !enter(addReady('T-0100')) &&
    getComputedStyle(findCard('T-0100')).opacity === '1'`,
    "reduced motion cancels an entrance in flight and shows later cards immediately");
  await emulateMotion();
  await evaluate(`fixture.board.tasks.splice(2); push(); settle()`);
  window.webContents.debugger.detach();
  if (process.argv.includes("--card-movement-only")) {
    console.log("Card movement Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--working-directory-only")) {
    await evaluate(`
      const selectedTask = fixture.board.tasks[0];
      const selectedPath = 'C:/Test/Shared files';
      selectedTask.workingDirectory = selectedPath;
      window.taskboard.command = async action => {
        if (action !== 'show') throw new Error('Unexpected action ' + action);
        return { ok: true, data: structuredClone(selectedTask) };
      };
      push();
      showTask(selectedTask.id);
      waitFor(() => body.textContent.includes(selectedPath));
    `);
    await check(`body.textContent.includes('Рабочая папка') &&
      ![...body.querySelectorAll('button')].some(control => control.textContent === 'Параметры запуска…')`,
      "a manager-set working directory is visible in the card");
    console.log("Working directory Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--schedule-only")) {
    await evaluate(`
      const recurringTask = fixture.board.tasks[0];
      recurringTask.schedule = { everyMinutes: 60, nextAt: '2030-01-14T09:00:00.000Z' };
      window.taskboard.command = async action => {
        if (action !== 'show') throw new Error('Unexpected action ' + action);
        return { ok: true, data: structuredClone(recurringTask) };
      };
      push();
      showTask(recurringTask.id);
      waitFor(() => body.textContent.includes('Следующий запуск'));
    `);
    await check(`!!findCard(recurringTask.id).querySelector('.task-schedule') &&
      ![...body.querySelectorAll('button')].some(control => control.textContent === 'Редактировать')`,
      "a manager-set schedule and its next run stay visible without the manual editor");
    console.log("Task schedule Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--goal-reply-only")) {
    await evaluate(`
      const activeGoal = { objective: 'Проверить карточки', status: 'active' };
      fixture.managerBusy = true;
      fixture.managerWork = { id: 'goal-run', phase: 'running', lane: 'work', startedAt: Date.now(),
        item: { type: 'mcpToolCall', title: 'ai_taskboard / task_wait', text: '', status: 'inProgress' } };
      window.taskboard.boardHistory = async (_project, _cursor, view) => ({ ok: true, data: view === 'live'
        ? { work: [], chat: [] } : { turns: [], goal: activeGoal, goalRunning: true } });
      push();
    `);
    await clickManagerField();
    await evaluate(`waitFor(() => !document.querySelector('.board-goal').hidden)`);
    await click(".board-work-toggle");
    await evaluate(`
      const workForm = document.querySelector('#board-draft');
      const workSends = [];
      window.taskboard.boardRequest = async (text, _files, project, goal, immediate, id, goalRunId) => {
        workSends.push({ text, goal, immediate, goalRunId });
        await window.taskboard.boardQueue(project, 'remove', id);
        return { ok: true, data: null };
      };
      workForm.querySelector('.draft-input textarea').value = 'Выбираю первый вариант';
      workForm.requestSubmit();
      waitFor(() => workSends.length && !workForm.querySelector('.board-queued-row'));
    `);
    await check(`workSends[0].text === 'Выбираю первый вариант' && workSends[0].immediate === true &&
      workSends[0].goal === false && workSends[0].goalRunId === 'goal-run' &&
      document.querySelector('.board-work').checkVisibility()`,
      "sending from Work Activity reaches the active goal without leaving its tab");
    await evaluate(`
      const goalQuestion = { id: 'goal-question', text: 'Выбрать первый вариант?', options: ['Да', 'Нет'] };
      const updateQuestion = question => window.pushChat({ project: fixture.project, type: 'orchestrator-question', question });
      let goalAnswer;
      window.taskboard.answerBoardQuestion = async (id, answer) => {
        goalAnswer = { id, answer };
        updateQuestion(null);
        return { ok: true, data: null };
      };
      updateQuestion(goalQuestion);
    `);
    await check(`document.querySelector('.manager-question[open]')?.textContent.includes(goalQuestion.text)`,
      "a goal question opens an answer form over Work Activity");
    await evaluate(`document.querySelector('.manager-question[open] .manager-question-options button').click(); settle()`);
    await check(`goalAnswer?.id === 'goal-question' && goalAnswer.answer === 'Да' &&
      document.querySelector('.board-work').checkVisibility()`,
      "choosing an answer responds to the goal question in Work Activity");
    console.log("Goal replies Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--goal-only")) {
    await evaluate(`
      const savedGoal = { objective: 'Проверить карточки', status: 'active' };
      const goalUpdate = (goal, goalRunning) => window.pushChat({
        project: fixture.project, type: 'orchestrator-goal', goal, goalRunning,
      });
      window.taskboard.boardHistory = async () => ({ ok: true, data: { turns: [], goal: savedGoal, goalRunning: false } });
      const goalPanel = document.querySelector('.board-goal');
      const [, pauseGoal, resumeGoal] = goalPanel.querySelectorAll('button');
      const displayedGoal = () => goalPanel.querySelector('.board-goal-status').textContent;
      void 0;
    `);
    await clickManagerField();
    await evaluate(`waitFor(() => !goalPanel.hidden)`);
    await evaluate(`goalPanel.querySelector('summary').click(); settle()`);
    await check(`displayedGoal() === 'Цель ждёт продолжения' && !pauseGoal.checkVisibility() && resumeGoal.checkVisibility()`,
      "a saved active goal without a run offers continuation");
    await evaluate(`goalUpdate(savedGoal, true); settle()`);
    await check(`displayedGoal() === 'Активная цель' && pauseGoal.checkVisibility() && !resumeGoal.checkVisibility()`,
      "a goal running from another window shows only pause");
    await evaluate(`goalUpdate(undefined, false); settle()`);
    await check(`displayedGoal() === 'Цель ждёт продолжения' && !pauseGoal.checkVisibility() && resumeGoal.checkVisibility()`,
      "the end of the run updates the panel without changing the saved goal");
    await evaluate(`goalUpdate({ ...savedGoal, status: 'paused' }, false); settle()`);
    await check(`displayedGoal() === 'Цель на паузе' && !pauseGoal.checkVisibility() && resumeGoal.checkVisibility()`,
      "a paused goal offers resume");
    await evaluate(`goalUpdate({ ...savedGoal, status: 'complete' }, false); settle()`);
    await check(`displayedGoal() === 'Цель выполнена' && !pauseGoal.checkVisibility() && !resumeGoal.checkVisibility()`,
      "a completed goal offers neither pause nor resume");
    await evaluate(`
      fixture.project = 'already-running-goal';
      fixture.managerWork = { id: 'goal-run', phase: 'running', startedAt: Date.now(), item: { type: 'mcpToolCall',
        title: 'ai_taskboard / task_wait', text: '', status: 'inProgress' } };
      const coordination = { id: 'coordination-1', type: 'mcpToolCall', title: 'task_wait', text: '', status: 'completed',
        messagesOnly: true, messages: [{ id: 'T-0001', sequence: 1, actor: 'agent',
          text: 'Детали работы исполнителя.\\n\\n### Технические детали\\n\\nЛог сборки.' }] };
      const reportCommit = '06b8c3dcc3f1f7bf008051b90e4a820c27a66203';
      const reportText = [
        'Текущая ветка main на коммите ' + reportCommit + ' включает принятые за эту неделю изменения.',
        'В реестре реализовано **76,99 % API**. Подробности внесены в [отчёт сверки](docs/report.md).',
        'T-0023 запущена для завершения учёта файловых ошибок и проверки принятой ветки для следующего выпуска.',
        'Карточка T-0061 готова, но её запуск отложен до освобождения исполнителя, который занят текущей проверкой.',
        'Следующей можно запустить T-0048. Приёмка изменений и проверки выпуска запланированы после достижения цели.',
      ].join(' ');
      const savedReply = { id: 'saved-reply', type: 'agentMessage', phase: 'final_answer', title: '', status: 'completed',
        text: 'Сохранённый ответ.\\n\\n' + reportText + '\\n\\n### Технические детали\\n\\nСлужебная подпись.\\n\\n### Команда для запуска\\n\\nЗапустите проверку.' };
      const dialogueLog = () => document.querySelector('.board-chat-log:not(.board-work)');
      window.taskboard.boardHistory = async (_project, _cursor, view) => ({ ok: true, data: view === 'live' ? { work: [], chat: [] } :
        { turns: [{ messages: [], items: [view === 'work' ? coordination : savedReply] }], goal: savedGoal, goalRunning: true } });
      push();
      void 0;
    `);
    await check(`document.querySelector('.draft-send').dataset.action === 'send' &&
      document.querySelector('.draft-placeholder').textContent.includes('Жду обновления на доске')`,
      "an active goal supplies activity while the manager composer can send");
    await clickManagerField();
    await check(`(() => {
      const bar = document.querySelector('.board-chat-bar');
      const dialogue = bar.querySelector('.board-dialogue-toggle');
      const work = bar.querySelector('.board-work-toggle');
      const grip = bar.querySelector('.board-chat-resize').getBoundingClientRect();
      const pin = bar.querySelector('.board-chat-pin').getBoundingClientRect();
      return dialogue.getAttribute('aria-pressed') === 'true' && work.getAttribute('aria-pressed') === 'false' &&
        work.getBoundingClientRect().right < grip.left && grip.right < pin.left;
    })()`, "the toolbar separates conversation tabs, resize handle, and pin");
    await evaluate(`waitFor(() => dialogueLog().textContent.includes('Сохранённый ответ'))`);
    await check(`getComputedStyle(dialogueLog().querySelector('.chat-report-details')).display === 'none' &&
      dialogueLog().querySelector('h3').textContent === 'Команда для запуска'`,
      "dialogue hides the generic appendix from saved replies and retains specific sections");
    await check(`(async () => {
      const report = dialogueLog().querySelector('.chat-run-final .chat-text');
      const paragraphs = [...report.querySelectorAll(':scope > p')].slice(1, -1);
      if (paragraphs.length < 2 || !report.querySelector('strong') || !report.querySelector('a[href="docs/report.md"]')) return false;
      const taskId = report.querySelector('code.chat-task-reference');
      if (taskId?.textContent !== 'T-0023' || getComputedStyle(taskId).whiteSpace !== 'nowrap') return false;
      const hash = report.querySelector('.chat-digest');
      if (hash?.title !== reportCommit || hash.textContent !== reportCommit.slice(0, 12) + '…') return false;
      const original = chatText(reportText, { agent: true, source: 'discussion.md' }).querySelector('p').textContent;
      if (paragraphs.map(p => p.textContent).join('').replace(hash.textContent, reportCommit) !== original ||
          chatText(reportText, {}).querySelectorAll('p').length !== 1) return false;
      let copied;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
      try {
        hash.click();
        await Promise.resolve();
        return copied === reportCommit;
      } finally { delete navigator.clipboard; }
    })()`, "saved manager reports break up dense prose, preserve Markdown and copy the full commit");
    await click(".board-work-toggle");
    await evaluate(`waitFor(() => document.querySelector('.board-work').textContent.includes('Детали работы исполнителя'))`);
    await check(`document.querySelector('.board-work').checkVisibility() &&
      document.querySelector('.board-work-toggle').getAttribute('aria-pressed') === 'true' &&
      document.querySelector('.board-work-overview').textContent.includes('Жду обновления на доске') &&
      document.querySelector('.board-work .chat-report-details > summary').checkVisibility() &&
      !document.querySelector('.board-chat-log:not(.board-work)').textContent.includes('Детали работы исполнителя')`,
      "work activity shows the live goal and saved coordination outside the dialogue");
    await click(".board-dialogue-toggle");
    await check(`document.querySelector('.board-work').hidden &&
      document.querySelector('.board-dialogue-toggle').getAttribute('aria-pressed') === 'true'`,
      "dialogue can be selected directly while background work continues");
    if (keepArtifacts) await capture("board-manager-toolbar.png");
    await click(".board-work-toggle");
    await evaluate(`
      window.taskboard.boardRequest = async (prompt, _files, _project, goal) => ({
        ok: !goal, data: { answer: prompt + ' · ответ\\n\\n### Technical details\\n\\nChecked the source.', changes: [] },
      });
      const parallelForm = document.querySelector('#board-draft');
      parallelForm.querySelector('.draft-input textarea').value = 'Вопрос менеджеру';
      parallelForm.requestSubmit();
      waitFor(() => document.querySelector('.board-chat-log:not(.board-work)').textContent.includes('Вопрос менеджеру · ответ'));
    `);
    await check(`document.querySelector('.board-work').hidden && document.querySelector('.board-work-toggle').classList.contains('working')`,
      "submitting a dialogue while the goal is running opens the reply and leaves the goal active");
    await check(`getComputedStyle(dialogueLog().querySelector('.chat-entry .chat-report-details')).display === 'none'`,
      "dialogue hides the generic appendix on an immediate reply too");
    await evaluate(`
      fixture.project = 'already-running-dialogue';
      fixture.managerWork = null;
      fixture.managerRun = { id: 'existing-run', phase: 'running' };
      window.taskboard.boardHistory = async () => ({ ok: true, data: { turns: [], goal: savedGoal, goalRunning: true } });
      push();
      const managerField = () => document.querySelector('.draft-placeholder');
      const managerButton = () => document.querySelector('.draft-send');
      const managerStatus = () => document.querySelector('.board-chat .chat-thinking');
      const publishManagerRun = run => window.pushChat({ project: fixture.project, type: 'orchestrator-run', managerRun: run });
      void 0;
    `);
    await check(`managerButton().dataset.action === 'stop' && !managerButton().disabled && managerField().textContent === 'Думаю…'`,
      "a new board view shows the running goal from its snapshot before opening the chat");
    await evaluate(`publishManagerRun({ ...fixture.managerRun, item: {
      type: 'mcpToolCall', status: 'inProgress', title: 'ai_taskboard / project_git', text: '',
    } }); void 0`);
    await check(`managerField().textContent === 'Вызов инструмента ai_taskboard / project_git'`,
      "live activity from another window updates the collapsed composer");
    await clickManagerField();
    await evaluate(`waitFor(() => document.querySelector('.board-goal-status').textContent === 'Активная цель')`);
    await check(`managerStatus().textContent === 'Вызов инструмента ai_taskboard / project_git' && !managerButton().disabled`,
      "loading history keeps the current status and stop control for a restored run");
    await evaluate(`
      let stopCalls = 0;
      window.taskboard.stopOrchestrator = async () => {
        stopCalls++;
        publishManagerRun(null);
        return { ok: true, data: null };
      };
      managerButton().click();
      waitFor(() => !managerStatus());
    `);
    await check(`stopCalls === 1 && managerButton().dataset.action === 'send'`,
      "stopping a restored run calls the manager and clears its activity when it ends");
    await clickBoard();
    for (const russian of [true, false]) {
      await evaluate(`fixture.russian = ${russian}; fixture.managerRun = null;
        fixture.managerWork = { id: 'goal-run', phase: 'running', startedAt: Date.now() }; push(); void 0`);
      for (const [item, expected] of [
        [{ type: 'mcpToolCall', title: 'ai_taskboard / task_set_milestone', text: '', status: 'inProgress' },
          russian ? 'Вызов инструмента ai_taskboard / task_set_milestone' : 'Using tool ai_taskboard / task_set_milestone'],
        [{ type: 'agentMessage', title: '', text: '', status: 'inProgress' },
          russian ? 'Пишу ответ…' : 'Writing a reply…'],
      ]) {
        await evaluate(`fixture.managerWork.item = ${JSON.stringify(item)}; push(); void 0`);
        await check(`document.querySelector('.draft-placeholder').textContent === ${JSON.stringify(expected)}`,
          "background activity updates without a goal prefix in " + (russian ? "Russian" : "English"));
      }
      await evaluate(`fixture.managerWork = null; push(); void 0`);
      await check(`document.querySelector('.draft-placeholder').textContent === ${JSON.stringify(russian ? 'Напишите менеджеру проекта…' : 'Write to the project manager…')}`,
        "finishing background activity restores the ordinary prompt");
      await evaluate(`fixture.managerWork = { id: 'goal-run', phase: 'running', startedAt: Date.now(),
        item: { type: 'mcpToolCall', title: 'ai_taskboard / task_wait', text: '', status: 'inProgress' } }; push(); void 0`);
    }
    await evaluate(`fixture.russian = true; push(); void 0`);
    if (keepArtifacts) await capture("board-manager-status.png");
    console.log("Goal controls Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--review-message-only")) {
    await evaluate(`
      const reviewed = fixture.board.tasks[0];
      const sourcePath = 'src/Core/Object/DeferredPropertyValue.cs';
      const text = '[P2] Критерий 1: ' + sourcePath + ':25 возвращает null из ReadNodePath(). Проверьте этот случай до и после сохранения.\\n\\n' +
        'Проверка должна включать повторную загрузку.\\n\\n' +
        '[P2] Критерий 3: [SceneState.md](docs/classes/SceneState.md) неверно описывает освобождение ресурсов. Уточните, когда закрывается последняя аренда.';
      reviewed.history.push({ actor: 'reviewer', action: 'request-changes', text,
        at: reviewed.updatedAt, from: 'review', to: 'in_progress' });
      window.taskboard.chatModels = async () => ({ ok: true, data: [] });
      window.taskboard.command = async () => ({ ok: true, data: structuredClone(reviewed) });
      let openedSource;
      window.taskboard.readMarkdown = async (id, link) => {
        openedSource = { id, link };
        return { ok: true, data: { path: sourcePath, name: 'DeferredPropertyValue.cs', line: 25,
          text: '// preceding lines\\n'.repeat(24) + 'return null;\\n' } };
      };
      window.taskboard.boardHistory = async () => ({ ok: true, data: { turns: [
        { messages: [], items: [{ id: 'review', type: 'mcpToolCall', messagesOnly: true, messages: [
          { id: reviewed.id, actor: 'reviewer', kind: 'request-changes', sequence: 1, text },
          { id: reviewed.id, actor: 'reviewer', kind: 'review-approved', sequence: 2, text: 'Сдача согласована.' },
        ] }] },
      ] } });
      const findingsRendered = root => {
        const [first, second, extra] = root.querySelectorAll('.chat-review-finding');
        return !extra && first?.querySelector('strong')?.textContent === 'Критерий 1' &&
          first.querySelector('.chat-review-priority')?.textContent === 'P2' &&
          first.querySelector('a')?.getAttribute('href') === sourcePath + ':25' &&
          first.querySelector('a')?.title === sourcePath + ':25' &&
          [...first.querySelectorAll('code')].map(code => code.textContent).join('|') === 'DeferredPropertyValue.cs:25|null|ReadNodePath()' &&
          first.querySelectorAll('p').length === 2 &&
          second?.querySelector('strong')?.textContent === 'Критерий 3' &&
          second.querySelector('a')?.getAttribute('href') === 'docs/classes/SceneState.md';
      };
      void 0;
    `);
    await clickManagerField();
    await click(".board-work-toggle");
    await evaluate(`waitFor(() => document.querySelector('.board-chat .chat-entry:has(.chat-review-finding)'))`);
    await check(`findingsRendered(document.querySelector('.board-chat .chat-entry:has(.chat-review-finding)'))`,
      "reviewer returns in manager chat separate findings, keeping prose, source locations and Markdown links");
    await check(`document.querySelector('.chat-review-status').textContent === 'Возврат на доработку' &&
      document.querySelector('.chat-entry:has(.chat-review-finding) .board-chat-task').textContent === reviewed.id &&
      document.querySelector('.chat-coordination:not(:has(.chat-review-finding))').textContent.includes('Сдача согласована.')`,
      "reviewer return keeps its task link, and reviewer approval remains a regular message");
    await evaluate(`document.querySelector('.chat-entry:has(.chat-review-finding)').scrollIntoView({ block: 'start' }); settle()`);
    if (keepArtifacts) await capture("board-review-message.png");
    await evaluate(`document.querySelector('.chat-review-finding a').click();
      waitFor(() => document.querySelector('.markdown-preview .source-line'))`);
    await check(`openedSource.id === reviewed.id && openedSource.link === sourcePath + ':25' &&
      document.querySelector('.markdown-preview h2').textContent === 'DeferredPropertyValue.cs:25' &&
      document.querySelector('.markdown-preview .source-line').textContent === 'return null;'`,
      "a source link opens its highlighted line in the task worktree preview");
    await evaluate(`document.querySelector('.markdown-preview').close(); settle()`);
    await evaluate(`document.querySelector('.chat-entry:has(.chat-review-finding) .board-chat-task').click(); settle()`);
    await evaluate(`waitFor(() => document.querySelector('.task-chat .chat-entry:has(.chat-review-finding)'))`);
    await check(`findingsRendered(document.querySelector('.task-chat .chat-entry:has(.chat-review-finding)'))`,
      "the same findings are readable in the task chat");
    console.log("Reviewer message Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--milestones-only")) {
    await evaluate(`
      window.taskboard.chatModels = async () => ({ ok: true, data: [] });
      const milestoneTask = fixture.board.tasks[0];
      milestoneTask.status = 'draft';
      milestoneTask.unfinishedDependencies = ['T-0002'];
      milestoneTask.subtasks = [{ title: 'Проверка', done: true }, { title: 'Приёмка', done: false }];
      fixture.board.gitInfo = { githubRepository: 'owner/example' };
      let openedMilestone;
      window.taskboard.openLink = async url => { openedMilestone = url; };
      milestoneTask.milestone = { repository: 'owner/example', number: 5, title: 'Версия 1.0' };
      window.taskboard.command = async (action, id) => {
        if (action === 'show' && id === milestoneTask.id) return { ok: true, data: structuredClone(milestoneTask) };
        throw new Error('Unexpected action ' + action);
      };
      push();
      showTask(milestoneTask.id).then(() => waitFor(() => !!body.querySelector('.task-milestone-link')));
    `);
    await check(`![...body.querySelectorAll('button')].some(control => control.textContent === 'Веха…')`,
      "the assigned milestone is visible without a manual milestone picker");
    await check(`(() => {
      const card = findCard(milestoneTask.id);
      const id = card.querySelector('.task-id').getBoundingClientRect();
      const milestone = card.querySelector('.task-milestone');
      const bounds = milestone.getBoundingClientRect();
      return milestone.textContent === 'Версия 1.0' && bounds.left > id.right && Math.abs(bounds.top - id.top) < 1;
    })()`, "the assigned milestone appears on the same line as the task ID");
    await check(`(() => {
      const meta = findCard(milestoneTask.id).querySelector('.task-meta');
      const idStyle = getComputedStyle(meta.querySelector('.task-id'));
      const milestone = meta.querySelector('.task-milestone');
      const textParts = [...meta.querySelectorAll('.task-stat')];
      const icons = ['symbol-number', 'milestone', 'link', 'attach']
        .map(name => meta.querySelector('.task-stat .codicon-' + name));
      return getComputedStyle(milestone).color === idStyle.color && idStyle.color === getComputedStyle(meta).color &&
        textParts.length === icons.length && textParts.every(part => {
        const style = getComputedStyle(part);
        return style.fontFamily === getComputedStyle(document.documentElement).fontFamily &&
          style.fontSize === idStyle.fontSize && style.lineHeight === idStyle.lineHeight;
      }) && icons.every(icon => {
        if (!icon) return false;
        const glyph = getComputedStyle(icon, '::before');
        return glyph.fontFamily === 'codicon' && glyph.content !== 'none' && document.fonts.check(glyph.font);
      });
    })()`, "task ID and milestone share the footer text color, and footer icons use the loaded Codicons font");
    await evaluate(`body.querySelector('.task-milestone-link').click(); waitFor(() => !!openedMilestone)`);
    await check(`openedMilestone === 'https://github.com/owner/example/milestone/5'`, "the assigned milestone opens on GitHub");
    await check(`(() => {
      const title = 'Очень длинное название следующей вехи проекта';
      milestoneTask.milestone = { repository: 'owner/example', number: 6, title };
      push();
      const card = findCard(milestoneTask.id);
      card.style.width = '148px';
      const id = card.querySelector('.task-id').getBoundingClientRect();
      const milestone = card.querySelector('.task-milestone');
      const bounds = milestone.getBoundingClientRect();
      const label = milestone.querySelector('.task-milestone-label');
      const meta = milestone.parentElement.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      return cardBounds.width === 148 && bounds.top >= id.bottom &&
        bounds.left >= meta.left && bounds.right <= meta.right && bounds.bottom <= cardBounds.bottom &&
        meta.left >= cardBounds.left && meta.right <= cardBounds.right &&
        label.clientWidth > 0 && label.scrollWidth > label.clientWidth &&
        getComputedStyle(label).textOverflow === 'ellipsis' && milestone.title.includes(title);
    })()`, "a long milestone wraps below the task ID at 148px, stays inside the card and exposes its full title on hover");
    console.log("GitHub milestone Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--queue-only")) {
    await evaluate(`
      const queueForm = byId('board-composer').querySelector('form');
      const queueInput = queueForm.querySelector('.draft-input textarea');
      const queuePanel = queueForm.querySelector('.board-chat-queue');
      const row = index => queuePanel.children[index];
      const rowButton = (index, label) => [...row(index).querySelectorAll('button')].find(control =>
        (control.getAttribute('aria-label') || control.textContent) === label);
      const requests = [];
      const longMessage = 'Первая строка\\n' + 'Подробности '.repeat(600).trimEnd();
      window.taskboard.boardRequest = (text, files, _project, _goal, immediate, id) =>
        new Promise(resolve => requests.push({ text, files, immediate, id, resolve }));
      const enqueueMessage = (text, files = []) => {
        const count = queuePanel.children.length;
        const clipboardData = new DataTransfer();
        files.forEach(file => clipboardData.items.add(file));
        queueInput.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        queueInput.value = text;
        queueForm.requestSubmit();
        return waitFor(() => queuePanel.children.length > count);
      };
      queueInput.value = 'Первый запрос';
      queueForm.requestSubmit();
      waitFor(() => requests.length === 1);
    `);
    await evaluate(`
      enqueueMessage(longMessage, [new File(['proof'], 'proof.txt')])
        .then(async () => {
          for (let index = 0; index < 12; index++) await enqueueMessage('Сообщение ' + index);
          return settle();
        });
    `);
    await check(`queuePanel.children.length === 13 && queuePanel.scrollHeight > queuePanel.clientHeight &&
      queuePanel.clientHeight > 0 && !queuePanel.closest('.board-chat-log') &&
      row(0).querySelector('.board-queued-preview').scrollWidth > row(0).querySelector('.board-queued-preview').clientWidth &&
      row(0).offsetHeight === row(1).offsetHeight &&
      !queueForm.querySelector('.board-chat-log').textContent.includes('Подробности')`, "the queue uses single-line previews and scrolls independently from chat");
    await evaluate(`rowButton(0, 'Изменить').click(); waitFor(() => row(0).querySelector('textarea'))`);
    await check(`row(0).querySelector('textarea').value === longMessage`, "the editor opens the complete multiline message");
    await evaluate(`
      row(0).querySelector('textarea').value = longMessage + '\\nКонец';
      rowButton(0, 'Сохранить').click();
      waitFor(() => !row(0).querySelector('textarea'));
    `);
    await evaluate(`rowButton(1, 'Удалить').click(); waitFor(() => queuePanel.children.length === 12)`);
    await check(`row(1).querySelector('.board-queued-preview').textContent === 'Сообщение 1'`, "any queued message can be removed without disturbing the order");
    await evaluate(`rowButton(0, 'Отправить сейчас').click(); waitFor(() => requests.length === 2)`);
    await check(`requests[1].immediate && requests[1].text === longMessage + '\\nКонец' && requests[1].files[0].name === 'proof.txt'`,
      "immediate send transmits the edited multiline message with its attachment");
    await evaluate(`
      requests[1].resolve({ ok: false, error: { message: 'Повторите отправку' } });
      waitFor(() => rowButton(0, 'Отправить сейчас'));
    `);
    await check(`queuePanel.children.length === 12 && row(0).querySelector('.board-queued-preview').textContent.endsWith('Конец')`,
      "a failed immediate send leaves the edited message in place");
    await evaluate(`
      const commentary = { id: 'earlier-comment', type: 'agentMessage', title: '', text: 'Уточню карточку', phase: 'commentary', status: 'completed' };
      const updateManager = items => window.pushChat({ project: fixture.project, type: 'orchestrator', items });
      updateManager([commentary]);
      rowButton(0, 'Отправить сейчас').click();
      waitFor(() => requests.length === 3);
    `);
    await evaluate(`requests[2].resolve({ ok: true, data: null }); waitFor(() => queuePanel.children.length === 11)`);
    await check(`[...queueForm.querySelectorAll('.board-chat-log .chat-text')].filter(entry => entry.textContent === requests[2].text).length === 1`,
      "a delivered message moves from the queue to history exactly once");
    await evaluate(`
      const followUp = { id: requests[2].id, type: 'userMessage', title: '', text: requests[2].text, status: 'completed',
        userMessage: { text: requests[2].text, files: [{ name: 'proof.txt' }] } };
      const answer = { id: 'later-comment', type: 'agentMessage', title: '', text: 'Уточнение получил', phase: 'final_answer', status: 'completed' };
      const items = [followUp, commentary, answer];
      const queueLog = queueForm.querySelector('.board-chat-log');
      const bubbles = () => [...queueLog.querySelectorAll('.chat-entry[data-actor="user"]')].filter(entry => entry.textContent.includes('Первая строка'));
      const ordered = phase => {
        const earlier = queueLog.querySelector('[data-item="message:earlier-comment"]');
        const later = queueLog.querySelector('[data-item="' + phase + ':later-comment"]');
        return bubbles().length === 1 && bubbles()[0].textContent.includes('proof.txt') &&
          Boolean(earlier?.compareDocumentPosition(bubbles()[0]) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          Boolean(bubbles()[0].compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
      };
      updateManager(items);
      void 0;
    `);
    await check(`ordered('message')`, "a late receipt replaces the one bubble after visible commentary and before new output");
    await evaluate(`requests[0].resolve({ ok: true, data: { items, answer: 'Уточнение получил' } }); waitFor(() => requests.length === 4)`);
    await check(`ordered('final') && !bubbles()[0].closest('details')`, "folding the completed turn retains the order and keeps the user message visible");
    await check(`requests[3].text === 'Сообщение 1' && !requests[3].immediate && queuePanel.children.length === 10`,
      "the next queued message starts automatically in order");
    if (keepArtifacts) await capture("board-manager-queue.png");
    await evaluate(`
      requests[3].resolve({ ok: true, data: { answer: 'Готово' } });
      waitFor(() => requests.length === 5);
    `);
    await evaluate(`
      queueInput.click();
      window.taskboard.boardHistory = async () => ({ ok: true, data: { turns: [
        { messages: [], items: [commentary] },
        { messages: [{ ...followUp.userMessage, clientId: followUp.id }], items: [answer] },
      ] } });
      requests[4].resolve({ ok: false, error: { message: 'Нет соединения' } });
      waitFor(() => !queueLog.querySelector('.chat-thinking'));
    `);
    await evaluate(`
      window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
      waitFor(() => bubbles().length === 1 && bubbles()[0].parentElement === queueLog);
    `);
    await check(`ordered('final')`, "loading the saved transcript shows the same chronology");
    console.log("Manager queue Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--chat-scroll-only")) {
    await evaluate(`
      fixture.project = 'scroll-fixture';
      push();
      const scrollForm = byId('board-composer').firstChild;
      const dialogue = scrollForm.querySelector('.board-chat-log:not(.board-work)');
      const workLog = scrollForm.querySelector('.board-work');
      const status = (id, text) => ({ id, text, type: 'agentMessage', title: '', status: 'completed', phase: 'final_answer' });
      const turn = item => ({ messages: [], items: [item] });
      let savedDialogue = Array.from({ length: 18 }, (_, i) => turn(status('dialogue-' + i, 'Ответ менеджера ' + i)));
      let savedWork = Array.from({ length: 18 }, (_, i) => turn(status('work-' + i, 'Обновление работы ' + i)));
      let activeWork = [];
      window.taskboard.boardHistory = async (_project, _cursor, view) => ({ ok: true, data: view === 'live'
        ? { work: activeWork, chat: [] } : { turns: view === 'work' ? savedWork : savedDialogue } });
      const bottomGap = list => list.scrollHeight - list.clientHeight - list.scrollTop;
      const row = (list, id) => list.querySelector('[data-item="message:' + id + '"], [data-item="final:' + id + '"]');
      const y = (list, id) => row(list, id).getBoundingClientRect().top - list.getBoundingClientRect().top;
      const place = (list, id) => { list.scrollTop += y(list, id) - 30; };
      const event = (type, fields = {}) => window.pushChat({ project: fixture.project, type: 'orchestrator-' + type, ...fields });
      const shown = () => !scrollForm.querySelector('.board-chat').getAnimations().some(a => a.transitionProperty === 'height');
      const end = list => bottomGap(list) <= 2;
      scrollForm.querySelector('.draft-input textarea').click();
      waitFor(() => row(dialogue, 'dialogue-17') && shown() && end(dialogue)).then(settle)
        .catch(error => { throw new Error(error.message + ' (last reply ' + Boolean(row(dialogue, 'dialogue-17')) +
          ', panel settled ' + shown() + ', bottom gap ' + bottomGap(dialogue) + ')'); });
    `);
    await check(`(async () => {
      event('run', { managerRun: { id: 'live-chat', phase: 'running' } });
      const first = status('live-chat-1', 'Пишу ответ менеджера.');
      const tool = { id: 'live-command', type: 'commandExecution', title: 'Get-Content README.md', status: 'inProgress', text: 'Читаю' };
      window.pushChat({ project: fixture.project, type: 'orchestrator', items: [first] });
      const entered = row(dialogue, first.id).getAnimations().some(a => a.animationName === 'board-chat-enter' &&
        a.effect.getKeyframes().every(keyframe => !keyframe.transform));
      if (!entered || !end(dialogue)) return false;
      window.pushChat({ project: fixture.project, type: 'orchestrator', items: [first, tool] });
      if (!end(dialogue)) return false;
      window.pushChat({ project: fixture.project, type: 'orchestrator', items: [tool, { ...first, text: first.text.repeat(65) }] });
      await settle();
      return end(dialogue);
    })()`, "live replies fade in without translation and the dialogue stays at the bottom as tools and text change");
    await evaluate(`place(dialogue, 'dialogue-6'); settle()`);
    await check(`(async () => {
      const before = y(dialogue, 'dialogue-6');
      savedDialogue[0] = turn(status('dialogue-0', 'Ранняя длинная реплика. '.repeat(25)));
      event('history');
      await waitFor(() => row(dialogue, 'dialogue-0')?.textContent.length > 100);
      await settle();
      return !end(dialogue) && Math.abs(y(dialogue, 'dialogue-6') - before) <= 1;
    })()`, "a dialogue history refresh keeps the visible reply fixed when older content grows");
    await evaluate(`
      scrollForm.querySelector('.board-work-toggle').click();
      waitFor(() => row(workLog, 'work-17') && end(workLog)).then(settle);
    `);
    await check(`(async () => {
      const incoming = status('work-live', 'Текущий шаг');
      activeWork = [incoming];
      event('work-activity');
      await waitFor(() => row(workLog, incoming.id));
      if (!row(workLog, incoming.id).getAnimations().some(a => a.animationName === 'board-chat-enter') || !end(workLog)) return false;
      savedWork = [...savedWork, turn(incoming)];
      event('work-history');
      await waitFor(() => workLog.querySelector('[data-item="final:work-live"]'));
      await settle();
      return end(workLog) && workLog.querySelectorAll('[data-item$=":work-live"]').length === 1;
    })()`, "work activity fades in and moves to saved history once without losing the bottom");
    await check(`(async () => {
      const item = status('saved-work', 'Новая запись в истории.');
      savedWork = [...savedWork, turn(item)];
      event('work-history');
      await waitFor(() => row(workLog, item.id));
      const entry = row(workLog, item.id);
      const fade = entry.getAnimations().find(animation => animation.animationName === 'board-chat-enter');
      if (!fade) return false;
      await fade.finished;
      await settle();
      if (entry.hasAttribute('data-enter')) return false;
      scrollForm.querySelector('.board-dialogue-toggle').click();
      await settle();
      scrollForm.querySelector('.board-work-toggle').click();
      return !row(workLog, item.id).getAnimations().some(animation => animation.animationName === 'board-chat-enter' &&
        animation.playState === 'running') && end(workLog);
    })()`, "an already displayed history entry does not fade in again on tab switch");
    await evaluate(`place(workLog, 'work-6'); settle()`);
    await check(`(async () => {
      const before = y(workLog, 'work-6');
      savedWork[0] = turn(status('work-0', 'Ранний шаг вырос. '.repeat(30)));
      event('work-history');
      await waitFor(() => row(workLog, 'work-0')?.textContent.length > 100);
      await settle();
      activeWork = [status('work-next', 'Следующий шаг. '.repeat(40))];
      event('work-activity');
      await waitFor(() => row(workLog, 'work-next'));
      await settle();
      return !end(workLog) && Math.abs(y(workLog, 'work-6') - before) <= 1;
    })()`, "work history reloads and incoming activity keep the same visible row at the same offset");
    await check(`(async () => {
      const before = y(workLog, 'work-6');
      scrollForm.querySelector('.board-dialogue-toggle').click();
      await settle();
      if (Math.abs(y(dialogue, 'dialogue-6') - 30) > 1) return false;
      scrollForm.querySelector('.board-work-toggle').click();
      await settle();
      return Math.abs(y(workLog, 'work-6') - before) <= 1;
    })()`, "switching views restores their independent reading positions");
    console.log("Manager chat scroll Chromium checks passed: " + checks);
    return;
  }
  if (process.argv.includes("--history-only")) {
    await evaluate(`
      const pageLog = byId('board-composer').querySelector('.board-chat-log');
      const pagesRequested = [];
      const savedPage = (label, count) => Array.from({ length: count }, (_, index) => ({
        messages: [{ text: label + ' ' + index, files: [] }], items: [],
      }));
      const latestPage = savedPage('Свежее сообщение', 25);
      window.taskboard.boardHistory = async (_project, cursor, view) => {
        if (view) return { ok: true, data: view === 'live' ? { work: [], chat: [] } : { turns: [] } };
        pagesRequested.push(cursor ?? null);
        return { ok: true, data: cursor === 'older' ?
          { turns: savedPage('Старое сообщение', 12), nextCursor: null } :
          { turns: latestPage, nextCursor: 'older' } };
      };
      window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
      pageLog.closest('form').querySelector('.draft-input textarea').click();
      waitFor(() => pageLog.textContent.includes('Свежее сообщение 24') &&
        pageLog.clientHeight > 0 && pageLog.scrollHeight - pageLog.clientHeight - pageLog.scrollTop <= 2 &&
        !pageLog.closest('.board-chat').getAnimations().some(animation => animation.transitionProperty === 'height')).then(settle)
        .catch(error => { throw new Error(error.message + ' (scroll ' + pageLog.scrollTop + ', height ' +
          pageLog.clientHeight + ', content ' + pageLog.scrollHeight + ')'); });
    `);
    await check(`pagesRequested.length === 1 && !pageLog.textContent.includes('Старое сообщение') &&
      pageLog.scrollHeight - pageLog.clientHeight - pageLog.scrollTop <= 2`, "opening the transcript loads only the latest page at the bottom");
    await evaluate(`
      const firstRecent = [...pageLog.querySelectorAll('.chat-entry')].find(entry => entry.textContent === 'Свежее сообщение 0');
      const recentOffset = firstRecent.getBoundingClientRect().top - pageLog.getBoundingClientRect().top + pageLog.scrollTop;
      pageLog.scrollTop = 0;
      waitFor(() => pageLog.textContent.includes('Старое сообщение 0')).then(settle);
    `);
    await check(`pagesRequested.join(',') === ',older' && pageLog.contains(firstRecent) &&
      pageLog.querySelector('.chat-entry').textContent === 'Старое сообщение 0' &&
      Math.abs(firstRecent.getBoundingClientRect().top - pageLog.getBoundingClientRect().top - recentOffset) < 2`,
      "scrolling up prepends an older page without moving the previously visible message");
    await check(`(async () => {
      const form = pageLog.closest('form');
      const olderMessage = [...pageLog.querySelectorAll('.chat-entry')].find(entry => entry.textContent === 'Старое сообщение 6');
      pageLog.scrollTop = olderMessage.offsetTop - pageLog.offsetTop;
      await settle();
      const offset = () => olderMessage.getBoundingClientRect().top - pageLog.getBoundingClientRect().top;
      const before = offset();
      if (before < -1 || before >= pageLog.clientHeight) return false;
      form.querySelector('.board-work-toggle').click();
      latestPage.push(...savedPage('Новый ответ', 1));
      window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
      await settle();
      form.querySelector('.board-dialogue-toggle').click();
      await settle();
      return pagesRequested.length === 2 && pageLog.contains(olderMessage) && Math.abs(offset() - before) <= 1;
    })()`, "history updates while reading work preserve an older dialogue page and the reading position");
    await evaluate(`pageLog.scrollTop = pageLog.scrollHeight; waitFor(() => pageLog.textContent.includes('Новый ответ')).then(settle)`);
    await check(`!pageLog.textContent.includes('Старое сообщение') && pagesRequested.length === 3 &&
      pageLog.scrollHeight - pageLog.clientHeight - pageLog.scrollTop <= 2`, "returning to the bottom releases older messages and loads new ones");
    await evaluate(`
      const unreadProject = 'unread-board';
      const otherProject = fixture.project;
      const setUnread = ids => {
        fixture.managerUnread = fixture.project === unreadProject ? ids : [];
        fixture.tabs = [{ path: otherProject, name: 'Первая доска' },
          { path: unreadProject, name: 'Вторая доска', unread: !!ids.length }];
        push();
      };
      const pending = ['unread-first', 'unread-last'];
      const receipts = [];
      let focusedDialogue = false;
      document.hasFocus = () => focusedDialogue;
      const reply = (id, text) => ({ messages: [], items: [
        { id, text, type: 'agentMessage', title: '', phase: 'final_answer', status: 'completed' },
      ] });
      window.taskboard.boardHistory = async (project, cursor, view) => ({ ok: true, data: view === 'live'
        ? { work: [], chat: [] } : project !== unreadProject || view === 'work' ? { turns: [] } : cursor
        ? { turns: [reply('read-old', 'Предыдущий ответ.'), reply(pending[0], 'Длинный ответ. '.repeat(180))] }
        : { turns: [reply('unread-last', 'Последний ответ.')], nextCursor: 'with-unread' } });
      window.taskboard.readManagerMessages = async (project, ids) => {
        receipts.push({ project, ids });
        const left = (fixture.managerUnread ?? []).filter(id => !ids.includes(id));
        setUnread(left);
        return { ok: true, data: left };
      };
      const dot = () => document.querySelector('.project-tab[data-project="unread-board"] .project-tab-unread');
      const unreadLog = () => byId('board-composer').querySelector('.board-chat-log:not(.board-work)');
      const unreadBubble = id => unreadLog().querySelector('[data-message-id="' + id + '"]');
      setUnread(pending);
      void 0;
    `);
    await check(`dot() && !receipts.length && !dot().parentElement.matches('[aria-selected="true"]')`,
      "the inactive board tab signals new manager replies");
    await evaluate(`
      fixture.project = unreadProject; setUnread(pending);
      byId('board-composer').querySelector('.draft-input textarea').click();
      waitFor(() => unreadBubble(pending[0]) && unreadLog().clientHeight > 0 &&
        !unreadLog().closest('.board-chat').getAnimations().some(animation => animation.transitionProperty === 'height')).then(settle);
    `);
    await check(`(() => {
      const first = unreadBubble(pending[0]);
      const last = unreadBubble(pending[1]);
      return dot() && !receipts.length && first.dataset.read === 'false' &&
        unreadBubble('read-old').dataset.read === 'true' && last.dataset.read === 'false' &&
        first.previousElementSibling?.textContent === 'Новые сообщения' &&
        getComputedStyle(first).borderRadius !== '0px' && last.getBoundingClientRect().width < unreadLog().clientWidth / 2;
    })()`, "stored replies have separate left bubbles and the divider precedes the first unread reply across pages");
    if (keepArtifacts) await capture("manager-unread.png");
    await evaluate(`
      byId('board-composer').querySelector('.board-work-toggle').click();
      focusedDialogue = true;
      unreadLog().dispatchEvent(new Event('scroll'));
      settle();
    `);
    await check(`dot() && !receipts.length`, "opening the work log does not mark dialogue replies read");
    await evaluate(`
      byId('sheet').showModal();
      byId('board-composer').querySelector('.board-dialogue-toggle').click();
      settle();
    `);
    await check(`!!dot() && !receipts.length &&
      unreadBubble(pending[0]).previousElementSibling?.classList.contains('board-chat-unread')`,
      "returning to the dialogue restores the divider and a modal leaves the messages unread");
    await evaluate(`
      byId('sheet').close();
      waitFor(() => receipts.length === 1).then(settle);
    `);
    await check(`receipts[0].project === unreadProject && receipts[0].ids.join() === pending[0] &&
      unreadBubble(pending[0]).dataset.read === 'true' && !!dot()`,
      "the visible reply becomes read but the below-fold reply leaves the indicator visible");
    await evaluate(`unreadLog().scrollTop = unreadLog().scrollHeight; waitFor(() => !dot()).then(settle)`);
    await check(`receipts.at(-1).ids.join() === pending[1] && unreadBubble(pending[1]).dataset.read === 'true'`,
      "scrolling to the last unread reply clears the tab indicator");
    console.log("Manager history Chromium checks passed: " + checks);
    return;
  }
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`lane('ready').querySelector('.task-id').textContent === 'T-0002'`, "initial board shows the newest task first");
  await evaluate(`
    const baselineTasks = fixture.board.tasks;
    const baselineCommand = window.taskboard.command;
    let reviewQueueCalls = 0;
    window.taskboard.command = async action => {
      if (action !== 'review-queue') throw Error('Unexpected command: ' + action);
      reviewQueueCalls++;
      return { ok: true, data: [
        { id: 'T-0003', revision: 2, status: 'conflict' },
        { id: 'T-0004', revision: 2, status: 'clean' },
        { id: 'T-0005', revision: 1, status: 'clean' },
      ] };
    };
    fixture.board.tasks = [...baselineTasks,
      task('T-0003', 'Первая сдача', { status: 'review', revision: 2, submittedAt: '2026-11-01T00:00:00Z' }),
      task('T-0004', 'Чистое слияние', { status: 'review', revision: 2, reviewApproved: true, submittedAt: '2026-11-02T00:00:00Z' }),
      task('T-0005', 'Смена ревизии', { status: 'review', revision: 2, submittedAt: '2026-11-03T00:00:00Z' }),
    ];
    fixture.runningTasks = ['T-0005'];
    push();
    void 0;
  `);
  await check(`reviewQueueCalls === 0 && byId('status-notifications').getAttribute('aria-label') === 'Очередь приёмки · 3'`, "the review badge updates without running Git while the queue is closed");
  await evaluate(`byId('notifications').showPopover(); waitFor(() => byId('notifications').textContent.includes('Конфликт Git'))`);
  await check(`(() => {
    const rows = [...byId('notifications').querySelectorAll('[data-review-task]')];
    return reviewQueueCalls === 1 && rows.map(row => row.dataset.reviewTask).join(',') === 'T-0004,T-0005,T-0003' &&
      rows[0].textContent.includes('Без конфликтов Git') && rows[0].textContent.includes('Согласовано ревьюером') && rows[0].querySelector('span').title &&
      rows[1].textContent.includes('Исполнитель ещё работает') && !rows[1].textContent.includes('Без конфликтов Git');
  })()`, "the queue prioritizes completed clean submissions and ignores checks for older revisions");
  await evaluate(`fixture.board.tasks = fixture.board.tasks.filter(task => task.id !== 'T-0004'); push(); waitFor(() => reviewQueueCalls === 2 && !byId('notifications').querySelector('[data-review-task="T-0004"]'))`);
  await check(`byId('status-notifications').getAttribute('aria-label') === 'Очередь приёмки · 2'`, "a completed decision removes the review row and updates the badge");
  if (process.argv.includes("--review-queue-only")) {
    console.log("Review queue Chromium checks passed: " + checks);
    return;
  }
  await evaluate(`
    byId('notifications').hidePopover();
    fixture.board.tasks = baselineTasks;
    fixture.runningTasks = [];
    window.taskboard.command = baselineCommand;
    push(); void 0;
  `);
  await evaluate(`
    const originalCard = findCard('T-0001');
    const originalCover = originalCard.querySelector('img');
    const originalLane = lane('ready');
    const originalHeight = originalCard.getBoundingClientRect().height;
    const columnFilter = originalLane.querySelector('details');
    columnFilter.open = true;
    columnFilter.querySelector('select').focus();
    const originalFocus = document.activeElement;
    const mutations = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(document.querySelector('#lanes'), { childList: true, subtree: true });
    push();
    void 0;
  `);
  await check(`findCard('T-0001') === originalCard && originalCover === originalCard.querySelector('img')`, "identical refresh retains card and decoded preview nodes");
  await check(`lane('ready') === originalLane && columnFilter.open && document.activeElement === originalFocus`, "refresh retains the column, open filter and keyboard focus");
  await check(`!originalCover.hidden && originalCard.getBoundingClientRect().height === originalHeight`, "refresh never hides the decoded preview or collapses its space");
  await check(`mutations.length === 0`, "identical snapshots do not mutate column contents");
  await evaluate(`fixture.runActivity = { 'T-0002': [{ id: 'log', text: 'New output' }] }; push(); void 0`);
  await check(`mutations.length === 0`, "agent log updates do not rebuild board contents");
  await evaluate(`fixture.runningTasks = ['T-0002']; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.agent-spinner') !== null && findCard('T-0001') === originalCard`, "activity changes update the affected card only");
  await evaluate(`const spinner = findCard('T-0002').querySelector('.agent-spinner'); push(); void 0`);
  await check(`findCard('T-0002').querySelector('.agent-spinner') === spinner`, "repeated activity snapshots retain the running animation");
  await evaluate(`fixture.board.tasks[0].title = 'Новое название'; fixture.board.tasks[0].revision++; push(); void 0`);
  await check(`findCard('T-0001') === originalCard && originalCard.querySelector('strong').textContent === 'Новое название'`, "changed data reaches the existing card");
  await check(`originalCard.querySelector('img') === originalCover && !originalCover.hidden && originalCover.naturalWidth > 0`, "editing a covered card retains its decoded image");
  await evaluate(`fixture.board.tasks[0].status = 'review'; push(); void 0`);
  await check(`lane('review').contains(originalCard) && originalCard.querySelector('img') === originalCover`, "status changes move the existing card and preview");
  await check(`lane('review').querySelector('.count').textContent === '1' && lane('ready').querySelector('.count').textContent === '1'`, "lane counters follow status changes");
  await check(`!originalCard.querySelector('.agent-spinner')`, "a submission waiting for review has no activity indicator");
  await evaluate(`fixture.reviewingTasks = { 'T-0001': 'reviewer' }; push(); void 0`);
  await check(`originalCard.querySelector('.agent-spinner')?.getAttribute('aria-label') === 'Проверяет ревьюер'`, "active independent review is shown on the card");
  await evaluate(`fixture.reviewingTasks['T-0001'] = 'manager'; push(); void 0`);
  await check(`originalCard.querySelector('.agent-spinner')?.title === 'Проверяет менеджер проекта'`, "active manager review is named in the tooltip");
  await evaluate(`delete fixture.reviewingTasks; push(); void 0`);
  await check(`!originalCard.querySelector('.agent-spinner') && lane('review').contains(originalCard)`, "the indicator clears when review ends without a decision");
  await evaluate(`findCard('T-0002').focus(); const focusBeforeCreation = document.activeElement; void 0`);
  await evaluate(`fixture.board.tasks.push(task('T-0003', 'Новая карточка', { priority: 'high', createdAt: '2026-11-03T12:00:00.000Z' })); push(); void 0`);
  await check(`findCard('T-0003') !== undefined`, "new tasks appear after refresh");
  await check(`lane('ready').querySelector('.task-id').textContent === 'T-0003'`, "a newly created task appears above older tasks");
  await check(`document.activeElement === focusBeforeCreation && lane('ready').querySelectorAll('.task-card')[1] === focusBeforeCreation`, "inserting a newer task above the focused card preserves focus");
  await evaluate(`findCard('T-0003').focus(); const focusedCard = document.activeElement; fixture.board.tasks.reverse(); push(); void 0`);
  await check(`document.activeElement === focusedCard && lane('ready').querySelector('.task-card') === focusedCard`, "refresh preserves newest-first order and keyboard focus despite changed input order");
  await evaluate(`fixture.board.tasks.find(task => task.id === 'T-0002').updatedAt = '2026-11-10T12:00:00.000Z'; push(); void 0`);
  await check(`lane('ready').querySelector('.task-card') === findCard('T-0002') && document.activeElement === focusedCard`,
    "editing an older task moves it above newer tasks and preserves keyboard focus");
  await evaluate(`fixture.board.tasks.reverse(); lane('ready').querySelector('.lane-collapse').click(); push(); void 0`);
  await check(`lane('ready').querySelector('.lane-cards').hidden`, "refresh retains a collapsed column");
  await evaluate(`lane('ready').querySelector('.lane-collapse').click(); void 0`);
  await evaluate(`const select = lane('ready').querySelector('select'); select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true })); void 0`);
  await check(`!findCard('T-0002') && !!findCard('T-0003')`, "column filters use newly received tasks");
  await evaluate(`fixture.board.tasks[2].priority = 'normal'; push(); void 0`);
  await check(`lane('ready').querySelectorAll('.task-card').length === 0 && !!lane('ready').querySelector('.lane-filter-empty')`, "refresh applies active filters and shows the empty state");
  await evaluate(`lane('ready').querySelector('.lane-filter-options button').click(); void 0`);
  await check(`!findCard('T-0003').hasAttribute('aria-description') && getComputedStyle(findCard('T-0003'), '::before').content === 'none'`,
    "changing a card back to normal removes its priority description and stripe");
  await check(`!!findCard('T-0002') && !!findCard('T-0003')`, "resetting the column filter restores current data");
  await evaluate(`fixture.board.tasks = fixture.board.tasks.filter(task => task.id !== 'T-0003'); push(); void 0`);
  await check(`!findCard('T-0003')`, "removed tasks disappear after refresh");
  await evaluate(`fixture.error = { code: 'BOARD_BUSY', operation: 'refresh', message: 'Another command is working on this board. Retry shortly.' }; push(); void 0`);
  await check(`!byId('notice').hidden && byId('notice-context').textContent === 'Обновление доски · board-fixture' &&
    byId('notice-message').textContent.includes('Обновление повторится автоматически') &&
    byId('notice-close').getAttribute('aria-label') === 'Скрыть уведомление' && findCard('T-0001') === originalCard`,
    "a watch failure shows its project and operation in the board language and retains the last confirmed cards");
  await evaluate(`byId('notice-close').click(); push(); void 0`);
  await check(`byId('notice').hidden`, "a dismissed refresh error stays hidden on subsequent snapshots");
  await evaluate(`delete fixture.error; push(); fixture.error = { code: 'BOARD_BUSY', operation: 'refresh', message: 'Another command is working on this board. Retry shortly.' }; push(); void 0`);
  await check(`!byId('notice').hidden`, "the same error is shown again if it recurs after a successful snapshot");
  await evaluate(`byId('notice-close').click(); fixture.error = { ...fixture.error, operation: 'open' }; push(); void 0`);
  await check(`!byId('notice').hidden && byId('notice-context').textContent === 'Открытие проекта · board-fixture'`,
    "an error for a different operation is visible even with the same underlying error code and message");
  await evaluate(`delete fixture.error; fixture.runningTasks = []; push(); void 0`);
  await check(`document.querySelector('#notice').hidden && !findCard('T-0002').querySelector('.agent-spinner')`, "recovery clears the error and stale activity");
  await evaluate(`fixture.board.tags[0].color = '#AB1234'; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.tag').style.getPropertyValue('--tag-color') === '#AB1234'`, "tag color changes reach existing cards");
  await evaluate(`fixture.board.tasks[1].unfinishedDependencies = ['T-0001']; push(); void 0`);
  await check(`lane('ready').contains(findCard('T-0002')) && findCard('T-0002').dataset.state === 'ready' &&
    findCard('T-0002').querySelector('.task-dependency-message').textContent === 'Ожидает T-0001' &&
    getComputedStyle(findCard('T-0002').querySelector('.task-dependency-message')).justifySelf === 'start'`,
    "a ready task waiting for a dependency shows a compact badge in the ready lane");
  await evaluate(`fixture.board.tasks[1].unfinishedDependencies = ['T-0003']; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.task-dependency-message').textContent === 'Ожидает T-0003'`,
    "the displayed dependency updates even when the count stays the same");
  await evaluate(`
    fixture.board.tasks[1].unfinishedDependencies = ['T-0003', 'T-0004', 'T-0005'];
    push(); void 0;
  `);
  await check(`(() => {
    const badge = findCard('T-0002').querySelector('.task-dependency-message');
    return badge.textContent === 'Ожидает T-0003 +2' && badge.title.includes('T-0003, T-0004, T-0005') &&
      badge.getBoundingClientRect().width <= badge.parentElement.clientWidth;
  })()`, "multiple prerequisites fit in one badge with the full list available");
  await evaluate(`fixture.board.tasks[1].unfinishedDependencies = []; push(); void 0`);
  await check(`lane('ready').contains(findCard('T-0002')) && !findCard('T-0002').querySelector('.task-dependency-message')`,
    "completed dependencies clear the waiting message and return tasks to the ready lane");
  await evaluate(`
    fixture.board.tasks[1].status = 'blocked';
    fixture.board.tasks[1].blocked = { reason: 'Ожидаю приёмки задачи ' + String.fromCharCode(96) + 'T-0001' + String.fromCharCode(96) + '.',
      condition: 'Получить результат.' };
    push(); void 0;
  `);
  await check(`(() => {
    const card = findCard('T-0002');
    const badge = card.querySelector('.task-dependency-message');
    return lane('blocked').contains(card) && badge?.textContent === 'Ожидает T-0001' &&
      badge.title.includes('Получить результат.') && !card.querySelector('.task-blocker');
  })()`, "a manual blocker that explicitly waits for a task uses the same badge");
  await evaluate(`fixture.board.tasks[1].blocked.reason = 'Ожидаю другую задачу.'; push(); void 0`);
  await check(`findCard('T-0002').querySelector('.task-dependency-message').textContent === 'Ожидает задачу'`,
    "an explicit wait without a task number still shows a badge");
  await evaluate(`fixture.board.tasks[1].blocked.reason = 'Ожидаю доступ к серверу для T-0001.'; push(); void 0`);
  await check(`!findCard('T-0002').querySelector('.task-dependency-message') &&
    findCard('T-0002').querySelector('.task-blocker').textContent.includes('доступ к серверу')`,
    "an unrelated blocker mentioning a task retains its reason");
  await evaluate(`fixture.board.tasks[1].status = 'ready'; delete fixture.board.tasks[1].blocked; push(); void 0`);
  await evaluate(`fixture.board.tasks[0].coverAttachment = 'missing.png'; fixture.board.tasks[0].attachments.push({ file: 'missing.png', name: 'missing.png' }); push(); void 0`);
  await evaluate(`settle()`);
  await check(`originalCard.querySelector('img').dataset.file === 'missing.png' && originalCard.querySelector('img').hidden`, "an unavailable replacement preview does not show the old attachment");
  await evaluate(`fixture.board.tasks[0].coverAttachment = 'cover.png'; push(); void 0`);
  await evaluate(`waitFor(() => !originalCard.querySelector('img').hidden)`);
  await check(`originalCard.querySelector('img').naturalWidth > 0`, "a valid preview loads after a failed replacement");
  await evaluate(`
    const previewSetting = () => body.querySelector('.form input[type="checkbox"]');
    const callsBeforeToggle = window.previewCalls;
    Object.assign(window.taskboard, {
      themes: async () => [],
      codexStatus: async () => ({ state: 'unavailable' }),
      chooseCodex: async () => ({ state: 'ready', selectedPath: 'codex.exe', clientPath: 'codex.exe', clientVersion: '0.167.1' }),
      autoDetectCodex: async () => ({ state: 'unavailable' }),
      chatModels: async () => ({ ok: true, data: ['manager', 'executor', 'reviewer'].map((id, index) => ({
        id, name: id, effort: 'low', efforts: index === 1 ? ['low'] : ['low', 'high'],
      })) }),
      command: async (name, id, input) => {
        if (name === 'tag-color') {
          const tag = fixture.board.tags.find(tag => tag.name === input.name);
          tag.color = input.color.toUpperCase();
          push();
          return { ok: true, data: tag };
        }
        if (name !== 'settings' || typeof input.showCardPreviews !== 'boolean') return { ok: false, error: { message: 'Invalid settings' } };
        fixture.board.settings = input;
        push();
        return { ok: true, data: input };
      },
    });
    boardSettings();
    void 0;
  `);
  await check(`previewSetting().checked && previewSetting().labels[0].textContent === 'Показывать превью на карточках'`, "boards without a saved preview preference default to showing covers");
  await evaluate(`
    settings();
    const providerPanel = () => body.querySelector('.provider-panel');
    const providerActions = () => Array.from(providerPanel().querySelectorAll('button'));
    waitFor(() => providerPanel().querySelector('[role="status"]').textContent.includes('не найден'));
  `);
  await check(`providerPanel().querySelector('h3').textContent === 'Провайдер моделей Codex' &&
    providerActions().map(button => button.textContent).join('|') === 'Выбрать файл…|Найти автоматически|Обновить статус' &&
    providerActions()[1].hidden`, "provider settings offer executable selection without a plugin setup action");
  await evaluate(`providerActions()[0].click(); waitFor(() => providerPanel().textContent.includes('0.167.1'))`);
  await check(`providerPanel().textContent.includes('Исполняемый файл Codex найден.') && !providerActions()[1].hidden`,
    "the provider panel shows the selected executable and offers to return to automatic detection");
  await evaluate(`providerActions()[1].click(); waitFor(() => providerActions()[1].hidden)`);
  await evaluate(`
    boardSettings();
    const tagHex = () => byId('tag-settings').querySelector('input[data-tag="UI"]');
    tagHex().value = 'blue';
    tagHex().dispatchEvent(new Event('change'));
    void 0;
  `);
  await check(`!tagHex().validity.valid && fixture.board.tags[0].color === '#AB1234'`, "tag settings reject a named color");
  await evaluate(`tagHex().value = '#217d79'; tagHex().dispatchEvent(new Event('change'));
    waitFor(() => tagHex().value === '#217D79')`);
  await check(`findCard('T-0002').querySelector('.tag').style.getPropertyValue('--tag-color') === '#217D79'`,
    "entering HEX in tag settings updates the tag on existing cards");
  await evaluate(`previewSetting().labels[0].click(); previewSetting().form.requestSubmit(); waitFor(() => !sheet.open)`);
  await check(`findCard('T-0001') === originalCard && !originalCard.querySelector('img') && fixture.board.settings.showCardPreviews === false && window.previewCalls === callsBeforeToggle`, "saving the unchecked setting hides the cover without replacing the task or requesting an image");
  await evaluate(`boardSettings(); void 0`);
  await check(`!previewSetting().checked`, "reopening board settings shows the saved preference");
  await evaluate(`
    const reviewModeSetting = () => body.querySelectorAll('.form select')[1];
    const roleFields = () => [...body.querySelectorAll('.board-agent-settings')];
    waitFor(() => roleFields().every(field => field.querySelectorAll('select')[1].options.length === 4))
  `);
  await check(`reviewModeSetting().value === 'human' &&
    [...reviewModeSetting().options].map(option => option.value).join('|') === 'human|manager|reviewer' &&
    roleFields().map(group => group.querySelector('legend').textContent).join('|') ===
    'Менеджер проекта|Исполнитель|Ревьюер'`, "legacy boards without a setting use manual acceptance and show separate agent settings");
  await evaluate(`
    roleFields().forEach((group, index) => {
      const [, model, effort] = group.querySelectorAll('select');
      model.value = ['manager', 'executor', 'reviewer'][index];
      model.dispatchEvent(new Event('change'));
      effort.value = index === 1 ? 'low' : 'high';
    });
    reviewModeSetting().value = 'manager';
    reviewModeSetting().dispatchEvent(new Event('change'));
    previewSetting().click(); previewSetting().form.requestSubmit();
    waitFor(() => !sheet.open && originalCard.querySelector('img')?.naturalWidth > 0)
  `);
  await check(`fixture.board.settings.reviewMode === 'manager' && ['manager', 'executor', 'reviewer'].every((role, index) =>
    fixture.board.settings[role].provider === 'codex' && fixture.board.settings[role].model === role &&
    fixture.board.settings[role].effort === (index === 1 ? 'low' : 'high'))`, "board settings save each role and the selected review mode");
  await check(`fixture.board.settings.showCardPreviews === true && originalCard.querySelector('img').dataset.file === 'cover.png' && window.previewCalls === callsBeforeToggle`, "enabling previews restores the previously selected cover from the cache");
  await evaluate(`const archivedTask = fixture.board.tasks.shift(); fixture.board.archived.push({ ...archivedTask, status: 'done' }); push(); archiveView = true; render(); void 0`);
  await check(`document.querySelector('#archive-list').contains(findCard('T-0001'))`, "archived tasks remain accessible");
  await evaluate(`const archiveCard = findCard('T-0001'); push(); void 0`);
  await check(`findCard('T-0001') === archiveCard`, "archive refreshes retain cards too");
  await evaluate(`fixture.project = 'other-board'; fixture.board.tasks = [task('T-0001', 'Другая доска')]; fixture.board.archived = []; push(); void 0`);
  await check(`findCard('T-0001') !== originalCard && findCard('T-0001').textContent.includes('Другая доска') && !findCard('T-0001').querySelector('img')`, "switching projects isolates cards and covers with the same task number");
  await evaluate(`fixture.board.tasks[0].priority = 'high'; push(); fixture.russian = false; push(); void 0`);
  await check(`lane('ready').querySelector('h2').textContent.includes('Ready') && findCard('T-0001').getAttribute('aria-description') === 'Priority · High'`, "language changes update columns and accessible priority descriptions");
  await evaluate(`const callsBeforeDelay = window.previewCalls; fixture.board.tasks[0].attachments = [{ file: 'delayed.png', name: 'delayed.png' }]; push(); void 0`);
  await evaluate(`waitFor(() => !!window.releasePreview)`);
  await evaluate(`const pendingImage = findCard('T-0001').querySelector('img'); fixture.board.tasks[0].title = 'Changed while loading'; push(); push(); window.releasePreview(); void 0`);
  await evaluate(`waitFor(() => !pendingImage.hidden)`);
  await check(`findCard('T-0001').querySelector('img') === pendingImage && window.previewCalls === callsBeforeDelay + 1`, "updates during preview loading retain the pending image and share its request");
  await evaluate(`fixture.board.tasks.push(...Array.from({ length: 40 }, (_, index) => task('S-' + index, 'Scroll task ' + index))); push(); void 0`);
  await evaluate(`(async () => {
    const ready = lane('ready');
    let more = ready.querySelector('.lane-more');
    while (more) {
      const before = ready.querySelectorAll('.task-card').length;
      more.click();
      await Promise.resolve();
      if (ready.querySelectorAll('.task-card').length <= before) throw new Error('Show more did not reveal tasks');
      more = ready.querySelector('.lane-more');
    }
  })()`);
  await evaluate(`document.querySelector('#lanes').scrollTop = 400; const boardScroll = document.querySelector('#lanes').scrollTop; push(); void 0`);
  await check(`boardScroll > 0 && document.querySelector('#lanes').scrollTop === boardScroll`, "refresh retains the scroll position on a long board");
  await evaluate(`
    fixture.russian = true;
    fixture.project = 'sorting-fixture';
    const taskId = number => 'T-' + String(number).padStart(4, '0');
    fixture.board.tasks = lanes.flatMap(([status], index) => [
      task(taskId(100 + index * 2), 'Обновлённая задача от 1 ноября', { status, updatedAt: '2026-11-04T12:00:00.000Z' }),
      task(taskId(101 + index * 2), 'Новая задача от 3 ноября', { status, createdAt: '2026-11-03T12:00:00.000Z' })
    ]);
    const laneIds = state => [...lane(state).querySelectorAll('.task-id')].map(node => node.textContent).join(',');
    const allLanesSorted = () => lanes.every(([state], index) => laneIds(state) === taskId(100 + index * 2) + ',' + taskId(101 + index * 2));
    const sourceOrder = fixture.board.tasks.map(task => task.id).join(',');
    push(); void 0;
  `);
  await check(`allLanesSorted()`, "every column sorts by last change even when the top card was created first and has a lower number");
  await check(`frame.board.tasks.map(task => task.id).join(',') === sourceOrder`, "rendering does not reorder the source snapshot");
  await evaluate(`fixture.board.tasks.reverse(); push(); void 0`);
  await check(`allLanesSorted()`, "all columns retain last-change order when a refresh changes snapshot order");
  await evaluate(`fixture.board.tasks.push(task('T-0000', 'Самая новая задача от 5 ноября', { createdAt: '2026-11-05T12:00:00.000Z', tags: ['UI'] })); push(); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0102,T-0103'`, "creation is the first change and places a new task at the top");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "board-newest-first.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`fixture.board.tasks.find(task => task.id === 'T-0102').priority = 'high'; fixture.board.tasks.find(task => task.id === 'T-0000').priority = 'high'; push(); const sortingFilter = lane('ready').querySelector('select'); sortingFilter.value = 'high'; sortingFilter.dispatchEvent(new Event('change', { bubbles: true })); void 0`);
  await check(`laneIds('ready') === 'T-0000,T-0102'`, "column filters preserve newest-first order for the matching subset");
  await evaluate(`lane('ready').querySelector('.lane-filter-options button').click(); fixture.board.tasks.find(task => task.id === 'T-0103').unfinishedDependencies = ['T-0100']; push(); settle()`);
  await check(`laneIds('blocked') === 'T-0106,T-0107' && laneIds('ready') === 'T-0000,T-0102,T-0103'`, "dependency waiting retains the ready column and its last-change order");
  await evaluate(`fixture.board.tasks.push(task('T-9999', 'Совпадающая дата', { createdAt: '2026-11-05T12:00:00.000Z', updatedAt: 'invalid' })); push(); settle()`);
  await evaluate(`const tiedOrder = laneIds('ready'); fixture.board.tasks.reverse(); push(); settle()`);
  await check(`laneIds('ready') === tiedOrder && tiedOrder.startsWith('T-9999,T-0000,')`, "invalid updatedAt falls back to creation and equal dates use a stable task-number tie-breaker");
  await evaluate(`fixture.board.tasks.push(task('T-9998', 'Без даты', { createdAt: '' }), task('T-9997', 'Повреждённая дата', { createdAt: 'invalid' })); push(); void 0`);
  await evaluate(`lane('ready').querySelector('.lane-more')?.click(); settle()`);
  await check(`laneIds('ready') === 'T-9999,T-0000,T-0102,T-9998,T-9997'`, "missing or invalid creation dates sort after dated tasks without breaking rendering");
  await evaluate(`
    const acceptedTask = task('T-0047', 'Завершить состояния действий Input', { status: 'review' });
    fixture.board.tasks.push(acceptedTask); push();
    const acceptedCard = findCard(acceptedTask.id);
    acceptedTask.status = 'done';
    acceptedTask.updatedAt = '2026-11-07T12:00:00.000Z';
    push(); settle();
  `);
  await check(`laneIds('done') === 'T-0047,T-0110,T-0111' && lane('done').querySelector('.task-card') === acceptedCard`,
    "an accepted older card moves to the top of Done without replacing its node");
  await evaluate(`
    fixture.board.archived = [
      { id: 'T-9999', title: 'Старый формат архива', status: 'done', closedAt: '2026-11-10T12:00:00.000Z' },
      { id: 'T-0033', title: 'Обновлён архивный тег', status: 'done', closedAt: '2026-11-01T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z' },
    ];
    push(); archiveView = true; render(); void 0;
  `);
  await check(`byId('archive-list').querySelector('.task-id').textContent === 'T-0033'`,
    "archive sorts by last change and falls back to the closing date for older archive entries");
  await evaluate(`archiveView = false; fixture.board.archived = []; void 0`);
  await evaluate(`fixture.russian = true; fixture.project = 'board-fixture'; fixture.board.tasks = [task('T-0001', 'Стабильное превью', { attachments: [{ file: 'cover.png', name: 'cover.png' }] }), task('T-0002', 'Обновляемая карточка', { tags: ['UI'] })]; push(); void 0`);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "board-stable.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    fixture.tabs = [{ path: 'board-fixture', name: 'Первый проект' }, { path: 'cache-second', name: 'Второй проект' }, { path: 'cache-delayed', name: 'Загрузка' }];
    push();
    const tabCard = findCard('T-0001');
    const tabCover = tabCard.querySelector('img');
    const firstBoard = structuredClone(fixture.board);
    const secondBoard = { ...structuredClone(fixture.board), tasks: [task('T-0001', 'Превью другого проекта', { attachments: [{ file: 'cover.png', name: 'cover.png' }] })] };
    const callsBeforeSwitch = window.previewCalls;
    fixture.project = 'cache-second'; fixture.board = secondBoard; push(); void 0;
  `);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`findCard('T-0001') !== tabCard && findCard('T-0001').querySelector('img') !== tabCover && window.previewCalls === callsBeforeSwitch + 1`, "identical attachment paths in another project have a separate preview request and image");
  await evaluate(`
    const secondTabCard = findCard('T-0001');
    const secondTabCover = secondTabCard.querySelector('img');
    firstBoard.tasks[0].title = 'Обновлено в фоновой вкладке'; firstBoard.tasks[0].revision++;
    fixture.project = 'board-fixture'; fixture.board = firstBoard; push(); void 0;
  `);
  await check(`findCard('T-0001') === tabCard && tabCard.querySelector('img') === tabCover && tabCover.naturalWidth > 0 && !tabCover.hidden`, "returning to a project immediately reuses its decoded image and card");
  await check(`tabCard.textContent.includes('Обновлено в фоновой вкладке') && window.previewCalls === callsBeforeSwitch + 1`, "background changes reach the restored card without fetching its cover again");
  await evaluate(`
    for (let round = 0; round < 10; round++) {
      fixture.project = 'cache-second'; fixture.board = secondBoard; push();
      fixture.project = 'board-fixture'; fixture.board = firstBoard; push();
    }
    void 0;
  `);
  await check(`findCard('T-0001') === tabCard && tabCard.querySelector('img') === tabCover && window.previewCalls === callsBeforeSwitch + 1`, "repeated tab switches retain decoded images without additional preview requests");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "project-tabs-cached-images.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    delete window.releasePreview;
    fixture.project = 'cache-delayed';
    fixture.board = { ...firstBoard, tasks: [task('T-0001', 'Отложенное превью', { attachments: [{ file: 'delayed.png', name: 'delayed.png' }] })] };
    push(); void 0;
  `);
  await evaluate(`waitFor(() => !!window.releasePreview)`);
  await evaluate(`
    const delayedCache = cardCoverCache;
    fixture.project = 'board-fixture'; fixture.board = firstBoard; push();
    window.releasePreview(); void 0;
  `);
  await evaluate(`settle()`);
  await check(`cardCoverCache !== delayedCache && findCard('T-0001').querySelector('img') === tabCover && tabCover.dataset.file === 'cover.png'`, "a late response from an inactive board cannot replace the current project's image");
  await evaluate(`
    fixture.tabs = fixture.tabs.filter(tab => tab.path !== 'cache-second'); push();
    const callsBeforeReopen = window.previewCalls;
    void 0;
  `);
  await check(`!boardViews.has('cache-second') && !secondTabCard.isConnected`, "closing a tab releases its cached board view");
  await evaluate(`
    fixture.tabs.push({ path: 'cache-second', name: 'Второй проект' });
    fixture.project = 'cache-second'; fixture.board = secondBoard; push(); void 0;
  `);
  await evaluate(`waitFor(() => findCard('T-0001').querySelector('img')?.naturalWidth > 0)`);
  await check(`findCard('T-0001') !== secondTabCard && findCard('T-0001').querySelector('img') !== secondTabCover && window.previewCalls === callsBeforeReopen + 1`, "reopening a closed project creates a fresh card and preview");
  await evaluate(`fixture.project = 'board-fixture'; fixture.board = firstBoard; push(); delete fixture.tabs; void 0`);
  await evaluate(`
    const interrupted = task('T-0050', 'Добавить вкладки проектов в одном окне', {
      status: 'in_progress', codexThreadId: '01234567-1234-5678-1234-123456789012',
    });
    fixture.board.tasks.push(interrupted);
    const launchCalls = [];
    let completeLaunch;
    Object.assign(window.taskboard, {
      command: async (name, id) => ({ ok: name === 'show' && id === interrupted.id, data: structuredClone(interrupted) }),
      chatModels: async () => ({ ok: true, data: [] }),
      launchTask: id => {
        launchCalls.push(id);
        return new Promise(resolve => { completeLaunch = resolve; });
      },
    });
    const resume = () => [...byId('sheet-body').querySelectorAll('button')].find(node => node.textContent === 'Продолжить');
    push();
    findCard(interrupted.id).click();
    void 0;
  `);
  await check(`sheet.open && !!resume() && !resume().hidden`, "an interrupted task can be resumed from its open card");
  await evaluate(`fixture.runningTasks = ['T-0001', 'T-0002']; push(); void 0`);
  await check(`byId('task-agent-run').textContent === 'Запуск с доски не активен'`, "occupied slots do not mark an interrupted task as queued");
  await evaluate(`fixture.waitingTasks = [interrupted.id]; push(); void 0`);
  await check(`findCard(interrupted.id).querySelector('.task-queue-indicator').title === 'В очереди' && byId('task-agent-run').textContent === 'В очереди' && !!byId('task-stop-waiting')`, "confirmed queue and its stop button are visible in Russian");
  await capture("executor-waiting-ru.png");
  await evaluate(`fixture.russian = false; push(); void 0`);
  await check(`findCard(interrupted.id).querySelector('.task-queue-indicator').title === 'Waiting for an available executor' && byId('task-agent-run').textContent === 'Waiting for an available executor'`, "confirmed queue is visible in English in both views");
  await capture("executor-waiting-en.png");
  await evaluate(`fixture.waitingTasks = []; push(); void 0`);
  await check(`byId('task-agent-run').textContent === 'Board run inactive' && findCard(interrupted.id).querySelector('.task-run-status').textContent === 'Board run inactive'`, "removing the queued request clears both views");
  await evaluate(`fixture.waitingTasks = [interrupted.id]; fixture.runningTasks.push(interrupted.id); push(); void 0`);
  await check(`byId('task-agent-run').querySelector('.agent-spinner')?.getAttribute('aria-label') === 'Agent is working' && findCard(interrupted.id).querySelector('.agent-spinner') !== null`, "a running executor takes precedence over a preceding queue snapshot");
  await evaluate(`fixture.russian = true; fixture.waitingTasks = []; fixture.runningTasks = []; push(); void 0`);
  await evaluate(`resume().click(); void 0`);
  await check(`resume().disabled && launchCalls.join(',') === interrupted.id`, "Continue invokes the board launch for the selected task once");
  await evaluate(`completeLaunch({ ok: false, error: { code: 'CODEX_UNAVAILABLE', message: 'Codex unavailable' } }); void 0`);
  await check(`!resume().disabled && byId('sheet-notice').textContent === 'Codex unavailable'`, "a launch error is shown and allows retry");
  await evaluate(`resume().click(); void 0`);
  await evaluate(`fixture.runningTasks = [interrupted.id]; push(); completeLaunch({ ok: true, data: interrupted }); void 0`);
  await check(`resume().hidden && byId('task-agent-run').querySelector('.agent-spinner') !== null`, "the launch button is hidden while the agent is working");
  await evaluate(`fixture.runningTasks = []; push(); void 0`);
  await check(`!resume().hidden && !resume().disabled`, "a stopped launch can be resumed without reopening the card");
  await evaluate(`interrupted.status = 'ready'; interrupted.git = { worktree: 'saved-worktree' }; interrupted.revision++; push(); void 0`);
  await check(`resume()?.disabled === false`, "a previously started task can also continue from Ready");
  await evaluate(`delete interrupted.git; delete interrupted.codexThreadId; interrupted.unfinishedDependencies = ['T-0001']; interrupted.revision++; push(); void 0`);
  await check(`byId('task-launch')?.textContent === 'Передать в работу' && byId('task-launch').disabled`, "first launches retain their label and dependency check");
  await evaluate(`
    interrupted.status = 'review'; interrupted.codexThreadId = '01234567-1234-5678-1234-123456789012';
    interrupted.unfinishedDependencies = []; interrupted.revision++;
    const feedbackCalls = [];
    window.taskboard.command = async (name, id, input) => {
      if (name === 'request-changes') {
        feedbackCalls.push(input);
        interrupted.status = 'blocked'; interrupted.revision += 2;
        interrupted.blocked = { reason: 'thread ' + interrupted.codexThreadId + ' already has an active writer', condition: 'Resume the task.' };
        push();
      }
      return { ok: true, data: structuredClone(interrupted) };
    };
    (async () => {
      await showTask(interrupted.id);
      noteTask(interrupted, 'request-changes');
      const feedbackForm = body.querySelector('form');
      feedbackForm.querySelector('textarea').value = 'Сохранить изображения при переключении вкладок';
      feedbackForm.addEventListener('submit', event => { window.feedbackNavigationPrevented = event.defaultPrevented; });
      feedbackForm.requestSubmit();
      feedbackForm.requestSubmit();
    })();
  `);
  await evaluate(`waitFor(() => sheetKind === 'task' && !!byId('task-launch'))`);
  await check(`feedbackCalls.length === 1 && sheetKind === 'task' && !body.querySelector('form#note') && taskInSheet.revision === interrupted.revision`, "saved feedback closes its form and opens the current task after a busy-chat failure");
  await check(`window.feedbackNavigationPrevented`, "feedback submission synchronously prevents navigation and ignores duplicate submits");
  await check(`body.querySelector('.task-blocker').textContent.includes('другом процессе') && byId('task-launch').textContent === 'Продолжить в новом чате'`, "busy chat failures show a readable reason and the explicit new-chat action");
  await evaluate(`settle()`);
  writeFileSync(join(artifacts, "task-busy-chat-recovery.png"), (await window.webContents.capturePage()).toPNG());
  await evaluate(`
    let newChatChoice;
    window.taskboard.launchTask = async (id, options) => { newChatChoice = { id, options }; return { ok: true, data: null }; };
    byId('task-launch').click(); void 0;
  `);
  await evaluate(`settle()`);
  await check(`newChatChoice.id === interrupted.id && newChatChoice.options.newThread === true && taskInSheet.status === 'blocked'`, "the recovery action asks main to confirm a new chat and preserves the task on cancellation");
  await evaluate(`
    interrupted.blocked = {
      reason: 'Could not save task token usage: Another command is working on this board.\\n\\n{"level":"WARN","target":"codex_otel"}',
      condition: 'Resolve the reported issue and resume the task.',
    };
    interrupted.revision++;
    push(); void 0;
  `);
  await evaluate(`waitFor(() => body.querySelector('.task-blocker') && taskInSheet?.revision === interrupted.revision)`);
  await check(`[body.querySelector('.task-blocker'), findCard(interrupted.id).querySelector('.task-blocker')].every(banner =>
    banner.textContent.includes('записи статистики токенов') && !banner.textContent.includes('codex_otel') &&
    !banner.title.includes('codex_otel')) && !byId('task-launch')`,
    "a legacy telemetry blocker shows a short explanation without offering a new Codex chat");
  await evaluate(`
    interrupted.status = 'done';
    interrupted.git = { worktree: 'saved-worktree' };
    interrupted.cleanupAvailable = true;
    interrupted.artifacts = [{ source: 'first.log', sha256: 'first' }];
    window.taskboard.command = async (name, id, input) => {
      if (name === 'cleanup-status') return { ok: true, data: { pending: true, path: 'saved-worktree', entries: ['!! report.local'] } };
      if (name === 'cleanup') {
        if (input.artifacts?.join() !== 'report.local') return { ok: false, error: { message: 'Expected the report path' } };
        interrupted.cleanupAvailable = false;
        delete interrupted.git.worktree;
        interrupted.artifacts = [{ source: 'first.log', sha256: 'first' }, { source: 'report.local', sha256: 'saved' }];
      }
      return { ok: true, data: structuredClone(interrupted) };
    };
    const sheetButton = text => [...body.querySelectorAll('button')].find(node => node.textContent === text);
    showTask(interrupted.id); void 0;
  `);
  await evaluate(`waitFor(() => taskInSheet?.id === interrupted.id)`);
  await check(`!body.textContent.includes('Принято · рабочая копия сохранена') && !sheetButton('Уборка рабочей копии…') &&
    body.querySelector('#task-review-files summary').textContent.includes('1 файл')`, "accepted cards retain normal completion and evidence without manual cleanup controls");
  await evaluate(`interrupted.cleanupAvailable = false; delete interrupted.git.worktree;
    interrupted.artifacts.push({ source: 'report.local', sha256: 'saved' }); showTask(interrupted.id); void 0`);
  await evaluate(`waitFor(() => taskInSheet?.cleanupAvailable === false)`);
  await check(`body.querySelector('#task-review-files summary').textContent.includes('2 файла')`, "automatic cleanup retains individual saved artifacts on the completed card");
  await check(`!sheetButton('Изменить теги')`, "the completed card has no direct tag editor");
  await evaluate(`interrupted.tags = ['Готово', 'Интерфейс']; interrupted.revision++; push();
    waitFor(() => taskInSheet.tags.includes('Готово'))`);
  await check(`taskInSheet.status === 'done' && byId('task-sheet-tags').textContent.includes('Готово')`,
    "a tag change made by the manager is reflected in the open card");
  window.setContentSize(1720, 960);
  await evaluate(`
    sheet.close();
    fixture.project = 'design-board'; fixture.theme = 'dark'; fixture.runningTasks = [];
    fixture.tabs = [{ path: 'design-board', name: 'AI Taskboard' }, { path: 'design-other', name: 'Electron2D' }];
    fixture.board = { settings: { autoMode: false }, gitInfo: { branch: 'main', head: '0123456789abcdef', user: 'Developer' }, tags: [{ name: 'интерфейс', color: '#91B6F9' }, { name: 'карточки', color: '#C0A5F4' }],
      archived: [task('T-0580', 'Похожий номер', { status: 'done' }), task('T-0058', 'Настроить порядок вкладок', { status: 'done' })], tasks: [
      task('T-0056', 'Убрать надпись «Загрузка проектов»', { tags: ['интерфейс'], createdAt: '2026-11-05' }),
      task('T-0055', 'Исправить обрезку превью по скруглению карточки', { tags: ['интерфейс', 'карточки'], priority: 'high', attachments: [{ file: 'cover.png', name: 'cover.png' }] }),
      task('T-0051', 'Исправить создание чатов вне папки проекта', { status: 'blocked', blocked: { reason: 'Нужно обновить Codex', condition: 'Установить обновление и продолжить задачу.' }, attachments: [{ file: 'notes.txt', name: 'notes.txt' }] }),
      task('T-0017', 'Добавить отдельную прокрутку колонок доски', { status: 'cancelled', priority: 'low', attachments: [{ file: 'notes.txt', name: 'notes.txt' }] }),
      ...Array.from({ length: 52 }, (_, index) => task('D-' + index, [
        'Добавить поддержку ссылок Markdown и открытие MD-файлов', 'Передавать вложения агенту при создании задачи',
        'Выровнять текст в карточке задачи', 'Добавить вкладки проектов в одном окне'
      ][index % 4], { status: 'done', priority: index === 51 ? 'urgent' : 'normal',
        attachments: index === 0 ? [{ file: 'cover.png', name: 'cover.png' }] : [] }))
    ] };
    const designBoard = structuredClone(fixture.board);
    const designOther = { settings: { autoMode: false }, tags: [], archived: [], tasks: [task('T-0001', 'Другая доска', { description: 'Описание другой задачи' })] };
    const draftCalls = [];
    window.taskboard.command = async (_name, id) => ({ ok: true, data: { ...fixture.board.tasks.find(task => task.id === id), criteria: [] } });
    window.taskboard.selectTab = async project => {
      fixture.project = project; fixture.board = project === 'design-board' ? designBoard : designOther; push();
    };
    const draftForm = () => byId('board-composer').querySelector('form');
    const draftText = () => draftForm().querySelector('.draft-input textarea');
    const draftPaste = (files, text = '') => {
      const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
      if (text) transfer.setData('text/plain', text);
      draftText().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    };
    const themeColor = name => {
      const probe = document.createElement('span'); probe.style.color = 'var(' + name + ')'; document.body.append(probe);
      const value = getComputedStyle(probe).color; probe.remove(); return value;
    };
    push(); showTask('T-0055'); void 0;
  `);
  await evaluate(`waitFor(() => sheetKind === 'task' && taskInSheet?.id === 'T-0055')`);
  await evaluate(`sheet.close(); waitFor(() => findCard('T-0055').querySelector('img')?.naturalWidth > 0)`);
  await evaluate(`
    const questionUpdates = [];
    const questionView = { id: 'question-1', text: 'Доступен ли сеанс Windows?', options: ['Да', 'Нет'] };
    const pendingQuestion = question => updateChat({ project: frame.project, type: 'orchestrator-question', question });
    const questionPopup = () => document.querySelector('.manager-question[open]');
    api.answerBoardQuestion = async (id, answer) => {
      questionUpdates.push({ id, answer });
      pendingQuestion(null);
      return { ok: true, data: null };
    };
    pendingQuestion(questionView);
  `);
  await check(`Boolean(questionPopup()?.textContent.includes(questionView.text)) && !draftForm().hasAttribute('data-open') &&
    questionPopup().querySelectorAll('.manager-question-options button').length === 2`,
    "the manager question opens automatically above a collapsed chat");
  await evaluate(`questionPopup().querySelector('.manager-question-options button').click(); settle()`);
  await check(`questionUpdates.length === 1 && questionUpdates[0].id === 'question-1' && questionUpdates[0].answer === 'Да' &&
    !questionPopup() && draftForm().querySelector('.manager-question-trigger').hidden`, "a choice answers the question once and closes the popup");
  await evaluate(`pendingQuestion({ ...questionView, id: 'question-2' }); questionPopup().close(); settle()`);
  await check(`!questionPopup() && !draftForm().querySelector('.manager-question-trigger').hidden`, "dismissing a popup keeps its question available");
  await evaluate(`draftForm().querySelector('.manager-question-trigger').click(); settle()`);
  await evaluate(`const customAnswer = questionPopup().querySelector('textarea');
    customAnswer.value = 'Сеанс будет вечером.';
    customAnswer.dispatchEvent(new Event('input'));
    questionPopup().querySelector('form').requestSubmit();
    settle()`);
  await check(`questionUpdates.at(-1).id === 'question-2' && questionUpdates.at(-1).answer === 'Сеанс будет вечером.' &&
    !questionPopup()`, "the user can reopen the popup and send a custom answer");
  await check(`!byId('search') && !byId('filters') && !byId('create') && !byId('board-actions')`, "top search, global filters and creation button are removed");
  await check(`byId('lanes').children.length === 7 && getComputedStyle(lane('ready')).backgroundColor === 'rgba(0, 0, 0, 0)'`, "reference composition uses seven open columns");
  await check(`!byId('status-branch').hidden && byId('status-branch').textContent === 'main' && !byId('status-user') && !document.querySelector('.status-bar .codicon-account') && !byId('status-notifications').hidden && document.querySelector('.status-bar').getBoundingClientRect().bottom === innerHeight`, "status bar retains Git branch and notifications without a user block at the bottom of the window");
  await check(`document.fonts.check('16px codicon') && ['.codicon-git-branch', '.codicon-cloud-upload'].every(selector => { const node = document.querySelector(selector); return getComputedStyle(node).fontFamily === 'codicon' && getComputedStyle(node, '::before').content.length > 2 && node.getBoundingClientRect().width === 16; })`, "status Git branch and publication icons load the actual Codicons font and glyphs");
  await check(`byId('project-tabs').getAttribute('aria-orientation') === 'vertical' && byId('project-tabs').getBoundingClientRect().right <= byId('app-content').getBoundingClientRect().left`, "project tabs form a vertical rail to the left of the board");
  await check(`getComputedStyle(byId('project-tabs').querySelector('[role=tab]')).writingMode === 'vertical-rl'`, "project names are rotated vertically");
  await check(`(() => { const tab = byId('project-tabs').firstElementChild, close = tab.querySelector('.codicon-close'), label = tab.querySelector('.project-tab-name'); const gap = label.getBoundingClientRect().top - close.getBoundingClientRect().bottom; return getComputedStyle(close).fontFamily === 'codicon' && getComputedStyle(close, '::before').content.length > 2 && gap >= 6 && gap <= 8 && tab.getBoundingClientRect().height < 124; })()`, "compact tabs use the shared close icon with a six-to-eight pixel gap to the name");
  await check(`(() => {
    const card = findCard('T-0055');
    return getComputedStyle(card).borderTopColor === themeColor('--border') && getComputedStyle(card).boxShadow === 'none';
  })()`, "opening and closing task details leaves the normal border and no accent shadow");
  await check(`(() => {
    const blocked = findCard('T-0051');
    const stripe = id => getComputedStyle(findCard(id), '::before');
    const urgent = stripe('D-51').backgroundColor;
    return stripe('T-0051').content === 'none' &&
      blocked.querySelector('.task-blocker')?.textContent.includes('Нужно обновить Codex') &&
      stripe('T-0055').backgroundColor === themeColor('--yellow') &&
      stripe('T-0017').backgroundColor === themeColor('--muted') &&
      stripe('D-51').content !== 'none' && ![themeColor('--yellow'), themeColor('--muted'), themeColor('--warn')].includes(urgent) &&
      !findCard('D-51').querySelector('.task-meta').textContent.includes('Срочный') &&
      findCard('D-51').getAttribute('aria-description') === 'Приоритет · Срочный' &&
      !!lane('done').querySelector('.task-done[aria-label]');
  })()`, "priority stripes are independent of status, and normal cards have no priority marker");
  await check(`findCard('T-0055').querySelector('.task-card-heading').nextElementSibling.className === 'task-tags' && findCard('T-0055').querySelector('.task-tags').nextElementSibling.tagName === 'IMG'`, "card title, tags and inset cover follow reference order");
  await check(`(() => { const image = findCard('T-0055').querySelector('img'), card = findCard('T-0055'); return image.getBoundingClientRect().left > card.getBoundingClientRect().left && image.getBoundingClientRect().right < card.getBoundingClientRect().right && parseInt(getComputedStyle(image).borderRadius) > 0; })()`, "cover fits inside the card padding with its own rounded border");
  await evaluate(`
    const shownDone = () => lane('done').querySelectorAll('.task-card').length;
    const moreDone = () => lane('done').querySelector('.lane-more');
    waitFor(() => shownDone() > 4)
  `);
  window.setContentSize(1920, 960);
  await evaluate(`settle()`);
  const edgeCount = await evaluate(`shownDone()`);
  const edgeHeight = await evaluate(`(() => {
    const board = byId('lanes');
    const content = moreDone().parentElement.getBoundingClientRect();
    const layoutOutsideCards = innerHeight - (board.getBoundingClientRect().top + board.clientHeight - 8 - board.scrollTop - content.top);
    return Math.ceil(layoutOutsideCards + content.height / 1.5) + 4;
  })()`);
  window.setContentSize(1920, edgeHeight);
  await evaluate(`settle()`);
  await check(`shownDone() === ${edgeCount} && lane('done').getBoundingClientRect().left >= byId('board-composer').getBoundingClientRect().right`,
    "the completed column uses the available height beside the composer");
  window.setContentSize(1720, 960);
  await evaluate(`settle()`);
  const tallCount = await evaluate(`shownDone()`);
  await check(`parseInt(moreDone().textContent.match(/\\d+/)[0]) === 52 - shownDone() && lane('done').querySelector('.count').textContent === '52'`, "a tall column fits more than four cards and reports its full count");
  await check(`(() => {
    const board = byId('lanes');
    const content = moreDone().parentElement.getBoundingClientRect();
    const visibleHeight = board.getBoundingClientRect().top + board.clientHeight - 8 - board.scrollTop - content.top;
    return content.height > visibleHeight && content.height <= visibleHeight * 1.5;
  })()`, "the initial cards extend below the viewport and show More within one and a half column heights");
  await evaluate(`settle()`);
  await capture("board-reference-dark.png");
  window.setContentSize(1720, 560);
  await evaluate(`waitFor(() => shownDone() < ${tallCount})`);
  window.setContentSize(1720, 960);
  await evaluate(`waitFor(() => shownDone() === ${tallCount})`);
  await evaluate(`moreDone().click(); settle()`);
  const expandedCount = tallCount + 4;
  await check(`shownDone() === ${expandedCount} && parseInt(moreDone().textContent.match(/\\d+/)[0]) === 52 - shownDone()`, "More reveals the next four cards and updates the remaining count");
  await evaluate(`push(); void 0`);
  await check(`shownDone() === ${expandedCount}`, "ordinary snapshots preserve expanded card batches");
  window.setContentSize(1720, 560);
  await evaluate(`settle()`);
  await check(`shownDone() === ${expandedCount}`, "shrinking the window keeps manually revealed cards");
  window.setContentSize(1720, 960);
  await evaluate(`settle()`);
  if (process.argv.includes("--columns-only")) {
    console.log(`Board Chromium checks passed: ${checks}, column fit ${tallCount}/52 before expanding`);
    return;
  }
  await evaluate(`lane('ready').querySelector('summary').click(); void 0`);
  await check(`lane('ready').querySelector('details').open && lane('ready').querySelector('.lane-filter-options').contains(lane('ready').querySelector('.lane-collapse'))`, "ellipsis opens column filters and collapse in one menu");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); void 0`);
  await check(`!lane('ready').querySelector('details').open && document.activeElement === lane('ready').querySelector('summary')`, "Escape closes the column menu and restores focus");
  await window.webContents.insertCSS(":root { --hover-time: 0ms; }");
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    await evaluate(`fixture.theme = '${theme}'; push(); new Promise(resolve => setTimeout(resolve, 220))`);
    await check(`getComputedStyle(findCard('T-0055')).borderTopColor === themeColor('--border') && getComputedStyle(findCard('T-0055')).backgroundColor === themeColor('--panel') && getComputedStyle(findCard('T-0055')).color === themeColor('--text') && getComputedStyle(findCard('T-0055'), '::before').backgroundColor === themeColor('--yellow') && getComputedStyle(findCard('T-0051'), '::before').content === 'none' && getComputedStyle(draftForm().querySelector('.board-draft-field')).backgroundColor === themeColor('--panel') && getComputedStyle(draftForm().querySelector('.board-chat')).backgroundColor === themeColor('--bg')`, theme + " uses active theme colors for cards, priorities, the composer and the chat panel");
    await capture("board-reference-" + theme + ".png");
  }
  for (const width of [1380, 1280, 1180]) {
    window.setContentSize(width, 900);
    await evaluate(`settle()`);
    await check(`byId('lanes').scrollWidth === byId('lanes').clientWidth && [...byId('lanes').children].every(column => column.getBoundingClientRect().right <= innerWidth)`, "all seven columns fit without horizontal scrolling at " + width + " pixels");
    await check(`lane('blocked').querySelector('.lane-title > span').getClientRects().length === 1`, "a single-word column title stays intact at " + width + " pixels");
    if (width === 1380) await capture("board-adaptive-1380.png");
  }
  await check(`Math.abs(byId('lanes').getBoundingClientRect().bottom - document.querySelector('.status-bar').getBoundingClientRect().top) <= 1 && getComputedStyle(byId('board-composer')).position === 'absolute'`, "columns extend to the status bar underneath a floating composer");
  await evaluate(`byId('lanes').scrollTop = byId('lanes').scrollHeight; settle()`);
  await check(`(() => { const cards = lane('done').querySelectorAll('.task-card'); return cards[cards.length - 1].getBoundingClientRect().bottom <= draftForm().getBoundingClientRect().top; })()`, "the final card can scroll completely above the floating field");
  await evaluate(`byId('lanes').scrollTop = 0; void 0`);
  await check(`draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0 &&
    draftForm().querySelector('.draft-placeholder').textContent === 'Напишите менеджеру проекта…' &&
    draftText().getAttribute('aria-label') === 'Сообщение менеджеру проекта'`, "collapsed composer addresses the project manager with a static localized hint");
  for (const russian of [false, true]) {
    await evaluate(`fixture.russian = ${russian}; push(); settle()`);
    await check(`draftForm().querySelector('.draft-placeholder').textContent === ${JSON.stringify(russian ?
      "Напишите менеджеру проекта…" : "Write to the project manager…")}`, "empty composer immediately follows the interface language");
  }
  await check(`(async () => {
    const hint = draftForm().querySelector('.draft-placeholder');
    const changes = [];
    const observer = new MutationObserver(() => changes.push(hint.textContent));
    observer.observe(hint, { childList: true, characterData: true, subtree: true });
    draftText().focus(); push(); draftText().blur(); push();
    await new Promise(resolve => setTimeout(resolve, 11000));
    observer.disconnect();
    return changes.length === 0 && hint.textContent === 'Напишите менеджеру проекта…';
  })()`, "focus, refresh and idle leave the static hint unchanged without a typing flash");
  await capture("manager-static-hint.png");
  await evaluate(`
    const draftBounds = () => JSON.stringify(draftForm().querySelector('.board-draft-field').getBoundingClientRect());
    draftText().value = 'Первая строка\\nВторая строка';
    const collapsedDraftBounds = draftBounds();
    void 0;
  `);
  await hover(".draft-input textarea");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "hovering over the manager field leaves the chat closed");
  await evaluate(`draftText().focus(); settle()`);
  await check(`document.activeElement === draftText() && getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "focusing the manager field leaves the chat closed");
  await clickManagerField();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height > 200)`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).transitionProperty.includes('height') &&
    !draftForm().textContent.includes('Открыть в Codex') && !draftForm().querySelector('.board-chat h2, .board-chat-model')`,
    "clicking the manager field expands the chat without a title or model label");
  await check(`(() => {
    const chat = draftForm().querySelector('.board-chat');
    const panel = chat.getBoundingClientRect();
    const style = getComputedStyle(chat);
    const field = draftForm().querySelector('.board-draft-field').getBoundingClientRect();
    return draftBounds() === collapsedDraftBounds && field.left < panel.left && panel.right < field.right &&
      getComputedStyle(draftForm().querySelector('.draft-placeholder')).visibility === 'hidden' &&
      panel.top < field.top && panel.bottom > field.top && panel.bottom < field.bottom &&
      style.borderBottomLeftRadius === '0px' && style.borderBottomRightRadius === '0px' &&
      document.elementFromPoint(field.left + field.width / 2, field.top + 2)?.closest('.board-draft-field') !== null;
  })()`, "the narrower chat slides up behind the stationary multiline composer with square lower corners");
  await hover(".board-chat-log");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "moving the pointer into chat keeps it open");
  await evaluate(`draftText().focus(); void 0`);
  await hover("#app-menu");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "input focus keeps chat open after the pointer leaves");
  await capture("board-orchestrator-open.png");
  await evaluate(`draftText().blur(); void 0`);
  await hover("#lanes .lane-title");
  await evaluate(`new Promise(resolve => setTimeout(resolve, 250))`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`, "chat stays open after the pointer and input focus leave");
  await clickBoard();
  await evaluate(`waitFor(() => getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden')`);
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden' && draftBounds() === collapsedDraftBounds`, "clicking outside the chat on the board collapses it without shifting the composer");
  await evaluate(`
    draftText().value = '';
    draftText().focus();
    draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => Math.abs(draftForm().querySelector('.board-chat').getBoundingClientRect().height - Math.min(390, innerHeight * .44)) < 2)`);
  await check(`!draftText().readOnly && !draftCalls.length`, "Enter in an empty focused field opens the chat without sending");
  await evaluate(`
    const taskMentions = () => draftForm().querySelector('.draft-task-mentions');
    const mentionKey = key => draftText().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const typeMention = (text, caret = text.length) => {
      const field = draftText();
      field.focus();
      field.value = text;
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    typeMention('Проверь (@58), пожалуйста', 'Проверь (@58'.length);
    void 0;
  `);
  await check(`taskMentions().matches(':popover-open') && taskMentions().firstElementChild.textContent === 'T-0058 · Настроить порядок вкладок' &&
    taskMentions().getBoundingClientRect().bottom <= draftText().getBoundingClientRect().top`, "typing @58 shows the exact task first above the manager input");
  await evaluate(`mentionKey('ArrowDown'); void 0`);
  await check(`taskMentions().querySelector('[aria-selected=true]').textContent.startsWith('T-0580')`, "arrow keys change the selected task");
  await evaluate(`mentionKey('ArrowUp'); mentionKey('Enter'); void 0`);
  await check(`draftText().value === 'Проверь (T-0058), пожалуйста' && !taskMentions().matches(':popover-open') && !draftCalls.length`, "Enter inserts the task reference at the caret without sending the message");
  await evaluate(`typeMention('@0058'); mentionKey('Escape'); typeMention('@0058'); void 0`);
  await check(`draftText().value === '@0058' && !taskMentions().matches(':popover-open')`, "Escape dismisses the current mention without altering the draft");
  await evaluate(`typeMention('user@58'); void 0`);
  await check(`!taskMentions().matches(':popover-open')`, "an at sign inside a word does not trigger task suggestions");
  await evaluate(`typeMention('@T-0058'); taskMentions().firstElementChild.click(); void 0`);
  await check(`draftText().value.trim() === 'T-0058' && document.activeElement === draftText()`, "clicking a suggestion inserts its canonical ID and keeps the composer focused");
  await evaluate(`typeMention(''); void 0`);
  await evaluate(`draftForm().querySelector('.draft-add').click(); settle()`);
  await check(`(() => {
    const menu = draftForm().querySelector('.draft-add-menu');
    const add = draftForm().querySelector('.draft-add');
    return menu.matches(':popover-open') && menu.getBoundingClientRect().bottom <= add.getBoundingClientRect().top &&
      [...menu.querySelectorAll('.draft-menu-actions button')].map(button => button.textContent).join('|') === 'Файлы|Задачи|Режим цели' &&
      !!draftForm().querySelector('.draft-add .codicon-add') && !!draftForm().querySelector('.draft-send .codicon-arrow-up') &&
      !!draftForm().querySelector('.draft-mic .codicon-mic');
  })()`, "the plus opens the three actions above the composer with font icons for plus, microphone and send");
  await evaluate(`
    const addMenuItems = () => draftForm().querySelectorAll('.draft-menu-actions button');
    addMenuItems()[1].click();
    const taskSearch = draftForm().querySelector('.draft-task-picker input');
    taskSearch.value = 'T-0055';
    taskSearch.dispatchEvent(new Event('input'));
    draftForm().querySelector('.draft-task-results button').click();
    void 0;
  `);
  await check(`draftText().value.trim() === 'T-0055' && !draftForm().querySelector('.draft-add-menu').matches(':popover-open')`, "selecting a task inserts its ID in the draft");
  await evaluate(`
    let openedFiles = 0;
    draftForm().querySelector('input[type=file]').click = () => openedFiles++;
    draftForm().querySelector('.draft-add').click();
    addMenuItems()[0].click();
    draftForm().querySelector('.draft-add').click();
    addMenuItems()[2].click();
    draftText().value = '';
    draftText().dispatchEvent(new Event('input'));
    void 0;
  `);
  await check(`openedFiles === 1 && !draftForm().querySelector('.draft-goal-chip').hidden && draftForm().querySelector('.draft-send').disabled &&
    draftForm().querySelector('.draft-placeholder').textContent === 'Опишите цель…'`, "files open the picker and goal mode prompts for a nonempty objective");
  await evaluate(`
    let recordedGoal;
    const normalRequest = window.taskboard.boardRequest;
    window.taskboard.boardRequest = async (text, files, project, goal) => {
      recordedGoal = { text, goal };
      window.pushChat({ project, type: 'orchestrator-goal', goal: {
        objective: goal === 'resume' ? 'Проверить карточки' : text, status: 'active',
      }, goalRunning: true });
      return { ok: true, data: { answer: 'Цель принята', changes: [] } };
    };
    draftText().value = 'Обновить карточки';
    draftForm().requestSubmit();
    waitFor(() => recordedGoal && draftForm().getAttribute('aria-busy') === 'false');
  `);
  await check(`recordedGoal.text === 'Обновить карточки' && recordedGoal.goal && draftForm().querySelector('.draft-goal-chip').hidden`, "sending a goal passes the objective to the manager and returns to message mode");
  await check(`!draftForm().querySelector('.board-goal').hidden && draftForm().querySelector('.board-goal-status').textContent === 'Активная цель'`, "the goal row shows the status confirmed by the provider");
  await evaluate(`
    const goalPanel = draftForm().querySelector('.board-goal');
    const [saveGoal, pauseGoal, resumeGoal, clearGoal] = goalPanel.querySelectorAll('button');
    const goalEditor = goalPanel.querySelector('textarea');
    let savedGoal = { objective: 'Обновить карточки', status: 'active' };
    window.taskboard.boardGoal = async (kind, objective) => {
      if (kind === 'edit' && objective === 'Ошибка') return { ok: false, error: { code: 'BOARD_GOAL_FAILED', message: 'Ошибка сохранения' } };
      if (kind === 'edit') savedGoal = { ...savedGoal, objective };
      if (kind === 'pause') savedGoal = { ...savedGoal, status: 'paused' };
      if (kind === 'clear') savedGoal = null;
      return { ok: true, data: savedGoal };
    };
    goalPanel.querySelector('summary').click();
    goalEditor.value = 'Ошибка';
    goalEditor.dispatchEvent(new Event('input'));
    saveGoal.click();
    waitFor(() => goalPanel.querySelector('[role=alert]').textContent.includes('Ошибка сохранения'));
  `);
  await check(`goalPanel.open && goalEditor.value === 'Ошибка' && goalPanel.querySelector('.board-goal-title').textContent === 'Обновить карточки'`, "a failed edit preserves both the stored goal and the proposed text");
  await evaluate(`
    goalEditor.value = 'Проверить карточки';
    goalEditor.dispatchEvent(new Event('input'));
    saveGoal.click();
    waitFor(() => goalPanel.querySelector('.board-goal-title').textContent === 'Проверить карточки');
  `);
  await evaluate(`pauseGoal.click(); waitFor(() => goalPanel.dataset.status === 'paused')`);
  await check(`pauseGoal.hidden && !resumeGoal.hidden && !resumeGoal.disabled`, "the paused goal can be resumed");
  await evaluate(`resumeGoal.click(); waitFor(() => recordedGoal.goal === 'resume' && draftForm().getAttribute('aria-busy') === 'false')`);
  await check(`recordedGoal.text === '' && goalPanel.dataset.status === 'active'`, "resuming restarts the saved goal without sending its text again");
  await evaluate(`clearGoal.click(); waitFor(() => goalPanel.hidden)`);
  await evaluate(`
    window.taskboard.boardRequest = normalRequest;
    const mediaDevices = {
      getUserMedia: async () => {
        voiceAudio = new AudioContext();
        const tone = voiceAudio.createOscillator();
        const output = voiceAudio.createMediaStreamDestination();
        tone.connect(output);
        tone.start();
        await voiceAudio.resume();
        return voiceStream = output.stream;
      },
    };
    let voiceStream, voiceAudio, finishTranscription, voiceCalls = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    window.taskboard.transcribeVoice = async (samples, locale) => {
      if (!(samples instanceof Float32Array) || !samples.length || locale !== 'ru') throw new Error('Wrong transcription input');
      voiceCalls++;
      return new Promise(resolve => { finishTranscription = () => resolve({ ok: true, data: 'Голосовой черновик' }); });
    };
    const voiceStop = () => draftForm().querySelector('.draft-voice-stop');
    const voiceCancel = () => draftForm().querySelector('.draft-voice-cancel');
    draftText().value = 'Начало ';
    draftText().setSelectionRange(7, 7);
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !voiceStop().disabled);
  `);
  await check(`draftForm().hasAttribute('data-dictating') && draftForm().querySelector('.draft-voice-wave').checkVisibility() && !voiceCalls`, "one microphone click starts recording with the waveform in the composer");
  await evaluate(`
    new Promise(resolve => setTimeout(resolve, 1000)).then(() => {
      voiceStop().click();
      return waitFor(() => !!finishTranscription);
    });
  `);
  await check(`(() => {
    const status = draftForm().querySelector('.draft-voice-status');
    const text = document.createRange();
    text.selectNodeContents(status);
    const label = text.getBoundingClientRect();
    const cancel = voiceCancel().getBoundingClientRect();
    const stop = voiceStop().getBoundingClientRect();
    const center = bounds => bounds.top + bounds.height / 2;
    return status.textContent === 'Распознаю речь…' && label.left > cancel.right && label.right < stop.left &&
      Math.abs(center(label) - center(cancel)) < 1.5 && Math.abs(center(label) - center(stop)) < 1.5;
  })()`, "the transcription label is centered between the voice controls");
  await evaluate(`finishTranscription(); waitFor(() => !draftForm().hasAttribute('data-dictating'))`);
  await check(`draftText().value.trim() === 'Начало Голосовой черновик' && voiceCalls === 1 && !draftCalls.length &&
    voiceStream.getAudioTracks()[0].readyState === 'ended'`, "stopping releases the microphone and inserts the transcript in the existing draft");
  await evaluate(`
    void voiceAudio.close();
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !voiceStop().disabled);
  `);
  await evaluate(`voiceCancel().click(); waitFor(() => !draftForm().hasAttribute('data-dictating'))`);
  await check(`draftText().value.trim() === 'Начало Голосовой черновик' && voiceCalls === 1 &&
    voiceStream.getAudioTracks()[0].readyState === 'ended'`, "cancelling releases the microphone and preserves the draft");
  await evaluate(`
    void voiceAudio.close();
    mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    draftForm().querySelector('.draft-mic').click();
    waitFor(() => !draftForm().hasAttribute('data-dictating') && !draftForm().querySelector('.draft-voice-status').hidden);
  `);
  await check(`draftForm().querySelector('.draft-voice-status').textContent.includes('Не удалось открыть микрофон') &&
    draftForm().querySelector('.draft-mic').checkVisibility() && draftText().value.trim() === 'Начало Голосовой черновик'`, "microphone denial restores the composer and preserves the draft");
  await check(`(() => {
    const button = draftForm().querySelector('.draft-send');
    const outer = button.getBoundingClientRect();
    const glyph = button.firstElementChild.getBoundingClientRect();
    return outer.width === 28 && outer.height === 28 && getComputedStyle(button).borderRadius === '50%' &&
      glyph.width === 16 && glyph.height === 16 &&
      Math.abs((glyph.left + glyph.right - outer.left - outer.right) / 2 + .5) < .1 &&
      Math.abs((glyph.top + glyph.bottom - outer.top - outer.bottom) / 2) < .1;
  })()`, "the circular send button centers its glyph");
  await evaluate(`
    delete navigator.mediaDevices;
    draftForm().querySelector('.draft-voice-status').hidden = true;
    draftText().value = ''; draftText().dispatchEvent(new Event('input')); void 0;
  `);
  await evaluate(`draftForm().querySelector('.board-chat-pin').click(); void 0`);
  await clickBoard();
  await check(`draftForm().querySelector('.board-chat-pin').getAttribute('aria-pressed') === 'true' &&
    !!draftForm().querySelector('.board-chat-pin .codicon-pinned') && getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'visible'`,
    "the active pin glyph appears and keeps the chat open when the board is clicked");
  const grip = await evaluate(`(() => {
    const rect = draftForm().querySelector('.board-chat-resize').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...grip });
  await evaluate(`settle()`);
  window.webContents.sendInputEvent({ type: "mouseMove", button: "left", x: grip.x, y: grip.y - 80 });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: grip.x, y: grip.y - 80 });
  await evaluate(`waitFor(() => !draftForm().hasAttribute('data-resizing') && draftForm().querySelector('.board-chat').getBoundingClientRect().height > 445)`)
    .catch(async error => { throw new Error("Drag did not settle: " + await evaluate(`JSON.stringify({
      height: draftForm().querySelector('.board-chat').getBoundingClientRect().height,
      resizing: draftForm().hasAttribute('data-resizing'),
    })`), { cause: error }); });
  await check(`parseFloat(getComputedStyle(draftForm().querySelector('.board-chat-log')).borderTopWidth) === 0`, "mouse drag increases chat height and leaves the transcript unframed");
  await evaluate(`draftForm().querySelector('.board-chat-pin').click(); void 0`);
  await clickBoard();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0)`)
    .catch(error => { throw new Error("Unpinned chat did not collapse", { cause: error }); });
  window.setContentSize(760, 760);
  await evaluate(`settle()`);
  await check(`byId('lanes').scrollWidth > byId('lanes').clientWidth && draftForm().getBoundingClientRect().right <= innerWidth && draftForm().getBoundingClientRect().bottom <= document.querySelector('.status-bar').getBoundingClientRect().top`, "narrow windows scroll the columns and retain a usable bottom composer");
  await capture("board-reference-narrow.png");
  await evaluate(`draftForm().requestSubmit(); void 0`);
  await check(`!draftText().readOnly`, "empty requests do not start preparation");
  await evaluate(`
    let finishWaiting;
    window.taskboard.boardRequest = (request, files) => {
      draftCalls.push({ request, files });
      return new Promise(resolve => { finishWaiting = resolve; });
    };
    window.taskboard.stopOrchestrator = async () => {
      finishWaiting({ ok: false, error: { code: 'BOARD_WAIT_CANCELLED', message: '' } });
      return { ok: true };
    };
    draftText().value = 'Сохранить мой запрос';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], 'image.png', { type: 'image/png' }));
    draftForm().dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => draftForm().querySelector('.board-attachment-preview img')?.naturalWidth > 0)`);
  await check(`!!draftForm().querySelector('.board-attachment-preview[aria-label="Просмотреть image.png"]')`, "dropping an image displays a preview before sending");
  await clickManagerField();
  await evaluate(`
    draftForm().requestSubmit(); draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !!finishWaiting)`);
  await evaluate(`window.pushChat({ project: fixture.project, type: 'orchestrator-waiting' }); void 0`);
  await check(`!draftText().readOnly && draftForm().querySelector('.chat-thinking').textContent.includes('Жду освобождения') &&
    !draftForm().querySelector('[aria-label="Отменить отправку"]').disabled && draftForm().querySelector('.draft-progress').hidden`, "busy chat keeps the pending request visible with a cancel button");
  await evaluate(`draftForm().querySelector('[aria-label="Отменить отправку"]').click(); void 0`);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false')`);
  await check(`draftCalls.length === 1 && draftCalls[0].files[0].name === 'image.png' && !draftText().value && draftForm().querySelector('.board-chat-queue .board-queued-thumbnail img') && draftForm().querySelector('.draft-progress').hidden && !draftForm().querySelector('.chat-thinking')`, "cancelling the wait leaves the request and image in the queue");
  await evaluate(`draftForm().querySelector('.board-chat-queue [aria-label="Удалить"]').click(); waitFor(() => !draftForm().querySelector('.board-chat-queue').childElementCount)`);
  await evaluate(`draftText().value = 'Сохранить мой запрос'; draftPaste([new File([png], 'image.png', { type: 'image/png' })]); void 0`);
  await evaluate(`byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-other' && !draftText().value && !draftForm().querySelectorAll('li').length && !draftForm().querySelectorAll('.chat-entry').length && findCard('T-0001').querySelector('.task-description').textContent === 'Описание другой задачи'`, "Down switches projects with isolated input, attachments, chat and description preview");
  await evaluate(`draftText().value = 'Другой запрос'; byId('project-tabs').querySelector('[aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); settle()`);
  await check(`fixture.project === 'design-board' && draftText().value === 'Сохранить мой запрос' && draftForm().querySelectorAll('li').length === 1 &&
    getComputedStyle(findCard('T-0055')).borderTopColor === themeColor('--border')`, "Up restores the source project's draft and attachment without an accent border on the last opened card");
  await evaluate(`draftForm().querySelector('.board-attachment-remove').click(); settle()`);
  await check(`draftForm().querySelector('.draft-attachments').hidden`, "attached files can be removed before sending");
  await evaluate(`draftPaste([new File([new Uint8Array(64 * 1024 * 1024 + 1)], 'large.bin')]); void 0`);
  await check(`draftForm().querySelectorAll('li').length === 0 && draftForm().textContent.includes('64 МиБ')`, "oversized attachments are rejected without changing the draft");
  await evaluate(`
    const pickerTransfer = new DataTransfer(); pickerTransfer.items.add(new File(['notes'], 'notes.txt'));
    const designPicker = draftForm().querySelector('[type=file]'); designPicker.files = pickerTransfer.files; designPicker.dispatchEvent(new Event('change'));
    draftText().value = '';
    let resolveDesignDraft;
    window.taskboard.boardRequest = (request, files) => { draftCalls.push({ request, files }); return new Promise(resolve => { resolveDesignDraft = resolve; }); };
    draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => !!resolveDesignDraft)`);
  await check(`draftCalls.at(-1).request === '' && draftCalls.at(-1).files[0].name === 'notes.txt' && !draftText().readOnly && draftForm().getAttribute('aria-busy') === 'true'`, "attachment-only requests leave the composer editable during preparation");
  await evaluate(`window.taskboard.selectTab('design-other'); resolveDesignDraft({ ok: true, data: { answer: 'Готово', changes: [{ id: 'T-0999', action: 'create' }] } }); settle()`);
  await check(`!sheet.open && fixture.project === 'design-other' && draftText().value === 'Другой запрос'`, "a background draft completion cannot open a task or erase another project's input");
  await evaluate(`window.taskboard.selectTab('design-board'); settle()`);
  await check(`!draftText().value && draftForm().querySelector('.draft-attachments').hidden && draftForm().getAttribute('aria-busy') === 'false'`, "successful background preparation clears only its original composer");
  await clickBoard();
  await evaluate(`waitFor(() => getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden')`);
  await evaluate(`
    const managerTaskCall = (id, action) => ({ id: action + id, type: 'dynamicToolCall', title: 'task_' + action,
      text: '{}', status: 'completed', taskChanges: [{ id, action }] });
    window.taskboard.boardRequest = async (request, files) => { draftCalls.push({ request, files }); return { ok: true, data: { answer: 'Готово', items: [managerTaskCall('T-0056', 'create')] } }; };
    draftText().value = 'Создать задачу'; draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && !!draftForm().querySelector('[data-task="T-0056"]'))`);
  await check(`!sheet.open && !draftText().value && draftCalls.at(-1).request === 'Создать задачу' && draftForm().querySelector('.board-chat-log').textContent.includes('Черновик создан')`, "Enter creates a draft and shows the result in the orchestrator chat");
  await check(`getComputedStyle(draftForm().querySelector('.board-chat')).visibility === 'hidden'`, "sending from the closed field keeps the chat closed");
  await clickManagerField();
  await evaluate(`waitFor(() => !draftForm().querySelector('.board-chat').getAnimations().length && draftForm().querySelector('.board-chat').getBoundingClientRect().height > 0); `);
  await evaluate(`settle()`);
  await check(`(() => { const result = draftForm().querySelector('[data-task="T-0056"]'); return !!result.closest('.chat-work:not([open])'); })()`, "the result is inside the collapsed work chronology");
  await check(`getComputedStyle(draftForm().querySelector('.chat-text')).fontFamily.includes('Segoe UI')`, "orchestrator messages retain the application font");
  await capture("board-orchestrator-result.png");
  await evaluate(`const createdTaskLink = draftForm().querySelector('[data-task="T-0056"]'); createdTaskLink.closest('.chat-work').open = true; createdTaskLink.closest('.chat-run-item').open = true; createdTaskLink.click(); void 0`);
  await evaluate(`waitFor(() => sheet.open && taskInSheet?.id === 'T-0056')`);
  await check(`taskInSheet.id === 'T-0056'`, "a chat result opens the created task on request");
  await evaluate(`const previousTaskLinks = draftForm().querySelectorAll('.board-chat-task').length; void 0`);
  await evaluate(`
    sheet.close();
    window.taskboard.boardRequest = async () => ({ ok: true, data: { answer: 'На доске три готовых задачи.', changes: [] } });
    draftText().value = 'Что на доске?'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && draftForm().textContent.includes('На доске три готовых задачи.'))`);
  await check(`!draftText().value && draftForm().querySelectorAll('.board-chat-task').length === previousTaskLinks`, "a discussion reply does not add a task result");
  await evaluate(`
    window.taskboard.boardRequest = async () => ({ ok: true, data: { answer: '', items: [managerTaskCall('T-0055', 'cancel')] } });
    draftText().value = 'Задача 55 не актуальна, отменяй'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => draftForm().getAttribute('aria-busy') === 'false' && !!draftForm().querySelector('[data-task="T-0055"]'))`);
  await check(`draftForm().querySelector('[data-task="T-0055"]').closest('.chat-run-item').querySelector('summary').textContent.includes('Задача отменена') && !sheet.open`, "a cancellation links to the affected task and shows its action");
  await evaluate(`
    const savedItems = [
      { id: 'a', type: 'dynamicToolCall', title: 'board_list', text: 'Board contents', status: 'completed' },
      { id: 'b', type: 'commandExecution', title: 'Get-Content README.md', text: 'Documentation', status: 'completed' },
      { id: 'c', type: 'agentMessage', text: [
        'Ответ из истории. По текущей доске:', '',
        '- **Три задачи готовы к работе.** В очереди поддержка F11 и правки карточек.',
        '- **Одна задача заблокирована.** Она ждёт обновления интеграции с Codex.',
        '',
        'Могу уточнить детали по любой задаче.',
      ].join('\\n'), status: 'completed', phase: 'final_answer' },
    ];
    window.taskboard.boardHistory = async () => ({ ok: true, data: { id: 'thread', turns: [
      { messages: [{ text: 'Вопрос из истории', files: [{ name: 'notes.txt' }] }], changes: [], items: savedItems, durationMs: 13000 },
      { messages: [{ text: 'Задача 55 не актуальна', files: [] }],
        items: [managerTaskCall('T-0055', 'cancel'),
          { id: 'd', type: 'agentMessage', text: 'T-0055 отменена как неактуальная.', status: 'completed', phase: 'final_answer' }] },
    ] } });
    window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
    draftText().focus(); void 0;
  `);
  await evaluate(`waitFor(() => !!draftForm().querySelector('.chat-work .chat-run-group'))`);
  await check(`draftForm().querySelectorAll('.chat-run-item').length === 3 && draftForm().querySelector('.chat-run-final').textContent.includes('Ответ из истории') && draftForm().textContent.includes('Вопрос из истории') && draftForm().querySelector('.chat-attachment').textContent.includes('notes.txt') &&
    draftForm().querySelector('.chat-run > .chat-run-item:has([data-task="T-0055"]) > summary')?.checkVisibility()`,
    "provider history shows the confirmed cancellation with the work chronology collapsed");
  await check(`(() => {
    const log = draftForm().querySelector('.board-chat-log');
    const answer = log.querySelector('.chat-run-final.board-manager-message').getBoundingClientRect();
    const style = getComputedStyle(log);
    const width = log.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return answer.width > 0 && answer.width <= width * .88 + 1 && log.scrollWidth === log.clientWidth &&
      Math.abs(answer.left - log.getBoundingClientRect().left - parseFloat(style.paddingLeft)) < 1;
  })()`, "the manager's answer is a left-aligned bubble within the transcript without horizontal scrolling");
  await evaluate(`draftForm().querySelector('.board-chat-log').scrollTop = 0; settle()`);
  await capture("board-manager-spacing.png");
  await evaluate(`
    const work = draftForm().querySelector('.chat-work');
    const group = work.querySelector('.chat-run-group');
    const disclosureTransition = async detail => {
      const before = detail.open;
      detail.querySelector('summary').click();
      const animation = detail.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.height));
      if (!animation) return false;
      await animation.finished;
      await settle();
      return detail.open !== before;
    };
    void 0;
  `);
  await check(`disclosureTransition(work)`, "the completed turn animates when opened");
  await check(`disclosureTransition(group)`, "the nested tool group animates when opened");
  await check(`disclosureTransition(group)`, "the nested tool group animates when closed");
  await evaluate(`group.open = true; settle()`);
  await evaluate(`
    const screenshotFiles = new DataTransfer();
    screenshotFiles.items.add(new File([png], 'image.png', { type: 'image/png' }));
    draftForm().dispatchEvent(new DragEvent('drop', { dataTransfer: screenshotFiles, bubbles: true, cancelable: true }));
    settle();
  `);
  await capture("board-orchestrator-tools.png");
  await evaluate(`draftForm().querySelector('.board-attachment-remove').click(); void 0`);
  await evaluate(`
    const managerRequests = [];
    let stoppedOrchestrator = 0;
    window.taskboard.boardRequest = (text, files, project, goal, immediate, id) => new Promise(resolve => {
      managerRequests.push({ text, files, project, immediate, id, resolve });
    });
    window.taskboard.stopOrchestrator = async () => {
      stoppedOrchestrator++;
      managerRequests[0].resolve({ ok: true, data: { id: 'thread', answer: '', changes: [], items: steeredItems, error: 'Ответ остановлен.' } });
      return { ok: true };
    };
    draftText().value = 'Покажи, что происходит'; draftForm().requestSubmit(); void 0;
  `);
  await evaluate(`waitFor(() => managerRequests.length === 1)`);
  await check(`draftText().value === '' && [...draftForm().querySelectorAll('.chat-entry[data-actor="user"][data-enter]')].some(entry => entry.textContent.includes('Покажи, что происходит'))`, "the composer clears and animates the new user message before the reply");
  await evaluate(`
    window.pushChat({ project: fixture.project, type: 'orchestrator-ready', model: 'gpt-active-test' });
    window.pushChat({ project: fixture.project, type: 'orchestrator', items: savedItems.slice(0, 2) });
    void 0;
  `);
  await check(`!!draftForm().querySelector('.chat-run-group[data-enter]') && !draftForm().querySelector('[aria-label="Остановить ответ"]').disabled &&
    !draftForm().querySelector('.board-chat-model')`, "live activity animates tool groups and offers interruption without a model label");
  await check(`(() => {
    const update = text => window.pushChat({ project: fixture.project, type: 'orchestrator', items: [
      { id: 'streaming', type: 'agentMessage', title: '', text, status: 'inProgress', phase: 'final_answer' },
    ] });
    update('Проверяю');
    const reply = () => draftForm().querySelector('[data-item="message:streaming"]');
    const first = reply();
    const fade = first?.getAnimations().find(animation => animation.animationName === 'board-chat-enter');
    if (first?.textContent.trim() !== 'Проверяю' || !fade) return false;
    fade.currentTime = 80;
    update('Проверяю **карточки**');
    const block = reply();
    const continued = block.getAnimations().find(animation => animation.animationName === 'board-chat-enter');
    const tail = block.querySelector('strong .chat-stream-fragment');
    const fades = continued?.currentTime >= 80 && tail?.textContent === 'карточки' &&
      tail.getAnimations()[0]?.animationName === 'board-chat-text-fade' && block.textContent.trim() === 'Проверяю карточки';
    window.pushChat({ project: fixture.project, type: 'orchestrator', items: savedItems.slice(0, 2) });
    return fades;
  })()`, "streaming text fades new fragments while preserving the reply's entrance progress and Markdown");
  await check(`(() => {
    const status = draftForm().querySelector('.chat-thinking > span');
    const update = (type, text, state = 'inProgress', title = '') => window.pushChat({
      project: fixture.project, type: 'orchestrator',
      items: [...savedItems.slice(0, 2), { id: 'live', type, title, text, status: state }],
    });
    if (status.textContent !== 'Думаю…') return false;
    update('reasoning', '**Проверяю карточки**');
    if (status.textContent !== 'Проверяю карточки' || draftForm().querySelector('[data-item="item:live"]')) return false;
    update('reasoning', '**Проверяю карточки**\\n\\n**Готовлю ответ**');
    const animations = status.getAnimations();
    if (status.textContent !== 'Готовлю ответ' || !animations.length) return false;
    update('reasoning', '**Проверяю карточки**\\n\\n**Готовлю ответ**\\nПодробности');
    if (status.getAnimations()[0] !== animations[0]) return false;
    update('reasoning', '**Готовлю ответ**', 'completed');
    if (status.textContent !== 'Думаю…' || !draftForm().querySelector('[data-item="item:live"]')) return false;
    update('commandExecution', '');
    if (status.textContent !== 'Выполняю команду…') return false;
    update('mcpToolCall', '', 'inProgress', 'ai_taskboard / task_wait');
    if (status.textContent !== 'Жду обновления на доске…') return false;
    update('mcpToolCall', '', 'completed', 'ai_taskboard / task_wait');
    return status.textContent === 'Думаю…' && draftForm().querySelector('.board-chat-queue').matches(':empty');
  })()`, "the latest activity replaces and animates one status line without duplicating the live summary");
  await evaluate(`const activityHint = draftForm().querySelector('.draft-placeholder');
    const ordinaryHint = activityHint.textContent; void 0`);
  await clickBoard();
  await evaluate(`waitFor(() => draftForm().querySelector('.board-chat').getBoundingClientRect().height === 0)`);
  await check(`!draftText().readOnly && draftForm().getAttribute('aria-busy') === 'true'`, "an outside click collapses the chat and the field remains editable while the reply continues");
  await check(`activityHint.textContent === 'Думаю…' && draftText().value === '' &&
    activityHint.parentElement === draftText().parentElement && getComputedStyle(activityHint).visibility === 'visible'`,
    "a collapsed manager chat shows the current activity as the empty field's placeholder");
  await evaluate(`window.pushChat({ project: fixture.project, type: 'orchestrator', items: [
    ...savedItems.slice(0, 2),
    { id: 'live', type: 'mcpToolCall', title: 'ai_taskboard / project_git', text: '', status: 'inProgress' },
  ] }); void 0`);
  await check(`activityHint.textContent === 'Вызов инструмента ai_taskboard / project_git'`,
    "tool activity updates the status even while the manager chat is collapsed");
  await check(`(() => {
    const input = draftText();
    input.value = 'Черновик';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const hidden = getComputedStyle(activityHint).visibility === 'hidden' && input.value === 'Черновик';
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return hidden && getComputedStyle(activityHint).visibility === 'visible' &&
      activityHint.textContent === 'Вызов инструмента ai_taskboard / project_git';
  })()`, "typing hides the activity and clearing the field reveals the latest status again");
  await clickManagerField();
  await check(`activityHint.textContent === ordinaryHint &&
    draftForm().querySelector('.chat-thinking').textContent === 'Вызов инструмента ai_taskboard / project_git'`,
    "opening the chat keeps the current status visible only in the log");
  await evaluate(`window.pushChat({ project: fixture.project, type: 'orchestrator', items: savedItems.slice(0, 2) }); void 0`);
  await evaluate(`const managerAction = draftForm().querySelector('.draft-send'); void 0`);
  await check(`managerAction.dataset.action === 'stop' && managerAction.parentElement.querySelectorAll('button').length === 2`, "an empty composer shows microphone and a single stop action");
  await evaluate(`draftPaste([new File(['notes'], 'follow-up.txt')]); void 0`);
  await check(`draftForm().querySelector('.draft-send') === managerAction && managerAction.dataset.action === 'send' && managerAction.getAttribute('aria-label') === 'Отправить запрос'`, "an attachment alone switches the same control to send");
  await evaluate(`
    draftText().value = 'Уточнение к запросу';
    draftText().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    waitFor(() => draftForm().querySelector('.board-chat-queue').childElementCount === 1);
  `);
  await evaluate(`
    draftText().value = 'Следующее сообщение';
    draftText().dispatchEvent(new Event('input', { bubbles: true }));
    draftForm().querySelector('.draft-send').click();
    waitFor(() => draftForm().querySelector('.board-chat-queue').childElementCount === 2);
  `);
  await check(`managerRequests.length === 1 && draftForm().querySelectorAll('.board-chat-queue .board-queued-status').length === 2 &&
    draftForm().querySelector('.board-queued-row').title.includes('follow-up.txt') &&
    !draftForm().querySelector('.board-chat-log .board-queued-row') && managerAction.dataset.action === 'stop'`, "text and attachments queue separately from the transcript during an active reply");
  await evaluate(`
    const queuedMessage = index => draftForm().querySelector('.board-chat-queue').children[index];
    const queuedButton = (index, label) => [...queuedMessage(index).querySelectorAll('button')].find(button => button.textContent === label);
    queuedButton(1, 'Изменить').click();
    waitFor(() => queuedMessage(1).querySelector('textarea'));
  `);
  await evaluate(`
    queuedMessage(1).querySelector('textarea').value = 'Срочное уточнение';
    queuedButton(1, 'Сохранить').click();
    waitFor(() => queuedMessage(1).querySelector('.board-queued-preview').textContent === 'Срочное уточнение');
  `);
  await evaluate(`queuedButton(1, 'Отправить сейчас').click(); waitFor(() => managerRequests.length === 2)`);
  await check(`managerRequests[1].immediate === true && managerRequests[1].text === 'Срочное уточнение' &&
    stoppedOrchestrator === 0 && queuedMessage(0).title.includes('follow-up.txt')`, "editing keeps queue order and Send now uses the active turn ahead of the earlier message");
  await evaluate(`managerRequests[1].resolve({ ok: false, error: { message: 'Ход уже завершился' } }); waitFor(() => queuedButton(1, 'Отправить сейчас'))`);
  await check(`queuedMessage(1).textContent.includes('Срочное уточнение') && draftForm().textContent.includes('Ход уже завершился')`,
    "an immediate-send rejection keeps the edited message in the queue");
  await evaluate(`queuedButton(1, 'Отправить сейчас').click(); waitFor(() => managerRequests.length === 3)`);
  await evaluate(`
    const steered = managerRequests[2];
    const steerMessage = { text: steered.text, files: [{ name: 'report.txt' }] };
    const steeredItems = [...savedItems.slice(0, 2),
      { id: steered.id, type: 'userMessage', userMessage: steerMessage, text: steered.text, title: '', status: 'completed' },
      { id: 'after-steer', type: 'agentMessage', text: 'Уточнение получил', status: 'completed', phase: 'final_answer' }];
    const immediateBubbles = () => [...draftForm().querySelectorAll('.board-chat-log .chat-entry[data-actor="user"]')]
      .filter(entry => entry.querySelector('.chat-text')?.textContent === steered.text);
    const appearsBefore = (first, second) => Boolean(first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    window.pushChat({ project: fixture.project, type: 'orchestrator', items: steeredItems });
    steered.resolve({ ok: true, data: null });
    waitFor(() => !queuedMessage(1));
  `);
  await check(`immediateBubbles().length === 1 && immediateBubbles()[0].textContent.includes('report.txt') &&
    appearsBefore(draftForm().querySelector('.chat-run [data-item="item:a"]'), immediateBubbles()[0]) &&
    appearsBefore(immediateBubbles()[0], draftForm().querySelector('[data-item="message:after-steer"]')) && stoppedOrchestrator === 0`,
    "immediate delivery shows one bubble with attachments between earlier and later activity");
  await evaluate(`managerRequests.splice(1); draftText().value = 'Следующее сообщение'; draftForm().requestSubmit(); waitFor(() => queuedMessage(1))`);
  await evaluate(`
    draftForm().querySelector('[aria-label="Остановить ответ"]').click();
    draftText().value = 'Новый черновик';
    draftText().dispatchEvent(new Event('input', { bubbles: true }));
    void 0;
  `);
  await evaluate(`waitFor(() => managerRequests.length === 2)`);
  await check(`stoppedOrchestrator === 1 && draftForm().textContent.includes('Ответ остановлен.') &&
    managerRequests[1].text === 'Уточнение к запросу' && managerRequests[1].files[0].name === 'follow-up.txt' &&
    managerRequests[1].project === managerRequests[0].project && draftText().value === 'Новый черновик'`, "stopping a reply sends the first queued message with its own attachment and preserves the new draft");
  await evaluate(`managerRequests[1].resolve({ ok: false, error: { message: 'Не удалось отправить' } }); waitFor(() => draftForm().querySelector('.board-chat-queue button'))`);
  await check(`managerRequests.length === 2 && draftText().value === 'Новый черновик' &&
    draftForm().querySelector('.board-chat-queue').textContent.includes('Не отправлено')`, "a failed send keeps the draft and later messages and pauses the queue");
  await evaluate(`draftForm().querySelector('.board-chat-queue button').click(); waitFor(() => managerRequests.length === 3)`);
  await check(`managerRequests[2].text === 'Уточнение к запросу' && managerRequests[2].files[0].name === 'follow-up.txt'`, "retry sends the original message with its attachment");
  await evaluate(`managerRequests[2].resolve({ ok: true, data: { answer: 'Получил уточнение', changes: [] } }); waitFor(() => managerRequests.length === 4)`);
  await check(`managerRequests[3].text === 'Следующее сообщение' && !managerRequests[3].files.length &&
    draftForm().querySelector('.board-chat-queue').childElementCount === 0`, "successful retry sends the next message without mixing attachments");
  await evaluate(`draftForm().closeChat(); void 0`);
  await evaluate(`managerRequests[3].resolve({ ok: true, data: { answer: 'Получил второе сообщение', changes: [] } }); waitFor(() => !draftForm().querySelector('.chat-thinking'))`);
  await check(`draftForm().getAttribute('aria-busy') === 'false' &&
    getComputedStyle(activityHint).visibility === 'hidden' && draftText().value === 'Новый черновик'`,
    "finishing while collapsed leaves the draft visible and clears the running state");
  await clickManagerField();
  await check(`activityHint.textContent === ordinaryHint`, "focusing the composer after completion restores its ordinary prompt");
  await check(`draftText().value === 'Новый черновик' && draftForm().textContent.includes('Получил второе сообщение')`, "the composer keeps text entered while queued requests complete");
  await check(`immediateBubbles().length === 1 && !immediateBubbles()[0].closest('details') &&
    appearsBefore(immediateBubbles()[0], draftForm().querySelector('[data-item="final:after-steer"]'))`,
    "folding the completed reply leaves the immediate message visible in chronological order");
  await evaluate(`
    window.taskboard.boardHistory = async () => ({ ok: true, data: { turns: [
      { messages: [{ text: managerRequests[0].text, files: [] }], items: steeredItems.slice(0, 2) },
      { messages: [{ ...steerMessage, clientId: steered.id }], items: steeredItems.slice(-1) },
    ] } });
    window.pushChat({ project: fixture.project, type: 'orchestrator-history' });
    waitFor(() => immediateBubbles().length === 1 && immediateBubbles()[0].parentNode.matches('.board-chat-log'));
  `);
  await check(`immediateBubbles().length === 1 && immediateBubbles()[0].textContent.includes('report.txt') &&
    appearsBefore(draftForm().querySelector('.chat-run [data-item="item:a"]'), immediateBubbles()[0]) &&
    appearsBefore(immediateBubbles()[0], draftForm().querySelector('[data-item="final:after-steer"]'))`,
    "reloading history preserves the immediate message in the same place without duplication");
  await evaluate(`archiveView = true; render(); void 0`);
  await check(`byId('board-composer').hidden`, "archive view hides task creation field");
  console.log(`Board Chromium checks passed: ${checks}`);
  if (keepArtifacts) console.log("Screenshots: " + artifacts);
}).catch(async error => {
  console.error(error);
  process.exitCode = 1;
  if (window && keepArtifacts) writeFileSync(join(artifacts, "board-failure.png"), (await window.webContents.capturePage()).toPNG());
}).finally(() => {
  window?.destroy();
  app.exit(process.exitCode ?? 0);
});
