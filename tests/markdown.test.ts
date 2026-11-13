import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import MarkdownIt from "markdown-it";
import { readMarkdownFile } from "../src/desktop/markdown-files.ts";

const source = readFileSync(new URL("../src/desktop/markdown.js", import.meta.url), "utf8");
const markdown = runInNewContext(source + ";chatMarkdown", { window: { markdownit: MarkdownIt } }) as ReturnType<typeof MarkdownIt>;

test("Markdown links preserve captions and local paths with spaces, slashes and parentheses", () => {
  const paths = [
    "G:/Projects/2026/AI Taskboard/.tasks/worktrees/T-0051/docs/codex-project-placement.md",
    String.raw`G:\Projects\2026\AI Taskboard\docs\диагностика.md`,
    "docs/diagnostic report.md", "docs/report (final).md", "../guide.markdown",
    "file:///G:/Projects/AI%20Taskboard/docs/report.md", "docs/report.md:12:3", "docs/report.md#details",
  ];
  for (const path of paths) {
    for (const destination of [path, "<" + path + ">"]) {
      const html = markdown.render("[Подробная диагностика](" + destination + ")");
      const match = /<a href="([^"]+)">Подробная диагностика<\/a>/.exec(html);
      assert.ok(match, html);
      assert.equal(decodeURIComponent(match[1]), decodeURIComponent(path));
    }
  }
  assert.match(markdown.render('[Веб](https://example.com/a "title")'), /<a href="https:\/\/example.com\/a" title="title">Веб<\/a>/);
  assert.match(markdown.render("[Почта](mailto:test@example.com)"), /<a href="mailto:test@example.com">Почта<\/a>/);
  assert.match(markdown.render("[Документ][ref]\n\n[ref]: <docs/report with spaces.md>"), /<a href="docs\/report%20with%20spaces.md">Документ<\/a>/);
  assert.match(markdown.render("`[Код](docs/report.md)`"), /<code>\[Код\]/);
});

test("plain Markdown paths use the filename as the label and preserve the target", () => {
  const text = String.raw`Источники: docs/decisions/index.md; **docs/maps.md#details** (docs\отчёт.md:97:3).`;
  const html = markdown.render(text);
  assert.match(html, /<a href="docs\/decisions\/index\.md" title="docs\/decisions\/index\.md">index\.md<\/a>;/);
  assert.match(html, /<strong><a href="docs\/maps\.md#details"[^>]*>maps\.md<\/a><\/strong>/);
  const windows = /<a href="([^"]+)"[^>]*>отчёт\.md<\/a>/.exec(html);
  assert.equal(decodeURIComponent(windows?.[1] ?? ""), String.raw`docs\отчёт.md:97:3`);
  assert.match(markdown.render("docs/with%20%23%20hash.md"), />with # hash\.md<\/a>/);
  assert.equal((markdown.render("[docs/report.md](docs/report.md) https://example.com/docs/file.md").match(/<a /g) ?? []).length, 2);
  assert.doesNotMatch(markdown.render("vbscript:docs/file.md //host/docs/file.md docs/file.md.bak \x60docs/example.md\x60"), /<a /);
});

test("Markdown rendering keeps HTML inert and refuses executable schemes and other local files", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,test", "vbscript:test.md", "httpsx:test.md", "docs/script.exe", "docs/file.txt"]) {
    assert.doesNotMatch(markdown.render("[Bad](" + link + ")"), /<a /);
  }
  assert.doesNotMatch(markdown.render('<script>alert(1)</script><img src=x onerror="alert(1)">'), /<(script|img)/);
  assert.doesNotMatch(markdown.render("![Image](docs/local.md)"), /<img/);
  assert.match(markdown.render("- [x] done\n\n**bold**\n\n```js\nalert(1)\n```"), /type="checkbox" disabled checked/);
});

test("Markdown reader resolves task and document bases, absolute paths and file URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskboard-markdown-"));
  try {
    const worktree = join(root, "worktree");
    const docs = join(worktree, "docs");
    await mkdir(docs, { recursive: true });
    const path = join(docs, "отчёт (final).MD");
    await writeFile(path, "\uFEFF# Диагностика\n\n**Готово**\n");
    await writeFile(join(root, "wrong.md"), "Board root");
    await writeFile(join(worktree, "wrong.md"), "Task worktree");
    assert.equal((await readMarkdownFile(worktree, "wrong.md")).text, "Task worktree");
    assert.equal((await readMarkdownFile(root, "wrong.md")).text, "Board root");
    for (const link of [path, path.replaceAll("\\", "/"), pathToFileURL(path).href,
      "docs/отчёт (final).MD", "docs\\отчёт (final).MD", "docs/%D0%BE%D1%82%D1%87%D1%91%D1%82%20(final).MD:12#details"]) {
      const result = await readMarkdownFile(worktree, link);
      assert.equal(result.path, path);
      assert.equal(result.text, "# Диагностика\n\n**Готово**\n");
    }
    assert.equal((await readMarkdownFile(root, "../wrong.md", path)).text, "Task worktree");
    const hashPath = join(docs, "with # hash.md");
    await writeFile(hashPath, "Hash");
    assert.equal((await readMarkdownFile(worktree, pathToFileURL(hashPath).href)).text, "Hash");
  } finally { await rm(root, { recursive: true }); }
});

test("Markdown reader rejects invalid, absent, non-file and oversized sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskboard-markdown-errors-"));
  try {
    await mkdir(join(root, "directory.md"));
    await writeFile(join(root, "large.md"), "");
    await truncate(join(root, "large.md"), 4 * 1024 * 1024 + 1);
    for (const link of ["javascript:test.md", "https://example.com/file.md", "bad%00.md", "bad\0.md", "bad%0A.md", "file.txt", "%zz.md"]) {
      await assert.rejects(readMarkdownFile(root, link), /INVALID_MARKDOWN_LINK/, link);
    }
    await assert.rejects(readMarkdownFile(root, "missing.md"), /ENOENT/);
    await assert.rejects(readMarkdownFile(root, "directory.md"));
    await assert.rejects(readMarkdownFile(root, "large.md"), /MARKDOWN_TOO_LARGE/);
  } finally { await rm(root, { recursive: true }); }
});
