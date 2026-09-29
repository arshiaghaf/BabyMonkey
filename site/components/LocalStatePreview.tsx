'use client';

import { useState } from 'react';
import { BabyMonkeyExperience } from '@/components/BabyMonkeyExperience';
import { MonkeyAssetWarmup } from '@/components/MonkeyAssetWarmup';
import {
  PublicAuthShell,
  type PublicAuthShellState,
} from '@/components/PublicAuthShell';
import {
  babyMonkeyStates,
  statePresentations,
  type BabyMonkeyState,
} from '@/lib/babymonkey-states';
import styles from './LocalStatePreview.module.css';

const stateLabels: Record<BabyMonkeyState, string> = {
  ready: 'Ready',
  pending: 'Pending',
  confirmed: 'Confirmed',
  cooldown: 'Cooldown',
  definitiveFailure: 'Failure',
  ambiguous: 'Ambiguous',
};

const artworkSources = Object.fromEntries(
  babyMonkeyStates.map((state) => [state, statePresentations[state].imageSrc]),
) as Record<BabyMonkeyState, string>;
const brandImageSrc = '/__preview-assets/monkey/ready-monkey-head.png';
const experienceLabels = {
  primaryAction: 'Ask the recipient to reach out gently',
  revealResult: 'Reveal whether the little monkey was sent',
  signOut: 'Sign out',
};
export function LocalStatePreview() {
  const [state, setState] = useState<BabyMonkeyState>('ready');
  const [controlsVisible, setControlsVisible] = useState(true);
  const [authState, setAuthState] = useState<PublicAuthShellState | null>(null);

  const enterPending = () => setState('pending');
  const revealResult = () => setState('confirmed');
  const showState = (nextState: BabyMonkeyState) => {
    setAuthState(null);
    setState(nextState);
  };
  const showAuthState = (nextState: PublicAuthShellState) => {
    setAuthState(nextState);
  };

  return (
    <>
      <MonkeyAssetWarmup artworkSources={artworkSources} />
      {authState ? (
        <PublicAuthShell
          onAuthenticate={
            authState === 'working' ? undefined : () => setAuthState('working')
          }
          state={authState}
        />
      ) : (
        <BabyMonkeyExperience
          artworkSources={artworkSources}
          brandImageSrc={brandImageSrc}
          labels={experienceLabels}
          onRevealResult={revealResult}
          onRetry={enterPending}
          onRetryAmbiguous={enterPending}
          onSignal={enterPending}
          presentation={statePresentations[state]}
          state={state}
        />
      )}

      {controlsVisible ? (
        <aside
          className={styles.controls}
          data-testid="local-preview-controls"
        >
          <p><strong>Local visual preview</strong></p>
          <p>No notification is sent.</p>
          <div
            aria-label="Preview state"
            className={styles.stateButtons}
            role="group"
          >
            {babyMonkeyStates.map((candidateState) => (
              <button
                aria-pressed={
                  !authState && state === candidateState
                }
                key={candidateState}
                onClick={() => showState(candidateState)}
                type="button"
              >
                {stateLabels[candidateState]}
              </button>
            ))}
            <button
              aria-pressed={authState === 'ready'}
              onClick={() => showAuthState('ready')}
              type="button"
            >
              Auth ready
            </button>
            <button
              aria-pressed={authState === 'working'}
              onClick={() => showAuthState('working')}
              type="button"
            >
              Auth working
            </button>
            <button
              aria-pressed={authState === 'recoverableFailure'}
              onClick={() => showAuthState('recoverableFailure')}
              type="button"
            >
              Auth failure
            </button>
          </div>
          <button className={styles.hideControls} onClick={() => setControlsVisible(false)} type="button">
            Hide preview controls
          </button>
        </aside>
      ) : (
        <button
          className={styles.showControls}
          data-testid="show-preview-controls"
          onClick={() => setControlsVisible(true)}
          type="button"
        >
          Show preview controls
        </button>
      )}
    </>
  );
}
