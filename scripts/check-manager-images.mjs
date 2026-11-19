// Production Electron main, IPC, history and renderer with a deterministic provider boundary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronCheck } from "./electron-check.mjs";

const restart = process.argv.includes("--restart");
const { scratch, artifacts } = electronCheck(import.meta.url, "manager-images", 120_000, [[], ["--restart"]]);
const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, nativeImage } = require("electron");
const root = fileURLToPath(new URL("../", import.meta.url));
const project = join(scratch, "board");
const orderProject = join(scratch, "order-board");
const orderPrompt = "Проверь порядок A без финала и B";
app.setPath("userData", join(scratch, restart ? "restart-profile" : "profile"));
app.setPath("appData", join(scratch, "app-data"));
app.requestSingleInstanceLock = () => true;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("lang", "ru");
const cli = (args, input, board = project) => {
  const result = JSON.parse(execFileSync(process.env.TASKBOARD_CHECK_NODE, [
    "--disable-warning=ExperimentalWarning", join(root, "src/cli/main.ts"), "--project", board,
    "--json", ...args, ...(input ? ["--stdin"] : []),
  ], { encoding: "utf8", windowsHide: true, input: input && JSON.stringify(input),
    env: { ...process.env, GIT_CEILING_DIRECTORIES: scratch } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const waitFor = async predicate => {
  const deadline = Date.now() + 20000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for manager images");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
let window;
const results = [];
let finishProvider;
void (async () => {
try {
  if (!restart) {
    symlinkSync(dirname(dirname(require.resolve("electron/package.json"))), join(scratch, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    for (const board of [project, orderProject]) {
      mkdirSync(board);
      cli(["init"], { git: false }, board);
      cli(["settings"], { autoMode: false }, board);
    }
  }
  let chosenProject = project;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosenProject] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(scratch, "download.png") });
  const provider = async (_profile, _project, _prompt, _images, _action, _tools, _instructions, _signal, session) => {
    const orderCase = session.goal === orderPrompt;
    const turnId = orderCase ? "order-A" : session.goal ? "goal-images" : "dialog-images";
    const items = [];
    const add = item => {
      items.push({ title: "", text: "", status: "completed", at: new Date().toISOString(),
        providerTurnId: turnId, ...item });
      session.onActivity([...items]);
    };
    session.save(randomUUID());
    session.onControl({ steer: async () => {}, interrupt: async () => {} }, "fixture");
    if (session.goal) {
      session.onGoalSet();
      session.onGoal({ objective: session.goal, status: "active" });
    }
    add({ id: turnId + "-comment", type: "agentMessage", phase: "commentary", text: "Подготовлю два варианта." });
    add({ id: turnId + "-command", type: "commandExecution", title: "node prepare-images.mjs", text: "Два варианта готовы." });
    for (const [index, color] of [[1, [62, 128, 224, 255]], [2, [86, 186, 88, 255]]]) {
      const pixels = Buffer.alloc(320 * 180 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        for (let channel = 0; channel < 4; channel++) {
          pixels[offset + channel] = color[channel];
        }
      }
      const png = nativeImage.createFromBitmap(pixels, { width: 320, height: 180 }).toPNG();
      const file = await session.saveGeneratedImage({
        id: turnId + "-image-" + index, status: "completed", result: png.toString("base64"),
      });
      assert.ok(file);
      add({ id: turnId + "-image-" + index, type: "imageGeneration", generatedImage: { file } });
    }
    add({ id: turnId + "-tool", type: "dynamicToolCall", title: "Проверка результата", text: "Порядок сохранён." });
    if (orderCase) {
      add({ id: "order-A-tail", type: "agentMessage", phase: "commentary", text: "Ход A сохранил изображения." });
      add({ id: "order-B-comment", providerTurnId: "order-B", type: "agentMessage", phase: "commentary",
        text: "Ход B продолжает работу." });
      add({ id: "order-B-answer", providerTurnId: "order-B", type: "agentMessage", phase: "final_answer",
        text: "Ход B завершён." });
    } else {
      add({ id: turnId + "-answer", type: "agentMessage", phase: "final_answer", text: "Готовы два изображения." });
    }
    finishProvider = Promise.withResolvers();
    await finishProvider.promise;
    session.onTurnEnded();
    if (session.goal) {
      session.onGoal({ objective: session.goal, status: "complete" });
    }
    return { text: "Готовы два изображения.", model: "fixture", goalStatus: session.goal ? "complete" : undefined };
  };
  globalThis.managerImageCheckProvider = provider;
  const sourceUrl = new URL("../src/desktop/main.ts", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace("release.run(() => replyToBoard(", "release.run(() => globalThis.managerImageCheckProvider(")
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, sourceUrl).href));
  const entry = join(scratch, "main-under-test.mjs");
  writeFileSync(entry, require("esbuild").transformSync(source, { loader: "ts", format: "esm" }).code);
  require(entry);
  await waitFor(() => BrowserWindow.getAllWindows().length === 1);
  window = BrowserWindow.getAllWindows()[0];
  window.setContentSize(1280, 800);
  window.webContents.setBackgroundThrottling(false);
  window.show();
  window.focus();
  const evaluate = code => window.webContents.executeJavaScript(code, true).catch(error => {
    throw new Error(code, { cause: error });
  });
  await waitFor(() => evaluate("Boolean(window.taskboard)"));
  await evaluate("window.taskboard.setLanguage('ru')");
  await evaluate("window.taskboard.menuAction('open-project')");
  await waitFor(() => evaluate("window.taskboard.bootstrap().then(f => Boolean(f.board && !f.loading))"));
  await evaluate("document.querySelector('#board-composer .board-draft-field').click()");
  if (!restart) {
    await evaluate(`window.imageCheckPending = window.taskboard.boardRequest('Создай два изображения', [], ${JSON.stringify(project)}, false, false); void 0`);
    await waitFor(() => evaluate("document.querySelectorAll('.board-chat-log:not(.board-work) [data-generated-answer] [data-manager-image]').length === 2"));
    finishProvider.resolve();
    const dialogue = await evaluate("window.imageCheckPending");
    assert.equal(dialogue.ok, true, JSON.stringify(dialogue));
    await evaluate(`window.imageCheckPending = window.taskboard.boardRequest('Создай два изображения для цели', [], ${JSON.stringify(project)}, true, false); void 0`);
    await waitFor(() => evaluate("!document.querySelector('.board-chat-views').hidden"));
    await evaluate("document.querySelector('.board-work-toggle').click()");
    await waitFor(() => evaluate("document.querySelectorAll('.board-work [data-generated-answer] [data-manager-image]').length === 2"));
    finishProvider.resolve();
    const goal = await evaluate("window.imageCheckPending");
    assert.equal(goal.ok, true, JSON.stringify(goal));
    results.push("PASS live dialogue and active goal show two result thumbnails before turn completion");
    await evaluate("document.querySelector('.board-dialogue-toggle').click()");
  }
  assert.equal(readdirSync(join(project, ".tasks/manager-images")).length, 4);
  assert.equal(await evaluate("window.taskboard.managerImagePreview('C:\\\\Windows\\\\win.ini')"), null);
  assert.equal(await evaluate("window.taskboard.managerImagePreview('../board.json')"), null);
  assert.equal(await evaluate("window.taskboard.managerImagePreview('00000000-0000-4000-8000-000000000000-1.png')"), null);
  results.push("PASS IPC rejects arbitrary local paths, traversal and unknown image names");
  await evaluate("document.querySelector('#board-composer .board-draft-field').click()");
  await waitFor(() => evaluate("Boolean(document.querySelector('.board-manager-message .chat-run-images img')?.naturalWidth)"));
  await evaluate("document.querySelector('.board-chat-pin').click()");
  await evaluate(`(async () => {
    for (let index = 0; index < 12; index++) {
      document.querySelector('.board-chat-resize').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp'}));
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  })()`);
  const dialogSelector = ".board-chat-log:not(.board-work)";
  const workResult = ".board-work [data-generated-answer]";
  const capture = async name => {
    await evaluate("document.fonts.ready");
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  const checkTiles = async selector => {
    const tiles = JSON.stringify(selector + " [data-manager-image]");
    const names = JSON.stringify(selector + " [data-manager-image] span");
    await waitFor(() => evaluate(`Boolean(document.querySelector(${tiles}))`));
    for (let index = 0; index < 2; index++) {
      await waitFor(() => evaluate(`(() => {
        const tile = document.querySelectorAll(${tiles})[${index}];
        tile?.scrollIntoView({block:'center', behavior:'instant'});
        return Boolean(tile?.querySelector('img')?.naturalWidth);
      })()`));
    }
    assert.deepEqual(await evaluate(`[...document.querySelectorAll(${names})].map(x => x.textContent)`),
      ["generated-1.png", "generated-2.png"]);
    assert.equal(await evaluate(`document.querySelectorAll(${tiles}).length`), 2);
  };
  await checkTiles(dialogSelector);
  await evaluate(`document.querySelector('${dialogSelector} .board-manager-message').scrollIntoView({block:'end'})`);
  if (!restart) {
    await capture("manager-dialog-generated-images.png");
  }
  const openMouse = async selector => {
    const point = await evaluate(`(() => {
      const tile = document.querySelector('${selector} [data-manager-image]');
      tile.scrollIntoView({block:'center'});
      const r = tile.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    for (const type of ["mouseDown", "mouseUp"]) {
      window.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
    }
    await waitFor(() => evaluate("Boolean(document.querySelector('.image-preview[open] img')?.naturalWidth)"));
  };
  await openMouse(dialogSelector);
  assert.equal(await evaluate("document.querySelector('.image-preview header output').value"), "1 / 2");
  await evaluate("document.querySelector('.image-preview-next').click()");
  await waitFor(() => evaluate("document.querySelector('.image-preview header output').value === '2 / 2'"));
  await evaluate("document.querySelector('.image-preview-toolbar button:last-child').click()");
  await waitFor(() => existsSync(join(scratch, "download.png")));
  const secondFile = await evaluate(`document.querySelectorAll('${dialogSelector} [data-manager-image]')[1].dataset.managerImage`);
  assert.deepEqual(readFileSync(join(scratch, "download.png")), readFileSync(join(project, ".tasks/manager-images", secondFile)));
  await evaluate("document.querySelector('.image-preview').close()");
  await waitFor(() => evaluate("!document.querySelector('.image-preview')"));
  await evaluate(`document.querySelector('${dialogSelector} [data-manager-image]').focus()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate("document.activeElement.hasAttribute('data-manager-image')"), true);
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await waitFor(() => evaluate("Boolean(document.querySelector('.image-preview[open] img')?.naturalWidth)"));
  await evaluate("document.querySelector('.image-preview').close()");
  results.push("PASS dialogue has two thumbnails next to answer, mouse and Enter open viewer, ordered navigation");
  await evaluate("document.querySelector('.board-work-toggle').click()");
  await waitFor(() => evaluate("Boolean(document.querySelector('.board-work-timeline .chat-work'))"));
  await checkTiles(workResult);
  assert.equal(await evaluate("document.querySelector('.board-work .chat-work').open"), false);
  await evaluate("document.querySelector('.board-work').scrollTop = 0");
  if (!restart) {
    await capture("manager-generated-images.png");
  }
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.board-work-timeline [data-item]')].map(x => x.dataset.item).filter(x => /^(message|item):goal-images-/.test(x))"),
    ["message:goal-images-comment", "item:goal-images-command", "item:goal-images-image-1", "item:goal-images-image-2",
      "item:goal-images-tool", "message:goal-images-answer"]);
  assert.equal(await evaluate("document.querySelector('.board-work-timeline').textContent.includes('Цель выполнена')"), true);
  await openMouse(workResult);
  if (!restart) {
    await capture("manager-generated-image-view.png");
  }
  await evaluate("document.querySelector('.image-preview').close()");
  await waitFor(() => evaluate("!document.querySelector('.image-preview')"));
  await evaluate(`document.querySelectorAll('.board-work details').forEach(x => {
    x.open = !x.matches('.chat-run-item') || !/command|tool/.test(x.dataset.item ?? '');
  })`);
  await checkTiles(".board-work .chat-run-group");
  await evaluate("document.querySelector('.board-work .chat-run-group').scrollIntoView({block:'start',behavior:'instant'})");
  if (!restart) {
    await capture("manager-generated-actions.png");
  }
  results.push("PASS goal work preserves commentary, command, two generation actions, tool and answer order");
  for (let index = 0; index < 2; index++) {
    await evaluate("document.querySelector('.board-dialogue-toggle').click()");
    await checkTiles(dialogSelector);
    await evaluate("document.querySelector('.board-work-toggle').click()");
    await checkTiles(workResult);
  }
  results.push("PASS repeated tab switches keep two images in each feed");
  const folder = join(project, ".tasks/manager-chat");
  const historyFile = readdirSync(folder).find(file => JSON.parse(readFileSync(join(folder, file), "utf8")).lane === "work");
  const historyPath = join(folder, historyFile);
  const original = JSON.parse(readFileSync(historyPath, "utf8"));
  writeFileSync(historyPath, JSON.stringify({ ...original, items: original.items.filter(item => item.phase !== "final_answer") }));
  await evaluate("document.querySelector('#board-composer').firstChild.invalidateWork()");
  await checkTiles(".board-work [data-item^='images:']");
  assert.equal(await evaluate("document.querySelector('.board-work [data-item^=images]').closest('.chat-work') === null"), true);
  writeFileSync(historyPath, JSON.stringify(original));
  await evaluate("document.querySelector('#board-composer').firstChild.invalidateWork()");
  await checkTiles(workResult);
  results.push("PASS a turn without a final answer shows two results in the main feed outside collapsed actions");
  // Missing copies retain the activity and let the other image load.
  if (restart) {
    const file = await evaluate(`document.querySelector('${workResult} [data-manager-image]').dataset.managerImage`);
    unlinkSync(join(project, ".tasks/manager-images", file));
    await evaluate("document.querySelector('#board-composer').firstChild.invalidateWork()");
    await waitFor(() => evaluate(`document.querySelector('${workResult} [data-manager-image] span')?.textContent.includes('недоступно')`));
    await evaluate(`document.querySelector('${workResult} [data-manager-image]').click()`);
    await waitFor(() => evaluate("document.querySelector('.image-preview-status')?.textContent.includes('недоступно')"));
    await evaluate("document.querySelector('.image-preview-next').click()");
    await waitFor(() => evaluate("document.querySelector('.image-preview header output').value === '2 / 2'"));
    await evaluate("document.querySelector('.image-preview').close()");
    results.push("PASS missing saved result shows unavailable state, second image and journal survive");
  }
  results.push(restart ? "PASS fresh Electron process reopens both feeds and saved images" : "PASS initial process");
  chosenProject = orderProject;
  await evaluate("window.taskboard.menuAction('open-project')");
  await waitFor(() => evaluate(`window.taskboard.bootstrap().then(frame => frame.board?.project === ${JSON.stringify(orderProject)} && !frame.loading)`));
  await evaluate("document.querySelector('#board-composer .board-draft-field').click()");
  if (restart) {
    await evaluate("document.querySelector('.board-work-toggle').click()");
  }
  await evaluate(`(async () => {
    for (let index = 0; index < 12; index++) {
      document.querySelector('.board-chat-resize').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp'}));
      await new Promise(resolve => setTimeout(resolve, 220));
    }
  })()`);
  const orderSeries = '.board-work [data-item="images:order-A-image-2"]';
  const checkOrder = async () => {
    await checkTiles(orderSeries);
    assert.equal(await evaluate(`(() => {
      const series = document.querySelector(${JSON.stringify(orderSeries)});
      const next = document.querySelector('.board-work [data-item="message:order-B-comment"]');
      const tail = document.querySelector('.board-work [data-item="message:order-A-tail"]');
      return Boolean(next && tail &&
        (tail.compareDocumentPosition(series) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (series.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`), true, "A results must follow A's last record and precede B");
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(orderSeries)}).length`), 1);
  };
  if (!restart) {
    await evaluate(`window.imageCheckPending = window.taskboard.boardRequest(${JSON.stringify(orderPrompt)}, [],
      ${JSON.stringify(orderProject)}, true, false); void 0`);
    await waitFor(() => evaluate("!document.querySelector('.board-chat-views').hidden"));
    await evaluate("document.querySelector('.board-work-toggle').click()");
    await waitFor(() => evaluate("Boolean(document.querySelector('.board-work [data-item=\"message:order-B-comment\"]'))"));
    await checkOrder();
    await capture("manager-image-turn-order-live.png");
    finishProvider.resolve();
    const response = await evaluate("window.imageCheckPending");
    assert.equal(response.ok, true, JSON.stringify(response));
  }
  await waitFor(() => evaluate("Boolean(document.querySelector('.board-work-timeline [data-item=\"message:order-B-answer\"]'))"));
  const history = await evaluate(`window.taskboard.boardHistory(${JSON.stringify(orderProject)}, null, 'work')`);
  assert.equal(history.ok, true, JSON.stringify(history));
  assert.equal(history.data.turns.length, 1, "both provider turns must share one saved history turn");
  assert.deepEqual([...new Set(history.data.turns[0].items.map(item => item.providerTurnId))], ["order-A", "order-B"]);
  await checkOrder();
  await evaluate(`(() => {
    document.querySelectorAll('.board-work .chat-work').forEach(detail => detail.open = true);
    document.querySelectorAll('.board-work .chat-run-group').forEach(detail => detail.open = false);
    document.querySelector(${JSON.stringify(orderSeries)}).scrollIntoView({block:'start', behavior:'instant'});
  })()`);
  await waitFor(() => evaluate(`(() => {
    document.querySelector(${JSON.stringify(orderSeries)}).scrollIntoView({block:'start', behavior:'instant'});
    const log = document.querySelector('.board-work').getBoundingClientRect();
    const series = document.querySelector(${JSON.stringify(orderSeries)}).getBoundingClientRect();
    const next = document.querySelector('.board-work [data-item="message:order-B-comment"]').getBoundingClientRect();
    return series.top >= log.top - 1 && next.bottom <= log.bottom + 1;
  })()`));
  await capture(restart ? "manager-image-turn-order-reopened.png" : "manager-image-turn-order-saved.png");
  await evaluate("document.querySelector('.board-dialogue-toggle').click()");
  await evaluate("document.querySelector('.board-work-toggle').click()");
  await checkOrder();
  results.push(restart
    ? "PASS restarted Electron keeps A images once before B, with both provider turns in one saved history turn"
    : "PASS live and saved A without final answer keeps two images once before B, including a later A commentary");
  const paths = ["src/desktop/chat-images.ts", "src/desktop/manager-images.ts", "src/desktop/codex-chat.ts",
    "src/desktop/main.ts", "src/desktop/preload.cjs", "src/desktop/chat.js", "src/desktop/renderer.js", "src/desktop/manager-history.ts",
    "src/desktop/image-preview.js", "scripts/check-manager-images.mjs"];
  const report = [
    `Windows Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}; 1280x800; sandbox and contextIsolation enabled`,
    "Command: node scripts/check-manager-images.mjs --artifacts .tasks/qa/T-0217",
    "Deterministic provider boundary with two different valid PNGs. Real image generation was not called.",
    "Windows PASS. Linux and macOS runtime unverified; storage uses native node:path, no OS-specific paths or processes added.",
    "Tested base " + execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
    "SHA-256 of working source bytes",
    ...paths.map(path => createHash("sha256").update(readFileSync(join(root, path))).digest("hex") + "  " + path),
    ...results,
  ].join("\n") + "\n";
  writeFileSync(join(artifacts, "manager-generated-images-check.txt"), report, { flag: restart ? "a" : "w" });
  console.log(results.join("\n"));
} catch (error) {
  if (window && !window.isDestroyed()) {
    const diagnostic = await window.webContents.executeJavaScript(`({
      active: document.activeElement.tagName,
      dialogs: document.querySelectorAll('.image-preview').length,
      tiles: [...document.querySelectorAll('.board-work [data-manager-image]')].map(tile => ({
        file: tile.dataset.managerImage,
        width: tile.querySelector('img')?.naturalWidth,
        bounds: tile.getBoundingClientRect().toJSON(),
      })),
      details: [...document.querySelectorAll('.board-work details')].map(detail => ({
        item: detail.dataset.item,
        open: detail.open,
      })),
    })`).catch(() => "Renderer closed");
    console.error(diagnostic);
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const win of BrowserWindow.getAllWindows()) {
    win.destroy();
  }
  app.exit(process.exitCode ?? 0);
}
})();
