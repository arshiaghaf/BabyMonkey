'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BabyMonkeyExperience } from '@/components/BabyMonkeyExperience';
import { MonkeyAssetWarmup } from '@/components/MonkeyAssetWarmup';
import { PublicAuthShell } from '@/components/PublicAuthShell';
import type { BabyMonkeyState, StatePresentation } from '@/lib/babymonkey-states';
import { confirmedDisplayDurationMs } from '@/lib/presentation-timing';
import { signalCooldownMs } from '@/lib/signal-timing';

export interface AuthorizedIdentityPresentationProps {
  brandImageSrc: string;
  labels: {
    signOut: string;
    primaryAction: string;
    revealResult: string;
  };
  artworkSources: Readonly<Record<BabyMonkeyState, string>>;
  presentations: Readonly<Record<BabyMonkeyState, StatePresentation>>;
  initialInteraction:
    | { available: false }
    | {
        available: true;
        state: 'ready';
        version: string | null;
      }
    | {
        available: true;
        state: 'pending' | 'cooldown' | 'confirmed' | 'definitive-failure' | 'ambiguous';
        retryAfterMs: number;
        version: string | null;
      };
}

const csrfCookieName = '__Host-bm-csrf';
const signalVersionHeaderName = 'x-bm-signal-version';
const subscribeToHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
function readCsrfCookie(): string | null {
  const matches = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${csrfCookieName}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(csrfCookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

type TerminalState = 'confirmed' | 'definitiveFailure' | 'ambiguous';

const toTerminalState = (
  state: 'confirmed' | 'definitive-failure' | 'ambiguous',
): TerminalState => state === 'definitive-failure' ? 'definitiveFailure' : state;

const createAttempt = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

type InteractionResponse = {
  state: 'pending' | 'cooldown' | 'confirmed' | 'definitive-failure' | 'ambiguous';
  retryAfterMs: number;
};

const parseInteractionResponse = (value: unknown): InteractionResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowed = keys.length === 2 && keys[0] === 'retryAfterMs' && keys[1] === 'state';
  if (!allowed) return null;
  if (!['pending', 'cooldown', 'confirmed', 'definitive-failure', 'ambiguous']
    .includes(String(record.state))) return null;
  if (
    typeof record.retryAfterMs !== 'number'
    || !Number.isInteger(record.retryAfterMs)
    || record.retryAfterMs < 0
    || record.retryAfterMs > signalCooldownMs
  ) return null;
  return record as InteractionResponse;
};

export function AuthorizedIdentityPresentation({
  brandImageSrc,
  artworkSources,
  initialInteraction,
  labels,
  presentations,
}: AuthorizedIdentityPresentationProps) {
  const [leaving, setLeaving] = useState(false);
  // Server-rendered controls must wait until React attaches their handlers.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientHydrated, serverHydrated);
  const initialTerminal = initialInteraction.available
    && (initialInteraction.state === 'confirmed'
      || initialInteraction.state === 'definitive-failure'
      || initialInteraction.state === 'ambiguous')
    ? toTerminalState(initialInteraction.state)
    : null;
  const initialViewState: BabyMonkeyState = initialTerminal
    ? 'pending'
    : !initialInteraction.available
      ? 'ready'
      : initialInteraction.state === 'definitive-failure'
        ? 'definitiveFailure'
        : initialInteraction.state;
  const [interactionState, setInteractionState] = useState<BabyMonkeyState>(
    initialViewState,
  );
  const [pendingResult, setPendingResult] = useState<TerminalState | null>(initialTerminal);
  const initialRetryAfterMs = initialInteraction.available
    && 'retryAfterMs' in initialInteraction
    ? initialInteraction.retryAfterMs
    : 0;
  const [retryAfterMs, setRetryAfterMs] = useState(
    initialTerminal ? initialRetryAfterMs : 0,
  );
  const [confirmedDisplayDeadlineMs, setConfirmedDisplayDeadlineMs] = useState<number | null>(
    null,
  );
  const [cooldownDeadlineMs, setCooldownDeadlineMs] = useState(
    () => initialInteraction.available && initialInteraction.state === 'cooldown'
      ? Date.now() + initialRetryAfterMs
      : null,
  );
  const [ambiguousRetryReady, setAmbiguousRetryReady] = useState(
    initialTerminal === 'ambiguous' && initialRetryAfterMs === 0,
  );
  const [signalVersion, setSignalVersion] = useState(
    initialInteraction.available ? initialInteraction.version : null,
  );
  const requestInFlight = useRef(false);

  useEffect(() => {
    const reloadAfterHistoryRestore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', reloadAfterHistoryRestore);
    return () => window.removeEventListener('pageshow', reloadAfterHistoryRestore);
  }, []);

  useEffect(() => {
    for (const source of [brandImageSrc, artworkSources.ready]) {
      const image = new window.Image();
      image.decoding = 'async';
      image.src = source;
    }
  }, [artworkSources.ready, brandImageSrc]);

  useEffect(() => {
    if (pendingResult !== 'ambiguous' || retryAfterMs <= 0) return;
    const timer = window.setTimeout(() => setAmbiguousRetryReady(true), retryAfterMs);
    return () => window.clearTimeout(timer);
  }, [pendingResult, retryAfterMs]);

  useEffect(() => {
    if (!initialInteraction.available || initialInteraction.state !== 'pending') return;
    const timer = window.setTimeout(
      () => window.location.replace('/'),
      initialInteraction.retryAfterMs,
    );
    return () => window.clearTimeout(timer);
  }, [initialInteraction]);

  useEffect(() => {
    if (interactionState !== 'confirmed' || confirmedDisplayDeadlineMs === null) return;
    const timer = window.setTimeout(() => {
      setPendingResult(null);
      setRetryAfterMs(0);
      setConfirmedDisplayDeadlineMs(null);
      setInteractionState('ready');
    }, Math.max(0, confirmedDisplayDeadlineMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [confirmedDisplayDeadlineMs, interactionState]);

  useEffect(() => {
    if (interactionState !== 'cooldown' || cooldownDeadlineMs === null) return;
    const timer = window.setTimeout(() => {
      setRetryAfterMs(0);
      setCooldownDeadlineMs(null);
      setInteractionState('ready');
    }, Math.max(0, cooldownDeadlineMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [cooldownDeadlineMs, interactionState]);

  const signOut = async () => {
    if (leaving) return;
    setLeaving(true);
    const csrf = readCsrfCookie();
    try {
      if (csrf) {
        await fetch('/api/identity/signout', {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            'x-bm-csrf': csrf,
          },
          body: '{}',
        });
      }
    } finally {
      // Only a fresh server render decides whether authorization remains.
      window.location.replace('/');
    }
  };

  const submitAttempt = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setInteractionState('pending');
    setPendingResult(null);
    setRetryAfterMs(0);
    setConfirmedDisplayDeadlineMs(null);
    setCooldownDeadlineMs(null);
    const attempt = createAttempt();
    const expectedVersion = signalVersion;
    const csrf = readCsrfCookie();
    if (!csrf) {
      window.location.replace('/');
      return;
    }
    const requestAttempt = async () => {
      for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
        try {
          const response = await fetch('/api/interaction', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/json',
              'x-bm-csrf': csrf,
              [signalVersionHeaderName]: expectedVersion ?? 'none',
            },
            body: JSON.stringify({ attempt }),
          });
          if (!response.ok) {
            window.location.replace('/');
            return null;
          }
          const returnedVersion = response.headers.get(signalVersionHeaderName);
          const parsed = parseInteractionResponse(await response.json());
          if (!parsed || !returnedVersion || !/^[0-9a-f]{64}$/u.test(returnedVersion)) {
            window.location.replace('/');
            return null;
          }
          return { result: parsed, version: returnedVersion };
        } catch {
          // The exact same opaque attempt is retried once to recover response loss.
        }
      }
      return null;
    };
    try {
      let response = await requestAttempt();
      while (response?.result.state === 'pending') {
        setSignalVersion(response.version);
        const pendingForMs = response.result.retryAfterMs;
        if (pendingForMs === undefined) {
          window.location.replace('/');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, pendingForMs));
        response = await requestAttempt();
      }
      if (!response) {
        window.location.replace('/');
        return;
      }
      const { result, version: resultVersion } = response;
      setSignalVersion(resultVersion);
      if (result.state === 'pending') {
        window.location.replace('/');
        return;
      }
      if (result.state === 'cooldown') {
        setRetryAfterMs(result.retryAfterMs);
        setCooldownDeadlineMs(Date.now() + result.retryAfterMs);
        setInteractionState(result.state);
        return;
      }
      setPendingResult(toTerminalState(result.state));
      const nextRetryAfterMs = result.retryAfterMs;
      setRetryAfterMs(nextRetryAfterMs);
      setAmbiguousRetryReady(
        result.state === 'ambiguous' && nextRetryAfterMs === 0,
      );
      setInteractionState('pending');
    } finally {
      requestInFlight.current = false;
    }
  };

  const revealResult = () => {
    if (!pendingResult) return;
    if (pendingResult === 'confirmed') {
      setConfirmedDisplayDeadlineMs(Date.now() + confirmedDisplayDurationMs);
    }
    setInteractionState(pendingResult);
  };

  if (leaving) return <PublicAuthShell state="working" />;

  return (
    <>
      <MonkeyAssetWarmup artworkSources={artworkSources} />
      <BabyMonkeyExperience
        artworkSources={artworkSources}
        brandImageSrc={brandImageSrc}
        labels={{
          primaryAction: labels.primaryAction,
          revealResult: labels.revealResult,
          signOut: labels.signOut,
        }}
        onRevealResult={hydrated && pendingResult ? revealResult : undefined}
        onRetry={hydrated && interactionState === 'definitiveFailure' ? submitAttempt : undefined}
        onRetryAmbiguous={
          hydrated && interactionState === 'ambiguous' && ambiguousRetryReady
            ? submitAttempt
            : undefined
        }
        onSignal={
          hydrated && initialInteraction.available && interactionState === 'ready'
            ? submitAttempt
            : undefined
        }
        onSignOut={hydrated ? signOut : undefined}
        presentation={presentations[interactionState]}
        state={interactionState}
      />
    </>
  );
}
