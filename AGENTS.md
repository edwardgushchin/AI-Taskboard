# Repository Guidelines

## Design Decisions

- Read [docs/explanation/architecture.md](docs/explanation/architecture.md) before changing product behavior. When a change revises a documented decision, update the relevant section there.
- Use glyphs from the bundled Codicons font for all desktop UI icons. Do not add SVG icons or draw icons in CSS. If a native control only accepts an image, render the corresponding font glyph into an image.

## Verification

- Run the repository checks relevant to the change. For behavior changes, verify the affected workflow and any failure case the change can introduce.
- Report the checks you ran, their results, and any gaps that affect verification.
- A confirmed memory leak in a submitted change blocks acceptance. A confirmed leak in a release candidate blocks publication. Fix the retention and repeat the affected check before proceeding.
- When a change touches the lifetime of a window, chat, subscription, timer, cache or process, repeat its create/use/release cycle and verify resource disposal. Follow the [memory regression procedure](docs/how-to/development.md#проверить-освобождение-памяти).

## Zero tolerance for leftover temporary files

- Reserve `.dev-diary` for Codex Worklog entries. Put disposable files, test profiles, and fixtures in a dedicated system temporary directory for each run.
- Set up automatic cleanup when creating temporary resources. Remove the temporary files and directories you created, stop their helper processes, and verify cleanup before reporting completion. Do this without waiting for a user reminder.
- If a check fails, keep the diagnostic evidence needed to understand or reproduce the failure and record where it is. Clean up the rest. Preserve requested deliverables and pre-existing user files.

## Commits and Pull Requests

- Use Conventional Commits, for example `docs: clarify contribution rules`.
- In pull requests, summarize the change, link the relevant issue or task when available, and include screenshots for visible UI changes.
