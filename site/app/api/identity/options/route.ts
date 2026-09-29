import {
  cleanupExpiredWebAuthnChallenges,
  replaceAuthenticationChallenge,
  replaceRegistrationChallenge,
  resolveEnrollmentClaim,
} from '@/server/d1/identity-repository';
import {
  appendExpiredCookie,
  ceremonyFlowCookieName,
  enrollmentCookieName,
  hashOpaqueCookie,
  readFlowCookie,
  requestCsrfMatches,
} from '@/server/identity/cookies';
import { encodeBase64url, randomBytes, sha256Hex } from '@/server/identity/crypto';
import {
  hasExactKeys,
  hasExactMutationEnvelope,
  neutralMutationFailure,
  noStoreHeaders,
  readBoundedJsonObject,
} from '@/server/identity/request';
import { getIdentityDatabase, getWebAuthnRuntimeConfig } from '@/server/identity/runtime';
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  webAuthnChallengeLifetimeMs,
} from '@/server/identity/webauthn';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const config = getWebAuthnRuntimeConfig();
  if (!hasExactMutationEnvelope(request, config)) return neutralMutationFailure();
  const flow = readFlowCookie(request, ceremonyFlowCookieName);
  if (!flow || !requestCsrfMatches(request, flow.csrfToken)) {
    return neutralMutationFailure();
  }
  const body = await readBoundedJsonObject(request, 32);
  if (!body || !hasExactKeys(body, [])) return neutralMutationFailure();
  const db = getIdentityDatabase();
  if (!db) return neutralMutationFailure(503);

  const nowMs = Date.now();
  await cleanupExpiredWebAuthnChallenges(db, nowMs, 32);
  const ownerHash = await sha256Hex(flow.flowIdentifier);
  const csrfHash = await sha256Hex(flow.csrfToken);
  const enrollmentClaimHash = await hashOpaqueCookie(request, enrollmentCookieName);
  const enrollment = enrollmentClaimHash
    ? await resolveEnrollmentClaim(db, enrollmentClaimHash, nowMs)
    : { state: 'unavailable' as const };
  const challenge = randomBytes(32);
  const challengeHash = await sha256Hex(encodeBase64url(challenge));
  const expiresAtMs = nowMs + webAuthnChallengeLifetimeMs;
  const headers = noStoreHeaders('application/json');

  if (enrollment.state === 'pending' && enrollmentClaimHash) {
    const options = await createRegistrationOptions(
      config,
      enrollment.principalId,
      challenge,
    );
    if (!options) return neutralMutationFailure();
    const stored = await replaceRegistrationChallenge(db, {
      challengeHash,
      ownerHash,
      csrfHash,
      invitationId: enrollment.invitationId,
      enrollmentClaimHash,
      candidatePrincipalId: enrollment.principalId,
      createdAtMs: nowMs,
      expiresAtMs,
    });
    return stored
      ? new Response(JSON.stringify({ ceremony: 'registration', options }), { headers })
      : neutralMutationFailure();
  }

  if (enrollmentClaimHash) appendExpiredCookie(headers, enrollmentCookieName);
  const options = await createAuthenticationOptions(config, challenge);
  if (!options) return neutralMutationFailure();
  const stored = await replaceAuthenticationChallenge(db, {
    challengeHash,
    ownerHash,
    csrfHash,
    createdAtMs: nowMs,
    expiresAtMs,
  });
  return stored
    ? new Response(JSON.stringify({ ceremony: 'authentication', options }), { headers })
    : neutralMutationFailure();
}
