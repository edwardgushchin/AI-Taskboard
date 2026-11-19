import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Called by check-board so this scenario uses the same sandboxed production renderer fixture.
export async function checkSubtaskFill({ window, evaluate, check, artifacts, root }) {
  const { nativeTheme } = await import("electron");
  const report = join(artifacts, "subtask-fill-check.txt");
  writeFileSync(report, "Command: node scripts/check-board.mjs --subtask-fill --artifacts .tasks/qa/T-0222\n");
  const log = text => {
    console.log(text);
    appendFileSync(report, text + "\n");
  };
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  log(`Git HEAD: ${head}; tested source representation: UTF-8 with LF (SHA-256 below).`);
  for (const path of [
    "scripts/check-board.mjs", "scripts/check-subtask-fill.mjs", "scripts/electron-check.mjs",
    "src/desktop/index.html", "src/desktop/renderer.js", "src/desktop/styles.css", "src/desktop/themes.css",
    "src/desktop/localization.cjs", "src/desktop/chat.js", "src/desktop/markdown.js",
    "src/desktop/source-files.cjs", "src/desktop/image-preview.js", "src/desktop/review-diff.js",
    "docs/explanation/architecture.md",
  ]) {
    const source = readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
    log(`${createHash("sha256").update(source).digest("hex")}  ${path}`);
  }
  log(`${process.platform}/${process.arch}; Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; Node ${process.versions.node}; viewport 1280x800.`);
  log("The fixture delivers snapshots through taskboard.subscribe; production card(), update(), CSS and accessibility are unchanged. No provider or real board writes.");
  window.setContentSize(1280, 800);
  // Windows throttles compositor frames for a hidden native window.
  window.showInactive();
  const cdp = window.webContents.debugger;
  cdp.attach("1.3");
  const motion = value => cdp.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
  let passed = 0;
  const verify = async (code, message) => {
    await check(code, message);
    passed++;
    log("PASS: " + message);
  };
  await evaluate(`
    const fillTask = task('T-0222', 'Плавное заполнение подзадач', {
      status: 'in_progress', tags: ['UI'],
      description: 'Сегменты заполняются слева направо. Остальные отметки сохраняются.',
      subtasks: [true, false, false, true].map((done, i) => ({ title: 'Шаг ' + (i + 1), done })),
      attachments: [{ file: 'cover.png', name: 'cover.png' }],
    });
    fixture.board.tasks = [fillTask, task('T-0223', 'Карточка без подзадач')];
    const fillCard = () => findCard(fillTask.id);
    const fillRow = () => fillCard().querySelector('.task-subtask-progress');
    const fillBars = () => [...fillRow().children];
    const fillStyle = bar => getComputedStyle(bar, '::before');
    const fractions = () => fillBars().map(bar => new DOMMatrixReadOnly(fillStyle(bar).transform).a);
    const fillAnimations = () => fillRow().getAnimations({ subtree: true });
    const mark = states => {
      fillTask.subtasks = states.map((done, i) => ({ title: 'Шаг ' + (i + 1), done }));
      fillTask.revision++;
      push();
    };
    const atEnd = states => fractions().every((value, i) => Math.abs(value - Number(states[i])) < 0.001);
    const endFill = async states => {
      mark(states);
      await settle();
      await waitFor(() => atEnd(states) && fillAnimations().length === 0);
    };
    const fillRect = selector => {
      const { x, y, width, height } = fillCard().querySelector(selector).getBoundingClientRect();
      return [x, y, width, height];
    };
    const traceFill = states => new Promise(resolve => {
      mark(states);
      const start = performance.now();
      const samples = [];
      const tick = () => {
        samples.push({ ms: Math.round(performance.now() - start), values: fractions() });
        if (performance.now() - start >= 450) {
          resolve(samples);
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
    push();
    waitFor(() => fillCard()?.querySelector('.task-card-cover')?.naturalWidth > 0);
  `);
  const capture = async name => {
    await evaluate("settle()");
    await window.webContents.capturePage();
    writeFileSync(join(artifacts, name), (await window.webContents.capturePage()).toPNG());
  };
  const assertTrace = (samples, index, increasing) => {
    const values = samples.map(sample => sample.values[index]);
    assert.ok(new Set(values.filter(value => value > 0.02 && value < 0.98).map(value => value.toFixed(3))).size >= 3,
      "at least three distinct intermediate fractions");
    assert.ok(values.slice(1).every((value, i) => increasing ? value >= values[i] - 0.001 : value <= values[i] + 0.001),
      "monotonic fill");
  };
  try {
    await motion("no-preference");
    for (const theme of ["dark", "light"]) {
      nativeTheme.themeSource = theme;
      await evaluate(`
        fixture.theme = ${JSON.stringify(theme)};
        resetBoardRendering();
        fillTask.subtasks = [true, false, false, true].map((done, i) => ({ title: 'Шаг ' + i, done }));
        push();
        settle();
      `);
      await verify(`innerWidth === 1280 && innerHeight === 800 && atEnd([true, false, false, true]) &&
        fillAnimations().length === 0`, `${theme}: first display immediately shows saved progress`);
      await evaluate(`
        window.savedRow = fillRow();
        window.savedBars = fillBars();
        window.savedMeta = fillRect('.task-meta');
        window.savedBounds = fillRect('.task-subtask-progress');
      `);
      const fill = await evaluate("traceFill([true, true, false, true])");
      log(`${theme} fill samples: ${JSON.stringify(fill)}`);
      assertTrace(fill, 1, true);
      assert.ok(fill.every(sample => sample.values[0] === 1 && sample.values[2] === 0 && sample.values[3] === 1));
      const unfill = await evaluate("traceFill([true, false, false, true])");
      assertTrace(unfill, 1, false);
      log(`${theme} unfill samples: ${JSON.stringify(unfill)}`);
      await verify(`atEnd([true, false, false, true]) && fillRow() === savedRow &&
        fillBars().every((bar, i) => bar === savedBars[i])`, `${theme}: fill and unfill preserve connected segments and unchanged neighbors`);

      const multi = await evaluate("traceFill([false, true, true, false])");
      for (const index of [0, 1, 2, 3]) {
        assertTrace(multi, index, index === 1 || index === 2);
      }
      log(`${theme} simultaneous nonadjacent changes: ${JSON.stringify(multi)}`);
      await verify("atEnd([false, true, true, false])", `${theme}: simultaneous changes reach each segment's own target`);
      await evaluate(`
        push();
        fillTask.priority = 'high';
        push();
        settle();
      `);
      await verify(`atEnd([false, true, true, false]) && fillAnimations().length === 0 && fillRow() === savedRow`,
        `${theme}: identical marks and metadata redraw do not restart animation`);

      await evaluate(`
        endFill([false, true, false, true]).then(async () => {
          mark([true, true, true, true]);
          await waitFor(() => fractions()[0] > 0.15 && fractions()[0] < 0.9);
          window.beforeReverse = fractions();
          window.originalTransition = fillAnimations()[0];
          fillTask.priority = 'normal';
          push();
          window.transitionRetained = fillAnimations().includes(originalTransition);
          mark([false, true, false, true]);
          window.afterReverse = fractions();
          await settle();
          mark([true, false, true, true]);
          await settle();
          mark([false, true, true, false]);
          await settle();
          await waitFor(() => atEnd([false, true, true, false]) && fillAnimations().length === 0);
        });
      `);
      log(`${theme} rapid reversal: ${JSON.stringify(await evaluate(`({
        retained: transitionRetained, before: beforeReverse, after: afterReverse,
        metaBefore: savedMeta, metaAfter: fillRect('.task-meta'),
        rowBefore: savedBounds, rowAfter: fillRect('.task-subtask-progress')
      })`))}`);
      await verify(`transitionRetained && beforeReverse.every((value, i) => Math.abs(value - afterReverse[i]) < 0.06) &&
        atEnd([false, true, true, false]) && JSON.stringify(fillRect('.task-meta')) === JSON.stringify(savedMeta) &&
        JSON.stringify(fillRect('.task-subtask-progress')) === JSON.stringify(savedBounds)`,
        `${theme}: rapid reversal uses the current fill, retains an active transition on redraw, and keeps metadata fixed`);

      await evaluate(`endFill([false, true, false, true])`);
      await evaluate(`
        mark([true, true, true, true]);
        waitFor(() => fractions()[0] > 0.25 && fractions()[0] < 0.75).then(() => {
          fillAnimations().forEach(animation => animation.pause());
        });
      `);
      const intermediate = await evaluate("fractions()");
      assert.ok(intermediate[0] > 0 && intermediate[0] < 1);
      log(`${theme} screenshot fractions: ${JSON.stringify(intermediate)}. Natural transition paused only for capture, then resumed.`);
      const suffix = theme === "dark" ? "" : "-light";
      await capture(`subtask-fill-mid-transition${suffix}.png`);
      await evaluate(`
        fillAnimations().forEach(animation => animation.play());
        waitFor(() => atEnd([true, true, true, true]) && fillAnimations().length === 0);
      `);
      await capture(`subtask-fill-complete${suffix}.png`);
      await verify(`(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        fillCard().append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const row = fillRow().getBoundingClientRect();
        const bars = fillBars().map(bar => bar.getBoundingClientRect());
        return atEnd([true, true, true, true]) && fillBars().every((bar, i) =>
          fillStyle(bar).backgroundColor === accent && fillStyle(bar).transformOrigin.startsWith('0px') &&
          bars[i].top === row.top && bars[i].height === 6 &&
          (i === 0 || bars[i].left > bars[i - 1].right)) &&
          fillRow().getAttribute('aria-hidden') === 'true' && fillCard().getAttribute('aria-description').endsWith('4/4') &&
          !findCard('T-0223').querySelector('.task-subtask-progress');
      })()`, `${theme}: active accent, left origin, one 6px row and accessible completed count`);
      const { result } = await cdp.sendCommand("Runtime.evaluate", { expression: "fillCard()" });
      const { nodes } = await cdp.sendCommand("Accessibility.getPartialAXTree", { objectId: result.objectId });
      await cdp.sendCommand("Runtime.releaseObject", { objectId: result.objectId });
      assert.equal(nodes[0].role.value, "button");
      assert.match(nodes[0].description.value, /4\/4$/);

      await motion("reduce");
      await evaluate("mark([false, true, false, true]); void 0");
      await verify(`atEnd([false, true, false, true]) && fillAnimations().length === 0 &&
        fillStyle(fillBars()[0]).transitionDuration === '0s'`, `${theme}: reduced motion immediately applies both directions`);
      await evaluate(`mark([true]); void 0`);
      await verify(`fillRow().children.length === 1 && atEnd([true]) && fillAnimations().length === 0`,
        `${theme}: changed subtask count shows the saved state`);
      await motion("no-preference");
      await evaluate(`mark([true, false, false, true]); settle()`);
      await verify(`atEnd([true, false, false, true]) && fillAnimations().length === 0`,
        `${theme}: a newly built row does not animate saved marks`);
      await evaluate(`mark([false, true, true, false]); waitFor(() => fractions()[1] > 0.1 && fractions()[1] < 0.9)`);
      await motion("reduce");
      await evaluate("settle()");
      log(`${theme} reduce during transition: ${JSON.stringify(await evaluate(`({
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        values: fractions(), transitions: fillAnimations().map(animation => ({
          state: animation.playState, time: animation.currentTime
        })), duration: fillStyle(fillBars()[1]).transitionDuration
      })`))}`);
      await verify(`atEnd([false, true, true, false]) && fillAnimations().length === 0`,
        `${theme}: enabling reduced motion during a transition snaps to the latest state`);
      await motion("no-preference");
    }
    log(`PASS: ${passed} scenario checks plus monotonic sample assertions and Chromium accessibility tree checks.`);
    log("Matrix: Windows runtime PASS. Linux/macOS runtime not run; renderer and CSS are shared. No platform paths, child processes, native windows or packaging changed.");
  } finally {
    await motion("");
    cdp.detach();
  }
}
