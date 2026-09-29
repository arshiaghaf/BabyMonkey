import { EventEmitter } from 'node:events';

import { MaintenanceError } from '../src/errors.ts';
import { registerSessionSignalHandlers, runAuthenticatedMenu } from '../src/session.ts';
import { TokenVault, type TextTerminal } from '../src/terminal.ts';

const createTerminal = (questions: string[]): TextTerminal & { questionCount: number } => ({
  close: () => undefined,
  questionCount: 0,
  question: async function question() {
    this.questionCount += 1;
    return questions.shift() ?? '1';
  },
  write: () => undefined,
  writeError: () => undefined,
});

describe('authenticated menu token lifecycle', () => {
  it('destroys the token idempotently after successful exit', async () => {
    const terminal = createTerminal(['8']);
    const bytes = Buffer.from('synthetic-token-value');
    const token = new TokenVault(bytes);

    await runAuthenticatedMenu({
      menu: 'fixed menu',
      runAction: async () => false,
      signal: new AbortController().signal,
      terminal,
      token,
    });

    token.destroy();
    expect(token.destroyed).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['confirmation cancellation', new MaintenanceError('cancelled')],
    ['failed mutation reconciliation', new MaintenanceError('mutation-not-confirmed')],
  ])('ends the session and destroys the token after %s', async (_name, failure) => {
    const terminal = createTerminal(['4', '1']);
    const token = new TokenVault(Buffer.from('synthetic-token'));
    const runAction = vi.fn(async () => { throw failure; });

    await expect(runAuthenticatedMenu({
      menu: 'fixed menu',
      runAction,
      signal: new AbortController().signal,
      terminal,
      token,
    })).rejects.toBe(failure);

    expect(token.destroyed).toBe(true);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(terminal.questionCount).toBe(1);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const)(
    'destroys the token and aborts on %s',
    (signal) => {
      const emitter = new EventEmitter();
      const token = new TokenVault(Buffer.from('synthetic-token'));
      const session = new AbortController();
      const removeHandlers = registerSessionSignalHandlers(emitter, () => {
        token.destroy();
        session.abort();
      });

      emitter.emit(signal);

      expect(token.destroyed).toBe(true);
      expect(session.signal.aborted).toBe(true);
      removeHandlers();
      expect(emitter.listenerCount(signal)).toBe(0);
    },
  );
});
