import { describe, expect, it } from 'vitest';

import {
  cleanupExpiredWebAuthnChallenges,
  consumeWebAuthnChallenge,
  replaceAuthenticationChallenge,
  replaceRegistrationChallenge,
  reserveInvitationForEnrollment,
  resolveEnrollmentClaim,
} from '@/server/d1/identity-repository';
import { createInvitation } from '@/server/d1/repository';
import { db, hash } from './helpers';

const principalId = 'A'.repeat(43);

describe('bounded identity challenges', () => {
  it('resolves invitation authority only from D1 and consumes each submitted challenge once', async () => {
    expect(await createInvitation(db, {
      invitationId: 'identity_invitation_0001',
      tokenHash: hash('a'),
      slot: 2,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 10_000,
    })).toBe(true);

    expect(await reserveInvitationForEnrollment(db, {
      tokenHash: hash('a'),
      enrollmentClaimHash: hash('b'),
      initialPrincipalId: principalId,
      nowMs: 200,
      pendingExpiresAtMs: 2_000,
    })).toBe(true);
    await expect(resolveEnrollmentClaim(db, hash('b'), 201)).resolves.toEqual({
      state: 'pending',
      invitationId: 'identity_invitation_0001',
      principalId,
    });

    expect(await replaceRegistrationChallenge(db, {
      challengeHash: hash('c'),
      ownerHash: hash('d'),
      csrfHash: hash('e'),
      invitationId: 'identity_invitation_0001',
      enrollmentClaimHash: hash('b'),
      candidatePrincipalId: principalId,
      createdAtMs: 300,
      expiresAtMs: 900,
    })).toBe(true);

    expect(await replaceRegistrationChallenge(db, {
      challengeHash: hash('f'),
      ownerHash: hash('0'),
      csrfHash: hash('9'),
      invitationId: 'identity_invitation_0001',
      enrollmentClaimHash: hash('b'),
      candidatePrincipalId: principalId,
      createdAtMs: 301,
      expiresAtMs: 901,
    })).toBe(true);

    await expect(consumeWebAuthnChallenge(db, {
      ownerHash: hash('d'),
      csrfHash: hash('e'),
      nowMs: 400,
    })).resolves.toBeNull();
    await expect(consumeWebAuthnChallenge(db, {
      ownerHash: hash('0'),
      csrfHash: hash('9'),
      nowMs: 400,
    })).resolves.toEqual({
      ceremony: 'registration',
      challengeHash: hash('f'),
      invitationId: 'identity_invitation_0001',
      enrollmentClaimHash: hash('b'),
      candidatePrincipalId: principalId,
    });
    await expect(consumeWebAuthnChallenge(db, {
      ownerHash: hash('0'),
      csrfHash: hash('9'),
      nowMs: 401,
    })).resolves.toBeNull();

    expect(await replaceAuthenticationChallenge(db, {
      challengeHash: hash('1'),
      ownerHash: hash('2'),
      csrfHash: hash('3'),
      createdAtMs: 500,
      expiresAtMs: 600,
    })).toBe(true);
    await expect(consumeWebAuthnChallenge(db, {
      ownerHash: hash('2'),
      csrfHash: hash('3'),
      nowMs: 600,
    })).resolves.toBeNull();
    await expect(cleanupExpiredWebAuthnChallenges(db, 600, 10)).resolves.toBe(1);
  });

  it('allows only one concurrent reservation of the same invitation', async () => {
    expect(await createInvitation(db, {
      invitationId: 'identity_invitation_0002',
      tokenHash: hash('4'),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 1_000,
      expiresAtMs: 8_000,
    })).toBe(true);

    const results = await Promise.all([
      reserveInvitationForEnrollment(db, {
        tokenHash: hash('4'),
        enrollmentClaimHash: hash('5'),
        initialPrincipalId: 'B'.repeat(43),
        nowMs: 1_100,
        pendingExpiresAtMs: 2_100,
      }),
      reserveInvitationForEnrollment(db, {
        tokenHash: hash('4'),
        enrollmentClaimHash: hash('6'),
        initialPrincipalId: 'C'.repeat(43),
        nowMs: 1_100,
        pendingExpiresAtMs: 2_100,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('caps live challenge state and recovers after expiry', async () => {
    const indexedHash = (prefix: string, index: number) =>
      `${prefix}${index.toString(16).padStart(63, '0')}`;

    const authenticationResults = await Promise.all(
      Array.from({ length: 64 }, (_, index) => replaceAuthenticationChallenge(db, {
        challengeHash: indexedHash('a', index),
        ownerHash: indexedHash('b', index),
        csrfHash: indexedHash('c', index),
        createdAtMs: 100,
        expiresAtMs: 200,
      })),
    );
    expect(authenticationResults.every(Boolean)).toBe(true);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM webauthn_challenges
      WHERE ceremony_type = 'authentication'
    `).first<number>('count')).toBe(64);

    expect(await createInvitation(db, {
      invitationId: 'identity_invitation_bound_0003',
      tokenHash: hash('7'),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 10,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await reserveInvitationForEnrollment(db, {
      tokenHash: hash('7'),
      enrollmentClaimHash: hash('8'),
      initialPrincipalId: principalId,
      nowMs: 20,
      pendingExpiresAtMs: 500,
    })).toBe(true);
    expect(await replaceRegistrationChallenge(db, {
      challengeHash: hash('6'),
      ownerHash: hash('5'),
      csrfHash: hash('4'),
      invitationId: 'identity_invitation_bound_0003',
      enrollmentClaimHash: hash('8'),
      candidatePrincipalId: principalId,
      createdAtMs: 100,
      expiresAtMs: 200,
    })).toBe(true);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM webauthn_challenges
      WHERE ceremony_type = 'registration'
    `).first<number>('count')).toBe(1);

    expect(await replaceAuthenticationChallenge(db, {
      challengeHash: hash('d'),
      ownerHash: hash('e'),
      csrfHash: hash('f'),
      createdAtMs: 100,
      expiresAtMs: 200,
    })).toBe(true);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM webauthn_challenges
      WHERE ceremony_type = 'authentication'
    `).first<number>('count')).toBe(64);
    expect(await db.prepare(`
      SELECT COUNT(*) AS count
      FROM webauthn_challenges
      WHERE ceremony_type = 'registration'
    `).first<number>('count')).toBe(1);
    expect(await db.prepare(
      'SELECT COUNT(*) AS count FROM webauthn_challenges WHERE owner_hash = ?1',
    ).bind(indexedHash('b', 0)).first<number>('count')).toBe(0);
    expect(await db.prepare(
      'SELECT COUNT(*) AS count FROM webauthn_challenges WHERE owner_hash = ?1',
    ).bind(hash('e')).first<number>('count')).toBe(1);

    expect(await replaceAuthenticationChallenge(db, {
      challengeHash: hash('d'),
      ownerHash: hash('e'),
      csrfHash: hash('f'),
      createdAtMs: 200,
      expiresAtMs: 300,
    })).toBe(true);
    expect(await db.prepare(
      'SELECT COUNT(*) AS count FROM webauthn_challenges',
    ).first<number>('count')).toBe(1);
  });
});
