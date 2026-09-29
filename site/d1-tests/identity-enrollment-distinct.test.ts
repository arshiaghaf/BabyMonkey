import { describe, expect, it } from 'vitest';

import {
  commitVerifiedEnrollment,
  readActiveCredentialByIdentifier,
  reserveInvitationForEnrollment,
  resolveEnrollmentClaim,
} from '@/server/d1/identity-repository';
import { createInvitation, resetPrincipalAuthorization } from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('distinct invitations and pre-commit failure', () => {
  it('keeps invitations isolated and rolls back a confirmed failure', async () => {
    for (const [slot, marker] of [[1, 'd'], [2, 'e']] as const) {
      expect(await createInvitation(db, { invitationId: `identity_distinct_${slot}`, tokenHash: hash(marker), slot, purpose: 'initial', createdAtMs: 100, expiresAtMs: 10_000 })).toBe(true);
      expect(await reserveInvitationForEnrollment(db, { tokenHash: hash(marker), enrollmentClaimHash: hash(String(slot)), initialPrincipalId: marker.toUpperCase().repeat(43), nowMs: 200, pendingExpiresAtMs: 5_000 })).toBe(true);
    }
    const distinct = await Promise.all(([1, 2] as const).map((slot) => commitVerifiedEnrollment(db, {
      invitationId: `identity_distinct_${slot}`, enrollmentClaimHash: hash(String(slot)),
      candidatePrincipalId: (slot === 1 ? 'D' : 'E').repeat(43),
      credentialIdentifier: bytes(`identity-distinct-${slot}`), verificationMaterial: bytes(`identity-distinct-key-${slot}`),
      signatureCounter: 0, nowMs: 300,
    })));
    expect(distinct).toEqual([
      { state: 'committed', authorizationGeneration: 1, signatureCounter: 0 },
      { state: 'committed', authorizationGeneration: 1, signatureCounter: 0 },
    ]);

    expect(await resetPrincipalAuthorization(db, 2, 400)).toBe(true);
    expect(await createInvitation(db, { invitationId: 'identity_precommit_failure', tokenHash: hash('a'), slot: 2, purpose: 'replacement', createdAtMs: 500, expiresAtMs: 10_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('a'), enrollmentClaimHash: hash('0'), initialPrincipalId: 'unused'.padEnd(43, '_'), nowMs: 600, pendingExpiresAtMs: 5_000 })).toBe(true);
    await expect(commitVerifiedEnrollment(db, {
      invitationId: 'identity_precommit_failure', enrollmentClaimHash: hash('0'), candidatePrincipalId: 'E'.repeat(43),
      credentialIdentifier: bytes('identity-invalid-counter'), verificationMaterial: bytes('identity-invalid-counter-key'),
      signatureCounter: -1, nowMs: 700,
    })).resolves.toEqual({ state: 'not-committed' });
    await expect(resolveEnrollmentClaim(db, hash('0'), 701)).resolves.toMatchObject({ state: 'pending' });
    expect(await readActiveCredentialByIdentifier(db, bytes('identity-invalid-counter'))).toBeNull();
  });
});
