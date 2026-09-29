import { describe, expect, it } from 'vitest';

import { commitVerifiedEnrollment, reserveInvitationForEnrollment } from '@/server/d1/identity-repository';
import { createInvitation } from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('same-invitation final commit concurrency', () => {
  it('allows exactly one identity commit for one claimed invitation', async () => {
    const principalId = 'J'.repeat(43);
    expect(await createInvitation(db, { invitationId: 'identity_commit_race', tokenHash: hash('b'), slot: 1, purpose: 'initial', createdAtMs: 100, expiresAtMs: 10_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('b'), enrollmentClaimHash: hash('c'), initialPrincipalId: principalId, nowMs: 200, pendingExpiresAtMs: 5_000 })).toBe(true);
    const attempts = await Promise.all(['one', 'two'].map((marker) => commitVerifiedEnrollment(db, {
      invitationId: 'identity_commit_race', enrollmentClaimHash: hash('c'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('identity-race-shared'), verificationMaterial: bytes(`identity-race-key-${marker}`),
      signatureCounter: 0, nowMs: 300,
    })));
    expect(attempts.filter(({ state }) => state === 'committed')).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM principals').first<number>('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM credentials').first<number>('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first<number>('count')).toBe(0);
  });
});
