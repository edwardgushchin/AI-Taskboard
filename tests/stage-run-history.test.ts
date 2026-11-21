import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readStageRunHistory, stageRunJournal } from "../src/desktop/stage-run-history.ts";

test("work and review keep all sessions and their event IDs in a new process", t => {
  const project = mkdtempSync(join(tmpdir(), "taskboard-stage-history-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, ".tasks"));
  const id = "T-0001";
  const threadId = randomUUID();
  const expected: Record<"work" | "review", string[]> = { work: [], review: [] };
  for (const phase of ["work", "review"] as const) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const stageSessionId = randomUUID();
      const journal = stageRunJournal(project, id, phase, stageSessionId);
      const item = {
        threadId,
        stageSessionId,
        id: "deliberately-reused",
        type: "commandExecution",
        title: "npm test",
        text: "",
        status: "inProgress",
        at: new Date(attempt * 1000).toISOString(),
      };
      journal.record(item);
      journal.record({ ...item, text: "All checks passed.", status: "completed" });
      expected[phase].push(stageSessionId);
      journal.close();
    }
  }
  const source = new URL("../src/desktop/stage-run-history.ts", import.meta.url).href;
  const reopened = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { readStageRunHistory } from ${JSON.stringify(source)};
    console.log(JSON.stringify(readStageRunHistory(process.argv[1], process.argv[2])));
  `, project, id], { encoding: "utf8" })) as ReturnType<typeof readStageRunHistory>;
  assert.deepEqual(reopened, readStageRunHistory(project, id));
  assert.deepEqual(readStageRunHistory(project, "T-0002"), { work: [], review: [] });
  for (const phase of ["work", "review"] as const) {
    assert.deepEqual(reopened[phase].map(item => item.stageSessionId), expected[phase]);
    assert.ok(reopened[phase].every(item =>
      item.threadId === threadId && item.id === "deliberately-reused" && item.status === "completed"));
  }
});
