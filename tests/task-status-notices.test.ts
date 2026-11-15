import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { syncTaskStatusNotices, readManagerHistory, managerUnread, readManagerMessages } from "../src/desktop/manager-history.ts";
import { statusNotice } from "../src/cli/task-messages.ts";
import { writeJson } from "../src/cli/storage.ts";
import type { Task } from "../src/cli/model.ts";

process.env.GIT_CEILING_DIRECTORIES = tmpdir();
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

test("CLI transitions replay in order without goals, windows or a running manager; positions survive restart", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], input?: unknown) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", root, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", windowsHide: true,
      input: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).data;
  };
  cli(["init"]);
  const task = cli(["create"], { title: "Проверка доступа", criteria: ["Доступ проверен"], workingDirectory: root });
  cli(["approve", task.id]);
  assert.equal(syncTaskStatusNotices(root), false); // First enable skips old events.
  const messages = () => readManagerHistory(root, null, "chat")?.turns.flatMap(turn => turn.items.map(item => item.text)) ?? [];
  cli(["update", task.id], { title: "Доступ к SSH" });
  assert.equal(syncTaskStatusNotices(root), false);
  cli(["start", task.id]);
  cli(["block", task.id], { reason: "нужен доступ к серверу", condition: "доступ выдан" });
  cli(["resume", task.id], { reason: "доступ выдан" });
  const submit = () => cli(["submit", task.id], { token: cli(["preview", task.id]).token,
    noChanges: true, summary: "доступ к SSH проверен", checks: ["Проверено"] });
  submit();
  cli(["request-changes", task.id], { actor: "user", reason: "проверь повторно" });
  submit();
  cli(["accept", task.id], { revision: cli(["show", task.id]).revision });
  assert.equal(syncTaskStatusNotices(root), true);
  const texts = messages();
  assert.equal(texts.length, 7);
  for (const [i, label] of ["в работе.", "заблокирована: нужен доступ к серверу", "в работе: доступ выдан",
    "сдана на проверку: доступ к SSH проверен", "в работе: проверь повторно",
    "сдана на проверку: доступ к SSH проверен", "завершена: доступ к SSH проверен"].entries()) {
    assert.ok(texts[i]!.includes(`T-0001 «Доступ к SSH» — ${label}`), texts[i]);
  }
  assert.equal(managerUnread(root).length, 7);
  readManagerMessages(root, [...managerUnread(root)]);
  assert.equal(syncTaskStatusNotices(root), false);
  assert.deepEqual(messages(), texts);
  assert.deepEqual(managerUnread(root), []);
  // Replay the persisted delivery batch after a simulated interruption.
  const positionPath = join(root, ".tasks", "manager-status-position.json");
  const position = JSON.parse(readFileSync(positionPath, "utf8"));
  const name = readdirSync(join(root, ".tasks", "manager-chat")).sort().at(-1)!;
  position.pending = [{ id: name.slice(14, -5), at: Number(name.slice(0, 13)), text: texts.at(-1) }];
  writeJson(positionPath, position);
  const restart = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {syncTaskStatusNotices} from ${JSON.stringify(new URL("../src/desktop/manager-history.ts", import.meta.url).href)};syncTaskStatusNotices(process.argv[1]);`, root], { encoding: "utf8", windowsHide: true });
  assert.equal(restart.status, 0, restart.stderr);
  assert.deepEqual(messages(), texts);
  const cancelled = cli(["create"], { title: "Отмена" });
  cli(["cancel", cancelled.id], { reason: "больше не требуется" });
  cli(["settings"], { archiveAfterDays: 0 });
  cli(["archive", "sweep"]);
  assert.ok(cli(["list"]).archived.some((task: Task) => task.id === cancelled.id));
  assert.equal(syncTaskStatusNotices(root), true);
  assert.ok(messages().at(-1)!.includes("отменена: больше не требуется"));
});

test("review approval is not completion; absent reasons stay absent; boards remain isolated", t => {
  const task = { id: "T-0002", title: "Пример" } as Task;
  assert.equal(statusNotice(task, { at: "", actor: "reviewer", action: "review-approve" }), undefined);
  assert.equal(statusNotice(task, { at: "", actor: "user", action: "update", from: "ready", to: "ready" }), undefined);
  assert.equal(statusNotice(task, { at: "", actor: "user", action: "accept", from: "review", to: "done", text: "abc123" }), "T-0002 «Пример» — завершена.");
  const root = mkdtempSync(join(tmpdir(), "taskboard-isolated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(managerUnread(root), []);
});
