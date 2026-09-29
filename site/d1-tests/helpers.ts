import { env } from 'cloudflare:workers';

import {
  commitVerifiedEnrollment,
  issueIdentitySession,
  reserveInvitationForEnrollment,
} from '@/server/d1/identity-repository';
import {
  consumeInitialEnrollment,
  createInvitation,
} from '@/server/d1/repository';
import type { D1DatabaseLike, PrincipalSlot } from '@/server/d1/types';

export const db = env.TEST_DB as unknown as D1DatabaseLike;

export const hash = (character: string) => character.repeat(64);

export const bytes = (value: string) => new TextEncoder().encode(value);

export async function enrollIdentity(input: {
  invitationId: string;
  principalId: string;
  slot: PrincipalSlot;
  tokenHash: string;
  claimHash: string;
  sessionHash: string;
  csrfHash: string;
  credentialMarker: string;
  sessionExpiresAtMs?: number;
}) {
  if (!await createInvitation(db, {
    invitationId: input.invitationId,
    tokenHash: input.tokenHash,
    slot: input.slot,
    purpose: 'initial',
    createdAtMs: 100,
    expiresAtMs: 20_000,
  })) throw new Error('Synthetic identity invitation was not created.');
  if (!await reserveInvitationForEnrollment(db, {
    tokenHash: input.tokenHash,
    enrollmentClaimHash: input.claimHash,
    initialPrincipalId: input.principalId,
    nowMs: 200,
    pendingExpiresAtMs: 5_000,
  })) throw new Error('Synthetic identity invitation was not reserved.');
  const commit = await commitVerifiedEnrollment(db, {
    invitationId: input.invitationId,
    enrollmentClaimHash: input.claimHash,
    candidatePrincipalId: input.principalId,
    credentialIdentifier: bytes(input.credentialMarker),
    verificationMaterial: bytes(`${input.credentialMarker}-public-key`),
    signatureCounter: 0,
    nowMs: 300,
  });
  if (commit.state !== 'committed') {
    throw new Error('Synthetic identity enrollment was not committed.');
  }
  if (!await issueIdentitySession(db, {
    credentialIdentifier: bytes(input.credentialMarker),
    principalId: input.principalId,
    expectedAuthorizationGeneration: 1,
    expectedCounter: 0,
    sessionHash: input.sessionHash,
    sessionCsrfHash: input.csrfHash,
    nowMs: 301,
    sessionExpiresAtMs: input.sessionExpiresAtMs ?? 10_000,
  })) throw new Error('Synthetic identity session was not issued.');
}

export async function enroll(
  slot: PrincipalSlot,
  marker: string,
  nowMs = 1_000,
) {
  const tokenHash = hash(marker);
  const invitationId = `invitation_${slot}_${marker.repeat(8)}`;
  const principalId = `principal_${slot}_${marker.repeat(8)}`;
  const created = await createInvitation(db, {
    invitationId,
    tokenHash,
    slot,
    purpose: 'initial',
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 10_000,
  });
  if (!created) throw new Error('Synthetic initial invitation was not created.');

  const consumed = await consumeInitialEnrollment(db, {
    tokenHash,
    slot,
    purpose: 'initial',
    principalId,
    credential: {
      identifier: bytes(`credential-${slot}-${marker}`),
      verificationMaterial: bytes(`verification-${slot}-${marker}`),
    },
    nowMs: nowMs + 1,
  });
  if (!consumed) throw new Error('Synthetic initial enrollment was not consumed.');
  return { tokenHash, invitationId, principalId };
}
