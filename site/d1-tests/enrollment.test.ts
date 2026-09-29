import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  consumeInitialEnrollment,
  createInvitation,
  resetPrincipalAuthorization,
  revokeInvitation,
  validateInvitationEligibility,
} from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('invitation and initial enrollment rules', () => {
  it('enforces purpose, binding, lifecycle, cardinality, and credential uniqueness', async () => {
    expect(await validateInvitationEligibility(db, {
      tokenHash: 'not-a-hash',
      slot: 1,
      purpose: 'initial',
      nowMs: 100,
    })).toEqual({ eligible: false });

    const expiredHash = hash('a');
    expect(await createInvitation(db, {
      invitationId: 'expired_invitation_a',
      tokenHash: expiredHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 200,
    })).toBe(true);
    expect(await validateInvitationEligibility(db, {
      tokenHash: expiredHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 200,
    })).toEqual({ eligible: false });

    const revokedHash = hash('b');
    expect(await createInvitation(db, {
      invitationId: 'revoked_invitation_b',
      tokenHash: revokedHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await revokeInvitation(db, revokedHash, 150)).toBe(true);
    expect(await validateInvitationEligibility(db, {
      tokenHash: revokedHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 160,
    })).toEqual({ eligible: false });

    const initialHash = hash('c');
    expect(await createInvitation(db, {
      invitationId: 'initial_invitation_c',
      tokenHash: initialHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await validateInvitationEligibility(db, {
      tokenHash: initialHash,
      slot: 2,
      purpose: 'initial',
      nowMs: 200,
    })).toEqual({ eligible: false });
    expect(await validateInvitationEligibility(db, {
      tokenHash: initialHash,
      slot: 1,
      purpose: 'replacement',
      nowMs: 200,
    })).toEqual({ eligible: false });
    expect(await consumeInitialEnrollment(db, {
      tokenHash: initialHash,
      slot: 1,
      purpose: 'initial',
      principalId: 'principal_slot_one_c',
      credential: {
        identifier: bytes('shared-credential'),
        verificationMaterial: bytes('verification-one'),
      },
      nowMs: 201,
    })).toBe(true);
    expect(await consumeInitialEnrollment(db, {
      tokenHash: initialHash,
      slot: 1,
      purpose: 'initial',
      principalId: 'losing_principal_one',
      credential: {
        identifier: bytes('losing-credential'),
        verificationMaterial: bytes('losing-verification'),
      },
      nowMs: 202,
    })).toBe(false);

    const secondHash = hash('d');
    expect(await createInvitation(db, {
      invitationId: 'initial_invitation_d',
      tokenHash: secondHash,
      slot: 2,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await consumeInitialEnrollment(db, {
      tokenHash: secondHash,
      slot: 2,
      purpose: 'initial',
      principalId: 'principal_slot_two_d',
      credential: {
        identifier: bytes('shared-credential'),
        verificationMaterial: bytes('verification-two'),
      },
      nowMs: 203,
    })).toBe(false);

    const secondInvitation = await env.TEST_DB.prepare(
      'SELECT consumed_at_ms FROM invitations WHERE token_hash = ?1',
    ).bind(secondHash).first();
    expect(secondInvitation).toEqual({ consumed_at_ms: null });
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM principals WHERE slot = 2',
    ).first<number>('count')).toBe(0);

    expect(await consumeInitialEnrollment(db, {
      tokenHash: secondHash,
      slot: 2,
      purpose: 'initial',
      principalId: 'principal_slot_two_d',
      credential: {
        identifier: bytes('distinct-credential'),
        verificationMaterial: bytes('verification-two'),
      },
      nowMs: 204,
    })).toBe(true);

    expect(await createInvitation(db, {
      invitationId: 'third_slot_attempt',
      tokenHash: hash('e'),
      slot: 3 as 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(false);
    await expect(env.TEST_DB.prepare(
      'INSERT INTO principal_slots (slot, ordinal) VALUES (3, 3)',
    ).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(
      'UPDATE principals SET authorization_generation = 0 WHERE slot = 1',
    ).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(
      'DELETE FROM principal_slots WHERE slot = 1',
    ).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(`
      INSERT INTO credentials (
        principal_slot, credential_identifier, verification_material,
        authorization_state, activated_generation, created_at_ms, updated_at_ms
      ) VALUES (
        1, x'99', x'98', 'active', 1, 250, 250
      )
    `).run()).rejects.toThrow();

    expect(await resetPrincipalAuthorization(db, 1, 300)).toBe(true);
    expect(await createInvitation(db, {
      invitationId: 'initial_on_reset_slot',
      tokenHash: hash('f'),
      slot: 1,
      purpose: 'initial',
      createdAtMs: 300,
      expiresAtMs: 1_000,
    })).toBe(false);

    const counts = await env.TEST_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM principals) AS principals,
        (SELECT COUNT(*) FROM credentials) AS credentials,
        (SELECT COUNT(*) FROM transaction_assertions) AS assertions
    `).first();
    expect(counts).toEqual({ principals: 2, credentials: 2, assertions: 0 });
  });
});
