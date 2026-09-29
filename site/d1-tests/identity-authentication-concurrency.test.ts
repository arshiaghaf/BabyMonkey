import { describe, expect, it } from 'vitest';

import { acceptAuthenticationAndIssueSession, resolveSessionAuthority } from '@/server/d1/identity-repository';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('authentication counter concurrency', () => {
  it('permits one optimistic counter winner and no losing session', async () => {
    const principalId = 'H'.repeat(43);
    await enrollIdentity({ invitationId: 'authentication_enrollment_2', principalId, slot: 2, tokenHash: hash('5'), claimHash: hash('6'), sessionHash: hash('7'), csrfHash: hash('8'), credentialMarker: 'authentication-credential-2' });
    const attempts = await Promise.all([1, 2].map((newCounter) => acceptAuthenticationAndIssueSession(db, {
      credentialIdentifier: bytes('authentication-credential-2'), principalId,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, newCounter,
      sessionHash: hash(String(newCounter)),
      sessionCsrfHash: hash(String(newCounter + 2)), nowMs: 600, sessionExpiresAtMs: 12_000,
    })));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const authorities = await Promise.all([resolveSessionAuthority(db, hash('1'), 601), resolveSessionAuthority(db, hash('2'), 601)]);
    expect(authorities.filter((authority) => authority.authorized)).toHaveLength(1);
  });
});
