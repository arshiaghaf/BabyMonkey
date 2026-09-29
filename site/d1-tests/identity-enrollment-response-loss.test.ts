import { describe, expect, it } from 'vitest';

import {
  commitVerifiedEnrollment,
  issueIdentitySession,
  readActiveCredentialByIdentifier,
  reserveInvitationForEnrollment,
  resolveEnrollmentClaim,
} from '@/server/d1/identity-repository';
import { createInvitation, resetPrincipalAuthorization } from '@/server/d1/repository';
import type { D1DatabaseLike } from '@/server/d1/types';
import { bytes, db, hash } from './helpers';

describe('enrollment response loss', () => {
  it('keeps committed identity final when its response or first session is lost', async () => {
    const principalId = 'F'.repeat(43);
    expect(await createInvitation(db, { invitationId: 'response_loss_0001', tokenHash: hash('3'), slot: 2, purpose: 'initial', createdAtMs: 1_000, expiresAtMs: 20_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('3'), enrollmentClaimHash: hash('4'), initialPrincipalId: principalId, nowMs: 1_100, pendingExpiresAtMs: 5_000 })).toBe(true);
    const responseLossDb: D1DatabaseLike = {
      prepare: (query) => db.prepare(query),
      batch: async (statements) => { await db.batch(statements); throw new Error('synthetic response loss after commit'); },
    };
    await expect(commitVerifiedEnrollment(responseLossDb, {
      invitationId: 'response_loss_0001', enrollmentClaimHash: hash('4'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('credential-response-loss'), verificationMaterial: bytes('public-key-response-loss'),
      signatureCounter: 0, nowMs: 1_200,
    })).resolves.toEqual({
      state: 'committed',
      authorizationGeneration: 1,
      signatureCounter: 0,
    });
    await expect(issueIdentitySession(db, {
      credentialIdentifier: bytes('credential-response-loss'), principalId, expectedAuthorizationGeneration: 1,
      expectedCounter: 0, sessionHash: hash('5'), sessionCsrfHash: hash('6'), nowMs: 1_201,
      sessionExpiresAtMs: 1_201,
    })).resolves.toBe(false);
    await expect(resolveEnrollmentClaim(db, hash('4'), 1_202)).resolves.toEqual({ state: 'committed' });
    expect(await readActiveCredentialByIdentifier(db, bytes('credential-response-loss'))).toMatchObject({ principalId, authorizationGeneration: 1 });
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('credential-response-loss'), principalId, expectedAuthorizationGeneration: 1,
      expectedCounter: 0, sessionHash: hash('5'), sessionCsrfHash: hash('6'), nowMs: 1_203,
      sessionExpiresAtMs: 9_000,
    })).toBe(true);

    expect(await resetPrincipalAuthorization(db, 2, 1_300)).toBe(true);
    expect(await createInvitation(db, { invitationId: 'response_loss_replacement', tokenHash: hash('7'), slot: 2, purpose: 'replacement', createdAtMs: 1_400, expiresAtMs: 20_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('7'), enrollmentClaimHash: hash('8'), initialPrincipalId: 'unused'.padEnd(43, '_'), nowMs: 1_500, pendingExpiresAtMs: 5_000 })).toBe(true);
    await expect(commitVerifiedEnrollment(responseLossDb, {
      invitationId: 'response_loss_replacement', enrollmentClaimHash: hash('8'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('credential-response-loss-replaced'), verificationMaterial: bytes('public-key-response-loss-replaced'),
      signatureCounter: 0, nowMs: 1_600,
    })).resolves.toEqual({
      state: 'committed',
      authorizationGeneration: 2,
      signatureCounter: 0,
    });
    expect(await readActiveCredentialByIdentifier(db, bytes('credential-response-loss-replaced'))).toMatchObject({ principalId, authorizationGeneration: 2 });
  });
});
