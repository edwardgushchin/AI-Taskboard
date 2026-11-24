import { activeManagerGoal, managerGoalBinding, managerGoalState } from "../src/cli/manager-goal.ts";
import { boardReviewModeTool, reviewModeCardReply, reviewModeConfirmation, reviewModeQuestion, reviewModeReceipt,
  reviewModeReplyTarget, setReviewModeFromChat } from "../src/desktop/chat-actions.ts";
import { confirmFixtureDraft, plannedDraft } from "./fixtures/planned-draft.ts";
import { isManual, manualContext } from "../src/cli/manual-board.ts";
import { captureFileLink, isFileLink, verifyFileLink } from "../src/cli/attachment-links.ts";
import localization from "../src/desktop/localization.cjs";
import { activeRunSummary } from "../src/desktop/active-runs.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, hash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { boardReviewMode, taskReviewMode, taskReviewModeVersion, codexThreadPattern, defaultBoardAgents, hexTagColor, maxAttachmentBytes, reviewVerifier, TaskboardError, taskIdPattern, reviewsAcceptanceRepair, usesIndependentReviewer } from "../src/cli/model.ts";
import { managerInbox, needsManagerAttention } from "../src/cli/task-messages.ts";
import type { RunActivity, Task } from "../src/cli/model.ts";
import type { ChatSettings } from "../src/cli/model.ts";
import { directory as storageDirectory, locateBoard, onBoard, readBoardSettings, readJson, writeJson } from "../src/cli/storage.ts";
import { registerRuntime, runtimeEntries, runtimeLocation, runtimeTransaction } from "../src/desktop/board-runtime.ts";
import type { BoardGoal, BoardGoalAction, readBoardHistory } from "../src/desktop/codex-chat.ts";
import { commitFileHashes, inspectProjectPath, projectSha256 } from "../src/desktop/project-files.ts";
import { readReviewReports, saveReviewReports } from "../src/desktop/review-history.ts";
import { reviewerActivity, withReviewerChat } from "../src/desktop/reviewer-chat.ts";
import {
  completedManagerAnswer, goalActivityItems, goalMessages, hasGoalHistory, hasManagerMessage, managerChatItems, managerHistoryFile, managerUnread, managerWorkItems,
  readDialogueReference, readManagerHistory, readManagerMessages, readManagerProviderHistory, readManagerRecovery, readManagerView,
  saveManagerHistory, sendGoalMessage,
} from "../src/desktop/manager-history.ts";
import { backgroundGoalHistory } from "../src/desktop/goal-history-background.ts";
import { goalActionTools, runGoalAction } from "../src/desktop/goal-actions.ts";
import { russianWriting } from "../src/desktop/russian-writing.ts";
import { autoQueueSettings, earliestOpenRelease, releaseWait, updateAutoQueue } from "../src/cli/auto-queue.ts";
import { nextReadyTask } from "../src/desktop/auto-queue.ts";
import { acknowledgeInterval, advanceInterval, goalQueueCondition, intervalDeadline, iterativeEnabled, ownerIterationDirective,
  goalEventConditions, goalReserveTarget, iterationDirectiveAfterEdit, normalizeGoalRules,
  readIterativeGoal, saveIterativeGoal } from "../src/desktop/iterative-goal.ts";
import { automationDelivery, pendingReviewApprovals } from "../src/desktop/automation-delivery.ts";
import { createAgentSlots } from "../src/desktop/agent-limits.ts";
import { settingsDelivery, syncSettingsNotices } from "../src/desktop/settings-notices.ts";
import { githubReadTool } from "../src/desktop/github-read.ts";
import { ApplicationUpdates, applicationUpdateTools } from "../src/desktop/installation-updates.ts";
import { expertActions, expertCommands, leadInstructions, phaseStageReporter } from "../src/desktop/expert-tools.ts";
import { executorFullAccess, managerAccess, setTaskExecutorAccess } from "../src/desktop/codex.ts";
import type { ManagerAccess } from "../src/desktop/codex.ts";

process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

const source = (file: string) => readFileSync(new URL("../src/desktop/" + file, import.meta.url), "utf8");
const boardSource = stripTypeScriptTypes(source("board-actions.ts").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""));
const main = ts.createSourceFile("main.ts", source("main.ts"), ts.ScriptTarget.Latest, true);
const dispatcherSource = stripTypeScriptTypes(main.statements.map(node => node.getText(main)).filter(text =>
  text.startsWith("const autoBoards =") || text.startsWith("const managerNoticeKey =") ||
  text.startsWith("function scheduleAutoBoard(")).join("\n"));
const handlerSource = stripTypeScriptTypes(main.statements.map(node => node.getText(main)).filter(text =>
  /^(?:(?:async )?function (?:frame|boardUnread|publishManagerUnread|managerQuestion|publishReviewActivity|isPastedFile|readBoardThread|saveBoardGoal|parseOwnerGoalEdit|goalIterationAuthority|changeBoardGoal|resumeBoardGoal|boardThreadPath|broadcastBoardChat|prepareBoardAttachments|runBoardRequest|executorBusy|canScheduleAutoReview|autoReviewTab|availableReviewSlots|reviewAttempt|readyReviews|scheduleAutoReview|reviewSubmission|saveTaskTokenUsage|reserveAgent|scheduleAgentWork|continueAcceptance|returnTaskToDraft|scheduleMaintenance|scheduleRecurringTasks|taskRunLimit|readQueuedMessage|queuedFiles|listQueuedMessages)\(|const (?:imageExtensions|imageTypes|boardRequests|boardGoalClears|boardGoalResumes|boardWorkRequests|backgroundManagerRequests|goalReadTool|goalChatTools|goalWorkTools|deferredExecutors|acceptanceWork|maintenanceWork|returningDrafts|reviewOperations|managerReviewOperations|taskOperations|steeringOperations) =|let schedulingAgentWork =|imageTypes\.set\(|ipcMain\.handle\("board:(?:queue|request|stopOrchestrator|answerQuestion|goal|history|readManagerMessages)",)/.test(text)).join("\n"));
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
  const milestoneDeletion = { run: undefined as ((input: Record<string, unknown>, signal: AbortSignal) => unknown) | undefined };
  let beforeReviewRead: (() => void) | undefined;
  const callCli = async (cwd: string, args: string[], input?: unknown, track = true) => {
    assert.equal(cwd, project);
    if (track) cliCalls.push(args);
    const key = args.slice(0, 2).join(" ");
    const busy = busyDecisions.get(key) ?? 0;
    if (busy > 0) {
      busyDecisions.set(key, busy - 1);
      return cliFailure("BOARD_BUSY", "Another command is working on this board.");
    }
    if (args[0] === "review" && beforeReviewRead) {
      const change = beforeReviewRead;
      beforeReviewRead = undefined;
      change();
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
    { AbortSignal, expertActions, expertCommands, leadInstructions, autoQueueSettings, earliestOpenRelease, releaseWait, isManual, manualContext, locateBoard, readBoardSettings, boardReviewMode, usesIndependentReviewer, callCli, cliFailure, commitFileHashes, defaultBoardAgents, hexTagColor, inspectProjectPath, managerInbox, needsManagerAttention, projectSha256, reviewVerifier, russianWriting, TaskboardError, taskIdPattern,
      DOMException, deleteGitHubMilestone: (_location: unknown, input: Record<string, unknown>, signal: AbortSignal) => milestoneDeletion.run!(input, signal),
      taskFields: { title: {}, description: {}, criteria: {}, tags: {} },
    },
  );
  type RunAction = (name: string, args: unknown, toolSignal?: AbortSignal) => Promise<any>;
  type GoalControl = (action: BoardGoalAction) => Promise<BoardGoal | null>;
  type GoalRequest = { objective?: string; resume?: boolean; accepted: () => void; delivered: (id: string) => void; controls: (control: GoalControl) => void;
    update: (goal: BoardGoal | null) => void; activity: (items: RunActivity[]) => void; settings?: ChatSettings | null;
    enableNotifications: (steer?: (text: string, images: string[]) => Promise<void>) => void; endTurn: () => void;
    finishTurn?: () => boolean;
    acceptTurn?: (thread: string, turn: string) => void; retrying?: (reason: string) => void;
    role?: string; access?: ManagerAccess; confirmApproval?: (details: string) => Promise<boolean> };
  type Reply = (action: RunAction, prompt: string, images: string[], id?: string, context?: any,
    waiting?: (waiting: boolean) => void, signal?: AbortSignal, goal?: GoalRequest) => Promise<{ text: string } | { interrupted: true }>;
  let respond: Reply;
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>();
  const threadId = "00000000-0000-0000-0000-000000000001";
  const dialogueId = "00000000-0000-0000-0000-000000000002";
  const binding = join(project, ".tasks", "manager-dialog.json");
  const chatBinding = join(project, ".tasks", "manager-conversation.json");
  const idleGoalActions: BoardGoalAction[] = [];
  let providerHistoryReads = 0;
  let savedTurn: { items: { type: string; phase: string; text: string }[] } | undefined;
  let savedTurnId: string | undefined;
  const managerTurnReads: string[] = [];
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
  let supportsUpdates = false;
  const applicationUpdates = new ApplicationUpdates({
    version: () => "0.1.0-alpha",
    supported: () => supportsUpdates,
    busy: () => false,
    confirm: async () => supportsUpdates,
    prepare: async () => ({ start: async () => {}, cancel: async () => {} }),
  });
  let quotaPaused = false;
  const runtime = runInNewContext(handlerSource + "\n({ frame, scheduleAutoReview, boardRequests, boardWorkRequests, backgroundManagerRequests, acceptanceWork, managerQuestion, runBoardRequest, scheduleRecurringTasks })", {
    get quotaWait() { return quotaPaused ? {} : undefined; },
    boardBudgetFailure: () => undefined, boardCodexBudget: () => undefined, saveDailyUsage: () => {},
    quotaInterruption: new Error("Fixture quota pause"), refreshQuota: async () => [],
    currentActiveGoal: activeManagerGoal, currentManagerGoal: managerGoalState, managerGoalBinding,
    acknowledgeInterval, intervalDeadline, iterativeEnabled, ownerIterationDirective, iterationDirectiveAfterEdit,
    normalizeGoalRules, readIterativeGoal, saveIterativeGoal,
    applicationUpdates, applicationUpdateTools, updateOwner: undefined, updateProject: undefined,
    scheduleAutoBoard: () => {}, scheduleDraftDiscussions: () => {},
    activeRunSummary, discussionActivityByTask: new Map(), runActivityByTask: new Map(), replyingTasks: new Set(), projectLabels: () => [], recentBoards: [], russian: true, theme: "dark",
    captureFileLink, isFileLink, verifyFileLink, AbortSignal, AbortController, ArrayBuffer, Buffer, Error, basename, dirname, extname, join, mkdtemp, rm, writeFile, maxAttachmentBytes, boardActions, boardInstructions, boardTools, callCli,
    githubReadTool, readBoardGitHub: (cwd: string, args: unknown) => callCli(cwd, ["github-read"], args),
    executorFullAccess, managerAccess, setTaskExecutorAccess, phaseStageReporter,
    autoReviewInstructions, autoReviewReadTools, autoReviewTaskTools, manualReviewInstructions, boardReviewMode, taskReviewMode, taskReviewModeVersion,
    boardReviewModeTool, reviewModeCardReply, reviewModeConfirmation, reviewModeQuestion, reviewModeReceipt,
    reviewModeReplyTarget, setReviewModeFromChat,
    reviewsAcceptanceRepair, usesIndependentReviewer, defaultBoardAgents, reviewVerifier,
    existsSync, storageDirectory, readdirSync, rmSync, hash, randomUUID, readJson, writeJson, saveReviewReports, withReviewerChat, reviewerActivity,
    backgroundGoalHistory, completedManagerAnswer, goalActivityItems, goalMessages, hasGoalHistory, hasManagerMessage, managerChatItems, managerHistoryFile, managerUnread,
    managerWorkItems, readDialogueReference, readManagerHistory, readManagerMessages, readManagerProviderHistory, readManagerRecovery, readManagerView,
    saveManagerHistory, sendGoalMessage, goalActionTools, runGoalAction,
    readManagerTurn: async (_profile: string, _project: string, reference: { turnId?: string }) => {
      managerTurnReads.push(reference.turnId ?? "");
      return !savedTurnId || savedTurnId === reference.turnId ? savedTurn : undefined;
    },
    send() {},
    notifyRunChange() {},
    tokenUsageQueue: () => ({
      enqueue: (cwd: string, id: string, report: unknown) => callCli(cwd, ["token-usage", id], report),
    }),
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
    russianWriting, isManual, manualContext, runtimeLocation, runtimeTransaction, onBoard, readBoardSettings, TaskboardError, settingsDelivery, syncSettingsNotices, automationDelivery,
    reviewWithCodex: async (_profile: string, cwd: string, settings: ChatSettings | null, context: string,
      tools: { name: string }[], call: RunAction, _signal: AbortSignal,
      onUsage: (report: import("../src/cli/token-usage.ts").TokenUsageReport) => Promise<void>) => {
      assert.equal(cwd, project);
      assert.deepEqual(Array.from(tools, tool => tool.name), ["task_review_diff", "task_review_artifact", "project_git", "project_path", "project_sha256"]);
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
      if (action.kind === "edit") {
        const { goal } = readJson(binding) as { goal: BoardGoal };
        const updated = { ...goal, objective: action.objective };
        action.commit?.(updated, randomUUID());
        return updated;
      }
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
        role?: "manager" | "reviewer"; separateTurn?: boolean; readOnly?: boolean; recovery?: boolean;
        access?: ManagerAccess; confirmApproval?: (details: string) => Promise<boolean>;
        onTurnAccepted?: (thread: string, turn: string) => void; onProviderRetry?: (reason: string) => void;
        onWaiting: (waiting: boolean) => void; onTurnEnded: () => void; goal?: string; resumeGoal?: boolean; onGoalSet: () => void;
        finishGoalTurn?: () => boolean;
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
        const approval = session.mcpTools.find(tool => tool.name === "task_approve")!.description;
        assert.match(approval, /agent confirms its current brief/);
        assert.match(approval, /task_wait.*task_show.*awaitingAnswer is false.*draftConfirmed is not false.*approvalRequirements is empty/);
      }
      assert.equal(session.title, "Project manager for project");
      const expectedTools = cleanupTurn ? ["task_cleanup_status", "task_cleanup", "project_path", "project_sha256"] : manualTurn ? ["expert_list", "expert_context", "expert_skill", "ask_user", "tag_set_color", "github_read"] : reviewTurn ? [
        "expert_list", "expert_context", "expert_skill", "team_inbox", "team_message", "team_findings",
        "task_review", "task_review_diff", "task_review_artifact", "task_accept", "task_request_changes", "project_git", "project_path", "project_sha256",
      ] : [
        "expert_list", "expert_context", "expert_skill", "expert_plan", "team_inbox", "team_message", "team_findings",
        "board_archive_cancelled", "board_auto_queue", "task_cancel", "provider_tools", "task_tool_grant", "task_tool_revoke", "task_set_executor_access", "ask_user", "manager_inbox", "manager_ack", "task_message", "task_start", "task_start_batch", "task_approve", "task_wait", "task_review_queue", "task_review", "task_review_diff",
        "task_review_artifact", "task_accept", "task_request_changes",
        "task_cleanup_status", "task_cleanup", "project_git", "project_git_push",
        "project_git_branches", "project_git_fetch", "project_git_fast_forward", "project_git_branch_create", "project_git_branch_delete",
        "milestones_list", "github_create_milestone", "github_set_milestone_due", "github_update_milestone", "github_delete_milestone",
        "task_set_milestone", "tag_set_color", "github_read",
      ];
      const mode = boardReviewMode((await callCli(project, ["settings"], undefined, false)).data);
      if (session.recovery) {
        assert.equal(session.readOnly, true);
        assert.equal(session.separateTurn, true);
        assert.deepEqual(Array.from(_tools as { name: string }[], tool => tool.name).sort(), ["board_list", "task_show"]);
        assert.equal(session.mcpTools.length, 0);
      } else {
        assert.deepEqual(Array.from(session.mcpTools, tool => tool.name).sort(),
        [...expectedTools.filter(name => (name !== "task_accept" || (mode !== "human" && mode !== "reviewer-human")) && (!instructions.includes("This turn repairs") || (!name.startsWith("project_git_") && !["task_start", "task_start_batch", "task_accept", "task_request_changes"].includes(name)))),
        ...(!manualTurn && !cleanupTurn && !instructions.includes("This turn repairs") ? ["task_return_to_draft"] : []),
        ...(!manualTurn && !cleanupTurn && !reviewTurn && !instructions.includes("This turn repairs") && !prompt.startsWith("AI Taskboard queue:") ? ["board_set_auto_mode"] : []),
        ...(!manualTurn && !cleanupTurn && mode === "manager" ? ["expert_stage", "expert_verify_skills"] : []),
        ...(!reviewTurn && !cleanupTurn && !instructions.includes("This turn repairs")
          ? (session.goal || session.resumeGoal
            ? ["goal_read", "goal_dialogue", "goal_inbox", "goal_report", "goal_configure_iteration"]
            : ["goal_read", "goal_send", "goal_edit"])
          : []),
        ...(!reviewTurn && !cleanupTurn && !instructions.includes("This turn repairs") && !session.goal && !session.resumeGoal &&
          !prompt.startsWith("AI Taskboard queue:") ? ["app_check_updates", "app_install_update", "board_import_project_rules"] : []),
        ...(!reviewTurn && !manualTurn && !cleanupTurn && !session.goal && !session.resumeGoal &&
          !instructions.includes("This turn repairs") && session.role === "manager" && !prompt.startsWith("AI Taskboard queue:") ?
          ["task_set_review_mode"] : []),
        ...(reviewTurn && mode === "reviewer" ? ["manager_ack", "task_cancel", "task_start"] : [])].sort());
      }
      if (reviewTurn && !session.recovery) {
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
          controls: control => session.onGoalControl(async action => {
            const updated = await control(action);
            if (action.kind === "edit" && updated) action.commit?.(updated, randomUUID());
            return updated;
          }), update: session.onGoal, activity: session.onActivity,
          role: session.role, settings: session.settings, endTurn: session.onTurnEnded, access: session.access,
          confirmApproval: session.confirmApproval, finishTurn: session.finishGoalTurn,
          acceptTurn: session.onTurnAccepted, retrying: session.onProviderRetry,
          enableNotifications: steer => session.onControl({
            steer: async (text, images, id) => {
              if (steer) await steer(text, images);
              else managerNotifications.push(text);
              if (id) {
                const user = { text, files: [] };
                session.onActivity([{ id, title: "", text, type: "userMessage", status: "completed", userMessage: user } as RunActivity]);
                session.onMessage(id);
              }
            }, interrupt: async () => {},
          }) });
    },
  });
  const reviewing = () => runtime.frame({ project, board: subscriptions.get(project)?.board, window: { webContents: {} } }).reviewingTasks;
  return {
    folder, project, threadId, dialogueId, binding, chatBinding, idleGoalActions, cliCalls, boardListeners, executorNotifications, managerNotifications,
    reviewing, agentSlots, failGoalClear: (message?: string) => { clearGoalError = message; },
    automationError: (error: string) => runtime.boardWorkRequests.get(project)?.automationEvent?.({ error }),
    automaticNotice: (board: unknown) =>
      runtime.runBoardRequest(sender, board, "AI Taskboard queue: test notice", [], false, false, undefined, undefined, undefined, true),
    repair: (task: Task, reply: Reply) => {
      respond = reply;
      return runtime.runBoardRequest(sender, { project, tasks: [task] }, "Repair this acceptance", [], false, false, undefined, undefined, undefined, false, task);
    },
    cleanup: (job: import("../src/cli/maintenance-state.ts").MaintenanceJob, reply: Reply) => {
      respond = reply;
      return runtime.runBoardRequest(sender, { project, tasks: [] }, "Repair private lifecycle cleanup", [], false, false, undefined, undefined, undefined, false, undefined, job);
    },
    busyDecisions,
    beforeReviewRead: (change: () => void) => { beforeReviewRead = change; },
    setQuotaPaused: (paused: boolean) => { quotaPaused = paused; },
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
        addWindow: () => watch.tabs.add({
          window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send() {} } },
        }),
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
    cli: (args: string[], input?: unknown) => {
      if (args[0] === "approve") confirmFixtureDraft(project, args[1]);
      return callCli(project, args, input);
    },
    prepareUpdate: async () => {
      supportsUpdates = true;
      await applicationUpdates.check();
      return applicationUpdates.install("0.1.1-alpha", new AbortController().signal);
    },
    cancelUpdate: () => applicationUpdates.cancel(),
    milestoneDeletion,
    run: (request: string, reply: Reply, files: unknown[] = [], goal = false, id?: string) => {
      respond = reply;
      return handlers.get("board:request")!({ sender }, request, files, undefined, goal, false, id);
    },
    resume: (objective: string, reply: Reply) => {
      respond = reply;
      return handlers.get("board:goal")!({ sender }, "resume", objective);
    },
    stop: () => handlers.get("board:stopOrchestrator")!({ sender }),
    history: (cursor?: string, view?: string) => handlers.get("board:history")!({ sender }, project, cursor, view),
    setLegacyHistory: (reader: typeof legacyHistory) => { legacyHistory = reader; },
    setSavedTurn: (turn: typeof savedTurn, id?: string) => {
      savedTurn = turn;
      savedTurnId = id;
    },
    managerTurnReads,
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
      const managerRun = () => runtime.frame({ project, board: { project, tasks: [], settings: {} }, window: { webContents: {} } }).managerWork;
      return { state, tab, notifications: questionNotifications, goalActivity, managerRuns, managerRun };
    },
    sendNow: (request: string, files: unknown[] = [], id?: string) =>
      handlers.get("board:request")!({ sender }, request, files, undefined, false, true, id),
    queue: (action: string, ...args: unknown[]) => handlers.get("board:queue")!({ sender }, project, action, ...args),
    goal: (kind: string, objective?: string) => handlers.get("board:goal")!({ sender }, kind, objective),
  };
}

test("manual manager edits personal tasks but cannot launch or move them", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"], { boardType: "manual" })).ok, true);
  const result = await f.run("Plan the week", async act => {
    const brief = { title: "Buy groceries" };
    for (const fields of [{}, { tags: [] }, { tags: [" ", "\t"] }, { tags: [42] }]) {
      const rejected = await act("task_create", { ...brief, ...fields });
      assert.equal(rejected.error.code, "TASK_TAGS_REQUIRED");
      assert.match(rejected.error.message, /non-blank tag.*retry task_create/);
    }
    const { data: emptyBoard } = await act("board_list", {});
    assert.deepEqual(emptyBoard.tasks, []);
    assert.deepEqual(emptyBoard.tags, []);

    const created = await act("task_create", { ...brief, tags: ["Groceries"] });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.data.id;
    const shown = await act("task_show", { id });
    const updated = await act("task_update", { id, revision: shown.data.revision, description: "Milk", tags: [], note: "User plan" });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.deepEqual((await act("task_show", { id })).data.tags, []);
    assert.equal(updated.data.status, shown.data.status);
    for (const name of ["task_start", "task_approve", "task_cancel", "task_accept"]) {
      const blocked = await act(name, { id, revision: updated.data.revision });
      assert.equal(blocked.error.code, "MANUAL_BOARD");
    }
    const board = await act("board_list", {});
    assert.equal(board.data.boardType, "manual");
    assert.deepEqual(board.data.tasks.map((task: { id: string }) => task.id), [id]);
    assert.deepEqual(board.data.tags, ["Groceries"]);
    const autoMode = await act("board_set_auto_mode", { enabled: true, reason: "Try the automatic queue" });
    assert.equal(autoMode.error.code, "MANUAL_BOARD");
    assert.match(autoMode.error.message, /авторежим недоступен|automatic mode/i);
    assert.ok(board.data.statuses.some((s: { id: string }) => s.id === shown.data.status));
    return { text: "Week planned." };
  });
  assert.equal(result.data?.answer, "Week planned.", JSON.stringify(result));
});

test("manager update commands use the common release check and provide manual instructions for unpacked clients", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  let offline = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /^https:\/\/api.github.com\/repos\/edwardgushchin\/AI-Taskboard\/releases\?/);
    if (offline) {
      throw new TypeError("Offline");
    }
    return Response.json([{ tag_name: "v0.1.1-alpha", prerelease: true }]);
  });
  const result = await f.run("Check for AI Taskboard updates", async act => {
    const checked = await act("app_check_updates", {});
    assert.equal(checked.ok, true);
    assert.equal(checked.data.currentVersion, "0.1.0-alpha");
    assert.equal(checked.data.latest.version, "0.1.1-alpha");
    assert.equal(checked.data.installation, "manual");
    const installed = await act("app_install_update", { version: "0.1.1-alpha" });
    assert.equal(installed.error.code, "UPDATE_MANUAL_REQUIRED");
    assert.match(installed.error.message, /github.com\/edwardgushchin\/AI-Taskboard\/releases/);
    offline = true;
    assert.equal((await act("app_check_updates", {})).error.code, "UPDATE_CHECK_FAILED");
    offline = false;
    assert.equal((await act("app_check_updates", {})).data.status, "available");
    return { text: "Current: 0.1.0-alpha. Available: 0.1.1-alpha. Install manually from the official release." };
  });
  assert.equal(result.ok, true);
  assert.match(result.data.answer, /Current: 0.1.0-alpha/);
});

test("a prepared update rejects new dialogue before claiming its writer and cancellation permits retry", async t => {
  const f = fixture(t);
  const { data: { project } } = await f.cli(["init"]);
  t.mock.method(globalThis, "fetch", async () => Response.json([{ tag_name: "v0.1.1-alpha" }]));
  assert.equal((await f.prepareUpdate()).ok, true);
  const blocked = await f.run("New request during update", async () => {
    assert.fail("An update must prevent a new provider turn");
  });
  assert.equal(blocked.error.code, "UPDATE_IN_PROGRESS");
  assert.equal(runtimeEntries(project).some(entry => entry.task === "manager:dialogue"), false);
  await f.cancelUpdate();
  const resumed = await f.run("Retry after update cancellation", async act => {
    assert.equal((await act("board_list", {})).ok, true);
    return { text: "The original client can work again." };
  });
  assert.equal(resumed.ok, true);
});

test("manager can set and read the board tag palette in HEX", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const brief = plannedDraft({ title: "Verify tag color" });
  const result = await f.run("Set the tag color", async act => {
    for (const fields of [{}, { tags: [] }, { tags: [" ", "\t"] }, { tags: "Интеграции" }]) {
      const rejected = await act("task_create", { ...brief, ...fields });
      assert.equal(rejected.error.code, "TASK_TAGS_REQUIRED");
    }
    const { data: emptyBoard } = await act("board_list", {});
    assert.deepEqual(emptyBoard.tasks, []);
    assert.deepEqual(emptyBoard.tags, []);

    const created = await act("task_create", { ...brief, tags: ["Интеграции", "интеграции"] });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const card = created.data;
    assert.deepEqual((await act("task_show", { id: card.id })).data.tags, ["Интеграции"]);
    const { data: catalog } = await act("board_list", {});
    assert.deepEqual(catalog.tags, ["Интеграции"]);
    assert.equal(catalog.tasks.length, 1);
    assert.match(catalog.tagColors["Интеграции"], /^#[0-9A-F]{6}$/);

    const saved = await act("tag_set_color", { name: "интеграции", color: "#217d79" });
    assert.equal(saved.data.name, "Интеграции");
    assert.equal(saved.data.color, "#217D79");
    const invalid = await act("tag_set_color", { name: "Интеграции", color: "teal" });
    assert.equal(invalid.error.code, "INVALID_INPUT");
    const { data: board } = await act("board_list", {});
    assert.equal(board.tagColors["Интеграции"], "#217D79");
    assert.equal(board.tasks[0].tags[0], "Интеграции");
    assert.equal(board.tasks[0].revision, card.revision);
    const reused = await act("task_create", plannedDraft({
      title: "Document the integration", tags: [" интеграции ", "ИНТЕГРАЦИИ"],
    }));
    assert.equal(reused.ok, true, JSON.stringify(reused.error));
    assert.deepEqual((await act("task_show", { id: reused.data.id })).data.tags, ["Интеграции"]);
    const { data: updatedBoard } = await act("board_list", {});
    assert.deepEqual(updatedBoard.tags, ["Интеграции"]);
    assert.equal(updatedBoard.tagColors["Интеграции"], "#217D79");
    return { text: "Tag color saved." };
  });
  assert.equal(result.data?.answer, "Tag color saved.", JSON.stringify(result.error ?? result.data?.error));
});

test("manual card creation and tag editing allow an empty list on both board types", async t => {
  for (const boardType of ["manual", "agent"]) {
    await t.test(boardType, async t => {
      const f = fixture(t);
      const init = await f.cli(["init"], boardType === "manual" ? { boardType } : undefined);
      assert.equal(init.ok, true, JSON.stringify(init.error));
      const brief = { title: "Write a checklist", actor: "user" };
      const created = await f.cli(["create"], boardType === "manual" ? brief : plannedDraft(brief));
      assert.equal(created.ok, true, JSON.stringify(created.error));
      assert.deepEqual(created.data.tags, []);

      const { id, revision } = created.data;
      const tagged = await f.cli(["update", id], { revision, actor: "user", tags: ["Checklists"] });
      assert.equal(tagged.ok, true, JSON.stringify(tagged.error));
      assert.deepEqual(tagged.data.tags, ["Checklists"]);
      const cleared = await f.cli(["update", id], { revision: tagged.data.revision, actor: "user", tags: [] });
      assert.equal(cleared.ok, true, JSON.stringify(cleared.error));
      assert.deepEqual(cleared.data.tags, []);
    });
  }
});

test("an explicit disable during a manual goal turn releases the manager afterwards", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"], { git: false })).ok, true);
  const objective = "Отключи итеративный режим";
  const result = await f.run(objective, async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    assert.ok(goal?.finishTurn);
    goal.update({ objective, status: "active" });
    goal.accepted();
    assert.equal(goal.finishTurn(), false);
    const changed = await act("goal_configure_iteration", { enabled: false });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(goal.finishTurn(), true);
    return { text: "Автоматические ходы отключены." };
  }, [], true);
  assert.equal(result.data.answer, "Автоматические ходы отключены.", JSON.stringify(result));
  const saved = readJson(f.binding) as { goalId: string; goal: BoardGoal };
  assert.equal(saved.goal.status, "active");
  assert.equal(readIterativeGoal(f.project, saved.goalId).enabled, false);
  assert.ok(!runtimeEntries(f.project).some(entry => entry.task === "manager:context"));
});

test("only the current owner objective authorizes the reserve rule", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"], { git: false })).ok, true);
  const rules = [{ kind: "reserve", scope: "board", threshold: "multiplier", value: 2 }];
  const command = "Включи итеративный режим и настрой правило: если число карточек, доступных к запуску, меньше общего лимита исполнителей, умноженного на 2, создай четыре карточки и жди";
  for (const objective of ["Нужны четыре карточки", command]) {
    const result = await f.run(objective, async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
      assert.ok(goal);
      goal.update({ objective, status: "active" });
      goal.accepted();
      const incorrect = await act("goal_configure_iteration", { rules: [{ ...rules[0], value: 3 }] });
      assert.equal(incorrect.error.code, "USER_DIRECTION_REQUIRED");
      const configured = await act("goal_configure_iteration", { enabled: true, rules });
      if (objective === command) {
        assert.equal(configured.ok, true, JSON.stringify(configured));
        assert.deepEqual(JSON.parse(JSON.stringify(configured.data.rules)), rules);
      } else {
        assert.equal(configured.error.code, "USER_DIRECTION_REQUIRED");
      }
      return { text: "Checked rule authorization." };
    }, [], true);
    assert.equal(result.data?.answer, "Checked rule authorization.", JSON.stringify(result));
  }
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
  const result = await f.run("Prepare a release with automatic dispatch", async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.accepted();
    goal!.update({ objective: "Prepare a release", status: "active" });
    const initial = await act("board_auto_queue", {});
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.data.enabled, true);
    assert.equal((await act("board_set_auto_mode", { enabled: false, reason: "Handle the backlog" })).data.enabled, false);
    assert.equal((await act("board_auto_queue", {})).data.enabled, false);
    assert.equal((await act("board_set_auto_mode", { enabled: true, reason: "Return dispatch to the board" })).data.enabled, true);
    const controlled = await act("board_auto_queue", { revision: initial.data.queue.revision, order: [second.id, first.id], hold: [first.id] });
    assert.equal(controlled.ok, true, JSON.stringify(controlled));
    queueRevision = controlled.data.queue.revision;
    assert.equal((await act("board_auto_queue", { revision: 0, paused: true })).error.code, "REVISION_CONFLICT");
    goal!.enableNotifications(async text => { notifications.push(text); });
    await wait(400);
    const beforeUpdate = notifications.length;
    const waiting = act("task_wait", {});
    for (let attempt = 0; !f.boardListeners.size && attempt < 50; attempt++) await wait(10);
    assert.equal(f.boardListeners.size, 1, "an automatic goal can wait before any executor is known");
    const snapshot = (await f.cli(["show", second.id])).data;
    const started = await f.cli(["start", second.id], { revision: snapshot.revision, autoMode: true, autoQueueRevision: queueRevision });
    assert.equal(started.ok, true, JSON.stringify(started));
    f.setRunning(second.id, true);
    await f.pushBoard();
    const updated = await waiting;
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.data.automationUpdated, true);
    assert.equal(notifications.length, beforeUpdate, "queue state never enters the conversation transport");
    assert.equal((await f.cli(["show", second.id])).data.status, "in_progress");
    const paused = await act("board_auto_queue", { revision: queueRevision, paused: true });
    assert.equal(paused.ok, true);
    assert.equal((await f.cli(["show", second.id])).data.status, "in_progress");
    goal!.update({ objective: "Prepare a release", status: "paused" });
    return { text: "Queue planned and automatic work observed." };
  }, [], true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.error, undefined, JSON.stringify(result));
  assert.equal((await f.cli(["settings"])).data.autoMode, true);
  const saved = (await f.cli(["auto-queue"])).data;
  assert.equal(saved.paused, true);
  assert.deepEqual(saved.order, [second.id, first.id]);
  const before = notifications.length;
  await f.pushBoard(); await wait(400);
  assert.equal(notifications.length, before, "the completed turn removes its live subscription");
});

test("acceptance of a converted queue hold dispatches once when a slot opens", { timeout: 360_000 }, async t => {
  for (const iterative of [true, false]) {
    await t.test(iterative ? "iterative goal enabled" : "iterative goal disabled", async testContext => {
      const f = fixture(testContext);
      const cli = async (args: string[], input?: unknown) => {
        const result = await f.cli(args, input);
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.data;
      };
      await cli(["init"], { git: false });
      const create = (title: string, dependencies: string[] = []) =>
        cli(["create"], plannedDraft({ title, criteria: ["Verified"], dependencies }));
      const submit = async (id: string) => {
        const { token } = await cli(["preview", id]);
        return cli(["submit", id], { token, noChanges: true, summary: "Verified result", checks: ["Verified"] });
      };
      const accept = async (id: string) => {
        const { revision } = await cli(["show", id, "--compact"]);
        const done = await cli(["accept", id], { actor: "user", revision });
        assert.equal(done.status, "done");
      };
      const previous = await create("Already accepted input");
      await cli(["approve", previous.id]);
      await cli(["start", previous.id]);
      await submit(previous.id);
      await accept(previous.id);
      const formatter = await create("Formatter correction");
      await cli(["approve", formatter.id]);
      await cli(["start", formatter.id]);
      await submit(formatter.id);
      const dependent = await create("Work waiting for formatter acceptance", [previous.id]);
      const heldForDecision = await create("Work waiting for a separate decision", [formatter.id]);
      const cancelled = await create("Cancelled input");
      const needsCancelled = await create("Work waiting for cancelled input", [cancelled.id]);
      const ready = await cli(["approve", dependent.id]);
      await cli(["approve", heldForDecision.id]);
      await cli(["approve", needsCancelled.id]);
      await cli(["cancel", cancelled.id], { reason: "Cancelled before acceptance" });
      await cli(["auto-queue"], { revision: 0, hold: [dependent.id, heldForDecision.id] });

      const managed = await f.run("Record the formatter prerequisite", async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
        if (iterative) {
          goal!.accepted();
          goal!.update({ objective: "Record the formatter prerequisite", status: "active" });
        }
        const before = await act("board_auto_queue", {});
        const replacement = { id: dependent.id, revision: ready.revision, dependency: formatter.id };
        const change = { revision: before.data.queue.revision, replaceHold: replacement };
        if (iterative) {
          const invalid = await act("board_auto_queue", { ...change, replaceHold: { ...replacement, dependency: formatter.id + "x" } });
          assert.equal(invalid.error.code, "INVALID_INPUT");
          const stale = await act("board_auto_queue", { ...change, replaceHold: { ...replacement, revision: ready.revision - 1 } });
          assert.equal(stale.error.code, "REVISION_CONFLICT");
          const cycle = await act("board_auto_queue", { ...change, replaceHold: { ...replacement, dependency: dependent.id } });
          assert.equal(cycle.error.code, "DEPENDENCY_CYCLE");
          onBoard(locateBoard(f.project), store => {
            store.save = () => { throw new Error("Injected card write failure"); };
            assert.throws(() => updateAutoQueue(store, change), /Injected card write failure/);
          });
          assert.deepEqual((await act("board_auto_queue", {})).data.queue, before.data.queue);
          assert.deepEqual((await cli(["show", dependent.id])).dependencies, [previous.id]);
        }
        const changed = await act("board_auto_queue", change);
        assert.equal(changed.ok, true, JSON.stringify(changed));
        assert.deepEqual(changed.data.queue.held, [heldForDecision.id]);
        const saved = changed.data.tasks.find((task: Task) => task.id === dependent.id);
        assert.deepEqual(saved.dependencies, [previous.id, formatter.id]);
        assert.deepEqual(saved.unfinishedDependencies, [formatter.id]);
        return { text: "Formatter prerequisite saved." };
      }, [], iterative);
      assert.equal(managed.data?.answer, "Formatter prerequisite saved.", JSON.stringify(managed));
      const goalId = activeManagerGoal(f.project);
      if (iterative) {
        assert.ok(goalId);
        saveIterativeGoal(f.project, { goalId, questions: [], retryAt: Date.now() + 180_000 });
      }
      await cli(["settings"], { autoMode: true, iterativeGoal: iterative ? goalId : false,
        taskLimits: { executor: 1, reviewer: 1 } });

      const launches: string[] = [];
      const slots = createAgentSlots();
      const occupy = () => slots.acquire(f.project, "executor", { executor: 1 })!;
      let release = occupy();
      const windows = [{ isDestroyed: () => false, webContents: {} }, { isDestroyed: () => false, webContents: {} }];
      const openDispatcher = async () => {
        const board = await cli(["list", "--compact"]);
        const watch = { board, tabs: new Set(windows.map(window => ({ window }))), reviewerRuns: new Map() };
        const runtime = runInNewContext(dispatcherSource + "\n({ scheduleAutoBoard, autoBoards })", {
          quotaWait: undefined, boardBudgetFailure: () => undefined, applicationUpdates: { installing: false }, closingProjects: new Set(),
          subscriptions: new Map([[f.project, watch]]), isManual, taskReviewMode, usesIndependentReviewer,
          nextReadyTask, pendingReviewApprovals, agentSlots: slots, projectIdentity: (project: string) => project,
          currentActiveGoal: activeManagerGoal, readBoardThread: () => goalId ? { id: goalId } : undefined,
          boardThreadPath: managerGoalBinding, goalMessages, goalQueueCondition, readIterativeGoal, intervalDeadline, iterativeEnabled,
          boardWorkRequests: new Map(), boardRequests: new Map(), backgroundManagerRequests: new Map(),
          boardGoalResumes: new Set(), boardGoalClears: new Set(), executorBusy: () => false,
          runBoardRequest: () => assert.fail("Dispatch must not need a manager or goal turn"),
          broadcastBoardChat: (_project: string, _event: string, { error }: { error: string }) => { errors.push(error); },
          callCli: (_project: string, args: string[], input: unknown) => f.cli(args, input),
          launchTask: async (_project: string, id: string, _review: unknown, _thread: unknown, revision: number,
            _retry: unknown, _schedule: unknown, _resolve: unknown, _extra: unknown, autoMode: boolean, _manual: boolean,
            autoQueueRevision: number) => {
            launches.push(id);
            release = occupy();
            return f.cli(["start", id], { revision, autoMode, autoQueueRevision });
          },
        });
        const errors: string[] = [];
        return async () => {
          for (const _window of windows) runtime.scheduleAutoBoard(watch);
          while (runtime.autoBoards.get(watch)?.running) await wait(1);
          assert.deepEqual(errors, []);
        };
      };
      const tick = await openDispatcher();
      await tick();
      assert.deepEqual(launches, []);
      // The second window commits acceptance while the first window still holds its old snapshot.
      await accept(formatter.id);
      await tick();
      const eligible = await cli(["show", dependent.id, "--compact"]);
      assert.equal(eligible.status, "ready");
      assert.deepEqual(eligible.unfinishedDependencies, []);
      assert.deepEqual(launches, []);
      const restarted = await openDispatcher();
      await restarted();
      assert.deepEqual(launches, []);
      let queue = await cli(["auto-queue"]);
      queue = await cli(["auto-queue"], { revision: queue.revision, paused: true });
      release();
      await restarted();
      assert.deepEqual(launches, []);
      await cli(["auto-queue"], { revision: queue.revision, paused: false });
      await cli(["settings"], { autoMode: false });
      await restarted();
      assert.deepEqual(launches, []);
      release = occupy();
      await cli(["settings"], { autoMode: true });
      await restarted();
      assert.deepEqual(launches, []);
      release();
      await restarted();
      assert.deepEqual(launches, [dependent.id]);
      release();
      await (await openDispatcher())();
      assert.deepEqual(launches, [dependent.id]);
      assert.equal((await cli(["show", dependent.id])).status, "in_progress");
      assert.equal((await cli(["show", heldForDecision.id])).status, "ready");
      assert.deepEqual((await cli(["show", needsCancelled.id])).unfinishedDependencies, [cancelled.id]);
    });
  }
});

test("release dispatch rechecks the queue and milestone under the start lock", { timeout: 180_000 }, async t => {
  const f = fixture(t);
  const cli = async (args: string[], input?: unknown) => {
    const result = await f.cli(args, input);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  await cli(["init"], { git: false });
  await cli(["settings"], { autoMode: true, reviewMode: "human", taskLimits: { executor: 2 } });
  const early = { repository: "owner/repo", number: 1, title: "0.1.2-alpha" };
  const late = { repository: "owner/repo", number: 2, title: "0.1.3-alpha" };
  const setMilestone = (id: string, milestone: Task["milestone"]) => onBoard(locateBoard(f.project), store => {
    const task = store.card(id);
    return store.save({ ...task, revision: task.revision + 1, milestone });
  });
  const create = async (title: string, milestone: Task["milestone"], dependencies?: string[]) => {
    const draft = await cli(["create"], plannedDraft({ title, dependencies }));
    await cli(["approve", draft.id]);
    return setMilestone(draft.id, milestone);
  };
  const first = await create("First release task", early);
  const second = await create("Second release task", early);
  const later = await create("Next release", late);
  await cli(["auto-queue"], { revision: 0, order: [later.id, first.id, second.id] });

  const slots = createAgentSlots();
  const release = new Map<string, () => void>();
  const attempts: [string, string][] = [];
  const errors: string[] = [];
  let beforeStart: (() => Promise<void>) | undefined;
  const window = () => ({ window: { isDestroyed: () => false, webContents: {} } });
  const windows = [window(), window()];
  const watch = { board: await cli(["list", "--compact"]), tabs: new Set(windows), reviewerRuns: new Map() };
  const runtime = runInNewContext(dispatcherSource + "\n({ scheduleAutoBoard, autoBoards })", {
    quotaWait: undefined, boardBudgetFailure: () => undefined, applicationUpdates: { installing: false }, closingProjects: new Set(),
    subscriptions: new Map([[f.project, watch]]), isManual, taskReviewMode, usesIndependentReviewer,
    nextReadyTask, pendingReviewApprovals, agentSlots: slots, projectIdentity: (project: string) => project,
    currentActiveGoal: () => undefined,
    boardWorkRequests: new Map(), boardRequests: new Map(), backgroundManagerRequests: new Map(),
    executorBusy: (_project: string, id: string) => release.has(id),
    broadcastBoardChat: (_project: string, _event: string, { error }: { error: string }) => { errors.push(error); },
    callCli: (_project: string, args: string[], input: unknown) => args[0] === "milestones"
      ? { ok: true, data: { milestones: [] } } : f.cli(args, input),
    launchTask: async (_project: string, id: string, _review: unknown, _thread: unknown, revision: number,
      _retry: unknown, scheduled: boolean, _resolve: unknown, _extra: unknown, autoMode: boolean, _manual: boolean,
      autoQueueRevision: number) => {
      const mutate = beforeStart;
      beforeStart = undefined;
      await mutate?.();
      const result = await f.cli(["start", id], { revision, scheduled, autoMode, autoQueueRevision });
      attempts.push([id, result.ok ? "started" : result.error.code]);
      if (result.ok) {
        const slot = slots.acquire(f.project, "executor", { executor: 2 });
        assert.ok(slot);
        release.set(id, slot);
      }
      return result;
    },
  });
  const tick = async () => {
    for (const _window of windows) runtime.scheduleAutoBoard(watch);
    while (runtime.autoBoards.get(watch)?.running) await wait(1);
    assert.deepEqual(errors, []);
  };
  const finish = async (id: string) => {
    const { token } = await cli(["preview", id]);
    await cli(["submit", id], { token, noChanges: true, summary: "Verified result", checks: ["Verified"] });
    const { revision } = await cli(["show", id]);
    await cli(["accept", id], { actor: "user", revision });
  };
  const releaseSlot = (id: string) => {
    release.get(id)?.();
    release.delete(id);
  };
  t.after(() => { for (const id of release.keys()) releaseSlot(id); });

  beforeStart = async () => { await cli(["auto-queue"], { revision: 1, order: [later.id, second.id, first.id] }); };
  await tick();
  assert.deepEqual(attempts, [[first.id, "AUTO_QUEUE_CHANGED"]]);
  await tick();
  assert.deepEqual(attempts.slice(1), [[second.id, "started"], [first.id, "started"]]);
  releaseSlot(first.id);
  const { token } = await cli(["preview", first.id]);
  const review = await cli(["submit", first.id], { token, noChanges: true, summary: "Verified result", checks: ["Verified"] });
  await tick();
  assert.equal(attempts.length, 3);
  await finish(second.id);
  releaseSlot(second.id);
  await tick();
  assert.equal(attempts.length, 3, "review alone keeps the early release open");
  await cli(["accept", first.id], { actor: "user", revision: review.revision });

  const dependent = await create("Cross-release dependency", late, [later.id]);
  beforeStart = async () => { setMilestone(dependent.id, early); };
  await tick();
  assert.deepEqual(attempts.at(-1), [later.id, "AUTO_RELEASE_WAIT"]);
  const diagnostic = await f.run("Inspect release wait", async act => {
    const queue = (await act("board_auto_queue", {})).data.tasks;
    assert.deepEqual(queue.find((task: Task) => task.id === dependent.id).unfinishedDependencies, [later.id]);
    assert.deepEqual(queue.find((task: Task) => task.id === later.id).releaseWait, { version: early.title, taskIds: [dependent.id] });
    return { text: "Release wait confirmed" };
  });
  assert.equal(diagnostic.data?.answer, "Release wait confirmed", JSON.stringify(diagnostic));
  await tick();
  assert.equal(attempts.length, 4);
  await cli(["start", later.id], { actor: "user", revision: later.revision });
  await finish(later.id);
  await tick();
  await tick();
  assert.deepEqual(attempts.slice(4), [[dependent.id, "started"]]);

  const scheduled = await create("Scheduled later release", late);
  onBoard(locateBoard(f.project), store => {
    const task = store.card(scheduled.id);
    store.save({ ...task, schedule: { everyMinutes: 60, nextAt: new Date(Date.now() - 1000).toISOString() } });
  });
  const ordinary = await create("Ordinary later release", late);
  await tick();
  assert.deepEqual(attempts.slice(5), [[scheduled.id, "started"]]);
  await finish(dependent.id);
  releaseSlot(dependent.id);
  await tick();
  assert.deepEqual(attempts.slice(5), [[scheduled.id, "started"], [ordinary.id, "started"]]);
});

test("the goal dispatcher wakes when release order leaves its ready queue below target", async () => {
  const project = "release-goal";
  const goalId = "current-goal";
  const early = {
    id: "T-0001",
    status: "ready",
    priority: "normal",
    expertWorkPlanned: true,
    milestone: { repository: "owner/repo", number: 1, title: "0.1.2-alpha" },
    unfinishedDependencies: ["T-0002"],
  };
  const later = ["T-0002", "T-0003"].map(id => ({
    id,
    status: "ready",
    priority: "normal",
    expertWorkPlanned: true,
    milestone: { repository: "owner/repo", number: 2, title: "0.1.3-alpha" },
  }));
  const board = {
    project,
    settings: { autoMode: true, autoModeEnabledAt: 0, reviewMode: "human", iterativeGoal: goalId, taskLimits: { executor: 1 } },
    tasks: [early, ...later] as (typeof later[number] & {
      activity?: { blocked?: { at: string; sequence: number } };
    })[],
  };
  const watch = {
    board,
    tabs: new Set([{ window: { isDestroyed: () => false, webContents: {} } }]),
    reviewerRuns: new Map(),
  };
  const turns: { ready: number; target: number; freeExecutorSlots: number }[] = [];
  const turnReasons: { kind: string; scope?: string }[][] = [];
  const launches: string[] = [];
  const errors: string[] = [];
  let state: ReturnType<typeof readIterativeGoal> = { goalId, questions: [] };
  let slots: { kind: string; role: string; task: string }[] = [];
  let executorRelease: { kind: string; id: string; releasedAt: number } | undefined;
  let active = true;
  let automationPaused = false;
  const goalWork = new Map();
  const runtime = runInNewContext(dispatcherSource + "\n({ scheduleAutoBoard, autoBoards })", {
    applicationUpdates: { installing: false }, quotaWait: undefined, boardBudgetFailure: () => undefined, closingProjects: new Set(),
    subscriptions: new Map([[project, watch]]), isManual, taskReviewMode, usesIndependentReviewer,
    nextReadyTask, pendingReviewApprovals, projectIdentity: (key: string) => key,
    agentSlots: {
      entries: () => executorRelease ? [...slots, executorRelease] : slots,
      available: () => !automationPaused,
      claim: () => () => {},
    },
    currentActiveGoal: () => active ? goalId : undefined, readBoardThread: () => ({ id: goalId }), boardThreadPath: () => project,
    goalMessages: () => [], goalQueueCondition, goalEventConditions, goalReserveTarget, iterativeEnabled, intervalDeadline,
    readIterativeGoal: () => state, saveIterativeGoal: (_project: string, next: typeof state) => { state = next; },
    boardWorkRequests: goalWork, boardRequests: new Map(), backgroundManagerRequests: new Map(),
    boardGoalResumes: new Set(), boardGoalClears: new Set(), executorBusy: () => false,
    broadcastBoardChat: (_project: string, _event: string, { error }: { error: string }) => {
      errors.push(error);
    },
    callCli: (_project: string, [command]: string[]) => {
      if (command === "list") return { ok: true, data: board };
      assert.equal(command, "milestones");
      return { ok: true, data: { milestones: [] } };
    },
    runBoardRequest: async (...args: unknown[]) => {
      assert.equal(args[4], "iterate");
      const prompt = String(args[2]);
      const { ready, target, freeExecutorSlots, reasons } = JSON.parse(prompt.slice(prompt.indexOf("{")));
      turns.push({ ready, target, freeExecutorSlots });
      turnReasons.push(reasons);
      const receipt = args[12] as Pick<typeof state, "waitFor" | "handled" | "freeExecutorSlots" | "reserveEpoch" |
        "executorReleaseId"> & { due?: number };
      state = {
        ...state, waitFor: receipt.waitFor, handled: receipt.handled,
        freeExecutorSlots: receipt.freeExecutorSlots, reserveEpoch: receipt.reserveEpoch,
        executorReleaseId: receipt.executorReleaseId,
      };
      if (receipt.due !== undefined && state.intervalMs) {
        state.nextAt = advanceInterval(receipt.due, state.intervalMs, Date.now());
      }
      return { ok: true };
    },
    launchTask: async (_project: string, id: string) => {
      launches.push(id);
      return cliFailure("EXECUTOR_LIMIT", "Slot taken before launch");
    },
  });
  const tick = async () => {
    runtime.scheduleAutoBoard(watch);
    while (runtime.autoBoards.get(watch)?.running) await wait(1);
    assert.deepEqual(errors, []);
  };
  await tick();
  await tick();
  assert.deepEqual(launches, []);
  assert.deepEqual(turns, [{ ready: 0, target: 2, freeExecutorSlots: 1 }]);

  early.status = "done";
  await tick();
  assert.deepEqual(launches, ["T-0002"]);
  assert.equal(turns.length, 1);

  automationPaused = true;
  early.status = "blocked";
  // Empty reserve. The in-progress card itself and the live slot have independent lifetimes.
  board.tasks.splice(1, 2, { ...later[0], status: "in_progress" });
  slots = [{ kind: "slot", role: "executor", task: later[0].id }];
  await tick();
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.at(-1), { ready: 0, target: 2, freeExecutorSlots: 0 });
  slots = [];
  await tick();
  await tick();
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.at(-1), { ready: 0, target: 2, freeExecutorSlots: 1 });

  slots = [{ kind: "slot", role: "executor", task: later[0].id }];
  await tick();
  slots = [];
  active = false;
  await tick();
  board.settings.autoMode = false;
  active = true;
  await tick();
  assert.equal(turns.length, 3);

  board.settings.autoMode = true;
  board.settings.autoModeEnabledAt = Date.now();
  await tick();
  await tick();
  assert.equal(turns.length, 3, "a slot released during a paused period is ignored on resume");

  slots = [{ kind: "slot", role: "executor", task: later[0].id }];
  await tick();
  slots = [];
  await tick();
  await tick();
  assert.equal(turns.length, 4, "the next release in the active period wakes once");

  goalWork.set(project, { changingGoal: true });
  slots = [{ kind: "slot", role: "executor", task: later[0].id }];
  await tick();
  slots = [];
  executorRelease = { kind: "executor-release", id: "short-executor", releasedAt: Date.now() };
  await tick();
  assert.equal(turns.length, 4, "no second turn runs concurrently with the goal");
  goalWork.delete(project);
  await tick();
  await tick();
  assert.equal(turns.length, 5, "the saved release wakes once even though both slot snapshots matched");

  board.settings.autoModeEnabledAt = 0;
  state = {
    goalId, questions: [], intervalMs: 60_000, nextAt: Date.now() - 1,
    rules: [{ kind: "blocked", scope: early.id }],
  };
  board.tasks[0].activity = { blocked: { at: new Date().toISOString(), sequence: 2 } };
  watch.tabs.add({ window: { isDestroyed: () => false, webContents: {} } });
  runtime.scheduleAutoBoard(watch);
  await tick();
  assert.equal(turns.length, 6);
  assert.deepEqual(turnReasons.at(-1), [{ kind: "interval" }, { kind: "blocked", scope: early.id }]);
  state = JSON.parse(JSON.stringify(state));
  await tick();
  assert.equal(turns.length, 6, "reading the saved receipt suppresses repeat delivery");
});

test("internal queue wakes preserve sequential questions through the manager inbox", async t => {
  const f = fixture(t);
  await f.cli(["init"], { git: false });
  await f.cli(["settings"], { autoMode: true, reviewMode: "reviewer-human" });
  const draft = (await f.cli(["create"], plannedDraft({ title: "Inbox source" }))).data;
  await f.cli(["approve", draft.id]);
  await f.cli(["start", draft.id]);
  f.setRunning(draft.id, true);
  await f.pushBoard();
  const result = await f.run("Coordinate the queue", async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.accepted();
    goal!.update({ objective: "Coordinate the queue", status: "active" });
    goal!.enableNotifications();
    await wait(400);
    const before = f.managerNotifications.length;
    const routineWait = act("task_wait", {});
    await f.cli(["message", draft.id], { kind: "update", text: "Routine progress" });
    await f.pushBoard();
    const routine = await routineWait;
    assert.equal(routine.ok, true, JSON.stringify(routine));
    assert.equal(routine.data.automationUpdated, true);
    assert.deepEqual(Array.from(routine.data.inbox), []);
    const errorWait = act("task_wait", {});
    f.automationError("accept T-0001: Integration needs attention");
    const failed = await errorWait;
    assert.equal(failed.ok, true, JSON.stringify(failed));
    assert.equal(failed.automationErrors[0].error, "accept T-0001: Integration needs attention");
    const questionWait = act("task_wait", {});
    const first = (await f.cli(["message", draft.id], { kind: "question", text: "Choose release A or B" })).data;
    await f.pushBoard();
    const second = (await f.cli(["message", draft.id], { kind: "question", text: "Confirm the deployment window" })).data;
    await f.pushBoard();
    const received = await questionWait;
    assert.equal(received.ok, true, JSON.stringify(received));
    const remaining = await act("manager_inbox", {});
    const questions = [...received.data.inbox, ...remaining.data].filter(message => message.kind === "question");
    assert.deepEqual(questions.map(message => message.sequence), [first.sequence, second.sequence]);
    assert.deepEqual(Array.from((await act("manager_inbox", {})).data), []);
    assert.equal((await act("manager_ack", { id: draft.id, through: second.sequence })).ok, true);
    assert.equal((await act("board_auto_queue", {})).data.reviewMode, "reviewer-human");
    assert.equal(f.managerNotifications.length, before, "questions use tool results rather than steer");
    goal!.update({ objective: "Coordinate the queue", status: "complete" });
    return { text: "Questions handled" };
  }, [], true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.error, undefined, JSON.stringify(result));
  assert.equal((await f.cli(["manager-inbox"])).data.length, 0);
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
      const updated = await act("github_update_milestone", { repository: "owner/example", number: 1, state: "closed" });
      assert.equal(updated.error.code, "GITHUB_REMOTE_REQUIRED");
      return { text: "No GitHub origin." };
    }, [], goal);
    assert.ok(reply.ok, JSON.stringify(reply.error));
  }
  assert.equal(f.cliCalls.filter(([name]) => name === "github-milestone-due").length, 2);
  assert.equal(f.cliCalls.filter(([name]) => name === "github-milestone-create").length, 2);
  assert.equal(f.cliCalls.filter(([name]) => name === "github-milestone-update").length, 2);
});

test("manager reveals milestone links before deletion and waits for native confirmation", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const target = { repository: "owner/example", number: 7 };
  const milestone = { ...target, title: "Release", state: "closed" };
  let linkedCards = Array.from({ length: 200 }, (_, index) => ({
    id: "T-" + String(index + 1).padStart(4, "0"), title: "Release card ".repeat(16), archived: index % 2 === 0,
  }));
  assert.ok(JSON.stringify(linkedCards).length > 24_000);
  let deletes = 0;
  let snapshot = "a".repeat(64);
  f.milestoneDeletion.run = input => {
    assert.equal(input.repository, target.repository);
    assert.equal(input.number, target.number);
    if (input.token === undefined) return { milestone, linkedCards, snapshot, token: "internal", deleted: false };
    assert.equal(input.token, "internal");
    deletes++;
    return { ...target, state: "deleted", deleted: true };
  };
  let previewSnapshot: string | undefined;
  const preview = async (act: (name: string, args: unknown) => Promise<any>, args: Record<string, unknown>) => {
    const result = await act("github_delete_milestone", { ...target, ...args });
    assert.equal(result.data.deleted, false);
    assert.equal(JSON.stringify(result.data.linkedCards), JSON.stringify(linkedCards));
    assert.equal(result.data.token, undefined);
    assert.equal(result.data.previewSnapshot, snapshot);
    assert.equal(f.pendingQuestion(), undefined);
    assert.equal(deletes, 0);
    previewSnapshot = result.data.previewSnapshot;
  };
  assert.ok((await f.run("Delete owner/example milestone #7 and keep its links", async act => {
    await preview(act, { keepLinks: true });
    await preview(act, {});
    return { text: "The milestone is linked." };
  })).ok);
  snapshot = "b".repeat(64);
  linkedCards[0] = { ...linkedCards[0], archived: false };
  assert.ok((await f.run("Keep its links", async act => {
    await preview(act, { keepLinks: true, previewSnapshot });
    return { text: "The milestone is linked." };
  })).ok);
  for (const { allow, keepLinks } of [
    { allow: false, keepLinks: true }, { allow: true, keepLinks: true }, { allow: true, keepLinks: false },
  ]) {
    if (!keepLinks) linkedCards = [];
    const before = deletes;
    const started = Promise.withResolvers<void>();
    const request = f.run("Delete owner/example milestone #7", async act => {
      const pending = act("github_delete_milestone", { ...target, keepLinks, ...(keepLinks ? { previewSnapshot } : {}) });
      started.resolve();
      const result = await pending;
      if (allow) assert.equal(result.data.deleted, true);
      else assert.equal(result.error.code, "GITHUB_MILESTONE_CONFIRMATION_REQUIRED");
      return { text: "Deletion decision handled." };
    });
    await started.promise;
    while (!f.pendingQuestion()) await new Promise(resolve => setImmediate(resolve));
    const question = f.pendingQuestion();
    assert.equal(question.approval, true);
    assert.match(question.text, /owner\/example #7 \(closed\)/);
    assert.ok(question.text.length < 500);
    if (keepLinks) assert.match(question.text, /200 cards.*full list/);
    assert.equal(deletes, before);
    assert.equal((await f.answerQuestion(question.id, question.options[allow ? 0 : 1])).ok, true);
    assert.ok((await request).ok);
  }
  assert.equal(deletes, 2);
});

test("cancelling the milestone MCP call closes the approval and prevents deletion", { timeout: 15_000 }, async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const target = { repository: "owner/example", number: 7 };
  f.milestoneDeletion.run = input => {
    assert.equal(input.token, undefined);
    return { milestone: { ...target, title: "Release", state: "open" }, linkedCards: [], snapshot: "a".repeat(64), token: "internal" };
  };
  const lifetime = new AbortController();
  const request = f.run("Delete milestone #7", async act => {
    const result = await act("github_delete_milestone", target, lifetime.signal);
    assert.equal(result.error.code, "GITHUB_MILESTONE_CONFIRMATION_REQUIRED");
    return { text: "Cancelled." };
  });
  while (!f.pendingQuestion()) await new Promise(resolve => setImmediate(resolve));
  const question = f.pendingQuestion();
  lifetime.abort();
  assert.ok((await request).ok);
  assert.equal(f.pendingQuestion(), undefined);
  assert.equal((await f.answerQuestion(question.id, "Allow once")).error.code, "QUESTION_CLOSED");
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

function attemptWhileBoardLocked<T>(project: string, attempt: () => T): T {
  return onBoard(locateBoard(project), () => {
    const startedAt = performance.now();
    const result = attempt();
    assert.ok(performance.now() - startedAt < 2_000, "Dispatch must return promptly while the SQLite board lock is held");
    return result;
  }, 0);
}

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
    assert.equal((await act("board_set_auto_mode", { enabled: false, reason: "Review role" })).error.code, "INVALID_INPUT");
    assert.equal((await act("task_review", { id: "T-0002" })).error.code, "INVALID_INPUT");
    if (calls === 1) {
      goal.endTurn();
      assert.deepEqual(Object.keys(activity()), []);
    }
    return { text: "Waiting for human judgment." };
  };
  const board = { project: join(f.folder, "project"), settings: { reviewMode: "human", autoMode: false },
    tasks: [{ id: "T-0001", status: "review", revision: 7, expertReviewPlanned: true }] };
  const watch = f.schedule(board, respond);
  activity = watch.reviewing;
  watch.tick();
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(watch.reviewing()), []);
  await f.cli(["settings"], { reviewMode: "manager", autoMode: true });
  board.settings.reviewMode = "manager";
  board.settings.autoMode = true;
  f.setRunning("T-0001", true);
  watch.tick();
  assert.equal(calls, 0);
  await watch.done();
  f.setRunning("T-0001", false);
  const notice = await attemptWhileBoardLocked(f.project, () => f.automaticNotice(board));
  assert.equal(notice.error.code, "BOARD_BUSY");
  attemptWhileBoardLocked(f.project, () => {
    watch.tick();
    assert.deepEqual(Object.keys(watch.reviewing()), []);
    assert.equal(calls, 0);
  });
  await f.cli(["settings"], { autoMode: false });
  await watch.done();
  assert.equal((await f.automaticNotice(board)).error.code, "AUTO_MODE_DISABLED");
  watch.tick();
  assert.equal(calls, 0);
  await f.cli(["settings"], { autoMode: true });
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

test("approved reviewer integration stays disabled with auto mode off while a goal runs and after release", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const release = f.agentSlots.claim(f.project, "manager:context");
  assert.ok(release);
  f.agentSlots.entries = runtimeEntries;
  runtimeTransaction(f.project, entries => {
    entries.find(entry => entry.task === "manager:context")!.state = { id: "active-goal", phase: "running",
      lane: "work", startedAt: Date.now(), goalRunning: true };
  });
  let backgroundCalls = 0;
  const watch = f.schedule({
    project: f.project, settings: { reviewMode: "reviewer" },
    tasks: [{ id: "T-0001", status: "review", revision: 7, reviewApproved: true }],
    managerInbox: [{ id: "T-0001", kind: "review-approve", sequence: 12 }],
  }, async () => { backgroundCalls++; return { text: "Handled outstanding approval." }; });
  try {
    watch.tick();
    await watch.done();
    assert.equal(backgroundCalls, 0);
  } finally { release(); }
  watch.tick();
  await watch.done();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(backgroundCalls, 0);
});

test("manager has no configurable capacity limit and gives the goal a separate context", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const configured = await f.cli(["settings"], { taskLimits: { manager: 1 } });
  assert.equal(configured.error.code, "INVALID_INPUT");
  f.agentSlots.configure({ executor: 1, manager: 1, reviewer: 1 });
  const release = f.agentSlots.acquire(f.project, "manager")!;
  assert.equal(f.agentSlots.available(f.project, "manager", { manager: 1 }), Infinity);
  assert.equal((await f.run("Discuss", async () => ({ text: "Ready" }))).ok, true);
  const goal = await f.run("Coordinate release", async (_act, _prompt, _images, id) => {
    assert.notEqual(id, f.dialogueId);
    return { text: "Separate context" };
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
    const created = await act("task_create", plannedDraft({ title: "Inventory fixtures", tags: ["Fixtures"], execution }));
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

test("a stale reviewer-human snapshot cannot reserve a reviewer after switching to human with automatic mode off", { timeout: 90_000 }, async t => {
  const f = fixture(t);
  await f.cli(["init"], { git: false });
  await f.cli(["settings"], { reviewMode: "reviewer-human", autoMode: true });
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Waiting for review", criteria: ["Verified"] }));
  await f.cli(["approve", task.id]);
  await f.cli(["start", task.id]);
  const { data: preview } = await f.cli(["preview", task.id]);
  assert.equal((await f.cli(["submit", task.id], { token: preview.token, noChanges: true,
    summary: "External result", checks: ["Verified"] })).ok, true);
  const { data: snapshot } = await f.cli(["list", "--compact"]);
  const queue = f.schedule(snapshot, async () => assert.fail("Unexpected manager review"));
  let calls = 0;
  f.setReviewer(async () => {
    calls++;
    return { summary: "Reviewed", needsHuman: true, findings: [], evidence: ["Checked"] };
  });
  attemptWhileBoardLocked(f.project, queue.tick);
  assert.deepEqual(Object.keys(queue.reviewing()), []);
  await queue.done();
  assert.equal(calls, 0);
  assert.equal((await f.cli(["settings"], { reviewMode: "human", autoMode: false })).ok, true);
  queue.tick();
  assert.deepEqual(Object.keys(queue.reviewing()), []);
  await queue.done();
  assert.equal(calls, 0);
  await queue.refresh();
  queue.tick();
  await queue.done();
  assert.equal(calls, 0);

  const setMode = (mode: "reviewer-human" | "reviewer", revision: number) => {
    const authorization = `Set ${task.id} to ${mode}`;
    const saved = setReviewModeFromChat(f.project, authorization, { id: task.id, revision, mode, authorization });
    assert.ok(saved.ok, JSON.stringify(saved));
    return saved.data.revision;
  };
  const current = (await f.cli(["show", task.id])).data;
  const hybridRevision = setMode("reviewer-human", current.revision);
  await queue.refresh();
  const reviewerRevision = setMode("reviewer", hybridRevision);
  queue.tick();
  assert.deepEqual(Object.keys(queue.reviewing()), []);
  await queue.done();
  assert.equal(calls, 0);

  const reservedRevision = setMode("reviewer-human", reviewerRevision);
  await queue.refresh();
  f.beforeReviewRead(() => { setMode("reviewer", reservedRevision); });
  queue.tick();
  await queue.done();
  assert.equal(calls, 0);

  await queue.refresh();
  queue.tick();
  await queue.done();
  assert.equal(calls, 1);
});

for (const reviewMode of ["reviewer", "reviewer-human"]) {
  test(reviewMode + " uses the shared review queue with and without automatic mode", { timeout: 120_000 }, async t => {
    const f = fixture(t);
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", f.project, ...args], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-b", "main");
    git("config", "user.name", "Taskboard");
    git("config", "user.email", "taskboard@example.invalid");
    git("commit", "--allow-empty", "-m", "Initial commit");
    await f.cli(["init"]);
    f.agentSlots.configure({ executor: 1, manager: 1, reviewer: 1 });
    for (const autoMode of [false, true]) {
      assert.equal((await f.cli(["settings"], { reviewMode, autoMode, reviewer: { model: "fixture", effort: "low" } })).ok, true);
      const ids: string[] = [];
      const submit = async (id: string, commit = false) => {
        const { data: preview } = await f.cli(["preview", id]);
        assert.equal((await f.cli(["submit", id], { token: preview.token, ...(commit ? { message: "test: add review evidence" } : { noChanges: true }),
          summary: "External result", checks: ["Read the result"] })).ok, true);
      };
      for (const title of ["First", "Second"]) {
        const { data: task } = await f.cli(["create"], plannedDraft({ title, criteria: ["Check the result"] }));
        await f.cli(["approve", task.id]);
        const started = await f.cli(["start", task.id]);
        assert.equal(started.ok, true, JSON.stringify(started));
        if (title === "First") {
          await writeFile(join(started.data.worktree, "evidence.txt"), "Review evidence\n");
          await submit(task.id, true);
        }
        ids.push(task.id);
      }
      const release = Promise.withResolvers<void>();
      const calls: Array<{ id: string; revision: number }> = [];
      f.setReviewer(async ({ id, revision }) => {
        calls.push({ id, revision });
        if (calls.length === 1) await release.promise;
        const findings = id === ids[1] && calls.filter(call => call.id === id).length === 1 ? ["Fix the result"] : [];
        return { summary: "Reviewed", findings, needsHuman: false, evidence: ["Checked"] };
      });
      const schedule = async () => f.schedule((await f.cli(["list", "--compact"])).data,
        async () => assert.fail("The review scheduler must not dispatch manager integration directly"));
      const queue = await schedule();
      f.setQuotaPaused(true);
      queue.tick();
      await queue.done();
      assert.equal(calls.length, 0);
      f.setQuotaPaused(false);
      queue.tick();
      for (let i = 0; !calls.length && i < 250; i++) await wait(20);
      try {
        assert.equal(calls.length, 1);
        assert.equal(Object.keys(queue.reviewing()).length, 1);
        await submit(ids[1]);
        await queue.refresh();
        queue.addWindow();
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
      const first = calls[0].id;
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
      assert.deepEqual(calls.map(call => call.id), [ids[0], ids[1], ids[1]]);
      assert.ok(calls[2].revision > calls[1].revision);
      t.diagnostic(JSON.stringify({ reviewMode, autoMode, calls }));
      for (const id of ids) {
        const { data } = await f.cli(["review", id, "--compact"]);
        assert.ok(data.reviewerApproval);
        assert.equal(Boolean(data.awaitingHumanAcceptance), reviewMode === "reviewer-human");
      }
      assert.equal((await f.cli(["settings"])).data.autoMode, autoMode);
      if (reviewMode === "reviewer" && !autoMode) {
        git("commit", "--allow-empty", "-m", "Advance the review target");
        await restarted.refresh();
        restarted.tick();
        await restarted.done();
        assert.deepEqual(calls.map(call => call.id), [ids[0], ids[1], ids[1], ids[0]]);
        const { data } = await f.cli(["review", ids[0], "--compact"]);
        assert.equal(data.reviewerApproval?.targetHead, data.targetHead);
        t.diagnostic(JSON.stringify({ advancedTarget: calls[3] }));
      }
    }
  });
}

test("a saved reviewer note prevents duplicate reviews after restart for both submission types", { timeout: 180_000 }, async t => {
  const f = fixture(t);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", f.project, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Taskboard");
  git("config", "user.email", "taskboard@example.invalid");
  git("commit", "--allow-empty", "-m", "Initial commit");
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.cli(["settings"], {
    autoMode: false, reviewMode: "reviewer", reviewer: { model: "fixture", effort: "low" },
  })).ok, true);

  const tasks: Task[] = [];
  for (const noChanges of [false, true]) {
    const { data: task } = await f.cli(["create"], plannedDraft({
      title: noChanges ? "External result" : "Git result", criteria: ["Check evidence"],
    }));
    assert.equal((await f.cli(["approve", task.id])).ok, true);
    const started = await f.cli(["start", task.id]);
    assert.equal(started.ok, true);
    if (!noChanges) {
      await writeFile(join(started.data.worktree, "evidence.txt"), "Review evidence\n");
    }
    const { data: preview } = await f.cli(["preview", task.id]);
    const submission = await f.cli(["submit", task.id], {
      token: preview.token,
      ...(noChanges ? { noChanges: true } : { message: "test: add evidence" }),
      summary: "Submitted", checks: ["Checked"],
    });
    assert.equal(submission.ok, true, JSON.stringify(submission));
    tasks.push(submission.data);
  }
  const [gitTask, externalTask] = tasks;
  const calls: Array<{ id: string; revision: number; targetHead: string | null }> = [];
  f.setReviewer(async ({ id, revision, targetHead }) => {
    calls.push({ id, revision, targetHead });
    return { summary: "Needs a human decision", needsHuman: true, findings: [], evidence: ["Checked"] };
  });
  const list = async () => (await f.cli(["list", "--compact"])).data;
  const reviewAfterOpening = async (snapshot?: Awaited<ReturnType<typeof list>>) => {
    const watch = f.schedule(snapshot ?? await list(), async () => assert.fail("Unexpected manager run"));
    watch.reloadReviewReports();
    watch.tick();
    await watch.done();
  };
  const beforeNotes = await list();
  await reviewAfterOpening(beforeNotes);
  for (const task of tasks) {
    const { data } = await f.cli(["show", task.id]);
    assert.equal(data.status, "review");
    assert.equal(data.history.at(-1).action, "review-note");
  }
  assert.equal(calls.length, 2);
  await reviewAfterOpening();
  assert.equal(calls.length, 2);
  await reviewAfterOpening(beforeNotes);
  assert.equal(calls.length, 2);

  git("commit", "--allow-empty", "-m", "Advance the review target");
  await reviewAfterOpening();
  const first = calls.find(call => call.id === gitTask.id);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].id, gitTask.id);
  assert.equal(calls[2].revision, first?.revision);
  assert.notEqual(calls[2].targetHead, first?.targetHead);

  assert.equal((await f.cli(["expert-message", externalTask.id], {
    actor: "user", to: "reviewer", kind: "decision", text: "Check the evidence again.",
  })).ok, true);
  await reviewAfterOpening();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].id, externalTask.id);
  assert.equal(calls[3].targetHead, null);
  await reviewAfterOpening();
  assert.equal(calls.length, 4);

  const { data: external } = await f.cli(["show", externalTask.id]);
  const authorization = `Set ${externalTask.id} to reviewer-human`;
  const changed = setReviewModeFromChat(f.project, authorization, {
    id: externalTask.id, revision: external.revision, mode: "reviewer-human", authorization,
  });
  assert.ok(changed.ok, JSON.stringify(changed));
  await reviewAfterOpening();
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[4], { id: externalTask.id, revision: changed.data.revision, targetHead: null });
  await reviewAfterOpening();
  assert.equal(calls.length, 5);
  t.diagnostic(JSON.stringify(calls));
});

test("an unfinished independent review keeps the submission and releases the manager to return it", { timeout: 60_000 }, async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  assert.equal((await f.cli(["settings"], { reviewMode: "reviewer", autoMode: true, reviewer: { model: "fixture", effort: "low" } })).ok, true);
  const created = await f.cli(["create"], plannedDraft({ title: "Source comparison", criteria: ["Verify the referenced facts"] }));
  assert.equal(created.ok, true, JSON.stringify(created));
  const task = created.data;
  const plan = await f.cli(["expert-plan", task.id], {
    phase: "review", revision: task.revision, lead: "independent-reviewer", reason: "Independent source verification",
    stages: [{ key: "verify", expertId: "independent-reviewer", title: "Verify facts",
      criteria: ["Verify the referenced facts"], inputs: [], outputs: ["evidence"], dependsOn: [] }],
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal((await f.cli(["approve", task.id])).ok, true);
  assert.equal((await f.cli(["start", task.id])).ok, true);
  const { data: preview } = await f.cli(["preview", task.id]);
  const submitted = await f.cli(["submit", task.id], { token: preview.token, noChanges: true, summary: "Comparison", checks: ["Compared prices"] });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const { data: board } = await f.cli(["list", "--compact"]);
  const reviewerStarted = Promise.withResolvers<void>();
  const reviewerRelease = Promise.withResolvers<void>();
  f.setReviewer(async () => {
    reviewerStarted.resolve();
    await reviewerRelease.promise;
    return { summary: "The original publication is missing.", findings: [], needsHuman: false, evidence: ["Compared the available notes."] };
  });
  const watch = f.schedule(board, async () => assert.fail("An incomplete review must not trigger integration."));
  watch.tick();
  try {
    await reviewerStarted.promise;
    const attempt = await f.run("Read the submission.", async act => {
      const review = await act("task_review", { id: task.id });
      assert.equal(review.ok, true);
      assert.equal(review.data.reviewerRunning, true);
      const result = await act("task_request_changes", { id: task.id, revision: review.data.revision, reason: "Save the original publication." });
      assert.equal(result.error.code, "REVIEW_IN_PROGRESS");
      return { text: "The reviewer is working." };
    });
    assert.equal(attempt.ok, true, JSON.stringify(attempt));
  } finally {
    reviewerRelease.resolve();
    await watch.done();
  }
  const { data: pending } = await f.cli(["show", task.id]);
  assert.equal(pending.status, "review");
  assert.ok(pending.history.some((event: { action: string; text?: string }) =>
    event.action === "review-note" && event.text?.includes("The original publication is missing.")));
  assert.ok(!pending.history.some((event: { action: string }) => event.action === "review-approve"));
  const returned = await f.run("Ask the executor to save the source.", async act => {
    const review = await act("task_review", { id: task.id });
    assert.equal(review.ok, true);
    const { revision, targetHead } = review.data;
    assert.equal(review.data.reviewerRunning, false);
    const result = await act("task_request_changes", { id: task.id, revision, reason: "Save the original publication." });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.status, "in_progress");
    const stale = await act("task_review_diff", { id: task.id, revision, targetHead, paths: ["source.txt"] });
    assert.equal(stale.error.code, "REVIEW_REQUIRED");
    return { text: "The executor will save the source." };
  });
  assert.equal(returned.ok, true, JSON.stringify(returned));
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
  await f.cli(["settings"], { reviewMode: "reviewer", autoMode: true, reviewer: model, taskLimits: { reviewer: 1 } });
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
  f.setReviewer(async ({ id, title, revision, submitted, targetHead, previousReview }, call, settings) => {
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
        const pinnedInput = { view: "commit_diff", from: previousReview.targetHead, to: targetHead, paths: ["new-target.txt"] };
        const pinnedDiff = await call("project_git", pinnedInput);
        assert.equal(pinnedDiff.ok, true, JSON.stringify(pinnedDiff));
        assert.match(pinnedDiff.data.output, /\n\+Unrelated change\n/);
        assert.equal((await call("project_git", { ...pinnedInput, paths: ["../new-target.txt"] })).error.code, "INVALID_INPUT");
        assert.equal((await call("project_git", { view: "diff" })).error.code, "INVALID_INPUT");
      }
    }
    if (title === "pass" || title === "fail") {
      const diff = await call("task_review_diff", { id, revision, targetHead, paths: [title + ".txt"], contextLines: 0 });
      assert.ok(diff.ok && diff.data.diff.includes("+" + title), JSON.stringify(diff));
    }
    if (title === "pass" && passReviews === 1) {
      const unavailable = await call("task_review_diff", { id, revision, targetHead, paths: ["pass.txt"], comparison: "previous-target" });
      assert.equal(unavailable.error.code, "REVIEW_REQUIRED");
      assert.equal(existsSync(join(project, "pass.txt")), false);
      const hash = await call("project_sha256", { commit: submitted, paths: ["pass.txt", "missing.txt", "../pass.txt"] });
      assert.equal(hash.ok, true, JSON.stringify(hash));
      assert.equal(hash.data.files[0].data.commit, submitted);
      assert.equal(hash.data.files[0].data.sha256, createHash("sha256").update("pass\n").digest("hex"));
      assert.equal(hash.data.files[1].error.code, "FILE_HASH_UNAVAILABLE");
      assert.equal(hash.data.files[2].error.code, "INVALID_INPUT");
      assert.equal((await call("project_sha256", { commit: targetHead, path: "pass.txt" })).error.code, "FILE_HASH_UNAVAILABLE");
      assert.equal((await call("project_sha256", { commit: git("rev-parse", submitted + "^{tree}"), path: "pass.txt" })).error.code, "REVIEW_REQUIRED");
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
  f.busyDecisions.set("review-approve " + tasks[0].id, 2);
  f.busyDecisions.set("request-changes " + tasks[1].id, 2);
  const handleApproval: Parameters<typeof f.schedule>[1] = async () => assert.fail("Unexpected automatic manager integration");
  const watch = f.schedule(board, handleApproval);
  const waitForDecision = async (id: string, action: string) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { data: card } = await f.cli(["show", id]);
      if (card.history.some((event: Task["history"][number]) => event.action === action)) return card;
      await wait(1000);
      await watch.refresh();
      watch.tick();
    }
    assert.fail(`Decision ${action} was not recorded for ${id}.`);
  };
  f.setRunning(tasks[1].id, true);
  watch.tick();
  assert.deepEqual(Object.entries(watch.reviewing()), [[tasks[0].id, "reviewer"]]);
  const taskLimits = { reviewer: 4 };
  assert.equal((await f.cli(["settings"], { taskLimits })).ok, true);
  board.settings.taskLimits = taskLimits;
  watch.tick();
  try {
    const startupTimeout = AbortSignal.timeout(60_000);
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
    const returned = await waitForDecision(tasks[1].id, "request-changes");
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
  const approved = await waitForDecision(tasks[0].id, "review-approve");
  await watch.done();
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
  assert.equal((await f.cli(["show", approved.id])).data.status, "review");
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
  await f.cli(["settings"], { autoMode: false });
  watch.tick();
  await watch.done();
  assert.equal((await f.cli(["show", repaired.id])).data.status, "review");
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
    assert.equal((await act("task_accept", reference)).error.code, "REVIEW_REQUIRED");
    // Restore the fixture's approved target before verifying normal integration.
    git("update-ref", "HEAD", head, review.targetHead);
    const { data: current } = await act("task_review", { id: approved.id });
    const accepted = await act("task_accept", { ...reference, targetHead: current.targetHead });
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

test("dialogue results filter coordination and do not add it to the goal log", async t => {
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
  assert.equal(work.length, 0);
  assert.equal(readManagerHistory(f.project)!.turns.flatMap(turn => turn.items).filter(item => item.messages?.length).length, 9);
});

test("manager recovery uses the selected saved reply and protects applied changes", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const text = "Create a draft for caching";
  const { data: id } = await f.queue("add", undefined, text, false, []);
  const result = await f.run(text, async (act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
    session!.acceptTurn!(f.dialogueId, "original-turn");
    assert.equal((await f.queue("list")).data.length, 0);
    const created = await act("task_create", plannedDraft({ title: "Cache", tags: ["Performance"] }));
    assert.equal(created.ok, true, created.error?.message);
    session!.retrying!("Selected model is at capacity.");
    throw new Error("Codex did not respond in time.");
  }, [], false, id);
  assert.equal(result.ok, true, result.error?.message);
  const readTurns = () => readManagerHistory(f.project, null, "chat")!.turns;
  const [original] = readTurns();
  assert.equal(original.outcome?.status, "interrupted");
  assert.match(original.outcome?.reason ?? "", /did not respond in time.*at capacity/s);
  assert.ok(original.recovery);
  for (const invalid of ["../" + original.recovery, original.recovery + ".json"]) {
    assert.equal((await f.queue("recover", undefined, invalid)).data, null);
  }
  const requested = await f.queue("recover", undefined, original.recovery);
  assert.equal((await f.queue("recover", undefined, original.recovery)).data, requested.data);
  const retried = await f.run(text, async (act, prompt, _images, _thread, _context, _waiting, _signal, session) => {
    assert.equal(prompt, text);
    const listed = await act("board_list", {});
    assert.equal(listed.data.tasks.length, 1);
    const blocked = await act("task_create", { title: "Cache", tags: ["Performance"] });
    assert.equal(blocked.error.code, "RECOVERY_READ_ONLY");
    session!.acceptTurn!(f.dialogueId, "recovery-turn");
    return { text: "The draft already exists." };
  }, [], false, requested.data);
  assert.equal(retried.data?.answer, "The draft already exists.", retried.error?.message ?? retried.data?.error);
  const [restored] = readTurns();
  assert.equal(readTurns().length, 1);
  assert.deepEqual(restored.messages, original.messages);
  assert.equal(restored.items.filter(item => item.phase === "final_answer").length, 1);
  assert.equal(restored.outcome?.status, "completed");
  assert.equal(restored.recovery, undefined);
  assert.equal((await f.cli(["list", "--compact"])).data.tasks.length, 1);
});

test("manager recovers a provider final after losing the connection", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const text = "Give me the board summary";
  const { data: id } = await f.queue("add", undefined, text, false, []);
  const result = await f.run(text, async (_act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
    session!.acceptTurn!(f.dialogueId, "original-turn");
    f.setSavedTurn({ items: [{ type: "agentMessage", phase: "final_answer", text: "The summary is ready." }] });
    throw new Error("Connection closed.");
  }, [], false, id);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.answer, "The summary is ready.");
  const { turns } = readManagerHistory(f.project, null, "chat")!;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messages.length, 1);
  assert.equal(turns[0].items.length, 1);
  assert.equal(turns[0].outcome?.status, "completed");
  assert.equal(turns[0].recovery, undefined);
});

test("an accepted manager message remains durable when writing history fails", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const text = "Keep this dialogue message";
  const { data: id } = await f.queue("add", undefined, text, false, []);
  const history = join(f.project, ".tasks", "manager-chat");
  const sent = await f.run(text, async (_act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
    await writeFile(history, "Block creation of the history directory.");
    session!.acceptTurn!(f.dialogueId, "original-turn");
    const [queued] = (await f.queue("list")).data;
    assert.equal(queued.id, id);
    assert.equal(queued.failed, true);
    throw new Error("Connection closed.");
  }, [], false, id);
  assert.equal(sent.ok, true, sent.error?.message);
  assert.equal(sent.data.keepQueued, true);
  assert.match(sent.data.error, /Connection closed/);

  await f.queue("retry", id);
  const failed = await f.run(text, async () => assert.fail("Do not resend an accepted message"), [], false, id);
  assert.equal(failed.error.code, "BOARD_QUEUE_FAILED");
  assert.equal((await f.queue("list")).data[0].id, id);

  rmSync(history);
  await f.queue("retry", id);
  const saved = await f.run(text, async () => assert.fail("Retry only the history write"), [], false, id);
  assert.equal(saved.ok, true, saved.error?.message);
  assert.equal((await f.queue("list")).data.length, 0);
  const [turn] = readManagerHistory(f.project, null, "chat")!.turns;
  assert.deepEqual(turn.messages.map(message => message.text), [text]);
  assert.equal(turn.outcome?.status, "interrupted");
  assert.match(turn.outcome?.reason ?? "", /Connection closed/);
  assert.ok(turn.recovery);
});

test("an interrupted manager turn preserves its outcome when the running state was already saved", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const text = "Keep the reason for this interruption";
  const { data: id } = await f.queue("add", undefined, text, false, []);
  const root = join(f.project, ".tasks");
  const history = join(root, "manager-chat");
  const backup = join(root, "manager-chat-saved");
  let recovery: string | undefined;
  const result = await f.run(text, async (_act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
    session!.acceptTurn!(f.dialogueId, "original-turn");
    assert.equal((await f.queue("list")).data.length, 0);
    const [running] = readManagerHistory(f.project, null, "chat")!.turns;
    assert.equal(running.outcome?.status, "running");
    recovery = running.recovery;
    await rename(history, backup);
    await writeFile(history, "Block only the final history write.");
    throw new Error("Connection closed after saving the running state.");
  }, [], false, id);
  assert.equal(result.data.keepQueued, true);
  assert.match(result.data.error, /Connection closed after saving the running state/);
  const [queued] = (await f.queue("list")).data;
  assert.equal(queued.id, id);
  assert.equal(queued.historyPending, true);
  assert.equal(queued.failed, true);

  rmSync(history);
  await rename(backup, history);
  assert.ok(recovery);
  assert.equal((await f.queue("recover", undefined, recovery)).data, id);
  const saved = await f.run(text, async () => assert.fail("Recover the saved outcome without a provider request"), [], false, id);
  assert.equal(saved.ok, true, saved.error?.message);
  assert.equal((await f.queue("list")).data.length, 0);
  const { turns } = readManagerHistory(f.project, null, "chat")!;
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].messages.map(message => message.text), [text]);
  assert.equal(turns[0].outcome?.status, "interrupted");
  assert.match(turns[0].outcome?.reason ?? "", /Connection closed after saving the running state/);
});

for (const savedTurnId of ["original-turn", "recovery-turn"]) {
  test("an interrupted recovery restores the late answer from " + savedTurnId, async t => {
    const f = fixture(t);
    await f.cli(["init"]);
    const text = "Recover the original answer";
    const { data: id } = await f.queue("add", undefined, text, false, []);
    const first = await f.run(text, async (_act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
      session!.acceptTurn!(f.dialogueId, "original-turn");
      throw new Error("Original connection closed.");
    }, [], false, id);
    assert.match(first.data.error, /Original connection closed/);
    const [original] = readManagerHistory(f.project, null, "chat")!.turns;
    const retry = await f.queue("recover", undefined, original.recovery);
    const interrupted = await f.run(text, async (_act, _prompt, _images, _thread, _context, _waiting, _signal, session) => {
      session!.acceptTurn!(f.dialogueId, "recovery-turn");
      throw new Error("Recovery connection closed.");
    }, [], false, retry.data);
    assert.match(interrupted.data.error, /Recovery connection closed/);
    const [pending] = readManagerHistory(f.project, null, "chat")!.turns;
    assert.equal(pending.recovery, original.recovery);

    const answer = "Saved answer restored from " + savedTurnId;
    f.setSavedTurn({ items: [{ type: "agentMessage", phase: "final_answer", text: answer }] }, savedTurnId);
    const recover = await f.queue("recover", undefined, pending.recovery);
    const restored = await f.run(text, async () => assert.fail("Use the original saved answer"), [], false, recover.data);
    assert.equal(restored.data.answer, answer);
    const expected = ["original-turn", "original-turn", "recovery-turn", "original-turn"];
    if (savedTurnId === "recovery-turn") expected.push("recovery-turn");
    assert.deepEqual(f.managerTurnReads, expected);
    const { turns } = readManagerHistory(f.project, null, "chat")!;
    assert.equal(turns.length, 1);
    assert.equal(turns[0].messages.length, 1);
    assert.equal(turns[0].items.filter(item => item.phase === "final_answer").length, 1);
});
}

test("an interrupted manager request preserves the durable queue until Codex records the message", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const attachments = [file("план.txt", "text/plain", "Сохрани русский текст")];
  const { data: id } = await f.queue("add", undefined, "Исходный текст", false, attachments);
  assert.equal((await f.queue("edit", id, "Новый текст")).ok, true);
  const result = await f.run("Новый текст", async () => ({ interrupted: true }), attachments, false, id);
  assert.equal(result.ok, true, result.error?.message);
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
  assert.deepEqual((await f.history(legacy.data.nextCursor)).data.turns, archived.data.turns);
  assert.equal(f.providerHistoryReads(), 0);
});

test("goal history pages retain scoped local events and hide unclassified provider operations", async t => {
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
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  assert.deepEqual((await f.history(undefined, "work")).data.turns, []);
  assert.equal((await f.history(undefined, "goal-availability")).data, false);
  cursors.length = 0;
  saveManagerHistory(f.project, start, randomUUID(), {
    lane: "work", goalId: f.threadId, message: { text: "Cancel T-0001", files: [] }, items: [local],
  });
  for (let i = 1; i <= 40; i++) {
    saveManagerHistory(f.project, start + i, randomUUID(), {
      lane: "work", goalId: f.threadId, items: [tool("work-" + i, "task_show", i)],
    });
  }
  const first = await f.history(undefined, "work");
  assert.equal(first.data.turns.reduce((count: number, turn: any) => count + turn.items.length + turn.messages.length, 0), 40);
  assert.match(first.data.nextCursor, /^goal:/);
  const lastLocal = await f.history(first.data.nextCursor, "work");
  assert.equal(lastLocal.data.turns.flatMap((turn: any) => turn.items)[0].id, "local");
  assert.deepEqual(cursors, []);
  const provider = await f.history(lastLocal.data.nextCursor, "work");
  assert.deepEqual(cursors, [null, "older", "oldest"]);
  assert.deepEqual(provider.data.turns, []);
  assert.equal(provider.data.nextCursor, null);
  const chat = await f.history();
  assert.deepEqual(chat.data.turns, []);
  assert.equal(chat.data.goalLogAvailable, undefined);
  assert.equal((await f.history(undefined, "goal-availability")).data, true);
  assert.deepEqual((await f.history(chat.data.nextCursor)).data.turns, []);
  const reopened = await f.history(undefined, "work");
  assert.deepEqual(reopened.data, first.data);
  writeJson(f.binding, { provider: "codex", id: f.threadId, history: "local" });
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
    const created = await act("task_create", plannedDraft({ title: "Use attached notes", tags: ["Notes"], attachmentIds: [2] }));
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
    const quotedReferences = "Quote 1:\n```\nКонтекст.\n```";
    assert.equal((await f.queue("add", id, "Черновик", false, attachments, undefined, quotedReferences)).ok, true);
    assert.equal((await f.queue("edit", id, "Send this first")).ok, true);
    const [queued] = (await f.queue("list")).data;
    assert.equal(queued.draft, "Send this first");
    assert.equal(queued.quotedReferences, quotedReferences);
    assert.equal(new TextDecoder().decode(queued.files[0].bytes), "bytes");
    assert.equal((await f.sendNow("Send this first", attachments, id)).ok, true);
    assert.equal((await f.queue("list")).data.length, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0].text).latestUserMessage, {
      text: "Send this first", quotedReferences, attachments: [{ id: 2, name: "new.png", imageIndex: 1 }],
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
    const wrongObject = await act("project_git", { view: "commit_diff", from, to: git("rev-parse", "HEAD^{tree}"), paths: ["tracked.txt"] });
    assert.equal(wrongObject.error.code, "GIT_COMMIT_REQUIRED");
    assert.equal(wrongObject.error.details.field, "to");
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
    assert.deepEqual(Object.keys(experts.data[0]).sort(), ["enabled", "group", "id", "name"]);
    const context = await act("expert_context", { ids: ["business-analyst", "product-owner"] });
    assert.equal(context.ok, true); assert.equal(context.data.length, 2);
    const overLimit = await act("expert_context", { ids: experts.data.slice(0, 7).map(({ id }: { id: string }) => id) });
    assert.equal(overLimit.error.code, "INVALID_INPUT");
    const skill = await act("expert_skill", { expertId: "product-owner", skillId: "workflow" });
    assert.equal(skill.ok, true); assert.match(skill.data.directory, /experts[\\/]product-owner[\\/]skills/);
    const stages = [
      { key: "analysis", expertId: "business-analyst", title: "Requirements", criteria: ["Acceptance criteria"], outputs: ["requirements.md"] },
      { key: "test", expertId: "qa-engineer", title: "Tests", criteria: ["Requirements covered"], inputs: ["requirements.md"], outputs: ["test-plan.md"], dependsOn: ["analysis"] },
    ];
    const brief = { title: "Sprint", description: "Prepare requirements and a test plan.", criteria: ["Both plans are ready."], tags: ["Planning"] };
    const incomplete = await act("task_create", brief);
    assert.equal(incomplete.error.code, "EXPERT_PLAN_REQUIRED");
    const invalidArtifact = await act("task_create", { ...brief,
      expertTeam: { work: { lead: "product-owner", reason: "Plan work.", stages: [
        { ...stages[1], dependsOn: [], artifactOutputs: { desktop: "png" } },
      ] }, review: { lead: "qa-engineer", reason: "Verify the output.", stages: [] } } });
    assert.equal(invalidArtifact.error.code, "INVALID_INPUT");
    assert.match(invalidArtifact.error.message, /Stage test.*"desktop".*outputs/);
    assert.equal((await act("board_list", {})).data.tasks.length, 0);
    const planned = await act("task_create", { ...brief,
      expertTeam: { work: { lead: "product-owner", reason: "Coordinate requirements and test planning.",
        stages: [stages[0], { ...stages[1], artifactOutputs: { "test-plan.md": "text" } }] },
        review: { lead: "qa-engineer", reason: "One QA specialist can verify both outputs.", stages: [] } } });
    assert.equal(planned.ok, true, JSON.stringify(planned.error));
    const parent = planned.data;
    assert.equal(parent.revision, 1);
    const saved = await act("task_show", { id: parent.id });
    assert.equal(saved.data.expertTeam.work.stages[1].dependsOn[0], stages[0].key);
    assert.deepEqual(saved.data.expertTeam.work.stages[1].artifactOutputs, { "test-plan.md": "text" });
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
      title: "Save a report", criteria: ["The report is present."], tags: ["Reports"], workingDirectory: f.folder,
    }))).data;
    confirmFixtureDraft(f.project, draft.id);
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

test("the manager cannot approve a draft with a newly saved question", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const result = await f.run("Approve the draft when the clarification is complete.", async act => {
    const { data: draft } = await act("task_create", plannedDraft({ title: "Choose an export format", tags: ["Export"] }));
    const approve = (revision: number) => act("task_approve", { id: draft.id, revision });
    assert.equal((await approve(draft.revision)).error.code, "DRAFT_DISCUSSION_REQUIRED");
    const chat = ["chat", draft.id];
    const settings = { model: "fixture", effort: "low" };
    const { data: prompt } = await f.cli(chat, { ...settings, text: "What information is missing?" });
    const { data: question } = await f.cli(chat, {
      ...settings,
      actor: "agent",
      text: "Which format should I use?",
      replyTo: prompt.history.length - 1,
      awaitingAnswer: true,
    });

    assert.equal((await approve(draft.revision)).error.code, "REVISION_CONFLICT");
    assert.equal((await approve(question.revision)).error.code, "TASK_AWAITING_ANSWER");
    assert.equal((await f.cli(["show", draft.id])).data.status, "draft");

    const { data: answer } = await f.cli(chat, { ...settings, text: "Use CSV." });
    const { data: closed } = await f.cli(chat, {
      ...settings,
      actor: "agent",
      text: "The format is clear.",
      replyTo: answer.history.length - 1,
      revision: answer.revision,
      awaitingAnswer: false,
      confirmsDraft: true,
    });
    assert.equal((await approve(closed.revision)).data.status, "ready");
    return { text: "Draft approved after clarification." };
  });
  assert.equal(result.data?.answer, "Draft approved after clarification.", JSON.stringify(result.error ?? result.data?.error));
});

test("the manager can approve drafts created while the goal was paused", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const objective = "Prepare the release";
  writeJson(f.binding, { provider: "codex", id: f.threadId, history: "local", goal: { objective, status: "paused" } });
  let pending: { id: string; revision: number } | undefined;
  const paused = await f.run("Prepare the release cards while the goal is paused.", async act => {
    assert.equal((await act("goal_read", {})).data.goal.status, "paused");
    const { data: draft } = await act("task_create", plannedDraft({ title: "Verify the release archive", criteria: ["The archive opens."], tags: ["Release"] }));
    const { data: other } = await act("task_create", plannedDraft({ title: "Update release notes", criteria: ["The notes list user-visible changes."], tags: ["Release"] }));
    pending = other;
    assert.equal((await f.cli(["show", draft.id])).data.goalThreadId, undefined);
    confirmFixtureDraft(f.project, draft.id);
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
  const resumed = await f.resume(objective, async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.update({ objective, status: "active" });
    confirmFixtureDraft(f.project, id);
    const approval = await act("task_approve", { id, revision });
    assert.equal(approval.ok, true, JSON.stringify(approval.error));
    assert.equal(approval.data.status, "ready");
    return { text: "Release notes are ready to start." };
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  const saved = (await f.cli(["show", id])).data;
  assert.equal(saved.status, "ready");
  assert.equal(saved.history.at(-1).actor, "manager");
});

test("the goal manager registers and reuses tags through task creation", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const objective = "Cover every applicable public API in the project";
  const result = await f.run(objective, async (act, _text, _images, _id, _context, _waiting, _signal, goal) => {
    goal!.update({ objective, status: "active" });
    const brief = plannedDraft({
      title: "Cover empty names",
      description: "Specify the empty-name result in the parser.",
      criteria: ["Empty names return a validation error."],
    });
    const rejected = await act("task_create", { ...brief, tags: [" "] });
    assert.equal(rejected.error.code, "TASK_TAGS_REQUIRED");
    const { data: beforeCreate } = await act("board_list", {});
    assert.deepEqual(beforeCreate.tags, []);
    assert.deepEqual(beforeCreate.tasks, []);

    const created = await act("task_create", { ...brief, tags: ["Coverage"] });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    const { data: saved } = await act("task_show", { id: created.data.id });
    assert.equal(saved.goalThreadId, f.threadId);
    assert.deepEqual(saved.tags, ["Coverage"]);
    const { data: catalog } = await act("board_list", {});
    assert.deepEqual(catalog.tags, ["Coverage"]);
    assert.equal(catalog.tasks.length, 1);
    assert.match(catalog.tagColors.Coverage, /^#[0-9A-F]{6}$/);
    const { data: tagged } = await act("tag_set_color", { name: "Coverage", color: "#217D79" });
    assert.equal(tagged.color, "#217D79");

    const reused = await act("task_create", plannedDraft({
      title: "Cover missing config",
      description: "Specify behavior for an absent config file.",
      criteria: ["Missing config uses defaults."],
      tags: ["coverage", "COVERAGE"],
    }));
    assert.equal(reused.ok, true, JSON.stringify(reused.error));
    const { data: second } = await act("task_show", { id: reused.data.id });
    assert.deepEqual(second.tags, ["Coverage"]);
    const { data: board } = await act("board_list", {});
    assert.deepEqual(board.tags, ["Coverage"]);
    assert.equal(board.tagColors.Coverage, "#217D79");
    return { text: "Coverage tags saved." };
  }, [], true);
  assert.equal(result.data?.answer, "Coverage tags saved.", JSON.stringify(result.error ?? result.data?.error));
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
      title: "Cover empty names",
      description: "Specify the empty-name result in the parser.",
      criteria: ["Empty names return a validation error."],
      tags: ["Coverage"],
    }))).data;
    sliceId = slice.id;
    assert.equal((await f.cli(["show", slice.id])).data.goalThreadId, f.threadId);
    confirmFixtureDraft(f.project, slice.id);
    const ready = (await act("task_approve", { id: slice.id, revision: slice.revision })).data;
    assert.equal(ready.status, "ready");
    const another = (await act("task_create", plannedDraft({
      title: "Cover missing config",
      description: "Specify behavior for an absent config file.",
      criteria: ["Missing config uses defaults."],
      tags: ["Coverage"],
    }))).data;
    confirmFixtureDraft(f.project, another.id);
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
    assert.deepEqual(f.cliCalls.slice(callsBeforeReturn).map(args => args[0]), ["list", "request-changes", "start"]);
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
    assert.deepEqual(f.cliCalls.slice(callsBeforeAccept).map(args => args[0]), ["accept"]);
    await f.pushBoard();
    assert.equal(f.reviewing()[sliceId], undefined);
    assert.deepEqual((await act("manager_inbox", {})).data.map((message: { sequence: number }) => message.sequence), [update.data.sequence]);
    return { text: "One slice integrated." };
  });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary.error ?? ordinary.data?.error));
  assert.equal(ordinary.data.answer, "One slice integrated.", ordinary.data.error);
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
  assert.equal((await f.cli(["settings"], { autoReview: true, autoMode: true })).ok, true);
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
  assert.deepEqual(reviewModels, [defaultBoardAgents.reviewer]);
  report = { ...report, summary: "The criterion is missing verification.", needsHuman: false, evidence: [null] };
  assert.equal((await f.cli(["expert-message", task.id], {
    actor: "user", to: "reviewer", kind: "decision", text: "Check the missing criterion.",
  })).ok, true);
  const missing = await runReview();
  assert.equal(missing.status, "review");
  assert.equal(missing.revision, waiting.revision);
  assert.equal(missing.history.at(-1).text, report.summary);
  const { data: unread } = await f.cli(["manager-inbox"]);
  assert.deepEqual(unread.map((message: { kind: string }) => message.kind), ["submit", "decision"]);
  assert.equal((await f.cli(["manager-ack", task.id], { through: unread.at(-1).sequence })).ok, true);
  const { data: other } = await f.cli(["create"], plannedDraft({ title: "Independent work", criteria: ["Complete independent work."] }));
  assert.equal((await f.cli(["approve", other.id])).ok, true);
  assert.equal((await f.cli(["start", other.id])).ok, true);
  assert.equal((await f.cli(["settings"], { archiveAfterDays: 0 })).ok, true);
  f.setRunning(other.id, true);
  report = { ...report, summary: "Verified that the obsolete folder is absent.", evidence: ["The obsolete folder does not exist."], verifyRisk: true };
  const ownerDecision = await f.cli(["expert-message", task.id], {
    actor: "user", to: "reviewer", kind: "decision", text: "The missing evidence is now available.",
  });
  assert.equal(ownerDecision.ok, true);
  assert.equal((await f.cli(["manager-ack", task.id], { through: ownerDecision.data.sequence })).ok, true);
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
    const created = await act("task_create", plannedDraft({ title: "Linked", tags: ["Attachments"], attachmentIds: [1] }));
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
    const draft = await act("task_create", plannedDraft({ title: "Draft", tags: ["Attachments"], attachmentIds: [1, 2, 3] }));
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
  const objective = "Saved objective";
  assert.equal((await f.resume(objective, async () => assert.fail("Must not start another chat"))).ok, false);
  assert.equal((await f.goal("edit", "  ")).ok, false);
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  f.setLegacyHistory(async () => ({
    goal: { objective, status: "paused" }, model: undefined, turns: [], nextCursor: null,
  }));
  assert.equal((await f.resume("Replaced objective", async () => assert.fail("Must not resume a different goal"))).ok, false);
  const settings = { model: "test-manager", effort: "high" };
  assert.equal((await f.cli(["settings"], { manager: settings })).ok, true);
  const { goalActivity, managerRuns, managerRun } = f.backgroundWindow();
  const connected = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const resume = f.resume(objective, async (_act, prompt, _images, id, _context, waiting, _signal, goal) => {
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
  });
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

test("clearing a paused goal is independent of dialogue and shares duplicate requests", async t => {
  const f = fixture(t);
  assert.equal((await f.cli(["init"])).ok, true);
  const goal = { objective: "Saved objective", status: "paused" };
  writeJson(f.binding, { provider: "codex", id: f.threadId, history: "local", goal });
  const connected = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const activeWriter = "failed to record goal instruction: thread already has an active writer";
  f.failGoalClear(activeWriter);
  const dialogue = f.run("Ordinary question", async (_act, _prompt, _images, id, _context, _waiting, signal) => {
    assert.notEqual(id, f.threadId);
    connected.resolve();
    await done.promise;
    assert.equal(signal?.aborted, false);
    return { text: "Ordinary answer" };
  });
  await Promise.race([connected.promise, dialogue.then(result => assert.fail(JSON.stringify(result)))]);
  try {
    const first = f.goal("clear");
    const duplicate = f.goal("clear");
    const early = await first;
    assert.equal(early.error.code, "BOARD_GOAL_FAILED");
    assert.equal((await duplicate).error.code, "BOARD_GOAL_FAILED");
    assert.equal(f.idleGoalActions.length, 1);
    assert.deepEqual((await f.history()).data.goal, goal);
    f.failGoalClear();
    assert.equal((await f.goal("clear")).data, null);
    done.resolve();
    assert.equal((await dialogue).data.answer, "Ordinary answer");
    assert.equal((await f.goal("clear")).data, null);
    assert.equal(f.idleGoalActions.length, 2);
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
  writeJson(f.binding, { provider: "codex", id: f.threadId, history: "local", goal });
  f.failGoalClear("Provider refused");
  const rejected = await f.goal("clear");
  assert.equal(rejected.error.code, "BOARD_GOAL_FAILED");
  assert.equal(rejected.error.message, "Provider refused");
  assert.deepEqual((await f.history()).data.goal, goal);
  f.failGoalClear();
  assert.equal((await f.goal("clear")).data, null);
  assert.equal(f.idleGoalActions.length, 2);
});

test("a paused legacy goal is retained locally without exposing its unclassified transcript", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const goal = { objective: "Legacy goal", status: "paused" as const };
  writeJson(f.binding, { provider: "codex", id: f.threadId });
  f.setLegacyHistory(async () => ({ goal, model: undefined, nextCursor: null,
    turns: [{ messages: [{ text: "Unclassified legacy message", files: [] }], items: [], durationMs: undefined }] }));
  const history = await f.history();
  assert.deepEqual(history.data.goal, goal);
  assert.deepEqual(history.data.turns, []);
  assert.deepEqual((readJson(f.binding) as { goal: unknown }).goal, goal);
  const result = await f.run("Send an instruction to the paused goal", async act => {
    assert.equal((await act("goal_send", { text: "Continue after review" })).ok, true);
    return { text: "Queued" };
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(goalMessages(f.project, f.threadId)[0]?.text, "Continue after review");
});

test("dialogue edits the selected paused goal and rejects missing, stale and unauthorized edits", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const original = "Проверить сборку Windows.";
  const added = original + "\nПроверить сборку Linux.";
  const replacement = "Перепиши текст справки.";
  const goalId = randomUUID();
  const save = (objective: string, id = goalId) => writeJson(f.binding, {
    provider: "codex", id: f.threadId, goalId: id, history: "local", goal: { objective, status: "paused" },
  });
  const edit = async (authorization: string, objective: string, expectedObjective: string, id = goalId, quotedReferences?: string | null) => {
    let response: any;
    let queuedId: string | undefined;
    if (quotedReferences !== undefined) {
      const queued = await f.queue("add", undefined, authorization, false, [], undefined, quotedReferences ?? undefined);
      assert.equal(queued.ok, true, JSON.stringify(queued));
      queuedId = queued.data;
    }
    const run = await f.run(authorization, async (act, prompt, _images, _thread, context) => {
      if (quotedReferences) {
        assert.equal(prompt, authorization);
        assert.equal(context?.quotedReferences, quotedReferences);
      }
      response = await act("goal_edit", { goalId: id, expectedObjective, objective, authorization });
      return { text: response.ok ? response.data.objective : response.error.message };
    }, [], false, queuedId);
    assert.equal(run.ok, true, JSON.stringify(run));
    return response;
  };
  const add = "Добавь к цели проверку на Linux";
  assert.equal((await edit(add, added, original)).error.code, "GOAL_NOT_FOUND");
  save(original);
  sendGoalMessage(f.project, goalId, "Сохрани отчёт по сборке.");
  for (const request of [
    "Замени текст цели на: «что-нибудь»",
    "Замени текст цели на: Сделай формулировку более понятной, пожалуйста",
    "Замени текст цели на: Сделай формулировку цели более понятной, пожалуйста",
    "Замени текст цели на: Сделай формулировку этой цели понятнее",
    "Замени текст цели на: Сделай формулировку нашей текущей цели понятнее.",
    "Замени текст цели на: Перепиши эту цель простыми словами.",
    "Замени текст цели на: Перепиши эту цель по итогам обсуждения.",
    "Замени текст цели на: Перепиши эту цель, пожалуйста, с учётом обсуждения.",
    "Замени текст цели на: Перепиши эту цель: как договорились.",
    "Replace the goal with: Rewrite this goal as discussed.",
    "Replace the goal with: Rewrite the current goal somehow, please.",
    "Замени текст цели на: Перепиши текст текущей цели простыми словами.",
    "Replace the goal with: Make the goal wording clearer, please.",
    "Replace the goal with: Make the wording of the current goal clearer.",
    "Replace the goal with: Make the wording of this goal clearer.",
    "Replace the goal with: Rewrite this goal in plain language.",
    "Замени текст цели на: Сделай формулировку понятной.",
    "Замени текст цели на:\n«Перепиши цель простыми словами»",
    "Replace the goal with: Make the wording easier to understand, please.",
    "Уточни цель: сделай формулировку более понятной, пожалуйста",
    "Уточни цель в части Linux: сделай текст читабельным",
    "Уточни цель: перепиши её более простыми словами",
    "Clarify the goal: make the wording easier to understand, please",
    "Уточни цель: сформулируй её чётче, пожалуйста",
    "Пожалуйста, уточни цель в части Linux: сформулируй её немного чётче, пожалуйста.",
    "Clarify the goal: make it clearer, please.",
    "Уточни цель: «сформулируй её чётче, пожалуйста»",
    "Добавь к цели проверку на Linux, пожалуйста?",
    "Уточни цель: сформулируй её чётче",
    "Уточни цель в части Linux: сформулируй её чётче",
    "Clarify the goal: make it clearer",
    "Уточни цель с учётом обсуждения",
    "Add something to the goal",
    "Уточни цель: с учётом обсуждения",
    "Update the goal based on the discussion",
    "Replace the goal with something else",
    "Добавь к цели проверку на Linux?",
    "> " + add,
    "Измени цель",
    "Измени цель как-нибудь",
    "Карточка T-1234: " + add,
  ]) {
    const rejected = await edit(request, added, original);
    assert.equal(rejected.ok, false, request);
    assert.equal(rejected.error.code, "USER_DIRECTION_REQUIRED", request);
    assert.match(rejected.error.message, /specifying what to change/u);
    assert.deepEqual((readJson(f.binding) as { goal: BoardGoal }).goal, { objective: original, status: "paused" }, request);
  }
  assert.equal(f.idleGoalActions.length, 0);
  assert.deepEqual((await edit(add, added, original)).data, { objective: added, status: "paused" });
  const duplicate = added + "\nПроверить сборку Linux.";
  assert.deepEqual((await edit(add, duplicate, added)).data, { objective: added, status: "paused" });
  assert.equal(f.idleGoalActions.length, 1);
  const refine = "Пожалуйста, уточни цель в части Linux: укажи Ubuntu 24.04, пожалуйста.";
  const refined = original + "\nПроверить сборку Linux на Ubuntu 24.04.";
  assert.deepEqual((await edit(refine, refined, added)).data, { objective: refined, status: "paused" });
  assert.deepEqual((await f.history()).data.goal, { objective: refined, status: "paused" });
  const replace = "Замени текст цели на: " + replacement;
  assert.equal((await edit(replace, replacement, original)).error.code, "GOAL_CHANGED");
  assert.equal((await edit(replace, replacement, refined, randomUUID())).error.code, "GOAL_CHANGED");
  assert.deepEqual((await edit(replace, replacement, refined)).data, { objective: replacement, status: "paused" });
  const quote = "Quote 1:\n```\nПерепиши текст справки.\n```";
  assert.equal((await edit("Замени текст цели на:", replacement, replacement, goalId, quote)).error.code, "USER_DIRECTION_REQUIRED");
  const multiline = replacement + "\n\n" + quote + "\n\nПроверь ссылки и примеры, пожалуйста.\n\t  ";
  const replaceEnglish = "Replace the goal with:\n" + multiline;
  const ambiguous = await edit(replaceEnglish, "Обновить справку.", replacement, goalId, null);
  assert.equal(ambiguous.error.code, "USER_DIRECTION_REQUIRED");
  const result = await edit(replaceEnglish, "Обновить справку.", replacement, goalId, quote);
  assert.deepEqual(result.data, { objective: multiline, status: "paused" });
  const finalObjective = multiline + "\nПроверить журнал ошибок.";
  const explicitEnglish = "Add a check of the error log to the goal, please.";
  assert.equal((await edit(explicitEnglish, finalObjective, multiline)).data.objective, finalObjective);
  const explicitWording = "Проверить отчёт и журнал ошибок.";
  const rewrite = "Уточни цель: перепиши её так: " + explicitWording;
  assert.equal((await edit(rewrite, explicitWording, finalObjective)).data.objective, explicitWording);
  assert.deepEqual((await f.history()).data.goal, { objective: explicitWording, status: "paused" });
  assert.equal((readJson(f.binding) as { goalId: string }).goalId, goalId);
  assert.equal(goalMessages(f.project, goalId)[0]?.text, "Сохрани отчёт по сборке.");
});

test("the active goal can read the saved edit but cannot apply invented iteration commands", async t => {
  const f = fixture(t);
  await f.cli(["init"]);
  const original = "Проверить сборку.";
  const mode = "Включи итеративный режим";
  const interval = "Измени интервал на 25 минут";
  const eventRule = "Настрой правило: смена статуса доски";
  const rules = [{ kind: "status", scope: "board" }];
  const ready = Promise.withResolvers<void>();
  const edited = Promise.withResolvers<void>();
  const work = f.run(original, async (act, _prompt, _images, _id, _context, _waiting, _signal, goal) => {
    let objective = original;
    goal!.accepted();
    goal!.update({ objective, status: "active" });
    goal!.controls(async action => {
      assert.equal(action.kind, "edit");
      objective = action.objective;
      const active = { objective, status: "active" } as const;
      goal!.update(active);
      return active;
    });
    goal!.enableNotifications();
    ready.resolve();
    await edited.promise;
    assert.equal((await act("goal_read", {})).data.goal.objective, objective);
    assert.equal((await act("goal_configure_iteration", { enabled: true })).error.code, "USER_DIRECTION_REQUIRED");
    assert.equal((await act("goal_configure_iteration", { rules: [] })).error.code, "USER_DIRECTION_REQUIRED");
    const configured = await act("goal_configure_iteration", { intervalMs: 1500000, rules });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    return { text: "Параметры проверены." };
  }, [], true);
  try {
    await ready.promise;
    const authorization = ["Добавь к цели проверку на Linux", interval, eventRule].join("\n");
    const result = await f.run(authorization, async act => {
      const { goalId, goal } = (await act("goal_read", {})).data;
      const response = await act("goal_edit", {
        authorization, goalId, expectedObjective: goal.objective,
        objective: [original, "Проверить Linux.", mode, interval, eventRule].join("\n"),
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      return { text: response.data.objective };
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(f.managerNotifications.at(-1) ?? "", /Read goal_read/);
  } finally {
    edited.resolve();
  }
  assert.equal((await work).data.answer, "Параметры проверены.");
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

test("a running goal accepts queued instructions while ordinary questions use another context", { timeout: 15_000 }, async t => {
  const f = fixture(t); await f.cli(["init"]);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Running task" }));
  f.setRunning(task.id, true);
  f.backgroundWindow();
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
    const history = await f.history(undefined, "work");
    assert.equal(history.ok, true, JSON.stringify(history));
    const turns = history.data.turns as { items: RunActivity[] }[];
    assert.ok(turns.some(turn => turn.items.some(item => item.text.includes(question.text))));
    assert.equal((await f.answerQuestion(question.id, "Alpha")).ok, true);
    await ready.promise;
    const parallel = await f.run("Parallel question", async () => ({ text: "Ordinary answer" }));
    assert.equal(parallel.data.answer, "Ordinary answer");
    assert.deepEqual(f.managerNotifications, []);
    const forwarded = await f.run("Pass Hold publication to the goal", async act => {
      const result = await act("goal_send", { text: "Hold publication" });
      assert.equal(result.ok, true, JSON.stringify(result));
      return { text: "Instruction queued" };
    });
    assert.equal(forwarded.data.answer, "Instruction queued");
    assert.equal(f.managerNotifications.at(-1), "AI Taskboard: new user directions are available. Read goal_inbox.");
  } finally {
    finish.resolve();
    if (f.pendingQuestion()) await f.answerQuestion(f.pendingQuestion().id, null);
  }
  const result = await work;
  assert.equal(result.data.answer, "Finished");
  const next = await f.run("Continue", async (_act, _prompt, _images, id) => {
    assert.equal(id, f.dialogueId);
    return { text: "Dialogue context" };
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
  f.agentSlots.configure({ ...f.agentSlots.limits, reviewer: 1 });
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
  f.agentSlots.configure({ ...f.agentSlots.limits, reviewer: 1 });
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

test("manager Git branch workflow stays scoped and uses checked commits", { timeout: 240_000 }, async t => {
  const f = fixture(t);
  const project = f.project;
  const remote = join(f.folder, "remote.git");
  const neighbor = join(f.folder, "neighbor");
  const publisher = join(f.folder, "publisher");
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const configure = (cwd: string) => {
    git(cwd, "config", "user.name", "Taskboard");
    git(cwd, "config", "user.email", "test@example.invalid");
  };
  git(project, "init", "-b", "main");
  configure(project);
  await writeFile(join(project, "tracked"), "before\n");
  await writeFile(join(project, "a-removed"), "keep after failed checkout\n");
  await writeFile(join(project, "c-shape"), "original file\n");
  await writeFile(join(project, "z-filtered"), "original\n");
  await writeFile(join(project, ".gitattributes"), "z-filtered filter=taskboard-test\n");
  mkdirSync(join(project, "tools"));
  await writeFile(join(project, "tools", "smudge.sh"), "test \"$(cat tools/smudge-mode)\" = ready || exit 1\nsh \"$1\"\n");
  await writeFile(join(project, "tools", "smudge-mode"), "ready\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "Base");
  const base = git(project, "rev-parse", "HEAD");
  git(f.folder, "init", "--bare", "-b", "trunk", remote);
  git(project, "remote", "add", "upstream", remote);
  git(project, "push", "upstream", base + ":refs/heads/trunk");
  git(f.folder, "clone", remote, publisher);
  configure(publisher);
  await writeFile(join(publisher, "tracked"), "after\n");
  await writeFile(join(publisher, "z-filtered"), "changed\n");
  git(publisher, "rm", "a-removed", "c-shape");
  mkdirSync(join(publisher, "b-new", "nested"), { recursive: true });
  await writeFile(join(publisher, "b-new", "nested", "added"), "incoming only\n");
  mkdirSync(join(publisher, "c-shape"));
  await writeFile(join(publisher, "c-shape", "child"), "replaced by a directory\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "-m", "Incoming");
  const incoming = git(publisher, "rev-parse", "HEAD");
  git(publisher, "push", "origin", "trunk");
  git(f.folder, "clone", remote, neighbor);
  const neighborCli = spawnSync(process.execPath, [entry, "--project", neighbor, "--json", "init"], { encoding: "utf8" });
  assert.equal(neighborCli.status, 0, neighborCli.stdout + neighborCli.stderr);
  const neighborIndex = readFileSync(join(neighbor, ".tasks", "board.json"));
  const neighborRefs = git(neighbor, "show-ref");
  assert.equal((await f.cli(["init"])).ok, true);
  let thread: string | undefined;
  const first = await f.run("Fetch and fast-forward main", async (act, _prompt, _images, id) => {
    assert.equal(id, undefined);
    const refs = await act("project_git_branches", {});
    assert.equal(refs.data.head, base);
    assert.deepEqual(Array.from(refs.data.remotes), ["upstream"]);
    for (const malformed of [" main", "main ", "bad\0name", "bad..name"]) {
      const refused = await act("project_git_branch_create", { branch: malformed, head: base });
      assert.equal(refused.error.code, "INVALID_INPUT");
    }
    for (const malformed of [" " + base, base + "\n", base.slice(0, -1) + "z", "0x" + base]) {
      const refused = await act("project_git_fast_forward", { branch: "main", head: malformed });
      assert.equal(refused.error.code, "INVALID_INPUT");
    }
    assert.equal((await act("project_git_fetch", { remote: "upstream " })).error.code, "INVALID_INPUT");
    const fetched = await act("project_git_fetch", { remote: "upstream" });
    assert.equal(fetched.ok, true, JSON.stringify(fetched.error));
    assert.equal(fetched.data.branches.find((entry: { ref: string }) => entry.ref === "refs/remotes/upstream/trunk").head, incoming);
    assert.equal(git(project, "rev-parse", "HEAD"), base);
    assert.equal(readFileSync(join(project, "tracked"), "utf8"), "before\n");
    assert.equal(git(project, "status", "--porcelain"), "");

    const snapshot = { branch: "main", head: base };
    const source = { ...snapshot, remote: "upstream", remoteBranch: "trunk" };
    assert.equal((await act("project_git_fast_forward", snapshot)).error.code, "GIT_REMOTE_REQUIRED");
    assert.equal((await act("project_git_fast_forward", { ...source, head: incoming })).error.code, "STALE_REPOSITORY");
    git(project, "switch", "-c", "other");
    assert.equal((await act("project_git_fast_forward", source)).error.code, "STALE_REPOSITORY");
    git(project, "switch", "main");
    await writeFile(join(project, "tracked"), "local edit");
    assert.equal((await act("project_git_fetch", { remote: "upstream" })).ok, true);
    assert.equal(git(project, "rev-parse", "HEAD"), base);
    assert.equal((await act("project_git_fast_forward", source)).error.code, "GIT_DIRTY_WORKTREE");
    assert.equal(readFileSync(join(project, "tracked"), "utf8"), "local edit");
    await writeFile(join(project, "tracked"), "before\n");
    const monitor = join(project, ".git", "atb-fast-forward-monitor");
    await writeFile(monitor, [
      "#!/bin/sh", "if test -f .git/atb-monitor-seen; then",
      "  git symbolic-ref HEAD refs/heads/other || exit 1",
      "else", "  touch .git/atb-monitor-seen", "fi", "exit 1",
    ].join("\n") + "\n", { mode: 0o755 });
    git(project, "config", "core.fsmonitor", monitor.replaceAll("\\", "/"));
    git(project, "config", "core.fsmonitorHookVersion", "2");
    const checkoutChanged = await act("project_git_fast_forward", source);
    git(project, "config", "--unset", "core.fsmonitor");
    git(project, "config", "--unset", "core.fsmonitorHookVersion");
    rmSync(monitor);
    rmSync(join(project, ".git", "atb-monitor-seen"));
    assert.equal(checkoutChanged.error.code, "GIT_REF_TRANSACTION_FAILED", JSON.stringify(checkoutChanged));
    assert.equal(git(project, "branch", "--show-current"), "other");
    assert.equal(git(project, "rev-parse", "refs/heads/main"), base);
    assert.equal(git(project, "rev-parse", "refs/heads/other"), base);
    assert.equal(readFileSync(join(project, "tracked"), "utf8"), "before\n");
    git(project, "switch", "main");
    const indexPath = join(project, ".git", "index");

    const failedFilter = join(project, ".git", "atb-failed-smudge");
    const partialWrite = join(project, ".git", "atb-partial-checkout");
    const shellPath = (path: string) => "'" + path.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
    git(project, "config", "filter.taskboard-test.clean", "cat");
    git(project, "config", "filter.taskboard-test.smudge", "sh tools/smudge.sh " + shellPath(failedFilter));
    git(project, "config", "filter.taskboard-test.required", "true");
    for (const outcome of ["failure", "edit and failure", "edit and success"]) {
      const script = ["#!/bin/sh"];
      script.push("test -e a-removed || printf removed > " + shellPath(partialWrite));
      if (outcome !== "failure") {
        script.push("printf 'editor saved\\n' > " + shellPath(join(project, "tracked")));
      }
      if (outcome === "edit and success") {
        script.push("cat", "exit 0");
      } else {
        script.push("exit 1");
      }
      await writeFile(failedFilter, script.join("\n") + "\n", { mode: 0o755 });
      git(project, "update-index", "--refresh");
      const indexBefore = readFileSync(indexPath);
      const rejected = await act("project_git_fast_forward", source);
      assert.equal(rejected.error.code, outcome === "edit and success" ? "GIT_DIRTY_WORKTREE" : "GIT_FAILED", JSON.stringify(rejected));
      assert.equal(readFileSync(partialWrite, "utf8"), "removed");
      rmSync(partialWrite);
      assert.equal(git(project, "rev-parse", "HEAD"), base);
      assert.equal(readFileSync(join(project, "a-removed"), "utf8"), "keep after failed checkout\n");
      assert.equal(readFileSync(join(project, "c-shape"), "utf8"), "original file\n");
      assert.equal(existsSync(join(project, "b-new")), false);
      assert.equal(readFileSync(join(project, "tracked"), "utf8"), outcome === "failure" ? "before\n" : "editor saved\n");
      assert.equal(readFileSync(join(project, "z-filtered"), "utf8"), "original\n");
      assert.deepEqual(readFileSync(indexPath), indexBefore);
      await writeFile(join(project, "tracked"), "before\n");
    }
    assert.equal(git(project, "status", "--porcelain"), "");
    await writeFile(failedFilter, "#!/bin/sh\ncat\n", { mode: 0o755 });
    const checkoutHook = join(project, ".git", "hooks", "reference-transaction");
    const checked = join(project, ".git", "atb-checkout-race");
    await writeFile(checkoutHook, [
      "#!/bin/sh", "read old next ref", '[ "$1" = prepared ] && [ "$ref" = HEAD ] || exit 0',
      'git switch other >.git/atb-checkout-race 2>&1 && exit 1',
      'git symbolic-ref HEAD refs/heads/other >>.git/atb-checkout-race 2>&1 && exit 1', "exit 0",
    ].join("\n") + "\n", { mode: 0o755 });
    const ff = await act("project_git_fast_forward", source);
    rmSync(checkoutHook);
    assert.match(readFileSync(checked, "utf8"), /index\.lock/);
    assert.match(readFileSync(checked, "utf8"), /HEAD\.lock/);
    rmSync(checked);
    assert.equal(ff.ok, true, JSON.stringify(ff.error));
    assert.match(ff.data.recoveryDirectory, /taskboard-fast-forward-/);
    git(project, "config", "--remove-section", "filter.taskboard-test");
    assert.equal(ff.data.head, incoming);
    assert.equal(git(project, "rev-parse", "HEAD"), incoming);
    assert.equal(readFileSync(join(project, "tracked"), "utf8"), "after\n");
    assert.equal(readFileSync(join(project, "c-shape", "child"), "utf8"), "replaced by a directory\n");
    assert.equal(readFileSync(join(project, "b-new", "nested", "added"), "utf8"), "incoming only\n");
    assert.equal(existsSync(join(project, "a-removed")), false);
    assert.equal(git(project, "for-each-ref", "--format=%(upstream)", "refs/heads/main"), "");
    return { text: "Fetched and updated." };
  });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  thread = first.data.id;
  assert.equal(typeof thread, "string");

  git(project, "branch", "--set-upstream-to=upstream/trunk", "main");
  git(publisher, "commit", "--allow-empty", "-m", "Second incoming");
  const current = git(publisher, "rev-parse", "HEAD");
  git(publisher, "push", "origin", "trunk");
  const second = await f.run("Continue with the branches", async (act, _prompt, _images, id) => {
    assert.equal(id, thread);
    const ff = await act("project_git_fast_forward", { branch: "main", head: incoming });
    assert.equal(ff.ok, true, JSON.stringify(ff.error));
    assert.equal(ff.data.head, current);
    assert.equal(git(project, "config", "branch.main.merge"), "refs/heads/trunk");
    assert.equal((await act("project_git_fast_forward", { branch: "main", head: current })).data.updated, false);
    const create = await act("project_git_branch_create", { branch: "merged", head: incoming });
    assert.equal(create.ok, true, JSON.stringify(create.error));
    assert.equal(git(project, "branch", "--show-current"), "main");
    const published = await act("project_git_push", { branch: "merged", head: incoming, remote: "upstream", remoteBranch: "published" });
    assert.equal(published.ok, true, JSON.stringify(published.error));
    assert.equal(published.data.remoteRef, "refs/heads/published");
    assert.equal(git(project, "config", "branch.merged.merge"), "refs/heads/published");
    git(project, "switch", "other");
    git(project, "commit", "--allow-empty", "-m", "Only in other");
    const unique = git(project, "rev-parse", "HEAD");
    const diverged = await act("project_git_fast_forward", { branch: "other", head: unique, remote: "upstream", remoteBranch: "trunk" });
    assert.equal(diverged.error.code, "GIT_DIVERGED");
    assert.equal(git(project, "rev-parse", "HEAD"), unique);
    git(project, "switch", "main");
    git(project, "push", "upstream", unique + ":refs/heads/unmerged");
    git(project, "remote", "add", "missing", join(f.folder, "missing.git"));
    const failed = await act("project_git_fetch", { remote: "missing" });
    assert.equal(failed.error.code, "GIT_REMOTE_FAILED");
    assert.match(failed.error.message, /connection and permissions/);
    return { text: "Checked the branches." };
  });
  assert.equal(second.ok, true, JSON.stringify(second.error));

  const remove = async (scope: string, branch: string, head: string, allow = true, beforeConfirm?: () => void) => {
    const shown = Promise.withResolvers<void>();
    let outcome: any;
    const turn = f.run("Delete the " + scope + " branch " + branch, async act => {
      const pending = act("project_git_branch_delete", { scope, branch, head, remote: "upstream" });
      shown.resolve();
      outcome = await pending;
      return { text: "Deletion checked." };
    });
    await Promise.race([shown.promise, turn.then(result => assert.fail("Deletion did not open a confirmation: " + JSON.stringify(result)))]);
    for (let attempt = 0; !f.pendingQuestion() && attempt < 100; attempt++) await wait(10);
    const question = f.pendingQuestion();
    assert.ok(question);
    assert.ok(question.approval);
    assert.ok(question.text.includes(branch) && question.text.includes(head) && question.text.includes("upstream"));
    beforeConfirm?.();
    assert.equal((await f.answerQuestion(question.id, allow ? "Allow once" : "Deny")).ok, true);
    assert.equal((await turn).ok, true);
    return outcome;
  };
  assert.equal((await f.cli(["git", "branch-delete"], { scope: "local", branch: "merged", head: incoming, remote: "upstream" })).error.code, "USER_DIRECTION_REQUIRED");
  assert.equal((await remove("local", "merged", incoming, false)).error.code, "USER_DIRECTION_REQUIRED");
  assert.equal(git(project, "rev-parse", "merged"), incoming);
  assert.equal((await remove("local", "main", current)).error.code, "GIT_PROTECTED_BRANCH");
  assert.equal((await remove("remote", "trunk", current)).error.code, "GIT_PROTECTED_BRANCH");

  const rebaseTargets = [
    ["local", project, "merged"],
    ["remote", remote, "published"],
  ] as const;
  for (const [scope, repository, branch] of rebaseTargets) {
    const rebasing = join(f.folder, "rebasing-" + scope);
    git(repository, "worktree", "add", rebasing, branch);
    configure(rebasing);
    const stopped = spawnSync("git", ["-C", rebasing, "rebase", "--force-rebase", "--exec", "false", base], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /execution failed/);
    assert.equal(git(rebasing, "branch", "--show-current"), "");
    assert.equal((await remove(scope, branch, incoming)).error.code, "GIT_BRANCH_IN_USE");
    assert.equal(git(repository, "rev-parse", "refs/heads/" + branch), incoming);
    git(rebasing, "rebase", "--abort");
    git(repository, "worktree", "remove", rebasing);
  }
  const unique = git(project, "rev-parse", "other");
  const linked = join(f.folder, "linked");
  git(project, "worktree", "add", linked, "other");
  assert.equal((await remove("local", "other", unique)).error.code, "GIT_BRANCH_IN_USE");
  git(project, "worktree", "remove", linked);
  assert.equal((await remove("local", "other", unique)).error.code, "GIT_UNMERGED_BRANCH");
  assert.equal((await remove("remote", "unmerged", unique)).error.code, "GIT_UNMERGED_BRANCH");
  assert.equal(git(remote, "rev-parse", "unmerged"), unique);

  git(project, "branch", "card-target", incoming);
  const { data: task } = await f.cli(["create"], plannedDraft({ title: "Use a target branch" }));
  const approved = await f.cli(["approve", task.id], { revision: task.revision });
  assert.equal(approved.ok, true, JSON.stringify(approved.error));
  const started = await f.cli(["start", task.id], { revision: approved.data.revision, target: "card-target" });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assert.equal((await remove("local", "card-target", incoming)).error.code, "GIT_PROTECTED_BRANCH");
  assert.equal((await remove("local", "merged", incoming, true, () => {
    git(project, "update-ref", "refs/heads/merged", current, incoming);
  })).error.code, "STALE_REPOSITORY");
  assert.equal(git(project, "rev-parse", "merged"), current);

  const detached = join(f.folder, "detached-refs");
  mkdirSync(detached);
  await writeFile(join(detached, "HEAD"), current + "\n");
  await writeFile(join(detached, "commondir"), remote + "\n");
  const hook = join(remote, "hooks", "reference-transaction");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const changeBeforeWrite = (ref: string, next: string, expected: string) => writeFile(hook, [
    "#!/bin/sh", "read old next ref", '[ "$1" = prepared ] && [ "$ref" = HEAD ] || exit 0',
    "git --git-dir=" + quote(detached) + " update-ref " + ref + " " + next + " " + expected,
  ].join("\n") + "\n", { mode: 0o755 });
  for (const [scope, branch, head] of [["local", "merged", current], ["remote", "published", incoming]]) {
    // The remote's HEAD was read, and the default's old commit was accepted as
    // ancestry evidence. Move the default just before its verification lock.
    await changeBeforeWrite("refs/heads/trunk", base, current);
    const blocked = await remove(scope!, branch!, head!);
    assert.equal(blocked.error.code, "GIT_REF_TRANSACTION_FAILED", JSON.stringify(blocked));
    assert.equal(git(remote, "rev-parse", "trunk"), base);
    assert.equal(git(scope === "local" ? project : remote, "rev-parse", branch!), head);
    rmSync(hook);
    git(remote, "update-ref", "refs/heads/trunk", current, base);
  }
  await changeBeforeWrite("refs/heads/published", unique, incoming);
  assert.equal((await remove("remote", "published", incoming)).error.code, "GIT_REF_TRANSACTION_FAILED");
  assert.equal(git(remote, "rev-parse", "published"), unique);
  rmSync(hook);
  git(remote, "update-ref", "refs/heads/published", incoming, unique);

  const origin = join(f.folder, "origin.git");
  git(f.folder, "init", "--bare", "-b", "stable", origin);
  git(project, "remote", "add", "origin", origin);
  git(project, "push", "origin", incoming + ":refs/heads/stable");
  git(project, "branch", "stable", incoming);
  assert.equal(git(project, "branch", "--show-current"), "main");
  assert.equal(git(project, "branch", "-r", "--list", "origin/HEAD"), "");
  assert.equal((await remove("local", "stable", incoming)).error.code, "GIT_PROTECTED_BRANCH");
  assert.equal(git(project, "rev-parse", "stable"), incoming);

  for (const [scope, branch, head] of [["local", "merged", current], ["remote", "published", incoming]]) {
    git(origin, "branch", branch!, base);
    await writeFile(hook, [
      "#!/bin/sh", "read old next ref", '[ "$1" = prepared ] && [ "$ref" = HEAD ] || exit 0',
      "git --git-dir=" + quote(origin) + " symbolic-ref HEAD refs/heads/" + branch,
    ].join("\n") + "\n", { mode: 0o755 });
    const blocked = await remove(scope!, branch!, head!);
    assert.equal(blocked.error.code, "GIT_REF_TRANSACTION_FAILED", JSON.stringify(blocked));
    assert.equal(git(origin, "symbolic-ref", "HEAD"), "refs/heads/" + branch);
    assert.equal(git(scope === "local" ? project : remote, "rev-parse", branch!), head);
    rmSync(hook);
    git(origin, "symbolic-ref", "HEAD", "refs/heads/stable");
  }

  git(remote, "branch", "replacement", base);
  await writeFile(hook, [
    "#!/bin/sh", "read old next ref", '[ "$1" = prepared ] && [ "$ref" = HEAD ] || exit 0',
    "git symbolic-ref HEAD refs/heads/replacement",
  ].join("\n") + "\n", { mode: 0o755 });
  for (const [scope, branch, head] of [["local", "merged", current], ["remote", "published", incoming]]) {
    const blocked = await remove(scope!, branch!, head!);
    assert.equal(blocked.error.code, "GIT_REF_TRANSACTION_FAILED", JSON.stringify(blocked));
    assert.match(blocked.error.details.output, /HEAD\.lock/);
    assert.equal(git(remote, "symbolic-ref", "HEAD"), "refs/heads/trunk");
    assert.equal(git(scope === "local" ? project : remote, "rev-parse", branch!), head);
  }
  rmSync(hook);

  git(remote, "config", "receive.denyDeletes", "true");
  assert.equal((await remove("remote", "published", incoming)).error.code, "GIT_REMOTE_TRANSACTION_UNAVAILABLE");
  assert.equal(git(remote, "rev-parse", "published"), incoming);
  git(remote, "config", "--unset", "receive.denyDeletes");
  for (const url of ["ssh://git@example.invalid/repo", "https://example.invalid/repo"]) {
    git(project, "remote", "set-url", "upstream", url);
    for (const [scope, branch, head] of [["local", "merged", current], ["remote", "published", incoming]]) {
      const prevented = await f.cli(["git", "branch-delete"], {
        scope, branch, head, remote: "upstream", confirmed: true,
      });
      assert.equal(prevented.error.code, "GIT_REMOTE_TRANSACTION_UNAVAILABLE");
      assert.match(prevented.error.message, /direct transactional access/);
      assert.equal(prevented.error.details.remote, "upstream");
      assert.equal(git(project, "rev-parse", "refs/heads/merged"), current);
      assert.equal(git(remote, "rev-parse", "refs/heads/published"), incoming);
    }
  }
  git(project, "remote", "set-url", "upstream", remote);
  assert.equal(git(project, "remote", "get-url", "upstream"), remote);
  assert.equal(git(project, "config", "branch.merged.merge"), "refs/heads/published");

  git(remote, "symbolic-ref", "HEAD", "refs/heads/missing");
  assert.equal((await remove("local", "merged", current)).error.code, "GIT_REMOTE_DEFAULT_UNKNOWN");
  assert.equal((await remove("remote", "published", incoming)).error.code, "GIT_REMOTE_DEFAULT_UNKNOWN");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
  assert.equal((await remove("local", "merged", current)).data.deleted, true);
  assert.equal((await remove("remote", "published", incoming)).data.deleted, true);
  assert.equal(git(project, "branch", "--list", "merged"), "");
  assert.equal(git(remote, "branch", "--list", "published"), "");
  const recreated = await f.run("Create merged again and publish it to a new branch", async act => {
    assert.equal((await act("project_git_branch_create", { branch: "merged", head: current })).ok, true);
    assert.equal(git(project, "for-each-ref", "--format=%(upstream)", "refs/heads/merged"), "");
    const pushed = await act("project_git_push", { branch: "merged", head: current, remote: "upstream", remoteBranch: "recreated" });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    assert.equal(git(remote, "rev-parse", "recreated"), current);
    assert.equal(git(project, "config", "branch.merged.merge"), "refs/heads/recreated");
    return { text: "Recreated and published." };
  });
  assert.equal(recreated.ok, true, JSON.stringify(recreated.error));
  assert.equal(git(project, "rev-parse", "HEAD"), current);
  assert.equal(git(neighbor, "show-ref"), neighborRefs);
  assert.deepEqual(readFileSync(join(neighbor, ".tasks", "board.json")), neighborIndex);
});
