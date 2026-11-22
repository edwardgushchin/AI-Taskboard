import { trackActiveRun, trackProvider, claimDiscussion, activeRunSummary, observeActiveRuns } from "../src/desktop/active-runs.ts";
import { providerActions } from "../src/desktop/provider-tools.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRpc, stopCodexProcess } from "../src/desktop/codex-rpc.ts";
import { isRoutingTimeout } from "../src/desktop/codex-routing-timeout.ts";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { boardProjectRulesPrompt, readBoardProjectRules, writeBoardProjectRules } from "../src/cli/board-agents.ts";
import { reviewModeInstruction } from "../src/desktop/chat-actions.ts";
import { CodexTokenUsage } from "../src/desktop/codex-token-usage.ts";
import { responseLanguageInstructions, boardAgentInstructions, boardCodexArgs, managerCodexArgs, boardWorklog, worklogReminder, worklogTool } from "../src/desktop/board-agent-hooks.ts";
import { withBoardMcp } from "../src/desktop/board-mcp.ts";
import { executorExpertTools, expertCommands, leadInstructions, phaseStageReporter, subagentInstructions } from "../src/desktop/expert-tools.ts";
import { githubReadTool } from "../src/desktop/github-read.ts";
import { runActivity, runLog } from "../src/desktop/run-activity.ts";
import type { RunActivity } from "../src/cli/model.ts";
import type { TokenUsageReport } from "../src/cli/token-usage.ts";

test("task discussion streams task usage before success, provider failure, or a disconnect", async t => {
  const counts: number[] = [];
  const stop = observeActiveRuns(() => counts.push(activeRunSummary().total));
  t.after(stop);
  const folder = mkdtempSync(join(tmpdir(), "ai-taskboard-chat-usage-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, ".tasks"));
  writeFileSync(join(folder, ".tasks", "board.json"), JSON.stringify({ settings: { boardType: "manual" } }));
  if (process.platform !== "win32") {
    writeFileSync(join(folder, "reviewer-rules.md"), "# Reviewer project\n");
    symlinkSync("reviewer-rules.md", join(folder, "AGENTS.md"), "file");
  }
  const oldRules = writeBoardProjectRules(folder, {
    text: "Reviewer OLD rule", revision: readBoardProjectRules(folder).revision,
  });
  writeBoardProjectRules(folder, { text: "Reviewer CURRENT rule", revision: oldRules.revision });
  const stub = join(folder, "server.cjs");
  writeFileSync(stub, `
    const send = value => console.log(JSON.stringify(value));
    const outcome = process.argv[2];
    require("node:readline").createInterface({ input: process.stdin }).on("line", async line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined) return;
      let result = {};
      if (method === "model/list") result = { data: [{ model: "selected", defaultReasoningEffort: "low", supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === "experimentalFeature/list") result = { data: [{ name: "multi_agent", enabled: true }] };
      if (method === "thread/start") {
        const assert = require("node:assert/strict");
        const reviewing = outcome.startsWith("review");
        assert.ok(process.argv.includes(reviewing ? 'web_search="disabled"' : 'web_search="live"'));
        assert.equal(params.permissions, undefined);
        assert.equal(params.sandbox, "read-only");
        if (reviewing) {
          assert.equal(params.ephemeral, false, "the provider needs the review lead's rollout for native subagents");
          assert.match(params.developerInstructions, /Assigned review lead specialization: .*QA lead/);
          assert.match(params.developerInstructions, /Assigned review plan: .*check-api/);
          assert.match(params.developerInstructions, /Native subagents are enabled/);
          assert.match(params.developerInstructions, /ready for acceptance in as few revision rounds as possible/);
          assert.match(params.developerInstructions, /Approve with an empty findings list/);
          assert.match(params.developerInstructions, /reuse evidence that is still valid for unaffected criteria/);
          assert.match(params.developerInstructions, /Report all material gaps together in a single return/);
          assert.match(params.developerInstructions, /check every criterion, even if you already found a defect/);
          assert.match(params.developerInstructions, /tested revision or provides concrete evidence that it still applies/);
          assert.match(params.developerInstructions, /These rules apply.*worklog_record/s);
          assert.match(params.developerInstructions, /Apply built-in rules silently/);
          assert.match(params.developerInstructions, /Internally verify recorded:true and staged:false/);
          assert.doesNotMatch(params.developerInstructions, /Ponytail|humanizer-ru|Codex Worklog/);
        } else {
          assert.match(params.developerInstructions, /Use built-in web search for relevant public sources/);
        }
        result = { thread: { id: "root" }, model: "actual" };
      }
      if (method === "turn/start") {
        require("node:assert/strict").deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
        if (outcome.startsWith("review")) {
          const assert = require("node:assert/strict");
          assert.ok(params.outputSchema.required.includes("verifyRisk"));
          const rules = params.additionalContext.ai_taskboard_project_rules.value;
          assert.match(rules, /Reviewer CURRENT rule/);
          assert.doesNotMatch(rules, /Reviewer OLD rule/);
          assert.equal(typeof params.clientUserMessageId, "string");
          require("node:fs").writeFileSync("review-client-id", params.clientUserMessageId);
        }
        send({ method: "turn/started", params: { threadId: "root", turn: { id: "turn-1" } } });
        const counts = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 10 };
        const notify = () => send({ method: "thread/tokenUsage/updated", params: { threadId: "root", turnId: "turn-1", tokenUsage: { total: counts, last: counts, modelContextWindow: 1000 } } });
        if (outcome !== "unknown") { notify(); notify(); }
        result = { turn: { id: "turn-1", status: "inProgress" } };
        send({ id, result });
        if (outcome === "review") {
          const url = process.argv.find(flag => flag.startsWith("mcp_servers=")).match(/http[^"]+/)[0];
          const entry = { title: "Reviewed the task", timeline: [{ time: null, items: ["Read the submission."] }] };
          for (const field of ["context", "changes", "decisions", "checks", "next_steps"]) entry[field] = ["Verified the criterion."];
          const args = { language: "en", entries: [entry] };
          const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.AI_TASKBOARD_MCP_TOKEN },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "worklog_record", arguments: args } }) });
          const reply = JSON.parse((await response.json()).result.content[0].text);
          if (!reply.ok) throw new Error(JSON.stringify(reply));
          require("node:fs").writeFileSync("worklog-path", reply.data.path);
        }
        if (outcome === "closed") { process.stdin.destroy(); return; }
        if (outcome.startsWith("review")) {
          send({ method: "item/completed", params: { threadId: "root", item: {
            id: "commentary", type: "agentMessage", phase: "commentary", text: "Checking the criteria." } } });
          send({ method: "item/completed", params: { threadId: "root", item: {
            id: "tool", type: "dynamicToolCall", tool: "task_review_diff", status: "completed" } } });
        }
        send({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "root", model: "child-model" } } });
        send({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } });
        if (outcome !== "unknown") send({ method: "thread/tokenUsage/updated", params: { threadId: "child", turnId: "child-turn", tokenUsage: { total: counts, last: counts } } });
        send({ method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } });
        const text = outcome.startsWith("review") ?
          JSON.stringify({ summary: "Verified", findings: [], evidence: ["Checked"], needsHuman: false, verifyRisk: false }) :
          JSON.stringify({ text: "Reply", awaitingAnswer: false });
        send({ method: "item/completed", params: { threadId: "root", item: { id: "final", type: "agentMessage", phase: "final_answer", text } } });
        send({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn-1", status: outcome === "failed" ? "failed" : "completed", error: { message: "Provider failed" } } } });
        return;
      }
      send({ id, result });
    });
  `);
  const source = readFileSync(new URL("../src/desktop/codex-chat.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  for (const outcome of ["ok", "unknown", "failed", "closed", "storage-failed", "review", "review-storage-failed"]) {
    const reports: TokenUsageReport[] = [];
    const runtime = runInNewContext(stripTypeScriptTypes(source) + "\n({ replyToTask, reviewWithCodex })", {
      boardProjectRulesPrompt, reviewModeInstruction,
      randomUUID, stopCodexProcess, isRoutingTimeout,
      executorExpertTools, expertCommands, trackActiveRun, trackProvider, claimDiscussion, spawn, codexRpc, CodexTokenUsage, manualContext: () => "", readBoardSettings: () => ({}), locateBoard: (path: string) => path, responseLanguageInstructions, boardAgentInstructions, boardCodexArgs, managerCodexArgs, providerActions, boardWorklog, worklogReminder, worklogTool, withBoardMcp, process, setTimeout, clearTimeout, runActivity, runLog,
      githubReadTool, leadInstructions, phaseStageReporter, subagentInstructions,
      leadSkillInstructions: async () => [], watchTeamMail: () => () => {},
      callCli: async (_project: string, args: string[]) => {
        assert.equal(args[0], "expert-context");
        return { ok: true, data: [{ prompt: "QA lead" }] };
      },
      configuredCodex: async () => ({ path: process.execPath, args: [stub, outcome] }),
      chatTools: [], saveChatImages: async () => [],
      cliFailure: (code: string, message: string) => ({ ok: false, error: { code, message } }),
    });
    if (outcome.startsWith("review")) {
      let activity: RunActivity[] = [];
      const checkpoints: { clientId: string; turnId?: string }[] = [];
      const review = await runtime.reviewWithCodex("profile", folder, { model: "selected", effort: "low" },
        "Review prompt", [], async () => ({ ok: true }), new AbortController().signal,
        async (report: TokenUsageReport) => {
          if (outcome === "review-storage-failed") throw new Error("Usage storage denied");
          reports.push(report);
        }, "T-0001", (items: RunActivity[]) => { activity = items; }, {
          lead: "qa-engineer", stages: [{ key: "check-api", expertId: "backend-developer", title: "Check API",
            description: "Verify the contract", criteria: ["Contract is compatible"], inputs: [], outputs: ["Evidence"], dependsOn: [] }],
        }, undefined, 0, {
          save: () => {},
          saveTurn: (turn?: { clientId: string; turnId?: string }) => {
            if (turn) checkpoints.push(turn);
          },
        });
      const clientId = readFileSync(join(folder, "review-client-id"), "utf8");
      assert.deepEqual(Array.from(checkpoints, ({ clientId, turnId }) => [clientId, turnId]), [
        [clientId, undefined],
        [clientId, "turn-1"],
      ]);
      assert.equal(review.summary, "Verified");
      assert.equal(review.verifyRisk, false);
      assert.deepEqual(Array.from(activity, item => item.id), ["commentary", "tool", "final"]);
      assert.equal(activity[1]?.title, "task_review_diff");
      if (outcome === "review") {
        const diaryPath = readFileSync(join(folder, "worklog-path"), "utf8");
        assert.match(readFileSync(diaryPath, "utf8"), /Reviewed the task[\s\S]*<!-- ai-taskboard-role:reviewer T-0001 -->/);
        assert.equal(reports.length, 1);
        assert.deepEqual(Array.from(reports[0].records, record => record.totalTokens), [120, 120]);
      }
      assert.equal(activeRunSummary().total, 0);
      assert.ok(counts.includes(1));
      continue;
    }
    const reply = runtime.replyToTask("profile", folder, { model: "selected", effort: "low" }, "Prompt", [],
      () => {}, async () => ({ ok: true }), folder, 1024, async (report: TokenUsageReport) => {
        if (outcome === "storage-failed") throw new Error("Usage storage denied");
        reports.push(report);
      });
    if (["failed", "closed"].includes(outcome)) {
      await assert.rejects(reply, /Provider failed|process closed/);
    } else {
      const answer = await reply;
      assert.equal(answer.text, "Reply");
      assert.equal(answer.usage?.used, outcome === "unknown" ? undefined : 120);
    }
    assert.equal(activeRunSummary().total, 0);
    assert.ok(counts.includes(1));
    if (outcome === "storage-failed") continue;
    const report = reports.at(-1)!;
    assert.equal(new Set(reports.map(report => report.id)).size, 1);
    const root = report.records.find(record => record.threadId === "root")!;
    assert.equal(root.model, "actual");
    assert.equal(root.totalTokens, outcome === "unknown" ? null : 120);
    assert.equal(root.incomplete, outcome !== "ok");
    if (outcome !== "closed") {
      const child = report.records.find(record => record.threadId === "child")!;
      assert.equal(child.model, "child-model");
      assert.equal(child.incomplete, outcome === "unknown");
    }
  }
});
