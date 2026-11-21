# Write task text

- Use the language of the source or the user's requested language. Preserve technical names, numbers, decisions, and the difference between confirmed and uncertain information.
- Give a draft a title that says what changes. Keep the context needed to act. State open questions explicitly and phrase each acceptance criterion as something a reviewer can verify.
- Write new task descriptions as a short, natural brief. Say what to do, add the context needed to understand why, and include essential conditions where they matter. Use ordinary paragraphs or a list when it helps. Do not use the stock headings Problem, Expected result, or Constraints (including their translated equivalents).
- Keep acceptance criteria in the separate `criteria` field. Include relevant reproduction steps and links in the description where they help the reader act. Preserve facts, uncertainty, links, and existing requirements when updating a card.
- When creating or refining a checklist (`subtasks`), write one observable result per item. Name the change, artifact, or condition that confirms completion. Split an item if it contains results that can be verified and marked complete independently. Let the task determine the number of items. Preserve existing checklist items and their completion marks unless the user authorizes a change.

For example, split “Add CSV export and document it” into two checklist items:

- “The Export action downloads a CSV containing the displayed rows.” Verify by exporting a populated table and comparing its rows with the file.
- “The user guide lists the steps for exporting a CSV.” Verify by locating those steps in the guide.

Example of a new brief (illustrative facts): the executor chat fails after an interrupted run with `no rollout found for thread id`; recovery must keep the assigned worktree. Whether the original chat can be restored is unknown.

Title: «Восстановить запуск исполнителя после потери чата»

`description`:

```markdown
Дать исполнителю продолжить задачу после прерванного запуска, когда сохранённый чат недоступен. Сейчас это заканчивается ошибкой `no rollout found for thread id`. При восстановлении нужно сохранить назначенный worktree и уже сделанные изменения.

Для воспроизведения продолжи задачу, чей сохранённый чат недоступен. Запуск и продолжение обрабатывает `src/desktop/codex-run.ts`.
```

Separate `criteria` field:

```json
[
  "При недоступном сохранённом чате запуск создаёт новый чат и продолжает ту же задачу.",
  "Назначенный worktree и изменения в нём сохраняются.",
  "При доступном сохранённом чате продолжается исходный чат."
]
```

- For progress, write what changed, what you verified, and what a new chat should do next. For a blocker, name what is missing and what would unblock it.
- For a submission, describe the actual change. Name each check by the observable behavior it verifies. Write a short outcome for the operator and put reproducible commands in a second line after `Command:` or `Команда:`. For example, `Отправка демозаявки с клавиатуры — пройдено. Форма подтвердила заявку без отправки данных.\nКоманда: node browser-check.cjs`. Describe skipped checks and limitations that affect acceptance. For a commit subject, use Conventional Commits.
- Remove repeated framing, filler, and generic praise. Compare the edited text with the source to check that nothing factual or relevant was lost.
