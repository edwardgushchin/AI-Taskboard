import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git } from "../cli/git.ts";
import { codexThreadPattern } from "../cli/model.ts";
import type { RunActivity, Task } from "../cli/model.ts";
import { runActivity } from "./run-activity.ts";
import { openBoardMcp } from "./board-mcp.ts";
import { checkWaitInstructions, checkWaitTool, executorToolTimeoutSeconds, waitForCheck } from "./check-wait.ts";
import type { configuredCodex } from "./codex.ts";
import { codexProject } from "./codex-project.ts";
import { codexRpc, turnControl } from "./codex-rpc.ts";
import type { AgentControl } from "./codex-rpc.ts";
import { CodexTokenUsage } from "./codex-token-usage.ts";
import type { TokenUsageReport } from "../cli/token-usage.ts";

type Client = NonNullable<Awaited<ReturnType<typeof configuredCodex>>>;
type Turn = { id: string; status: string; error?: { message?: string } | null };
type Run = AgentControl & { threadId: string; completion: Promise<string | undefined> };
const profile = "ai-taskboard";

function accessPaths(project: string, cwd: string, branch: string): string[] {
  const resolveGitPath = (...args: string[]) =>
    realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", ...args]).trim());
  const common = resolveGitPath("--git-common-dir");
  const refs = branch.split("/");
  return [
    realpathSync(cwd), realpathSync(join(project, ".tasks")), resolveGitPath("--git-dir"),
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

export async function startCodexRun(client: Client, project: string, cwd: string, task: Task,
  onActivity?: (item: RunActivity) => void, onTokenUsage?: (report: TokenUsageReport) => Promise<void>, signal?: AbortSignal): Promise<Run> {
  signal?.throwIfAborted();
  if (!task.git) throw new Error("The task has no prepared Git worktree.");
  const paths = [...new Set(accessPaths(project, cwd, task.git.branch))];
  const codexHome = (client.env ?? process.env).CODEX_HOME || join(homedir(), ".codex");
  const worklogSessions = resolve(project, codexHome, "plugins", "data", "codex-worklog-codex-worklog", "sessions-v2");
  const filesystem = [
    '":root" = "read"',
    ...paths.map(path => JSON.stringify(path) + ' = "write"'),
    JSON.stringify(worklogSessions) + ' = "write"',
    JSON.stringify(join(paths[1], "worktrees")) + ' = "read"',
  ].join(", ");
  const mcp = await openBoardMcp([checkWaitTool], (_name, args, requestSignal) =>
    waitForCheck(paths[0], args, signal ? AbortSignal.any([signal, requestSignal]) : requestSignal), executorToolTimeoutSeconds);
  let child: ChildProcessWithoutNullStreams;
  try {
    signal?.throwIfAborted();
    child = spawn(client.path, [
      ...client.args, "app-server", "-c", mcp.config,
      "-c", "permissions." + profile + "={filesystem={" + filesystem + "}}",
      "-c", "default_permissions=" + JSON.stringify(profile),
      ...(process.platform === "win32" ? ["-c", 'windows.sandbox="mxc"'] : []),
    ], { cwd: project, env: { ...(client.env ?? process.env), ...mcp.env }, windowsHide: true, stdio: "pipe" });
  } catch (error) {
    await mcp.close();
    throw error;
  }
  const exited = new Promise<void>(resolve => child.once("close", resolve));
  const turns = new Map<string, Turn>();
  const activity = new Map<string, RunActivity>();
  const tokens = new CodexTokenUsage();
  let activeThreadId: string | undefined;
  let control: AgentControl | undefined;
  let interruptTimeout: NodeJS.Timeout | undefined;
  let lastError = "";
  const timeout = setTimeout(() => {
    lastError = "Codex did not start the task in time.";
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
    await Promise.all([exited, mcp.close()]);
  };
  child.stderr.setEncoding("utf8").on("data", chunk => { lastError = (lastError + chunk).slice(-1500); });
  const rpc = codexRpc(child, message => {
    tokens.queue(tokens.observe(message), onTokenUsage);
    const params = message.params as { threadId?: string; turn: Turn };
    if (activeThreadId && params?.threadId === activeThreadId) {
      if (onActivity && message.method?.startsWith("item/")) {
        const item = runActivity(activity, message.method, params);
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
    lastError = signal?.reason instanceof Error ? signal.reason.message : "The task run was interrupted.";
    if (control) void control.interrupt().catch(error => { rpc.fail(error); child.kill(); });
    else { rpc.fail(new Error(lastError)); child.kill(); }
    interruptTimeout = setTimeout(() => { rpc.fail(new Error(lastError)); child.kill(); }, 5000);
  }
  signal?.addEventListener("abort", interrupt, { once: true });
  async function monitor(turnId: string) {
    let failure: string | undefined;
    try {
      while (!turns.has(turnId)) await rpc.receive();
      const turn = turns.get(turnId)!;
      if (turn.status !== "completed") failure = signal?.aborted ? lastError
        : turn.error?.message || "Codex ended the task run: " + turn.status + ".";
    } catch (error) {
      failure = lastError.trim() || (error as Error).message;
    } finally {
      await tokens.save(tokens.finish(Boolean(failure)), onTokenUsage);
      await close();
    }
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
      throw new Error("Codex cannot write to the task worktree, board or Git directories. " + (error as Error).message);
    }
    const existing = task.codexThreadId;
    const projectId = existing ? undefined : await codexProject(request, project).catch(error => {
      throw new Error("Codex could not open or create the project for this board. " + (error as Error).message);
    });
    const started = await request<{
      thread: { id: string; projectId: string | null; model?: string }; model?: string; activePermissionProfile?: { id: string };
      approvalPolicy?: string; approvalsReviewer?: string;
    }>(existing ? "thread/resume" : "thread/start", {
      cwd, projectId, threadId: existing, model: task.execution?.model, permissions: profile,
      approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    });
    if (projectId && started.thread.projectId !== projectId) {
      throw new Error("Codex did not attach the task chat to the board project.");
    }
    if (started.activePermissionProfile?.id !== profile) {
      throw new Error("Codex did not apply the write permissions for this task.");
    }
    if (started.approvalPolicy !== "on-request" || started.approvalsReviewer !== "auto_review") {
      throw new Error("Codex did not enable automatic approval review. Check the connected Codex version and its approval policy.");
    }
    const threadId = started.thread.id;
    if (!codexThreadPattern.test(threadId) || (existing && threadId !== existing)) throw new Error("Codex returned an unexpected thread ID.");
    const feedback = task.history.findLast(event => event.action === "request-changes")?.text;
    const prompt = [
      checkWaitInstructions,
      "Выполни задачу AI Taskboard " + task.id + " в подготовленной рабочей копии.",
      "Корень доски: " + project,
      "Используй навык ai-taskboard:work-task и прочитай актуальную карточку по номеру.",
      "Заверши проход командой сдачи, записи прогресса, паузы или блокировки в AI Taskboard.",
      'Если работа выполнена вне Git и preview вернул пустой diff, передай в submit токен preview, noChanges: true, итог и результаты проверок без поля message.',
      "Если доступ отклонён, продолжай разрешённым способом. Если без доступа нельзя выполнить обязательный шаг, заблокируй задачу. В причине укажи шаг, нужный ресурс и причину отказа, в условии разблокировки — конкретное действие для продолжения.",
      "Рабочая копия: " + cwd,
      JSON.stringify({ title: task.title, description: task.description, criteria: task.criteria }),
      ...(feedback ? ["Замечание к последней сдаче: " + feedback] : []),
    ].join("\n");
    activeThreadId = threadId;
    tokens.track(threadId, started.model ?? started.thread.model ?? null, true);
    const { turn } = await request<{ turn: Turn }>("turn/start", {
      threadId, effort: task.execution?.effort, input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    control = turnControl(request, threadId, turn.id);
    tokens.save(tokens.begin(threadId, turn.id), onTokenUsage);
    clearTimeout(timeout);
    if (turn.status !== "inProgress") turns.set(turn.id, turn);
    return { threadId, completion: monitor(turn.id), ...control };
  } catch (error) {
    await close();
    await tokens.save(tokens.finish(true), onTokenUsage);
    if (error instanceof Error && /already has an active writer/i.test(error.message)) {
      throw Object.assign(error, { code: "CODEX_THREAD_BUSY" });
    }
    throw error;
  }
}
