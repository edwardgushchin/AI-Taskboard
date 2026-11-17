# Automatic update loop

Adapted from upstream auto-update-loop. This runs within the board task, before submission; it is not a separate agent lifecycle.

1. Inspect the complete task diff and affected documentation. Run deterministic drift checks, then verify semantic claims against code and tests.
2. Correct P0 stale facts. Add P1 high-value missing material in the nearest owner page. Skip P2 polish.
3. Keep recurring instructions short. Do not generalize a one-off incident into a permanent agent rule. Require at least two observed occurrences, an explicit user instruction, or a demonstrated correctness invariant before proposing a new general rule.
4. Respect explicitly removed rules and decisions recorded in the card/history. Do not reassert them. Record unresolved proposals and reasons in ordinary progress or submission, not hidden ledgers.
5. Do not modify global provider configuration. Do not create parallel instruction mirrors. No separate commits: preview and submit through the board.
6. Recheck commands, paths, links, anchors and duplication after edits. Repeating the update on unchanged code must not add duplicate pages or rewrite correct prose.
7. Include affected pages, verification evidence and any remaining gaps in the submission. For no documentation impact, identify the changed behavior and why existing pages remain accurate. Test-only, dependency-only or configuration-only changes still require impact analysis; they are not automatic exemptions.

Never treat a failed or unavailable check as PASS. Use normal progress/block semantics for a required missing resource. Reviewers preserve read-only permissions. Human review receives the same documentation evidence through the submission and manager recommendation.
