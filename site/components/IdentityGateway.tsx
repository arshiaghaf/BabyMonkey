'use client';

import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import {
  PublicAuthShell,
  type PublicAuthShellState,
} from '@/components/PublicAuthShell';

type FlowResponse = { csrf: string };
type RegistrationOptionsResponse = {
  ceremony: 'registration';
  options: PublicKeyCredentialCreationOptionsJSON;
};
type AuthenticationOptionsResponse = {
  ceremony: 'authentication';
  options: PublicKeyCredentialRequestOptionsJSON;
};

const csrfHeaderName = 'x-bm-csrf';

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || response.headers.get('content-type') !== 'application/json') {
    throw new Error('Identity request failed.');
  }
  return response.json();
}

function isFlowResponse(value: unknown): value is FlowResponse {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof (value as FlowResponse).csrf === 'string'
      && /^[A-Za-z0-9_-]{43}$/u.test((value as FlowResponse).csrf),
  );
}

function isOptionsResponse(
  value: unknown,
): value is RegistrationOptionsResponse | AuthenticationOptionsResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { ceremony?: unknown; options?: unknown };
  return (
    (candidate.ceremony === 'registration'
      || candidate.ceremony === 'authentication')
    && Boolean(candidate.options)
    && typeof candidate.options === 'object'
  );
}

export function IdentityGateway() {
  const [state, setState] = useState<PublicAuthShellState>('ready');

  useEffect(() => {
    const revalidateAfterHistoryRestore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', revalidateAfterHistoryRestore);
    return () => window.removeEventListener('pageshow', revalidateAfterHistoryRestore);
  }, []);

  const authenticate = async () => {
    if (state === 'working') return;
    setState('working');
    try {
      const flow = await readJson(await fetch('/api/identity/flow', {
        cache: 'no-store',
        credentials: 'same-origin',
      }));
      if (!isFlowResponse(flow)) throw new Error('Invalid identity flow.');

      const options = await readJson(await fetch('/api/identity/options', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          [csrfHeaderName]: flow.csrf,
        },
        body: '{}',
      }));
      if (!isOptionsResponse(options)) throw new Error('Invalid ceremony options.');

      const response = options.ceremony === 'registration'
        ? await startRegistration({ optionsJSON: options.options })
        : await startAuthentication({ optionsJSON: options.options });

      const verification = await readJson(await fetch('/api/identity/verify', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          [csrfHeaderName]: flow.csrf,
        },
        body: JSON.stringify({ response }),
      }));
      if (
        !verification
        || typeof verification !== 'object'
        || (verification as { ok?: unknown }).ok !== true
      ) {
        throw new Error('Identity verification failed.');
      }
      window.location.replace('/');
    } catch {
      // Cancellation and verification failures are recoverable and never retry a POST.
      setState('recoverableFailure');
    }
  };

  return <PublicAuthShell onAuthenticate={authenticate} state={state} />;
}
