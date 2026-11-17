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
import { createExpertPlan, reviewDecisionSequence, sendTeamMessage, teamInbox } from "../src/cli/expert-team.ts";
import { managerInbox } from "../src/cli/task-messages.ts";

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
    assert.throws(() => createExpertPlan(store, parent.id, { revision: 1, stages: [brief("a", "product-owner", ["b"]), brief("b", "qa-engineer", ["a"])] }), /cycle/);
    const work = { revision: parent.revision, lead: "backend-developer", stages: [brief("analysis"), brief("design", "ux-designer", ["analysis"])] };
    const result = createExpertPlan(store, parent.id, work);
    assert.equal(result.lead, "backend-developer");
    assert.deepEqual(result.stages[1].dependsOn, ["analysis"]);
    assert.equal(createExpertPlan(store, parent.id, work).parent.revision, result.parent.revision);
    assert.throws(() => createExpertPlan(store, parent.id, { ...work, stages: [brief("analysis", "qa-engineer")] }), /different plan/);
    assert.throws(() => createExpertPlan(store, parent.id, { revision: 2, phase: "review", stages: [brief("test", "qa-engineer", ["analysis"])] }), /Unknown prerequisite/);
    const review = createExpertPlan(store, parent.id, { phase: "review", revision: 2, lead: "qa-engineer", stages: [brief("test", "qa-engineer")] });
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
    const reply = sendTeamMessage(store, id, "owner", { to: "reviewer", text: "EU", replyTo: question, kind: "decision" });
    assert.equal(teamInbox(store, id, "reviewer", question).messages[0].text, "EU");
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
