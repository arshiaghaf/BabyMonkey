import { fork } from 'node:child_process';
import path from 'node:path';
import { terminationSignal, ownedDirectory, removeOwnedDirectory, childResult, stopOwnedGroup, requireProcessGroups } from './runner-lifecycle.mjs';
const root = process.cwd();
requireProcessGroups();
const termination = terminationSignal();
let state, runtime;
let code = 0;
try {
  state = await ownedDirectory('babymonkey-production-runtime-');
  termination.signal.throwIfAborted();
  runtime = fork(path.join(root,'scripts/production-browser-runtime.mjs'), process.argv.slice(2), {
    detached: true, cwd: root, stdio: ['ignore','inherit','inherit','ipc'],
    env: { ...process.env, BABYMONKEY_RUNTIME_SCRATCH: state },
  });
  // Register completion concurrently: a fast child may exit immediately after readiness.
  const completion = childResult(runtime, termination.signal, { timeoutMs: 300_000 });
  completion.catch(() => undefined);
  await childResult(runtime, termination.signal, { ready: true });
  code = await completion;
} catch (error) { code = termination.signal.aborted ? termination.signal.reason.exitCode : 1; console.error(error.message); }
finally {
  try { await stopOwnedGroup(runtime); } catch (error) { console.error(error.message); code = 1; }
  try { await removeOwnedDirectory(state); } catch (error) { console.error(error.message); code = 1; }
  termination.remove();
}
process.exit(termination.signal.aborted && code === 0 ? termination.signal.reason.exitCode : code);
