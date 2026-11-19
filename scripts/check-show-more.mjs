import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Uses the board's normal snapshot subscription and native Chromium input events.
export async function checkShowMore({ window, evaluate, check, click, capture, artifacts, root }) {
  const report = [
    `Observed: ${new Date().toISOString()}`,
    `${process.platform}/${process.arch}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; Node ${process.versions.node}`,
    "Command: node scripts/check-board.mjs --show-more --artifacts .tasks/qa/show-more",
    "BrowserWindow: sandbox=true, contextIsolation=true; isolated temporary profile; production HTML/CSS/renderer and fixture IPC.",
    "All positions and deltas are in CSS pixels. Snapshots preserve task order and only change revision.",
  ];
  const sources = [
    "scripts/check-board.mjs", "scripts/check-show-more.mjs", "scripts/electron-check.mjs",
    "src/desktop/index.html", "src/desktop/renderer.js", "src/desktop/styles.css", "src/desktop/themes.css",
    "src/desktop/image-preview.js", "src/desktop/review-diff.js", "src/desktop/source-files.cjs",
    "src/desktop/markdown.js", "src/desktop/chat.js", "src/desktop/localization.cjs",
    "src/desktop/locales/ru.json", "src/desktop/locales/en.json",
  ];
  report.push("Source SHA-256 representation: UTF-8 text normalized from CRLF to LF (compare to Git blobs).");
  for (const path of sources) {
    const source = readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
    report.push(`${createHash("sha256").update(source).digest("hex")}  ${path}`);
  }
  const saveReport = () => writeFileSync(join(artifacts, "show-more-scroll-check.txt"), report.join("\n") + "\n");
  window.show();
  window.focus();
  await evaluate(`
    const doneCards = () => [...lane('done').querySelectorAll('.task-card')];
    const doneMore = () => lane('done').querySelector('.lane-more');
    const cardId = node => node?.querySelector('.task-id')?.textContent ?? null;
    const position = () => ({
      x: byId('lanes').scrollLeft,
      y: byId('lanes').scrollTop,
      anchorY: window.showMoreAnchor.getBoundingClientRect().top,
      anchorX: window.showMoreAnchor.getBoundingClientRect().left,
      ids: doneCards().map(cardId),
      focus: cardId(document.activeElement),
      inColumn: lane('done').contains(document.activeElement),
    });
    void 0;
  `);
  try {
    const layouts = [[1280, "bottom"], [1280, "room"], [760, "bottom"], [760, "room"]];
    for (const [width, placement] of layouts) {
      window.setContentSize(width, 800);
      const neighboringCount = placement === "room" ? 16 : 0;
      for (const activation of ["mouse", "Enter", "Space"]) {
        for (const hidden of [1, 177, 2, 3, 4]) {
          const label = `${width}x800 ${placement} ${activation} hidden=${hidden}`;
          await evaluate(`
            fixture.project = ${JSON.stringify(label)};
            fixture.board.tasks = [
              task('OTHER', 'Соседняя колонка'),
              ...Array.from({ length: ${neighboringCount} }, (_, i) => task('C-' + i,
                'Соседняя длинная колонка для проверки прокрутки', {
                  status: 'cancelled',
                  description: 'Дополнительные карточки оставляют место для перехода Tab без прокрутки.',
                })),
              ...Array.from({ length: 200 }, (_, i) => task('D-' + String(i).padStart(3, '0'),
                'Задача ' + i + ' — проверка положения', {
                  status: 'done',
                  description: 'Порядок карточек и позиция доски сохраняются при раскрытии.',
                })),
            ];
            push();
            settle();
          `);
          await evaluate(`
            doneMore().click();
            settle();
          `);
          await evaluate(`
            fixture.board.tasks.length = 1 + ${neighboringCount} + doneCards().length + ${hidden};
            push();
            settle();
          `);
          await evaluate(`
            for (let batch = 0; batch < 2; batch++) {
              lane('cancelled').querySelector('.lane-more')?.click();
            }
            settle();
          `);
          await evaluate(`
            (() => {
              doneMore().focus({ preventScroll: true });
              const board = byId('lanes');
              board.scrollLeft = board.scrollWidth;
              window.showMoreAnchor = doneCards().at(-1);
              board.scrollTop += doneMore().getBoundingClientRect().top - 420;
            })();
            settle();
          `);
          const before = await evaluate(`position()`);
          assert.ok(before.y > 0, label + ": board is vertically scrolled");
          if (width === 760) {
            assert.ok(before.x > 0, label + ": board is at the horizontal right edge");
          }
          await check(`Number(doneMore().textContent.match(/\\d+/)[0]) === ${hidden}`,
            label + ": exact remaining count");
          const takeScreenshot = placement === "room" && activation === "mouse" && hidden === 177;
          const prefix = width === 1280 ? "show-more" : "show-more-narrow";
          if (takeScreenshot) {
            await capture(prefix + "-before.png");
          }
          if (activation === "mouse") {
            await click('.lane[data-state="done"] .lane-more');
          } else {
            window.webContents.focus();
            const keyCode = activation === "Space" ? "Space" : "Enter";
            window.webContents.sendInputEvent({ type: "keyDown", keyCode });
            window.webContents.sendInputEvent({ type: "char", keyCode: activation === "Space" ? " " : "\r" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode });
            await evaluate(`settle()`);
          }
          const after = await evaluate(`position()`);
          report.push(`${label}\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`);
          saveReport();
          const stable = (state, phase) => {
            assert.ok(Math.abs(state.anchorY - before.anchorY) <= 2, label + phase + ": anchor Y");
            assert.equal(state.x, before.x, label + phase + ": scrollLeft");
            assert.equal(state.y, before.y, label + phase + ": scrollTop");
            assert.equal(state.anchorX, before.anchorX, label + phase + ": anchor X");
          };
          stable(after, " activation");
          const added = Math.min(4, hidden);
          assert.equal(after.ids.length, before.ids.length + added, label + ": batch size");
          assert.deepEqual(after.ids.slice(0, before.ids.length), before.ids, label + ": previous order");
          const expectedNew = await evaluate(`fixture.board.tasks.filter(task => task.status === 'done')
            .map(task => task.id).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
            .slice(${before.ids.length}, ${before.ids.length + added})`);
          assert.deepEqual(after.ids.slice(before.ids.length), expectedNew, label + ": revealed order");
          assert.equal(after.focus, expectedNew[0], label + ": first new card is focused");
          assert.ok(after.inColumn, label + ": focus stays in column");
          await check(`lane('ready').querySelectorAll('.task-card').length === 1 &&
            Boolean(doneMore()) === ${hidden > 4}`, label + ": only target column changes; final button disappears");
          await evaluate(`
            fixture.board.tasks = fixture.board.tasks.map(task => ({ ...task, revision: task.revision + 1 }));
            push();
            settle();
          `);
          const refreshed = await evaluate(`position()`);
          report.push(`refresh=${JSON.stringify(refreshed)}`);
          stable(refreshed, " refresh");
          assert.deepEqual(refreshed.ids, after.ids, label + ": refresh preserves batch");
          assert.equal(refreshed.focus, after.focus, label + ": refresh preserves focus");
          if (takeScreenshot) {
            await capture(prefix + "-after.png");
          }
          if (placement === "room" && activation !== "mouse" && added > 1) {
            window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
            window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
            await evaluate(`settle()`);
            const tabbed = await evaluate(`position()`);
            report.push(`Tab=${JSON.stringify(tabbed)}`);
            assert.equal(tabbed.focus, expectedNew[1], label + ": Tab reaches next revealed card");
            stable(tabbed, " Tab");
          }
          report.push("PASS: position, order, batch, focus and refresh; Tab checked when the next card is visible.");
        }
      }
    }
    report.push("60 scenarios passed. Windows: executed. Linux/macOS: not executed; shared DOM-only change, no path/process/window/packaging changes.");
  } catch (error) {
    report.push("FAIL: " + error.stack);
    throw error;
  } finally {
    saveReport();
  }
}
