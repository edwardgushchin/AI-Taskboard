import { plannedDraft } from "./fixtures/planned-draft.ts";
import { isManual, manualContext } from "../src/cli/manual-board.ts";
import { captureFileLink, isFileLink, verifyFileLink } from "../src/cli/attachment-links.ts";
import localization from "../src/desktop/localization.cjs";
import { activeRunSummary } from "../src/desktop/active-runs.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { boardReviewMode, codexThreadPattern, defaultBoardAgents, hexTagColor, maxAttachmentBytes, reviewVerifier, TaskboardError, taskIdPattern, reviewsAcceptanceRepair, usesIndependentReviewer } from "../src/cli/model.ts";
import { managerInbox, needsManagerAttention } from "../src/cli/task-messages.ts";
import type { RunActivity, Task } from "../src/cli/model.ts";
import type { ChatSettings } from "../src/cli/model.ts";
import { directory as storageDirectory, locateBoard, readBoardSettings, readJson, writeJson } from "../src/cli/storage.ts";
import { registerRuntime, runtimeLocation, runtimeTransaction } from "../src/desktop/board-runtime.ts";
import type { BoardGoal, BoardGoalAction, readBoardHistory } from "../src/desktop/codex-chat.ts";
import { inspectProjectPath, projectSha256 } from "../src/desktop/project-files.ts";
import { readReviewReports, saveReviewReports } from "../src/desktop/review-history.ts";
import { reviewerActivity, withReviewerChat } from "../src/desktop/reviewer-chat.ts";
import { goalMessages, hasManagerMessage, managerChatItems, managerUnread, managerWorkItems, readManagerHistory, readManagerMessages, readManagerView, saveManagerHistory } from "../src/desktop/manager-history.ts";
import { russianWriting } from "../src/desktop/russian-writing.ts";
import { autoQueueSettings } from "../src/cli/auto-queue.ts";
import { automationDelivery } from "../src/desktop/automation-delivery.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { settingsDelivery, syncSettingsNotices } from "../src/desktop/settings-notices.ts";
import { githubReadTool } from "../src/desktop/github-read.ts";
import { expertActions, expertCommands, leadInstructions, phaseStageReporter } from "../src/desktop/expert-tools.ts";
import { executorFullAccess, managerAccess, setTaskExecutorAccess } from "../src/desktop/codex.ts";
import type { ManagerAccess } from "../src/desktop/codex.ts";

process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

const source = (file: string) => readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
const boardSource = stripTypeScriptTypes(source("board-actions.ts").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
const main = ts.createSourceFile("main.ts", source("main.ts"), ts.ScriptTarget.Latest, true);
const handlerSource = stripTypeScriptTypes(main.statements.map(node => node.getText(main)).filter(text =>
  /^(?:(?:async )?function (?:frame|boardUnread|publishManagerUnread|managerQuestion|publishReviewActivity|isPastedFile|readBoardThread|saveBoardGoal|changeBoardGoal|boardThreadPath|broadcastBoardChat|prepareBoardAttachments|runBoardRequest|executorBusy|scheduleAutoReview|reviewSubmission|saveTaskTokenUsage|reserveAgent|scheduleAgentWork|continueAcceptance|returnTaskToDraft|scheduleMaintenance|scheduleRecurringTasks|taskRunLimit|readQueuedMessage|queuedFiles|listQueuedMessages)\(|const (?:imageExtensions|imageTypes|boardRequests|boardGoalClears|boardWorkRequests|backgroundManagerRequests|goalChatTools|goalWorkTools|deferredExecutors|acceptanceWork|maintenanceWork|returningDrafts|reviewOperations|managerReviewOperations|taskOperations|steeringOperations) =|let schedulingAgentWork =|imageTypes\.set\(|ipcMain\.handle\("board:(?:queue|request|stopOrchestrator|answerQuestion|goal|history|readManagerMessages)",)/.test(text)).join("\n"));
const entry = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const cliFailure = (code: string, message: string) => ({ ok: false, error: { code, message } });

function fixture(t: TestContext) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-orchestrator-test-")));
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }));
  const project = join(folder, "project");
  mkdirSync(project);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: folder };
  const cliCalls: string[][] = [];
  const busyDecisions = new Map<string, number>();
  const callCli = async (cwd: string, args: string[], input?: unknown, track = true) => {
    assert.equal(cwd, project);
    if (track) cliCalls.push(args);
    const key = args.slice(0, 2).join(" ");
    const busy = busyDecisions.get(key) ?? 0;
    if (busy > 0) {
      busyDecisions.set(key, busy - 1);
      return cliFailure("BOARD_BUSY", "Another command is working on this board.");
    }
    const result = spawnSync(process.execPath, [entry, "--project", cwd, "--json", ...args,
      ...(input === undefined ? [] : ["--stdin"])], { env, encoding: "utf8", input: JSON.stringify(input), windowsHide: true });
    assert.ok(result.stdout, result.stderr);
    const reply = JSON.parse(result.stdout);
    if (args[0] === "init" && reply.ok) assert.equal(reply.data.project, project);
    return reply;
  };
  const { autoReviewInstructions, autoReviewReadTools, autoReviewTaskTools, boardActions, boardInstructions, boardMcpTools, boardTools, manualReviewInstructions, reviewerTools } = runInNewContext(
    boardSource + "\n({ autoReviewInstructions, autoReviewReadTools, autoReviewTaskTools, boardActions, boardInstructions, boardMcpTools, boardTools, manualReviewInstructions, reviewerTools })",
    { AbortSignal, expertActions, expertCommands, leadInstructions, autoQueueSettings, isManual, manualContext, locateBoard, readBoardSettings, boardReviewMode, usesIndependentReviewer, callCli, cliFailure, defaultBoardAgents, hexTagColor, inspectProjectPath, managerInbox, needsManagerAttention, projectSha256, reviewVerifier, russianWriting, TaskboardError, taskIdPattern,
      taskFields: { title: {}, description: {}, criteria: {}, tags: {} },
    },
  );
  type RunAction = (name: string, args: unknown) => Promise<any>;
  type GoalControl = (action: BoardGoalAction) => Promise<BoardGoal | null>;
  type GoalRequest = { objective?: string; resume?: boolean; accepted: () => void; delivered: (id: string) => void; controls: (control: GoalControl) => void;
    update: (goal: BoardGoal | null) => void; activity: (items: RunActivity[]) => void; settings?: ChatSettings | null;
    enableNotifications: (steer?: (text: string, images: string[]) => Promise<void>) => void; endTurn: () => void;
    role?: string; access?: ManagerAccess; confirmApproval?: (details: string) => Promise<boolean> };
  type Reply = (action: RunAction, prompt: string, images: string[], id?: string, context?: any,
    waiting?: (waiting: boolean) => void, signal?: AbortSignal, goal?: GoalRequest) => Promise<{ text: string } | { interrupted: true }>;
  let respond: Reply;
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  const threadId = "00000000-0000-0000-0000-000000000001";
  const dialogueId = "00000000-0000-0000-0000-000000000002";
  const binding = join(project, ".tasks", "manager-dialog.json");
  const chatBinding = join(project, ".tasks", "manager-dialog.json");
  const idleGoalActions: BoardGoalAction[] = [];
  let providerHistoryReads = 0;
  let legacyHistory: (cursor: string | null) => ReturnType<typeof readBoardHistory> = async () => {
    throw new Error("Codex history unavailable.");
  };
  const runningTasks = new Set<string>();
  const boardListeners = new Set<(tasks: Task[]) => void>();
  const subscriptions = new Map();
  const agentSlots = createAgentSlots();
  agentSlots.claim = (project, task) => registerRuntime(project, { kind: "task", task },
    entries => !entries.some(entry => entry.kind !== "queue" && entry.task === task));
  let clearGoalError: string | undefined;
  const executorNotifications: string[] = [];
  const managerNotifications: string[] = [];
  const questionNotifications: { title: string; body: string; click?: () => void; closed?: boolean }[] = [];
  const windowStates = new Map();
  let reviewSubmission = async (context: any, _call: RunAction, _settings?: ChatSettings | null): Promise<unknown> => ({
    summary: "Reviewed submission.", findings: [], needsHuman: false,
    evidence: context.criteria.map(() => "Independently verified by the reviewer fixture."),
  });
  const activeAgents = new Map<string, { control: { steer: (text: string) => Promise<void> } }>();
  const sender = { isDestroyed: () => true };
  const runtime = runInNewContext(handlerSource + "\n({ frame, scheduleAutoReview, boardRequests, boardWorkRequests, backgroundManagerRequests, acceptanceWork, managerQuestion, runBoardRequest, scheduleRecurringTasks })", {
    scheduleAutoBoard: () => {}, scheduleDraftDiscussions: () => {},
    activeRunSummary, runActivityByTask: new Map(), replyingTasks: new Set(), projectLabels: () => [], recentBoards: [], russian: true, theme: "dark",
    captureFileLink, isFileLink, verifyFileLink, AbortSignal, AbortController, ArrayBuffer, Buffer, Error, basename, dirname, extname, join, mkdtemp, rm, writeFile, maxAttachmentBytes, boardActions, boardInstructions, boardTools, callCli,
    githubReadTool, readBoardGitHub: (cwd: string, args: unknown) => callCli(cwd, ["github-read"], args),
    executorFullAccess, managerAccess, setTaskExecutorAccess, phaseStageReporter,
    autoReviewInstructions, autoReviewReadTools, autoReviewTaskTools, manualReviewInstructions, boardReviewMode, reviewsAcceptanceRepair, usesIndependentReviewer, defaultBoardAgents, reviewVerifier,
    existsSync, storageDirectory, readdirSync, rmSync, randomUUID, readJson, writeJson, saveReviewReports, withReviewerChat, reviewerActivity,
    goalMessages, hasManagerMessage, managerChatItems, managerUnread, managerWorkItems, readManagerHistory, readManagerMessages, readManagerView, saveManagerHistory,
    send() {},
    readBoardHistory: (_profile: string, _project: string, _id: string, cursor: string | null) => {
      providerHistoryReads++;
      return legacyHistory(cursor);
    },
    codexThreadPattern, projectIdentity: (path: string) => path, windowStates, boardMcpTools,
    Notification: class {
      static isSupported() { return true; }
      private view: (typeof questionNotifications)[number];
      constructor(view: (typeof questionNotifications)[number]) { this.view = view; }
      on(_event: string, click: () => void) { this.view.click = click; }
      show() { questionNotifications.push(this.view); }
      close() { this.view.closed = true; }
    },
    activateTab: (owner: { active: unknown }, tab: unknown) => { owner.active = tab; },
    launchingTasks: new Set(), runningTasks, chatRuns: new Map(), activeAgents, managerInbox, needsManagerAttention, subscriptions, reviewerTools,
    process, closingProjects: new Set(), setImmediate, setTimeout, clearTimeout, performance, console, agentSlots, wait,
    russianWriting, isManual, manualContext, runtimeLocation, runtimeTransaction, readBoardSettings, settingsDelivery, syncSettingsNotices, automationDelivery,
    reviewWithCodex: async (_profile: string, cwd: string, settings: ChatSettings | null, context: string,
      tools: { name: string }[], call: RunAction, _signal: AbortSignal,
      onUsage: (report: import("../src/cli/token-usage.ts").TokenUsageReport) => Promise<void>) => {
      assert.equal(cwd, project);
      assert.deepEqual(Array.from(tools, tool => tool.name), ["task_review_diff", "task_review_artifact", "project_path", "project_sha256"]);
      const task = JSON.parse(context);
      const report = await reviewSubmission(task, call, settings);
      const confirmation = task.candidateReview || (report as { verifyRisk?: boolean })?.verifyRisk;
      if (task.title === "pass" || task.title === "fail" || confirmation) {
        const id = randomUUID();
        await onUsage({ id, sequence: 1, records: [{ threadId: id, turnId: id,
          model: confirmation ? settings?.model ?? "reviewer-fixture" : "reviewer-fixture", incomplete: false,
          totalTokens: 2, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }] });
      }
      return report;
    },
    observeBoardTasks: (_board: unknown, listener: (tasks: Task[]) => void) => {
      boardListeners.add(listener);
      return () => { boardListeners.delete(listener); };
    },
    updateBoardGoal: async (_profile: string, cwd: string, id: string, action: BoardGoalAction) => {
      assert.equal(cwd, project);
      assert.equal(id, threadId);
      idleGoalActions.push(action);
      if (clearGoalError) throw new Error(clearGoalError);
      return null;
    },
    launchTask: async (cwd: string, id: string, review?: { input: unknown }, newThread?: false | "manager", revision?: number, _retryDisconnect?: boolean, _scheduled?: boolean, resolveConflicts?: boolean) => {
      if (review) {
        const revised = await callCli(cwd, ["request-changes", id], review.input);
        if (!revised.ok) return revised;
        revision = revised.data.revision;
      }
      if (newThread === "manager") {
        const resumed = await callCli(cwd, ["resume", id], { revision, reason: "Continuing in a new chat." });
        if (!resumed.ok) return resumed;
        revision = resumed.data.revision;
      }
      const result = await callCli(cwd, ["start", id], { revision, resolveConflicts });
      return result.ok ? { ok: true, data: result.data.task } : result;
    },
    tmpdir: () => folder, stateOf: () => ({ project, board: { project, settings: {} } }), app: { getPath: () => folder }, cliFailure, t: (key: string, parameters = {}) => localization.text(key, parameters, "en"), localization,
    beginOperation: () => ({ controller: new AbortController(), finish() {} }),
    ipcMain: { handle: (name: string, callback: (...args: unknown[]) => Promise<any>) => { handlers.set(name, callback); } },
    replyToBoard: async (_profile: string, cwd: string, prompt: string, images: string[], action: RunAction,
      _tools: unknown, instructions: string, _signal: AbortSignal,
      session: { id?: string; title: string; save: (id: string) => void; attachmentContext?: string; mcpTools: { name: string; description: string }[];
        role?: "manager" | "reviewer"; separateTurn?: boolean; readOnly?: boolean; access?: ManagerAccess; confirmApproval?: (details: string) => Promise<boolean>;
        onWaiting: (waiting: boolean) => void; onTurnEnded: () => void; goal?: string; resumeGoal?: boolean; onGoalSet: () => void;
        onControl: (control: { steer: (text: string, images: string[], id?: string) => Promise<void>; interrupt: () => Promise<void> }) => void;
        onMessage: (id: string) => void; onActivity: (items: RunActivity[]) => void;
        onGoalControl: (control: GoalControl) => void; onGoal: (goal: BoardGoal | null) => void; settings?: ChatSettings | null }) => {
      assert.equal(cwd, project);
      assert.ok(instructions.includes(russianWriting));
      const manualTurn = instructions.includes("Обычная доска личных дел");
      const reviewTurn = Boolean(session.readOnly || session.separateTurn);
      const cleanupTurn = instructions.includes("private maintenance run");
      if (manualTurn) assert.match(instructions, /Пользователь сам меняет статусы/);
      else {
        assert.match(instructions, /Before accepting, check whether the project or task needs any evidence after acceptance/);
        assert.match(instructions, /verify the paths and checksums/);
      }
      if (!reviewTurn && !manualTurn && !cleanupTurn) {
        assert.match(instructions, /reviewer approval can unblock dependent work.*before dispatching more independent work/);
        assert.match(instructions, /Lifecycle cleanup and its diagnostics are internal/);
        assert.match(instructions, /only what changes the recipient's work/);
        assert.match(session.mcpTools.find(tool => tool.name === "task_message")!.description, /only what this executor needs to act/);
      }
      assert.equal(session.title, "Project manager for project");
      const expectedTools = cleanupTurn ? ["task_cleanup_status", "task_cleanup", "project_path", "project_sha256"] : manualTurn ? ["expert_list", "expert_context", "expert_skill", "ask_user", "tag_set_color", "github_read"] : reviewTurn ? [
        "expert_list", "expert_context", "expert_skill", "team_inbox", "team_message", "team_findings",
        "task_review", "task_review_diff", "task_review_artifact", "task_accept", "task_request_changes", "project_git", "project_path", "project_sha256",
      ] : [
        "expert_list", "expert_context", "expert_skill", "expert_plan", "team_inbox", "team_message", "team_findings",
        "board_auto_queue", "task_cancel", "provider_tools", "task_tool_grant", "task_tool_revoke", "task_set_executor_access", "ask_user", "manager_inbox", "manager_ack", "task_message", "task_start", "task_start_batch", "task_approve", "task_wait", "task_review_queue", "task_review", "task_review_diff",
        "task_review_artifact", "task_accept", "task_request_changes",
        "task_cleanup_status", "task_cleanup", "project_git", "project_git_push",
        "milestones_list", "github_create_milestone", "github_set_milestone_due", "task_set_milestone", "tag_set_color", "github_read",
      ];
      const mode = boardReviewMode((await callCli(project, ["settings"], undefined, false)).data);
      assert.deepEqual(Array.from(session.mcpTools, tool => tool.name).sort(),
        [...expectedTools.filter(name => (name !== "task_accept" || mode !== "human") && (!instructions.includes("This turn repairs") || !["task_start", "task_start_batch", "task_accept", "task_request_changes"].includes(name))),
        ...(!manualTurn && !cleanupTurn && !instructions.includes("This turn repairs") ? ["task_return_to_draft"] : []),
        ...(!manualTurn && !cleanupTurn && mode === "manager" ? ["expert_stage", "expert_verify_skills"] : []),
        ...(!reviewTurn && !cleanupTurn && !instructions.includes("This turn repairs") ? (session.goal || session.resumeGoal ? ["goal_inbox", "goal_report"] : ["goal_read", "goal_send"]) : []),
        ...(reviewTurn && mode === "reviewer" ? ["manager_ack", "task_cancel", "task_start"] : [])].sort());
      if (reviewTurn) {
        assert.doesNotMatch(instructions, /manager_inbox|task_cleanup_status/);
        assert.equal(session.attachmentContext, undefined);
        assert.equal(session.separateTurn, true);
        assert.equal((_tools as unknown[]).length, 0);
      }
      const newThread = reviewTurn ? dialogueId :
        session.goal || session.resumeGoal ? threadId : dialogueId;
      if (!session.id) session.save(newThread);
      return respond(action, prompt, images, session.id, session.attachmentContext && JSON.parse(session.attachmentContext),
        session.onWaiting, _signal, { objective: session.goal, resume: session.resumeGoal, accepted: session.onGoalSet, delivered: session.onMessage,
          controls: session.onGoalControl, update: session.onGoal, activity: session.onActivity,
          role: session.role, settings: session.settings, endTurn: session.onTurnEnded, access: session.access, confirmApproval: session.confirmApproval,
          enableNotifications: steer => session.onControl({
            steer: async (text, images, id) => {
              if (steer) await steer(text, images);
              else managerNotifications.push(text);
              if (id) session.onMessage(id);
            }, interrupt: async () => {},
          }) });
    },
  });
  const reviewing = () => runtime.frame({ project, board: subscriptions.get(project)?.board, window: { webContents: {} } }).reviewingTasks;
  return {
    folder, project, threadId, dialogueId, binding, chatBinding, idleGoalActions, cliCalls, boardListeners, executorNotifications, managerNotifications,
    reviewing, agentSlots, failGoalClear: (message?: string) => { clearGoalError = message; },
    repair: (task: Task, reply: Reply) => {
      respond = reply;
      return runtime.runBoardRequest(sender, { project, tasks: [task] }, "Repair this acceptance", [], false, false, undefined, undefined, undefined, false, task);
    },
    cleanup: (job: import("../src/cli/maintenance-state.ts").MaintenanceJob, reply: Reply) => {
      respond = reply;
      return runtime.runBoardRequest(sender, { project, tasks: [] }, "Repair private lifecycle cleanup", [], false, false, undefined, undefined, undefined, false, undefined, job);
    },
    busyDecisions,
    setReviewer: (runner: typeof reviewSubmission) => { reviewSubmission = runner; },
    schedule: (board: any, reply: Reply) => {
      respond = reply;
      const watch = { board, reviewerRuns: new Map<string, Promise<void>>(), reviewAttempts: new Map(),
        integrationAttempts: new Map(), reviewReports: new Map(), tabs: new Set([{
        window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
      }]) };
      subscriptions.set(project, watch);
      return {
        tick: () => runtime.scheduleAutoReview(watch),
        acceptanceTick: () => runtime.scheduleRecurringTasks(),
        runChanged: () => { for (const listener of boardListeners) listener(watch.board); },
        reloadReviewReports: () => { watch.reviewReports = readReviewReports(folder, project); return watch.reviewReports; },
        reviewing,
        refresh: async () => { watch.board = (await callCli(project, ["list", "--compact"])).data; },
        done: async () => {
          await Promise.all(watch.reviewerRuns.values());
          while (runtime.backgroundManagerRequests.has(project) || runtime.acceptanceWork.size) {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
          }
        },
      };
    },
    connectExecutor: (id: string) => activeAgents.set(project + "\0" + id, {
      control: { steer: async text => { executorNotifications.push(text); } },
    }),
    setRunning: (id: string, running: boolean) => running ? runningTasks.add(project + "\0" + id) : runningTasks.delete(project + "\0" + id),
    pushBoard: async () => {
      const board = await callCli(project, ["list", "--compact"]);
      subscriptions.set(project, { board: board.data, reviewerRuns: new Map(), reviewAttempts: new Map(),
        integrationAttempts: new Map(), reviewReports: new Map(), tabs: new Set() });
      for (const listener of boardListeners) listener(board.data);
      runtime.boardWorkRequests.get(project)?.automationChanged?.(board.data);
      runtime.boardRequests.get(project)?.automationChanged?.(board.data);
    },
    cli: (args: string[], input?: unknown) => callCli(project, args, input),
    run: (request: string, reply: Reply, files: unknown[] = [], goal: boolean | "resume" = false, id?: string) => {
      respond = reply;
      return handlers.get("board:request")!({ sender }, request, files, undefined, goal, false, id);
    },
    stop: () => handlers.get("board:stopOrchestrator")!({ sender }),
    history: (cursor?: string, view?: string) => handlers.get("board:history")!({ sender }, project, cursor, view),
    setLegacyHistory: (reader: typeof legacyHistory) => { legacyHistory = reader; },
    markRead: (ids: string[], board = project) => handlers.get("board:readManagerMessages")!({ sender }, board, ids),
    providerHistoryReads: () => providerHistoryReads,
    pendingQuestion: () => runtime.managerQuestion(project)?.view,
    answerQuestion: (id: string, answer: string | null) => handlers.get("board:answerQuestion")!({ sender }, id, answer),
    backgroundWindow: () => {
      const tab = { board: { project }, project };
      const goalActivity: boolean[] = [];
      const managerRuns: ({ phase: string; item?: Partial<RunActivity> } | null)[] = [];
      const state = { tabs: [tab], active: undefined as unknown, window: {
        isDestroyed: () => false, isMinimized: () => true, isFocused: () => false,
        restore() {}, show() {}, focus() {}, webContents: {
          send(channel: string, update: { type?: string; goalRunning?: boolean; managerWork?: typeof managerRuns[number] }) {
            if (channel === "chat:update" && update.type === "orchestrator-goal" && update.goalRunning !== undefined) {
              goalActivity.push(update.goalRunning);
            }
            if (channel === "chat:update" && update.type === "orchestrator-run" && update.managerWork !== undefined) {
              managerRuns.push(structuredClone(update.managerWork));
            }
          },
        },
      } };
      windowStates.set(1, state);
      const managerRun = () => runtime.frame({ project, board: { project, tasks: [] }, window: { webContents: {} } }).managerWork;
      return { state, tab, notifications: questionNotifications, goalActivity, managerRuns, managerRun };
    },
    sendNow: (request: string, files: unknown[] = [], id?: string, goalRunId?: string) =>
      handlers.get("board:request")!({ sender }, request, files, undefined, false, true, id, goalRunId),
    queue: (action: string, ...args: unknown[]) => handlers.get("board:queue")!({ sender }, project, action, ...args),
    goal: (kind: string, objective?: string) => handlers.get("board:goal")!({ sender }, kind, objective),
  };
}

test("manual manager edits personal tasks but cannot launch or move them", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"], { boardType: "manual" })).ok, true);
  const result = await f.run("Plan the week", async act => {
    const created = await act("task_create", { title: "Buy groceries" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.data.id;
    const shown = await act("task_show", { id });
    const updated = await act("task_update", { id, revision: shown.data.revision, description: "Milk", note: "User plan" });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.data.status, shown.data.status);
    for (const name of ["task_start", "task_approve", "task_cancel", "task_accept"]) {
      const blocked = await act(name, { id, revision: updated.data.revision });
      assert.equal(blocked.error.code, "MANUAL_BOARD");
    }
    const board = await act("board_list", {});
    assert.equal(board.data.boardType, "manual");
    assert.ok(board.data.statuses.some((s: { id: string }) => s.id === shown.data.status));
    return { text: "Week planned." };
  });
  assert.equal(result.data?.answer, "Week planned.", JSON.stringify(result));
});

test("manager can set and read the board tag palette in HEX", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: card } = await f.cli(["create"], plannedDraft({ title: "Verify tag color", tags: ["Интеграции"] }));
  const result = await f.run("Set the tag color", async act => {
    const saved = await act("tag_set_color", { name: "интеграции", color: "#217d79" });
    assert.equal(saved.data.name, "Интеграции");
    assert.equal(saved.data.color, "#217D79");
    const invalid = await act("tag_set_color", { name: "Интеграции", color: "teal" });
    assert.equal(invalid.error.code, "INVALID_INPUT");
    const { data: board } = await act("board_list", {});
    assert.equal(board.tagColors["Интеграции"], "#217D79");
    assert.equal(board.tasks[0].tags[0], "Интеграции");
    assert.equal(board.tasks[0].revision, card.revision);
    return { text: "Tag color saved." };
  });
  assert.equal(result.data?.answer, "Tag color saved.", JSON.stringify(result.error ?? result.data?.error));
});

test("a goal controls the persistent automatic queue and receives live board changes", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"], { git: false })).ok, true);
  assert.equal((await f.cli(["settings"], { autoMode: true, reviewMode: "reviewer" })).ok, true);
  const first = (await f.cli(["create"], plannedDraft({ title: "First slice", criteria: ["First result"] }))).data;
  const second = (await f.cli(["create"], plannedDraft({ title: "Second slice", criteria: ["Second result"] }))).data;
  await f.cli(["approve", first.id]); await f.cli(["approve", second.id]);
  await f.pushBoard();
  let queueRevision = 0;
  const notifications: string[] = [];
  const received = Promise.withResolvers<void>();
  const result = await f.run("Prepare a release with automatic dispatch", async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.accepted();
    goal!.update({ objective: "Prepare a release", status: "active" });
    const initial = await act("board_auto_queue", {});
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.data.enabled, true);
    const controlled = await act("board_auto_queue", { revision: initial.data.queue.revision, order: [second.id, first.id], hold: [first.id] });
    assert.equal(controlled.ok, true, JSON.stringify(controlled));
    queueRevision = controlled.data.queue.revision;
    assert.equal((await act("board_auto_queue", { revision: 0, paused: true })).error.code, "REVISION_CONFLICT");
    goal!.enableNotifications(async text => {
      notifications.push(text);
      if (text.includes('"status":"in_progress"')) received.resolve();
    });
    const waiting = act("task_wait", {});
    for (let attempt = 0; !f.boardListeners.size && attempt < 50; attempt++) await wait(10);
    assert.equal(f.boardListeners.size, 1, "an automatic goal can wait before any executor is known");
    const snapshot = (await f.cli(["show", second.id])).data;
    const started = await f.cli(["start", second.id], { revision: snapshot.revision, autoMode: true, autoQueueRevision: queueRevision });
    assert.equal(started.ok, true, JSON.stringify(started));
    f.setRunning(second.id, true);
    await f.pushBoard();
    await Promise.race([received.promise, wait(5000).then(() => assert.fail("No live automation update"))]);
    assert.equal((await waiting).error.code, "USER_MESSAGE_RECEIVED");
    assert.ok(notifications.some(text => text.includes(second.id) && text.includes('"running":true')));
    const paused = await act("board_auto_queue", { revision: queueRevision, paused: true });
    assert.equal(paused.ok, true);
    assert.equal((await f.cli(["show", second.id])).data.status, "in_progress");
    goal!.update({ objective: "Prepare a release", status: "paused" });
    return { text: "Queue planned and automatic work observed." };
  }, [], true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.cli(["settings"])).data.autoMode, true);
  const saved = (await f.cli(["auto-queue"])).data;
  assert.equal(saved.paused, true);
  assert.deepEqual(saved.order, [second.id, first.id]);
  const before = notifications.length;
  await f.pushBoard(); await wait(400);
  assert.equal(notifications.length, before, "the completed turn removes its live subscription");
});

test("manager grants and revokes executor access for a task", async t => {
  const f = fixture(t);
  const initialized = await f.cli(["init"]);
  assert.ok(initialized.ok);
  const card = (await f.cli(["create"], plannedDraft({ title: "Run an Electron check", criteria: ["The window loads."],
    workingDirectory: initialized.data.project }))).data;
  const accepted = (await f.cli(["approve", card.id])).data;
  const started = (await f.cli(["start", card.id])).data.task;
  assert.equal(started.status, "in_progress");
  const request = await f.cli(["message", card.id], { kind: "question", text: "Electron fails its sandbox startup check. Can I use full access?" });
  assert.ok(request.ok);
  const reply = await f.run("Handle executor requests", async act => {
    const inbox = await act("manager_inbox", { replay: true });
    assert.match(JSON.stringify(inbox), /Electron fails its sandbox startup check/);
    const args = { id: card.id, revision: started.revision, fullAccess: true };
    const rejected = await act("task_set_executor_access", { ...args, revision: accepted.revision });
    assert.equal(rejected.error.code, "REVISION_CONFLICT");
    const granted = await act("task_set_executor_access", args);
    assert.deepEqual(granted.data, { ...args, appliesOn: "next-run" });
    assert.equal((await act("task_show", { id: card.id })).data.executorFullAccess, true);
    const revoked = await act("task_set_executor_access", { ...args, fullAccess: false });
    assert.equal(revoked.data.fullAccess, false);
    assert.equal((await act("task_show", { id: card.id })).data.executorFullAccess, false);
    return { text: "Executor settings verified." };
  });
  assert.ok(reply.ok, JSON.stringify(reply.error));
});

test("manager milestone tools use the board origin and return per-card results", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: card } = await f.cli(["create"], plannedDraft({ title: "Remove old release task" }));
  const { data: closed } = await f.cli(["cancel", card.id], { reason: "Obsolete" });
  const result = await f.run("Clear the milestone from this card", async act => {
    const listed = await act("milestones_list", {});
    assert.equal(listed.error.code, "GITHUB_REMOTE_REQUIRED");
    const { data: board } = await act("board_list", {});
    assert.equal(board.tasks[0].revision, closed.revision);
    const assigned = await act("task_set_milestone", { tasks: [{ id: card.id, revision: closed.revision }], milestone: null });
    assert.ok(assigned.ok, JSON.stringify(assigned.error));
    assert.equal(assigned.data.tasks[0].data.status, "cancelled");
    return { text: "No milestone is set." };
  });
  assert.equal(result.data?.answer, "No milestone is set.", JSON.stringify(result.error ?? result.data?.error));
});

test("manager routes GitHub milestone writes through the board host", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  for (const goal of [false, true]) {
    const reply = await f.run("Set the deadline of GitHub milestone #1 to 2026-11-20", async (act, _prompt, _images, _id, _context, _waiting, _signal, work) => {
      if (goal) work!.accepted();
      const result = await act("github_set_milestone_due", { repository: "owner/example", number: 1, dueDate: "2026-11-20" });
      assert.equal(result.error.code, "GITHUB_REMOTE_REQUIRED");
      const created = await act("github_create_milestone", { repository: "owner/example", title: "Next" });
      assert.equal(created.error.code, "GITHUB_REMOTE_REQUIRED");
      return { text: "No GitHub origin." };
    }, [], goal);
    assert.ok(reply.ok, JSON.stringify(reply.error));
  }
  assert.equal(f.cliCalls.filter(([name]) => name === "github-milestone-due").length, 2);
  assert.equal(f.cliCalls.filter(([name]) => name === "github-milestone-create").length, 2);
});

test("GitHub read is routed to the board host on new and continued manager requests", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  for (const goal of [false, false, true]) {
    const reply = await f.run("Read origin", async (act, _prompt, _images, _id, _context, _waiting, _signal, work) => {
      if (goal) work!.accepted();
      const result = await act("github_read", { view: "repository" });
      assert.equal(result.error.code, "GITHUB_REMOTE_REQUIRED");
      return { text: "No GitHub origin." };
    }, [], goal);
    assert.ok(reply.ok, JSON.stringify(reply.error));
  }
  assert.equal(f.cliCalls.filter(([name]) => name === "github-read").length, 3);
});

test("a manager question returns the user's answer to the active request exactly once", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const { state, tab, notifications } = f.backgroundWindow();
  const shown = Promise.withResolvers<void>();
  const request = f.run("Continue the goal", async act => {
    const reply = act("ask_user", { question: "Which session?", options: ["Windows", "Linux"] });
    shown.resolve();
    assert.equal((await act("ask_user", { question: "Another question?" })).error.code, "QUESTION_PENDING");
    assert.equal((await reply).data.answer, "Windows, but tomorrow");
    return { text: "Understood." };
  });
  await shown.promise;
  const question = f.pendingQuestion();
  assert.equal(question.text, "Which session?");
  assert.deepEqual(Array.from(question.options), ["Windows", "Linux"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, question.text);
  notifications[0].click?.();
  assert.equal(state.active, tab);
  assert.equal((await f.answerQuestion("other", "Linux")).error.code, "QUESTION_CLOSED");
  assert.equal((await f.answerQuestion(question.id, " ")).error.code, "INVALID_INPUT");
  assert.equal((await f.answerQuestion(question.id, " Windows, but tomorrow ")).ok, true);
  assert.equal((await f.answerQuestion(question.id, "Linux")).error.code, "QUESTION_CLOSED");
  assert.equal(notifications[0].closed, true);
  const result = await request;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.answer, "Understood.");
  assert.equal(f.pendingQuestion(), undefined);
});

test("manager manual approval asks the user and accepts only one of the displayed decisions", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  managerAccess(f.folder, f.project, "ask");
  const shown = Promise.withResolvers<void>();
  const request = f.run("Check the project", async (_action, _prompt, _images, _id, _context, _waiting, _signal, manager) => {
    assert.equal(manager?.access, "ask");
    const decision = manager!.confirmApproval!("Get-ChildItem");
    shown.resolve();
    assert.equal(await decision, true);
    return { text: "Done." };
  });
  await shown.promise;
  const question = f.pendingQuestion();
  assert.equal(question.approval, true);
  assert.equal(question.text, "Get-ChildItem");
  assert.equal((await f.answerQuestion(question.id, "yes")).error.code, "INVALID_INPUT");
  assert.equal((await f.answerQuestion(question.id, "Allow once")).ok, true);
  assert.equal((await request).ok, true);
  assert.equal(f.pendingQuestion(), undefined);
});

test("a board snapshot with auto-review on wakes the manager once per submitted revision", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const goalBinding = { provider: "codex", id: f.threadId, goal: { objective: "Saved goal", status: "active" } };
  writeJson(f.binding, goalBinding);
  let calls = 0;
  let activity: () => Record<string, string>;
  const respond: Parameters<typeof f.schedule>[1] = async (act, message, _images, _id, _context, _waiting, _signal, goal) => {
    calls++;
    assert.deepEqual(Object.entries(activity()), []);
    assert.ok(goal);
    goal.enableNotifications();
    assert.deepEqual(Object.entries(activity()), [["T-0001", "manager"]]);
    assert.match(message, /automatic review.*T-0001/i);
    assert.equal((await act("task_create", { title: "Unrelated task" })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_review", { id: "T-0002" })).error.code, "INVALID_INPUT");
    if (calls === 1) {
      goal.endTurn();
      assert.deepEqual(Object.keys(activity()), []);
    }
    return { text: "Waiting for human judgment." };
  };
  const board = { project: join(f.folder, "project"), settings: { reviewMode: "human" },
    tasks: [{ id: "T-0001", status: "review", revision: 7, expertReviewPlanned: true }] };
  const watch = f.schedule(board, respond);
  activity = watch.reviewing;
  watch.tick();
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(watch.reviewing()), []);
  await f.cli(["settings"], { reviewMode: "manager" });
  board.settings.reviewMode = "manager";
  f.setRunning("T-0001", true);
  watch.tick();
  assert.equal(calls, 0);
  await watch.done();
  f.setRunning("T-0001", false);
  const releaseManager = f.agentSlots.acquire(f.project, "manager");
  assert.ok(releaseManager);
  watch.tick();
  assert.deepEqual(Object.keys(watch.reviewing()), []);
  assert.equal(calls, 0);
  releaseManager();
  watch.tick();
  watch.tick();
  await watch.done();
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(watch.reviewing()), []);
  watch.tick();
  assert.equal(calls, 1);
  board.tasks[0].revision++;
  watch.tick();
  await watch.done();
  assert.equal(calls, 2);
  assert.deepEqual(readJson(f.binding), goalBinding);
});

test("manager has no configurable capacity limit and shares one board context", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const configured = await f.cli(["settings"], { taskLimits: { manager: 1 } });
  assert.equal(configured.error.code, "INVALID_INPUT");
  f.agentSlots.configure({ executor: 1, manager: 1, reviewer: 1 });
  const release = f.agentSlots.acquire(f.project, "manager")!;
  assert.equal(f.agentSlots.available(f.project, "manager", { manager: 1 }), Infinity);
  assert.equal((await f.run("Discuss", async () => ({ text: "Ready" }))).ok, true);
  const goal = await f.run("Coordinate release", async (_act, _prompt, _images, id) => {
    assert.equal(id, f.dialogueId);
    return { text: "Same context" };
  }, [], true);
  assert.equal(goal.ok, true, JSON.stringify(goal));
  release();
});

test("manager can route a draft to Luna or Sol without changing board defaults", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const routed = await f.run("Assign a small inventory", async (act, _prompt, _images, _id, _context, _waiting, _signal, session) => {
    assert.deepEqual(session?.settings, defaultBoardAgents.manager);
    const execution = { model: "gpt-6-luna", effort: "high" };
    const created = await act("task_create", plannedDraft({ title: "Inventory fixtures", execution }));
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const { id, revision } = created.data;
    assert.deepEqual((await f.cli(["show", id])).data.execution, execution);
    const invalid = await act("task_update", { id, revision, note: "Change execution settings.",
      execution: { model: "gpt-6-astra", effort: "high" } });
    assert.equal(invalid.error.code, "INVALID_INPUT");
    const escalated = await act("task_update", { id, revision, note: "Use extra reasoning for the cross-module inventory.",
      execution: reviewVerifier });
    assert.equal(escalated.ok, true, JSON.stringify(escalated.error));
    assert.deepEqual((await f.cli(["show", id])).data.execution, reviewVerifier);
    return { text: "Routed." };
  });
  assert.equal(routed.data?.answer, "Routed.", JSON.stringify(routed));
  assert.deepEqual((await f.cli(["settings"])).data.executor, defaultBoardAgents.executor);
});

test("reviewer-human uses the shared review queue with and without automatic mode", { timeout: 120_000 }, async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  f.agentSlots.configure({ executor: 1, manager: 1, reviewer: 1 });
  for (const autoMode of [false, true]) {
    assert.equal((await f.cli(["settings"], { reviewMode: "reviewer-human", autoMode, reviewer: { model: "fixture", effort: "low" } })).ok, true);
    const ids: string[] = [];
    const submit = async (id: string) => {
      const { data: preview } = await f.cli(["preview", id]);
      assert.equal((await f.cli(["submit", id], { token: preview.token, noChanges: true,
        summary: "External result", checks: ["Read the result"] })).ok, true);
    };
    for (const title of ["First", "Second"]) {
      const { data: task } = await f.cli(["create"], plannedDraft({ title, criteria: ["Check the result"] }));
      await f.cli(["approve", task.id]);
      assert.equal((await f.cli(["start", task.id])).ok, true);
      await submit(task.id);
      ids.push(task.id);
    }
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    f.setReviewer(async ({ id }) => {
      calls.push(id);
      if (calls.length === 1) await release.promise;
      const findings = id === ids[1] && calls.filter(call => call === id).length === 1 ? ["Fix the result"] : [];
      return { summary: "Reviewed", findings, needsHuman: false, evidence: ["Checked"] };
    });
    const schedule = async () => f.schedule((await f.cli(["list", "--compact"])).data,
      async () => assert.fail("Hybrid approval must not dispatch manager integration"));
    const queue = await schedule();
    queue.tick();
    for (let i = 0; !calls.length && i < 250; i++) await wait(20);
    try {
      assert.equal(calls.length, 1);
      assert.equal(Object.keys(queue.reviewing()).length, 1);
      queue.tick();
      assert.equal(calls.length, 1);
    } finally {
      release.resolve();
    }
    await queue.done();
    await queue.refresh();
    queue.tick();
    await queue.done();
    assert.equal(calls.length, 2);
    const first = calls[0];
    assert.equal((await f.cli(["show", first])).data.status, "review");
    const returned = await f.cli(["show", ids[1]]);
    assert.equal(returned.data.status, "in_progress");
    await submit(ids[1]);
    await queue.refresh();
    queue.tick();
    await queue.done();
    assert.equal(calls.length, 3);
    const restarted = await schedule();
    restarted.tick();
    await restarted.done();
    assert.equal(calls.length, 3);
    for (const id of ids) {
      const { data } = await f.cli(["review", id, "--compact"]);
      assert.equal(data.awaitingHumanAcceptance, true);
    }
  }
});

test("reviewers agree to submissions or return defects, and the manager controls integration", { timeout: 240_000 }, async t => {
  const f = fixture(t);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Taskboard");
  git("config", "user.email", "taskboard@example.invalid");
  git("config", "maintenance.auto", "false");
  git("commit", "--allow-empty", "-m", "Initial commit");
  await f.cli(["init"]);
  const model = { provider: "codex", model: "review-model", effort: "xhigh" };
  await f.cli(["settings"], { reviewMode: "reviewer", reviewer: model });
  await writeFile(join(project, ".git", "info", "exclude"), "\n/review.log\n", { flag: "a" });
  const tasks: Task[] = [];
  for (const name of ["pass", "fail", "hold-a", "hold-b", "queued"]) {
    const { data: task } = await f.cli(["create"], plannedDraft({ title: name, criteria: ["Expected content exists."] }));
    assert.equal((await f.cli(["approve", task.id])).ok, true);
    const { data: started } = await f.cli(["start", task.id]);
    const noChanges = name !== "pass" && name !== "fail";
    if (!noChanges) await writeFile(join(started.worktree, name + ".txt"), name + "\n");
    if (name === "fail") await writeFile(join(started.worktree, "review.log"), "Original check\n");
    const { data: preview } = await f.cli(["preview", task.id]);
    const submitted = await f.cli(["submit", task.id], {
      token: preview.token, ...(noChanges ? { noChanges } : { message: "feat: test " + name }),
      summary: name, checks: ["Checked the test content."], ...(name === "fail" ? { artifacts: ["review.log"] } : {}),
    });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    tasks.push(submitted.data);
  }
  const release = Promise.withResolvers<void>();
  const releaseFailure = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const reviewed = new Set<string>();
  let passReviews = 0;
  let failReviews = 0;
  f.setReviewer(async ({ id, title, revision, targetHead, previousReview }, call, settings) => {
    assert.deepEqual(settings, model);
    reviewed.add(id);
    if (reviewed.size === 4) started.resolve();
    if (title === "pass") {
      if (++passReviews === 1) await release.promise;
      else {
        assert.equal(previousReview.report.summary, "pass");
        assert.notEqual(previousReview.targetHead, targetHead);
        assert.deepEqual(previousReview.changes, { paths: ["new-target.txt"], total: 1 });
        const targetComparison = { id, revision, targetHead, paths: ["new-target.txt"], comparison: "previous-target", contextLines: 0 };
        const targetDelta = await call("task_review_diff", targetComparison);
        assert.equal(targetDelta.ok, true, JSON.stringify(targetDelta));
        assert.match(targetDelta.data.diff, /\n\+Unrelated change\n/);
        const citedLine = await call("task_review_diff", { ...targetComparison, line: 1, lineRadius: 0 });
        assert.equal(citedLine.ok, true, JSON.stringify(citedLine));
        assert.match(citedLine.data.diff, /\n\+Unrelated change\n/);
        assert.match(citedLine.data.diff, /\n@@ -0,0 \+1,1 @@/);
        const unchangedLine = await call("task_review_diff", { ...targetComparison, line: 2 });
        assert.equal(unchangedLine.ok, true, JSON.stringify(unchangedLine));
        assert.equal(unchangedLine.data.diff, "");
        const wrongTargetPath = await call("task_review_diff", { ...targetComparison, paths: ["pass.txt"] });
        assert.equal(wrongTargetPath.error.code, "INVALID_INPUT");
        const wrongTargetHead = await call("task_review_diff", { ...targetComparison, targetHead: previousReview.targetHead });
        assert.equal(wrongTargetHead.ok, false);
      }
    }
    if (title === "pass" || title === "fail") {
      const diff = await call("task_review_diff", { id, revision, targetHead, paths: [title + ".txt"], contextLines: 0 });
      assert.ok(diff.ok && diff.data.diff.includes("+" + title), JSON.stringify(diff));
    }
    if (title === "pass" && passReviews === 1) {
      const unavailable = await call("task_review_diff", { id, revision, targetHead, paths: ["pass.txt"], comparison: "previous-target" });
      assert.equal(unavailable.error.code, "REVIEW_REQUIRED");
    }
    if (title === "pass" && passReviews === 2) {
      const unavailable = await call("task_review_diff", { id, revision, targetHead, paths: ["pass.txt"], comparison: "previous-submission" });
      assert.equal(unavailable.error.code, "REVIEW_REQUIRED");
    }
    if (title.startsWith("hold-")) await release.promise;
    if (title === "fail" && ++failReviews === 1) await releaseFailure.promise;
    if (title === "fail" && failReviews === 2) {
      assert.deepEqual(previousReview.report.findings, ["Fix the missing content."]);
      assert.equal(previousReview.submitted, tasks[1].git?.submission?.sha);
      assert.deepEqual(previousReview.submissionChanges, { paths: ["fail.txt"], total: 1 });
      assert.equal(previousReview.artifacts, undefined);
      assert.deepEqual(previousReview.addedArtifacts, [{
        source: "review.log", sha256: createHash("sha256").update("Rechecked the fix\n").digest("hex"),
      }]);
      assert.deepEqual(previousReview.removedArtifacts, []);
      const delta = await call("task_review_diff", { id, revision, targetHead, paths: ["fail.txt"],
        comparison: "previous-submission", contextLines: 0 });
      assert.equal(delta.ok, true, JSON.stringify(delta));
      assert.match(delta.data.diff, /\n-fail\n\+fail fixed\n/);
      const wrongPath = await call("task_review_diff", { id, revision, targetHead, paths: ["*.txt"],
        comparison: "previous-submission" });
      assert.equal(wrongPath.error.code, "INVALID_INPUT");
      const tagged = await f.cli(["update", id], { revision, tags: ["reviewed"] });
      assert.equal(tagged.ok, true);
      await watch.refresh();
      watch.tick();
      return { summary: "Verified the fix.", findings: [], evidence: ["Fixed file inspected."], needsHuman: false };
    }
    if (title === "queued") queued.resolve();
    return { summary: title, needsHuman: title !== "pass" && title !== "fail",
      findings: title === "fail" ? ["Fix the missing content."] : [],
      evidence: [title === "pass" ? "Verified in submitted diff." : null] };
  });
  const { data: board } = await f.cli(["list", "--compact"]);
  const notified = new Set<string>();
  f.busyDecisions.set("review-approve " + tasks[0].id, 2);
  f.busyDecisions.set("request-changes " + tasks[1].id, 2);
  const handleApproval: Parameters<typeof f.schedule>[1] = async (act, prompt) => {
    assert.match(prompt, /reviewer approved these submissions/i);
    const messages = [];
    for (const [, id, sequence] of prompt.matchAll(/(T-\d+) \((\d+)\)/g)) {
      assert.ok(!notified.has(id));
      const { data: review } = await act("task_review", { id });
      assert.ok(review.reviewerApproval);
      messages.push({ id, through: Number(sequence) });
      notified.add(id);
    }
    assert.equal((await act("manager_ack", { messages: [...messages, { id: "T-9999", through: 1 }] })).error.code, "INVALID_INPUT");
    assert.equal((await act("manager_ack", { messages })).ok, true);
    return { text: "Integrate these submissions later." };
  };
  const watch = f.schedule(board, handleApproval);
  f.setRunning(tasks[1].id, true);
  watch.tick();
  assert.deepEqual(Object.entries(watch.reviewing()), [[tasks[0].id, "reviewer"]]);
  const taskLimits = { reviewer: 4 };
  assert.equal((await f.cli(["settings"], { taskLimits })).ok, true);
  board.settings.taskLimits = taskLimits;
  watch.tick();
  try {
    const startupTimeout = AbortSignal.timeout(10_000);
    const timedOut = new Promise<never>((_, reject) => startupTimeout.addEventListener("abort",
      () => reject(startupTimeout.reason), { once: true }));
    await Promise.race([started.promise, watch.done(), timedOut]);
    assert.deepEqual([...reviewed].sort(), tasks.slice(0, 4).map(task => task.id));
    assert.deepEqual(Object.entries(watch.reviewing()), tasks.slice(0, 4).map(task => [task.id, "reviewer"]));
    releaseFailure.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.boardListeners.size, 1);
    assert.ok(!f.cliCalls.some(([action, id]) => action === "request-changes" && id === tasks[1].id));
    f.setRunning(tasks[1].id, false);
    watch.runChanged();
    await Promise.race([queued.promise, timedOut]);
    assert.equal(watch.reviewing()[tasks[1].id], undefined);
    assert.equal(watch.reviewing()[tasks[4].id], "reviewer");
    const { data: returned } = await f.cli(["show", tasks[1].id]);
    assert.equal(returned.status, "in_progress");
    assert.equal(returned.history.findLast((event: any) => event.action === "request-changes").actor, "reviewer");
    assert.equal(returned.tokenUsage.byModel[0].totalTokens, 2);
    assert.equal(f.cliCalls.filter(([action, id]) => action === "token-usage" && id === returned.id).length, 0);
    await writeFile(join(project, "new-target.txt"), "Unrelated change\n");
    git("add", "new-target.txt");
    git("commit", "-m", "Advance target during review");
  } finally {
    f.setRunning(tasks[1].id, false);
    watch.runChanged();
    release.resolve();
    releaseFailure.resolve();
    await watch.done();
  }
  assert.deepEqual(Object.keys(watch.reviewing()), []);
  const { data: approved } = await f.cli(["show", tasks[0].id]);
  assert.equal(approved.status, "review");
  assert.equal(approved.git.accepted, undefined);
  assert.equal(existsSync(join(project, "pass.txt")), false);
  const { data: messages } = await f.cli(["manager-inbox"]);
  const approval = messages.find((message: { id: string; kind: string }) => message.id === approved.id && message.kind === "review-approve");
  assert.equal(approval?.actor, "reviewer");
  assert.equal(approval.target, "refs/heads/main");
  assert.equal(approval.commit, undefined);
  const returnedNotice = messages.find((message: { id: string }) => message.id === tasks[1].id);
  assert.equal(returnedNotice?.kind, "request-changes");
  assert.equal(returnedNotice.actor, "reviewer");
  assert.equal(returnedNotice.text, "Fix the missing content.");
  assert.equal(passReviews, 2);
  const { data: approvedMetrics } = await f.cli(["metrics", approved.id]);
  assert.equal(approvedMetrics.reviews.length, 1);
  const [measuredReview] = approvedMetrics.reviews;
  assert.equal(measuredReview.decision, null);
  assert.equal(measuredReview.reviewerAttempts.length, 2);
  for (const attempt of measuredReview.reviewerAttempts) {
    assert.ok(attempt.durationMs >= 0);
    assert.equal(attempt.tokens, 2);
    assert.equal(attempt.tokensIncomplete, false);
  }
  assert.equal(measuredReview.reviewerAttempts[0].decisionTiming, undefined);
  const decisionTiming = measuredReview.reviewerAttempts[1].decisionTiming;
  assert.ok(Number.isSafeInteger(decisionTiming.lockWaitMs) && decisionTiming.lockWaitMs >= 0);
  assert.ok(Number.isSafeInteger(decisionTiming.verificationMs) && decisionTiming.verificationMs >= 0);
  assert.ok(measuredReview.submissionToReviewerMs >= 0);
  assert.equal(approvedMetrics.tokens.total, 4);
  assert.equal(f.cliCalls.filter(([action, id]) => action === "token-usage" && id === approved.id).length, 1);
  assert.equal(existsSync(f.binding), false);
  await watch.refresh();
  watch.tick();
  await watch.done();
  assert.deepEqual([...notified], [approved.id]);
  f.setRunning(tasks[4].id, true);
  const readReturnPrompt = "Read review feedback while waiting for another executor";
  const readReturn = await f.run(readReturnPrompt, async (act, prompt, images) => {
    if (prompt !== readReturnPrompt) return handleApproval(act, prompt, images);
    const { data: wait } = await act("task_wait", { ids: [tasks[4].id] });
    assert.ok(wait.tasks[0].running);
    assert.equal(wait.timedOut, false);
    assert.deepEqual(wait.inbox.find((message: { id: string }) => message.id === tasks[1].id), returnedNotice);
    assert.ok(!(await act("manager_inbox", {})).data.some((message: { id: string }) => message.id === tasks[1].id));
    return { text: "Read review feedback." };
  });
  assert.equal(readReturn.ok, true, JSON.stringify(readReturn.error));
  f.setRunning(tasks[4].id, false);
  assert.equal((await f.cli(["manager-ack", tasks[1].id], { through: returnedNotice.sequence })).ok, true);
  assert.ok(!(await f.cli(["manager-inbox"])).data.some((message: { id: string }) => message.id === tasks[1].id));
  const repaired = tasks[1];
  const savedReports = watch.reloadReviewReports();
  assert.equal(savedReports.get(repaired.id)?.snapshot, undefined);
  assert.deepEqual(savedReports.get(repaired.id)?.report.findings, ["Fix the missing content."]);
  await writeFile(join(repaired.git!.worktree!, "fail.txt"), "fail fixed\n");
  await writeFile(join(repaired.git!.worktree!, "review.log"), "Rechecked the fix\n");
  const { data: preview } = await f.cli(["preview", repaired.id]);
  const submitted = await f.cli(["submit", repaired.id], {
    token: preview.token, message: "fix: supply missing content", summary: "Fixed", checks: ["Checked the repaired file."],
    artifacts: ["review.log"],
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await watch.refresh();
  watch.tick();
  await watch.done();
  watch.tick();
  await watch.done();
  const repairedCard = (await f.cli(["show", repaired.id])).data;
  assert.equal(repairedCard.status, "review");
  assert.equal(repairedCard.history.at(-1).action, "review-approve");
  assert.deepEqual((await f.cli(["manager-inbox"])).data
    .filter((message: { id: string }) => message.id === repaired.id)
    .map((message: { kind: string }) => message.kind), ["review-approve"]);
  assert.deepEqual(repairedCard.tags, ["reviewed"]);
  assert.equal(failReviews, 2);
  await watch.refresh();
  watch.tick();
  await watch.done();
  assert.deepEqual([...notified].sort(), [approved.id, repaired.id].sort());
  await watch.refresh();
  watch.tick();
  await watch.done();
  const head = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "Advance after review approval");
  const managed = await f.run("Integrate pass and defer the other submission", async act => {
    const { data: review } = await act("task_review", { id: approved.id });
    assert.equal(review.reviewerApproval.targetHead, head);
    assert.deepEqual(review.reviewerApproval.evidence, ["Verified in submitted diff."]);
    const reference = { id: approved.id, revision: review.revision, targetHead: review.targetHead, integrationMode: "squash" };
    assert.equal((await f.cli(["accept", approved.id], { ...reference, actor: "reviewer" })).error.code, "REVIEW_MODE_CHANGED");
    assert.equal((await act("task_accept", { ...reference, targetHead: head })).error.code, "REVIEW_REQUIRED");
    const accepted = await act("task_accept", reference);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.equal(accepted.data.status, "done");
    return { text: "Integrated pass. The repaired submission can wait." };
  });
  assert.equal(managed.ok, true, JSON.stringify(managed.error));
  assert.equal(managed.data.error, undefined);
  assert.equal(readFileSync(join(project, "pass.txt"), "utf8").trim(), "pass");
  assert.equal(git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 2);
  assert.equal((await f.cli(["show", repaired.id])).data.status, "review");
  assert.equal((await f.cli(["metrics", approved.id])).data.reviews[0].decisionActor, "manager");
});

const file = (name: string, type: string, content: string) => ({ name, type, bytes: new TextEncoder().encode(content).buffer });

test("dialogue results filter coordination on completion, interruption and partial failure while history retains work", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  for (const outcome of ["complete", "interrupt", "failure"]) {
    const { data: messageId } = await f.queue("add", undefined, outcome, false, []);
    const items = ["manager_inbox", "task_wait", "task_message"].map((tool, index) => ({
      id: outcome + tool, type: "mcpToolCall", title: "ai_taskboard / " + tool, text: "PRIVATE RESULT", status: "completed",
      messagesOnly: tool !== "task_wait",
      messages: [{ id: "T-0001", sequence: index + 1, actor: index === 0 ? "agent" : index === 1 ? "reviewer" : "manager", text: "PRIVATE MESSAGE" }],
    }));
    const result = await f.run(outcome, async (_act, _prompt, _images, _id, _context, _waiting, _signal, session) => {
      session!.delivered(messageId);
      session!.activity(items);
      if (outcome === "interrupt") return { interrupted: true };
      if (outcome === "failure") throw new Error("Provider disconnected");
      return { text: "Public reply" };
    }, [], false, messageId);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.items.some((item: any) => item.messages?.length || item.messagesOnly || item.text.includes("PRIVATE")), false);
    if (outcome === "complete") assert.equal(result.data.items.at(-1).text, "Public reply");
  }
  const chat = (await f.history(undefined, "chat")).data.turns;
  assert.equal(chat.flatMap((turn: any) => turn.items).some((item: any) => item.messages?.length || item.text.includes("PRIVATE")), false);
  const work = (await f.history(undefined, "work")).data.turns.flatMap((turn: any) => turn.items);
  assert.equal(work.length, 9);
  assert.equal(work.flatMap((item: any) => item.messages).length, 9);
});

test("an interrupted manager request preserves the durable queue until Codex records the message", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const attachments = [file("план.txt", "text/plain", "Сохрани русский текст")];
  const { data: id } = await f.queue("add", undefined, "Исходный текст", false, attachments);
  assert.equal((await f.queue("edit", id, "Новый текст")).ok, true);
  const result = await f.run("Новый текст", async () => ({ interrupted: true }), attachments, false, id);
  assert.equal(result.data.keepQueued, true);
  const [saved] = (await f.queue("list")).data;
  assert.equal(saved.id, id);
  assert.equal(saved.draft, "Новый текст");
  assert.equal(saved.files[0].name, "план.txt");
  assert.equal(new TextDecoder().decode(saved.files[0].bytes), "Сохрани русский текст");
  assert.equal(saved.failed, true);
  assert.equal((await f.queue("retry", id)).ok, true);
  const queuePath = join(f.project, ".tasks", "manager-queue", id + ".json");
  const queuedBeforeDelivery = readFileSync(queuePath);
  const sent = await f.run(saved.draft, async (_act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.delivered(id);
    assert.equal((await f.queue("list")).data.length, 0);
    return { interrupted: true };
  }, attachments, false, id);
  assert.equal(sent.data.keepQueued, false);
  // Recreate the state after a crash between the history write and queue removal.
  await writeFile(queuePath, queuedBeforeDelivery);
  assert.equal((await f.run(saved.draft, async () => assert.fail("Already delivered"), attachments, false, id)).ok, true);
  assert.equal((await f.queue("list")).data.length, 0);
  const archived = await f.history();
  assert.equal(archived.ok, true);
  assert.equal(archived.data.turns.length, 1);
  const messages = archived.data.turns[0].messages;
  assert.equal(messages.length, 1);
  const [{ at, ...message }] = messages;
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(message, { text: "Новый текст", clientId: id, files: [] });
  assert.equal(f.providerHistoryReads(), 0);
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId });
  const legacy = await f.history();
  assert.deepEqual(legacy.data.turns, archived.data.turns);
  assert.equal(f.providerHistoryReads(), 0);
  const paused = { objective: "Resume later", status: "paused" };
  writeJson(join(f.project, ".tasks", "orchestrator.json"), { provider: "codex", id: f.threadId, goal: paused });
  const withPausedGoal = await f.history();
  assert.deepEqual(withPausedGoal.data.goal, paused);
  assert.deepEqual(withPausedGoal.data.turns, archived.data.turns);
  assert.equal(f.providerHistoryReads(), 0);
  assert.equal((await f.history(legacy.data.nextCursor)).error.code, "BOARD_HISTORY_FAILED");
  assert.equal(f.providerHistoryReads(), 1);
});

test("work history continues from local pages to earlier provider operations", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const start = Date.now();
  const tool = (id: string, name: string, offset: number) => ({
    id, title: "ai_taskboard / " + name, type: "mcpToolCall", status: "completed",
    text: name, at: new Date(start + offset).toISOString(),
  });
  const local = tool("local", "task_cancel", 1);
  const cancel = tool("old-cancel", "task_cancel", -2);
  const message = tool("old-mail", "team_message", -1);
  const cursors: (string | null)[] = [];
  f.setLegacyHistory(async cursor => {
    cursors.push(cursor);
    const items = cursor === null ? [local] : cursor === "older" ? [message] : [cancel];
    return { model: undefined, goal: undefined,
      turns: [{ items, messages: [], durationMs: undefined }],
      nextCursor: cursor === null ? "older" : cursor === "older" ? "oldest" : null };
  });
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId });
  assert.equal((await f.history(undefined, "work")).data.turns[0].items[0].id, "local");
  cursors.length = 0;
  saveManagerHistory(f.project, start, randomUUID(), {
    lane: "chat", message: { text: "Cancel T-0001", files: [] }, items: [local],
  });
  for (let i = 1; i <= 20; i++) saveManagerHistory(f.project, start + i, randomUUID(), {
    lane: "notice", items: [{ id: "notice-" + i, type: "agentMessage", title: "", status: "completed", text: "Cancelled" }],
  });
  const first = await f.history(undefined, "work");
  assert.equal(first.data.turns.length, 20);
  assert.match(first.data.nextCursor, /^local:/);
  const lastLocal = await f.history(first.data.nextCursor, "work");
  assert.equal(lastLocal.data.turns[0].items[0].id, "local");
  assert.deepEqual(cursors, []);
  const provider = await f.history(lastLocal.data.nextCursor, "work");
  assert.deepEqual(cursors, [null, "older"]);
  assert.deepEqual(provider.data.turns[0].items, [message]);
  const last = await f.history(provider.data.nextCursor, "work");
  assert.deepEqual(last.data.turns[0].items, [cancel]);
  assert.equal(last.data.nextCursor, null);
  const chat = await f.history();
  assert.equal(chat.data.turns[0].messages[0].text, "Cancel T-0001");
  assert.deepEqual((await f.history(chat.data.nextCursor)).data.turns, []);
  const reopened = await f.history(undefined, "work");
  assert.deepEqual(reopened.data, first.data);
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId, history: "local" });
  assert.equal((await f.history(first.data.nextCursor, "work")).data.nextCursor, null);
});

test("only a background goal uses the longer board wait", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Running task" }));
  f.setRunning(task.id, true);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const delays: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    delays.push(ms);
    return timeout(0);
  });
  for (const goal of [false, true]) {
    const result = await f.run("Wait for the task", async (act, _text, _images, _id, _context, _waiting, _signal, session) => {
      if (goal) session!.update({ objective: "Wait for the task", status: "active" });
      const response = await act("task_wait", { ids: [task.id] });
      assert.equal(response.data.timedOut, true);
      assert.equal(f.boardListeners.size, 0);
      return { text: "Wait completed." };
    }, [], goal);
    assert.equal(result.data.answer, "Wait completed.");
  }
  assert.deepEqual(delays, [90_000, 300_000]);
});

test("send now steers the active manager with attachments and releases its executor wait", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Running task" }));
  f.setRunning(task.id, true);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent: { text: string; images: string[] }[] = [];
  const pending = f.run("Original request", async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.enableNotifications(async (text, images) => {
      if (text === "reject") throw new Error("No active turn.");
      sent.push({ text, images });
    });
    const waiting = act("task_wait", { ids: [task.id] });
    ready.resolve();
    assert.equal((await waiting).error.code, "USER_MESSAGE_RECEIVED");
    const created = await act("task_create", plannedDraft({ title: "Use attached notes", attachmentIds: [2] }));
    assert.equal(created.ok, true);
    assert.equal((await f.cli(["show", created.data.id])).data.attachments[0].name, "new.png");
    await release.promise;
    return { text: "Finished" };
  }, [file("old.txt", "text/plain", "old")]);
  try {
    await ready.promise;
    assert.equal((await f.sendNow("reject")).error.code, "CHAT_SEND_FAILED");
    assert.equal(f.boardListeners.size, 1);
    const id = "00000000-0000-4000-8000-000000000002";
    const attachments = [file("new.png", "image/png", "bytes")];
    assert.equal((await f.queue("add", id, "Черновик", false, attachments)).ok, true);
    assert.equal((await f.queue("edit", id, "Send this first")).ok, true);
    const [queued] = (await f.queue("list")).data;
    assert.equal(queued.draft, "Send this first");
    assert.equal(new TextDecoder().decode(queued.files[0].bytes), "bytes");
    assert.equal((await f.sendNow("Send this first", attachments, id)).ok, true);
    assert.equal((await f.queue("list")).data.length, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0].text).latestUserMessage, {
      text: "Send this first", attachments: [{ id: 2, name: "new.png", imageIndex: 1 }],
    });
    assert.match(sent[0].images[0], /^data:image\/png;base64,/);
  } finally {
    release.resolve();
  }
  assert.equal((await pending).ok, true);
  assert.equal((await f.sendNow("Too late")).error.code, "CHAT_NOT_RUNNING");
  assert.equal(f.boardListeners.size, 0);
});

test("manager reads Git information without modifying the repository", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  await writeFile(join(project, "tracked.txt"), "Original\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "-m", "Initial commit");
  const from = git("rev-parse", "HEAD");
  await writeFile(join(project, "tracked.txt"), "Committed edit\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "-m", "Commit for comparison");
  const to = git("rev-parse", "HEAD");
  await writeFile(join(project, "tracked.txt"), "Staged edit\n");
  git("add", "tracked.txt");
  await writeFile(join(project, "tracked.txt"), "Working edit\n");
  await writeFile(join(project, "untracked.txt"), "New file\n");
  await writeFile(join(project, ".gitattributes"), "tracked.txt filter=test diff=test\n");
  git("config", "filter.test.clean", "exit 1");
  git("config", "filter.test.required", "true");
  git("config", "diff.test.textconv", "exit 1");
  const indexPath = join(project, ".git", "index");
  const index = readFileSync(indexPath);
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId });
  const reply = await f.run("Проверь Git и свободное место", async (act, _text, _images, thread) => {
    assert.equal(thread, f.threadId);
    const status = await act("project_git", { view: "status" });
    assert.match(status.data.output, /## main[\s\S]*MM tracked\.txt[\s\S]*\?\? untracked\.txt/);
    assert.equal(status.data.branch, "main");
    assert.equal(status.data.head, to);
    assert.match(status.data.note, /filters were disabled/);
    assert.match((await act("project_git", { view: "log" })).data.output, /Initial commit/);
    assert.match((await act("project_git", { view: "diff" })).data.output, /\+Working edit/);
    assert.match((await act("project_git", { view: "staged_diff" })).data.output, /\+Staged edit/);
    const commit = await act("project_git", { view: "commit_diff", from, to, paths: ["tracked.txt"] });
    assert.equal(commit.ok, true);
    assert.match(commit.data.output, /\+Committed edit/);
    assert.doesNotMatch(commit.data.output, /Staged edit|Working edit/);
    assert.equal((await act("project_git", { view: "reset" })).error.code, "INVALID_INPUT");
    assert.equal((await act("project_git", { view: "status", path: ".." })).error.code, "INVALID_INPUT");
    return { text: "Проверил." };
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(reply.data.changes.length, 0);
  assert.deepEqual(readFileSync(indexPath), index);
  assert.equal(existsSync(indexPath + ".lock"), false);
});

test("manager pushes a pinned local branch to its configured remote without a confirmation", async t => {
  const f = fixture(t);
  const project = join(f.folder, "project");
  const remote = join(f.folder, "remote.git");
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(project, "init", "-b", "main");
  git(project, "config", "user.name", "Taskboard");
  git(project, "config", "user.email", "taskboard@example.invalid");
  git(project, "commit", "--allow-empty", "-m", "Initial commit");
  assert.equal((await f.cli(["init"])).ok, true);
  const first = git(project, "rev-parse", "HEAD");
  git(project, "commit", "--allow-empty", "-m", "Publishable commit");
  git(project, "tag", "-a", "local-only", "-m", "Do not include this tag");
  git(project, "config", "push.followTags", "true");

  const reply = await f.run("Опубликуй текущую ветку", async act => {
    const { branch, head } = (await act("project_git", { view: "status" })).data;
    const push = { branch, head };
    assert.equal((await act("project_git_push", push)).error.code, "GIT_REMOTE_REQUIRED");
    git(f.folder, "init", "--bare", "-b", "main", remote);
    git(project, "remote", "add", "origin", remote);
    assert.equal((await act("project_git_push", { branch, head: first })).error.code, "STALE_REPOSITORY");
    assert.equal((await act("project_git_push", { ...push, force: true })).error.code, "INVALID_INPUT");

    const published = await act("project_git_push", push);
    assert.equal(published.ok, true, JSON.stringify(published.error));
    const { gitInfo, ...destination } = published.data;
    assert.deepEqual(destination, { ...push, remote: "origin", remoteRef: "refs/heads/main" });
    assert.equal(gitInfo.upstream, "refs/heads/main");
    assert.deepEqual(gitInfo.tracking, { ahead: 0, behind: 0 });
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), head);
    assert.equal(git(remote, "tag", "--list"), "");
    assert.equal((await act("project_git_push", push)).ok, true);

    git(project, "config", "branch.main.remote", "origin");
    git(project, "config", "branch.main.merge", "refs/heads/integration");
    const upstream = await act("project_git_push", push);
    assert.equal(upstream.ok, true, JSON.stringify(upstream.error));
    assert.equal(upstream.data.remoteRef, "refs/heads/integration");
    assert.equal(git(remote, "rev-parse", "refs/heads/integration"), head);

    git(project, "switch", "-c", "diverged", first);
    git(project, "commit", "--allow-empty", "-m", "Diverging commit");
    const diverged = git(project, "rev-parse", "HEAD");
    git(project, "config", "branch.diverged.remote", "origin");
    git(project, "config", "branch.diverged.merge", "refs/heads/integration");
    const rejected = await act("project_git_push", { branch: "diverged", head: diverged });
    assert.equal(rejected.error.code, "GIT_PUSH_FAILED");
    assert.match(rejected.error.details.output, /\[rejected\]/);
    assert.equal(git(remote, "rev-parse", "refs/heads/integration"), head);
    return { text: "Проверил отправку." };
  });
  assert.ok(reply.ok, JSON.stringify(reply.error));
  assert.equal(reply.data.answer, "Проверил отправку.");
  assert.equal(reply.data.changes.length, 0);
});

test("manager adopts expert roles, loads a board skill and plans an addressed specialist team", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const reply = await f.run("Подготовь команду спринта", async act => {
    const experts = await act("expert_list", {});
    assert.equal(experts.ok, true); assert.equal(experts.data.length, 220);
    const context = await act("expert_context", { ids: ["business-analyst", "product-owner"] });
    assert.equal(context.ok, true); assert.equal(context.data.length, 2);
    const skill = await act("expert_skill", { expertId: "product-owner", skillId: "workflow" });
    assert.equal(skill.ok, true); assert.match(skill.data.directory, /experts[\\/]product-owner[\\/]skills/);
    const stages = [
      { key: "analysis", expertId: "business-analyst", title: "Requirements", criteria: ["Acceptance criteria"], outputs: ["requirements.md"] },
      { key: "test", expertId: "qa-engineer", title: "Tests", criteria: ["Requirements covered"], inputs: ["requirements.md"], outputs: ["test-plan.md"], dependsOn: ["analysis"] },
    ];
    const brief = { title: "Sprint", description: "Prepare requirements and a test plan.", criteria: ["Both plans are ready."] };
    const incomplete = await act("task_create", brief);
    assert.equal(incomplete.error.code, "EXPERT_PLAN_REQUIRED");
    assert.equal((await act("board_list", {})).data.tasks.length, 0);
    const planned = await act("task_create", { ...brief,
      expertTeam: { work: { lead: "product-owner", reason: "Coordinate requirements and test planning.", stages },
        review: { lead: "qa-engineer", reason: "One QA specialist can verify both outputs.", stages: [] } } });
    assert.equal(planned.ok, true, JSON.stringify(planned.error));
    const parent = planned.data;
    assert.equal(parent.revision, 1);
    const saved = await act("task_show", { id: parent.id });
    assert.equal(saved.data.expertTeam.work.stages[1].dependsOn[0], stages[0].key);
    const sent = await act("team_message", { id: parent.id, to: parent.id, kind: "decision", text: "Start with the EU market" });
    assert.equal(sent.ok, true, JSON.stringify(sent.error));
    const inbox = await act("team_inbox", { id: parent.id });
    assert.equal(inbox.ok, true); assert.equal(inbox.data.messages[0].from, "manager");
    assert.equal(inbox.data.expertTeam.work.stages.length, 2);
    const finding = { symptom: "Test target is unavailable", environment: "QA on Windows",
      cause: "The selected test uses a Linux-only fixture.", verification: "Reproduced on both target platforms." };
    const recorded = await act("team_findings", { id: parent.id, finding });
    assert.equal(recorded.ok, true, JSON.stringify(recorded.error));
    assert.equal(recorded.data.taskId, parent.id);
    assert.deepEqual((await act("team_findings", { query: "Linux-only Windows" })).data, [recorded.data]);
    return { text: "Команда подготовлена." };
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(existsSync(join(f.project, ".codex")), false);
  assert.equal(existsSync(join(f.project, ".claude")), false);
});

test("manager inspects and hashes project paths without access outside the project", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const project = join(f.folder, "project");
  const artifacts = join(project, "artifacts");
  const outside = join(f.folder, "outside");
  mkdirSync(artifacts);
  mkdirSync(outside);
  await writeFile(join(artifacts, "пакет test.bin"), Buffer.from([0, 255, 13, 10, 65]));
  await writeFile(join(artifacts, ".hidden"), "");
  const large = join(project, "many");
  mkdirSync(large);
  await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(join(large, String(index)), "")));
  await writeFile(join(outside, "data.bin"), "outside");
  await symlink(outside, join(project, "external"), process.platform === "win32" ? "junction" : "dir");
  const reply = await f.run("Проверь каталог и пересчитай SHA-256 пакета", async act => {
    for (const path of [".taskboard", ".taskboard\\nested"]) {
      const checked = await act("project_path", { path });
      assert.equal(checked.ok, true);
      assert.equal(checked.data.exists, false);
    }
    assert.equal((await act("project_path", { path: ".tasks" })).data.kind, "directory");
    const root = await act("project_path", { path: ".", list: true });
    assert.equal(root.ok, true);
    assert.ok(root.data.entries.some((entry: { name: string; kind: string }) => entry.name === ".tasks" && entry.kind === "directory"));
    assert.ok(root.data.entries.some((entry: { name: string; kind: string }) => entry.name === "external" && entry.kind === "link"));
    const listing = (await act("project_path", { path: "artifacts", list: true })).data;
    assert.equal(listing.truncated, false);
    assert.equal(Array.from(listing.entries, (entry: { name: string }) => entry.name).sort().join(","), ".hidden,пакет test.bin");
    assert.equal((await act("project_path", { path: "artifacts\\пакет test.bin" })).data.kind, "file");
    const bounded = (await act("project_path", { path: "many", list: true })).data;
    assert.equal(bounded.entries.length, 200);
    assert.equal(bounded.truncated, true);
    for (const path of ["../outside", "external", "external/missing", artifacts, "C:relative.bin"]) {
      assert.equal((await act("project_path", { path, list: true })).error.code, "INVALID_INPUT");
    }
    assert.equal((await act("project_path", { path: "artifacts/.hidden", list: true })).error.code, "INVALID_INPUT");
    assert.equal((await act("project_path", { path: "artifacts/.hidden/child" })).error.code, "PROJECT_PATH_UNAVAILABLE");
    const digest = await act("project_sha256", { path: "artifacts\\пакет test.bin" });
    assert.equal(digest.ok, true, JSON.stringify(digest.error));
    assert.equal(digest.data.path, "artifacts/пакет test.bin");
    assert.equal(digest.data.sha256, "4259d3f5151edfc7205e3e7c3fde341e237968666aad8946dcbcf6a374502c60");
    const paths = ["artifacts\\пакет test.bin", "external/data.bin", "missing.bin", "artifacts/.hidden"];
    const batch = await act("project_sha256", { paths });
    assert.equal(batch.ok, true, JSON.stringify(batch.error));
    assert.deepEqual(Array.from(batch.data.files, (entry: { path: string }) => entry.path), paths);
    const [first, outside, missing, empty] = batch.data.files;
    assert.equal(first.data.sha256, digest.data.sha256);
    assert.equal(outside.error.code, "INVALID_INPUT");
    assert.equal(missing.error.code, "FILE_HASH_UNAVAILABLE");
    assert.equal(empty.data.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal((await act("project_sha256", { paths, path: paths[0] })).error.code, "INVALID_INPUT");
    assert.equal((await act("project_sha256", { paths: [paths[0], paths[0]] })).error.code, "INVALID_INPUT");
    for (const path of ["../outside/data.bin", "external/data.bin", join(artifacts, "пакет test.bin"), "C:relative.bin"]) {
      assert.equal((await act("project_sha256", { path })).error.code, "INVALID_INPUT");
    }
    for (const path of ["artifacts", "missing.bin"]) {
      assert.equal((await act("project_sha256", { path })).error.code, "FILE_HASH_UNAVAILABLE");
    }
    return { text: digest.data.sha256 };
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.equal(reply.data.changes.length, 0);
});

test("manager launches multiple tasks through the task start path and reports each result", async t => {
  const f = fixture(t);
  const initialized = await f.cli(["init"]);
  assert.equal(initialized.ok, true);
  const { data: first } = await f.cli(["create"], plannedDraft({ title: "First", criteria: ["First result"] }));
  const { data: second } = await f.cli(["create"], plannedDraft({ title: "Second", criteria: ["Second result"] }));
  const { data: draft } = await f.cli(["create"], plannedDraft({ title: "Draft", criteria: ["Draft result"] }));
  const { data: firstReady } = await f.cli(["approve", first.id]);
  const { data: secondReady } = await f.cli(["approve", second.id]);
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", join(f.folder, "project"), ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "--allow-empty", "-m", "Initial commit");
  const result = await f.run("Запусти задачи", async (act, _prompt, _images, thread) => {
    assert.equal(thread, f.threadId);
    assert.equal((await act("task_start", { id: first.id })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_start", { id: first.id, revision: firstReady.revision, newThread: "true" })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_start", { id: first.id, revision: first.revision })).error.code, "REVISION_CONFLICT");
    const launches = await Promise.all([
      act("task_start", { id: first.id, revision: firstReady.revision }),
      act("task_start", { id: second.id, revision: secondReady.revision }),
    ]);
    assert.deepEqual(launches.map(result => result.data.status), ["in_progress", "in_progress"]);
    assert.equal((await act("task_start", { id: first.id, revision: firstReady.revision })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_start", { id: draft.id, revision: draft.revision })).error.code, "INVALID_TRANSITION");
    const blocked = await f.cli(["block", first.id], { reason: "already has an active writer", condition: "Continue in a new chat." });
    const resumed = await act("task_start", { id: first.id, revision: blocked.data.revision, newThread: true });
    assert.equal(resumed.data.status, "in_progress");
    return { text: "Запущены две задачи." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(Array.from(result.data.changes, (change: { id: string; action: string }) => [change.id, change.action]),
    [[first.id, "start"], [second.id, "start"], [first.id, "start"]]);
  assert.deepEqual(readJson(f.chatBinding), { provider: "codex", id: f.threadId });
});

test("manager can create and dispatch a task in an existing working directory", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const result = await f.run("Сохрани проверку в указанной папке", async act => {
    const draft = (await act("task_create", plannedDraft({
      title: "Save a report", criteria: ["The report is present."], workingDirectory: f.folder,
    }))).data;
    const approved = (await act("task_approve", { id: draft.id, revision: draft.revision })).data;
    const launched = await act("task_start", { id: draft.id, revision: approved.revision });
    assert.equal(launched.data.status, "in_progress");
    const task = (await act("task_show", { id: draft.id })).data;
    assert.equal(task.workingDirectory, f.folder);
    assert.equal(task.git, undefined);
    return { text: "Запущено." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
});

test("the manager can approve drafts created while the goal was paused", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const objective = "Prepare the release";
  writeJson(f.binding, { provider: "codex", id: f.threadId, history: "local", goal: { objective, status: "paused" } });
  let pending: { id: string; revision: number } | undefined;
  const paused = await f.run("Prepare the release cards while the goal is paused.", async act => {
    assert.equal((await act("goal_read", {})).data.goal.status, "paused");
    const { data: draft } = await act("task_create", plannedDraft({ title: "Verify the release archive", criteria: ["The archive opens."] }));
    const { data: other } = await act("task_create", plannedDraft({ title: "Update release notes", criteria: ["The notes list user-visible changes."] }));
    pending = other;
    assert.equal((await f.cli(["show", draft.id])).data.goalThreadId, undefined);
    const approval = await act("task_approve", { id: draft.id, revision: draft.revision });
    assert.equal(approval.ok, true, JSON.stringify(approval.error));
    assert.equal(approval.data.status, "ready");
    assert.equal((await act("task_approve", { id: draft.id, revision: draft.revision })).error.code, "REVISION_CONFLICT");
    return { text: "Archive verification is ready to start." };
  });
  assert.equal(paused.ok, true, JSON.stringify(paused.error));
  assert.equal(paused.data.error, undefined);
  assert.ok(pending);
  const { id, revision } = pending;
  const resumed = await f.run("", async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.update({ objective, status: "active" });
    const approval = await act("task_approve", { id, revision });
    assert.equal(approval.ok, true, JSON.stringify(approval.error));
    assert.equal(approval.data.status, "ready");
    return { text: "Release notes are ready to start." };
  }, [], "resume");
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  assert.equal(resumed.data.error, undefined);
  const saved = (await f.cli(["show", id])).data;
  assert.equal(saved.status, "ready");
  assert.equal(saved.history.at(-1).actor, "manager");
});

test("a goal delegates a bounded slice, waits for submission, and reviews before local integration", { timeout: 150_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.cli(["settings"], { reviewMode: "manager" })).ok, true);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Taskboard");
  git("config", "user.email", "taskboard@example.invalid");
  git("commit", "--allow-empty", "-m", "chore: initialize");
  await writeFile(join(project, ".git", "info", "exclude"), "\n/report.local\n", { flag: "a" });
  const unrelated = (await f.cli(["create"], plannedDraft({ title: "Manual task", criteria: ["Manual review"] }))).data;
  const objective = "Cover every applicable public API in the project";
  let sliceId = "";
  const result = await f.run(objective, async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.update({ objective, status: "active" });
    assert.equal((await act("task_create", { title: "All coverage", description: objective, criteria: ["100%"] })).error.code, "GOAL_SLICE_REQUIRED");
    const slice = (await act("task_create", plannedDraft({
      title: "Cover empty names", description: "Specify the empty-name result in the parser.", criteria: ["Empty names return a validation error."],
    }))).data;
    sliceId = slice.id;
    assert.equal((await f.cli(["show", slice.id])).data.goalThreadId, f.threadId);
    const ready = (await act("task_approve", { id: slice.id, revision: slice.revision })).data;
    assert.equal(ready.status, "ready");
    const another = (await act("task_create", plannedDraft({
      title: "Cover missing config", description: "Specify behavior for an absent config file.", criteria: ["Missing config uses defaults."],
    }))).data;
    const anotherReady = (await act("task_approve", { id: another.id, revision: another.revision })).data;
    const { data: backlog } = await act("board_list", {});
    assert.equal(backlog.tasks.find((task: { id: string }) => task.id === another.id).revision, anotherReady.revision);
    assert.equal((await act("task_start_batch", { tasks: [
      { id: slice.id, revision: ready.revision }, { id: slice.id, revision: ready.revision },
    ] })).error.code, "INVALID_INPUT");
    const batch = (await act("task_start_batch", { tasks: [
      { id: slice.id, revision: ready.revision },
      { id: another.id, revision: anotherReady.revision },
      { id: unrelated.id, revision: unrelated.revision },
    ] })).data.tasks;
    assert.equal(batch[2].ok, false);
    const started = batch[0].data;
    assert.equal(started.status, "in_progress");
    assert.equal(batch[1].data.status, "in_progress");
    const { git: context } = (await f.cli(["show", slice.id])).data;
    f.setRunning(slice.id, true);
    f.setRunning(another.id, true);
    const wait = act("task_wait", { ids: [another.id] });
    assert.equal(f.boardListeners.size, 1);
    const routine = await f.cli(["message", slice.id], { kind: "update", text: "Parser work is in progress." });
    assert.equal(routine.ok, true);
    await f.pushBoard();
    const callsWhileRunning = f.cliCalls.length;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.cliCalls.length, callsWhileRunning);
    goal!.enableNotifications();
    const question = await f.cli(["message", slice.id], { kind: "question", text: "Should empty names return a validation error?" });
    assert.equal(question.ok, true);
    const callsBeforeNotification = f.cliCalls.length;
    await f.pushBoard();
    const notified = (await wait).data;
    assert.deepEqual(f.cliCalls.slice(callsBeforeNotification).map(args => args.join(" ")), ["list --compact"]);
    assert.equal(notified.timedOut, false);
    assert.equal(notified.tasks[0].id, another.id);
    assert.equal(notified.tasks[0].running, true);
    assert.deepEqual(notified.inbox.map(({ id, sequence }: { id: string; sequence: number }) => ({ id, sequence })),
      [{ id: slice.id, sequence: question.data.sequence }]);
    assert.equal((await act("manager_ack", { id: slice.id, through: routine.data.sequence })).ok, true);
    const unrelatedRead = await act("task_show", { id: another.id });
    assert.equal(unrelatedRead.data.id, another.id);
    assert.equal(unrelatedRead.unreadBoardAttention, undefined);
    const nextQuestion = await f.cli(["message", another.id], { kind: "question", text: "Can an empty config use the defaults?" });
    assert.equal(nextQuestion.ok, true);
    await f.pushBoard();
    const hint = (await act("task_show", { id: slice.id })).unreadBoardAttention;
    assert.equal(hint.count, 1);
    assert.equal(hint.messages[0].id, another.id);
    assert.equal(hint.messages[0].sequence, nextQuestion.data.sequence);
    assert.equal(f.managerNotifications.length, 0);
    await f.pushBoard();
    assert.equal(f.managerNotifications.length, 0);
    const unread = await act("manager_inbox", {});
    assert.equal(unread.data[0].kind, "question");
    assert.deepEqual(unread.data.map(({ id, sequence }: { id: string; sequence: number }) => ({ id, sequence })),
      [{ id: another.id, sequence: nextQuestion.data.sequence }]);
    assert.deepEqual((await act("manager_inbox", {})).data, []);
    assert.equal((await act("manager_inbox", { replay: "yes" })).error.code, "INVALID_INPUT");
    const replayed = await act("manager_inbox", { replay: true });
    assert.deepEqual(replayed.data.map(({ id, sequence }: { id: string; sequence: number }) => ({ id, sequence })),
      [{ id: slice.id, sequence: question.data.sequence }, { id: another.id, sequence: nextQuestion.data.sequence }]);
    assert.equal((await act("task_show", { id: slice.id })).unreadBoardAttention, undefined);
    f.connectExecutor(slice.id);
    const decisionText = "Проверь коммит `513affc` в ветке `main`.\nЗапусти `git status --short`.";
    const decision = await act("task_message", { id: slice.id, kind: "decision", text: decisionText,
      replyTo: question.data.sequence });
    assert.equal(decision.data.notified, true);
    assert.match(f.executorNotifications[0], /messages T-/);
    assert.ok(f.executorNotifications[0].includes(`message ${decision.data.sequence} for ${slice.id}`));
    assert.match(f.executorNotifications[0], /afterSequence/);
    const received = await f.cli(["messages", slice.id]);
    assert.equal(received.data[0].text, decisionText);
    assert.equal(decision.data.at, received.data[0].at);
    assert.ok(Number.isFinite(Date.parse(decision.data.at)));
    assert.equal(received.data[0].replyTo, question.data.sequence);
    const later = await f.cli(["manager-message", slice.id], { text: "Use the existing test fixture." });
    const additions = await f.cli(["messages", slice.id], { afterSequence: decision.data.sequence });
    assert.equal(later.data.at, additions.data[0].at);
    assert.deepEqual(additions.data.map(({ sequence }: { sequence: number }) => sequence), [later.data.sequence]);
    assert.deepEqual((await f.cli(["messages", slice.id], { afterSequence: later.data.sequence })).data, []);
    assert.equal((await f.cli(["messages", slice.id], { afterSequence: -1 })).error.code, "INVALID_INPUT");
    const ack = [{ id: slice.id, through: question.data.sequence }, { id: another.id, through: nextQuestion.data.sequence }];
    assert.equal((await act("manager_ack", { messages: [ack[0], { ...ack[1], through: 999 }] })).error.code, "INVALID_INPUT");
    assert.deepEqual((await f.cli(["manager-inbox"])).data.map((message: { id: string }) => message.id), [slice.id, another.id]);
    const callsBeforeAck = f.cliCalls.length;
    assert.deepEqual((await act("manager_ack", { messages: ack })).data, ack);
    assert.deepEqual(f.cliCalls.slice(callsBeforeAck).map(args => args.join(" ")), ["manager-ack"]);
    assert.deepEqual((await act("manager_inbox", {})).data, []);
    await f.pushBoard();
    assert.equal((await act("task_show", { id: another.id })).unreadBoardAttention, undefined);
    const queued = await act("task_message", { id: another.id, kind: "update", text: "Keep the default config unchanged." });
    assert.equal(queued.data.notified, false);
    assert.equal((await f.cli(["messages", another.id])).data[0].text, "Keep the default config unchanged.");
    assert.equal((await f.cli(["show", slice.id])).data.revision, started.revision);
    const reviewWait = act("task_wait", { id: another.id });
    const submit = async (content: string) => {
      await writeFile(join(context.worktree, "parser.txt"), content);
      await writeFile(join(context.worktree, "notes.txt"), "Unrelated review details\n");
      await writeFile(join(context.worktree, "report.local"), "Parser fixture output.\n");
      const { token } = (await f.cli(["preview", slice.id])).data;
      const response = await f.cli(["submit", slice.id], { token, message: "feat: cover empty names", summary: "Parser result",
        checks: ["Parser fixture passed"], artifacts: ["report.local"] });
      assert.equal(response.ok, true, JSON.stringify(response.error));
      return response.data;
    };
    const first = await submit("Empty name: ignored\n");
    assert.equal((await act("task_request_changes", { id: slice.id, revision: first.revision, reason: "Return a validation error." })).error.code, "CHAT_BUSY");
    await f.pushBoard();
    const waited = (await reviewWait).data;
    assert.equal(waited.timedOut, false);
    assert.equal(waited.id, another.id);
    assert.equal(waited.running, true);
    assert.equal(waited.summary, undefined);
    assert.equal(waited.nextStep, undefined);
    assert.equal(waited.inbox[0].id, slice.id);
    assert.equal(waited.inbox[0].kind, "submit");
    assert.equal(waited.inbox[0].text, "Parser result");
    assert.equal(waited.inbox[0].result, undefined);
    assert.equal((await act("task_show", { id: another.id })).unreadBoardAttention, undefined);
    assert.equal(f.boardListeners.size, 0);
    f.setRunning(slice.id, false);
    await f.pushBoard();
    const submittedState = (await act("task_wait", { id: slice.id })).data;
    assert.equal(submittedState.status, "review");
    assert.equal(submittedState.summary, undefined);
    assert.equal(submittedState.nextStep, undefined);
    assert.equal((await act("task_wait", { ids: [slice.id], reviewIds: [slice.id] })).error.code, "INVALID_INPUT");
    assert.equal((await act("manager_ack", { id: slice.id, through: waited.inbox[0].sequence })).ok, true);
    let decisionReceived = false;
    const decisionWait = act("task_wait", { ids: [another.id], reviewIds: [slice.id] }).then(result => {
      decisionReceived = true;
      return result;
    });
    await f.pushBoard();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(decisionReceived, false);
    assert.equal(f.boardListeners.size, 1);
    const paused = act("task_wait", { ids: [another.id] });
    goal!.update({ objective, status: "paused" });
    assert.equal((await paused).error.code, "ACTION_FAILED");
    assert.equal((await decisionWait).error.code, "ACTION_FAILED");
    goal!.update({ objective, status: "active" });
    assert.equal(f.boardListeners.size, 0);
    f.setRunning(another.id, false);
    const stopped = (await act("task_wait", { ids: [another.id] })).data.tasks[0];
    assert.equal(stopped.running, false);
    assert.equal(stopped.summary, "");
    assert.equal(stopped.nextStep, "");
    assert.equal((await act("task_accept", { id: slice.id, revision: first.revision, targetHead: "unreviewed", evidence: ["Checked parser.txt."] })).error.code, "REVIEW_REQUIRED");
    const summary = (await act("task_review", { id: slice.id })).data;
    assert.equal(summary.diff, undefined);
    assert.deepEqual(summary.paths, ["notes.txt", "parser.txt"]);
    assert.match((await act("task_review_diff", {
      id: slice.id, revision: summary.revision, targetHead: summary.targetHead, paths: ["parser.txt"],
    })).data.diff, /\+Empty name: ignored/);
    const callsBeforeReturn = f.cliCalls.length;
    const waitForReturn = act("task_wait", { reviewIds: [slice.id] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.boardListeners.size, 1);
    const retry = await act("task_request_changes", { id: slice.id, revision: summary.revision, reason: "Return a validation error for empty names." });
    assert.equal(retry.data.status, "in_progress");
    assert.deepEqual(f.cliCalls.slice(callsBeforeReturn).map(args => args[0]), ["list", "settings", "request-changes", "start"]);
    await f.pushBoard();
    const returned = (await waitForReturn).data;
    assert.equal(returned.timedOut, false);
    assert.equal(returned.tasks[0].status, "in_progress");
    assert.equal(f.boardListeners.size, 0);
    assert.deepEqual((await act("manager_inbox", {})).data, []);
    await submit("Empty name: validation error\n");
    return { text: "One slice sent for review." };
  }, [], true);
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result.data?.error));
  assert.equal(result.data.answer, "One slice sent for review.", result.data.error);
  assert.equal(f.boardListeners.size, 0);
  assert.equal((await f.cli(["settings"], { autoReview: false })).ok, true);
  const manual = await f.run("Prepare a recommendation for manual acceptance", async act => {
    const currentRevision = (await f.cli(["show", sliceId])).data.revision;
    const calls = f.cliCalls.length;
    const reviewed = await act("task_review", { id: sliceId, knownRevision: currentRevision });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed.error));
    const review = reviewed.data;
    assert.deepEqual(f.cliCalls.slice(calls).map(args => args[0]), ["review"]);
    assert.equal(review.reviewMode, "human");
    assert.equal(review.executorRunning, false);
    assert.equal(review.evidenceUnchanged, undefined);
    assert.equal(review.settings, undefined);
    assert.equal(review.reviewer, undefined);
    const revised = await act("task_update", {
      id: sliceId, revision: review.revision, criteria: ["Invalid empty names return an error."], note: "Clarify the criterion.",
    });
    assert.equal(revised.error.code, "STATUS_CHANGE_REQUIRED");
    const unchanged = (await act("task_show", { id: sliceId })).data;
    assert.equal(unchanged.status, "review");
    assert.equal(unchanged.revision, review.revision);
    assert.deepEqual(unchanged.criteria, review.criteria);
    const ref = { id: sliceId, revision: review.revision, targetHead: review.targetHead };
    const paths = ["parser.txt"];
    assert.equal((await act("task_review_diff", { ...ref, paths, revision: ref.revision + 1 })).error.code, "REVIEW_REQUIRED");
    assert.equal((await act("task_review_diff", { ...ref, paths, targetHead: "unreviewed" })).error.code, "REVIEW_REQUIRED");
    assert.match((await act("task_review_diff", { ...ref, paths })).data.diff, /\+Empty name: validation error/);
    const [{ source, sha256 }] = review.artifacts;
    assert.equal(review.artifacts.length, 1);
    assert.deepEqual(Object.keys(review.artifacts[0]).sort(), ["sha256", "source"]);
    const artifact = { id: sliceId, revision: ref.revision, source, sha256 };
    assert.equal((await act("task_review_artifact", artifact)).data.text, "Parser fixture output.\n");
    assert.equal((await act("task_review_artifact", { ...artifact, revision: ref.revision + 1 })).error.code, "REVIEW_REQUIRED");
    assert.equal((await act("task_review_artifact", { ...artifact, sha256: "0".repeat(64) })).error.code, "REVIEW_REQUIRED");
    assert.equal((await act("task_accept", { ...ref, evidence: ["Verified manually."] })).error.code, "AUTO_REVIEW_DISABLED");
    assert.equal((await act("task_request_changes", { id: sliceId, revision: ref.revision + 1, reason: "Return for review." })).error.code, "REVIEW_REQUIRED");
    f.setRunning(sliceId, true);
    const refreshed = await act("task_review", { id: sliceId, knownRevision: review.revision });
    assert.equal(refreshed.ok, true, JSON.stringify(refreshed.error));
    assert.equal(refreshed.data.executorRunning, true);
    assert.equal(refreshed.data.targetHead, review.targetHead);
    assert.equal(refreshed.data.evidenceUnchanged, true);
    assert.equal(refreshed.data.criteria, undefined);
    assert.equal(refreshed.data.result, undefined);
    assert.equal(refreshed.data.artifacts, undefined);
    assert.equal((await act("task_review_artifact", artifact)).data.text, "Parser fixture output.\n");
    const full = await act("task_review", { id: sliceId, knownRevision: review.revision + 1 });
    assert.deepEqual(full.data.criteria, review.criteria);
    assert.deepEqual(full.data.artifacts, review.artifacts);
    f.setRunning(sliceId, false);
    return { text: "Ready for a user decision." };
  });
  assert.equal(manual.ok, true, JSON.stringify(manual.error));
  assert.equal(manual.data.answer, "Ready for a user decision.");
  assert.equal((await f.cli(["settings"], { reviewMode: "manager" })).ok, true);
  f.setReviewer(async () => { throw new Error("Manager mode should not launch a reviewer."); });
  const ordinary = await f.run("Review the submission", async act => {
    await f.pushBoard();
    assert.deepEqual(Object.keys(f.reviewing()), []);
    assert.equal((await act("task_show", { id: sliceId })).unreadBoardAttention.messages[0].kind, "submit");
    const inbox = await act("manager_inbox", {});
    assert.deepEqual(inbox.data.map((message: { kind: string }) => message.kind), ["submit"]);
    assert.equal(inbox.data[0].text, "Parser result");
    assert.equal(inbox.data[0].result, undefined);
    const review = (await act("task_review", { id: sliceId })).data;
    assert.equal(review.reviewMode, "manager");
    assert.equal(f.reviewing()[sliceId], "manager");
    assert.equal(review.reviewer, undefined);
    assert.equal(review.diff, undefined);
    const diff = await act("task_review_diff", {
      id: sliceId, revision: review.revision, targetHead: review.targetHead, paths: ["parser.txt"],
    });
    assert.match(diff.data.diff, /\+Empty name: validation error/);
    assert.doesNotMatch(diff.data.diff, /notes\.txt|Unrelated review details/);
    assert.equal(review.result.checks[0], "Parser fixture passed");
    const update = await f.cli(["message", sliceId], { text: "The shared parser fixture is available for other tasks." });
    assert.equal(update.ok, true, JSON.stringify(update.error));
    const target = { id: sliceId, revision: review.revision, targetHead: review.targetHead };
    assert.equal((await f.cli(["accept", sliceId], { ...target, actor: "manager", reviewMode: "reviewer" })).error.code, "REVIEW_MODE_CHANGED");
    const callsBeforeAccept = f.cliCalls.length;
    assert.equal((await act("task_accept", { ...target, evidence: [] })).error.code, "VERIFICATION_REQUIRED");
    const accepted = await act("task_accept", { ...target, evidence: ["The submitted parser fixture explicitly returns a validation error for empty names."] });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.equal(accepted.data.status, "done");
    assert.equal(accepted.data.acceptedTreeMatchesSubmission, true);
    assert.deepEqual(f.cliCalls.slice(callsBeforeAccept).map(args => args[0]), ["settings", "settings", "accept"]);
    await f.pushBoard();
    assert.equal(f.reviewing()[sliceId], undefined);
    assert.deepEqual((await act("manager_inbox", {})).data.map((message: { sequence: number }) => message.sequence), [update.data.sequence]);
    return { text: "One slice integrated." };
  });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.error ?? ordinary.data?.error));
  assert.equal(ordinary.data.answer, "One slice integrated.");
  assert.equal(readFileSync(join(project, "parser.txt"), "utf8").trim(), "Empty name: validation error");
  const saved = (await f.cli(["show", sliceId])).data;
  assert.equal(saved.history.findLast((event: { action: string }) => event.action === "accept").actor, "manager");
  const followUp = await f.run("Check for unacknowledged messages", async act => {
    const card = await act("task_show", { id: sliceId });
    assert.equal(card.data.acceptedTreeMatchesSubmission, true);
    const inbox = await act("manager_inbox", {});
    assert.deepEqual(inbox.data.map((message: { text: string }) => message.text),
      ["The shared parser fixture is available for other tasks."]);
    return { text: "The prior update is still available." };
  });
  assert.equal(followUp.ok, true, JSON.stringify(followUp.error ?? followUp.data?.error));
  assert.equal(followUp.data.answer, "The prior update is still available.", followUp.data.error);
});

test("a reviewer leaves gaps on review and wakes the waiting manager on approval without Git changes", { timeout: 150_000 }, async t => {
  const f = fixture(t);
  const project = join(f.folder, "project");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("-c", "user.name=Taskboard", "-c", "user.email=taskboard@example.invalid", "commit", "--allow-empty", "-m", "Initial commit");
  const head = git("rev-parse", "HEAD");
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.cli(["settings"], { reviewMode: "human" })).ok, true);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Check local data", criteria: ["Obsolete folder is absent."] }));
  assert.equal((await f.cli(["approve", task.id])).ok, true);
  const started = await f.cli(["start", task.id]);
  assert.equal(started.ok, true);
  await writeFile(join(project, ".git", "info", "exclude"), "\n/report.local\n", { flag: "a" });
  await writeFile(join(started.data.worktree, "report.local"), "Verified result");
  const { data: preview } = await f.cli(["preview", task.id]);
  assert.equal((await f.cli(["submit", task.id], {
    token: preview.token, noChanges: true, summary: "Obsolete folder is absent", checks: ["Checked the project directory"],
  })).ok, true);
  const manual = await f.run("Review with human acceptance", async act => {
    f.setRunning(task.id, true);
    const queue = await act("task_review_queue", {});
    assert.equal(queue.ok, true, JSON.stringify(queue.error));
    assert.equal(queue.data.length, 1);
    assert.equal(queue.data[0].id, task.id);
    assert.equal(queue.data[0].executorRunning, true);
    assert.equal(queue.data[0].status, "noChanges");
    f.setRunning(task.id, false);
    const { data: review } = await act("task_review", { id: task.id });
    assert.equal(review.reviewMode, "human");
    assert.equal(review.reviewer, undefined);
    const reference = { id: task.id, revision: review.revision };
    assert.equal((await act("task_accept", { ...reference, targetHead: null, evidence: ["Checked."] })).error.code, "AUTO_REVIEW_DISABLED");
    assert.equal((await act("task_request_changes", { ...reference, revision: reference.revision + 1, reason: "Try again." })).error.code, "REVIEW_REQUIRED");
    assert.equal((await f.cli(["accept", task.id], { revision: review.revision, actor: "manager" })).error.code, "AUTO_REVIEW_DISABLED");
    return { text: "Awaiting human acceptance." };
  });
  assert.equal(manual.ok, true, JSON.stringify(manual.error));
  assert.equal((await f.cli(["settings"], { autoReview: true })).ok, true);
  assert.equal((await f.cli(["settings"])).data.reviewMode, "reviewer");
  let report = { summary: "The user must approve the result.", findings: [], evidence: ["Checked."] as (string | null)[], needsHuman: true, verifyRisk: false };
  const reviewModels: (ChatSettings | null | undefined)[] = [];
  f.setReviewer(async (context, call, settings) => {
    reviewModels.push(settings);
    if (settings?.model === reviewVerifier.model) {
      assert.deepEqual(settings, reviewVerifier);
      assert.deepEqual(context.candidateReview, report);
      return { ...report, verifyRisk: false };
    }
    assert.deepEqual(settings, defaultBoardAgents.reviewer);
    const result = await call("project_path", { path: "obsolete" });
    assert.equal(result.ok, true);
    assert.equal(result.data.exists, false);
    return report;
  });
  let managerCalls = 0;
  const runReview = async () => {
    const { data: board } = await f.cli(["list", "--compact"]);
    const watch = f.schedule(board, async () => { managerCalls++; return { text: "Unexpected manager call." }; });
    watch.tick();
    await watch.done();
    assert.deepEqual(Object.keys(watch.reviewing()), []);
    return (await f.cli(["show", task.id])).data;
  };
  const waiting = await runReview();
  assert.deepEqual(reviewModels, [defaultBoardAgents.reviewer]);
  assert.equal(waiting.status, "review");
  assert.equal(waiting.history.at(-1).action, "review-note");
  assert.equal(waiting.history.at(-1).actor, "reviewer");
  assert.equal(waiting.history.at(-1).text, report.summary);
  assert.equal((await runReview()).history.length, waiting.history.length);
  report = { ...report, summary: "The criterion is missing verification.", needsHuman: false, evidence: [null] };
  const missing = await runReview();
  assert.equal(missing.status, "review");
  assert.equal(missing.revision, waiting.revision);
  assert.equal(missing.history.at(-1).text, report.summary);
  const { data: unread } = await f.cli(["manager-inbox"]);
  assert.deepEqual(unread.map((message: { kind: string }) => message.kind), ["submit"]);
  assert.equal((await f.cli(["manager-ack", task.id], { through: unread[0].sequence })).ok, true);
  const { data: other } = await f.cli(["create"], plannedDraft({ title: "Independent work", criteria: ["Complete independent work."] }));
  assert.equal((await f.cli(["approve", other.id])).ok, true);
  assert.equal((await f.cli(["start", other.id])).ok, true);
  assert.equal((await f.cli(["settings"], { archiveAfterDays: 0 })).ok, true);
  f.setRunning(other.id, true);
  report = { ...report, summary: "Verified that the obsolete folder is absent.", evidence: ["The obsolete folder does not exist."], verifyRisk: true };
  const result = await f.run("Wait for the next outcome", async act => {
    const wait = act("task_wait", { ids: [other.id] });
    assert.equal(f.boardListeners.size, 1);
    const initial = (await act("task_review", { id: task.id })).data;
    const reference = { id: task.id, revision: initial.revision, targetHead: null };
    assert.equal((await act("task_accept", reference)).error.code, "REVIEW_REQUIRED");
    const before = reviewModels.length;
    const approved = await runReview();
    assert.deepEqual(reviewModels.slice(before), [defaultBoardAgents.reviewer, reviewVerifier]);
    assert.deepEqual(approved.tokenUsage.byModel.map(({ model, totalTokens }: { model: string; totalTokens: number }) =>
      [model, totalTokens]).sort(), [[reviewVerifier.model, 2], [defaultBoardAgents.reviewer.model, 2]].sort());
    assert.equal(approved.status, "review");
    assert.deepEqual((await f.cli(["archive", "sweep"])).data.archived, []);
    await f.pushBoard();
    const outcome = (await wait).data;
    assert.equal(outcome.tasks[0].running, true);
    assert.equal(outcome.timedOut, false);
    const [notice] = outcome.inbox;
    assert.equal(outcome.inbox.length, 1);
    assert.equal(notice.actor, "reviewer");
    assert.equal(notice.id, task.id);
    assert.equal(notice.sequence, approved.history.length);
    assert.equal(notice.status, "review");
    assert.equal(notice.text, report.summary);
    assert.equal(notice.commit, undefined);
    assert.deepEqual((await f.cli(["manager-inbox"])).data, [notice]);
    assert.deepEqual((await act("manager_inbox", {})).data, []);
    assert.equal((await act("task_show", { id: other.id })).unreadBoardAttention, undefined);
    let secondWaitFinished = false;
    const secondWait = act("task_wait", { ids: [other.id] }).then(reply => {
      secondWaitFinished = true;
      return reply;
    });
    await f.pushBoard();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondWaitFinished, false);
    f.setRunning(other.id, false);
    await f.pushBoard();
    const executorFinished = (await secondWait).data;
    assert.equal(executorFinished.tasks[0].running, false);
    assert.equal(executorFinished.timedOut, false);
    assert.deepEqual(Array.from(executorFinished.inbox), []);
    assert.equal((await act("manager_ack", { id: task.id, through: notice.sequence })).ok, true);
    assert.deepEqual((await f.cli(["manager-inbox"])).data, []);
    assert.deepEqual((await f.cli(["archive", "sweep"])).data.archived, []);
    const review = (await act("task_review", { id: task.id })).data;
    assert.ok(review.reviewerApproval);
    assert.equal((await act("task_accept", reference)).data.status, "done");
    assert.deepEqual((await f.cli(["archive", "sweep"])).data.archived, [task.id]);
    return { text: "Manager accepted the task." };
  });
  assert.equal(result.data?.answer, "Manager accepted the task.", JSON.stringify(result.error ?? result.data?.error));
  assert.equal(managerCalls, 0);
  assert.equal(git("rev-parse", "HEAD"), head);
});

test("cancelling a waiting request keeps the board thread and releases its temporary attachments", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId });
  const ready = Promise.withResolvers<void>();
  const pending = f.run("Read this", async (_act, _text, _images, id, _context, waiting, signal) => {
    assert.equal(id, f.threadId);
    waiting!(true);
    const stopped = new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    ready.resolve();
    return stopped;
  }, [file("notes.txt", "text/plain", "notes")]);
  await Promise.race([ready.promise, pending.then(result => assert.fail(JSON.stringify(result)))]);
  assert.equal((await f.stop()).ok, true);
  assert.equal((await pending).error.code, "BOARD_WAIT_CANCELLED");
  assert.equal((await f.stop()).error.code, "CHAT_NOT_RUNNING");
  assert.deepEqual(readdirSync(f.folder), ["project"]);
  assert.deepEqual(readJson(f.chatBinding), { provider: "codex", id: f.threadId });
});

test("orchestrator discusses a board, remembers the turn, and cancels the original task through the CLI", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const created = await f.cli(["create"], plannedDraft({ title: "Fix card preview", criteria: ["Corners match"] }));
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const task = created.data;
  await f.cli(["approve", task.id]);
  const first = await f.run("Что на доске?", async (act, prompt) => {
    assert.equal(prompt, "Что на доске?");
    const list = await act("board_list", {});
    assert.equal(list.data.tasks[0].id, task.id);
    return { text: "В очереди задача на исправление превью." };
  });
  assert.equal(first.data.changes.length, 0);
  const firstReply = first.data.items.at(-1).id;
  assert.deepEqual(managerUnread(f.project), [firstReply]);
  assert.equal((await f.markRead([firstReply], "foreign-board")).error.code, "BOARD_NOT_FOUND");
  assert.deepEqual((await f.markRead([firstReply])).data, []);
  assert.deepEqual(readJson(f.chatBinding), { provider: "codex", id: f.dialogueId, history: "local" });
  const second = await f.run("Эта задача не актуальна", async (act, prompt, _images, id) => {
    assert.equal(id, f.dialogueId);
    assert.equal(prompt, "Эта задача не актуальна");
    const current = (await act("task_show", { id: task.id })).data;
    assert.equal(current.history, undefined);
    assert.equal(current.tokenUsage, undefined);
    const args = { id: current.id, revision: current.revision, reason: "Задача не актуальна" };
    assert.equal((await act("task_cancel", { ...args, revision: 1 })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_cancel", args)).ok, true);
    const { data: page } = await act("task_show", { id: task.id, historyLimit: 1 });
    assert.equal(page.history[0].sequence, page.historyLength);
    assert.equal(page.history[0].text, args.reason);
    const { data: previous } = await act("task_show", { id: task.id, historyLimit: 1, beforeSequence: page.history[0].sequence });
    assert.equal(previous.history[0].sequence, page.historyLength - 1);
    assert.equal((await act("task_show", { id: task.id, historyLimit: 21 })).error.code, "INVALID_INPUT");
    return { text: "Задача отменена." };
  });
  assert.equal(second.data.changes[0].action, "cancel");
  assert.equal(second.data.changes[0].id, task.id);
  const board = (await f.cli(["list"])).data;
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].status, "cancelled");
  assert.equal(board.tasks[0].history.at(-1).actor, "manager");
  const tagged = await f.run("Поставь тег на отменённую задачу", async act => {
    const { data: current } = await act("task_show", { id: task.id });
    const input = { id: task.id, revision: current.revision, tags: ["Интерфейс"], note: "Уточнил категорию" };
    assert.equal((await act("task_update", { ...input, title: "Another task" })).error.code, "INVALID_TRANSITION");
    assert.equal((await act("task_update", input)).data.status, "cancelled");
    return { text: "Тег добавлен." };
  });
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  const saved = (await f.cli(["show", task.id])).data;
  assert.deepEqual(saved.tags, ["Интерфейс"]);
  assert.equal(saved.closedAt, board.tasks[0].closedAt);
  assert.equal(saved.history.at(-1).actor, "manager");
  const returned = await f.run("Верни отменённую задачу в черновик", async act => {
    const { data: current } = await act("task_show", { id: task.id });
    assert.equal((await act("task_return_to_draft", { id: task.id, revision: current.revision - 1 })).error.code, "REVISION_CONFLICT");
    const result = await act("task_return_to_draft", { id: task.id, revision: current.revision });
    assert.equal(result.data.status, "draft", JSON.stringify(result.error));
    assert.equal((await act("task_approve", { id: task.id, revision: result.data.revision })).error.code, "USER_APPROVAL_REQUIRED");
    return { text: "Задача возвращена в черновик." };
  });
  assert.equal(returned.data.changes[0].action, "return_to_draft");
  assert.equal((await f.cli(["show", task.id])).data.closedAt, undefined);
});

test("the project manager can revise an approved task and resolve its blocker from a discussion", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Group task chats", criteria: ["Use the original integration"] }));
  const { data: ready } = await f.cli(["approve", task.id]);
  const { data: blocked } = await f.cli(["block", task.id], {
    revision: ready.revision, allowUnstarted: true, reason: "Original integration is unavailable", condition: "Use a supported integration",
  });
  const result = await f.run("Достаточно, чтобы у чатов задач была общая папка, в том числе на телефоне.", async (act, prompt) => {
    assert.equal(prompt, "Достаточно, чтобы у чатов задач была общая папка, в том числе на телефоне.");
    const { data: current } = await act("task_show", { id: task.id });
    const criteria = ["Task chats appear in a shared project folder on desktop and mobile"];
    const update = { id: current.id, revision: current.revision, criteria, note: "Keep the required outcome and allow any supported integration" };
    assert.equal((await act("task_update", { ...update, revision: ready.revision })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_update", { ...update, criteria: [] })).error.code, "CRITERIA_REQUIRED");
    const revised = await act("task_update", update);
    assert.equal(revised.ok, true, JSON.stringify(revised.error));
    assert.equal(revised.data.status, "blocked");
    assert.equal((await act("task_unblock", {
      id: task.id, revision: revised.data.revision, reason: "The task no longer requires the unavailable integration",
    })).ok, true);
    return { text: "Уточнил критерии и снял блокировку." };
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(Array.from(result.data.changes, (change: { action: string }) => change.action), ["update", "unblock"]);
  const board = (await f.cli(["list"])).data;
  assert.equal(board.tasks.length, 1);
  const updated = board.tasks[0];
  assert.equal(updated.id, task.id);
  assert.equal(updated.status, "ready");
  assert.equal(updated.revision, blocked.revision + 2);
  assert.deepEqual(updated.criteria, ["Task chats appear in a shared project folder on desktop and mobile"]);
  assert.deepEqual(updated.history.slice(-2).map((event: { actor: string }) => event.actor), ["manager", "manager"]);
});

test("manager keeps large file links through queue, provider context and card creation", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const path = join(f.project, "large.bin");
  await writeFile(path, "part");
  const { truncateSync } = await import("node:fs");
  truncateSync(path, 80 * 1024 * 1024);
  const link = captureFileLink(path);
  const files = [{ name: "large.bin", type: "", bytes: new ArrayBuffer(0), link }];
  const queued = await f.queue("add", undefined, "Read part", false, files);
  assert.equal(queued.ok, true, JSON.stringify(queued));
  const restored = await f.queue("list");
  assert.equal(restored.data[0].files[0].link.path, link.path);
  assert.equal(restored.data[0].files[0].bytes.byteLength, 0);
  const result = await f.run("Read part", async (act, _prompt, images, _id, context) => {
    assert.equal(images.length, 0);
    assert.equal(context.attachments[0].path, link.path);
    assert.equal(context.attachments[0].link.size, link.size);
    const created = await act("task_create", plannedDraft({ title: "Linked", attachmentIds: [1] }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.data.attachments[0].link.path, link.path);
    return { text: "Linked" };
  }, files);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await f.queue("remove", queued.data)).ok, true);
  truncateSync(path, 81 * 1024 * 1024);
  const changed = await f.run("Check changed source", async (_act, _prompt, images, _id, context) => {
    assert.equal(images.length, 0);
    assert.match(context.attachments[0].error, /changed/);
    assert.equal(context.attachments[0].link.path, link.path);
    return { text: "Source changed; attach it again." };
  }, files);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.ok(existsSync(path));
});

test("orchestrator preserves selected attachments, restores blocked drafts, and reports changes after a failed reply", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const files = [file("image.png", "image/png", "first"), file("notes.txt", "text/plain", "notes"), file("image.png", "", "second")];
  const created = await f.run("", async (act, prompt, images, _id, context) => {
    assert.equal(prompt, "See attachments.");
    assert.deepEqual(context.attachments, [
      { id: 1, name: "image.png", image: true, imageIndex: 1 }, { id: 2, name: "notes.txt", image: false },
      { id: 3, name: "image.png", image: true, imageIndex: 2 },
    ]);
    assert.deepEqual(Array.from(images, image => Buffer.from(image.split(",")[1], "base64").toString()), ["first", "second"]);
    assert.equal((await act("task_create", { title: "Draft", attachmentIds: [4] })).error.code, "INVALID_INPUT");
    const draft = await act("task_create", plannedDraft({ title: "Draft", attachmentIds: [1, 2, 3] }));
    assert.equal(draft.ok, true);
    throw new Error("Provider failed after creation");
  }, files);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.match(created.data.error, /Provider failed after creation/);
  const id = created.data.changes[0].id;
  const blocked = await f.run("Пока заблокируй её", async (act, _prompt, _images, thread) => {
    assert.equal(thread, f.dialogueId);
    const draft = (await act("task_show", { id })).data;
    assert.equal(draft.attachments.length, 3);
    assert.equal((await act("task_block", { id, revision: draft.revision, reason: "No layout", condition: "Get layout" })).data.status, "blocked");
    return { text: "Заблокирована." };
  });
  const unblocked = await f.run("Макет готов, разблокируй", async act => {
    const result = await act("task_unblock", { id, revision: blocked.data.changes[0].revision, reason: "Layout is ready" });
    assert.equal(result.data.status, "draft");
    return { text: "Черновик разблокирован." };
  });
  assert.equal(unblocked.data.changes[0].status, "draft");
  const draft = (await f.cli(["show", id])).data;
  assert.equal(draft.blocked, undefined);
  assert.equal(draft.git, undefined);
  assert.deepEqual(readdirSync(f.folder), ["project"]);
});

test("an unsuccessful reply keeps the board unchanged and allows resending the attachments", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const files = [file("REF.JPEG", "", "jpeg"), file("clip", "image/png", "png"), file("ref.webp", "", "webp"), file("ref.gif", "", "gif")];
  const failed = await f.run("Посмотри вложения", async (_act, _prompt, images) => {
    assert.deepEqual(Array.from(images, image => image.split(/[/:;]/)[2]), ["jpeg", "png", "webp", "gif"]);
    throw new Error("Unable to decode image");
  }, files);
  assert.equal(failed.error.code, "CODEX_BOARD_REQUEST_FAILED");
  assert.match(failed.error.message, /Unable to decode image/);
  assert.deepEqual((await f.cli(["list"])).data.tasks, []);
  assert.deepEqual(readdirSync(f.folder), ["project"]);
  const retry = await f.run("Посмотри вложения", async (_act, prompt, images, id) => {
    assert.equal(id, f.dialogueId);
    assert.equal(prompt, "Посмотри вложения");
    assert.equal(images.length, 4);
    return { text: "Посмотрел." };
  }, files);
  assert.equal(retry.data.answer, "Посмотрел.");
});

test("a connection failure after goal acceptance preserves the request in the existing chat", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const objective = "Keep the board up to date";
  const fail = async () => { throw new Error("Codex did not respond in time."); };
  const notAccepted = await f.run(objective, fail, [], true);
  assert.equal(notAccepted.error.code, "CODEX_BOARD_REQUEST_FAILED");

  const accepted = await f.run(objective, async (_act, _prompt, _images, id, _context, _waiting, _signal, goal) => {
    assert.equal(id, f.threadId);
    assert.equal(goal?.objective, objective);
    goal!.update({ objective, status: "active" });
    goal!.accepted();
    return fail();
  }, [], true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.id, f.threadId);
  assert.match(accepted.data.error, /goal is saved.*\n.*\nCodex did not respond/s);
  const savedGoal = { objective, status: "active" };
  const { goalId, ...binding } = readJson(f.binding) as { goalId: string };
  assert.match(goalId, codexThreadPattern);
  assert.deepEqual(binding, { provider: "codex", id: f.threadId, history: "local", goal: savedGoal });
  const history = await f.history();
  assert.equal(history.ok, true);
  assert.deepEqual(history.data.goal, savedGoal);
  assert.equal(history.data.goalRunning, false);
  assert.equal((await f.goal("clear")).ok, true);
  assert.equal((await f.history()).data.goal, null);
  assert.equal(f.providerHistoryReads(), 0);
  assert.deepEqual(readdirSync(f.folder), ["project"]);
});

test("a damaged dialogue binding reports an error before opening another chat", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  writeJson(f.chatBinding, { provider: "codex", id: "invalid" });
  let called = false;
  const result = await f.run("Что на доске?", async () => {
    called = true;
    return { text: "unexpected" };
  });
  assert.equal(result.error.code, "CODEX_BOARD_REQUEST_FAILED");
  assert.equal(called, false);
  assert.deepEqual(readJson(f.chatBinding), { provider: "codex", id: "invalid" });
});

test("goal actions use the running chat connection and resume requires an existing binding", { timeout: 10_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.run("", async () => assert.fail("Must not start another chat"), [], "resume")).ok, false);
  assert.equal((await f.goal("edit", "  ")).ok, false);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  const settings = { model: "test-manager", effort: "high" };
  assert.equal((await f.cli(["settings"], { manager: settings })).ok, true);
  const { goalActivity, managerRuns, managerRun } = f.backgroundWindow();
  const connected = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const resume = f.run("", async (_act, prompt, _images, id, _context, waiting, _signal, goal) => {
    assert.equal(id, f.threadId);
    assert.equal(prompt, "");
    assert.ok(goal?.resume);
    assert.deepEqual(goal.settings, settings);
    goal.update({ objective: "Saved objective", status: "active" });
    waiting?.(true);
    waiting?.(false);
    goal.enableNotifications();
    goal.activity([{ id: "tool-1", type: "mcpToolCall", status: "inProgress", title: "ai_taskboard / project_git", text: "Tool output" }]);
    goal.controls(async action => {
      assert.equal(action.kind, "pause");
      return { objective: "Saved objective", status: "paused" };
    });
    connected.resolve();
    await done.promise;
    return { text: "Paused." };
  }, [], "resume");
  await Promise.race([connected.promise, resume.then(result => assert.fail(JSON.stringify(result)))]);
  try {
    assert.deepEqual(goalActivity, [true]);
    assert.deepEqual(managerRuns.slice(0, 4).map(run => run?.phase), ["starting", "waiting", "starting", "running"]);
    for (let attempt = 0; managerRuns.length === 4 && attempt < 100; attempt++) await wait(20);
    assert.deepEqual(managerRuns.map(run => run?.phase), ["starting", "waiting", "starting", "running", "running"]);
    assert.deepEqual(structuredClone(managerRun()), managerRuns.at(-1));
    assert.equal(managerRuns.at(-1)?.item?.title, "ai_taskboard / project_git");
    assert.equal(managerRuns.at(-1)?.item?.text, "");
    const paused = await f.goal("pause");
    assert.equal(paused.data.status, "paused");
    assert.equal(f.idleGoalActions.length, 0);
  } finally {
    done.resolve();
    await resume;
  }
  assert.deepEqual(goalActivity, [true, false]);
  assert.equal(managerRuns.at(-1), null);
  assert.equal(managerRun(), null);
  assert.equal((await f.goal("clear")).data, null);
  assert.equal(f.idleGoalActions[0]?.kind, "clear");
});

test("clearing a paused goal waits for dialogue and shares the result between requests", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const goal = { objective: "Saved objective", status: "paused" };
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId, history: "local", goal });
  const connected = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const activeWriter = "failed to record goal instruction: thread already has an active writer";
  f.failGoalClear(activeWriter);
  const dialogue = f.run("Ordinary question", async (_act, _prompt, _images, id, _context, _waiting, signal) => {
    assert.equal(id, f.threadId);
    connected.resolve();
    await done.promise;
    assert.equal(signal?.aborted, false);
    return { text: "Ordinary answer" };
  });
  await Promise.race([connected.promise, dialogue.then(result => assert.fail(JSON.stringify(result)))]);
  try {
    const first = f.goal("clear");
    const duplicate = f.goal("clear");
    const early = await Promise.race([first, wait(50, "pending")]);
    assert.equal(early, "pending", JSON.stringify(early));
    assert.equal(f.idleGoalActions.length, 0);
    assert.deepEqual((await f.history()).data.goal, goal);
    f.failGoalClear();
    done.resolve();
    assert.equal((await dialogue).data.answer, "Ordinary answer");
    for (const result of await Promise.all([first, duplicate])) {
      assert.equal(result.ok, true);
      assert.equal(result.data, null);
    }
    assert.equal((await f.goal("clear")).data, null);
    assert.equal(f.idleGoalActions.length, 1);
    const history = await f.history();
    assert.equal(history.data.goal, null);
    assert.match(JSON.stringify(history.data.turns), /Ordinary question.*Ordinary answer/);
  } finally {
    done.resolve();
    await dialogue;
  }
});

test("a provider refusal leaves a paused goal in history and permits retry", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const goal = { objective: "Saved objective", status: "paused" };
  writeJson(f.chatBinding, { provider: "codex", id: f.threadId, history: "local", goal });
  f.failGoalClear("Provider refused");
  const rejected = await f.goal("clear");
  assert.equal(rejected.error.code, "BOARD_GOAL_FAILED");
  assert.equal(rejected.error.message, "Provider refused");
  assert.deepEqual((await f.history()).data.goal, goal);
  f.failGoalClear();
  assert.equal((await f.goal("clear")).data, null);
  assert.equal(f.idleGoalActions.length, 2);
});

test("two windows sharing a board cannot start separate orchestrator chats", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = f.run("First question", async () => {
    ready.resolve();
    await release.promise;
    return { text: "First answer" };
  });
  try {
    await ready.promise;
    const second = await f.run("Second question", async () => { throw new Error("A concurrent turn started"); });
    assert.equal(second.error.code, "BOARD_REQUEST_IN_PROGRESS");
  } finally {
    release.resolve();
    assert.equal((await first).data.id, f.dialogueId);
  }
});

test("a running goal accepts a question answer and steering during task_wait in the same context", { timeout: 15_000 }, async t => {
  const f = fixture(t); await f.cli(["init"]);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Running task" }));
  f.setRunning(task.id, true);
  const { managerRun } = f.backgroundWindow();
  const asked = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const work = f.run("Coordinate", async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.accepted();
    goal!.update({ objective: "Coordinate", status: "active" });
    goal!.enableNotifications();
    const answer = act("ask_user", { question: "Which release?", options: ["Alpha", "Beta"] });
    asked.resolve();
    assert.equal((await answer).data.answer, "Alpha");
    const waiting = act("task_wait", { ids: [task.id] });
    ready.resolve();
    assert.equal((await waiting).error.code, "USER_MESSAGE_RECEIVED");
    await finish.promise;
    return { text: "Finished" };
  }, [], true);
  try {
    await asked.promise;
    const question = f.pendingQuestion();
    assert.equal(question.text, "Which release?");
    const turns = (await f.history()).data.turns as { items: RunActivity[] }[];
    assert.ok(turns.some(turn => turn.items.some(item => item.text.includes(question.text))));
    assert.equal((await f.answerQuestion(question.id, "Alpha")).ok, true);
    await ready.promise;
    const goalRunId = managerRun().id;
    const duplicate = await f.run("Parallel question", async () => assert.fail("Second context"));
    assert.equal(duplicate.error.code, "BOARD_REQUEST_IN_PROGRESS");
    const messageId = "00000000-0000-4000-8000-000000000003";
    assert.equal((await f.queue("add", messageId, "Hold publication", false, [])).ok, true);
    assert.equal((await f.sendNow("Hold publication", [], messageId, "stale-run")).error.code, "CHAT_NOT_RUNNING");
    assert.equal((await f.queue("list")).data.length, 1);
    assert.equal((await f.sendNow("Hold publication", [], messageId, goalRunId)).ok, true);
    assert.equal((await f.queue("list")).data.length, 0);
    assert.equal(f.managerNotifications.at(-1), "Hold publication");
  } finally {
    finish.resolve();
    if (f.pendingQuestion()) await f.answerQuestion(f.pendingQuestion().id, null);
  }
  const result = await work;
  assert.equal(result.data.answer, "Finished");
  const next = await f.run("Continue", async (_act, _prompt, _images, id) => {
    assert.equal(id, f.threadId); return { text: "Same context" };
  });
  assert.equal(next.ok, true, JSON.stringify(next));
});

test("the manager can read the open queue without closed or archived cards", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const { data: archived } = await f.cli(["create"], plannedDraft({ title: "Archived work" }));
  assert.equal((await f.cli(["cancel", archived.id], { reason: "Obsolete" })).ok, true);
  assert.equal((await f.cli(["settings"], { archiveAfterDays: 0 })).ok, true);
  assert.equal((await f.cli(["archive", "sweep"])).ok, true);

  const { data: closed } = await f.cli(["create"], plannedDraft({ title: "Closed work" }));
  assert.equal((await f.cli(["cancel", closed.id], { reason: "Obsolete" })).ok, true);
  const { data: open } = await f.cli(["create"], plannedDraft({ title: "Open work", tags: ["Runtime"], criteria: ["Work is verified."] }));
  const approved = await f.cli(["approve", open.id]);
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  const { data: ready } = approved;
  const { data: edited } = await f.cli(["update", open.id], { title: "Updated open work", revision: ready.revision });
  assert.equal(edited.title, "Updated open work");
  assert.notEqual(edited.updatedAt, ready.updatedAt);
  const result = await f.run("Show the open queue", async act => {
    assert.equal((await act("board_list", { activeOnly: "true" })).error.code, "INVALID_INPUT");
    const full = (await act("board_list", {})).data;
    const active = (await act("board_list", { activeOnly: true })).data;
    const fullTasks = Array.from<{ id: string }>(full.tasks);
    assert.deepEqual(fullTasks.map(task => task.id), [closed.id, open.id]);
    assert.deepEqual(Array.from<{ id: string }>(full.archived).map(task => task.id), [archived.id]);
    assert.deepEqual(Array.from(active.tasks), fullTasks.filter(task => task.id === open.id));
    assert.equal(active.tasks[0].readySince, ready.updatedAt);
    assert.equal(full.tasks[0].readySince, undefined);
    assert.equal(active.archived.length, 0);
    assert.deepEqual(Array.from(active.tags), Array.from(full.tags));
    return { text: "Open queue read." };
  });
  assert.equal(result.data?.answer, "Open queue read.", JSON.stringify(result.error ?? result.data?.error));
});

test("manager reopens a conflicting approved submission and integrates its reviewed repair", async t => {
  const f = fixture(t);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(f.project, "init", "-b", "main");
  // Keep detached maintenance from holding the disposable cwd during cleanup.
  git(f.project, "config", "maintenance.auto", "false");
  git(f.project, "config", "core.autocrlf", "false");
  git(f.project, "config", "user.name", "Taskboard");
  git(f.project, "config", "user.email", "taskboard@example.invalid");
  await writeFile(join(f.project, "source.txt"), "base\n");
  git(f.project, "add", ".");
  git(f.project, "commit", "-m", "Initial");
  await f.cli(["init"]);
  await f.cli(["settings"], { reviewMode: "reviewer" });
  const { data: card } = await f.cli(["create"], plannedDraft({ title: "Conflict repair", criteria: ["Both changes preserved"] }));
  await f.cli(["approve", card.id]);
  const { data: started } = await f.cli(["start", card.id]);
  const cwd = started.worktree;
  await writeFile(join(cwd, "source.txt"), "task\n");
  const { data: preview } = await f.cli(["preview", card.id]);
  const { data: submitted } = await f.cli(["submit", card.id], { token: preview.token, message: "fix: change source", summary: "Changed", checks: [] });
  const approve = async (revision: number) => {
    const { data: review } = await f.cli(["review", card.id]);
    assert.equal((await f.cli(["review-approve", card.id], { revision, targetHead: review.targetHead, summary: "Verified", evidence: ["Content checked"] })).ok, true);
  };
  await approve(submitted.revision);
  await f.run("Check clean submission", async act => {
    assert.equal((await act("task_start", { id: card.id, revision: submitted.revision, resolveConflicts: true })).error.code, "NO_MERGE_CONFLICT");
    return { text: "Clean submission retained" };
  });
  await writeFile(join(f.project, "source.txt"), "target\n");
  git(f.project, "commit", "-am", "Target change");
  const result = await f.run("Repair and integrate", async act => {
    const args = { id: card.id, revision: submitted.revision, resolveConflicts: true };
    assert.equal((await act("task_start", { ...args, resolveConflicts: "true" })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_start", { ...args, revision: submitted.revision - 1 })).error.code, "REVISION_CONFLICT");
    assert.equal((await act("task_start", { id: card.id, revision: submitted.revision })).error.code, "INVALID_TRANSITION");
    const reopened = await act("task_start", args);
    assert.equal(reopened.data.status, "in_progress");
    assert.equal((await f.cli(["show", card.id])).data.git.worktree, cwd);
    const conflict = spawnSync("git", ["-C", cwd, "merge", "main"], { encoding: "utf8", windowsHide: true });
    assert.equal(conflict.status, 1, conflict.stderr);
    await writeFile(join(cwd, "source.txt"), "target\ntask\n");
    git(cwd, "add", "source.txt");
    git(cwd, "commit", "-m", "fix: resolve integration conflict", "-m", "Task: " + card.id);
    const { data: next } = await f.cli(["preview", card.id]);
    const resubmitted = await f.cli(["submit", card.id], { token: next.token, message: next.commitMessage ?? "fix: preserve both changes", summary: "Combined", checks: ["Both lines present"] });
    assert.equal(resubmitted.ok, true, JSON.stringify(resubmitted));
    let review = (await act("task_review", { id: card.id })).data;
    assert.equal(review.reviewerApproval, undefined);
    assert.equal((await act("task_accept", { id: card.id, revision: review.revision, targetHead: review.targetHead })).error.code, "REVIEW_REQUIRED");
    await approve(review.revision);
    review = (await act("task_review", { id: card.id })).data;
    assert.equal((await act("task_accept", { id: card.id, revision: review.revision, targetHead: review.targetHead })).data.status, "done");
    return { text: "Integrated reviewed repair" };
  });
  assert.equal(result.data?.error, undefined, JSON.stringify(result));
  assert.equal(readFileSync(join(f.project, "source.txt"), "utf8"), "target\ntask\n");
});


test("manager returns the same card in every review mode and preserves human acceptance", { timeout: 150_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  for (const mode of ["human", "manager", "reviewer"] as const) {
    assert.equal((await f.cli(["settings"], { reviewMode: mode })).ok, true);
    const { data: task } = await f.cli(["create"], plannedDraft({ title: "T-0115 return scenario", criteria: ["Feedback reaches executor"] }));
    await f.cli(["approve", task.id]);
    await f.cli(["start", task.id]);
    const { data: preview } = await f.cli(["preview", task.id]);
    assert.equal((await f.cli(["submit", task.id], { token: preview.token, noChanges: true, summary: "Check return", checks: ["Fixture result inspected"] })).ok, true);
    const run = await f.run("Return work with feedback", async act => {
      const { data: review } = await act("task_review", { id: task.id });
      const ref = { id: task.id, revision: review.revision, reason: "Fix the validation failure and preserve the report." };
      if (mode === "human") {
        assert.equal((await act("task_accept", { id: ref.id, revision: ref.revision, targetHead: null })).error.code, "AUTO_REVIEW_DISABLED");
        assert.equal((await f.cli(["accept", task.id], { revision: ref.revision, actor: "manager" })).error.code, "AUTO_REVIEW_DISABLED");
      }
      assert.equal((await f.cli(["request-changes", task.id], { ...ref, revision: ref.revision - 1, actor: "manager", reviewMode: mode, targetHead: null })).error.code, "REVISION_CONFLICT");
      const otherMode = mode === "human" ? "manager" : "human";
      await f.cli(["settings"], { reviewMode: otherMode });
      assert.equal((await act("task_request_changes", ref)).error.code, "REVIEW_REQUIRED");
      await f.cli(["settings"], { reviewMode: mode });
      await act("task_review", { id: task.id });
      const returned = await act("task_request_changes", ref);
      assert.equal(returned.ok, true, JSON.stringify(returned.error));
      const current = (await f.cli(["show", task.id])).data;
      assert.equal(current.status, "in_progress");
      const events = current.history.filter((event: any) => event.action === "request-changes");
      assert.equal(events.length, 1);
      assert.equal(events[0].actor, "manager");
      assert.equal(events[0].text, ref.reason);
      const launch = await f.cli(["start", task.id, "--compact"], { launchDetails: true });
      assert.equal(launch.data.task.feedback, ref.reason);
      assert.equal((await f.cli(["request-changes", task.id], { ...ref, revision: current.revision, actor: "manager", reviewMode: mode, targetHead: null })).error.code, "INVALID_TRANSITION");
      assert.equal((await f.cli(["show", task.id])).data.history.filter((event: any) => event.action === "request-changes").length, 1);
      return { text: "Returned after the successful tool result." };
    });
    assert.equal(run.ok, true, JSON.stringify(run.error ?? run.data?.error));
    await f.cli(["cancel", task.id], { reason: "Fixture complete" });
  }
});


test("private cleanup repair persists, shares reviewer capacity and preserves a done card without a goal", async t => {
  const f = fixture(t);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", f.project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(f.project, ".gitignore"), "node_modules/\n*.local\n");
  git("add", ".gitignore"); git("commit", "-m", "chore: fixture");
  await f.cli(["init"]); await f.cli(["settings"], { reviewMode: "human", autoMode: false });
  await f.run("Initial conversation", async () => ({ text: "Remembered" }));
  const historyBefore = await f.history();
  const { data: card } = await f.cli(["create"], plannedDraft({ title: "T-0138 fixture", criteria: ["Keep evidence"] }));
  await f.cli(["approve", card.id]); const { data: started } = await f.cli(["start", card.id]);
  await writeFile(join(started.worktree, "result.txt"), "result");
  const { data: preview } = await f.cli(["preview", card.id]);
  const { data: submitted } = await f.cli(["submit", card.id], { token: preview.token, message: "fix: fixture", summary: "Result", checks: ["Checked"] });
  mkdirSync(join(started.worktree, "node_modules"));
  const dependency = join(started.worktree, "node_modules", "reproduced.js");
  await writeFile(dependency, "known dependency bytes");
  await writeFile(join(started.worktree, "user.local"), "unknown user data");
  const { data: done } = await f.cli(["accept", card.id], { revision: submitted.revision });
  assert.equal(done.status, "done"); assert.equal(done.cleanupWarning, undefined);
  const queuePath = join(f.project, ".tasks", "maintenance.json");
  const jobs = JSON.parse(readFileSync(queuePath, "utf8"));
  jobs[0].retryAt = 0; jobs[0].owner = 999999; // Recover an interrupted owner after restart.
  await writeFile(queuePath, JSON.stringify(jobs));
  const { data: pending } = await f.cli(["maintenance"]);
  assert.equal(pending.length, 1);
  const release = f.agentSlots.acquire(f.project, "reviewer", { reviewer: 1 }, "other-review")!;
  assert.equal((await f.cleanup(pending[0], async () => assert.fail("Reviewer pool full"))).error.code, "REVIEWER_LIMIT");
  assert.equal((await f.cli(["maintenance"])).data.length, 1);
  release();
  const result = await f.cleanup(pending[0], async (action, _prompt, _images, id, _context, _waiting, _signal, meta) => {
    assert.equal(id, undefined);
    assert.equal(meta?.role, "reviewer"); assert.equal(meta?.objective, undefined); assert.equal(meta?.resume, false);
    assert.equal(f.agentSlots.available(f.project, "reviewer", { reviewer: 1 }), 0);
    assert.equal(f.agentSlots.available(f.project, "executor", { executor: 1 }), 1);
    assert.equal((await f.cli(["maintenance"], { action: "claim", id: pending[0].id, owner: process.pid })).data.claimed, false);
    assert.equal(readFileSync(dependency, "utf8"), "known dependency bytes");
    await rm(dependency);
    await rm(join(started.worktree, "node_modules"), { recursive: true });
    assert.equal(readFileSync(join(started.worktree, "user.local"), "utf8"), "unknown user data");
    const cleaned = await action("task_cleanup", { id: card.id, artifacts: ["user.local"] });
    assert.equal(cleaned.ok, true);
    return { text: "Internal cleanup repaired." };
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await f.cli(["maintenance"])).data, []);
  assert.ok(!existsSync(started.worktree));
  assert.equal((await f.cli(["show", card.id])).data.status, "done");
  assert.equal((await f.cli(["list"])).data.tasks.length, 1);
  assert.deepEqual(await f.history(), historyBefore);
  assert.equal(f.pendingQuestion(), undefined);
  assert.equal(f.agentSlots.available(f.project, "reviewer", { reviewer: 1 }), 1);
});

test("acceptance repair has an isolated context and waits for shared reviewer capacity", async t => {
  const f = fixture(t);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", f.project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await writeFile(join(f.project, "source.txt"), "base\n"); git("add", "."); git("commit", "-m", "chore: initial");
  await f.cli(["init"]); await f.cli(["settings"], { reviewMode: "human", autoMode: false });
  await f.run("Initial conversation", async () => ({ text: "Remembered" }));
  const { data: card } = await f.cli(["create"], plannedDraft({ title: "Repair", criteria: ["Verified"] }));
  await f.cli(["approve", card.id]); const { data: started } = await f.cli(["start", card.id]);
  await writeFile(join(started.worktree, "source.txt"), "task\n");
  const { data: preview } = await f.cli(["preview", card.id]);
  const { data: submitted } = await f.cli(["submit", card.id], { token: preview.token, message: "fix: task", summary: "Changed", checks: ["Checked"] });
  await writeFile(join(f.project, "source.txt"), "target\n"); git("commit", "-am", "fix: target");
  const { data: queued } = await f.cli(["accept", card.id], { actor: "user", revision: submitted.revision, targetHead: git("rev-parse", "HEAD"), message: "fix: integrate" });
  assert.equal(queued.acceptanceRepair.phase, "queued");
  const release = f.agentSlots.acquire(f.project, "reviewer", { reviewer: 1 }, "review:other")!;
  assert.equal((await f.repair(queued, async () => assert.fail("Reviewer pool full"))).error.code, "REVIEWER_LIMIT");
  assert.equal((await f.cli(["show", card.id])).data.acceptanceRepair.phase, "queued");
  release();
  const scheduler = f.schedule((await f.cli(["list", "--compact"])).data, async (_act, _prompt, _images, id, _context, _waiting, _signal, session) => {
    assert.equal(id, undefined); assert.deepEqual(session?.settings, defaultBoardAgents.manager);
    assert.equal(f.agentSlots.available(f.project, "reviewer", { reviewer: 1 }), 0);
    assert.equal(f.agentSlots.available(f.project, "executor", { executor: 1 }), 1);
    const running = (await f.cli(["show", card.id])).data;
    assert.equal(running.status, "review"); assert.equal(running.git.worktree, started.worktree);
    await f.cli(["block", card.id], { reason: "Needs product decision", condition: "Decide" });
    return { text: "Decision needed" };
  });
  scheduler.acceptanceTick(); scheduler.acceptanceTick();
  await scheduler.done();
  assert.equal(f.agentSlots.available(f.project, "reviewer", { reviewer: 1 }), 1);
  assert.equal((await f.cli(["show", card.id])).data.acceptanceRepair.phase, "failed");
  assert.equal(f.cliCalls.filter(args => args[0] === "start" && args[1] === card.id).length, 2);
});
