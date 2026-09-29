import { revokeIdentitySession } from '@/server/d1/identity-repository';
import {
  appendExpiredCookie,
  hashOpaqueCookie,
  readOpaqueCookie,
  requestCsrfMatches,
  sessionCookieName,
  sessionCsrfCookieName,
} from '@/server/identity/cookies';
import {
  hasExactKeys,
  hasExactMutationEnvelope,
  neutralMutationFailure,
  noStoreHeaders,
  readBoundedJsonObject,
} from '@/server/identity/request';
import { getIdentityDatabase, getWebAuthnRuntimeConfig } from '@/server/identity/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const config = getWebAuthnRuntimeConfig();
  if (!hasExactMutationEnvelope(request, config)) return neutralMutationFailure();
  const csrfToken = readOpaqueCookie(request, sessionCsrfCookieName);
  if (!csrfToken || !requestCsrfMatches(request, csrfToken)) {
    return neutralMutationFailure();
  }
  const body = await readBoundedJsonObject(request, 32);
  if (!body || !hasExactKeys(body, [])) return neutralMutationFailure();
  const sessionHash = await hashOpaqueCookie(request, sessionCookieName);
  const csrfHash = await hashOpaqueCookie(request, sessionCsrfCookieName);
  const db = getIdentityDatabase();
  if (!sessionHash || !csrfHash || !db) return neutralMutationFailure();
  const revoked = await revokeIdentitySession(db, {
    sessionHash,
    csrfHash,
    revokedAtMs: Date.now(),
  });
  if (!revoked) return neutralMutationFailure();
  const headers = noStoreHeaders('application/json');
  appendExpiredCookie(headers, sessionCookieName);
  appendExpiredCookie(headers, sessionCsrfCookieName);
  return new Response(JSON.stringify({ ok: true }), { headers });
}
