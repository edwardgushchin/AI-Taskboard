import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";

export async function checkTaskChatSend({
  window, evaluate, artifacts, cli, until, check, report, settings, control, activeCard, getProvider,
}) {
  report.fixture = "Real renderer, preload, IPC, main process and CLI. The fixture gates the user write and history read, and controls provider replies.";
  const first = "Вопрос с вложением";
  const second = "Дополнение во время ответа";
  const refused = "Вопрос во время разбора";
  const failed = "Вопрос с отказом после записи";
  const draft = "Новый черновик";
  const quoted = "Исходная цитата";
  const file = "пример.txt";
  const finishText = "Ответ завершён.";
  const id = activeCard.id;
  const other = cli(["create"], plannedDraft({ title: "Другая карточка", execution: settings })).id;
  const task = card => cli(["show", card]);
  const savedUsers = card => task(card).history.filter(event => event.chat && event.actor === "user");
  const open = card => evaluate(`showTask(${JSON.stringify(card)}, true)`);
  const read = text => evaluate(`(() => {
    const log = document.querySelector('.task-dialogue');
    const rows = Array.from(log.querySelectorAll('[data-actor="user"]')).filter(row =>
      row.querySelector('.chat-text')?.textContent.includes(${JSON.stringify(text)}));
    const row = rows[0];
    const thinking = log.querySelector('.chat-thinking');
    return {
      count: rows.length,
      text: row?.textContent,
      sending: row?.textContent.includes('Отправляется…'),
      retry: Boolean(row && Array.from(row.querySelectorAll('button')).some(button =>
        button.textContent === 'Повторить отправку')),
      thinking: Boolean(thinking),
      beforeThinking: Boolean(row && thinking && row.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING),
      input: document.querySelector('#task-chat-input').value,
      inputEnabled: !document.querySelector('#task-chat-input').readOnly,
    };
  })()`);
  const fill = text => evaluate(`(() => {
    const input = document.querySelector('#task-chat-input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
    input.focus();
  })()`);
  const send = async (text, { enter = false, packet = false } = {}) => {
    if (packet) {
      await evaluate(`(() => {
        const input = document.querySelector('#task-chat-input');
        const data = new DataTransfer();
        data.items.add(new File(['attachment bytes'], ${JSON.stringify(file)}, { type: 'text/plain' }));
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
        const state = chatDrafts.get(frame.project + '\\0' + taskInSheet.id);
        state.quotes.push({ source: ${JSON.stringify(quoted)}, comment: 'Комментарий к цитате' });
      })()`);
    }
    await fill(text);
    if (enter) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    } else {
      await evaluate("document.querySelector('.task-chat .chat-send').click()");
    }
  };
  const capture = async (name, text) => {
    await evaluate(`document.fonts.ready.then(() =>
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    assert.equal(await evaluate(`(() => {
      const log = document.querySelector('.task-dialogue');
      const row = Array.from(log.querySelectorAll('[data-actor="user"]')).find(entry =>
        entry.textContent.includes(${JSON.stringify(text)}));
      const viewport = log.getBoundingClientRect();
      const box = row?.getBoundingClientRect();
      return Boolean(box?.height && box.top >= viewport.top && box.bottom <= viewport.bottom);
    })()`), true, "The whole message must be visible in " + name);
    const image = await window.webContents.capturePage();
    assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
    writeFileSync(join(artifacts, name), image.toPNG());
  };
  const complete = provider => provider.finish.resolve({ text: finishText });
  const idle = card => until(() => evaluate(`window.taskboard.bootstrap().then(frame =>
    !frame.replyingTasks?.includes(${JSON.stringify(card)}))`), "writer released for " + card);
  const assertPacket = (card, text) => {
    const saved = savedUsers(card).filter(event => event.text.startsWith(text));
    assert.equal(saved.length, 1);
    assert.match(saved[0].text, new RegExp(quoted));
    assert.match(saved[0].text, /Комментарий к цитате/);
    assert.equal(saved[0].chat.files.length, 1);
    const attachment = task(card).attachments.find(item => item.file === saved[0].chat.files[0]);
    assert.equal(attachment.name, file);
    assert.equal(Buffer.from(cli(["attachment", "read", card], { file: attachment.file }).base64, "base64").toString(),
      "attachment bytes");
  };

  await until(() => task(other).history.some(event => event.chat), "other card initial discussion");
  await idle(other);
  window.setContentSize(1280, 800);
  window.focus();
  await open(id);
  control.write = Promise.withResolvers();
  await send(first, { enter: true, packet: true });
  await until(() => control.calls.some(call => call.id === id), "Enter reaches delayed write");
  const pending = await read(first);
  assert.equal(pending.count, 1);
  assert.equal(pending.sending, true);
  assert.equal(pending.thinking, false);
  assert.equal(pending.input, first);
  assert.equal(pending.inputEnabled, true);
  assert.ok(pending.text.includes(file) && pending.text.includes(quoted));
  assert.equal(savedUsers(id).length, 0);
  await capture("send-pending.png", first);
  await fill(draft);
  control.delayShow = { id, gate: Promise.withResolvers() };
  control.write.resolve();
  await until(async () => (await read(first)).beforeThinking, "live reply below question while history read is delayed");
  assert.equal((await read(first)).count, 1);
  control.delayShow.gate.resolve();
  delete control.delayShow;
  await until(() => evaluate("taskInSheet.history.some(event => event.chat?.requestId)"), "stored history reaches the renderer");
  const saved = await read(first);
  assert.equal(saved.count, 1);
  assert.equal(saved.sending, false);
  assert.equal(saved.beforeThinking, true);
  assert.equal(saved.input, draft);
  assertPacket(id, first);
  await capture("send-saved.png", first);
  check("Enter before the gated write, saved history delayed behind live activity, one question with attachment and quotation, new draft preserved");

  await open(other);
  assert.equal((await read(first)).count, 0);
  assert.equal((await read(first)).thinking, false);
  await open(id);
  assert.equal((await read(first)).count, 1);
  assert.equal((await read(first)).input, draft);
  assert.equal((await read(first)).beforeThinking, true);
  check("Switching cards hides unrelated reply activity and reopening restores one question and the new draft");

  const ordinary = getProvider();
  control.write = Promise.withResolvers();
  await send(second);
  await until(() => control.calls.filter(call => call.id === id).length === 2, "button reaches delayed steering write");
  assert.equal((await read(second)).sending, true);
  assert.equal((await read(second)).input, second);
  assert.equal(savedUsers(id).length, 1);
  control.write.resolve();
  await until(() => control.steering.some(message => message.text === second), "second message steered into current turn");
  await until(async () => (await read(second)).beforeThinking, "saved steering message before live reply");
  assert.equal(getProvider(), ordinary);
  complete(ordinary);
  await idle(id);
  assert.equal(savedUsers(id).filter(event => event.text === second).length, 1);
  check("The send button displays a second question immediately and hands it to the existing response without starting another turn");

  control.holdAnalysis = true;
  const automatic = cli(["create"], plannedDraft({ title: "Автоматический разбор", execution: settings })).id;
  await until(() => getProvider()?.mode === "initial", "automatic analysis starts");
  const analysis = getProvider();
  await open(automatic);
  await send(refused, { packet: true });
  await until(async () => (await read(refused)).retry, "automatic analysis refuses write and offers retry");
  assert.equal(savedUsers(automatic).length, 0);
  assert.equal((await read(refused)).input, refused);
  await fill(draft);
  analysis.finish.resolve({ text: JSON.stringify({ questions: "Как продолжить разбор?" }) });
  await idle(automatic);
  await evaluate(`Array.from(document.querySelectorAll('.task-dialogue button')).find(button =>
    button.textContent === 'Повторить отправку').click()`);
  await until(() => getProvider() !== analysis, "retry starts regular response");
  await until(async () => (await read(refused)).beforeThinking, "retried question before reply");
  assertPacket(automatic, refused);
  assert.equal((await read(refused)).count, 1);
  assert.equal((await read(refused)).input, draft);
  complete(getProvider());
  await idle(automatic);
  check("Automatic analysis refuses before write. Retry sends one copy of the original packet and preserves the independent draft");

  await open(id);
  const previous = getProvider();
  control.delayShow = { id, gate: Promise.withResolvers() };
  await send(failed);
  await until(() => getProvider() !== previous, "response starts after write");
  const failing = getProvider();
  await fill(draft);
  failing.finish.reject(new Error("Fixture refusal after write"));
  await idle(id);
  const retryState = () => evaluate(`(() => {
    const button = document.querySelector('.task-chat .chat-retry-reply');
    const feedback = document.querySelector('.task-chat .chat-composer > .chat-status');
    const history = taskInSheet.history.findLast(event => event.chat);
    return { hidden: button.hidden, disabled: button.disabled, feedback: feedback.textContent, history };
  })()`);
  await until(async () => (await retryState()).feedback.includes("Fixture refusal after write"),
    "send finishes while the saved history is delayed");
  const stale = await retryState();
  assert.notEqual(stale.history.text, failed);
  assert.ok(stale.hidden || stale.disabled, "Reply retry must not target the older question");
  control.delayShow.gate.resolve();
  delete control.delayShow;
  await until(async () => {
    const state = await retryState();
    return !state.hidden && !state.disabled && state.history.text === failed;
  },
    "saved message offers reply retry");
  report.afterWrite = await retryState();
  await evaluate("document.querySelector('.task-chat .chat-retry-reply').click()");
  try {
    await until(() => getProvider() !== failing, "retry responds to saved question");
  } catch (error) {
    report.afterRetry = await retryState();
    throw error;
  }
  assert.equal((await read(failed)).input, draft);
  assert.equal((await read(failed)).count, 1);
  complete(getProvider());
  await idle(id);
  await evaluate("document.querySelector('#close-sheet').click()");
  await open(id);
  assert.equal((await read(failed)).count, 1);
  assert.equal((await read(failed)).input, draft);
  assert.equal(savedUsers(id).filter(event => event.text === failed).length, 1);
  check("Failure after write retries the reply on the existing question. Reopening shows one question and the new draft");
}
