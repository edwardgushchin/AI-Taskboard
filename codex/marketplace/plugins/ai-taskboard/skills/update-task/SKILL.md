---
name: update-task
description: Update a local AI Taskboard card, checklist, priority, or comments when the user gives new information about a specific task, for example "Обнови T-0042".
---

# Update a task

The CLI launch array installed by AI Taskboard is `__AI_TASKBOARD_CLI__`. Execute the first element with the remaining elements as fixed arguments. Preserve paths with spaces as single arguments. If the array is unavailable, ask the user to connect Codex in AI Taskboard settings.

- Read the current card with `--project <project> --json show <id>`. Read [task-writing](../task-writing/SKILL.md) before writing.
- Call `update <id> --stdin` with one UTF-8 JSON object containing the fields the user wants changed and the current `revision`. Updating `criteria`, `questions`, `tags`, or `subtasks` replaces that list. Carry forward entries outside the requested edit.
- For explicit new requirements from the user on an approved task, send `actor: "user"` and a `note` naming what changed. Record proposals or uncertainty as questions or comments. The CLI manages the state change if prior review is stale.
- Use `comment <id> --stdin` with `text` and `revision` for a dated note. For a revision conflict, reread the card and preserve intervening changes before retrying.
