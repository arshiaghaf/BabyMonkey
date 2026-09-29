import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {
  acceptAuthenticationAndIssueSession,
  commitVerifiedEnrollment,
  consumeWebAuthnChallenge,
  issueIdentitySession,
  readActiveCredentialByIdentifier,
} from '@/server/d1/identity-repository';
import {
  appendExpiredCookie,
  appendSessionCookies,
  ceremonyFlowCookieName,
  createOpaqueToken,
  enrollmentCookieName,
  hashOpaqueCookie,
  readFlowCookie,
  requestCsrfMatches,
  sessionCookieName,
  sessionLifetimeMs,
} from '@/server/identity/cookies';
import { decodeBase64url, sha256Hex } from '@/server/identity/crypto';
import { readSubmittedChallenge } from '@/server/identity/http';
import {
  hasExactKeys,
  hasExactMutationEnvelope,
  neutralMutationFailure,
  noStoreHeaders,
  readBoundedJsonObject,
} from '@/server/identity/request';
import { getIdentityDatabase, getWebAuthnRuntimeConfig } from '@/server/identity/runtime';
import {
  verifyAuthenticationCeremony,
  verifyRegistrationCeremony,
} from '@/server/identity/webauthn';

export const dynamic = 'force-dynamic';

const successfulResponse = (
  sessionIdentifier: string,
  csrfToken: string,
  expireEnrollment: boolean,
) => {
  const headers = noStoreHeaders('application/json');
  appendSessionCookies(headers, sessionIdentifier, csrfToken);
  appendExpiredCookie(headers, ceremonyFlowCookieName);
  if (expireEnrollment) appendExpiredCookie(headers, enrollmentCookieName);
  return new Response(JSON.stringify({ ok: true }), { headers });
};

export async function POST(request: Request) {
  const config = getWebAuthnRuntimeConfig();
  if (!hasExactMutationEnvelope(request, config)) return neutralMutationFailure();
  const flow = readFlowCookie(request, ceremonyFlowCookieName);
  if (!flow || !requestCsrfMatches(request, flow.csrfToken)) {
    return neutralMutationFailure();
  }
  const db = getIdentityDatabase();
  if (!db) return neutralMutationFailure();

  const consumed = await consumeWebAuthnChallenge(db, {
    ownerHash: await sha256Hex(flow.flowIdentifier),
    csrfHash: await sha256Hex(flow.csrfToken),
    nowMs: Date.now(),
  });
  if (!consumed) return neutralMutationFailure();
  const body = await readBoundedJsonObject(request);
  if (!body || !hasExactKeys(body, ['response'])) return neutralMutationFailure();
  const submittedChallengeHash = await readSubmittedChallenge(body.response);
  if (!submittedChallengeHash || submittedChallengeHash !== consumed.challengeHash) {
    return neutralMutationFailure();
  }

  const session = await createOpaqueToken();
  const sessionCsrf = await createOpaqueToken();
  const previousSessionHash = await hashOpaqueCookie(request, sessionCookieName) ?? undefined;
  const nowMs = Date.now();

  if (consumed.ceremony === 'registration') {
    const enrollmentClaimHash = await hashOpaqueCookie(request, enrollmentCookieName);
    if (enrollmentClaimHash !== consumed.enrollmentClaimHash) {
      return neutralMutationFailure();
    }
    const verified = await verifyRegistrationCeremony({
      config,
      response: body.response as RegistrationResponseJSON,
      challengeHash: consumed.challengeHash,
    });
    if (!verified) return neutralMutationFailure();
    const committed = await commitVerifiedEnrollment(db, {
      invitationId: consumed.invitationId,
      enrollmentClaimHash: consumed.enrollmentClaimHash,
      candidatePrincipalId: consumed.candidatePrincipalId,
      credentialIdentifier: verified.credentialIdentifier,
      verificationMaterial: verified.verificationMaterial,
      signatureCounter: verified.signatureCounter,
      transports: verified.transports,
      nowMs,
    });
    if (committed.state !== 'committed') return neutralMutationFailure();
    const issued = await issueIdentitySession(db, {
      credentialIdentifier: verified.credentialIdentifier,
      principalId: consumed.candidatePrincipalId,
      expectedAuthorizationGeneration: committed.authorizationGeneration,
      expectedCounter: committed.signatureCounter,
      sessionHash: session.hash,
      sessionCsrfHash: sessionCsrf.hash,
      previousSessionHash,
      nowMs,
      sessionExpiresAtMs: nowMs + sessionLifetimeMs,
    });
    return issued
      ? successfulResponse(session.raw, sessionCsrf.raw, true)
      : neutralMutationFailure();
  }

  const response = body.response as AuthenticationResponseJSON;
  const credentialIdentifier = typeof response?.id === 'string'
    ? decodeBase64url(response.id)
    : null;
  if (!credentialIdentifier || credentialIdentifier.byteLength > 4096) {
    return neutralMutationFailure();
  }
  const credential = await readActiveCredentialByIdentifier(db, credentialIdentifier);
  if (!credential) return neutralMutationFailure();
  const verified = await verifyAuthenticationCeremony({
    config,
    response,
    challengeHash: consumed.challengeHash,
    credential,
  });
  if (!verified) return neutralMutationFailure();
  const accepted = await acceptAuthenticationAndIssueSession(db, {
    credentialIdentifier,
    principalId: credential.principalId,
    expectedAuthorizationGeneration: credential.authorizationGeneration,
    expectedCounter: credential.signatureCounter,
    newCounter: verified.newCounter,
    sessionHash: session.hash,
    sessionCsrfHash: sessionCsrf.hash,
    previousSessionHash,
    nowMs,
    sessionExpiresAtMs: nowMs + sessionLifetimeMs,
  });
  if (!accepted) return neutralMutationFailure();
  const completed = successfulResponse(session.raw, sessionCsrf.raw, true);
  return completed;
}
