import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { boardAgentInstructions } from '../src/desktop/board-agent-hooks.ts';

test('documentation audit rejects stale commands, paths and links; update is repeatable and read-only', t => {
  const root = mkdtempSync(join(tmpdir(), 'taskboard-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc' } }));
  const page = join(root, 'docs', 'README.md');
  const audit = () => spawnSync(process.execPath, ['scripts/check-docs.mjs', root], { encoding: 'utf8', windowsHide: true });
  // Initial documentation, then code changes invalidate a previously correct page.
  const initial = '# Docs\n\n## Проверка\n\n[Go](#проверка)\n\n```text\nnpm run check\n```\n';
  writeFileSync(page, initial);
  assert.equal(audit().status, 0);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'tsc' } }));
  writeFileSync(page, initial + '\n`src/removed.ts`\n[Missing](missing.md)\n[Anchor](#gone)\n');
  const bad = audit();
  assert.equal(bad.status, 1);
  for (const kind of ['stale command', 'stale path', 'broken link', 'broken anchor']) assert.ok(bad.stdout.includes(kind), kind);
  const updated = initial.replace('npm run check', 'npm run verify');
  writeFileSync(page, updated);
  assert.equal(audit().status, 0);
  assert.equal(audit().status, 0);
  assert.equal(readFileSync(page, 'utf8'), updated);
});

test('all roles receive compact documentation rules with an accessible guide and no permission mutation', () => {
  for (const role of ['manager', 'executor', 'reviewer'] as const) {
    const text = boardAgentInstructions(role);
    assert.match(text, /continued and automatic goal turns/);
    assert.match(text, /Documentation is part of task completion/);
    assert.match(text, /existing permissions and board lifecycle/);
    const guide = JSON.parse(text.match(/bundled guide at (".*?") and load/)![1]);
    assert.ok(existsSync(guide));
    assert.match(readFileSync(guide, 'utf8'), /init/);
    assert.ok(!text.includes('# Automatic update loop'));
    if (role === 'manager') assert.match(text, /human mode/);
    if (role === 'executor') assert.match(text, /Before preview\/submit/);
    if (role === 'reviewer') assert.match(text, /keep review read-only/);
  }
});
