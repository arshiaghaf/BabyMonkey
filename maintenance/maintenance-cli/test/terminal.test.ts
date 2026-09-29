import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';

import {
  assertClosedInteractiveInvocation,
  createTextTerminal,
  readSecretBytes,
  TokenVault,
} from '../src/terminal.ts';

class FakeInput extends EventEmitter {
  isRaw = false;
  readonly queued: Buffer[] = [];
  pause(): this { return this; }
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
  resume(): this { return this; }
  unshift(chunk: Buffer): void { this.queued.unshift(chunk); }
}

describe('closed TTY secret entry', () => {
  it('rejects argv, known secret environment, and any detached stream', () => {
    const base = { argv: ['node', 'cli'], env: {}, stdinIsTty: true, stdoutIsTty: true, stderrIsTty: true };
    expect(() => { assertClosedInteractiveInvocation(base); }).not.toThrow();
    expect(() => { assertClosedInteractiveInvocation({ ...base, argv: [...base.argv, '--token=x'] }); }).toThrow(/Sensitive/);
    expect(() => { assertClosedInteractiveInvocation({ ...base, env: { CLOUDFLARE_API_TOKEN: 'x' } }); }).toThrow(/Sensitive/);
    expect(() => { assertClosedInteractiveInvocation({ ...base, stdinIsTty: false }); }).toThrow(/interactive TTY/);
  });

  it('disables echo before publishing the hidden token prompt', async () => {
    const input = new FakeInput();
    const rawAtPrompt: boolean[] = [];
    const promise = readSecretBytes(input, { write(value) {
      if (value !== '\n') rawAtPrompt.push(input.isRaw);
      return true;
    } }, { timeoutMs: 1_000, signal: new AbortController().signal });
    input.emit('data', Buffer.from('synthetic-token-for-local-test\n'));
    const bytes = await promise;
    bytes.fill(0);
    expect(rawAtPrompt).toEqual([true]);
    expect(input.isRaw).toBe(false);
  });

  it.each(['prompt', 'resume'])('restores terminal mode when %s initialization fails', async (failure) => {
    const input = new FakeInput();
    if (failure === 'resume') input.resume = () => { throw new Error('synthetic setup failure'); };
    await expect(readSecretBytes(input, { write() {
      if (failure === 'prompt') throw new Error('synthetic setup failure');
      return true;
    } }, { timeoutMs: 1_000, signal: new AbortController().signal })).rejects.toThrow('synthetic setup failure');
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  it('reads without echo, restores raw mode, and wipes the vault', async () => {
    const input = new FakeInput();
    const writes: string[] = [];
    const secret = randomBytes(24).toString('base64url');
    const promise = readSecretBytes(input, { write: (value) => { writes.push(value); return true; } }, {
      timeoutMs: 1_000, signal: new AbortController().signal,
    });
    input.emit('data', Buffer.from(`${secret}\n`));
    const bytes = await promise;
    expect(writes.join('')).not.toContain(secret);
    expect(input.isRaw).toBe(false);
    const vault = new TokenVault(bytes);
    expect(vault.authorizationHeader()).toBe(`Bearer ${secret}`);
    vault.destroy();
    expect(vault.destroyed).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('cancels on Ctrl-C without echoing buffered input', async () => {
    const input = new FakeInput();
    const writes: string[] = [];
    const prefix = randomBytes(12).toString('base64url');
    const promise = readSecretBytes(input, { write: (value) => { writes.push(value); return true; } }, {
      timeoutMs: 1_000, signal: new AbortController().signal,
    });
    input.emit('data', Buffer.from(`${prefix}\u0003`));
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(writes.join('')).not.toContain(prefix);
    expect(input.isRaw).toBe(false);
  });

  it('preserves only post-secret input for the next terminal question', async () => {
    const input = new FakeInput();
    const secret = randomBytes(24).toString('base64url');
    const promise = readSecretBytes(input, { write: () => true }, {
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    input.emit('data', Buffer.from(`${secret}\r\n8\r\n`));
    const bytes = await promise;
    expect(bytes.toString('utf8')).toBe(secret);
    expect(input.queued).toHaveLength(1);
    expect(input.queued[0]?.toString('utf8')).toBe('8\r\n');
    expect(input.queued[0]?.toString('utf8')).not.toContain(secret);
    bytes.fill(0);
  });

  it('restores raw mode and releases listeners after secret timeout', async () => {
    const input = new FakeInput();
    const promise = readSecretBytes(input, { write: () => true }, {
      timeoutMs: 10,
      signal: new AbortController().signal,
    });
    await expect(promise).rejects.toMatchObject({ code: 'session-timeout' });
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  it('restores raw mode and releases listeners after signal cancellation', async () => {
    const input = new FakeInput();
    const session = new AbortController();
    const promise = readSecretBytes(input, { write: () => true }, {
      timeoutMs: 1_000,
      signal: session.signal,
    });
    session.abort();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  });

  it('detaches readline before raw secret capture', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const terminal = createTextTerminal(
      input,
      output,
      output,
      new AbortController().signal,
      1_000,
    );
    const pendingQuestion = terminal.question('Synthetic prompt: ');
    expect(input.listenerCount('data')).toBeGreaterThan(0);
    terminal.close();
    await expect(pendingQuestion).rejects.toBeDefined();
    expect(input.listenerCount('data')).toBe(0);
  });

  it('releases text listeners after an input stream failure', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const priorErrorListener = (): void => undefined;
    input.on('error', priorErrorListener);
    const terminal = createTextTerminal(
      input,
      output,
      output,
      new AbortController().signal,
      20,
    );
    const pendingQuestion = terminal.question('Synthetic prompt: ');
    expect(() => input.emit('error', new Error('synthetic stream failure'))).not.toThrow();
    await expect(pendingQuestion).rejects.toBeDefined();
    terminal.close();
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listeners('error')).toEqual([priorErrorListener]);
    input.off('error', priorErrorListener);
  });

  it('sanitizes TTY errors and restores raw mode', async () => {
    const input = new FakeInput();
    const writes: string[] = [];
    const promise = readSecretBytes(input, {
      write: (value) => { writes.push(value); return true; },
    }, { timeoutMs: 1_000, signal: new AbortController().signal });
    input.emit('error', new Error('terminal payload'));
    await expect(promise).rejects.toMatchObject({ code: 'secret-input-failed' });
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(writes.join('')).not.toContain('terminal payload');
  });
});
