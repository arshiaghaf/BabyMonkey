import { spawn } from 'node:child_process';

import { MaintenanceError } from './errors.ts';

export type SpawnImplementation = typeof spawn;

export const copyInvitationToClipboard = async (
  invitationUrl: string,
  options: { signal: AbortSignal; timeoutMs: number },
  spawnImplementation: SpawnImplementation = spawn,
): Promise<void> => {
  if (options.signal.aborted) throw new MaintenanceError('cancelled');
  if (process.platform !== 'darwin') {
    throw new MaintenanceError('clipboard-failed');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnImplementation('/usr/bin/pbcopy', [], {
      env: {},
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let settled = false;
    const finish = (error?: MaintenanceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onError = () => {
      child.removeListener('close', onClose);
      if (!settled) finish(new MaintenanceError('clipboard-failed'));
    };
    const onClose = (code: number | null) => {
      child.removeListener('error', onError);
      if (!settled) {
        finish(code === 0 ? undefined : new MaintenanceError('clipboard-failed'));
      }
    };
    const onAbort = () => {
      child.stdin?.destroy();
      child.kill('SIGTERM');
      finish(new MaintenanceError('cancelled'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new MaintenanceError('session-timeout'));
    }, options.timeoutMs);
    child.once('error', onError);
    child.once('close', onClose);
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    child.stdin?.end(invitationUrl);
  });
};
