import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readBoundaryPages(root) {
  const project = join(process.env.TASKBOARD_CHECK_DIR, "goal-boundary");
  mkdirSync(join(project, ".tasks"), { recursive: true });
  const script = `
    import { readManagerHistory, saveManagerHistory } from "./src/desktop/manager-history.ts";

    const project = process.argv[1];
    const at = "2026-11-20T01:25:01.002Z";
    const item = (id, time) => ({ id, at: time, text: id, type: "agentMessage", title: "", status: "completed" });
    // The physical journal records the equal-time IDs in the opposite order.
    const items = [item("late-b", at), item("late-a", at)];
    for (let index = 1; index <= 39; index++) {
      const time = new Date(Date.parse("2026-11-20T01:26:00.000Z") + index).toISOString();
      items.push(item("after-" + index, time));
    }
    const goalId = "625280c9-c9d1-4c28-89fc-82b65c8efaa2";
    saveManagerHistory(project, Date.parse(at), goalId, { lane: "work", goalId, items });
    const head = readManagerHistory(project, null, "work");
    const earlier = readManagerHistory(project, head.nextCursor, "work");
    console.log(JSON.stringify({ head, earlier }));
  `;
  return JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, ["--input-type=module", "-e", script, project], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }));
}

export async function checkGoalOrder({ window, evaluate, capture, artifacts, root }) {
  window.setContentSize(741, 900);
  window.webContents.setZoomFactor(1);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await evaluate(`
    const makeOrderItem = (id, time, text, fields = {}) => ({
      id, at: '2026-11-20T' + time + 'Z', type: 'agentMessage', title: '',
      status: 'completed', text, phase: 'final_answer', ...fields,
    });
    const orderTurn = (...items) => ({ messages: [], items });
    const orderEarly = makeOrderItem('coordination:T-0001/17', '01:17:12.012', '', {
      type: 'dynamicToolCall',
      messagesOnly: true,
      messages: [{
        id: 'T-0001', sequence: 17, actor: 'agent', text: 'Раннее сообщение, доставленное с опозданием.',
        at: '2026-11-20T01:17:12.012Z',
      }],
    });
    const orderFirst = makeOrderItem('late-z', '01:25:01.001', 'Первая самостоятельная реплика за 01:25.', {
      providerTurnId: 'goal-turn-a',
    });
    const orderSecond = makeOrderItem('late-b', '01:25:01.002', 'Вторая самостоятельная реплика за 01:25.', {
      providerTurnId: 'goal-turn-b',
    });
    const orderTie = makeOrderItem('late-a', '01:25:01.002', 'Ещё одна запись с точным совпадением времени.', {
      providerTurnId: 'goal-turn-c',
    });
    const orderCommand = makeOrderItem('goal-command', '01:24:58.000', 'Файл прочитан.', {
      type: 'commandExecution', title: 'Get-Content README.md', providerTurnId: 'goal-turn-a',
    });
    const orderImage = makeOrderItem('goal-image', '01:24:59.000', '', {
      type: 'imageGeneration', providerTurnId: 'goal-turn-a', generatedImage: { file: 'fixture.png' },
    });
    const orderDialogue = makeOrderItem('regular-reply', '01:30:01.000', 'Обычный ответ в диалоге.');
    const orderOlder = Array.from({ length: 20 }, (_, i) => orderTurn(makeOrderItem(
      'old-' + i, '01:0' + Math.floor(i / 10) + ':' + String(i % 10).padStart(2, '0') + '.000', 'Ранняя страница ' + i,
    )));
    const orderGoal = { objective: 'Проверить порядок сообщений', status: 'active' };
    let orderSaved = [orderTurn(orderFirst), orderTurn(orderSecond)];
    let orderEarlierPage = orderOlder;
    let orderCursor = 'earlier';
    let orderLive = [];
    let orderOlderReads = 0;
    window.taskboard.boardHistory = async (_project, cursor, view) => {
      if (view === 'live') return { ok: true, data: { work: orderLive, chat: [] } };
      if (view !== 'work') return { ok: true, data: { turns: [orderTurn(orderDialogue)] } };
      if (cursor === orderCursor) orderOlderReads++;
      return { ok: true, data: {
        turns: cursor === orderCursor ? orderEarlierPage : orderSaved,
        nextCursor: cursor === orderCursor ? null : orderCursor,
        goal: orderGoal, goalRunning: true, goalLogAvailable: true,
      } };
    };
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = 120;
    imageCanvas.height = 48;
    const imageContext = imageCanvas.getContext('2d');
    imageContext.fillStyle = '#375e80';
    imageContext.fillRect(0, 0, 120, 48);
    imageContext.fillStyle = '#ffffff';
    imageContext.font = '14px sans-serif';
    imageContext.fillText('Изображение', 10, 29);
    const orderPreview = imageCanvas.toDataURL();
    window.taskboard.managerImagePreview = async () => orderPreview;
    const orderOpen = async () => {
      const form = byId('board-composer').firstChild;
      form.style.setProperty('--board-chat-height', '660px');
      form.querySelector('.draft-input textarea').click();
      window.pushChat({
        project: fixture.project, type: 'orchestrator-goal', goal: orderGoal, goalRunning: true,
      });
      const toggle = form.querySelector('.board-work-toggle');
      await waitFor(() => !toggle.parentElement.hidden);
      toggle.click();
      await waitFor(() => orderLog().querySelector('[data-item$=":late-b"]'));
      await Promise.all(form.querySelector('.board-chat').getAnimations().map(animation => animation.finished.catch(() => {})));
      await settle();
    };
    const orderLog = () => byId('board-composer').querySelector('.board-work');
    const orderEvent = type => window.pushChat({ project: fixture.project, type: 'orchestrator-work-' + type });
    const orderRow = id => [...orderLog().querySelectorAll('[data-item]')].find(row => row.dataset.item === id);
    const orderSnapshot = () => [...orderLog().querySelectorAll('[data-item]')].flatMap(row => {
      if (!/^(message|final|coordination):/.test(row.dataset.item)) return [];
      const time = row.querySelector('time');
      if (!time) return [];
      const id = row.dataset.item.replace(/^(message|final):/, '');
      return [[id, time.dateTime, time.textContent]];
    });
    push();
    orderOpen();
  `);

  const early = ["coordination:T-0001/17", "2026-11-20T01:17:12.012Z", "01:17"];
  const first = ["late-z", "2026-11-20T01:25:01.001Z", "01:25"];
  const second = ["late-b", "2026-11-20T01:25:01.002Z", "01:25"];
  const tie = ["late-a", "2026-11-20T01:25:01.002Z", "01:25"];
  const stages = [];
  const verify = async (label, expected) => {
    const rows = await evaluate("orderSnapshot()");
    stages.push([label, rows]);
    assert.deepEqual(rows, expected, label);
  };

  await verify("Сохранённые реплики до поздней доставки", [first, second]);
  await evaluate(`
    (async () => {
      orderLive = [orderEarly];
      orderEvent('activity');
      await waitFor(() => orderRow('coordination:T-0001/17'));
      await settle();
    })()
  `);
  await verify("Поздняя доставка ранней живой реплики", [early, first, second]);
  const width = await evaluate("orderLog().getBoundingClientRect().width");
  assert.ok(Math.abs(width - 680) <= 30, "Ширина журнала в CSS-пикселях: " + width);
  assert.equal(await evaluate("Boolean(orderLog().querySelector('.board-work-overview'))"), false);
  const captureSettled = async name => {
    await evaluate(`
      (async () => {
        await settle();
        await Promise.all(orderLog().getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
        await settle();
      })()
    `);
    await capture(name);
  };
  await captureSettled("goal-live-order.png");

  await evaluate(`
    (async () => {
      orderLive = [orderSecond, orderFirst, orderEarly, orderCommand, orderImage];
      orderSaved = [orderTurn(orderCommand, orderImage, orderFirst), orderTurn(orderTie, orderSecond)];
      orderEvent('activity');
      orderEvent('history');
      await waitFor(() => orderRow('message:late-a') && orderRow('item:goal-command'));
      const action = orderRow('item:goal-command');
      for (let detail = action; detail; detail = detail.parentElement.closest('details')) {
        if (!detail.open) detail.querySelector('summary').click();
      }
      await settle();
    })()
  `);
  await verify("Сохранение, дубли из живого снимка и точное совпадение времени", [early, first, tie, second]);
  await evaluate(`
    (async () => {
      orderEarlierPage = [...orderOlder, orderTurn(orderEarly)];
      orderLive = [];
      orderEvent('activity');
      await settle();
    })()
  `);
  await verify("Завершение живого хода до подгрузки ранней записи", [early, first, tie, second]);
  const image = await evaluate(`
    (async () => {
      const preview = () => orderRow('message:late-z').querySelector('[data-manager-image="fixture.png"] img');
      await waitFor(() => preview()?.naturalWidth === 120);
      return !orderRow('message:late-b').querySelector('[data-manager-image]');
    })()
  `);
  assert.equal(image, true, "Миниатюра остаётся в ответе своего providerTurnId");

  const offset = await evaluate(`
    (async () => {
      orderLog().style.maxHeight = '220px';
      orderLog().scrollTop = 0;
      await settle();
      const y = () => orderRow('coordination:T-0001/17').getBoundingClientRect().top - orderLog().getBoundingClientRect().top;
      const before = y();
      orderLog().querySelector('.board-chat-older').click();
      await waitFor(() => orderRow('message:old-0'));
      await settle();
      return { before, after: y(), earlierRequests: orderOlderReads, open: orderRow('item:goal-command').open };
    })()
  `);
  assert.ok(Math.abs(offset.before - offset.after) <= 1, JSON.stringify(offset));
  assert.equal(offset.earlierRequests, 1);
  assert.equal(offset.open, true);
  const older = Array.from({ length: 20 }, (_, i) => {
    const minute = "0" + Math.floor(i / 10);
    return ["old-" + i, "2026-11-20T01:" + minute + ":0" + (i % 10) + ".000Z", "01:" + minute];
  });
  await verify("Ранняя страница и сохранение позиции", [...older, early, first, tie, second]);

  const restored = await evaluate(`
    (async () => {
      const original = orderLog();
      const form = original.closest('form');
      form.querySelector('.board-dialogue-toggle').click();
      await waitFor(() => form.querySelector('[data-message-id="regular-reply"]'));
      const dialogueOk = !form.querySelector('.board-chat-log:not(.board-work)').textContent.includes(orderFirst.text);
      orderLive = [];
      orderSaved = [orderTurn(orderEarly), orderTurn(orderCommand, orderImage, orderFirst), orderTurn(orderSecond, orderTie)];
      fixture.project = 'goal-reopened';
      push();
      await waitFor(() => orderLog() !== original);
      await orderOpen();
      return dialogueOk;
    })()
  `);
  assert.equal(restored, true);
  await verify("Повторно открытая сохранённая история", [early, first, tie, second]);
  await captureSettled("goal-restored-order.png");

  const boundary = readBoundaryPages(root);
  const later = Array.from({ length: 39 }, (_, index) =>
    ["after-" + (index + 1), "2026-11-20T01:26:00." + String(index + 1).padStart(3, "0") + "Z", "01:26"]);
  assert.ok(boundary.head.nextCursor, "Получен курсор ранней страницы журнала");
  assert.equal(boundary.earlier.nextCursor, null);
  assert.equal(boundary.head.turns[0].items[0].id, second[0], "Более поздний ID совпадающего времени попал на первую страницу");
  assert.equal(boundary.earlier.turns[0].items[0].id, tie[0], "Более ранний ID совпадающего времени попал на раннюю страницу");
  await evaluate(`
    (async () => {
      const original = orderLog();
      const boundary = ${JSON.stringify(boundary)};
      orderSaved = boundary.head.turns;
      orderEarlierPage = boundary.earlier.turns;
      orderCursor = boundary.head.nextCursor;
      fixture.project = 'goal-boundary';
      push();
      await waitFor(() => orderLog() !== original);
      await orderOpen();
    })()
  `);
  await verify("Первая сохранённая страница с одним из совпадающих ID", [second, ...later]);
  await evaluate(`
    (async () => {
      orderLog().querySelector('.board-chat-older').click();
      await waitFor(() => orderRow('message:late-a'));
      await settle();
    })()
  `);
  await verify("Догрузка второго совпадающего ID из сохранённой истории", [tie, second, ...later]);

  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const paths = ["scripts/check-board.mjs", "scripts/check-goal-order.mjs", "scripts/electron-check.mjs",
    "src/desktop/chat.js", "src/desktop/renderer.js", "src/desktop/manager-history.ts", "src/desktop/main.ts"];
  const blobs = paths.map(path => {
    const hash = execFileSync("git", ["hash-object", "--path=" + path, path], { cwd: root, encoding: "utf8" }).trim();
    return "- `" + hash + "` — `" + path + "`";
  });
  const report = [
    "# Проверка хронологии «Хода цели»",
    "",
    `Windows Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}. Масштаб 100%, ширина ленты ${width} CSS px, часовой пояс UTC.`,
    "",
    "Команда из корня проекта с установленными зависимостями:",
    "",
    "```powershell",
    "node scripts/check-board.mjs --goal-order-only --artifacts .tasks/qa",
    "```",
    "",
    "Результат — код 0. Штатный renderer в изолированном BrowserWindow, sandbox и contextIsolation включены. Контролируемые IPC-ответы заменяют провайдера. Две страницы с совпадающими отметками времени прочитал штатный менеджер истории из временного журнала. Остальные страницы заданы в проверке. Повторное открытие создало новый экземпляр панели с теми же сохранёнными данными.",
    "",
    `Смещение опорной записи при нажатии «Более ранние события» составило ${offset.after - offset.before} CSS px, запросов ранней страницы — ${offset.earlierRequests}. Действие осталось раскрыто. Миниатюра доступна у своего ответа. Обычный «Диалог» показал свой ответ отдельно. Сводка активных агентов отсутствует.`,
    "",
    "## Идентификаторы, исходное время и показанная минута",
    "",
    ...stages.flatMap(([label, rows]) => ["### " + label, "", ...rows.map(row => "- " + row.join(" · ")), ""]),
    "## Проверенный снимок",
    "",
    `HEAD рабочего дерева перед сдачей — \`${base}\`. Ниже Git blob SHA-1 проверенных файлов после применения фильтров Git, в представлении для коммита.`,
    "",
    ...blobs,
    "",
  ].join("\n");
  writeFileSync(join(artifacts, "goal-order-check.md"), report);
  console.log("Goal chronology Chromium checks passed");
}
