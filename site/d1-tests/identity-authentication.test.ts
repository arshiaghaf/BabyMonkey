import { describe, expect, it } from 'vitest';

import {
  acceptAuthenticationAndIssueSession,
  resolveSessionAuthority,
  revokeIdentitySession,
} from '@/server/d1/identity-repository';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('atomic counter acceptance and opaque sessions', () => {
  it('accepts synchronized zero counters, rotates sessions, and confirms sign-out revocation', async () => {
    const principalId = 'G'.repeat(43);
    await enrollIdentity({ invitationId: 'authentication_enrollment_1', principalId, slot: 1, tokenHash: hash('a'), claimHash: hash('b'), sessionHash: hash('c'), csrfHash: hash('d'), credentialMarker: 'authentication-credential-1' });
    expect(await acceptAuthenticationAndIssueSession(db, {
      credentialIdentifier: bytes('authentication-credential-1'), principalId,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, newCounter: 0,
      sessionHash: hash('e'), sessionCsrfHash: hash('f'),
      previousSessionHash: hash('c'), nowMs: 400, sessionExpiresAtMs: 11_000,
    })).toBe(true);
    await expect(resolveSessionAuthority(db, hash('c'), 401)).resolves.toEqual({ authorized: false });
    await expect(resolveSessionAuthority(db, hash('e'), 401)).resolves.toMatchObject({ authorized: true, slot: 1 });
    expect(await revokeIdentitySession(db, { sessionHash: hash('e'), csrfHash: hash('f'), revokedAtMs: 500 })).toBe(true);
    await expect(resolveSessionAuthority(db, hash('e'), 501)).resolves.toEqual({ authorized: false });
    expect(await revokeIdentitySession(db, { sessionHash: hash('e'), csrfHash: hash('f'), revokedAtMs: 502 })).toBe(false);
  });
});
