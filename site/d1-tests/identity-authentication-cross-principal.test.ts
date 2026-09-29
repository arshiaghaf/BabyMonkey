import { describe, expect, it } from 'vitest';

import { acceptAuthenticationAndIssueSession, issueIdentitySession, resolveSessionAuthority } from '@/server/d1/identity-repository';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('session rotation principal binding', () => {
  it('never revokes a prior cookie that belongs to the other principal', async () => {
    const firstPrincipal = 'V'.repeat(43);
    const secondPrincipal = 'W'.repeat(43);
    await enrollIdentity({ invitationId: 'cross_slot_first', principalId: firstPrincipal, slot: 1, tokenHash: hash('1'), claimHash: hash('2'), sessionHash: hash('3'), csrfHash: hash('4'), credentialMarker: 'cross-slot-first' });
    await enrollIdentity({ invitationId: 'cross_slot_second', principalId: secondPrincipal, slot: 2, tokenHash: hash('5'), claimHash: hash('6'), sessionHash: hash('7'), csrfHash: hash('8'), credentialMarker: 'cross-slot-second' });
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('cross-slot-second'), principalId: secondPrincipal,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, sessionHash: hash('9'),
      sessionCsrfHash: hash('a'), previousSessionHash: hash('3'), nowMs: 400,
      sessionExpiresAtMs: 12_000,
    })).toBe(true);
    await expect(resolveSessionAuthority(db, hash('3'), 401)).resolves.toMatchObject({ authorized: true, slot: 1 });
    expect(await acceptAuthenticationAndIssueSession(db, {
      credentialIdentifier: bytes('cross-slot-second'), principalId: secondPrincipal,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, newCounter: 1,
      sessionHash: hash('b'), sessionCsrfHash: hash('c'),
      previousSessionHash: hash('3'), nowMs: 500, sessionExpiresAtMs: 13_000,
    })).toBe(true);
    await expect(resolveSessionAuthority(db, hash('3'), 501)).resolves.toMatchObject({ authorized: true, slot: 1 });
  });
});
