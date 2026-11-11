import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { codexThreadPattern } from "../cli/model.ts";
import type { Task } from "../cli/model.ts";
import type { configuredCodex } from "./codex.ts";

type Client = NonNullable<Awaited<ReturnType<typeof configuredCodex>>>;
type ConfiguredTask = Task & { execution?: { model: string; effort?: string } };

export function startCodexRun(client: Client, project: string, cwd: string, task: ConfiguredTask): Promise<string> {
  const settings = task.execution;
  const flags = [
    ...(settings?.model ? ["--model", settings.model] : []),
    ...(settings?.effort ? ["--config", "model_reasoning_effort=" + JSON.stringify(settings.effort)] : []),
  ];
  const prompt = [
    "Выполни задачу AI Taskboard " + task.id + " в подготовленной рабочей копии.",
    "Корень доски: " + project,
    "Используй навык ai-taskboard:work-task и прочитай актуальную карточку по номеру.",
    "Рабочая копия: " + cwd,
    JSON.stringify({ title: task.title, description: task.description, criteria: task.criteria }),
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(client.path, [
      ...client.args, "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write",
      "--json", ...flags, "-",
    ], { cwd, env: client.env, windowsHide: true, stdio: "pipe" });
    const output = createInterface({ input: child.stdout });
    let thread: string | undefined;
    let lastError = "";
    let started = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Codex did not start the task in time."));
    }, 60_000);
    child.stderr.setEncoding("utf8").on("data", chunk => { lastError = (lastError + chunk).slice(-1500); });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      if (!started) reject(new Error(lastError.trim() || "Codex closed before starting the task."));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    output.on("line", line => {
      if (started) return;
      let event: { type?: string; thread_id?: string; error?: { message?: string } };
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === "thread.started" && event.thread_id && codexThreadPattern.test(event.thread_id)) {
        thread = event.thread_id;
      }
      if (event?.type === "turn.failed" && event.error?.message) lastError = event.error.message;
      if (event?.type === "turn.started" && thread) {
        clearTimeout(timeout);
        started = true;
        resolve(thread);
      }
    });
  });
}
