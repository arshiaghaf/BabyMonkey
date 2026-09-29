import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  advancePrincipalGeneration,
  clearOperationalState,
  consumeInitialEnrollment,
  consumeReplacementEnrollment,
  createInvitation,
  createSession,
  reserveOperationalState,
  resetPrincipalAuthorization,
  revokePrincipalSessions,
  revokeSession,
  settleOperationalState,
  validateInvitationEligibility,
  validateSession,
} from '@/server/d1/repository';
import { bytes, db, enroll, hash } from './helpers';

describe('principal, replacement, generation, and session lifecycle', () => {
  it('preserves stable identity and isolates every selected-slot transition', async () => {
    const first = await enroll(1, 'a');
    const second = await enroll(2, 'b');
    const sessionOne = hash('c');
    const sessionTwo = hash('d');
    expect(await createSession(db, {
      sessionHash: sessionOne,
      slot: 1,
      createdAtMs: 2_000,
      expiresAtMs: 20_000,
    })).toBe(true);
    expect(await createSession(db, {
      sessionHash: sessionTwo,
      slot: 2,
      createdAtMs: 2_000,
      expiresAtMs: 20_000,
    })).toBe(true);
    expect(await validateSession(db, sessionOne, 3_000)).toBe(true);
    expect(await validateSession(db, sessionTwo, 3_000)).toBe(true);

    expect(await resetPrincipalAuthorization(db, 1, 4_000)).toBe(true);
    expect(await resetPrincipalAuthorization(db, 1, 4_001)).toBe(false);
    expect(await validateSession(db, sessionOne, 4_002)).toBe(false);
    expect(await validateSession(db, sessionTwo, 4_002)).toBe(true);
    expect(await createSession(db, {
      sessionHash: hash('e'),
      slot: 1,
      createdAtMs: 4_002,
      expiresAtMs: 20_000,
    })).toBe(false);

    const resetState = await env.TEST_DB.prepare(`
      SELECT p.principal_id, p.authorization_generation, p.authorization_state,
             c.authorization_state AS credential_state
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = 1
    `).first();
    expect(resetState).toEqual({
      principal_id: first.principalId,
      authorization_generation: 1,
      authorization_state: 'reset',
      credential_state: 'revoked',
    });

    const replacementOne = hash('e');
    const staleSibling = hash('f');
    for (const [invitationId, tokenHash] of [
      ['replacement_invitation_e', replacementOne],
      ['replacement_invitation_f', staleSibling],
    ] as const) {
      expect(await createInvitation(db, {
        invitationId,
        tokenHash,
        slot: 1,
        purpose: 'replacement',
        createdAtMs: 4_100,
        expiresAtMs: 10_000,
      })).toBe(true);
    }
    expect(await validateInvitationEligibility(db, {
      tokenHash: replacementOne,
      slot: 1,
      purpose: 'initial',
      nowMs: 4_200,
    })).toEqual({ eligible: false });
    expect(await consumeInitialEnrollment(db, {
      tokenHash: replacementOne,
      slot: 1,
      purpose: 'initial',
      principalId: 'replacement_must_not_create',
      credential: {
        identifier: bytes('misused-credential'),
        verificationMaterial: bytes('misused-verification'),
      },
      nowMs: 4_200,
    })).toBe(false);
    expect(await consumeReplacementEnrollment(db, {
      tokenHash: replacementOne,
      slot: 1,
      purpose: 'replacement',
      credential: {
        identifier: bytes('replacement-credential'),
        verificationMaterial: bytes('replacement-verification'),
      },
      nowMs: 4_201,
    })).toBe(true);

    const replaced = await env.TEST_DB.prepare(`
      SELECT p.principal_id, p.authorization_generation,
             c.activated_generation,
             CAST(c.credential_identifier AS TEXT) AS credential_identifier
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = 1
    `).first<{
      principal_id: string;
      authorization_generation: number;
      activated_generation: number;
      credential_identifier: string;
    }>();
    expect(replaced?.principal_id).toBe(first.principalId);
    expect(replaced?.authorization_generation).toBe(2);
    expect(replaced?.activated_generation).toBe(2);
    expect(replaced?.credential_identifier).toBe('replacement-credential');
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM credentials',
    ).first<number>('count')).toBe(2);

    expect(await resetPrincipalAuthorization(db, 1, 5_000)).toBe(true);
    expect(await validateInvitationEligibility(db, {
      tokenHash: staleSibling,
      slot: 1,
      purpose: 'replacement',
      nowMs: 5_001,
    })).toEqual({ eligible: false });

    const replacementTwo = hash('9');
    expect(await createInvitation(db, {
      invitationId: 'replacement_invitation_9',
      tokenHash: replacementTwo,
      slot: 1,
      purpose: 'replacement',
      createdAtMs: 5_001,
      expiresAtMs: 10_000,
    })).toBe(true);
    expect(await consumeReplacementEnrollment(db, {
      tokenHash: replacementTwo,
      slot: 1,
      purpose: 'replacement',
      credential: {
        identifier: bytes('replacement-credential-two'),
        verificationMaterial: bytes('replacement-verification-two'),
      },
      nowMs: 5_002,
    })).toBe(true);

    const generationBefore = await env.TEST_DB.prepare(
      'SELECT authorization_generation FROM principals WHERE slot = 1',
    ).first<number>('authorization_generation');
    expect(generationBefore).toBe(3);
    const staleReservationHash = hash('7');
    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 3,
      idempotencyHash: staleReservationHash,
      nowMs: 5_500,
      expiresAtMs: 6_500,
      cooldownUntilMs: 7_000,
    })).toBe(true);
    expect(await Promise.all([
      advancePrincipalGeneration(db, 1, 6_000),
      advancePrincipalGeneration(db, 1, 6_001),
    ])).toEqual([true, true]);
    const generationAfter = await env.TEST_DB.prepare(
      'SELECT authorization_generation FROM principals WHERE slot = 1',
    ).first<number>('authorization_generation');
    expect(generationAfter).toBe(5);
    expect(await settleOperationalState(
      db,
      1,
      3,
      staleReservationHash,
    )).toBe(false);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations WHERE principal_slot = 1',
    ).first<number>('count')).toBe(0);
    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 3,
      idempotencyHash: hash('6'),
      nowMs: 6_100,
      expiresAtMs: 6_500,
      cooldownUntilMs: 7_000,
    })).toBe(false);
    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 5,
      idempotencyHash: staleReservationHash,
      nowMs: 6_100,
      expiresAtMs: 6_500,
      cooldownUntilMs: 7_000,
    })).toBe(true);
    expect(await clearOperationalState(
      db,
      1,
      3,
      staleReservationHash,
    )).toBe(false);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations WHERE principal_slot = 1',
    ).first<number>('count')).toBe(1);
    expect(await clearOperationalState(
      db,
      1,
      5,
      staleReservationHash,
    )).toBe(true);
    await expect(env.TEST_DB.prepare(
      'UPDATE principals SET authorization_generation = 4 WHERE slot = 1',
    ).run()).rejects.toThrow();

    const newSession = hash('8');
    expect(await createSession(db, {
      sessionHash: newSession,
      slot: 1,
      createdAtMs: 7_000,
      expiresAtMs: 20_000,
    })).toBe(true);
    expect(await revokeSession(db, newSession, 7_100)).toBe(true);
    expect(await revokeSession(db, newSession, 7_101)).toBe(false);
    await expect(env.TEST_DB.prepare(
      'UPDATE sessions SET revoked_at_ms = NULL WHERE session_hash = ?1',
    ).bind(newSession).run()).rejects.toThrow();
    expect(await validateSession(db, newSession, 7_200)).toBe(false);
    expect(await revokePrincipalSessions(db, 2, 7_300)).toEqual({
      confirmed: true,
      revoked: 1,
    });
    expect(await validateSession(db, sessionTwo, 7_301)).toBe(false);

    const otherPrincipal = await env.TEST_DB.prepare(`
      SELECT p.principal_id, p.authorization_generation, p.authorization_state,
             c.authorization_state AS credential_state
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = 2
    `).first();
    expect(otherPrincipal).toEqual({
      principal_id: second.principalId,
      authorization_generation: 1,
      authorization_state: 'active',
      credential_state: 'active',
    });
  });
});
