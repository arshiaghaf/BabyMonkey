import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function terminationSignal() {
  const controller = new AbortController();
  const interrupt = () => controller.abort(Object.assign(new Error('Runner interrupted.'), { exitCode: 130 }));
  const terminate = () => controller.abort(Object.assign(new Error('Runner terminated.'), { exitCode: 143 }));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  return { signal: controller.signal, remove() { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); } };
}
export async function ownedDirectory(prefix) {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}
export async function validateOwnedDirectory(directory) {
  if (!directory) throw new Error('Missing parent-owned runner directory.');
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o777) !== 0o700 || await realpath(directory) !== directory || path.dirname(directory) !== await realpath(os.tmpdir()) || !/^babymonkey-(?:demo-run|production-runtime)-/.test(path.basename(directory))) throw new Error('Refusing redirected or unowned runner directory.');
}
export async function removeOwnedDirectory(directory) {
  if (!directory) return;
  await validateOwnedDirectory(directory);
  await bounded(rm(directory, { recursive: true, force: true }), 5_000, 'Owned directory cleanup timed out.');
}
export async function bounded(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export function childResult(child, signal, { ready = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => { clearTimeout(timer); child.off('error', fail); child.off('exit', exit); child.off('message', message); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(value); };
    const fail = error => finish(error);
    const exit = code => ready ? finish(new Error('Owned runtime failed before readiness.')) : finish(null, code ?? 1);
    const message = value => { if (ready && value?.ready) finish(null, value); };
    const abort = () => finish(signal.reason);
    child.once('error', fail); child.once('exit', exit); if (ready) child.on('message', message);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error(ready ? 'Owned runtime startup timed out.' : 'Owned test execution timed out.')), timeoutMs);
    if (signal.aborted) abort(); else if (child.exitCode !== null || child.signalCode !== null) exit(child.exitCode);
  });
}
export function activeOwnedGroupMembers(output, groupId, uid) {
  const members = output.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => Number(parts[1]) === groupId);
  if (members.some(parts => Number(parts[2]) !== uid)) throw new Error('Owned process group contains another user.');
  return members.filter(parts => !parts[3]?.startsWith('Z')).map(parts => Number(parts[0]));
}
// Only children spawned detached:true by these runners may be passed here. Their
// POSIX process groups contain all their descendants, never the caller's group.
export async function stopOwnedGroup(child) {
  if (!child?.pid) return;
  const liveMembers = () => {
    // A reaped browser group can retain zombie rows briefly. kill(-pgid, 0)
    // may report EPERM for that state on macOS, so inspect active members.
    const result = spawnSync('ps', ['-axo', 'pid=,pgid=,uid=,stat='], { encoding: 'utf8', timeout: 1_000 });
    if (result.status !== 0) throw new Error('Cannot inspect owned process group.');
    return activeOwnedGroupMembers(result.stdout, child.pid, process.getuid());
  };
  const send = signal => {
    if (!liveMembers().length) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code !== 'ESRCH' && !(error.code === 'EPERM' && !liveMembers().length)) throw new Error(`Cannot send ${signal} to owned group ${child.pid}: ${error.code}`);
    }
  };
  const alive = () => liveMembers().length > 0;
  send('SIGTERM');
  const deadline = Date.now() + 2_000;
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (alive()) send('SIGKILL');
  // A killed group can briefly contain OS-reaped zombies. No unbounded wait.
  if (child.exitCode === null && child.signalCode === null) await bounded(new Promise(resolve => child.once('exit', resolve)), 1_000, 'Owned child did not exit.');
}
export function requireProcessGroups() {
  if (process.platform === 'win32') throw new Error('Owned browser runners require POSIX process groups. Windows runner support is unverified.');
}
