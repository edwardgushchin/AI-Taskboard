import { confirmFixtureDraft, plannedDraft } from "./fixtures/planned-draft.ts";
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
  cli(["settings"], { reviewMode: "manager" });
  const sync = () => cli(["sync-notices"], { language: "ru" }).changed;
  const task = cli(["create"], plannedDraft({ title: "Проверка доступа", criteria: ["Доступ проверен"], workingDirectory: root }));
  confirmFixtureDraft(root, task.id);
  cli(["approve", task.id]);
  assert.equal(sync(), false); // First enable skips old events.
  const work = () => readManagerHistory(root)?.turns.flatMap(turn => turn.items) ?? [];
  const messages = () => work().map(item => item.text);
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
  cli(["accept", task.id], { actor: "manager", revision: cli(["show", task.id]).revision });
  assert.equal(sync(), true);
  const texts = messages();
  assert.equal(texts.length, 6);
  for (const [i, label] of ["в работе.", "заблокирована: нужен доступ к серверу", "в работе.",
    "сдана на проверку: доступ к SSH проверен",
    "сдана на проверку: доступ к SSH проверен", "завершена: доступ к SSH проверен"].entries()) {
    assert.ok(texts[i]!.includes(`T-0001 «Доступ к SSH» — ${label}`), texts[i]);
  }
  const history = cli(["show", task.id]).history as Task["history"];
  assert.deepEqual(work().map(item => item.at), history.filter(event => statusNotice(task, event)).map(event => event.at));
  assert.deepEqual(readManagerHistory(root, null, "chat")?.turns, []);
  assert.deepEqual(readManagerHistory(root, null, "work")?.turns, []);
  assert.deepEqual(managerUnread(root), []);
  assert.equal(syncTaskStatusNotices(root), false);
  assert.deepEqual(messages(), texts);
  assert.deepEqual(managerUnread(root), []);
  // Replay the persisted delivery batch after a simulated interruption.
  const positionPath = join(root, ".tasks", "manager-status-position.json");
  const position = JSON.parse(readFileSync(positionPath, "utf8"));
  const name = readdirSync(join(root, ".tasks", "manager-chat")).sort().at(-1)!;
  position.pending = [{ id: name.slice(14, -5), at: Number(name.slice(0, 13)), eventAt: work().at(-1)!.at, text: texts.at(-1) }];
  writeJson(positionPath, position);
  const restart = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {syncTaskStatusNotices} from ${JSON.stringify(new URL("../src/desktop/manager-history.ts", import.meta.url).href)};syncTaskStatusNotices(process.argv[1]);`, root], { encoding: "utf8", windowsHide: true });
  assert.equal(restart.status, 0, restart.stderr);
  assert.deepEqual(messages(), texts);
  const cancelled = Array.from({ length: 5 }, (_, i) => cli(["create"], plannedDraft({ title: "Отмена " + i })));
  for (const card of cancelled) cli(["cancel", card.id], { actor: "manager", reason: "больше не требуется" });
  cli(["settings"], { archiveAfterDays: 0 });
  cli(["archive", "sweep"]);
  const archived: Task[] = cli(["list"]).archived;
  for (const card of cancelled) assert.ok(archived.some(task => task.id === card.id));
  assert.equal(syncTaskStatusNotices(root), true);
  for (const card of cancelled) {
    const event = cli(["show", card.id]).history.at(-1);
    assert.equal(event.action, "cancel");
    assert.equal(event.text, "больше не требуется");
    assert.equal(work().filter(item => item.text.startsWith(card.id + " ") && item.at === event.at).length, 1);
  }
  assert.deepEqual(readManagerHistory(root, null, "chat")?.turns, []);
  assert.deepEqual(readManagerHistory(root, null, "work")?.turns, []);
  assert.deepEqual(managerUnread(root), []);
});

test("review approval is not completion; absent reasons stay absent; boards remain isolated", t => {
  const task = { id: "T-0002", title: "Пример" } as Task;
  assert.equal(statusNotice(task, { at: "", actor: "reviewer", action: "review-approve" }), undefined);
  assert.equal(statusNotice(task, { at: "", actor: "user", action: "update", from: "ready", to: "ready" }), undefined);
  assert.equal(statusNotice(task, { at: "", actor: "reviewer", action: "accept", from: "review", to: "done", text: "abc123" }), "T-0002 «Пример» — завершена.");
  const root = mkdtempSync(join(tmpdir(), "taskboard-isolated-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(managerUnread(root), []);
});


test("manual lifecycle actions retain audit history without notices; agents still notify afterwards", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-manual-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], input?: unknown, success = true) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", root, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", windowsHide: true,
      input: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(result.status === 0, success, result.stdout + result.stderr);
    return JSON.parse(result.stdout).data;
  };
  cli(["init"]);
  syncTaskStatusNotices(root);
  const task = cli(["create"], plannedDraft({ title: "Manual", criteria: ["Checked"], workingDirectory: root }));
  const manual = (action: string, input = {}) => {
    cli([action, task.id], { ...input, actor: "user" });
    assert.equal(syncTaskStatusNotices(root), false, action);
    assert.deepEqual(managerUnread(root), []);
    assert.equal(cli(["show", task.id]).history.at(-1).actor, "user");
  };
  confirmFixtureDraft(root, task.id);
  manual("approve");
  manual("return-to-draft", { revision: cli(["show", task.id]).revision });
  manual("approve"); manual("start");
  cli(["block", task.id], { reason: "useful blocker", condition: "access" });
  assert.equal(syncTaskStatusNotices(root), true);
  readManagerMessages(root, [...managerUnread(root)]);
  manual("resume", { reason: "internal manual reason" });
  cli(["block", task.id], { actor: "manager", reason: "useful blocker", condition: "access" });
  assert.equal(syncTaskStatusNotices(root), true);
  readManagerMessages(root, [...managerUnread(root)]);
  const reason = "Пользователь поручил ещё одну попытку…";
  cli(["unblock", task.id], { actor: "manager", reason });
  assert.equal(cli(["show", task.id]).history.at(-1).text, reason);
  assert.equal(syncTaskStatusNotices(root), true);
  const texts = readManagerHistory(root)!.turns.flatMap(turn => turn.items.map(item => item.text));
  assert.ok(texts.some(text => text.includes("useful blocker")));
  assert.ok(!texts.some(text => text.includes(reason)));
  readManagerMessages(root, [...managerUnread(root)]);
  manual("start");
  const submit = () => cli(["submit", task.id], { token: cli(["preview", task.id]).token,
    noChanges: true, summary: "result", checks: ["checked"] });
  submit(); syncTaskStatusNotices(root); readManagerMessages(root, [...managerUnread(root)]);
  manual("request-changes", { reason: "feedback" });
  submit(); syncTaskStatusNotices(root); readManagerMessages(root, [...managerUnread(root)]);
  manual("accept", { revision: cli(["show", task.id]).revision });
  const source = cli(["create"], plannedDraft({ title: "Source", criteria: ["Checked"] }));
  const target = cli(["create"], plannedDraft({ title: "Main", criteria: ["Checked"] }));
  cli(["cancel", source.id], { actor: "manager", reason, mergedInto: source.id, transferred: "hash wrapping" }, false);
  assert.equal(cli(["show", source.id]).status, "draft");
  cli(["cancel", source.id], { actor: "manager", reason, mergedInto: target.id, transferred: "hash wrapping" });
  assert.equal(syncTaskStatusNotices(root), true);
  const text = readManagerHistory(root)!.turns.at(-1)!.items[0]!.text;
  assert.ok(text.includes(source.id) && text.includes(target.id) && text.includes("Source") && text.includes("Main") && text.includes("hash wrapping"));
  assert.ok(!text.includes(reason));
  const cancelled = cli(["create"], plannedDraft({ title: "Manual cancel" }));
  cli(["cancel", cancelled.id], { actor: "user", reason });
  assert.equal(syncTaskStatusNotices(root), false);
  const restart = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {syncTaskStatusNotices} from ${JSON.stringify(new URL("../src/desktop/manager-history.ts", import.meta.url).href)};if(syncTaskStatusNotices(process.argv[1]))process.exit(1);`, root], { encoding: "utf8", windowsHide: true });
  assert.equal(restart.status, 0, restart.stderr);
});


test("manual Git checkout and resumed checkout preserve the actor of each start", t => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-git-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (args: string[], input?: unknown) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      fileURLToPath(new URL("../src/cli/main.ts", import.meta.url)), "--project", root, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { encoding: "utf8", windowsHide: true,
      input: input === undefined ? undefined : JSON.stringify(input) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).data;
  };
  cli(["init"], { git: true });
  const task = cli(["create"], plannedDraft({ title: "Git source", criteria: ["Checked"] }));
  confirmFixtureDraft(root, task.id);
  cli(["approve", task.id], { actor: "user" });
  syncTaskStatusNotices(root);
  cli(["start", task.id], { actor: "user" });
  assert.equal(cli(["show", task.id]).history.at(-1).actor, "user");
  assert.equal(syncTaskStatusNotices(root), false);
  cli(["pause", task.id]);
  syncTaskStatusNotices(root); readManagerMessages(root, [...managerUnread(root)]);
  cli(["start", task.id], { actor: "user" });
  assert.equal(syncTaskStatusNotices(root), false);
  cli(["pause", task.id]);
  syncTaskStatusNotices(root); readManagerMessages(root, [...managerUnread(root)]);
  cli(["start", task.id], { actor: "manager" });
  assert.equal(cli(["show", task.id]).history.at(-1).actor, "manager");
  assert.equal(syncTaskStatusNotices(root), true);
});
