import { describe, expect, it } from 'vitest';

import { acceptAuthenticationAndIssueSession, resolveSessionAuthority } from '@/server/d1/identity-repository';
import { advancePrincipalGeneration } from '@/server/d1/repository';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('authentication counter and generation checks', () => {
  it('rejects counter regression and a stale authorization-generation snapshot', async () => {
    await expect(acceptAuthenticationAndIssueSession(db, {
      credentialIdentifier: bytes('counter-regression'), principalId: 'Z'.repeat(43),
      expectedAuthorizationGeneration: 1, expectedCounter: 7, newCounter: 7,
      sessionHash: hash('9'), sessionCsrfHash: hash('a'),
      nowMs: 100, sessionExpiresAtMs: 200,
    })).resolves.toBe(false);
    const principalId = 'Y'.repeat(43);
    await enrollIdentity({ invitationId: 'authentication_generation_race', principalId, slot: 1, tokenHash: hash('0'), claimHash: hash('1'), sessionHash: hash('2'), csrfHash: hash('3'), credentialMarker: 'authentication-generation-race' });
    expect(await advancePrincipalGeneration(db, 1, 400)).toBe(true);
    expect(await acceptAuthenticationAndIssueSession(db, {
      credentialIdentifier: bytes('authentication-generation-race'), principalId,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, newCounter: 1,
      sessionHash: hash('4'), sessionCsrfHash: hash('5'),
      nowMs: 500, sessionExpiresAtMs: 12_000,
    })).toBe(false);
    await expect(resolveSessionAuthority(db, hash('4'), 501)).resolves.toEqual({ authorized: false });
  });
});
