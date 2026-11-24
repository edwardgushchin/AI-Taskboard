import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts, keepArtifacts } = electronCheck(import.meta.url, "reviewer-images", 60_000);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, nativeImage } = require("electron");
const project = join(scratch, "board");
const profile = join(scratch, "profile");
const id = "T-0001";
const other = "T-0002";
const first = "reference-blue.png";
const second = "reference-orange.png";
const missing = "missing.png";
const unviewed = "unviewed.png";
const viewed = (id, path, status = "completed") => ({ id, type: "imageView", title: "", status,
  text: JSON.stringify({ path }) });
const finishReview = Promise.withResolvers();
const report = [];

app.setPath("appData", scratch);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
process.argv.push("--project", project);

async function waitFor(probe, description) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out: " + description);
}

function fixtureImage(name, color) {
  const width = 320;
  const height = 160;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const x = (offset / 4) % width;
    pixels.writeUInt32LE(x > width / 3 && x < width * 2 / 3 ? 0xfff2f5f9 : color, offset);
  }
  const image = nativeImage.createFromBitmap(pixels, { width, height });
  writeFileSync(join(project, name), image.toPNG());
  return image.toDataURL();
}

async function run() {
  const { initializeBoard, locateBoard } = require("../src/cli/storage.ts");
  const { record } = require("../src/cli/model.ts");
  const { createTask, recordRunLog } = require("../src/cli/tasks.ts");
  const { addAttachment } = require("../src/cli/archive.ts");
  const { withReviewerChat } = require("../src/desktop/reviewer-chat.ts");
  mkdirSync(project);
  mkdirSync(profile);
  writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
  const storage = initializeBoard(locateBoard(project, true), store => store);
  const expected = [fixtureImage(first, 0xff2255aa), fixtureImage(second, 0xffd07718)];
  fixtureImage(unviewed, 0xff228844);
  let task = storage.create(createTask(id, { title: "Просмотр изображений в ходе ревью" }));
  for (const name of [first, second]) task = addAttachment(storage, task, { path: join(project, name), link: true });
  task = recordRunLog(task, { entries: [viewed("executor", second)] });
  storage.save(record(task, "submit", "agent", "review"));
  storage.create(createTask(other, { title: "Другая карточка" }));

  const review = withReviewerChat(project, id, () => {}, async publish => {
    publish([viewed("first", first), viewed("second", join(project, second)), viewed("missing", missing),
      viewed("failed", unviewed, "failed")]);
    await finishReview.promise;
  });
  try {
    require("../src/desktop/main.ts");
    const window = await waitFor(async () => {
      const [candidate] = BrowserWindow.getAllWindows();
      return candidate && !candidate.webContents.isLoading() && await candidate.webContents.executeJavaScript(
        `typeof frame !== 'undefined' && frame.project === ${JSON.stringify(project)} && Boolean(frame.board)`) && candidate;
    }, "board");
    const contents = window.webContents;
    contents.setBackgroundThrottling(false);
    const evaluate = code => contents.executeJavaScript(code);
    const waitUI = code => waitFor(() => evaluate(code), code);
    const tile = item => `document.querySelector('#task-chat-work :is([data-item="item:${item}"], [data-item^="item:"][data-item$=":${item}"]) .chat-attachment')`;
    const image = item => `${tile(item)}?.querySelector('img')`;
    const viewer = "document.querySelector('.image-preview[open]')";
    const stage = `${viewer}?.querySelector('.image-preview-stage img:not([hidden])')`;
    const getPreview = (card, path, reviewer) =>
      evaluate(`api.runImagePreview(${JSON.stringify(card)}, ${JSON.stringify(path)}, ${reviewer})`);
    async function openHistory() {
      await evaluate(`showTask('${id}')`);
      await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click()`);
    }
    async function reveal(item) {
      await waitUI(`Boolean(${tile(item)})`);
      await evaluate(`(() => {
        const tile = ${tile(item)};
        for (let parent = tile.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches('details')) parent.open = true;
        }
        tile.scrollIntoView({block: 'center'});
      })()`);
    }
    async function thumbnails() {
      for (const [index, item] of ["first", "second"].entries()) {
        await reveal(item);
        await waitUI(`${image(item)}?.naturalWidth === 320`);
        assert.equal(await evaluate(`${image(item)}.src`), expected[index]);
      }
    }
    async function capture(name) {
      if (!keepArtifacts) return;
      await reveal("first");
      writeFileSync(join(artifacts, name), (await contents.capturePage()).toPNG());
    }
    await openHistory();
    assert.equal((await evaluate(`api.reviewerChat('${id}')`)).data.attempts[0].durationMs, undefined);
    assert.equal(await getPreview(id, first, true), expected[0]);
    assert.equal(await getPreview(id, join(project, second), true), expected[1]);
    await thumbnails();
    await capture("review-image-live.png");
    await reveal("first");
    const point = await evaluate(`(() => {
      const rect = ${tile("first")}.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    window.focus();
    contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    await waitUI(`${stage}?.src === ${JSON.stringify(expected[0])}`);
    for (const type of ["keyDown", "keyUp"]) contents.sendInputEvent({ type, keyCode: "Right" });
    await waitUI(`${stage}?.src === ${JSON.stringify(expected[1])}`);
    await evaluate(`${viewer}.close()`);
    report.push("Во вкладке «Ход работы» клик открыл первое вложение, стрелка вправо — второе.");

    finishReview.resolve();
    await review;
    assert.equal(await getPreview(id, first, true), expected[0]);
    assert.equal(await getPreview(id, join(project, second), true), expected[1]);
    await evaluate("sheet.close()");
    await openHistory();
    assert.equal(typeof (await evaluate(`api.reviewerChat('${id}')`)).data.attempts[0].durationMs, "number");
    await thumbnails();
    await capture("review-image-history.png");
    await reveal("second");
    await evaluate(`${tile("second")}.focus()`);
    assert.equal(await evaluate(`document.activeElement === ${tile("second")}`), true);
    contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    contents.sendInputEvent({ type: "char", keyCode: "\r" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitUI(`${stage}?.src === ${JSON.stringify(expected[1])}`);
    await evaluate(`${viewer}.close()`);
    await evaluate(`document.querySelector('[aria-controls="task-chat-work"]').click()`);
    await reveal("executor");
    await waitUI(`${image("executor")}?.src === ${JSON.stringify(expected[1])}`);
    report.push("После завершения ревью IPC возвращает оба файла. После повторного открытия карточки обе миниатюры загружаются из сохранённой истории, Enter открывает вторую. Миниатюра исполнителя загружается.");

    await reveal("missing");
    await waitUI(`/недоступ/i.test(${tile("missing")}.textContent)`);
    await evaluate(`${tile("missing")}.click()`);
    await waitUI(`${viewer}?.querySelector('.image-preview-status').textContent.includes('${missing}')`);
    assert.equal(await getPreview(id, missing, true), null);
    assert.equal(await getPreview(id, unviewed, true), null);
    assert.equal(await getPreview(other, first, true), null);
    assert.equal(await getPreview(id, first, false), null);
    report.push("Отсутствующий файл помечен в миниатюре и просмотрщике. IPC отклоняет путь из неудавшегося действия, путь другой карточки и запрос пути ревьюера в журнале исполнителя.");
    const result = [`PASS Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}/${process.arch}, окно ${window.getSize().join("×")}`,
      "Изолированная доска, тестовые вложения и события без внешнего провайдера. Renderer, preload и IPC приложения.",
      ...report, "Команда: node scripts/check-reviewer-images.mjs --artifacts .tasks/qa", ""].join("\n");
    if (keepArtifacts) writeFileSync(join(artifacts, "review-image-check.txt"), result);
    console.log(result);
  } finally {
    finishReview.resolve();
    await review;
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
