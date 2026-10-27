import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve('@node-minify/core'));
// Older glob releases do not export package.json, and the CLI layout changes.
let globRoot = path.dirname(coreRequire.resolve('glob'));
let metadata;
for (;;) {
  const metadataPath = path.join(globRoot, 'package.json');
  const candidate = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
  if (candidate?.name === 'glob') { metadata = candidate; break; }
  const parent = path.dirname(globRoot);
  assert.notEqual(parent, globRoot, 'Could not resolve the minifier glob package.');
  globRoot = parent;
}
const cli = path.resolve(globRoot, typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.glob);

for (const filename of ['$(touch injected)', 'ordinary;touch injected', 'ordinary file.txt']) {
  test(`minifier glob CLI passes filename literally: ${filename}`, async t => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'near-glob-security-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    await writeFile(path.join(scratch, filename), 'synthetic');
    const output = execFileSync(process.execPath, [cli, '-c', 'echo', '*'], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.deepEqual(await readdir(scratch), [filename]);
    assert.ok(output.includes(filename), 'The matched filename must reach the command unchanged.');
  });
}

test('minifier glob library retains string and array wildcard support', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'near-glob-library-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const filename of ['first.js', 'with space.js', 'excluded.txt']) {
    await writeFile(path.join(scratch, filename), 'synthetic');
  }
  const { globSync } = coreRequire('glob');
  const pattern = path.join(scratch, '*.js');
  const expected = ['first.js', 'with space.js'].map(name => path.join(scratch, name)).sort();
  assert.deepEqual(globSync(pattern).sort(), expected);
  assert.deepEqual(globSync([pattern]).sort(), expected);
});
