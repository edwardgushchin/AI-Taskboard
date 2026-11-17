---
name: docs
description: Create, update and audit project documentation from code and verified behavior.
license: MIT
---
# Documentation

Adapted from mthines/agent-skills. See [origin and changes](ADAPTATION.md).
This is a thin index: load only the rules needed for the current phase.

## Select the work

| Mode | When | Result |
| --- | --- | --- |
| init | No docs tree, or explicitly authorized rebuild | docs/README.md and pages sized to real reader needs |
| update | Code changes affect documented behavior | Targeted corrections and missing pages |
| audit | Review or health check | Read-only inventory with PASS, WARN, FAIL and evidence |

An existing docs tree is merged in task scope. Never rebuild another project's docs merely because a board is installed or opened.
A rebuild requires explicit authorization. README work stays within the assigned scope.
Do not announce skill names to the user.

## Procedure

1. Read [routing and style](rules/content-routing.md). Inspect source, public entry points, callers, settings and relevant checks. Existing prose is evidence to verify, not authority.
2. For init, read [docs structure](rules/docs-folder.md). For update, read [drift detection](rules/drift-detection.md) and [automatic updates](rules/auto-update-loop.md). For audit, read all three.
3. Map affected behavior to one owner page per fact. Follow existing project instructions and use the nearest relevant page. Link from other surfaces.
4. Create or update only justified pages. Do not invent APIs, capabilities, commands, examples, or empty sections.
5. Check local paths, commands, cross-links and heading anchors. Trace semantic claims to current code or a verified scenario. A link checker alone cannot establish completeness.
6. Repeat the audit after edits. A second update with unchanged code should produce no duplicates or cosmetic rewrite.
7. Report changed pages, source/check evidence, unresolved drift and the reason for any no-impact conclusion in the normal task submission. A failed check is a failure, not successful documentation delivery.

## Role boundaries

The manager includes documentation impact when planning and reviewing tasks, including goal work. The executor updates affected docs before preview/submit, or gives a verifiable no-impact explanation. The reviewer checks accuracy, completeness, duplication and local links against the submitted behavior. In human mode the manager surfaces this evidence and gaps to the user. Use the existing reviewMode and lifecycle; never create an independent commit, change provider settings, or bypass permissions.
