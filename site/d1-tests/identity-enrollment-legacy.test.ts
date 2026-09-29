import { describe, expect, it } from 'vitest';

import { commitVerifiedEnrollment, readActiveCredentialByIdentifier, reserveInvitationForEnrollment } from '@/server/d1/identity-repository';
import { consumeReplacementEnrollment, createInvitation, resetPrincipalAuthorization } from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('identity and legacy repository compatibility', () => {
  it('resets counter and transports when the preserved replacement export wins', async () => {
    const principalId = 'K'.repeat(43);
    expect(await createInvitation(db, { invitationId: 'legacy_compat_initial', tokenHash: hash('c'), slot: 1, purpose: 'initial', createdAtMs: 100, expiresAtMs: 10_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('c'), enrollmentClaimHash: hash('d'), initialPrincipalId: principalId, nowMs: 200, pendingExpiresAtMs: 5_000 })).toBe(true);
    expect(await commitVerifiedEnrollment(db, {
      invitationId: 'legacy_compat_initial', enrollmentClaimHash: hash('d'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('legacy-old-credential'), verificationMaterial: bytes('legacy-old-key'),
      signatureCounter: 42, transports: ['hybrid', 'internal'], nowMs: 300,
    })).toEqual({
      state: 'committed',
      authorizationGeneration: 1,
      signatureCounter: 42,
    });
    expect(await resetPrincipalAuthorization(db, 1, 400)).toBe(true);
    expect(await createInvitation(db, { invitationId: 'legacy_compat_replacement', tokenHash: hash('0'), slot: 1, purpose: 'replacement', createdAtMs: 500, expiresAtMs: 10_000 })).toBe(true);
    expect(await consumeReplacementEnrollment(db, {
      tokenHash: hash('0'), slot: 1, purpose: 'replacement',
      credential: { identifier: bytes('legacy-new-credential'), verificationMaterial: bytes('legacy-new-key') },
      nowMs: 600,
    })).toBe(true);
    expect(await readActiveCredentialByIdentifier(db, bytes('legacy-new-credential'))).toMatchObject({ signatureCounter: 0, transports: undefined });
  });
});
