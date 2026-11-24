import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import MarkdownIt from "markdown-it";
import { readMarkdownFile } from "../src/desktop/markdown-files.ts";

const source = ["source-files.cjs", "markdown.js"].map(name =>
  readFileSync(new URL("../src/desktop/" + name, import.meta.url), "utf8")).join("\n");
const markdown = runInNewContext(source + ";chatMarkdown", { window: { markdownit: MarkdownIt } }) as ReturnType<typeof MarkdownIt>;

test("chat task links keep board names, task IDs and adjacent punctuation separate", () => {
  for (const env of [{}, { agent: true }, { agent: true, report: true }]) {
    const text = "Здесь #T-0013, там (#Полевые работы/T-0013), затем `#Говновоз/T-0013`.";
    const html = markdown.render(text, env);
    assert.match(html, /href="#T-0013" data-task="T-0013">[^]*?<\/i>T-0013<\/a>,/);
    assert.match(html, /\(<a [^>]+data-task="T-0013" data-task-board="Полевые работы">[^]*?<\/i>Полевые работы\/T-0013<\/a>\),/);
    assert.match(html, /data-task-board="Говновоз">[^]*?<\/i>Говновоз\/T-0013<\/a>\./);

    for (const invalid of ["#Полевые работы/T-0013abc", "#Полевые работы/T-0013.5",
      "#Полевые работы/T-00e3", "#Полевые работы/T-0013/extra", "#T-0013abc"]) {
      assert.doesNotMatch(markdown.render(invalid, env), /data-task=/, invalid);
    }
    assert.doesNotMatch(markdown.render("[#Полевые работы/T-0013](https://example.com)", env), /data-task=/);
  }
});

test("short commit references require explicit context in prose and inline code", () => {
  for (const env of [{}, { agent: true }, { agent: true, report: true }, { coordination: true }]) {
    for (const value of ["190cb97", "ABCDEF12", "abcd", "1".repeat(39)]) {
      for (const text of ["Коммит " + value, "commit: `" + value + "`", "**Коммит** **" + value + "**"]) {
        assert.ok(markdown.render(text, env).includes("<code>" + value + "</code>"), text);
      }
    }
    for (const text of ["190cb97", "1234567", "decafbad", "Коммит src/190cb97", "commit 190cb97.txt", "commit 190cb97-extra", "commit 190cb97/next", "commit [190cb97](https://example.com)", "commit https://example.com/190cb97", "commit `git show 190cb97`", "```text\nКоммит 190cb97\n```", "    commit 190cb97"]) {
      assert.doesNotMatch(markdown.render(text, env), /<code>190cb97<\/code>/, text);
    }
  }
});

test("rendered source and document destinations open the same real file without changing captions", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskboard-source-links-"));
  try {
    await mkdir(join(root, "src/desktop"), { recursive: true });
    const text = Array.from({ length: 600 }, (_, i) => `/* строка ${i + 1} */`).join("\n");
    const extensions = ["css", "cs", "fs", "vb", "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx",
      "py", "rs", "go", "java", "kt", "swift", "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx",
      "rb", "php", "lua", "gd", "sh", "ps1", "md", "markdown", "txt", "log", "json"];
    for (const extension of extensions) {
      for (const name of ["styles." + extension, "стили (final)." + extension]) {
        const relative = "src/desktop/" + name;
        const absolute = join(root, relative);
        await writeFile(absolute, text);
        const paths = [relative, relative.replaceAll("/", "\\"), absolute, absolute.replaceAll("\\", "/"),
          encodeURI(relative), pathToFileURL(absolute).href];
        if (process.platform === "win32") paths.push("/" + absolute.replaceAll("\\", "/"));
        for (const path of paths) for (const suffix of [":582", ":582:3"]) for (const caption of [name, "`" + name + "`", "Открыть файл"]) {
          const html = markdown.render(`[${caption}](${path}${suffix})`, { agent: true });
          const match = /<a href="([^"]+)">([\s\S]*?)<\/a>/.exec(html);
          assert.ok(match, html);
          assert.equal(match[2], caption.startsWith("`") ? `<code>${name}</code>` : caption);
          assert.equal(decodeURIComponent(match[1]), decodeURIComponent(path + suffix));
          const file = await readMarkdownFile(root, match[1]);
          assert.equal(file.path, absolute);
          assert.equal(file.text, text);
          assert.equal(file.line, /^(md|markdown|txt|log|json)$/.test(extension) ? undefined : 582);
        }
      }
    }
    assert.equal(markdown.render("[styles.css](src/desktop/styles.css:582)"),
      '<p><a href="src/desktop/styles.css:582">styles.css</a></p>\n');
    assert.match(markdown.render("src/desktop/styles.css:582", { agent: true }), /<a [^>]*><code>styles.css:582<\/code><\/a>/);
    for (const value of ["`src/desktop/styles.css:582`", "styles.css:582", "src/desktop/styles.css:0"]) {
      assert.doesNotMatch(markdown.render(value, { agent: true }), /<a /);
    }
  } finally { await rm(root, { recursive: true }); }
});

test("source line fragments preserve chat captions and select the requested lines", async () => {
  const root = new URL("../", import.meta.url);
  const base = fileURLToPath(root);
  const links = [
    ["Код выбора результата", "src/desktop/renderer.js", 2823],
    ["Код модели", "src/desktop/voice-transcription.ts", 18],
    ["Выбор языка", "src/desktop/renderer.js", 2851],
  ] as const;
  for (const [caption, relative, line] of links) {
    const path = fileURLToPath(new URL(relative, root));
    for (const destination of [relative, path, pathToFileURL(path).href]) {
      const html = markdown.render(`[${caption}](${destination}#L${line})`, { agent: true });
      const match = /<a href="([^"]+)">([^<]+)<\/a>/.exec(html);
      assert.ok(match, html);
      assert.equal(match[2], caption);
      const file = await readMarkdownFile(base, match[1]);
      assert.equal(file.path, path);
      assert.equal(file.line, line);
    }
  }
});

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
    await writeFile(join(root, "large.css"), "");
    await truncate(join(root, "large.css"), 4 * 1024 * 1024 + 1);
    for (const link of ["javascript:test.md", "https://example.com/file.md", "bad%00.md", "bad\0.md", "bad%0A.md", "file.html", "%zz.md"]) {
      await assert.rejects(readMarkdownFile(root, link), /INVALID_MARKDOWN_LINK/, link);
    }
    await assert.rejects(readMarkdownFile(root, "missing.md"), /ENOENT/);
    await assert.rejects(readMarkdownFile(root, "directory.md"));
    await assert.rejects(readMarkdownFile(root, "large.md"), /MARKDOWN_TOO_LARGE/);
    await assert.rejects(readMarkdownFile(root, "large.css:582"), /MARKDOWN_TOO_LARGE/);
    await assert.rejects(readMarkdownFile(root, "missing.css:582"), /ENOENT/);
    await assert.rejects(readMarkdownFile(root, "large.css#L582"), /MARKDOWN_TOO_LARGE/);
    await assert.rejects(readMarkdownFile(root, "missing.css#L582"), /ENOENT/);
    for (const suffix of ["#L0", "#L-2", "#L+2", "#L2x", "#L2e1", "#L0x2", "#L2.0", "#L2#L3", "%23L2"]) {
      const link = "styles.css" + suffix;
      assert.doesNotMatch(markdown.render(`[Source](${link})`), /<a /);
      await assert.rejects(readMarkdownFile(root, link), /INVALID_MARKDOWN_LINK/, link);
    }
    await assert.rejects(readMarkdownFile(root, "styles.css#L9007199254740992"), /INVALID_MARKDOWN_LINK/);
    for (const link of ["javascript:styles.css:1", "https://example.com/styles.css:1", "styles.css", "styles.css:0", "styles.css:9007199254740992", "bad%00.css:1", "bad%0A.css:1"]) {
      await assert.rejects(readMarkdownFile(root, link), /INVALID_MARKDOWN_LINK/);
    }
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
    await writeFile(join(outside, "styles.css"), "Outside");
    await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const link of ["../outside/report.txt", "linked/report.txt", "file:///C:/report.txt",
      "../outside/styles.css:1", "linked/styles.css:1", "../outside/Private.cs:1", "linked/Private.cs:1",
      "../outside/styles.css#L1", "linked/styles.css#L1", "linked/Private.cs", "linked/Private.cs:0"]) {
      await assert.rejects(readMarkdownFile(workspace, link), /INVALID_MARKDOWN_LINK/);
    }
  } finally { await rm(root, { recursive: true }); }
});
