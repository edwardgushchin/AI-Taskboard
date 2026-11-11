---
name: update-task
description: Update a local AI Taskboard card, checklist, tags, priority, or comments, or change a board tag's color. Use for requests like "Обнови T-0042".
---

# Update a task

The CLI launch array installed by AI Taskboard is `__AI_TASKBOARD_CLI__`. Execute the first element with the remaining elements as fixed arguments. Preserve paths with spaces as single arguments. If the array is unavailable, ask the user to connect Codex in AI Taskboard settings.

- Read the current card with `--project <project> --json show <id>`. Read [task-writing](../task-writing/SKILL.md) before writing.
- Call `update <id> --stdin` with one UTF-8 JSON object containing the fields the user wants changed and the current `revision`. Updating `criteria`, `questions`, `tags`, or `subtasks` replaces that list. Carry forward entries outside the requested edit.
- When assigning tags, read `list` for the board's `tags` catalog and reuse names for topics it already covers. Missing names are registered by `update` with a default color. Follow the [create-task](../create-task/SKILL.md) tagging instructions to set a specific color for a new tag. Use `tag set --stdin` with `name` and `color` when the user asks to change a tag's color across the board.
- For explicit new requirements from the user on an approved task, send `actor: "user"` and a `note` naming what changed. Record proposals or uncertainty as questions or comments. The CLI manages the state change if prior review is stale.
- Use `comment <id> --stdin` with `text` and `revision` for a dated note. For a revision conflict, reread the card and preserve intervening changes before retrying.
