import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  publicErrorMessage,
  runMaintenanceCli,
  type MaintenanceCliOptions,
} from '../../src/cli.ts';

interface Scenario {
  pauseAfterHiddenPrompt?: boolean;
  questionTimeoutMs: number;
  secretTimeoutMs: number;
  sessionTimeoutMs: number;
}

globalThis.fetch = async () => {
  throw new Error('network access is disabled in the PTY fixture');
};

const terminalState = (): string => {
  const result = spawnSync('/bin/stty', ['-g'], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'ignore'],
  });
  if (result.status !== 0) throw new Error('terminal state unavailable');
  return result.stdout.trim();
};

const run = async (): Promise<void> => {
  const scenario = JSON.parse(
    await readFile(path.resolve('scenario.json'), 'utf8'),
  ) as Scenario;
  if (scenario.pauseAfterHiddenPrompt) {
    // Model descheduling immediately after a prompt reaches the real terminal.
    // Synthetic input can arrive while the CLI cannot yet execute its next line.
    process.stdout.write = new Proxy(process.stdout.write.bind(process.stdout), {
      apply(target, receiver, args) {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (typeof result !== 'boolean') throw new Error('unexpected synthetic output result');
        if (args[0] === 'Cloudflare D1 Write token: ') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
        return result;
      },
    });
  }
  const originalTerminalState = terminalState();
  let operationError: unknown;
  try {
    const options: MaintenanceCliOptions = {
      paths: {
        configPath: path.resolve('maintenance.json'),
        journalPath: path.resolve('invitation-journal.json'),
        lockPath: path.resolve('maintenance.lock'),
      },
      questionTimeoutMs: scenario.questionTimeoutMs,
      secretTimeoutMs: scenario.secretTimeoutMs,
      sessionTimeoutMs: scenario.sessionTimeoutMs,
    };
    await runMaintenanceCli(options);
  } catch (error) {
    operationError = error;
  }
  if (terminalState() !== originalTerminalState) {
    throw new Error('terminal state was not restored');
  }
  process.stdout.write('TTY_STATE_RESTORED\nTOKEN_VAULT_DESTROYED\n');
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) throw new Error('unexpected synthetic failure');
};

run().catch((error: unknown) => {
  process.stderr.write(`${publicErrorMessage(error)}\n`);
  process.exitCode = 1;
});
