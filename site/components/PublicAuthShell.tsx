'use client';

import styles from './PublicAuthShell.module.css';

export const publicAuthShellStates = [
  'ready',
  'working',
  'recoverableFailure',
] as const;

export type PublicAuthShellState = (typeof publicAuthShellStates)[number];

export type PublicAuthShellProps = {
  state: PublicAuthShellState;
  onAuthenticate?: () => void;
};

const supportingCopy: Record<PublicAuthShellState, string> = {
  ready: 'Let’s make sure it’s really you.',
  working: 'Just a moment…',
  recoverableFailure: 'That didn’t work. Let’s try again.',
};

const unavailableDescriptionId = 'public-auth-unavailable';

export function PublicAuthShell({
  state,
  onAuthenticate,
}: PublicAuthShellProps) {
  const isWorking = state === 'working';
  const isUnavailable = !isWorking && !onAuthenticate;
  const isDisabled = isWorking || !onAuthenticate;

  return (
    <main
      className="rosewater-surface"
      data-auth-state={state}
      data-view="public-auth-shell"
    >
      <div className={styles.stage}>
        <div className={styles.content}>
          <div className={styles.copy}>
            <h1 className={styles.title}>
              This little corner has just one person in mind.
            </h1>
            <p
              aria-atomic="true"
              aria-live="polite"
              className={styles.supporting}
              role="status"
            >
              <span className={styles.supportingMessage} key={state}>
                {supportingCopy[state]}
              </span>
            </p>
          </div>

          <button
            aria-busy={isWorking}
            aria-describedby={isUnavailable ? unavailableDescriptionId : undefined}
            className={styles.action}
            disabled={isDisabled}
            onClick={onAuthenticate}
            type="button"
          >
            Verify
          </button>

          {isUnavailable ? (
            <p className={styles.visuallyHidden} id={unavailableDescriptionId}>
              Continue is not available yet.
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
