import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { boardAgentInstructions, boardWorklog } from "../src/desktop/board-agent-hooks.ts";

test("Worklog writes only complete authored blocks and recovers a staged turn after reopening", async t => {
  const project = mkdtempSync(join(tmpdir(), "ai-taskboard-worklog-"));
  t.after(() => rmSync(project, { recursive: true }));
  const board = join(project, ".tasks");
  mkdirSync(board);
  const worklog = boardWorklog(project, "executor", "T-0042");
  const threadId = "executor";
  const start = (turnId: string) => ({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
  const finish = (turnId: string) => ({ method: "turn/completed", params: { threadId, turn: { id: turnId } } });

  worklog.observe(start("omitted"), threadId);
  assert.match(worklog.remind({ ok: true, data: null }).worklog ?? "", /worklog_record.*entries/);
  assert.equal(worklog.remind({ ok: true, data: null }).worklog, undefined);
  worklog.observe({ method: "item/completed", params: { threadId, turnId: "omitted", item: { type: "contextCompaction" } } }, threadId);
  assert.match(worklog.remind({ ok: true, data: null }).worklog ?? "", /worklog_record/);
  worklog.observe({ method: "item/completed", params: { threadId, turnId: "omitted", item: {
    type: "agentMessage", phase: "final_answer", text: "Проверил рабочую копию и обновил документацию.",
  } } }, threadId);
  worklog.observe(finish("omitted"), threadId);
  worklog.start(threadId, "omitted");
  assert.equal((await worklog.submit({ skip: "no_material_work" })).ok, false);
  worklog.start(threadId, "trivial");
  assert.deepEqual(await worklog.submit({ skip: "no_material_work" }), {
    ok: true, data: { recorded: false, staged: false, skipped: "no_material_work" },
  });
  worklog.finish();
  assert.equal(existsSync(join(board, "worklog")), false);

  const entry = {
    title: "Проверил сохранение результата", context: ["Карточка T-0042."],
    timeline: [{ time: "11:20", items: ["Сверил изменения.\nПовторил проверку."] }],
    changes: ["Исправил сохранение."], decisions: ["Использовал имеющийся API."],
    checks: ["Две проверки прошли."], next_steps: ["Готово к ревью."],
    artifacts: ["[Отчёт](<" + join(project, "reports", "итог проверки.txt") + ">)"],
  };
  const document = { language: "ru", entries: [entry, { ...entry, title: "Уточнил критерии новой задачи", timeline: [{ time: null, items: ["Изучил сценарий."] }], artifacts: [] }] };
  worklog.start(threadId, "written");
  assert.equal((await worklog.submit({ skip: "no_material_work" })).ok, true);
  worklog.observe({ method: "item/completed", params: { threadId, turnId: "written", item: {
    type: "fileChange", status: "completed",
  } } }, threadId);
  assert.match(worklog.remind({ ok: true, data: null }).worklog ?? "", /context, timeline, changes, decisions, checks and next_steps/);
  const skipAfterEdit = await worklog.submit({ skip: "no_material_work" });
  assert.equal(skipAfterEdit.ok, false);
  assert.match(skipAfterEdit.error?.message ?? "", /changed files/);
  assert.equal((await worklog.submit({ language: "ru", entries: [{ ...entry, checks: ["## Заголовок"] }] })).ok, false);
  const saved = await worklog.submit(document);
  assert.ok(saved.ok, JSON.stringify(saved));
  const { path, entry_ids, recorded, staged } = saved.data as { path: string; entry_ids: string[]; recorded: boolean; staged: boolean };
  assert.equal(recorded, true);
  assert.equal(staged, false);
  assert.equal(entry_ids.length, 2);
  assert.match(relative(project, path).replaceAll("\\", "/"), /^\.tasks\/worklog\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.deepEqual(await worklog.submit(document), saved);
  assert.equal((await worklog.submit({ ...document, entries: [{ ...entry, title: "Повтор с изменением" }] })).ok, false);
  worklog.finish();

  const text = readFileSync(path, "utf8");
  assert.equal(text.match(/codex-worklog-entry:/g)?.length, 2);
  assert.match(text, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2} — Проверил сохранение результата$/m);
  assert.match(text, /ai-taskboard-role:executor T-0042/);
  assert.match(text, /### Хронология\n\n- \x6011:20\x60\n  - Сверил изменения\.\n    Повторил проверку\./);
  assert.match(text, /### Проверки\n\n- Две проверки прошли\.\n- \[Отчёт\]\(<\.\.\/\.\.\/\.\.\/\.\.\/reports\/итог проверки\.txt>\)/);
  assert.match(text, /- \x60Время не зафиксировано\x60/);
  assert.doesNotMatch(text, /Проверил рабочую копию|Board turn|Повтор с изменением/);
  assert.match(text.trimEnd(), /<!-- codex-worklog-entry:[0-9a-f]{24} -->$/);

  const original = join(board, "worklog");
  const blockedProject = mkdtempSync(join(tmpdir(), "ai-taskboard-worklog-"));
  t.after(() => rmSync(blockedProject, { recursive: true }));
  const blocked = join(blockedProject, relative(project, original));
  mkdirSync(join(blockedProject, ".tasks"));
  writeFileSync(blocked, "temporarily blocked");
  const pending = boardWorklog(blockedProject, "reviewer", "T-0042");
  pending.start(threadId, "pending");
  const blockedEntry = { ...entry, artifacts: [], checks: ["Проверил поведение.", "Authorization: Bearer syntheticSecretForTest"] };
  assert.equal((await pending.submit({ language: "ru", entries: [blockedEntry] })).ok, false);
  const stagedDir = join(blockedProject, ".tasks", "pending");
  assert.equal(readdirSync(stagedDir).filter(name => name.endsWith(".json")).length, 1);
  unlinkSync(blocked);
  const reopened = boardWorklog(blockedProject, "manager");
  reopened.start("manager", "post-restart");
  const retried = readFileSync(join(blockedProject, relative(project, path)), "utf8");
  assert.match(retried, /Проверил сохранение результата[\s\S]*turn:pending[\s\S]*ai-taskboard-role:reviewer T-0042/);
  assert.match(retried, /Bearer \[redacted\]/);
  assert.doesNotMatch(retried, /syntheticSecretForTest/);
  assert.equal(retried.match(/codex-worklog-entry:/g)?.length, 1);
  assert.equal(readdirSync(stagedDir).filter(name => name.endsWith(".json")).length, 0);
});


test("all board roles receive the same action boundaries on every instruction build", () => {
  for (const role of ["manager", "executor", "reviewer"] as const) {
    for (let turn = 0; turn < 2; turn++) {
      const instructions = boardAgentInstructions(role);
      assert.match(instructions, /no drag-and-drop or arbitrary manual status movement/);
      assert.match(instructions, /human review mode only the human requests acceptance/);
      assert.match(instructions, /persisted user acceptance request can continue automatically/);
      assert.match(instructions, /only tools actually supplied in this run/);
      assert.match(instructions, /send limitations or questions to the manager with message/);
      assert.match(instructions, /Confirm a transition only after a successful tool result/);
    }
  }
});

test("manual board instructions describe personal tasks without agent lifecycle actions", () => {
  const instructions = boardAgentInstructions("manager", "Personal tasks", { manual: true });
  assert.match(instructions, /Only the user moves personal tasks/);
  assert.doesNotMatch(instructions, /Managers create drafts|launch with task_start|delegate the smallest/);
});


test("built-in rules stay silent without rewriting supplied questions or quotations", () => {
  const supplied = 'User asks: What is humanizer-ru? Quote: "Ponytail SKILL.md"';
  for (const role of ["manager", "executor", "reviewer"] as const) {
    for (const dialogue of [true, false]) {
      const instructions = boardAgentInstructions(role, supplied, { dialogue });
      assert.ok(instructions.startsWith(supplied));
      const rules = instructions.slice(supplied.length);
      assert.doesNotMatch(rules, /Ponytail|humanizer-ru|Codex Worklog|THIRD_PARTY_NOTICES/);
      assert.match(rules, /Apply built-in rules silently/);
      assert.match(rules, /Answer direct questions about a specific skill or journal substantively/);
      assert.match(rules, /preserve user requests, quotations and saved history verbatim/);
      assert.match(rules, /immutable provider policy.*exact source/);
      assert.match(rules, /Internally verify recorded:true and staged:false; retry the same payload/);
      assert.match(rules, /Do not announce successful journal writes or expose recorded\/staged fields/);
    }
  }
});
