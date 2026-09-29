import { submitProtectedSignal } from '@/server/signal/service';
import { getFixedDeliveryBoundary } from '@/server/signal/runtime';
import {
  hashOpaqueCookie,
  readOpaqueCookie,
  requestCsrfMatches,
  sessionCookieName,
  sessionCsrfCookieName,
} from '@/server/identity/cookies';
import { decodeBase64url } from '@/server/identity/crypto';
import {
  hasExactKeys,
  hasExactMutationEnvelope,
  neutralMutationFailure,
  noStoreHeaders,
  noStoreJson,
  readBoundedJsonObject,
} from '@/server/identity/request';
import { getIdentityDatabase, getWebAuthnRuntimeConfig } from '@/server/identity/runtime';

export const dynamic = 'force-dynamic';

const signalVersionHeaderName = 'x-bm-signal-version';

const isAttempt = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[A-Za-z0-9_-]{43}$/u.test(value)
  && decodeBase64url(value)?.byteLength === 32;

export async function POST(request: Request) {
  const config = getWebAuthnRuntimeConfig();
  if (!hasExactMutationEnvelope(request, config)) return neutralMutationFailure();
  const csrfToken = readOpaqueCookie(request, sessionCsrfCookieName);
  if (!csrfToken || !requestCsrfMatches(request, csrfToken)) {
    return neutralMutationFailure();
  }
  const body = await readBoundedJsonObject(request, 128);
  if (!body || !hasExactKeys(body, ['attempt']) || !isAttempt(body.attempt)) {
    return neutralMutationFailure();
  }
  const submittedVersion = request.headers.get(signalVersionHeaderName);
  const expectedVersion = submittedVersion === 'none'
    ? null
    : submittedVersion && /^[0-9a-f]{64}$/u.test(submittedVersion)
      ? submittedVersion
      : undefined;
  if (expectedVersion === undefined) return neutralMutationFailure();
  const sessionHash = await hashOpaqueCookie(request, sessionCookieName);
  const csrfHash = await hashOpaqueCookie(request, sessionCsrfCookieName);
  const db = getIdentityDatabase();
  if (!db || !sessionHash || !csrfHash) return neutralMutationFailure();

  const result = await submitProtectedSignal(db, {
    sessionHash,
    csrfHash,
    attempt: body.attempt,
    expectedVersion,
    now: Date.now,
  }, getFixedDeliveryBoundary());
  if (!result.accepted || !result.snapshot.available) return neutralMutationFailure();
  const snapshot = result.snapshot;
  const headers = noStoreHeaders('application/json');
  headers.set(signalVersionHeaderName, result.version);
  return noStoreJson({
    state: snapshot.state,
    ...('retryAfterMs' in snapshot ? { retryAfterMs: snapshot.retryAfterMs } : {}),
  }, 200, headers);
}
