import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { electronCheck } from './electron-check.mjs';

const { scratch } = electronCheck(import.meta.url, 'docs-package', 60_000);
const { app } = await import('electron');
app.setPath('userData', join(scratch, 'profile'));
try {
  const resources = resolve(process.argv[2], 'resources');
  const { boardAgentInstructions } = await import(pathToFileURL(join(resources, 'app.asar', 'src/desktop/board-agent-hooks.ts')));
  let count = 0;
  for (const role of ['manager', 'executor', 'reviewer']) {
    const instructions = boardAgentInstructions(role);
    const guide = JSON.parse(instructions.match(/bundled guide at (".*?") and load/)[1]);
    assert.ok(guide.includes('app.asar.unpacked'));
    assert.match(readFileSync(guide, 'utf8'), /# Documentation/);
    const base = resolve(guide, '..');
    const files = readdirSync(base, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
    for (const file of files) {
      const packaged = readFileSync(join(file.parentPath, file.name));
      const relative = join(file.parentPath.slice(base.length), file.name);
      const source = readFileSync(join(fileURLToPath(new URL('../src/desktop/agent-instructions/docs/', import.meta.url)), relative));
      assert.equal(createHash('sha256').update(packaged).digest('hex'), createHash('sha256').update(source).digest('hex'));
      count++;
    }
  }
  console.log(JSON.stringify({ roles: 3, resourceComparisons: count, packagedGuide: 'app.asar.unpacked', result: 'PASS' }));
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
