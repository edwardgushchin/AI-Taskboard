import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeEntries } from "../src/desktop/board-runtime.ts";
import { plannedDraft } from "../tests/fixtures/planned-draft.ts";
import { electronCheck } from "./electron-check.mjs";

const { scratch, artifacts } = electronCheck(import.meta.url, "manager-recovery", 110_000, [
  ["--first"], ["--restart"],
]);
const { app, BrowserWindow } = await import("electron");
const require = createRequire(import.meta.url);
const node = process.env.TASKBOARD_CHECK_NODE;
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const project = join(scratch, "T-0352-board");
const other = join(scratch, "other-board");
const profile = join(scratch, "profile");
const transcript = join(scratch, "provider.jsonl");
const fake = join(scratch, "provider.cjs");
const first = process.argv.includes("--first");
const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).trim();
const timeout = "Codex did not respond in time.";
const capacity = "Selected model is at capacity. Please try a different model.";
const messages = {
  overload: "Создай карточку для проверки очереди",
  restore: "Подведи итог проверки очереди",
  denied: "Смоделируй окончательный отказ",
  drop: "Смоделируй тишину после принятия",
  delayed: "Ответь с задержкой",
  stop: "Дождись команды остановки",
  next: "Ответь на следующее сообщение",
  legacy: "Проверь план по T-0001",
  cache: "Проверь оптимизацию кэша",
};
const title = "Проверка очереди";
const draft = plannedDraft({
  title, description: "Карточка для проверки повторного действия.", criteria: ["Создана одна карточка."],
  tags: ["проверка"],
});
const success = "Ход проверен и завершён.";
const restored = "Сохранённый итог провайдера.";
const reconciled = "Текущее состояние подтверждено. Продолжение подготовлено.";
const rejected = "Провайдер окончательно отклонил запрос.";

function cli(root, args, input) {
  const reply = JSON.parse(execFileSync(node, [cliPath, "--project", root, "--json", ...args], {
    encoding: "utf8", windowsHide: true, timeout: 15_000, input: input && JSON.stringify(input),
  }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}

function provider() {
  const { appendFileSync, existsSync, readFileSync } = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const { spawnSync } = require("node:child_process");
  const { createInterface } = require("node:readline");
  const [log, inputs, ...flags] = process.argv.slice(2);
  const { messages, draft, success, restored, reconciled, rejected, capacity } = JSON.parse(inputs);
  let threadId, turnId, clientId, interruptTimer, mutation, prompt;
  const send = event => console.log(JSON.stringify(event));
  const record = (event, details = {}) => appendFileSync(log, JSON.stringify({
    event, threadId, turnId, clientId, prompt, pid: process.pid, ...details,
  }) + "\n");
  const history = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  const notice = (method, params) => send({ method, params: { threadId, turnId, ...params } });
  const done = (status, error) => {
    clearTimeout(interruptTimer);
    notice("turn/completed", { turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } });
  };
  const final = text => notice("item/completed", {
    item: { type: "agentMessage", phase: "final_answer", id: randomUUID(), text },
  });
  const activity = () => {
    notice("item/completed", { item: {
      type: "agentMessage", phase: "commentary", id: randomUUID(), text: "Сверяю состояние очереди.",
    } });
    notice("item/completed", { item: {
      type: "mcpToolCall", id: randomUUID(), server: "ai_taskboard", tool: "expert_list",
      status: "completed", arguments: {}, result: { content: [] },
    } });
  };
  async function reply(line) {
    const { id, method, params, result: rpcResult } = JSON.parse(line);
    if (id === 951 && method === undefined) {
      record("mutation", { result: rpcResult, safe: mutation === "safe" });
      if (mutation === "safe") {
        final(reconciled);
        done("completed");
      }
      return;
    }
    if (id === undefined) return;
    let result = {};
    if (method === "command/exec") {
      const [exe, ...args] = params.command;
      const check = spawnSync(exe, args, { cwd: params.cwd, encoding: "utf8",
        windowsHide: true, env: { ...process.env, ...params.env } });
      result = { exitCode: check.status, stdout: check.stdout, stderr: check.stderr };
    } else if (method === "thread/start" || method === "thread/resume") {
      threadId = params.threadId ?? randomUUID();
      record(method, { sandbox: params.sandbox, approvalPolicy: params.approvalPolicy });
      result = { thread: { id: threadId }, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, activePermissionProfile: { id: params.permissions } };
    } else if (method === "config/read") {
      result = { config: { mcp_servers: { ai_taskboard: { url: "http://127.0.0.1/mcp" } } } };
    } else if (method === "model/list") {
      result = { data: [{ id: "gpt-6.2-sol", model: "gpt-6.2-sol", isDefault: true,
        defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null };
    } else if (method === "mcpServerStatus/list") {
      const flag = flags.find(value => value.includes("ai_taskboard") && value.includes("http"));
      const response = await fetch(flag.match(/http[^"]+/)[0], {
        method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const { tools } = (await response.json()).result;
      result = { data: [{ name: "ai_taskboard", tools: Object.fromEntries(tools.map(tool => [tool.name, tool])) }] };
    } else if (method === "thread/turns/list") {
      threadId = params.threadId;
      record(method);
      result = { data: history().filter(event => event.event === "turn/start" && event.threadId === threadId)
        .toReversed().map(turn => ({ id: turn.turnId, status: turn.prompt === messages.restore ? "completed" : "interrupted",
          completedAt: Date.now(), itemsView: "full", items: [
            { type: "userMessage", clientId: turn.clientId },
            ...(turn.prompt === messages.restore ? [{ type: "agentMessage", phase: "final_answer", text: restored }] : []),
          ] })) };
    } else if (method === "turn/start") {
      prompt = params.input[0].text;
      const attempt = history().filter(event => event.event === method && event.prompt === prompt).length + 1;
      turnId = randomUUID();
      clientId = params.clientUserMessageId;
      record(method, { attempt, sandbox: params.sandboxPolicy?.type });
      send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (prompt === messages.overload) {
        activity();
        mutation = attempt === 1 ? "original" : "safe";
        send({ id: 951, method: "item/tool/call", params: { threadId, turnId, callId: randomUUID(), tool: "task_create",
          arguments: draft } });
        if (attempt === 1) {
          notice("error", { willRetry: true, error: { message: capacity } });
          interruptTimer = setTimeout(() => {
            final(success);
            done("completed");
          }, 4200);
        }
      } else if (prompt === messages.restore) {
        activity();
        setTimeout(() => process.exit(0), 500);
      } else if (prompt === messages.denied) {
        activity();
        done("failed", rejected);
      } else if (prompt === messages.delayed) {
        notice("error", { willRetry: true, error: { message: capacity } });
        setTimeout(() => {
          final(success);
          done("completed");
        }, 1200);
      } else if (prompt === messages.stop || prompt === messages.drop) {
        activity();
      } else {
        final(reconciled);
        done("completed");
      }
      return;
    } else if (method === "turn/interrupt") {
      record(method);
      send({ id, result });
      done("interrupted");
      return;
    }
    send({ id, result });
  }
  createInterface({ input: process.stdin }).on("line", line => {
    void reply(line).catch(error => {
      record("fixture-error", { error: error.message });
      process.exitCode = 1;
      process.stdin.destroy();
    });
  });
}

if (first) {
  mkdirSync(profile);
  for (const root of [project, other]) {
    mkdirSync(root);
    cli(root, ["init"]);
    cli(root, ["settings", "--stdin"], { autoMode: false });
  }
  writeFileSync(join(profile, "appearance.json"), JSON.stringify({ language: "ru" }));
  writeFileSync(fake, "(" + provider.toString() + ")();\n");
}

app.setPath("appData", scratch);
app.setPath("userData", profile);
app.disableHardwareAcceleration();
app.requestSingleInstanceLock = () => true;
globalThis.managerRecoveryClient = {
  path: node, args: [fake, transcript, JSON.stringify({ messages, draft, success, restored, reconciled, rejected, capacity })],
  windowsSandbox: "mxc",
};

function instrument(name, transform) {
  const source = new URL("../src/desktop/" + name + ".ts", import.meta.url);
  const code = transform(readFileSync(source, "utf8"))
    .replaceAll("import.meta.url", JSON.stringify(source.href))
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_, path) => "from " + JSON.stringify(new URL(path, source).href));
  const output = join(scratch, name + ".mjs");
  writeFileSync(output, require("esbuild").transformSync(code, { loader: "ts", format: "esm" }).code);
  return output;
}

const chat = instrument("codex-chat", code => {
  assert.ok(code.includes("const idleTimeoutMs = 180_000;"));
  return code.replace("configuredCodex, executorFullAccess", "executorFullAccess")
    .replace("const idleTimeoutMs = 180_000;", "const idleTimeoutMs = 2800;")
    .concat("\nconst configuredCodex = async () => globalThis.managerRecoveryClient;");
});
const entry = instrument("main", code => code
  .replace("codexStatus, configuredCodex,", "codexStatus,")
  .replace("providerLimitSource, readCodexLimits,", "providerLimitSource,")
  .replaceAll('"./codex-chat.ts"', JSON.stringify(pathToFileURL(chat).href))
  .concat(`
const configuredCodex = async () => globalThis.managerRecoveryClient;
const readCodexLimits = async () => ({ provider: "Codex", state: "unknown", windows: [] });
globalThis.managerRecoveryCheck = { createWindow };
`));
process.argv.push("--project", project);
require(entry);

const evaluate = (window, expression) => window.webContents.executeJavaScript(expression);
const api = (window, method, ...args) => evaluate(window, "window.taskboard." + method + "(..." + JSON.stringify(args) + ")");
const logSelector = "#board-draft .board-chat-log:not(.board-work)";
const history = window => api(window, "boardHistory", project, null, "chat");
const snapshot = () => existsSync(transcript) ? readFileSync(transcript, "utf8").trim().split("\n").map(JSON.parse) : [];
const starts = prompt => snapshot().filter(event => event.event === "turn/start" && event.prompt === prompt);
const text = window => evaluate(window, `document.querySelector(${JSON.stringify(logSelector)})?.innerText ?? ""`);
const contains = async (window, ...lines) => {
  const current = await text(window);
  return lines.every(line => current.includes(line));
};
async function until(read, description, duration = 15_000) {
  const started = Date.now();
  while (Date.now() - started < duration) {
    const value = await read();
    if (value) return value;
    await wait(50);
  }
  throw new Error("Timed out: " + description + "\n" + JSON.stringify(snapshot().slice(-8)));
}
async function pin(window) {
  await until(() => evaluate(window, "Boolean(document.querySelector('#board-draft textarea'))"), "manager composer");
  await evaluate(window, "document.querySelector('#board-draft:not([data-pinned]) .board-chat-pin')?.click()");
  await until(() => evaluate(window, "Boolean(document.querySelector('#board-draft[data-pinned]'))"), "pinned dialogue");
}
async function prepare(window) {
  window.setContentSize(1280, 800);
  window.webContents.setZoomFactor(1);
  await until(async () => (await api(window, "bootstrap"))?.board?.project === project, "board loaded");
  await pin(window);
}
async function send(window, prompt) {
  await evaluate(window, `(() => {
    const form = document.querySelector("#board-draft");
    const input = form.querySelector("textarea[name=request]");
    input.value = ${JSON.stringify(prompt)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
  })()`);
}
async function clickRecovery(window) {
  return evaluate(window, `(() => {
    const controls = [...document.querySelectorAll(".manager-recovery button")].filter(button => !button.disabled);
    const button = controls.at(-1);
    button?.click();
    return Boolean(button);
  })()`);
}
async function capture(window, name) {
  window.show();
  await evaluate(window, `document.querySelector(${JSON.stringify(logSelector)}).scrollTo(0, 1000000)`);
  await wait(120);
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
  writeFileSync(join(artifacts, name + ".png"), image.toPNG());
}
const settled = () => !runtimeEntries(project).some(entry => entry.task === "manager:dialogue");
function providerExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return true;
  }
}
function released() {
  if (!settled()) return false;
  const livePids = [...new Set(snapshot().map(event => event.pid))].filter(pid => !providerExited(pid));
  if (!livePids.length) return true;
  if (process.platform !== "win32") return false;
  // Once an App Server has exited, Windows can reuse its PID for another process.
  const filter = livePids.map(pid => "ProcessId = " + pid).join(" OR ");
  const liveFixturePids = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object {
      $_.CommandLine -and $_.CommandLine.Contains($env:TASKBOARD_CHECK_PROVIDER_PATH)
    } | ForEach-Object { $_.ProcessId }`,
  ], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, TASKBOARD_CHECK_PROVIDER_PATH: fake },
  }).trim();
  return !liveFixturePids;
}
const outcomes = async window => (await history(window)).data.turns;
const replyCount = (turns, prompt) => turns.filter(turn => turn.messages.some(message => message.text === prompt))
  .flatMap(turn => turn.items.filter(item => item.phase === "final_answer" && item.status === "completed"));

void app.whenReady().then(async () => {
  console.log(first ? "Manager recovery: live check." : "Manager recovery: restart check.");
  const window = await until(() => BrowserWindow.getAllWindows()[0], "first window");
  await prepare(window);
  if (first) {
    const twin = globalThis.managerRecoveryCheck.createWindow([project, other], project).window;
    await prepare(twin);
    await send(window, messages.overload);
    await until(() => starts(messages.overload).length === 1, "first provider attempt");
    await until(() => contains(window, "Сверяю состояние очереди."), "live commentary");
    assert.equal(await contains(window, "Восстановить ответ"), false);
    await capture(window, "waiting");
    await until(() => contains(window, timeout, capacity, "Восстановить ответ"), "persisted timeout in original window");
    await until(() => contains(twin, timeout, capacity, "Восстановить ответ"), "same timeout in second window");
    assert.equal(await contains(window, "Выполнено"), false);
    assert.equal(cli(project, ["list", "--compact"]).tasks.filter(task => task.title === title).length, 1, JSON.stringify(snapshot().slice(-5)));
    await capture(window, "interrupted");
    await api(twin, "selectTab", other);
    await until(async () => (await api(twin, "bootstrap")).board?.project === other, "other board selected");
    await api(twin, "selectTab", project);
    await until(async () => (await api(twin, "bootstrap")).board?.project === project, "original board selected");
    await pin(twin);
    await until(() => contains(twin, timeout, capacity), "timeout after board switch");
    await Promise.all([clickRecovery(window), clickRecovery(twin)]);
    await until(async () => settled() && await contains(window, reconciled), "recovered reply");
    await until(() => contains(twin, reconciled), "same recovered reply in second window");
    const turns = await outcomes(window);
    assert.equal(turns.flatMap(turn => turn.messages).filter(message => message.text === messages.overload).length, 1);
    assert.equal(replyCount(turns, messages.overload).length, 1);
    assert.equal(starts(messages.overload).length, 2);
    assert.equal(starts(messages.overload)[1].sandbox, "readOnly");
    // The provider can disconnect before it reads the result of the original mutation.
    // The card count above confirms that mutation committed before recovery began.
    const recoveryMutations = snapshot().filter(event => event.event === "mutation" && event.safe);
    assert.equal(recoveryMutations.length, 1);
    assert.equal(recoveryMutations[0].result?.success, false);
    assert.equal(cli(project, ["list", "--compact"]).tasks.filter(task => task.title === title).length, 1);
    await capture(window, "recovered");
    await until(released, "providers and writer released after timeout and recovery");
    console.log("Manager recovery: both windows, switch and protected recovery passed.");
    await send(window, messages.restore);
    await until(async () => settled() && await contains(window, restored), "saved answer recovered after transport loss");
    assert.equal(starts(messages.restore).length, 1);
    assert.equal(replyCount(await outcomes(window), messages.restore).length, 1);
    await until(released, "providers and writer released after provider history lookup");
    console.log("Manager recovery: provider history restored.");
    await send(window, messages.delayed);
    await until(() => starts(messages.delayed).length === 1, "delayed provider turn");
    await wait(300);
    const delayed = (await outcomes(window)).find(turn => turn.messages.some(message => message.text === messages.delayed));
    assert.equal(delayed?.outcome?.status, "running");
    await until(async () => settled() && await contains(window, success), "provider recovered before timeout");
    await send(window, messages.stop);
    await until(() => evaluate(window, `document.querySelector("#board-draft .chat-send")?.ariaLabel?.includes("Остановить") && !document.querySelector("#board-draft .chat-send").disabled`), "stop button enabled");
    await evaluate(window, 'document.querySelector("#board-draft .chat-send").click()');
    await until(async () => settled() && snapshot().some(event => event.event === "turn/interrupt"), "interrupted by user");
    await until(released, "providers and writer released after stop");
    await send(window, messages.denied);
    await until(async () => settled() && await contains(window, rejected), "provider rejected");
    await send(window, messages.drop);
    await until(async () => settled() && await contains(window, messages.drop, timeout), "plain connection timeout");
    await send(window, messages.next);
    await until(async () => settled() && replyCount(await outcomes(window), messages.next).length === 1, "next ordinary request");
    const turnsBeforeRestart = await outcomes(window);
    const drop = turnsBeforeRestart.find(turn => turn.messages.some(message => message.text === messages.drop));
    assert.equal(drop.outcome.status, "interrupted");
    assert.ok(drop.outcome.reason.includes(timeout));
    assert.ok(!drop.outcome.reason.includes(capacity));
    await until(released, "providers and writer released after next request");
    const folder = join(project, ".tasks", "manager-chat");
    const legacyExamples = [
      [1, messages.legacy, "2026-11-23T20:27:00+03:00", 180000],
      [2, messages.legacy, "2026-11-23T20:30:00+03:00", 355000],
      [3, messages.cache, "2026-11-24T00:24:00+03:00", 231153],
    ];
    for (const [offset, prompt, at, durationMs] of legacyExamples) {
      const items = offset === 2 ? [{
        id: randomUUID(), type: "mcpToolCall", title: "ai_taskboard / expert_list", status: "completed", text: "",
      }] : [];
      writeFileSync(join(folder, `${Date.now() + 100 * offset}-${randomUUID()}.json`), JSON.stringify({
        lane: "chat", message: { text: prompt, files: [], at }, items, durationMs,
      }));
    }
  } else {
    await until(() => contains(window, restored, timeout, messages.cache), "restored transcript after Electron restart");
    const turns = await outcomes(window);
    assert.equal(replyCount(turns, messages.restore).length, 1);
    const legacy = turns.filter(turn => turn.messages.some(message => [messages.legacy, messages.cache].includes(message.text)));
    assert.equal(legacy.length, 3);
    assert.ok(legacy.every(turn => turn.recovery && !turn.outcome?.reason));
    assert.ok(await contains(window, "Итог хода не подтверждён."));
    for (const [index, turn] of legacy.entries()) {
      const id = turn.recovery;
      const result = await api(window, "boardQueue", project, "recover", undefined, id);
      assert.ok(result.ok, JSON.stringify(result));
      await until(async () => settled() && !(await outcomes(window)).some(row => row.recovery === id), "legacy recovery " + index);
    }
    assert.equal(starts(messages.legacy).length, 2);
    assert.equal(starts(messages.cache).length, 1);
    const recoveredLegacy = await outcomes(window);
    assert.equal(replyCount(recoveredLegacy, messages.legacy).length, 2);
    assert.equal(replyCount(recoveredLegacy, messages.cache).length, 1);
    await until(released, "providers and writer released after legacy recovery");
    assert.equal(cli(project, ["list", "--compact"]).tasks.filter(task => task.title === title).length, 1);
    const paths = [
      "scripts/check-manager-recovery.mjs", "scripts/electron-check.mjs", "tests/fixtures/planned-draft.ts",
      "src/desktop/main.ts", "src/desktop/codex-chat.ts",
      "src/desktop/manager-history.ts", "src/desktop/renderer.js", "src/desktop/chat.js", "src/desktop/styles.css",
      "src/desktop/locales/en.json", "src/desktop/locales/ru.json",
    ];
    const digest = path => createHash("sha256").update(readFileSync(new URL("../" + path, import.meta.url))).digest("hex");
    writeFileSync(join(artifacts, "report.md"), [
      "# Восстановление ответа менеджера",
      "",
      `Windows ${process.arch}, Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}.`,
      `База рабочей копии \`${base}\`. Непосредственно проверенные исходники ниже (SHA-256 рабочих файлов, сырые байты).`,
      "",
      "Команда",
      "",
      "\`\`\`powershell",
      "node scripts/check-manager-recovery.mjs --artifacts .tasks/qa/manager-recovery",
      "\`\`\`",
      "",
      "- Два окна показали одно и то же прерывание после сообщений о перегрузке. Ожидающий ход показывал промежуточное сообщение и не предлагал восстановление.",
      "- Стенд воспроизводит интервал исходного сбоя в уменьшенном масштабе. Тайм-аут 2,8 с в копии исходника истекает раньше запланированного повтора через 4,2 с. Настройки модели сохранены.",
      "- Два одновременных нажатия запустили один сеанс восстановления. Запись сохранила одну реплику и один итог. После попытки повторить уже применённый вызов инструмента на доске осталась одна карточка.",
      "- Провайдер с сохранённым итогом разорвал соединение. Из его истории восстановился один ответ без нового запуска. Ответ сохранился после перезапуска Electron.",
      "- Проверены возобновившийся провайдер, окончательный отказ, отдельный тайм-аут без ошибки перегрузки, штатная кнопка остановки и обычное следующее сообщение.",
      "- После тайм-аута, восстановления и остановки проверено завершение процессов App Server и освобождение записи manager:dialogue.",
      "- После смены проекта причина тайм-аута осталась в ленте. Для двух синтетических старых реплик по T-0001 и старой реплики про оптимизацию кэша проверен повтор с точным исходным текстом и без выдуманной диагностики.",
      "- Linux и macOS не запускались. Стенд использует тот же JavaScript и IPC, но Windows-поведение окон и упакованная сборка на других ОС здесь не проверены.",
      "",
      ...paths.map(path => `- \`${digest(path)}\` \`${path}\``),
      "",
      ...readdirSync(artifacts).filter(name => name.endsWith(".png")).sort().map(name => `- [${name}](${name})`),
      "",
    ].join("\n"));
  }
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
