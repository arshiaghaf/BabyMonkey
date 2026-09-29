import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  consumeInitialEnrollment,
  consumeReplacementEnrollment,
  createInvitation,
  resetPrincipalAuthorization,
} from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('same-invitation concurrency', () => {
  it('commits at most one complete winner and no losing-path state', async () => {
    const tokenHash = hash('a');
    expect(await createInvitation(db, {
      invitationId: 'concurrent_same_invitation',
      tokenHash,
      slot: 1,
      purpose: 'initial',
      createdAtMs: 100,
      expiresAtMs: 1_000,
    })).toBe(true);

    const attempts = await Promise.all([
      consumeInitialEnrollment(db, {
        tokenHash,
        slot: 1,
        purpose: 'initial',
        principalId: 'concurrent_principal_a',
        credential: {
          identifier: bytes('concurrent-credential-a'),
          verificationMaterial: bytes('verification-a'),
        },
        nowMs: 200,
      }),
      consumeInitialEnrollment(db, {
        tokenHash,
        slot: 1,
        purpose: 'initial',
        principalId: 'concurrent_principal_b',
        credential: {
          identifier: bytes('concurrent-credential-b'),
          verificationMaterial: bytes('verification-b'),
        },
        nowMs: 200,
      }),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);

    const state = await env.TEST_DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM principals) AS principals,
        (SELECT COUNT(*) FROM credentials) AS credentials,
        (SELECT COUNT(*) FROM invitations WHERE consumed_at_ms IS NOT NULL) AS consumed,
        (SELECT COUNT(*) FROM transaction_assertions) AS assertions
    `).first();
    expect(state).toEqual({ principals: 1, credentials: 1, consumed: 1, assertions: 0 });

    const credential = await env.TEST_DB.prepare(
      'SELECT CAST(credential_identifier AS TEXT) AS identifier FROM credentials WHERE principal_slot = 1',
    ).first<string>('identifier');
    expect(credential).not.toBeNull();
    expect(['concurrent-credential-a', 'concurrent-credential-b']).toContain(credential);

    const principalId = await env.TEST_DB.prepare(
      'SELECT principal_id FROM principals WHERE slot = 1',
    ).first<string>('principal_id');
    expect(await resetPrincipalAuthorization(db, 1, 300)).toBe(true);
    const replacementHash = hash('c');
    expect(await createInvitation(db, {
      invitationId: 'concurrent_same_replacement',
      tokenHash: replacementHash,
      slot: 1,
      purpose: 'replacement',
      createdAtMs: 301,
      expiresAtMs: 1_000,
    })).toBe(true);
    const replacementAttempts = await Promise.all([
      consumeReplacementEnrollment(db, {
        tokenHash: replacementHash,
        slot: 1,
        purpose: 'replacement',
        credential: {
          identifier: bytes('replacement-concurrent-a'),
          verificationMaterial: bytes('replacement-verification-a'),
        },
        nowMs: 400,
      }),
      consumeReplacementEnrollment(db, {
        tokenHash: replacementHash,
        slot: 1,
        purpose: 'replacement',
        credential: {
          identifier: bytes('replacement-concurrent-b'),
          verificationMaterial: bytes('replacement-verification-b'),
        },
        nowMs: 400,
      }),
    ]);
    expect(replacementAttempts.filter(Boolean)).toHaveLength(1);
    expect(await env.TEST_DB.prepare(`
      SELECT p.principal_id, p.authorization_generation,
             COUNT(c.principal_slot) AS credential_count
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = 1
      GROUP BY p.slot
    `).first()).toEqual({
      principal_id: principalId,
      authorization_generation: 2,
      credential_count: 1,
    });
  });
});
