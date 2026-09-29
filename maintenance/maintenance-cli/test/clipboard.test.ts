import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { copyInvitationToClipboard, type SpawnImplementation } from '../src/clipboard.ts';

describe('explicit clipboard boundary', () => {
  it('uses only the fixed pbcopy executable with no args, shell, or inherited environment', async () => {
    if (process.platform !== 'darwin') return;
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough();
    const spawn = ((command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as SpawnImplementation;
    const invitation = new URL('https://app.example.com/invite');
    invitation.hash = randomBytes(32).toString('base64url');
    await copyInvitationToClipboard(invitation.href, {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    }, spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/usr/bin/pbcopy', args: [], options: { env: {}, shell: false },
    });
  });
});
