import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true });
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
const ignored = new Set(['node_modules', '.git', '.tasks', '.taskboard-worktrees', '.dev-diary', 'dist', 'release']);
function inventory(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(e => ignored.has(e.name) || e.isSymbolicLink() ? [] :
    e.isDirectory() ? inventory(resolve(root, e.name)) : e.name.endsWith('.md') ? [resolve(root, e.name)] : []);
}
function anchors(tokens) {
  const result = new Set(), counts = new Map();
  tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return;
    const inline = tokens[i + 1];
    const text = (inline.children ?? []).filter(t => ['text', 'code_inline'].includes(t.type)).map(t => t.content).join('');
    const base = slug(text), n = counts.get(base) ?? 0;
    counts.set(base, n + 1); result.add(base + (n ? '-' + n : ''));
  });
  return result;
}
export function checkDocs(root) {
  root = resolve(root);
  const files = inventory(root), parsed = new Map(files.map(file => [file, md.parse(readFileSync(file, 'utf8'), {})]));
  const issues = [];
  const scripts = existsSync(resolve(root, 'package.json')) ? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {} : {};
  for (const [file, tokens] of parsed) {
    const label = relative(root, file).replaceAll('\\', '/');
    const fail = (kind, value) => issues.push(`${label}: ${kind}: ${value}`);
    function visit(token) {
      if (token.type === 'link_open' || token.type === 'image') {
        const href = token.attrGet(token.type === 'image' ? 'src' : 'href');
        if (href && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
          try {
            const [path, fragment] = href.split('#');
            const target = path ? resolve(dirname(file), decodeURIComponent(path.split('?')[0])) : file;
            if (!existsSync(target)) fail('broken link', href);
            else if (fragment && target.endsWith('.md') && !anchors(parsed.get(target) ?? md.parse(readFileSync(target, 'utf8'), {})).has(decodeURIComponent(fragment))) fail('broken anchor', href);
          } catch { fail('invalid link', href); }
        }
      }
      // Current documentation, not historical reports or literal teaching examples in the bundled guide.
      if (['code_inline', 'fence'].includes(token.type) && (label.startsWith('docs/') || label === 'README.md' || label === 'AGENTS.md')) {
        for (const match of token.content.matchAll(/\bnpm run ([\w:-]+)/g)) if (!(match[1] in scripts)) fail('stale command', match[0]);
        const path = token.content.replace(/:\d+(?::\d+)?$/, '');
        if (token.type === 'code_inline' && /^(?:src|scripts|build)\/[\w./-]+\.[\w]+$/.test(path) && !existsSync(resolve(root, path))) fail('stale path', path);
      }
      token.children?.forEach(visit);
    }
    tokens.forEach(visit);
  }
  return { files: files.length, issues };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocs(process.argv[2] ?? '.');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.issues.length ? 1 : 0;
}
