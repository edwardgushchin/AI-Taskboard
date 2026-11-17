import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { manualContext } from "../src/cli/manual-board.ts";
import { effectiveSettings, inheritedLimits } from "../src/cli/settings-notices.ts";
import { taskChatActions } from "../src/desktop/chat-actions.ts";

test("weekly manual board: public CLI, reloads, transitions, columns and neighbouring agent board", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-manual-"));
  try {
    const manual = join(root, "week"); const agent = join(root, "agents");
    mkdirSync(manual); mkdirSync(agent);
    function cli(project: string, command: string, id?: string, input = {}, error?: string) {
      const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", project,
        "--json", command, ...(id ? [id] : []), "--stdin"], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: root } });
      const reply = JSON.parse(result.stdout);
      if (error) { assert.equal(reply.error?.code, error, result.stdout); return; }
      assert.equal(reply.ok, true, result.stdout + result.stderr); return reply.data;
    }
    let board = cli(manual, "init", undefined, { boardType: "manual", git: true });
    assert.equal(existsSync(join(manual, ".git")), false);
    const first = board.settings.manualColumns[0]; const work = board.settings.manualColumns[1]; const done = board.settings.manualColumns[2];
    for (const column of [first, work, done]) {
      const created = cli(manual, "create", undefined, { actor: "user", title: column.name, initialStatus: column.id });
      assert.equal(created.status, column.id);
      assert.equal(Boolean(created.closedAt), column.terminal);
      assert.equal(created.git, undefined);
      assert.equal(created.history.some((e: { action: string }) => e.action === "start"), false);
    }
    cli(manual, "create", undefined, { actor: "user", title: "Missing column", initialStatus: "manual:removed" }, "INVALID_INPUT");
    cli(manual, "create", undefined, { actor: "manager", title: "Not a user move", initialStatus: work.id }, "MANUAL_BOARD");
    const attachmentPath = join(root, "shopping.txt"); writeFileSync(attachmentPath, "Milk and bread");
    let card = cli(manual, "create", undefined, { title: "Buy groceries", actor: "manager", attachmentSources: [{ path: attachmentPath }] });
    const attachments = card.attachments;
    assert.equal(card.status, first.id);
    const second = cli(manual, "create", undefined, { title: "Plan the week" });
    for (const to of [work.id, first.id, done.id, work.id]) {
      card = cli(manual, "manual-move", card.id, { actor: "user", revision: card.revision, to });
      assert.equal(card.status, to);
    }
    card = cli(manual, "update", card.id, { actor: "manager", revision: card.revision, description: "Milk and bread" });
    card = cli(manual, "update", card.id, { actor: "user", revision: card.revision, criteria: ["For the week"] });
    assert.equal(card.status, work.id);
    const chat = taskChatActions(manual, card, "Change the description", () => {});
    const chatEdit = await chat("task_update", { authorization: "Change the description", description: "Milk, bread and fruit" });
    assert.equal(chatEdit.ok, true, JSON.stringify(chatEdit));
    card = cli(manual, "show", card.id);
    assert.equal(card.status, work.id);
    assert.equal(card.description, "Milk, bread and fruit");
    for (const actor of ["manager", "agent"]) cli(manual, "manual-move", card.id, { actor, revision: card.revision, to: done.id }, "MANUAL_BOARD");
    for (const command of ["start", "approve", "submit", "accept", "request-changes", "pause", "resume", "block", "cancel", "review", "preview"]) cli(manual, command, card.id, {}, "MANUAL_BOARD");
    cli(manual, "settings", undefined, { autoMode: true }, "MANUAL_BOARD");
    cli(manual, "settings", undefined, { boardType: "agent" }, "IMMUTABLE_BOARD_TYPE");
    cli(manual, "update", card.id, { schedule: { everyMinutes: 1 } }, "MANUAL_BOARD");
    const next = [{ ...done, name: "All set", color: "#123456" }, { ...work, name: "This week" }, { id: "manual:extra", name: "Later", color: "#654321", terminal: false }];
    cli(manual, "manual-columns", undefined, { actor: "user", previous: board.settings.manualColumns, columns: next }, "COLUMN_NOT_EMPTY");
    cli(manual, "manual-columns", undefined, { actor: "user", previous: board.settings.manualColumns, columns: next, moves: { [first.id]: work.id } });
    cli(manual, "manual-columns", undefined, { actor: "user", previous: board.settings.manualColumns, columns: next }, "REVISION_CONFLICT");
    board = cli(manual, "list");
    assert.deepEqual(board.settings.manualColumns, next);
    assert.ok(manualContext(board.settings).includes("All set"));
    assert.ok(String(effectiveSettings(board.settings, inheritedLimits)["Статусы"]).includes("This week"));
    assert.equal(cli(manual, "show", second.id).status, work.id);
    card = cli(manual, "show", card.id);
    assert.equal(card.history.filter((e: {action: string}) => e.action === "manual-move").length, 4);
    assert.ok(card.history.some((e: {text?: string}) => e.text?.includes("→")));
    card = cli(manual, "manual-move", card.id, { actor: "user", revision: card.revision, to: done.id });
    assert.ok(card.closedAt);
    assert.equal(card.git, undefined);
    assert.deepEqual(card.attachments, attachments);
    assert.equal(readFileSync(join(manual, ".tasks", "attachments", card.id, attachments[0].file), "utf8"), "Milk and bread");
    assert.equal(existsSync(join(manual, ".tasks", "worktrees", card.id)), false);
    cli(agent, "init");
    cli(agent, "create", undefined, { actor: "user", title: "Wrong process", initialStatus: work.id }, "INVALID_INPUT");
    const legacyPath = join(agent, ".tasks", "board.json");
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")); delete legacy.settings.boardType; writeFileSync(legacyPath, JSON.stringify(legacy));
    const task = cli(agent, "create", undefined, { title: "Agent work", criteria: ["Works"] });
    assert.equal(cli(agent, "approve", task.id, { actor: "user" }).status, "ready");
    cli(agent, "settings", undefined, { boardType: "manual" }, "IMMUTABLE_BOARD_TYPE");
    assert.equal(cli(manual, "settings").autoMode, false);
    const manualPath = join(manual, ".tasks", "board.json");
    const stale = JSON.parse(readFileSync(manualPath, "utf8")); stale.settings.autoMode = true;
    writeFileSync(manualPath, JSON.stringify(stale));
    assert.equal(cli(manual, "settings").autoMode, false);
    const withoutGit = spawnSync(process.execPath, ["src/cli/main.ts", "--project", manual, "--json", "list"], {
      encoding: "utf8", env: { ...process.env, PATH: "", Path: "" },
    });
    assert.equal(JSON.parse(withoutGit.stdout).ok, true, withoutGit.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
});

test("two manual board subscriptions see column edits and reject stale saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "taskboard-manual-watch-"));
  const children: ReturnType<typeof spawn>[] = [];
  const streams: ReturnType<typeof createInterface>[] = [];
  const args = ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", root, "--json"];
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: root };
  const cli = (command: string, input: unknown) => JSON.parse(spawnSync(process.execPath, [...args, command, "--stdin"], { env, encoding: "utf8", input: JSON.stringify(input) }).stdout);
  try {
    const board = cli("init", { boardType: "manual" }).data;
    const snapshots: any[][] = [[], []];
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [...args, "watch", "--compact"], { env, windowsHide: true });
      children.push(child);
      const stream = createInterface({ input: child.stdout! }); streams.push(stream);
      stream.on("line", line => snapshots[i].push(JSON.parse(line).data));
    }
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!condition()) { assert.ok(Date.now() < deadline, "watch did not deliver update"); await new Promise(resolve => setTimeout(resolve, 25)); }
    };
    await waitFor(() => snapshots.every(s => s.length > 0));
    const columns = [...board.settings.manualColumns].reverse(); columns[0] = { ...columns[0], name: "Weekend", color: "#123456" };
    assert.equal(cli("manual-columns", { actor: "user", previous: board.settings.manualColumns, columns }).ok, true);
    await waitFor(() => snapshots.every(s => s.at(-1)?.settings.manualColumns[0].name === "Weekend"));
    assert.deepEqual(snapshots[0].at(-1).settings, snapshots[1].at(-1).settings);
    assert.equal(cli("settings", { autoMode: true }).error.code, "MANUAL_BOARD");
    assert.equal(cli("manual-columns", { actor: "user", previous: board.settings.manualColumns, columns }).error.code, "REVISION_CONFLICT");
  } finally {
    const exits = children.map(child => once(child, "exit"));
    children.forEach(child => child.kill()); await Promise.all(exits); streams.forEach(stream => stream.close());
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});
