# Write task text

- Use the language of the source or the user's requested language. Preserve technical names, numbers, decisions, and the difference between confirmed and uncertain information.
- Give a draft a title that says what changes. Keep the context needed to act. State open questions explicitly and phrase each acceptance criterion as something a reviewer can verify.
- For progress, write what changed, what you verified, and what a new chat should do next. For a blocker, name what is missing and what would unblock it.
- For a submission, describe the actual diff. Write each check in the task's language as a short name followed by its outcome and what it verified. If the exact command helps reproduce the check, put it on the next line of the same string after `Command:` or `Команда:`. For example, `Release build — passed; no errors or warnings\nCommand: dotnet build -c Release`. State skipped checks or limitations when they affect acceptance. For a commit subject, describe the change in the required Conventional Commit format.
- Remove repeated framing, filler, and generic praise. Compare the edited text with the source to check that nothing factual or relevant was lost.
