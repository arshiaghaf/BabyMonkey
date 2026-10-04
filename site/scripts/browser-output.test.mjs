import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bounded, stopOwnedGroup } from './runner-lifecycle.mjs';

// Load all three real configs through Playwright, then override only the server
// and test flow with a synthetic artifact-producing fixture (no browser needed).
for (const config of ['playwright.config.ts', 'playwright.demo.config.ts', 'playwright.cloudflare.config.ts']) {
  for (const signal of [undefined, 'SIGINT', 'SIGTERM']) {
    test(`${config}: direct invocation owns output and cleans on ${signal ?? 'normal exit'}`, { timeout: 25_000 }, async () => {
      const scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), 'browser-output-fixture-'));
      const sentinel = path.join(scratch, 'unrelated-sentinel');
      const outputs = new Set();
      let child;
      try {
        await writeFile(sentinel, 'preserve');
        await writeFile(path.join(scratch, 'config.ts'), `
          import base from ${JSON.stringify(path.resolve(config))};
          console.log('OWNED_OUTPUT:' + base.outputDir);
          export default { ...base, testDir: ${JSON.stringify(scratch)}, testMatch: '**/ownership.spec.ts', testIgnore: [],
            webServer: undefined, workers: 1, use: {}, timeout: 15000 };
        `);
        await writeFile(path.join(scratch, 'ownership.spec.ts'), `
          import { test } from ${JSON.stringify(path.resolve('node_modules/@playwright/test/index.mjs'))};
          import { writeFile } from 'node:fs/promises';
          test.afterEach(async ({}, info) => {
            // Teardown writes must finish before the parent removes its output.
            await new Promise(resolve => setTimeout(resolve, 750));
            await writeFile(info.outputPath('teardown.txt'), 'owned teardown');
            await writeFile(${JSON.stringify(path.join(scratch, 'teardown-completed'))}, 'complete');
          });
          test('synthetic artifact', async ({}, info) => {
            await writeFile(info.outputPath('synthetic.txt'), 'owned');
            console.log('ARTIFACT_READY');
            ${signal ? 'await new Promise(resolve => setTimeout(resolve, 12000));' : ''}
          });
        `);
        child = spawn(process.execPath, [path.resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', path.join(scratch, 'config.ts')], {
          cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, BABYMONKEY_TEST_PROXY: 'http://127.0.0.1:9', BABYMONKEY_BROWSER_OUTPUT: scratch },
        });
        let output = '', resolveReady;
        const ready = new Promise(resolve => { resolveReady = resolve; });
        const collect = chunk => {
          output += chunk;
          for (const match of output.matchAll(/OWNED_OUTPUT:([^\r\n]+)/g)) outputs.add(match[1]);
          if (output.includes('ARTIFACT_READY')) resolveReady();
        };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        const completion = new Promise(resolve => child.once('close', (code, termination) => resolve({ code, termination })));
        await bounded(ready, 12_000, 'Synthetic Playwright fixture did not start.');
        assert.ok(outputs.size >= 1, output);
        for (const directory of outputs) {
          assert.notEqual(path.dirname(directory), scratch);
          assert.match(path.basename(path.dirname(directory)), /^babymonkey-browser-(preview|demo|production)-/);
        }
        if (signal) child.kill(signal);
        const result = await bounded(completion, 10_000, 'Browser output cleanup exceeded its bound.');
        assert.equal(result.termination, null, output);
        assert.equal(result.code, signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0, output);
        await stopOwnedGroup(child);
        assert.equal(await readFile(path.join(scratch, 'teardown-completed'), 'utf8'), 'complete', output);
        for (const directory of outputs) await assert.rejects(readFile(path.join(path.dirname(directory), 'results/.last-run.json')), /ENOENT/);
        // Check the root itself: absent output alone would miss leaked scratch.
        for (const directory of outputs) await assert.rejects(realpath(path.dirname(directory)), /ENOENT/, directory);
        assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
      } finally {
        await stopOwnedGroup(child);
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }
}

test('simultaneous config loads allocate independent output roots', { timeout: 15_000 }, async () => {
  const roots = [];
  const children = [];
  try {
    for (let index = 0; index < 2; index++) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { ownedBrowserOutput } from './scripts/browser-output.mjs';
        console.log(ownedBrowserOutput('demo'));
        setInterval(() => {}, 1000);
      `], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      children.push(child);
      roots.push(await bounded(new Promise(resolve => child.stdout.once('data', chunk => resolve(String(chunk).trim()))), 5000, 'Output allocation timed out.'));
    }
    assert.notEqual(roots[0], roots[1]);
    children[0].kill('SIGTERM');
    await bounded(new Promise(resolve => children[0].once('close', resolve)), 7000, 'Cleanup timed out.');
    await assert.rejects(realpath(path.dirname(roots[0])), /ENOENT/);
    await realpath(path.dirname(roots[1]));
  } finally { for (const child of children) await stopOwnedGroup(child); }
  await assert.rejects(realpath(path.dirname(roots[1])), /ENOENT/);
});
