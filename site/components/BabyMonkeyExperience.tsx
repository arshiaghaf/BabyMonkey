'use client';

import './ProtectedExperience.css';
import { MonkeyMark } from '@/components/MonkeyMark';
import { MonkeyArtworkTransition } from '@/components/MonkeyArtworkTransition';
import type {
  BabyMonkeyState,
  StatePresentation,
} from '@/lib/babymonkey-states';

export type BabyMonkeyExperienceProps = {
  artworkSources: Readonly<Record<BabyMonkeyState, string>>;
  brandImageSrc: string;
  labels: {
    primaryAction: string;
    revealResult: string;
    signOut: string;
  };
  presentation: StatePresentation;
  state: BabyMonkeyState;
  onSignal?: () => void;
  onRevealResult?: () => void;
  onRetry?: () => void;
  onRetryAmbiguous?: () => void;
  onSignOut?: () => void;
};

export function BabyMonkeyExperience({
  artworkSources,
  brandImageSrc,
  labels,
  presentation,
  state,
  onSignal,
  onRevealResult,
  onRetry,
  onRetryAmbiguous,
  onSignOut,
}: BabyMonkeyExperienceProps) {
  const primaryAction =
    state === 'ready'
      ? onSignal
      : state === 'pending'
        ? onRevealResult
        : undefined;
  const resultRevealEnabled = state === 'pending' && Boolean(onRevealResult);
  const supportingDetail =
    state === 'pending' && !resultRevealEnabled
      ? undefined
      : presentation.detail;
  const primaryActionLabel = resultRevealEnabled
    ? labels.revealResult
    : labels.primaryAction;
  const retryHandler =
    state === 'definitiveFailure'
      ? onRetry
      : state === 'ambiguous'
        ? onRetryAmbiguous
        : undefined;

  return (
    <div
      className={`rosewater-surface state-${state}`}
      data-state={state}
      data-view="experience"
    >
      <header className="rosewater-header">
        <MonkeyMark className="brand-mark" imageSrc={brandImageSrc} />
        <button
          className="sign-out-control"
          disabled={!onSignOut}
          onClick={onSignOut}
          type="button"
        >
          {labels.signOut}
        </button>
      </header>

      <main className="rosewater-stage">
        <div
          aria-atomic="true"
          aria-live="polite"
          className="state-message state-content-enter"
          key={`message-${state}`}
          role="status"
        >
          <h1
            aria-label={presentation.titleLines ? presentation.title : undefined}
          >
            {presentation.titleLines
              ? presentation.titleLines.map((line, index) => (
                  <span key={line}>
                    {line}
                    {index < presentation.titleLines!.length - 1 ? ' ' : null}
                  </span>
                ))
              : presentation.title}
          </h1>
          {supportingDetail ? (
            <p className={resultRevealEnabled ? 'pending-result-hint' : undefined}>
              {supportingDetail}
            </p>
          ) : null}
        </div>

        <button
          aria-label={primaryActionLabel}
          className="monkey-control"
          disabled={!primaryAction}
          onClick={primaryAction}
          type="button"
        >
          <span className="monkey-artwork-wrap" aria-hidden="true">
            <MonkeyArtworkTransition artworkSources={artworkSources} state={state} />
            {state === 'confirmed' ? (
              <span className="confirmation-petals" aria-hidden="true">
                <span />
                <span />
              </span>
            ) : null}
          </span>
        </button>

        <div
          className="recovery-slot state-content-enter"
          key={`recovery-${state}`}
        >
          {presentation.recoveryLabel ? (
            <button
              className="recovery-control"
              disabled={!retryHandler}
              onClick={retryHandler}
              type="button"
            >
              {presentation.recoveryLabel}
            </button>
          ) : presentation.interactionHint ? (
            <p className="interaction-hint">{presentation.interactionHint}</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
