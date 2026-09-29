import type { TokenVault, TextTerminal } from './terminal.ts';

interface SignalEmitter {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

const SESSION_SIGNALS: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
];

export const registerSessionSignalHandlers = (
  emitter: SignalEmitter,
  abort: () => void,
): (() => void) => {
  for (const signal of SESSION_SIGNALS) emitter.once(signal, abort);
  return () => {
    for (const signal of SESSION_SIGNALS) emitter.removeListener(signal, abort);
  };
};

interface AuthenticatedMenuOptions {
  menu: string;
  runAction(choice: string): Promise<boolean>;
  signal: AbortSignal;
  terminal: TextTerminal;
  token: TokenVault;
}

export const runAuthenticatedMenu = async (
  options: AuthenticatedMenuOptions,
): Promise<void> => {
  try {
    let running = true;
    while (running && !options.signal.aborted) {
      options.terminal.write(options.menu);
      const choice = (await options.terminal.question('Choose 1-8: ')).trim();
      running = await options.runAction(choice);
    }
  } finally {
    options.token.destroy();
  }
};
