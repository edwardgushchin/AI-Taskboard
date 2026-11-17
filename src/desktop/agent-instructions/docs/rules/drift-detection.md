# Drift detection

Adapted from upstream drift-detection.

## Inventory and scope

For an update inspect the assigned task base and target, committed diff, staged and unstaged edits, new files and deletions. Never assume the default branch is main. For an audit inspect all documentation surfaces. Classify changes by API, UI, build, configuration, storage, architecture and tests. Follow changed entry points through their callers.

## Deterministic checks

1. Check exact local file references, stripping optional line numbers. Distinguish existing source paths from generated output and illustrative placeholders; label examples rather than silently ignoring broken real paths.
2. Compare documented package scripts with package.json; use the project's equivalent for other runtimes. Validate changed public CLI commands against their parser/help and run the relevant scenario.
3. Resolve every local Markdown link and heading fragment, including references from outside docs to moved pages. Use the project's checker when available.
4. Identify duplicate facts, unreachable pages, obsolete imports and rules whose scope no longer exists.
5. Block delivery on broken local links and incorrect commands. Report external network failures separately.

## Semantic checks

Compare claims about defaults, permissions, state transitions, packaging, failure behavior and architecture with source and actual checks. A deterministic PASS does not prove semantic accuracy. Record evidence per affected area and unresolved gaps. Prioritize P0 wrong/stale facts, then P1 missing useful information. Skip P2 cosmetic polish unless requested. Audit is read-only; applying findings is update work within the authorized task.
