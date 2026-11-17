# docs/ structure

Adapted from upstream docs-folder (Diátaxis).

Use docs/README.md as the entry point. Link to it from the repository README. Group pages by reader purpose, using tutorials, how-to, reference and explanation when enough real material exists. Small trees may use flat pages. Do not generate all four sections just to fill a template.

Each page serves one reader need: a tutorial teaches one concrete path with observable results; a how-to gives steps to a goal; reference describes current interfaces; explanation gives rationale. Split mixed pages when that helps the reader.

Before writing, inventory source files, packages, CI, public interfaces and existing docs. Size the tree to this evidence rather than fixed quotas. Every page must be reachable from the index, directly or through an indexed section. Use relative cross-links to the fact's owner and verify fragments against actual headings. Avoid orphan pages, circular prerequisites, copied reference dumps and empty scaffolds.

For a monorepo, root docs own cross-package behavior; package docs own package details. A static site is unnecessary until reader needs justify it.
