import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitSafeDirectoryEnvironment, isolatedWorktreesDirectory } from "../cli/git.ts";
import { codexThreadPattern } from "../cli/model.ts";
import type { RunActivity, Task } from "../cli/model.ts";
import { directory } from "../cli/storage.ts";
import { runActivity } from "./run-activity.ts";
import { boardAgentInstructions, boardCodexArgs, boardWorklog, worklogReminder, worklogTool } from "./board-agent-hooks.ts";
import { openBoardMcp } from "./board-mcp.ts";
import { checkWaitInstructions, checkWaitTool, executorToolTimeoutSeconds, waitForCheck } from "./check-wait.ts";
import { executorToolConfig, verifyExecutorTools } from "./provider-tools.ts";
import { callCli } from "./cli.ts";
import { bundled, entry } from "./cli.ts";
import { taskboardCliLaunch } from "./codex.ts";
import type { configuredCodex } from "./codex.ts";
import { codexRpc, turnControl } from "./codex-rpc.ts";
import type { AgentControl } from "./codex-rpc.ts";
import { CodexTokenUsage } from "./codex-token-usage.ts";
import type { TokenUsageReport } from "../cli/token-usage.ts";
import { insideProject } from "./project-files.ts";

type Client = NonNullable<Awaited<ReturnType<typeof configuredCodex>>>;
type Turn = { id: string; status: string; error?: { message?: string } | null };
type RunFailure = { reason: string; disconnected?: boolean; interrupted?: boolean };
type Run = AgentControl & { threadId: string; completion: Promise<RunFailure | undefined> };
const profile = "ai-taskboard";
const instructions = new URL("./agent-instructions/", import.meta.url);

function executorInstructions() {
  const readInstructions = (name: string) => readFileSync(new URL(name + ".md", instructions), "utf8").trim();
  return boardAgentInstructions("executor", [
    "AI Taskboard has already started this card and assigned its working directory. Read the current card, then work in that directory. Pass --project with the board root in every CLI invocation.",
    "If a provider MCP tool is missing, use task_tool_request with server, tool and a reason. The request is bound to this task. The manager discovers tools with provider_tools and saves an assignment with task_tool_grant. Assignments apply on the next task run, including a resumed chat; finish the current pass with progress before restarting. Do not claim hot connection or successful authorization from a saved assignment.",
    checkWaitInstructions,
    readInstructions("executor").replace("__AI_TASKBOARD_CLI__", () => JSON.stringify(taskboardCliLaunch(bundled, entry))),
    readInstructions("task-writing"),
  ].join("\n\n"));
}

function gitAccessPaths(cwd: string, branch: string): string[] {
  const resolveGitPath = (...args: string[]) =>
    realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", ...args]).trim());
  const common = resolveGitPath("--git-common-dir");
  const refs = branch.split("/");
  return [
    resolveGitPath("--git-dir"),
    join(common, "objects"), dirname(join(common, ...refs)),
    dirname(join(common, "logs", ...refs)), join(common, "reftable"),
  ].filter(existsSync);
}

const verifyWrite = [
  "const fs = require('node:fs'), path = require('node:path');",
  "for (const root of process.argv.slice(1)) {",
  "  const dir = fs.mkdtempSync(path.join(root, '.taskboard-access-'));",
  "  const probe = path.join(dir, 'probe');",
  "  try { fs.writeFileSync(probe, '0'); fs.writeFileSync(probe, '1'); }",
  "  finally { try { fs.unlinkSync(probe); } finally { fs.rmdirSync(dir); } }",
  "}",
].join("\n");

export type ExecutorTask = Pick<Task, "id" | "title" | "description" | "criteria" | "execution" | "git" | "codexThreadId" | "workingDirectory" | "schedule" | "toolGrants"> &
  { feedback?: string };

export function missingCodexThread(message: string | undefined, threadId: string | undefined) {
  return Boolean(threadId && message === "no rollout found for thread id " + threadId);
}

export async function startCodexRun(client: Client, project: string, cwd: string, task: ExecutorTask,
  onActivity?: (item: RunActivity) => void, onTokenUsage?: (report: TokenUsageReport) => Promise<void>, signal?: AbortSignal,
  beforeTurn?: (threadId: string) => Promise<void>): Promise<Run> {
  signal?.throwIfAborted();
  if (!task.git && !task.workingDirectory) throw new Error("The task has no prepared working directory.");
  const runDirectory = realpathSync(cwd);
  if (task.workingDirectory && runDirectory !== task.workingDirectory) {
    throw new Error("The task's working directory now points somewhere else.");
  }
  const boardData = realpathSync(join(project, ".tasks"));
  const paths = [...new Set([runDirectory, boardData, ...(task.git ? gitAccessPaths(cwd, task.git.branch) : [])])];
  const developerInstructions = executorInstructions();
  const worklog = boardWorklog(project, "executor", task.id);
  const readOnlyWorktrees = [join(boardData, "worktrees")];
  const isolatedRoot = join(dirname(boardData), isolatedWorktreesDirectory);
  if (insideProject(runDirectory, isolatedRoot)) {
    if (runDirectory === isolatedRoot) throw new Error("Choose an individual worktree, not the shared worktree directory.");
    directory(isolatedRoot, true);
    readOnlyWorktrees.push(isolatedRoot);
  }
  const requestTool = { name: "task_tool_request", description: "Request a missing provider MCP tool for this task. The manager receives a question. Assignment requires a restarted task run; provider permissions still apply.",
    inputSchema: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" }, reason: { type: "string" } }, required: ["server", "tool", "reason"], additionalProperties: false } };
  const mcp = await openBoardMcp([worklogTool, checkWaitTool, requestTool], async (name, args, requestSignal) => name === requestTool.name
    ? worklog.remind(await callCli(project, ["tool-request", task.id, "--compact"], args))
    : name === checkWaitTool.name
    ? worklog.remind(await waitForCheck(runDirectory, args, signal ? AbortSignal.any([signal, requestSignal]) : requestSignal))
    : worklog.submit(args), executorToolTimeoutSeconds);
  let child: ChildProcessWithoutNullStreams;
  let runTemp: string | undefined;
  const removeRunTemp = async () => {
    if (runTemp) await rm(runTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(error => console.warn("Could not remove the executor's temporary directory.", runTemp, error.message));
  };
  try {
    signal?.throwIfAborted();
    const env = { ...(client.env ?? process.env), ...mcp.env };
    if (process.platform === "win32") {
      runTemp = mkdtempSync(join(realpathSync(tmpdir()), "ai-taskboard-executor-temp-"));
      paths.push(runTemp);
      Object.assign(env, { TEMP: runTemp, TMP: runTemp, TMPDIR: runTemp });
    }
    const filesystem = [
      '":root" = "read"',
      ...paths.map(path => JSON.stringify(path) + ' = "write"'),
      ...readOnlyWorktrees.map(path => JSON.stringify(path) + ' = "read"'),
    ].join(", ");
    const runEnv = process.platform === "win32" && client.windowsSandbox === "elevated"
      ? gitSafeDirectoryEnvironment(env, dirname(boardData), ...(task.git ? [runDirectory] : []))
      : env;
    child = spawn(client.path, [
      ...client.args, ...boardCodexArgs, "-c", mcp.config,
      "-c", 'web_search="live"',
      "--disable", "network_proxy",
      "-c", "permissions." + profile + "={filesystem={" + filesystem + "},network={enabled=true}}",
      "-c", "default_permissions=" + JSON.stringify(profile),
      ...(process.platform === "win32" ? ["--disable", "prefer_mxc", "-c", "windows.sandbox=" + JSON.stringify(client.windowsSandbox ?? "mxc")] : []),
    ], { cwd: project, env: runEnv, windowsHide: true, stdio: "pipe" });
  } catch (error) {
    try { await mcp.close(); } finally { await removeRunTemp(); }
    throw error;
  }
  const exited = new Promise<void>(resolve => child.once("close", resolve));
  const turns = new Map<string, Turn>();
  const activity = new Map<string, RunActivity>();
  const tokens = new CodexTokenUsage();
  let activeThreadId: string | undefined;
  let control: AgentControl | undefined;
  let interruptTimeout: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    rpc.fail(new Error("Codex did not start the task in time."));
    child.kill();
    rpc.close();
  }, 60_000);
  const close = async () => {
    clearTimeout(timeout);
    clearTimeout(interruptTimeout);
    signal?.removeEventListener("abort", interrupt);
    rpc.close();
    child.stdin.end();
    child.kill();
    await exited;
    try { await mcp.close(); } finally { await removeRunTemp(); }
  };
  child.stderr.resume();
  const rpc = codexRpc(child, message => {
    tokens.queue(tokens.observe(message), onTokenUsage);
    const params = message.params as { threadId?: string; turn: Turn };
    if (activeThreadId && params?.threadId === activeThreadId) {
      worklog.observe(message, activeThreadId);
      if (onActivity && message.method?.startsWith("item/")) {
        const item = runActivity(activity, message.method, params, new Date().toISOString());
        if (item) {
          activity.set(item.id, item);
          onActivity(item);
        }
      }
      if (message.method === "turn/completed") turns.set(params.turn.id, params.turn);
    }
  });
  const { request, send } = rpc;
  function interrupt() {
    const reason = signal?.reason instanceof Error ? signal.reason : new Error("The task run was interrupted.");
    if (control) void control.interrupt().catch(error => { rpc.fail(error); child.kill(); });
    else { rpc.fail(reason); child.kill(); }
    interruptTimeout = setTimeout(() => { rpc.fail(reason); child.kill(); }, 5000);
  }
  signal?.addEventListener("abort", interrupt, { once: true });
  async function monitor(turnId: string) {
    let failure: RunFailure | undefined;
    try {
      while (!turns.has(turnId)) await rpc.receive();
      const turn = turns.get(turnId)!;
      if (turn.status !== "completed") failure = {
        reason: turn.error?.message || "Codex ended the task run: " + turn.status + ".",
        ...(turn.status === "interrupted" ? { interrupted: true } : {}),
      };
    } catch (error) {
      const message = (error as Error).message;
      failure = {
        reason: message,
        disconnected: !signal?.aborted && message === "The Codex process closed.",
      };
    } finally {
      worklog.finish();
      await close();
      await tokens.save(tokens.finish(Boolean(failure)), onTokenUsage);
    }
    if (failure && signal?.aborted) return { reason: signal.reason instanceof Error
      ? signal.reason.message : "The task run was interrupted." };
    return failure;
  }

  try {
    await request("initialize", {
      clientInfo: { name: "ai_taskboard", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    try {
      const probe = await request<{ exitCode: number; stderr: string; stdout: string }>("command/exec", {
        cwd, permissionProfile: profile, timeoutMs: 15_000, env: { ELECTRON_RUN_AS_NODE: "1" },
        command: [process.execPath, "-e", verifyWrite, ...paths],
      });
      if (probe.exitCode !== 0) throw new Error((probe.stderr || probe.stdout).trim());
    } catch (error) {
      throw new Error("Codex cannot write to the directories required for this task. " + (error as Error).message);
    }
    let existing = task.codexThreadId;
    type ThreadReply = {
      thread: { id: string; model?: string }; model?: string; activePermissionProfile?: { id: string };
      approvalPolicy?: string; approvalsReviewer?: string;
    };
    const threadOptions = {
      cwd, model: task.execution?.model, permissions: profile,
      approvalPolicy: "on-request", approvalsReviewer: "auto_review", developerInstructions,
      config: await executorToolConfig(request, cwd, task.toolGrants),
    };
    let started: ThreadReply | undefined;
    if (existing) {
      try {
        started = await request<ThreadReply>("thread/resume", { ...threadOptions, threadId: existing });
      } catch (error) {
        if (!missingCodexThread((error as Error).message, existing)) throw error;
        signal?.throwIfAborted();
        existing = undefined;
      }
    }
    started ??= await request<ThreadReply>("thread/start", threadOptions);
    if (started.activePermissionProfile?.id !== profile) {
      throw new Error("Codex did not apply the write permissions for this task.");
    }
    if (started.approvalPolicy !== "on-request" || started.approvalsReviewer !== "auto_review") {
      throw new Error("Codex did not enable automatic approval review. Check the connected Codex version and its approval policy.");
    }
    const threadId = started.thread.id;
    await verifyExecutorTools(request, threadId, task.toolGrants);
    if (!codexThreadPattern.test(threadId) || (existing && threadId !== existing)) throw new Error("Codex returned an unexpected thread ID.");
    signal?.throwIfAborted();
    await beforeTurn?.(threadId);
    signal?.throwIfAborted();
    timeout.refresh();
    const prompt = [
      "Выполни задачу AI Taskboard " + task.id + " в назначенной рабочей папке.",
      "Корень доски: " + project,
      ...(task.workingDirectory ? [
        "Папка задачи: " + cwd,
        "У задачи нет отдельной ветки или worktree. Используй сценарий сдачи результата вне Git из инструкции.",
      ] : []),
      "Прочитай актуальную карточку через show " + task.id + " --compact.",
      "Для чтения истории используй show --compact с historyLimit. Повторно используй прочитанные изменения, если снимок совпадает.",
      "Команды, которые должен запускать читатель, оформляй отдельными блоками кода Markdown. Пояснения пиши отдельными абзацами.",
      task.schedule
        ? "Это очередной запуск повторяющейся задачи. Выполни один проход по текущим условиям и запиши результат через progress с summary и nextStep. Карточка вернётся в готовые до следующего запуска. Не используй submit. Если без посторонней помощи выполнить задачу нельзя, используй block."
        : "Заверши работу в карточке командой сдачи, записи прогресса, паузы или блокировки в AI Taskboard.",
      "После записи результата в карточку и перед итоговым ответом вызови mcp__ai_taskboard__worklog_record с языком и массивом entries. " +
        "Инструмент подключён к текущему ходу. Команды Worklog из истории относятся к прошлым ходам.",
      "Перед сдачей сопоставь каждый критерий с результатом в diff или проверке. Для изменённого поведения перечисли существенно разные условия, в которых действует один критерий, и проверь сочетания, где результат может различаться. Например, для изменений поставки это чистая и повторная сборка, сборка и публикация, настройки по умолчанию и переопределения. После возврата проверь другие затронутые сценарии того же критерия. Если проверка выполнена на более ранней ревизии, покажи, почему она ещё применима, либо повтори затронутую проверку.",
      "Если доступ отклонён, продолжай разрешённым способом. Если без доступа нельзя выполнить обязательный шаг, заблокируй задачу. В причине укажи шаг, нужный ресурс и причину отказа, в условии разблокировки — конкретное действие для продолжения.",
      "Рабочая папка: " + cwd,
      JSON.stringify({ title: task.title, description: task.description, criteria: task.criteria }),
      ...(task.feedback ? ["Замечание к последней сдаче: " + task.feedback] : []),
    ].join("\n");
    activeThreadId = threadId;
    tokens.track(threadId, started.model ?? started.thread.model ?? null, true);
    const { turn } = await request<{ turn: Turn }>("turn/start", {
      threadId, effort: task.execution?.effort, input: [{ type: "text", text: prompt, text_elements: [] }],
      additionalContext: { ai_taskboard_worklog: { value: worklogReminder, kind: "application" } },
    });
    worklog.start(threadId, turn.id);
    control = turnControl(request, threadId, turn.id);
    tokens.save(tokens.begin(threadId, turn.id), onTokenUsage);
    clearTimeout(timeout);
    if (turn.status !== "inProgress") turns.set(turn.id, turn);
    return { threadId, completion: monitor(turn.id), ...control };
  } catch (error) {
    worklog.finish();
    await close();
    await tokens.save(tokens.finish(true), onTokenUsage);
    if (error instanceof Error && /already has an active writer/i.test(error.message)) {
      throw Object.assign(error, { code: "CODEX_THREAD_BUSY" });
    }
    throw error;
  }
}
