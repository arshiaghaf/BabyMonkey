import { describe, expect, it } from 'vitest';

import { acceptAuthenticationAndIssueSession, resolveSessionAuthority } from '@/server/d1/identity-repository';
import type { D1DatabaseLike } from '@/server/d1/types';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('authentication response loss', () => {
  it('recognizes an atomic authentication commit after its response is lost', async () => {
    const principalId = 'X'.repeat(43);
    await enrollIdentity({ invitationId: 'authentication_response_loss', principalId, slot: 2, tokenHash: hash('b'), claimHash: hash('c'), sessionHash: hash('d'), csrfHash: hash('e'), credentialMarker: 'authentication-response-loss' });
    const responseLossDb: D1DatabaseLike = {
      prepare: (query) => db.prepare(query),
      batch: async (statements) => { await db.batch(statements); throw new Error('synthetic response loss after authentication commit'); },
    };
    await expect(acceptAuthenticationAndIssueSession(responseLossDb, {
      credentialIdentifier: bytes('authentication-response-loss'), principalId,
      expectedAuthorizationGeneration: 1, expectedCounter: 0, newCounter: 1,
      sessionHash: hash('f'), sessionCsrfHash: hash('0'),
      previousSessionHash: hash('d'), nowMs: 500, sessionExpiresAtMs: 12_000,
    })).resolves.toBe(true);
    await expect(resolveSessionAuthority(db, hash('d'), 501)).resolves.toEqual({ authorized: false });
    await expect(resolveSessionAuthority(db, hash('f'), 501)).resolves.toMatchObject({ authorized: true, authorizationGeneration: 1 });
  });
});
