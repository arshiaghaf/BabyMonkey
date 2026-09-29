import { describe, expect, it } from 'vitest';

import {
  commitVerifiedEnrollment,
  issueIdentitySession,
  reserveInvitationForEnrollment,
  resolveSessionAuthority,
} from '@/server/d1/identity-repository';
import {
  advancePrincipalGeneration,
  createInvitation,
} from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('enrollment session generation binding', () => {
  it('cannot issue the first session after a later generation advance', async () => {
    const principalId = 'R'.repeat(43);
    expect(await createInvitation(db, {
      invitationId: 'enrollment_session_generation_race',
      tokenHash: hash('a'),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 10_000,
    })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, {
      tokenHash: hash('a'),
      enrollmentClaimHash: hash('b'),
      initialPrincipalId: principalId,
      nowMs: 200,
      pendingExpiresAtMs: 5_000,
    })).toBe(true);
    const committed = await commitVerifiedEnrollment(db, {
      invitationId: 'enrollment_session_generation_race',
      enrollmentClaimHash: hash('b'),
      candidatePrincipalId: principalId,
      credentialIdentifier: bytes('enrollment-session-race-credential'),
      verificationMaterial: bytes('enrollment-session-race-key'),
      signatureCounter: 0,
      nowMs: 300,
    });
    expect(committed).toEqual({
      state: 'committed',
      authorizationGeneration: 1,
      signatureCounter: 0,
    });

    expect(await advancePrincipalGeneration(db, 1, 400)).toBe(true);
    if (committed.state !== 'committed') throw new Error('Enrollment did not commit.');
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('enrollment-session-race-credential'),
      principalId,
      expectedAuthorizationGeneration: committed.authorizationGeneration,
      expectedCounter: committed.signatureCounter,
      sessionHash: hash('c'),
      sessionCsrfHash: hash('d'),
      nowMs: 500,
      sessionExpiresAtMs: 9_000,
    })).toBe(false);
    await expect(resolveSessionAuthority(db, hash('c'), 501)).resolves.toEqual({
      authorized: false,
    });
  });
});
