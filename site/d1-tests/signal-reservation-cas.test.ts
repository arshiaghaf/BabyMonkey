import { describe, expect, it } from 'vitest';

import { issueIdentitySession } from '@/server/d1/identity-repository';
import {
  readSignalSnapshot,
  reserveSignalAttempt,
  settleSignalAttempt,
  settleUninvokedSignalAttempt,
} from '@/server/d1/signal-repository';
import { setNotificationState } from '@/server/d1/repository';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('signal reservation causal precondition', () => {
  it('rejects a stale parallel wave after fast failure but permits a fresh retry', async () => {
    const firstSession = { sessionHash: hash('0'), csrfHash: hash('1') };
    const secondSession = { sessionHash: hash('2'), csrfHash: hash('3') };
    const principalId = 'P'.repeat(43);
    await enrollIdentity({
      invitationId: 'signal-cas-invitation',
      principalId,
      slot: 1,
      tokenHash: hash('4'),
      claimHash: hash('5'),
      ...firstSession,
      credentialMarker: 'signal-cas-credential',
      sessionExpiresAtMs: 100_000,
    });
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('signal-cas-credential'),
      principalId,
      expectedAuthorizationGeneration: 1,
      expectedCounter: 0,
      sessionHash: secondSession.sessionHash,
      sessionCsrfHash: secondSession.csrfHash,
      nowMs: 302,
      sessionExpiresAtMs: 100_000,
    })).toBe(true);
    expect(await setNotificationState(db, {
      enabled: true,
      expectedRevision: 1,
      updatedAtMs: 350,
    })).toBe(true);

    const firstHash = hash('6');
    expect(await reserveSignalAttempt(db, {
      ...firstSession,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: firstHash,
      expectedVersion: null,
      nowMs: 400,
    })).toBe(true);
    expect(await settleSignalAttempt(db, {
      ...firstSession,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: firstHash,
      result: 'definitive-failure',
      nowMs: 401,
    })).toBe(true);

    expect(await reserveSignalAttempt(db, {
      ...secondSession,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: hash('7'),
      expectedVersion: null,
      nowMs: 400,
    })).toBe(false);
    const freshHash = hash('8');
    expect(await reserveSignalAttempt(db, {
      ...secondSession,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: freshHash,
      expectedVersion: firstHash,
      nowMs: 402,
    })).toBe(true);
    expect(await settleUninvokedSignalAttempt(db, {
      ...secondSession,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: freshHash,
      nowMs: 10_403,
    })).toBe(true);
    await expect(readSignalSnapshot(db, {
      sessionHash: secondSession.sessionHash,
      idempotencyHash: freshHash,
      nowMs: 10_404,
    })).resolves.toEqual({
      available: true,
      state: 'definitive-failure',
      retryAfterMs: 0,
    });

    const staleAuthorityHash = hash('9');
    expect(await reserveSignalAttempt(db, {
      ...secondSession,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: staleAuthorityHash,
      expectedVersion: freshHash,
      nowMs: 10_405,
    })).toBe(true);
    expect(await setNotificationState(db, {
      enabled: false,
      expectedRevision: 2,
      updatedAtMs: 10_406,
    })).toBe(true);
    expect(await settleUninvokedSignalAttempt(db, {
      ...secondSession,
      authorizationGeneration: 1,
      notificationRevision: 2,
      idempotencyHash: staleAuthorityHash,
      nowMs: 10_407,
    })).toBe(false);
  });
});
