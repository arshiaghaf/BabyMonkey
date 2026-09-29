import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  clearInvitationPendingClaim,
  consumeInitialEnrollment,
  createInvitation,
  reserveInvitationPendingClaim,
  validateInvitationEligibility,
} from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('bounded invitation pending state', () => {
  it('is claim-bound, expiring, clearable, and consumed only by an eligible transition', async () => {
    const tokenHash = hash('a');
    const staleHash = hash('d');
    const firstClaim = hash('b');
    const secondClaim = hash('c');
    expect(await createInvitation(db, {
      invitationId: 'pending_invitation_a',
      tokenHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);
    expect(await createInvitation(db, {
      invitationId: 'pending_stale_sibling',
      tokenHash: staleHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);

    const reservations = await Promise.all([
      reserveInvitationPendingClaim(db, {
        tokenHash,
        slot: 1,
        purpose: 'initial',
        nowMs: 200,
        pendingClaimHash: firstClaim,
        pendingExpiresAtMs: 300,
      }),
      reserveInvitationPendingClaim(db, {
        tokenHash,
        slot: 1,
        purpose: 'initial',
        nowMs: 200,
        pendingClaimHash: secondClaim,
        pendingExpiresAtMs: 300,
      }),
    ]);
    expect(reservations.filter(Boolean)).toHaveLength(1);
    const winner = reservations[0] ? firstClaim : secondClaim;
    const loser = reservations[0] ? secondClaim : firstClaim;

    expect(await validateInvitationEligibility(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 201,
    })).toEqual({ eligible: false });
    expect(await validateInvitationEligibility(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 201,
      pendingClaimHash: loser,
    })).toEqual({ eligible: false });
    expect((await validateInvitationEligibility(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 201,
      pendingClaimHash: winner,
    })).eligible).toBe(true);
    expect(await clearInvitationPendingClaim(db, tokenHash, loser)).toBe(false);
    expect(await clearInvitationPendingClaim(db, tokenHash, winner)).toBe(true);

    expect(await reserveInvitationPendingClaim(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 220,
      pendingClaimHash: firstClaim,
      pendingExpiresAtMs: 230,
    })).toBe(true);
    expect(await reserveInvitationPendingClaim(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 231,
      pendingClaimHash: secondClaim,
      pendingExpiresAtMs: 300,
    })).toBe(true);
    expect(await consumeInitialEnrollment(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      principalId: 'pending_principal_a',
      pendingClaimHash: firstClaim,
      credential: {
        identifier: bytes('pending-credential-a'),
        verificationMaterial: bytes('pending-verification-a'),
      },
      nowMs: 240,
    })).toBe(false);
    expect(await consumeInitialEnrollment(db, {
      tokenHash,
      slot: 1,
      purpose: 'initial',
      principalId: 'pending_principal_a',
      pendingClaimHash: secondClaim,
      credential: {
        identifier: bytes('pending-credential-a'),
        verificationMaterial: bytes('pending-verification-a'),
      },
      nowMs: 240,
    })).toBe(true);

    expect(await env.TEST_DB.prepare(`
      SELECT consumed_at_ms, pending_claim_hash, pending_expires_at_ms,
        pending_principal_id
      FROM invitations WHERE token_hash = ?1
    `).bind(tokenHash).first()).toEqual({
      consumed_at_ms: 240,
      pending_claim_hash: null,
      pending_expires_at_ms: null,
      pending_principal_id: null,
    });
    expect(await reserveInvitationPendingClaim(db, {
      tokenHash: staleHash,
      slot: 1,
      purpose: 'initial',
      nowMs: 250,
      pendingClaimHash: hash('e'),
      pendingExpiresAtMs: 300,
    })).toBe(false);

    await expect(env.TEST_DB.prepare(`
      INSERT INTO invitations (
        invitation_id, token_hash, principal_slot, purpose,
        required_generation, created_at_ms, expires_at_ms
      ) VALUES ('malformed_invitation', 'bad', 2, 'initial', NULL, 1, 2)
    `).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(`
      INSERT INTO invitations (
        invitation_id, token_hash, principal_slot, purpose,
        required_generation, created_at_ms, expires_at_ms
      ) VALUES (
        'replacement_null_generation',
        '${hash('f')}', 2, 'replacement', NULL, 1, 1000
      )
    `).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(`
      INSERT INTO invitations (
        invitation_id, token_hash, principal_slot, purpose,
        required_generation, created_at_ms, expires_at_ms,
        pending_claim_hash, pending_expires_at_ms
      ) VALUES (
        'pending_null_expiry',
        '${hash('9')}', 2, 'initial', NULL, 1, 1000,
        '${hash('8')}', NULL
      )
    `).run()).rejects.toThrow();
    await expect(env.TEST_DB.prepare(`
      UPDATE invitations
      SET pending_claim_hash = ?2, pending_expires_at_ms = NULL
      WHERE token_hash = ?1
    `).bind(staleHash, hash('7')).run()).rejects.toThrow();
  });
});
