import {
  appendEnrollmentCookie,
  appendExpiredCookie,
  createOpaqueToken,
  invitationBootstrapCookieName,
  readFlowCookie,
  requestCsrfMatches,
} from '@/server/identity/cookies';
import { decodeBase64url, encodeBase64url, randomBytes, sha256Hex } from '@/server/identity/crypto';
import { reserveInvitationForEnrollment } from '@/server/d1/identity-repository';
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
  const bootstrap = readFlowCookie(request, invitationBootstrapCookieName);
  if (!bootstrap || !requestCsrfMatches(request, bootstrap.csrfToken)) {
    return neutralMutationFailure();
  }
  const body = await readBoundedJsonObject(request, 256);
  if (!body || !hasExactKeys(body, ['token']) || typeof body.token !== 'string') {
    return neutralMutationFailure();
  }
  const tokenBytes = decodeBase64url(body.token);
  if (body.token.length !== 43 || tokenBytes?.byteLength !== 32) {
    return neutralMutationFailure();
  }
  const db = getIdentityDatabase();
  if (!db) return neutralMutationFailure(503);

  const enrollment = await createOpaqueToken();
  const accepted = await reserveInvitationForEnrollment(db, {
    tokenHash: await sha256Hex(body.token),
    enrollmentClaimHash: enrollment.hash,
    initialPrincipalId: encodeBase64url(randomBytes(32)),
    nowMs: Date.now(),
    pendingExpiresAtMs: Date.now() + 15 * 60 * 1000,
  });
  if (!accepted) return neutralMutationFailure();

  const headers = noStoreHeaders('application/json');
  appendEnrollmentCookie(headers, enrollment.raw);
  appendExpiredCookie(headers, invitationBootstrapCookieName);
  return new Response(JSON.stringify({ ok: true }), { headers });
}
