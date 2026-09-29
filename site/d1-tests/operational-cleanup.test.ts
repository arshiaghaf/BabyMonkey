import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  cleanupExpiredState,
  clearOperationalState,
  createInvitation,
  createSession,
  reserveOperationalState,
  settleOperationalState,
} from '@/server/d1/repository';
import { db, enroll, hash } from './helpers';

describe('bounded operational coordination and cleanup', () => {
  it('keeps at most one overwritable row per slot and never removes authorization', async () => {
    expect(await createInvitation(db, {
      invitationId: 'expired_cleanup_invitation',
      tokenHash: hash('a'),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 10,
      expiresAtMs: 20,
    })).toBe(true);
    for (const [invitationId, tokenHash] of [
      ['expired_cleanup_invitation_two', hash('1')],
      ['expired_cleanup_invitation_three', hash('2')],
    ] as const) {
      expect(await createInvitation(db, {
        invitationId,
        tokenHash,
        slot: 1,
        purpose: 'initial',
        createdAtMs: 10,
        expiresAtMs: 20,
      })).toBe(true);
    }
    expect(await cleanupExpiredState(db, {
      nowMs: 50,
      terminalBeforeMs: 50,
      limit: 1,
    })).toEqual({ invitations: 1, sessions: 0, operationalReservations: 0 });
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM invitations WHERE expires_at_ms = 20',
    ).first<number>('count')).toBe(2);
    await enroll(1, 'b', 100);
    await enroll(2, 'c', 100);

    const expiredSession = hash('d');
    const activeSession = hash('e');
    expect(await createSession(db, {
      sessionHash: expiredSession,
      slot: 1,
      createdAtMs: 200,
      expiresAtMs: 300,
    })).toBe(true);
    expect(await createSession(db, {
      sessionHash: activeSession,
      slot: 2,
      createdAtMs: 200,
      expiresAtMs: 10_000,
    })).toBe(true);

    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 1,
      idempotencyHash: hash('f'),
      nowMs: 200,
      expiresAtMs: 250,
      cooldownUntilMs: 300,
    })).toBe(true);
    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 1,
      idempotencyHash: hash('9'),
      nowMs: 201,
      expiresAtMs: 251,
      cooldownUntilMs: 301,
    })).toBe(false);
    expect(await reserveOperationalState(db, {
      slot: 2,
      authorizationGeneration: 1,
      idempotencyHash: hash('8'),
      nowMs: 400,
      expiresAtMs: 500,
      cooldownUntilMs: 600,
    })).toBe(true);
    expect(await settleOperationalState(db, 2, 1, hash('8'))).toBe(true);
    expect(await settleOperationalState(db, 2, 1, hash('8'))).toBe(false);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations',
    ).first<number>('count')).toBe(2);

    const cleanup = await cleanupExpiredState(db, {
      nowMs: 400,
      terminalBeforeMs: 400,
      limit: 10,
    });
    expect(cleanup.invitations).toBeGreaterThanOrEqual(1);
    expect(cleanup.sessions).toBe(1);
    expect(cleanup.operationalReservations).toBe(1);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM principals',
    ).first<number>('count')).toBe(2);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM credentials',
    ).first<number>('count')).toBe(2);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE session_hash = ?1',
    ).bind(activeSession).first<number>('count')).toBe(1);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations WHERE principal_slot = 2',
    ).first<number>('count')).toBe(1);

    expect(await clearOperationalState(db, 2, 1, hash('f'))).toBe(false);
    expect(await clearOperationalState(db, 2, 1, hash('8'))).toBe(true);
    expect(await cleanupExpiredState(db, {
      nowMs: 1_000,
      terminalBeforeMs: 1_000,
      limit: 0,
    })).toEqual({ invitations: 0, sessions: 0, operationalReservations: 0 });

    const forbiddenTables = await env.TEST_DB.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table'
        AND (name LIKE '%signal%' OR name LIKE '%history%' OR name LIKE '%event%')
    `).all();
    expect(forbiddenTables.results).toEqual([]);
  });
});
