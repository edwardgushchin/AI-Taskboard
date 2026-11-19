import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { BoardStore, initializeBoard, onBoard, readJson } from "../src/cli/storage.ts";
import { expertAssets, expertContext, expertSkill, listExperts, readExpert, saveExpert } from "../src/cli/experts.ts";
import { createTask } from "../src/cli/tasks.ts";
import { createExpertPlan, expertStagesStatus, reviewDecisionSequence, sendTeamMessage, teamInbox, updateExpertStage } from "../src/cli/expert-team.ts";
import { managerInbox } from "../src/cli/task-messages.ts";
import { callCli } from "../src/desktop/cli.ts";
import { phaseStageReporter } from "../src/desktop/expert-tools.ts";
import type { Task } from "../src/cli/model.ts";

function fixture(t: TestContext) {
  const parent = realpathSync(tmpdir()); const root = mkdtempSync(join(parent, "taskboard-experts-"));
  t.after(() => { assert.equal(dirname(realpathSync(root)), parent); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); assert.equal(existsSync(root), false); });
  const location = { root, directory: join(root, ".tasks"), repository: null };
  initializeBoard(location, () => undefined);
  return { root, location, run: <T>(action: (store: BoardStore) => T) => onBoard(location, action) };
}
const brief = (key: string, expertId = "business-analyst", dependsOn: string[] = []) => ({ key, expertId, title: key,
  description: "A concrete stage", inputs: ["Project brief"], outputs: [key + ".md"], criteria: ["Verified result"], dependsOn });

test("220 board-local expert packages can be edited, disabled and extended without changing provider profiles", t => {
  const f = fixture(t);
  f.run(store => {
    assert.equal(listExperts(store).length, 220);
    const managerRoles = expertContext(store, ["business-analyst", "product-owner"]);
    assert.equal(managerRoles.length, 2); assert.match(managerRoles[0].prompt, /Бизнес/);
    const role = readExpert(store, "product-owner");
    const saved = saveExpert(store, { ...role, prompt: "Our own product rules" });
    assert.equal(saved.revision, role.revision + 1);
    assert.throws(() => saveExpert(store, { ...role }), /changed/);
    const created = saveExpert(store, { version: 1, id: "custom-editor", name: "Editor", group: "Custom", enabled: true,
      prompt: "Edit the supplied text", skills: [{ id: "edit", name: "Edit", content: "Preserve the meaning" }] });
    assert.match(expertSkill(store, created.id, "edit").content, /Preserve the meaning\s*$/);
    saveExpert(store, { ...created, enabled: false });
    assert.throws(() => expertContext(store, [created.id]), /disabled/);
    assert.throws(() => readExpert(store, "../../escape"), /without paths/);
    assert.equal(listExperts(store).length, 221);
  });
  f.run(store => assert.equal(readExpert(store, "product-owner").prompt, "Our own product rules"));
  assert.equal(existsSync(join(f.root, ".codex")), false); assert.equal(existsSync(join(f.root, ".claude")), false);
});

test("every upstream skill is pinned and a loaded package carries scripts, references and license files", t => {
  const f = fixture(t);
  const assets = expertAssets();
  const library = readJson(join(assets, "library.json")) as Record<string, { repo: string; path: string; sha256: string }>;
  assert.equal(Object.keys(library).length, 157);
  for (const skill of Object.values(library)) {
    const path = join(assets, "library", skill.repo.toLowerCase().replaceAll("/", "--"), skill.path);
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), skill.sha256, path);
  }
  f.run(store => {
    const expert = readExpert(store, "qa-engineer");
    const skill = expert.skills.find(s => s.name === "webapp-testing")!;
    const result = expertSkill(store, expert.id, skill.id);
    assert.match(result.content, /Playwright/);
    assert.equal(existsSync(join(result.directory, "scripts", "with_server.py")), true);
    assert.equal(existsSync(join(result.directory, "LICENSE.txt")), true);
    assert.equal(result.directory.startsWith(join(f.root, ".tasks", "experts", expert.id)), true);
    const assistant = readExpert(store, "personal-assistant");
    const taskSkill = assistant.skills.find(s => s.name === "task-management")!;
    const loaded = expertSkill(store, assistant.id, taskSkill.id);
    assert.doesNotMatch(loaded.content, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.equal(existsSync(join(loaded.directory, "..", "dashboard.html")), true);
  });
});

test("work and review stages stay on one card with independent dependency graphs", t => {
  const f = fixture(t);
  f.run(store => {
    const parent = store.create(createTask(store.allocateId(), { title: "Sprint" }));
    const reason = "The backend lead needs an independent interface design.";
    assert.throws(() => createExpertPlan(store, parent.id, { revision: 1, stages: [] }), /team rationale/);
    assert.throws(() => createExpertPlan(store, parent.id, { revision: 1, reason, stages: [brief("a", "product-owner", ["b"]), brief("b", "qa-engineer", ["a"])] }), /cycle/);
    const work = { revision: parent.revision, lead: "backend-developer", reason, stages: [brief("analysis"), brief("design", "ux-designer", ["analysis"])] };
    const result = createExpertPlan(store, parent.id, work);
    assert.equal(result.lead, "backend-developer");
    assert.equal(result.parent.history.at(-1)?.text, reason);
    assert.deepEqual(result.stages[1].dependsOn, ["analysis"]);
    assert.equal(createExpertPlan(store, parent.id, work).parent.revision, result.parent.revision);
    assert.throws(() => createExpertPlan(store, parent.id, { ...work, stages: [brief("analysis", "qa-engineer")] }), /different plan/);
    assert.throws(() => createExpertPlan(store, parent.id, { revision: 2, phase: "review", reason, stages: [brief("test", "qa-engineer", ["analysis"])] }), /Unknown prerequisite/);
    const review = createExpertPlan(store, parent.id, { phase: "review", revision: 2, lead: "qa-engineer", reason: "QA can verify both outputs.", stages: [brief("test", "qa-engineer")] });
    assert.equal(review.parent.expertTeam?.work?.stages.length, 2);
    assert.equal(review.parent.expertTeam?.review?.stages.length, 1);
    assert.equal(store.snapshot().tasks.length, 1);
  });
});

test("responsible executor and reviewer have distinct mailboxes on the same card", t => {
  const f = fixture(t);
  let id = "", question = 0;
  f.run(store => {
    const task = store.create(createTask(store.allocateId(), { title: "Team" }));
    id = task.id;
    sendTeamMessage(store, id, id, { to: "reviewer", text: "Check the API", kind: "update" });
    assert.equal(teamInbox(store, id, "reviewer").messages.length, 1);
    assert.equal(managerInbox(store.snapshot().tasks).length, 0);
    question = sendTeamMessage(store, id, "reviewer", { to: "owner", text: "Which market?", kind: "question" }).sequence;
    assert.equal(managerInbox(store.snapshot().tasks)[0].expertMessage?.to, "owner");
    assert.throws(() => sendTeamMessage(store, id, id, { to: "T-9999", text: "cross-team" }), /within/);
  });
  f.run(store => {
    const diagnostic = sendTeamMessage(store, id, "manager", { to: "reviewer", text: "The provider is still unavailable", replyTo: question, kind: "decision" });
    assert.equal(teamInbox(store, id, "reviewer", question).messages[0].sequence, diagnostic.sequence);
    assert.equal(reviewDecisionSequence(store.card(id)), 0, "a manager's reply does not schedule a repeat review");
    const reply = sendTeamMessage(store, id, "owner", { to: "reviewer", text: "EU", replyTo: question, kind: "decision" });
    assert.equal(teamInbox(store, id, "reviewer", question).messages.at(-1)?.text, "EU");
    assert.equal(managerInbox(store.snapshot().tasks).at(-1)?.expertMessage?.from, "owner");
    assert.equal(teamInbox(store, id, id).messages.some(m => m.text === "EU"), false);
    assert.equal(store.card(id).revision, 1);
    assert.equal(reviewDecisionSequence(store.card(id)), reply.sequence);
  });
});

test("public CLI exposes specialization in launch state and rejects unknown assignments", t => {
  const f = fixture(t);
  const call = (args: string[], input: object = {}) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", f.root, "--json", ...args, "--stdin"],
      { input: JSON.stringify(input), encoding: "utf8", windowsHide: true });
    assert.ok(result.stdout, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(call(["experts"]).data.length, 220);
  const created = call(["create"], { title: "Research", expertId: "research-scientist" }).data;
  assert.equal(call(["show", created.id, "--compact"], { launchDetails: true }).data.expertId, "research-scientist");
  assert.equal(call(["update", created.id], { revision: 1, expertId: "unknown-role" }).error.code, "EXPERT_NOT_FOUND");
});

test("planned work and review enforce stage order, evidence and independent mail across CLI sessions", { timeout: 90_000 }, t => {
  const f = fixture(t);
  const call = (args: string[], input: object = {}, error?: string) => {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "src/cli/main.ts", "--project", f.root, "--json", ...args, "--stdin"],
      { input: JSON.stringify(input), encoding: "utf8", windowsHide: true });
    assert.ifError(result.error);
    assert.ok(result.stdout, result.stderr);
    const reply = JSON.parse(result.stdout);
    if (error) assert.equal(reply.error?.code, error, result.stdout);
    else assert.equal(reply.ok, true, result.stdout);
    return reply.data;
  };
  const work = [brief("analysis", "product-owner"), brief("test", "qa-engineer", ["analysis"])];
  const review = { lead: "independent-reviewer", reason: "Separate review verifies the output.", stages: [brief("test", "independent-reviewer")] };
  const workPlan = { lead: "product-owner", reason: "The product owner checks scope and QA tests the result.", stages: work };
  const scope = { title: "Check scope", description: "Verify the changes.", criteria: ["Checked"], workingDirectory: f.root,
    subtasks: [{ title: "Check the scope" }, { title: "Verify the output" }] };
  const task = call(["create"], scope);
  call(["settings"], { requireExpertPlans: true, reviewMode: "reviewer" });
  call(["create"], { ...scope, actor: "manager" }, "EXPERT_PLAN_REQUIRED");
  call(["create"], { ...scope, actor: "user" }, "EXPERT_PLAN_REQUIRED");
  call(["create"], { ...scope, actor: "manager", expertTeam: {
    work: workPlan, review: { ...review, stages: [brief("test", "qa-engineer", ["missing"])] },
  } }, "INVALID_INPUT");
  assert.deepEqual(call(["list"]).tasks.map((entry: { id: string }) => entry.id), [task.id]);
  const planned = call(["create"], { ...scope, actor: "manager", expertTeam: { work: workPlan, review } });
  assert.equal(planned.revision, 1);
  assert.equal(planned.status, "draft");
  assert.deepEqual(planned.history.filter((event: { action: string }) => event.action === "expert-plan").map((event: { text: string }) => event.text), [workPlan.reason, review.reason]);
  assert.deepEqual(call(["show", planned.id]).approvalRequirements, []);
  assert.equal(call(["approve", planned.id], { revision: planned.revision }).status, "ready");
  let revision = task.revision;
  const command = (name: string, input: object = {}, error?: string) => call([name, task.id], input, error);
  assert.deepEqual(command("show").approvalRequirements, ["work", "review"]);
  command("approve", { revision }, "EXPERT_PLAN_REQUIRED");
  revision = command("expert-plan", { revision, ...workPlan }).parent.revision;
  command("approve", { revision }, "EXPERT_PLAN_REQUIRED");
  revision = command("expert-plan", { revision, phase: "review", ...review }).parent.revision;
  revision = command("approve", { revision }).revision;
  const started = command("start", { revision }).task;
  revision = started.revision;
  const loaded = command("expert-skill", { actor: "agent", expertId: "product-owner", skillId: "workflow" });
  assert.match(loaded.content, /workflow/);
  assert.deepEqual(command("show").history.at(-1).expertSkill, {
    expertId: "product-owner", skillId: "workflow", name: loaded.name, source: "tool",
  });
  assert.equal(command("show").revision, revision);
  const checked = command("checklist", { revision, index: 1, done: true });
  assert.equal(checked.status, "in_progress");
  assert.deepEqual(checked.subtasks.map((item: { done: boolean }) => item.done), [true, false]);
  command("checklist", { revision, index: 2, done: true }, "REVISION_CONFLICT");
  revision = checked.revision;
  assert.equal(command("checklist", { revision, index: 1, done: true }).revision, revision);
  const report = (key: string, state: string, input: object = {}, error?: string) =>
    command("expert-stage", { revision, actor: "agent", phase: "work", key, state, ...input }, error);
  report("test", "running", {}, "EXPERT_DEPENDENCIES_INCOMPLETE");
  report("analysis", "done", { result: "Ready", outputs: { [work[0].outputs[0]]: "Evidence" } }, "EXPERT_STAGE_NOT_RUNNING");
  report("analysis", "running");
  report("analysis", "running", { revision: revision - 1 }, "REVISION_CONFLICT");
  const question = command("expert-message", { actor: "agent", stage: "work:analysis", to: "owner", kind: "question", text: "Confirm scope?" });
  report("analysis", "blocked", { result: "Awaiting scope" });
  command("expert-message", { actor: "user", to: "work:analysis", kind: "decision", text: "Scope confirmed", replyTo: question.sequence });
  const mail = command("expert-inbox", { actor: "agent" });
  assert.equal(mail.messages.at(-1).to, "work:analysis");
  assert.equal(command("expert-inbox", { actor: "reviewer" }).messages.length, 0);
  assert.equal(mail.stages.find((s: { address: string }) => s.address === "work:analysis").state, "blocked");
  report("analysis", "running");
  report("analysis", "done", { result: "Confirmed", outputs: { invalid: "Evidence" } }, "INVALID_INPUT");
  const result = { result: "Checked", outputs: { [work[0].outputs[0]]: "Evidence" } };
  report("analysis", "done", result);
  report("analysis", "done", result);
  assert.equal(report("test", "running").dependencies[0].run.result, "Checked");
  const preview = command("preview");
  const submission = { token: preview.token, noChanges: true, summary: "Verified", checks: ["Check"] };
  command("submit", submission, "EXPERT_STAGES_INCOMPLETE");
  report("test", "done", { ...result, outputs: { [work[1].outputs[0]]: "Verified" } }, "INVALID_INPUT");
  report("test", "done", { ...result, outputs: { [work[1].outputs[0]]: "Verified" }, fallback: "Provider did not expose native delegation" });
  revision = command("submit", submission).revision;
  const decision = { revision, targetHead: null, summary: "Reviewed", evidence: ["Verified"] };
  command("review-approve", decision, "EXPERT_STAGES_INCOMPLETE");
  report("test", "running", { targetHead: null, phase: "review", actor: "reviewer" });
  report("test", "done", { ...result, outputs: { [brief("test").outputs[0]]: "Reviewed" }, targetHead: null, phase: "review", actor: "reviewer" });
  command("expert-message", { actor: "user", to: "review:test", kind: "decision", text: "Confirm the alternate case as well" });
  command("review-approve", decision, "EXPERT_STAGES_INCOMPLETE");
  report("test", "running", { targetHead: null, phase: "review", actor: "reviewer" });
  report("test", "done", { ...result, outputs: { [brief("test").outputs[0]]: "Reviewed both cases" }, targetHead: null, phase: "review", actor: "reviewer" });
  assert.equal(command("review-approve", decision).history.at(-1).action, "review-approve");
});

test("one native specialist can finish multiple stages but cannot impersonate a different specialization", t => {
  const f = fixture(t);
  const task = f.run(store => {
    const task = store.create(createTask(store.allocateId(), { title: "Expert handoffs" }));
    const plan = createExpertPlan(store, task.id, {
      revision: task.revision, lead: "product-owner", reason: "The owner coordinates the audit and checks its results.",
      stages: [brief("first"), brief("second"), brief("audit", "qa-engineer")],
    }).parent;
    return store.save({ ...plan, status: "in_progress" });
  });
  const change = (key: string, state: string, agentId?: string) =>
    f.run(store => updateExpertStage(store, task.id, "work", {
      revision: task.revision, key, state, agentId, sessionId: "test-session", result: "Checked",
      outputs: { [key + ".md"]: "Verified output" },
    }));
  change("first", "running"); change("second", "running"); change("audit", "running");
  change("first", "done", "specialist-one");
  assert.throws(() => change("second", "done", "specialist-two"), /Reuse the provider agent/);
  assert.throws(() => change("audit", "done", "specialist-one"), /represents one specialization/);
  change("second", "done", "specialist-one");
  change("audit", "done", "specialist-two");
  f.run(store => {
    const saved = store.card(task.id);
    assert.equal(saved.revision, task.revision);
    assert.deepEqual(expertStagesStatus(saved, "work").map(stage => stage.state), ["done", "done", "done"]);
  });
});

test("a resumed native specialist must complete in the current lead run", async t => {
  const f = fixture(t);
  const draft = await callCli<Task>(f.root, ["create"], {
    title: "Retest the updated page", workingDirectory: f.root, criteria: ["Run QA"],
    expertTeam: {
      work: { lead: "product-owner", reason: "QA is delegated.", stages: [brief("verify", "qa-engineer")] },
      review: { lead: "desktop-qa", reason: "Check the result independently.", stages: [] },
    },
  });
  assert.ok(draft.ok, JSON.stringify(draft));
  const id = draft.data.id;
  const ready = await callCli<Task>(f.root, ["approve", id], { revision: draft.data.revision });
  assert.ok(ready.ok, JSON.stringify(ready));
  const started = await callCli<{ task: Task }>(f.root, ["start", id], { revision: ready.data.revision });
  assert.ok(started.ok, JSON.stringify(started));
  const { revision } = started.data.task;

  const reporter = phaseStageReporter(f.root, "work", id);
  const stage = { revision, key: "verify" };
  assert.ok((await reporter.report({ ...stage, state: "running" })).ok);
  const result = { ...stage, state: "done", agentId: "previous-qa", result: "Retested", outputs: { "verify.md": "New checks passed." } };
  const observe = (threadId: string, item: object) =>
    reporter.observe({ method: "item/completed", params: { threadId, item } }, "lead");
  const followup = { type: "collabAgentToolCall", tool: "followupTask", status: "completed", receiverThreadIds: ["previous-qa"] };
  const expectError = async (code: string) => {
    const reply = await reporter.report(result);
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, code);
  };
  observe("other-lead", followup);
  await expectError("EXPERT_AGENT_UNCONFIRMED");
  observe("lead", followup);
  await expectError("EXPERT_AGENT_RUNNING");
  observe("lead", { type: "collabAgentToolCall", tool: "wait", agentsStates: { "previous-qa": { status: "completed" } } });
  observe("lead", { ...followup, tool: "resumeAgent" });
  await expectError("EXPERT_AGENT_RUNNING");
  observe("lead", { type: "subAgentActivity", kind: "completed", agentThreadId: "previous-qa", agentPath: "/root/qa" });
  assert.ok((await reporter.report({ ...result, agentId: "/root/qa" })).ok);
  f.run(store => assert.equal(store.card(id).history.at(-1)?.expertStageRun?.agentId, "previous-qa"));
});
test("assigned skills require successful actions by the correct agent and preserve native outputs", { timeout: 120_000 }, async t => {
  const f = fixture(t);
  const action = (tool: string, args: object, id: string, isError = false) => ({
    id, type: "mcpToolCall", tool, server: "fixture", status: "completed", arguments: args, result: { isError },
  });
  const ready = async <T>(name: string, input?: object, id?: string) => {
    const reply = await callCli<T>(f.root, [name, ...(id ? [id] : [])], input);
    if (!reply.ok) assert.fail(JSON.stringify(reply.error));
    return reply.data;
  };
  const errorCode = async (promise: Promise<{ ok: boolean; error?: { code: string } }>, code: string) => {
    const response = await promise;
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, code);
  };
  const observe = (reporter: ReturnType<typeof phaseStageReporter>, threadId: string, item: object, lead = "lead") =>
    reporter.observe({ method: "item/completed", params: { threadId, item } }, lead);
  for (const mode of ["reviewer", "manager"] as const) {
    await ready("settings", { reviewMode: mode });
    const lead = { skills: ["workflow"], skillChecks: { workflow: { tool: "trace", server: "fixture", arguments: { case: "lead" } } } };
    const specialist = { ...brief("verify", "qa-engineer"), skills: ["workflow"],
      skillChecks: { workflow: { command: "node check.mjs" } } };
    const base = { title: "Verify assigned skills", description: "Use observable actions.", criteria: ["Checked"], workingDirectory: f.root };
    const work = { lead: "product-owner", reason: "Coordinate and verify the test.", ...lead, stages: [specialist] };
    const review = { lead: "desktop-qa", reason: "Inspect the submitted evidence.", ...lead, stages: [] };
    await errorCode(callCli(f.root, ["create"], { ...base, expertTeam: { work: { ...work, skillChecks: undefined } } }), "SKILL_CHECK_REQUIRED");
    const draft = await ready<Task>("create", { ...base, expertTeam: { work, review } });
    const approved = await ready<Task>("approve", { revision: draft.revision }, draft.id);
    const { task } = await ready<{ task: Task }>("start", { revision: approved.revision }, draft.id);
    const revision = task.revision;
    const report = phaseStageReporter(f.root, "work", task.id);
    const command = { id: "command", type: "commandExecution", status: "completed", exitCode: 0,
      command: '"C:\\Program Files\\PowerShell\\pwsh.exe" -Command \'node check.mjs\'' };
    const outputs = { "verify.md": "The specialist's own result" };
    let history: object[] = [];
    report.bind(async <T>(_method: string, input: object) => {
      assert.equal((input as { threadId: string }).threadId, "child");
      return { data: history.map(item => ({ item, completedAtMs: Date.now() })), nextCursor: null } as T;
    }, "lead");
    const start = await report.report({ revision, key: "verify", state: "running" });
    assert.ok(start.ok);
    assert.equal("assignedSkills" in start.data && start.data.assignedSkills.length, 1);
    const complete = { revision, key: "verify", state: "done", agentId: "child", result: "Checked", outputs };
    observe(report, "lead", { type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"] });
    observe(report, "lead", { type: "collabAgentToolCall", tool: "wait", agentsStates: { child: { status: "completed" } } });
    observe(report, "lead", command);
    await errorCode(report.report(complete), "SKILL_USE_REQUIRED");
    history = [{ ...command, command: "echo node check.mjs" }, { id: "answer", type: "agentMessage", text: JSON.stringify({ outputs }) }];
    await errorCode(report.report(complete), "SKILL_USE_REQUIRED");
    history = [command, history[1]];
    await errorCode(report.report({ ...complete, outputs: { "verify.md": "Replaced by the lead" } }), "EXPERT_RESULT_MISMATCH");
    assert.ok((await report.report(complete)).ok);
    const preview = await ready<{ token: string }>("preview", undefined, task.id);
    const submission = { token: preview.token, noChanges: true, summary: "Checked", checks: ["Verified"] };
    await errorCode(callCli(f.root, ["submit", task.id], submission), "SKILL_USE_REQUIRED");
    observe(report, "lead", action("trace", { case: "lead" }, "failed", true));
    observe(report, "lead", action("trace", { case: "other" }, "wrong"));
    await errorCode(report.verify({ revision }), "SKILL_USE_REQUIRED");
    observe(report, "lead", action("trace", { case: "lead" }, "correct"));
    assert.ok((await report.verify({ revision })).ok);
    const submitted = await ready<Task>("submit", submission, task.id);
    const decision = { revision: submitted.revision, targetHead: null, summary: "Verified", evidence: ["Observed"] };
    const finish = mode === "reviewer" ? "review-approve" : "accept";
    const actor = mode === "manager" ? { actor: mode } : {};
    await errorCode(callCli(f.root, [finish, task.id], { ...decision, ...actor }), "SKILL_USE_REQUIRED");
    await errorCode(callCli(f.root, ["accept", task.id], { revision: submitted.revision }), "SKILL_USE_REQUIRED");
    const reviewing = phaseStageReporter(f.root, "review", mode === "reviewer" ? task.id : undefined, null);
    if (mode === "manager") {
      observe(reviewing, "lead", { ...action("task_review", { id: "other" }, "read-other"), server: "ai_taskboard" });
      await errorCode(reviewing.verify({ ...decision, id: task.id }), "REVIEW_REQUIRED");
      observe(reviewing, "lead", { ...action("task_review", { id: task.id }, "read-card"), server: "ai_taskboard" });
    }
    observe(reviewing, "lead", action("trace", { case: "lead" }, "reviewed"));
    assert.ok((await reviewing.verify({ ...decision, id: task.id })).ok);
    await ready(finish, { ...decision, ...actor }, task.id);
  }
});
