import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { git } from "../cli/git.ts";
import { codexThreadPattern } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";
import type { configuredCodex } from "./codex.ts";
import { codexProject } from "./codex-project.ts";

type Client = NonNullable<Awaited<ReturnType<typeof configuredCodex>>>;
type Turn = { id: string; status: string; error?: { message?: string } | null };
type Run = { threadId: string; completion: Promise<string | undefined> };
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

export async function startCodexRun(client: Client, project: string, cwd: string, task: Task): Promise<Run> {
  if (!task.git) throw new Error("The task has no prepared Git worktree.");
  const paths = [...new Set(accessPaths(project, cwd, task.git.branch))];
  const filesystem = [
    '":root" = "read"',
    ...paths.map(path => JSON.stringify(path) + ' = "write"'),
    JSON.stringify(join(paths[1], "worktrees")) + ' = "read"',
  ].join(", ");
  const child = spawn(client.path, [
    ...client.args, "app-server", "-c", "permissions." + profile + "={filesystem={" + filesystem + "}}",
    "-c", "default_permissions=" + JSON.stringify(profile),
  ], { cwd: project, env: client.env, windowsHide: true, stdio: "pipe" });
  const exited = new Promise<void>(resolve => child.once("close", resolve));
  const output = createInterface({ input: child.stdout });
  const lines = output[Symbol.asyncIterator]();
  const turns = new Map<string, Turn>();
  let lastError = "";
  let nextId = 0;
  const timeout = setTimeout(() => {
    lastError = "Codex did not start the task in time.";
    child.kill();
    output.close();
  }, 60_000);
  const close = () => {
    clearTimeout(timeout);
    output.close();
    child.stdin.end();
    child.kill();
    return exited;
  };
  child.stderr.setEncoding("utf8").on("data", chunk => { lastError = (lastError + chunk).slice(-1500); });
  const streamError = (error: Error) => {
    lastError = error.message;
    output.close();
  };
  child.once("error", streamError);
  child.stdin.on("error", streamError);

  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  async function receive() {
    const line = await lines.next();
    if (line.done) throw new Error(lastError.trim() || "The Codex process closed.");
    const message = JSON.parse(line.value);
    if (message.method === "turn/completed") {
      const turn = message.params.turn as Turn;
      turns.set(turn.id, turn);
    }
    if (message.method && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "This request is unavailable in an unattended task run." } });
    }
    return message;
  }
  async function request<R>(method: string, params: object): Promise<R> {
    const id = nextId++;
    send({ id, method, params });
    for (;;) {
      const response = await receive();
      if (response.id !== id || response.method) continue;
      if (response.error) throw new Error(response.error.message);
      return response.result;
    }
  }
  async function monitor(turnId: string) {
    try {
      while (!turns.has(turnId)) await receive();
      const turn = turns.get(turnId)!;
      if (turn.status !== "completed") return turn.error?.message || "Codex ended the task run: " + turn.status + ".";
    } catch (error) {
      return (error as Error).message;
    } finally {
      await close();
    }
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
      thread: { id: string; projectId: string | null }; activePermissionProfile?: { id: string };
    }>(existing ? "thread/resume" : "thread/start", {
      cwd, projectId, threadId: existing, model: task.execution?.model, approvalPolicy: "never", permissions: profile,
    });
    if (projectId && started.thread.projectId !== projectId) {
      throw new Error("Codex did not attach the task chat to the board project.");
    }
    if (started.activePermissionProfile?.id !== profile) {
      throw new Error("Codex did not apply the write permissions for this task.");
    }
    const threadId = started.thread.id;
    if (!codexThreadPattern.test(threadId) || (existing && threadId !== existing)) throw new Error("Codex returned an unexpected thread ID.");
    const prompt = [
      "Выполни задачу AI Taskboard " + task.id + " в подготовленной рабочей копии.",
      "Корень доски: " + project,
      "Используй навык ai-taskboard:work-task и прочитай актуальную карточку по номеру.",
      "Рабочая копия: " + cwd,
      JSON.stringify({ title: task.title, description: task.description, criteria: task.criteria }),
    ].join("\n");
    const { turn } = await request<{ turn: Turn }>("turn/start", {
      threadId, effort: task.execution?.effort, input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    clearTimeout(timeout);
    if (turn.status !== "inProgress") turns.set(turn.id, turn);
    return { threadId, completion: monitor(turn.id) };
  } catch (error) {
    await close();
    throw error;
  }
}
