# Write task text

- Use the language of the source or the user's requested language. Preserve technical names, numbers, decisions, and the difference between confirmed and uncertain information.
- Give a draft a title that says what changes. Keep the context needed to act. State open questions explicitly and phrase each acceptance criterion as something a reviewer can verify.
- For new task descriptions, use Markdown sections in this order: `### Проблема` for what happens now; `### Ожидаемый результат` for what should change; `### Ограничения` for essential conditions; `### Диагностика и связанные файлы` for reproduction details, relevant files, logs, and links the executor needs. Use the source or requested language for the prose and other headings, but keep the final heading exactly `### Диагностика и связанные файлы` so the UI can recognize and collapse that section by default. Keep the problem and expected result outside the collapsed section.
- Omit sections with no relevant content. Do not invent constraints or add technical detail just to fill the structure. Preserve facts, uncertainty, links, and the verifiable result. Keep acceptance criteria in the card's separate `criteria` field, outside `description`. Apply this structure to new briefs created with `task_create` or prepared with `task_update`; do not reformat old cards just to match it or change their requirements.

Example of a new brief (illustrative facts): the executor chat fails after an interrupted run with `no rollout found for thread id`; recovery must keep the assigned worktree. Whether the original chat can be restored is unknown.

Title: «Восстановить запуск исполнителя после потери чата»

`description`:

```markdown
### Проблема
После прерванного запуска продолжение задачи завершается ошибкой `no rollout found for thread id`. Возможность восстановить исходный чат пока не подтверждена.

### Ожидаемый результат
Исполнитель может продолжить задачу после потери чата.

### Ограничения
Сохранить назначенный worktree и сделанные в нём изменения.

### Диагностика и связанные файлы
Путь запуска и продолжения: `src/desktop/codex-run.ts`.
Для воспроизведения продолжить задачу, чей сохранённый чат недоступен.
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
- For a submission, describe the actual diff. Write each check in the task's language as a short name followed by its outcome and what it verified. If the exact command helps reproduce the check, put it on the next line of the same string after `Command:` or `Команда:`. For example, `Release build — passed; no errors or warnings\nCommand: dotnet build -c Release`. State skipped checks or limitations when they affect acceptance. For a commit subject, describe the change in the required Conventional Commit format.
- Remove repeated framing, filler, and generic praise. Compare the edited text with the source to check that nothing factual or relevant was lost.
