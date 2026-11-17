import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("Git menu dates use relative labels in English and Russian", () => {
  const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
  const start = renderer.indexOf("function relativeCommitDate(");
  const end = renderer.indexOf("\nasync function openGitBranches", start);
  assert.ok(start >= 0 && end > start);
  const frame = { russian: false };
  const format = runInNewContext(renderer.slice(start, end) + "\nrelativeCommitDate", {
    frame, language: (english: string, russian: string) => frame.russian ? russian : english,
  }) as (value: string, now: number) => string;
  const now = Date.parse("2026-11-12T12:00:00Z");
  const ago = (seconds: number) => format(new Date(now - seconds * 1000).toISOString(), now);
  assert.equal(format("invalid", now), "");
  assert.equal(ago(0), "just now");
  assert.equal(ago(59), "just now");
  assert.equal(ago(300), "5 min. ago");
  assert.equal(ago(7200), "2 hr. ago");
  assert.equal(ago(86400), "yesterday");
  assert.equal(ago(-86400), "tomorrow");
  assert.equal(ago(63072000), "2 yr. ago");
  frame.russian = true;
  assert.equal(ago(0), "только что");
  assert.match(ago(300), /5.+мин.+назад/u);
  assert.equal(ago(86400), "вчера");
});

test("Git status separates publication, destination and counts", () => {
  const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
  const nodes = new Map<string, any>();
  const node = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", title: "",
      setAttribute() {}, matches() { return false; }, querySelector(key: string) { return node(id + key); } });
    return nodes.get(id);
  };
  const frame: any = { project: "fixture", board: { tasks: [] } };
  const render = runInNewContext(renderer.slice(renderer.indexOf("function renderStatusBar("), renderer.indexOf("\nlet tabsSignature")) + "\nrenderStatusBar", {
    frame, byId: node, renderActiveAgents() {}, language: (en: string) => en,
    gitPushes: new Map(), reviewNotificationKey: "", reviewNotifications: [],
  });
  const base = { branch: "main", head: "a".repeat(40), remotes: ["origin"], pushTarget: { remote: "origin", remoteRef: "refs/heads/main" } };
  const cases = [
    [base, true, false, false],
    [{ ...base, remotes: [], pushTarget: undefined }, false, true, true],
    [{ ...base, trackingError: true }, true, false, false],
    [{ ...base, tracking: { ahead: 0, behind: 0 } }, true, false, false],
    [{ ...base, tracking: { ahead: 1, behind: 2 } }, true, false, false],
    [{ ...base, pushTarget: undefined, pushError: "destination" }, true, false, true],
    [{ ...base, branch: undefined }, true, true, false],
    [{ branch: "main", remotes: [] }, true, true, true],
    [{ gitError: true }, true, false, true],
  ];
  for (const [info, publishHidden, sendHidden, disabled] of cases) {
    frame.board.gitInfo = info;
    render(false);
    assert.equal(node("status-publish").hidden, publishHidden);
    assert.equal(node("status-tracking").hidden, sendHidden);
    assert.equal(node("status-tracking").disabled, disabled);
    assert.doesNotMatch(node("status-tracking").title, /undefined/);
    if (!sendHidden) {
      const tracking = (info as any).tracking;
      assert.equal(node("status-trackingspan").textContent,
        tracking ? tracking.behind + "↓ " + tracking.ahead + "↑" : "?↓ ?↑");
      assert.doesNotMatch(node("status-trackingspan").textContent, /Branch|Ветка/);
    }
  }
});

test("status push sends a pinned revision without upstream and clears busy state on failure", async () => {
  const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
  const frame = { project: "fixture", board: { gitInfo: { branch: "main", head: "a".repeat(40), pushTarget: { remote: "origin" } } } };
  const pushes = new Map();
  let called = 0;
  const push = runInNewContext(renderer.slice(renderer.indexOf("async function pushTrackedBranch("), renderer.indexOf("\nasync function publishToGitHub")) + "\npushTrackedBranch", {
    frame, gitPushes: pushes, renderStatusBar() {},
    async gitCommand(action: string, input: any, project: string) {
      called++;
      assert.equal(action, "push");
      assert.equal(project, "fixture");
      assert.equal(input.head, frame.board.gitInfo.head);
      assert.equal(input.branch, "main");
      assert.equal(pushes.get(project), "main");
      throw new Error("rejected");
    },
  });
  await assert.rejects(push(), /rejected/);
  assert.equal(called, 1);
  assert.equal(pushes.size, 0);
});


test("successful push applies the returned Git snapshot immediately", async () => {
  const renderer = readFileSync(new URL("../src/desktop/renderer.js", import.meta.url), "utf8");
  const frame: any = { project: "fixture", board: { gitInfo: { branch: "main" } } };
  const fresh = { branch: "main", upstream: "refs/heads/main", tracking: { ahead: 0, behind: 0 } };
  let draws = 0;
  const command = runInNewContext(renderer.slice(renderer.indexOf("async function gitCommand("), renderer.indexOf("\nfunction updateGitRevision")) + "\ngitCommand", {
    frame, api: { command: async () => ({ ok: true, data: { gitInfo: fresh } }) }, notice() {},
    renderStatusBar() { draws++; },
  });
  await command("push", {}, "fixture");
  assert.equal(frame.board.gitInfo, fresh);
  assert.equal(draws, 1);
});
