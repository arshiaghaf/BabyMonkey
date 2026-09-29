import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  consumeInitialEnrollment,
  consumeReplacementEnrollment,
  createInvitation,
  resetPrincipalAuthorization,
  revokePrincipalSessions,
  validateInvitationEligibility,
  validateSession,
} from '@/server/d1/repository';
import type { D1DatabaseLike } from '@/server/d1/types';
import { bytes, db, hash } from './helpers';

describe('transaction and database failure semantics', () => {
  it('rolls back pre-commit failure and fails closed on ambiguous or malformed results', async () => {
    const tokenHash = hash('a');
    expect(await createInvitation(db, {
      invitationId: 'rollback_invitation_a',
      tokenHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);

    await expect(env.TEST_DB.batch([
      env.TEST_DB.prepare(`
        INSERT INTO principals (
          slot, principal_id, credential_slot, authorization_generation,
          authorization_state, created_at_ms, updated_at_ms
        ) VALUES (1, 'rollback_principal_a', 1, 1, 'active', 200, 200)
      `),
      env.TEST_DB.prepare(`
        INSERT INTO credentials (
          principal_slot, credential_identifier, verification_material,
          authorization_state, activated_generation, created_at_ms, updated_at_ms
        ) VALUES (1, ?1, ?2, 'active', 1, 200, 200)
      `).bind(bytes('rollback-credential'), bytes('rollback-verification')),
      env.TEST_DB.prepare(`
        UPDATE invitations SET consumed_at_ms = 200 WHERE token_hash = ?1
      `).bind(tokenHash),
      env.TEST_DB.prepare(`
        INSERT INTO transaction_assertions (assertion_id, satisfied)
        VALUES ('forced_failure', 0)
      `),
    ])).rejects.toThrow();

    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM principals',
    ).first<number>('count')).toBe(0);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM credentials',
    ).first<number>('count')).toBe(0);
    expect(await env.TEST_DB.prepare(
      'SELECT consumed_at_ms FROM invitations WHERE token_hash = ?1',
    ).bind(tokenHash).first()).toEqual({ consumed_at_ms: null });

    const responseLossDb: D1DatabaseLike = {
      prepare: (query) => db.prepare(query),
      batch: async (statements) => {
        await db.batch(statements);
        throw new Error('synthetic committed response loss');
      },
    };
    expect(await consumeInitialEnrollment(responseLossDb, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      principalId: 'response_loss_principal',
      credential: {
        identifier: bytes('response-loss-credential'),
        verificationMaterial: bytes('response-loss-verification'),
      },
      nowMs: 300,
    })).toBe(false);
    expect(await env.TEST_DB.prepare(`
      SELECT p.authorization_generation, p.authorization_state,
             c.authorization_state AS credential_state,
             i.consumed_at_ms
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      JOIN invitations AS i ON i.principal_slot = p.slot
      WHERE p.slot = 1 AND i.token_hash = ?1
    `).bind(tokenHash).first()).toEqual({
      authorization_generation: 1,
      authorization_state: 'active',
      credential_state: 'active',
      consumed_at_ms: 300,
    });

    expect(await resetPrincipalAuthorization(db, 1, 400)).toBe(true);
    const replacementHash = hash('b');
    expect(await createInvitation(db, {
      invitationId: 'response_loss_replacement',
      tokenHash: replacementHash,
      slot: 1,
      purpose: 'replacement',
      createdAtMs: 401,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await consumeReplacementEnrollment(responseLossDb, {
      tokenHash: replacementHash,
      slot: 1,
      purpose: 'replacement',
      credential: {
        identifier: bytes('response-loss-replacement'),
        verificationMaterial: bytes('response-loss-replacement-verification'),
      },
      nowMs: 500,
    })).toBe(false);
    expect(await env.TEST_DB.prepare(`
      SELECT p.authorization_generation, p.authorization_state,
             c.authorization_state AS credential_state,
             i.consumed_at_ms
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      JOIN invitations AS i ON i.principal_slot = p.slot
      WHERE p.slot = 1 AND i.token_hash = ?1
    `).bind(replacementHash).first()).toEqual({
      authorization_generation: 2,
      authorization_state: 'active',
      credential_state: 'active',
      consumed_at_ms: 500,
    });

    const malformedReadDb = {
      prepare: () => ({
        bind() { return this; },
        first: async () => ({ authorized: 'yes', invitationId: 123 }),
        run: async () => ({ success: true }),
      }),
      batch: async () => [],
    } as D1DatabaseLike;
    expect(await validateSession(malformedReadDb, hash('c'), 100)).toBe(false);
    expect(await validateInvitationEligibility(malformedReadDb, {
      tokenHash: hash('c'),
      slot: 1,
      purpose: 'initial',
      nowMs: 100,
    })).toEqual({ eligible: false });

    const failingDb = {
      prepare: () => {
        throw new Error('synthetic D1 read failure');
      },
      batch: async () => {
        throw new Error('synthetic D1 batch failure');
      },
    } as unknown as D1DatabaseLike;
    expect(await validateSession(failingDb, hash('d'), 100)).toBe(false);
    expect(await validateInvitationEligibility(failingDb, {
      tokenHash: hash('d'),
      slot: 1,
      purpose: 'initial',
      nowMs: 100,
    })).toEqual({ eligible: false });

    const confirmedNoOpDb = {
      prepare: () => ({
        bind() { return this; },
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
      batch: async () => [],
    } as unknown as D1DatabaseLike;
    expect(await revokePrincipalSessions(confirmedNoOpDb, 1, 100)).toEqual({
      confirmed: true,
      revoked: 0,
    });
    expect(await revokePrincipalSessions(malformedReadDb, 1, 100)).toEqual({
      confirmed: false,
    });
    expect(await revokePrincipalSessions(failingDb, 1, 100)).toEqual({
      confirmed: false,
    });
  });
});
