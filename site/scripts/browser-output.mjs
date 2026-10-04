import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Allocate during config loading, before Playwright clears outputDir. Each
// process/config owns an exclusive root, including direct CLI invocations.
// No environment variable or caller-supplied deletion path is accepted.
export function ownedBrowserOutput(mode) {
  if (!['preview', 'demo', 'production'].includes(mode)) throw new Error('Unknown browser output mode.');
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), `babymonkey-browser-${mode}-`));
  const { dev, ino } = lstatSync(root);
  let interruptedExitCode;
  const cleanup = () => {
    if (interruptedExitCode !== undefined) process.exitCode = interruptedExitCode;
    // Exit handlers cannot await. A small filesystem-only child bounds cleanup
    // to five seconds; it receives only this internally allocated root/identity.
    // Its separate group lets cleanup finish while the runner stops its group.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { lstatSync, realpathSync, rmSync } from 'node:fs';
      const [root, dev, ino] = process.argv.slice(1);
      let info;
      try { info = lstatSync(root); } catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
          (info.mode & 0o777) !== 0o700 || String(info.dev) !== dev || String(info.ino) !== ino ||
          realpathSync(root) !== root) throw new Error('Refusing changed browser output root.');
      rmSync(root, { recursive: true, force: true });
    `, root, String(dev), String(ino)], { timeout: 5_000, stdio: 'ignore', detached: true });
    if (result.status !== 0) {
      console.error('Owned browser output cleanup failed; inspect this run:', root);
      process.exitCode = 1;
    }
  };
  process.once('exit', cleanup);
  const interrupted = signal => {
    interruptedExitCode ??= signal === 'SIGINT' ? 130 : 143;
    // Let Playwright finish worker teardown before deleting output. Its SIGINT
    // path is cooperative; use it for SIGTERM too, retaining exit status 143.
    if (process.listenerCount('SIGINT') > 1) {
      if (signal === 'SIGTERM') process.emit('SIGINT');
      return;
    }
    process.exit(interruptedExitCode);
  };
  process.on('SIGINT', () => interrupted('SIGINT'));
  process.once('SIGTERM', () => interrupted('SIGTERM'));
  return path.join(root, 'results');
}
