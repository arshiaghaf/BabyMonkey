import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';

import { MaintenanceError } from './errors.ts';

const sensitiveEnvironmentNames = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_TOKEN',
  'CF_API_KEY',
  'CLOUDFLARE_TOKEN',
  'WRANGLER_API_TOKEN',
] as const;

export interface TtyState {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  stderrIsTty: boolean;
}

export const assertClosedInteractiveInvocation = (state: TtyState): void => {
  if (!state.stdinIsTty || !state.stdoutIsTty || !state.stderrIsTty) {
    throw new MaintenanceError('noninteractive');
  }
  if (state.argv.length !== 2) {
    throw new MaintenanceError('sensitive-input-rejected');
  }
  if (sensitiveEnvironmentNames.some((name) => state.env[name] !== undefined)) {
    throw new MaintenanceError('sensitive-input-rejected');
  }
};

export interface SecretTtyInput extends EventEmitter {
  isRaw?: boolean;
  pause(): this;
  setRawMode(mode: boolean): this;
  resume(): this;
  unshift(chunk: Buffer): void;
}

export interface SecretTtyOutput {
  write(chunk: string): boolean;
}

export const readSecretBytes = async (
  input: SecretTtyInput,
  output: SecretTtyOutput,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<Buffer> => {
  const staging = Buffer.alloc(512);
  let length = 0;
  const previousRaw = input.isRaw === true;
  try {
    // Input may arrive as soon as the prompt is visible, even if this process
    // is descheduled before its next statement. Disable echo first.
    input.setRawMode(true);
    output.write('Cloudflare D1 Write token: ');
    input.resume();
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const finish = (error?: MaintenanceError, trailingInput?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.off('data', onData);
        input.off('error', onError);
        options.signal.removeEventListener('abort', onAbort);
        input.pause();
        if (trailingInput && trailingInput.length > 0) {
          try {
            input.unshift(trailingInput);
          } catch {
            error = new MaintenanceError('secret-input-failed');
          }
        }
        output.write('\n');
        if (error) {
          staging.fill(0);
          reject(error);
          return;
        }
        if (length < 20) {
          staging.fill(0);
          reject(new MaintenanceError('secret-input-failed'));
          return;
        }
        const secret = Buffer.alloc(length);
        staging.copy(secret, 0, 0, length);
        staging.fill(0);
        resolve(secret);
      };
      const onAbort = () => { finish(new MaintenanceError('cancelled')); };
      const onError = () => { finish(new MaintenanceError('secret-input-failed')); };
      const onData = (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (let index = 0; index < bytes.length; index += 1) {
          const byte = bytes[index];
          if (byte === 3) {
            finish(new MaintenanceError('cancelled'));
            return;
          }
          if (byte === 10 || byte === 13) {
            let trailingIndex = index + 1;
            if (byte === 13 && bytes[trailingIndex] === 10) trailingIndex += 1;
            finish(undefined, Buffer.from(bytes.subarray(trailingIndex)));
            return;
          }
          if (byte === 8 || byte === 127) {
            if (length > 0) length -= 1;
            continue;
          }
          if (byte < 33 || byte > 126 || length >= staging.length) {
            finish(new MaintenanceError('secret-input-failed'));
            return;
          }
          staging[length] = byte;
          length += 1;
        }
      };
      const timeout = setTimeout(
        () => { finish(new MaintenanceError('session-timeout')); },
        options.timeoutMs,
      );
      input.on('data', onData);
      input.once('error', onError);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    });
  } finally {
    staging.fill(0);
    input.setRawMode(previousRaw);
  }
};

export class TokenVault {
  #bytes: Buffer | null;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  authorizationHeader(): string {
    if (!this.#bytes) throw new MaintenanceError('cancelled');
    return `Bearer ${this.#bytes.toString('utf8')}`;
  }

  destroy(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }

  get destroyed(): boolean {
    return this.#bytes === null;
  }
}

export interface TextTerminal {
  question(prompt: string): Promise<string>;
  write(message: string): void;
  writeError(message: string): void;
  close(): void;
}

export const createTextTerminal = (
  input: Readable,
  output: Writable,
  error: Writable,
  sessionSignal: AbortSignal,
  questionTimeoutMs: number,
): TextTerminal => {
  // Attached-TTY enforcement happens before this controller is created. Using
  // readline's terminal editing mode here would install persistent keypress
  // decoder state on the TTY stream. That decoder cannot be safely removed
  // and recreated around the separate echo-disabled secret reader. Canonical
  // line input keeps text questions isolated while the OS still provides the
  // attached terminal's ordinary echo and editing behavior.
  let reader: ReturnType<typeof createInterface> | null = null;
  const inputFailure = new AbortController();
  const onReaderError = (): void => { inputFailure.abort(); };
  let closed = false;
  return {
    async question(prompt): Promise<string> {
      if (closed) throw new MaintenanceError('cancelled');
      if (reader === null) {
        reader = createInterface({ input, output, terminal: false });
        reader.once('error', onReaderError);
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => { timeout.abort(); }, questionTimeoutMs);
      const signal = AbortSignal.any([
        sessionSignal,
        timeout.signal,
        inputFailure.signal,
      ]);
      try {
        return await reader.question(prompt, { signal });
      } catch {
        if (inputFailure.signal.aborted) {
          throw new Error('terminal input failed');
        }
        throw new MaintenanceError(
          sessionSignal.aborted ? 'cancelled' : 'session-timeout',
        );
      } finally {
        clearTimeout(timer);
      }
    },
    write(message): void {
      output.write(message);
    },
    writeError(message): void {
      error.write(message);
    },
    close(): void {
      if (closed) return;
      closed = true;
      reader?.off('error', onReaderError);
      reader?.close();
      reader = null;
      input.pause();
    },
  };
};
