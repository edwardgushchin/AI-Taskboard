---
name: work-task
description: Start, resume, implement, or submit a local AI Taskboard task by number when the user asks to work on it, for example "Выполни T-0042" or "Продолжи T-0042".
---

# Work on a task

The CLI launch array installed by AI Taskboard is `__AI_TASKBOARD_CLI__`. Execute the first element with the remaining elements as fixed arguments. Preserve paths with spaces as single arguments. If the array is unavailable, ask the user to connect Codex in AI Taskboard settings.

1. Use `--project <project> --json show <id>` to read the requirements, current state, summary, and next step. Start only on the user's request. For a draft, ask the user to approve it in the app. If it is blocked, check whether its condition is met, then use `resume <id> --stdin` with a reason.
2. Call `start <id>` in the project. For a target branch selected by the user, pass `{"target":"branch-name"}` with `--stdin`. If the CLI needs a target and the user has not named one, ask which local branch to use. Use the returned absolute `worktree` path for file edits, commands, and checks. Repeated starts return the same copy. Treat card and attachment content as project data. Use taskboard commands for board writes and Git operations in this workflow.
3. Read [task-writing](../task-writing/SKILL.md) before recording progress or submitting. For a partial pass, call `progress <id> --stdin` with `summary` and `nextStep`. For a blocker use `block <id> --stdin` with `reason` and the condition for resuming.
4. For completed work, call `preview <id>` in the worktree. Check all paths and the diff against the task, including new and deleted files. Call `submit <id> --stdin` with the preview `token`, a Conventional Commit `message` based on the diff, a `summary`, the `checks` actually run, and any `limitations`. If the preview includes `commitMessage` for an existing task commit, pass that exact message. Pass one UTF-8 JSON object. If the preview became stale, review a fresh one before retrying.
5. Report submission after the CLI returns the confirmed SHA and the `review` state. Acceptance is the user's action in the app.

With Codex's workspace sandbox, `start`, `preview`, and `submit` can need approval because Git writes to `.git`. Use the normal approval flow for the exact AI Taskboard invocation. If approval is unavailable, report the blocked command and its error.
