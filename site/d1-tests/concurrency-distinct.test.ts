import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  consumeInitialEnrollment,
  consumeReplacementEnrollment,
  createInvitation,
  resetPrincipalAuthorization,
} from '@/server/d1/repository';
import { bytes, db, hash } from './helpers';

describe('distinct-slot concurrency', () => {
  it('allows both isolated slots without crossing bindings', async () => {
    const invitations = [
      createInvitation(db, {
        invitationId: 'distinct_invitation_a',
        tokenHash: hash('a'),
        slot: 1,
        purpose: 'initial',
        createdAtMs: 100,
        expiresAtMs: 1_000,
      }),
      createInvitation(db, {
        invitationId: 'distinct_invitation_b',
        tokenHash: hash('b'),
        slot: 2,
        purpose: 'initial',
        createdAtMs: 100,
        expiresAtMs: 1_000,
      }),
    ];
    expect(await Promise.all(invitations)).toEqual([true, true]);

    const enrollments = await Promise.all([
      consumeInitialEnrollment(db, {
        tokenHash: hash('a'),
        slot: 1,
        purpose: 'initial',
        principalId: 'distinct_principal_a',
        credential: {
          identifier: bytes('credential-a'),
          verificationMaterial: bytes('verification-a'),
        },
        nowMs: 200,
      }),
      consumeInitialEnrollment(db, {
        tokenHash: hash('b'),
        slot: 2,
        purpose: 'initial',
        principalId: 'distinct_principal_b',
        credential: {
          identifier: bytes('credential-b'),
          verificationMaterial: bytes('verification-b'),
        },
        nowMs: 200,
      }),
    ]);
    expect(enrollments).toEqual([true, true]);

    const rows = await env.TEST_DB.prepare(`
      SELECT p.slot, p.principal_id, CAST(c.credential_identifier AS TEXT)
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      ORDER BY p.slot
    `).raw();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]).toBe(1);
    expect(rows[0]?.[1]).toBe('distinct_principal_a');
    expect(rows[0]?.[2]).toBe('credential-a');
    expect(rows[1]?.[0]).toBe(2);
    expect(rows[1]?.[1]).toBe('distinct_principal_b');
    expect(rows[1]?.[2]).toBe('credential-b');

    expect(await Promise.all([
      resetPrincipalAuthorization(db, 1, 300),
      resetPrincipalAuthorization(db, 2, 300),
    ])).toEqual([true, true]);
    const replacementA = hash('c');
    const replacementB = hash('d');
    expect(await Promise.all([
      createInvitation(db, {
        invitationId: 'distinct_replacement_a',
        tokenHash: replacementA,
        slot: 1,
        purpose: 'replacement',
        createdAtMs: 301,
        expiresAtMs: 1_000,
      }),
      createInvitation(db, {
        invitationId: 'distinct_replacement_b',
        tokenHash: replacementB,
        slot: 2,
        purpose: 'replacement',
        createdAtMs: 301,
        expiresAtMs: 1_000,
      }),
    ])).toEqual([true, true]);
    expect(await Promise.all([
      consumeReplacementEnrollment(db, {
        tokenHash: replacementA,
        slot: 1,
        purpose: 'replacement',
        credential: {
          identifier: bytes('replacement-a'),
          verificationMaterial: bytes('replacement-verification-a'),
        },
        nowMs: 400,
      }),
      consumeReplacementEnrollment(db, {
        tokenHash: replacementB,
        slot: 2,
        purpose: 'replacement',
        credential: {
          identifier: bytes('replacement-b'),
          verificationMaterial: bytes('replacement-verification-b'),
        },
        nowMs: 400,
      }),
    ])).toEqual([true, true]);
    expect(await env.TEST_DB.prepare(`
      SELECT COUNT(*) AS count
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.authorization_generation = 2
        AND c.activated_generation = 2
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
    `).first<number>('count')).toBe(2);
  });
});
