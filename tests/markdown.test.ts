import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
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

test("plain Markdown paths containing @ take precedence over inferred email links", () => {
  const path = "docs/coverage/classes/@GlobalScope.md";
  for (const value of [path, path + "#errors"]) {
    assert.ok(markdown.render("См. " + value + ".").includes(
      '<a href="' + value + '" title="' + value + '">@GlobalScope.md</a>.'));
  }
  assert.match(markdown.render("user@example.md"), /href="mailto:user@example.md"/);
  assert.match(markdown.render("[Почта](mailto:docs/user@example.md)"), /href="mailto:docs\/user@example.md"/);
  assert.match(markdown.render("mailto:docs/user@example.md"), /href="mailto:docs\/user@example.md"/);
  assert.match(markdown.render("https://example.com/" + path), /href="https:\/\/example.com\/docs\/coverage\/classes\/@GlobalScope.md"/);
});

test("explicit Markdown links to local reports, logs and manifests preserve their captions", () => {
  const base = "/G:/Projects/2026/Electron2D/.tasks/qa/T-0018/setup-review/";
  const links = [
    ["Отчёт", base + "verification.txt"],
    ["Лог coverage", base + "t0018-setup-coverage.log"],
    ["Манифест SHA-256", base + "sha256.json"],
  ];
  const rendered = markdown.render(links.map(([caption, path]) => `[${caption}](${path})`).join(" · "));
  for (const [caption, path] of links) assert.ok(rendered.includes(`<a href="${path}">${caption}</a>`), rendered);
});

test("agent messages link source locations and distinguish code from prose", () => {
  const text = "src/Core/Foo.cs:25 вызывает ReadNodePath() и SetSceneInstanceLoadPlaceholder(true). " +
    "SceneState.GetNodePropertyValue<string> вернёт null для Node?. Проверка borrowed.IsDisposed в Foo.cs:42. " +
    "См. [описание](docs/SceneState.md) и `Length`.";
  const html = markdown.render(text, { agent: true });
  assert.match(html, /<a href="src\/Core\/Foo.cs:25" title="src\/Core\/Foo.cs:25"><code>Foo.cs:25<\/code><\/a>/);
  for (const code of ["ReadNodePath()", "SetSceneInstanceLoadPlaceholder(true)", "SceneState.GetNodePropertyValue&lt;string&gt;",
    "null", "Node?", "borrowed.IsDisposed", "Foo.cs:42", "Length"]) {
    assert.ok(html.includes("<code>" + code + "</code>"), html);
  }
  assert.match(html, /<a href="docs\/SceneState.md">описание<\/a>/);
  assert.match(markdown.render("[Исходник](<src/Other file.cs:2>)"), /<a href="src\/Other%20file.cs:2">Исходник<\/a>/);
  assert.doesNotMatch(markdown.render(text), /<code>null<\/code>/);
});

test("Markdown rendering keeps HTML inert and refuses executable schemes and unsupported local files", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,test", "vbscript:test.md", "httpsx:test.md", "docs/script.exe", "docs/index.html"]) {
    assert.doesNotMatch(markdown.render("[Bad](" + link + ")"), /<a /);
  }
  assert.doesNotMatch(markdown.render('<script>alert(1)</script><img src=x onerror="alert(1)">'), /<(script|img)/);
  assert.doesNotMatch(markdown.render("![Image](docs/local.md) ![Log](docs/local.log)"), /<img/);
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
    for (const name of ["verification.txt", "coverage.log", "sha256.json"]) {
      const report = join(docs, name);
      const content = '<script>inert</script>\n**Verbatim**\n';
      await writeFile(report, content);
      const links = ["docs/" + name, pathToFileURL(report).href];
      if (process.platform === "win32") links.push("/" + report.replaceAll("\\", "/"));
      for (const link of links) {
        assert.deepEqual(await readMarkdownFile(worktree, link), { path: report, name, text: content });
      }
    }
    const boardReport = join(root, "verification.txt");
    await writeFile(boardReport, "Board report");
    assert.equal((await readMarkdownFile(worktree, boardReport, undefined, root)).text, "Board report");
    const sourceFile = join(docs, "SceneState.cs");
    await writeFile(sourceFile, "// first\nreturn null;\n");
    assert.deepEqual(await readMarkdownFile(worktree, "docs/SceneState.cs:2:1", undefined, root),
      { path: sourceFile, name: "SceneState.cs", text: "// first\nreturn null;\n", line: 2 });
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
    for (const link of ["javascript:test.md", "https://example.com/file.md", "bad%00.md", "bad\0.md", "bad%0A.md", "file.html", "%zz.md"]) {
      await assert.rejects(readMarkdownFile(root, link), /INVALID_MARKDOWN_LINK/, link);
    }
    await assert.rejects(readMarkdownFile(root, "missing.md"), /ENOENT/);
    await assert.rejects(readMarkdownFile(root, "directory.md"));
    await assert.rejects(readMarkdownFile(root, "large.md"), /MARKDOWN_TOO_LARGE/);
  } finally { await rm(root, { recursive: true }); }
});

test("local text links cannot read reports outside the project through paths or junctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskboard-report-paths-"));
  try {
    const workspace = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(outside, "report.txt"), "Outside");
    await writeFile(join(outside, "Private.cs"), "Outside");
    await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const link of ["../outside/report.txt", "linked/report.txt", "file:///C:/report.txt",
      "../outside/Private.cs:1", "linked/Private.cs:1", "linked/Private.cs", "linked/Private.cs:0"]) {
      await assert.rejects(readMarkdownFile(workspace, link), /INVALID_MARKDOWN_LINK/);
    }
  } finally { await rm(root, { recursive: true }); }
});
