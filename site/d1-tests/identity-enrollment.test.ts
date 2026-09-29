import { describe, expect, it } from 'vitest';

import {
  commitVerifiedEnrollment,
  issueIdentitySession,
  readActiveCredentialByIdentifier,
  reserveInvitationForEnrollment,
  resolveEnrollmentClaim,
  resolveSessionAuthority,
} from '@/server/d1/identity-repository';
import { createInvitation, resetPrincipalAuthorization } from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('verified enrollment finality', () => {
  it('commits initial and replacement enrollment without changing the stable principal', async () => {
    const principalId = 'D'.repeat(43);
    expect(await createInvitation(db, { invitationId: 'verified_initial_0001', tokenHash: hash('a'), slot: 1, purpose: 'initial', createdAtMs: 100, expiresAtMs: 20_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('a'), enrollmentClaimHash: hash('b'), initialPrincipalId: principalId, nowMs: 200, pendingExpiresAtMs: 5_000 })).toBe(true);
    await expect(commitVerifiedEnrollment(db, {
      invitationId: 'verified_initial_0001', enrollmentClaimHash: hash('b'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('credential-initial'), verificationMaterial: bytes('public-key-initial'),
      signatureCounter: 7, transports: ['internal', 'hybrid', 'internal'], nowMs: 300,
    })).resolves.toEqual({
      state: 'committed',
      authorizationGeneration: 1,
      signatureCounter: 7,
    });
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('credential-initial'), principalId, expectedAuthorizationGeneration: 1,
      expectedCounter: 7, sessionHash: hash('c'), sessionCsrfHash: hash('d'), nowMs: 301,
      sessionExpiresAtMs: 9_000,
    })).toBe(true);
    await expect(resolveEnrollmentClaim(db, hash('b'), 301)).resolves.toEqual({ state: 'committed' });
    await expect(resolveSessionAuthority(db, hash('c'), 301)).resolves.toEqual({ authorized: true, slot: 1, authorizationGeneration: 1 });
    expect(await readActiveCredentialByIdentifier(db, bytes('credential-initial'))).toMatchObject({
      slot: 1, authorizationGeneration: 1, principalId, signatureCounter: 7,
      transports: ['hybrid', 'internal'],
    });

    expect(await resetPrincipalAuthorization(db, 1, 400)).toBe(true);
    expect(await createInvitation(db, { invitationId: 'verified_replace_0001', tokenHash: hash('e'), slot: 1, purpose: 'replacement', createdAtMs: 500, expiresAtMs: 20_000 })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, { tokenHash: hash('e'), enrollmentClaimHash: hash('f'), initialPrincipalId: 'E'.repeat(43), nowMs: 600, pendingExpiresAtMs: 5_000 })).toBe(true);
    await expect(resolveEnrollmentClaim(db, hash('f'), 601)).resolves.toEqual({ state: 'pending', invitationId: 'verified_replace_0001', principalId });
    await expect(commitVerifiedEnrollment(db, {
      invitationId: 'verified_replace_0001', enrollmentClaimHash: hash('f'), candidatePrincipalId: principalId,
      credentialIdentifier: bytes('credential-replaced'), verificationMaterial: bytes('public-key-replaced'),
      signatureCounter: 0, transports: ['internal'], nowMs: 700,
    })).resolves.toEqual({
      state: 'committed',
      authorizationGeneration: 2,
      signatureCounter: 0,
    });
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('credential-replaced'), principalId, expectedAuthorizationGeneration: 2,
      expectedCounter: 0, sessionHash: hash('1'), sessionCsrfHash: hash('2'),
      previousSessionHash: hash('c'), nowMs: 701, sessionExpiresAtMs: 10_000,
    })).toBe(true);
    expect(await readActiveCredentialByIdentifier(db, bytes('credential-initial'))).toBeNull();
    expect(await readActiveCredentialByIdentifier(db, bytes('credential-replaced'))).toMatchObject({ slot: 1, authorizationGeneration: 2, principalId, signatureCounter: 0 });
    await expect(resolveSessionAuthority(db, hash('c'), 701)).resolves.toEqual({ authorized: false });
    await expect(resolveSessionAuthority(db, hash('1'), 701)).resolves.toEqual({ authorized: true, slot: 1, authorizationGeneration: 2 });
  });
});
