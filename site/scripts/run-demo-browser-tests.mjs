import { fork, spawn } from 'node:child_process';
import path from 'node:path';
import { terminationSignal, ownedDirectory, removeOwnedDirectory, childResult, stopOwnedGroup, requireProcessGroups } from './runner-lifecycle.mjs';
const root = process.cwd();
requireProcessGroups();
const termination = terminationSignal();
let state, server, test;
let code = 0;
try {
  for (const outcome of ['confirmed', 'definitive-failure', 'ambiguous']) {
    termination.signal.throwIfAborted();
    state = await ownedDirectory('babymonkey-demo-run-');
    termination.signal.throwIfAborted();
    try {
      server = fork(path.join(root, 'scripts/run-development-preview.mjs'), ['--hostname', '127.0.0.1'], {
        detached: true, cwd: root, stdio: ['ignore','inherit','inherit','ipc'],
        env: { ...process.env, BABYMONKEY_DEMO_PARENT_STATE: state, BABYMONKEY_LOCAL_DEMO: '1', BABYMONKEY_FAKE_DELIVERY: outcome, NEXT_TELEMETRY_DISABLED: '1' },
      });
      const ready = await childResult(server, termination.signal, { ready: true });
      if (ready.tokens?.length !== 2) throw new Error('Invalid demo readiness.');
      termination.signal.throwIfAborted();
      test = spawn(process.execPath, [path.join(root,'node_modules/@playwright/test/cli.js'), 'test','--config','playwright.demo.config.ts'], {
        detached: true, cwd: root, stdio: 'inherit',
        env: { ...process.env, BABYMONKEY_DEMO_INVITE_1: ready.tokens[0], BABYMONKEY_DEMO_INVITE_2: ready.tokens[1], BABYMONKEY_TEST_OUTCOME: outcome },
      });
      code = await childResult(test, termination.signal, { timeoutMs: 180_000 });
    } finally {
      await Promise.allSettled([stopOwnedGroup(test), stopOwnedGroup(server)]).then(results => { for (const result of results) if (result.status === 'rejected') throw result.reason; });
      server = test = undefined;
      await removeOwnedDirectory(state); state = undefined;
    }
    if (code) break;
  }
} catch (error) { code = termination.signal.aborted ? termination.signal.reason.exitCode : 1; console.error(error.message); }
finally {
  await Promise.allSettled([stopOwnedGroup(test), stopOwnedGroup(server)]);
  try { await removeOwnedDirectory(state); } catch (error) { console.error(error.message); code = 1; }
  termination.remove();
}
process.exit(termination.signal.aborted && code === 0 ? termination.signal.reason.exitCode : code);
