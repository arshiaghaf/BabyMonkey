import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { signalCooldownMs } from '@/lib/signal-timing';
import { readSignalSnapshot, reserveSignalAttempt } from '@/server/d1/signal-repository';
import { issueIdentitySession, revokeIdentitySession } from '@/server/d1/identity-repository';
import { advancePrincipalGeneration, cleanupExpiredState, resetPrincipalAuthorization, revokePrincipalSessions, setNotificationState } from '@/server/d1/repository';
import type { FixedDeliveryBoundary } from '@/server/signal/delivery-boundary';
import { submitProtectedSignal } from '@/server/signal/service';
import { bytes, db, enrollIdentity, hash } from './helpers';

const setupPrincipal = async (slot: 1 | 2, marker: string) => {
  const sessionHash = hash(marker);
  const csrfHash = hash(slot === 1 ? 'e' : 'f');
  await enrollIdentity({
    invitationId: `signal-invitation-${slot}-${marker}`,
    principalId: marker.repeat(43),
    slot,
    tokenHash: hash(marker),
    claimHash: hash(marker),
    sessionHash,
    csrfHash,
    credentialMarker: `signal-credential-${slot}-${marker}`,
    sessionExpiresAtMs: 1_000_000,
  });
  return { sessionHash, csrfHash };
};

describe('protected signal state machine', () => {
  it('enforces authority, concurrency, replay, outcomes, cooldown, isolation, invalidation, and cleanup', async () => {
    expect(signalCooldownMs).toBe(15_000);
    const first = await setupPrincipal(1, '0');
    const second = await setupPrincipal(2, '1');
    const firstOtherSession = { sessionHash: hash('3'), csrfHash: hash('4') };
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('signal-credential-1-0'),
      principalId: '0'.repeat(43),
      expectedAuthorizationGeneration: 1,
      expectedCounter: 0,
      sessionHash: firstOtherSession.sessionHash,
      sessionCsrfHash: firstOtherSession.csrfHash,
      nowMs: 302,
      sessionExpiresAtMs: 1_000_000,
    })).toBe(true);
    expect(await setNotificationState(db, { enabled: true, expectedRevision: 1, updatedAtMs: 350 })).toBe(true);

    const deniedBoundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };
    await expect(submitProtectedSignal(db, {
      sessionHash: hash('2'), csrfHash: first.csrfHash,
      attempt: 'missing-session', expectedVersion: null, now: () => 375,
    }, deniedBoundary)).resolves.toEqual({ accepted: false });
    await expect(submitProtectedSignal(db, {
      sessionHash: first.sessionHash, csrfHash: second.csrfHash,
      attempt: 'copied-session', expectedVersion: null, now: () => 375,
    }, deniedBoundary)).resolves.toEqual({ accepted: false });
    await expect(submitProtectedSignal(db, {
      ...first, attempt: 'expired-session', expectedVersion: null,
      now: () => 1_000_000,
    }, deniedBoundary)).resolves.toEqual({ accepted: false });
    expect(deniedBoundary.deliver).not.toHaveBeenCalled();
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations',
    ).first<number>('count')).toBe(0);

    let nowMs = 400;
    const versions: Record<1 | 2, string | null> = { 1: null, 2: null };
    const submit = async (
      slot: 1 | 2,
      session: { sessionHash: string; csrfHash: string },
      attempt: string,
      boundary: FixedDeliveryBoundary,
      now: () => number = () => nowMs,
    ) => {
      const result = await submitProtectedSignal(db, {
        ...session,
        attempt,
        expectedVersion: versions[slot],
        now,
      }, boundary);
      if (result.accepted) versions[slot] = result.version;
      return result;
    };
    const outcomes = vi.fn()
      .mockResolvedValueOnce('confirmed')
      .mockResolvedValueOnce('definitive-failure')
      .mockResolvedValueOnce('ambiguous');
    const outcomeBoundary: FixedDeliveryBoundary = { deliver: outcomes };
    const submitFirst = (attempt: string) => submit(1, first, attempt, outcomeBoundary);

    await expect(submitFirst('first')).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });
    nowMs += 1;
    await expect(submitFirst('first')).resolves.toMatchObject({
      accepted: true,
      snapshot: { state: 'confirmed', retryAfterMs: signalCooldownMs - 1 },
    });
    await expect(submitFirst('different-during-cooldown')).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: signalCooldownMs - 1 },
    });
    expect(outcomes).toHaveBeenCalledTimes(1);

    nowMs = 400 + signalCooldownMs;
    await expect(submitFirst('definite')).resolves.toMatchObject({
      accepted: true,
      snapshot: { state: 'definitive-failure', retryAfterMs: 0 },
    });
    await expect(submitFirst('definite')).resolves.toMatchObject({
      accepted: true,
      snapshot: { state: 'definitive-failure' },
    });
    await expect(submit(1, firstOtherSession, 'definite', outcomeBoundary))
      .resolves.toMatchObject({
        accepted: true,
        snapshot: { state: 'definitive-failure' },
      });
    expect(outcomes).toHaveBeenCalledTimes(2);
    await expect(submitFirst('fresh-retry')).resolves.toMatchObject({
      accepted: true,
      snapshot: { state: 'ambiguous', retryAfterMs: signalCooldownMs },
    });
    expect(outcomes).toHaveBeenCalledTimes(3);

    nowMs = 130_000;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const concurrentDeliver = vi.fn(async () => { await held; return 'confirmed' as const; });
    const concurrentBoundary: FixedDeliveryBoundary = { deliver: concurrentDeliver };
    const concurrent = [
      submit(1, first, 'session-one', concurrentBoundary),
      submit(1, firstOtherSession, 'session-two', concurrentBoundary),
    ];
    await vi.waitFor(() => expect(concurrentDeliver).toHaveBeenCalledTimes(1));
    release();
    const concurrentResults = await Promise.all(concurrent);
    expect(concurrentResults.every((result) => result.accepted)).toBe(true);
    expect(concurrentResults.map((result) => (
      result.accepted && result.snapshot.available ? result.snapshot.state : 'unavailable'
    )).sort())
      .toEqual(['confirmed', 'pending']);
    expect(concurrentDeliver).toHaveBeenCalledTimes(1);
    nowMs += 1;
    await expect(submit(
      1,
      firstOtherSession,
      'other-session-cooldown',
      concurrentBoundary,
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: signalCooldownMs - 1 },
    });
    expect(concurrentDeliver).toHaveBeenCalledTimes(1);

    nowMs = 200_000;
    const isolatedBoundary: FixedDeliveryBoundary = { deliver: vi.fn(async () => 'definitive-failure' as const) };
    await expect(Promise.all([
      submit(1, first, 'slot-one', isolatedBoundary),
      submit(2, second, 'slot-two', isolatedBoundary),
    ])).resolves.toHaveLength(2);
    expect(isolatedBoundary.deliver).toHaveBeenCalledTimes(2);
    expect(await env.TEST_DB.prepare('SELECT COUNT(*) AS count FROM operational_reservations').first<number>('count')).toBe(2);
    await expect(revokeIdentitySession(db, {
      sessionHash: first.sessionHash,
      csrfHash: second.csrfHash,
      revokedAtMs: nowMs + 1,
    })).resolves.toBe(false);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations',
    ).first<number>('count')).toBe(2);

    const unresolvedHash = hash('9');
    expect(await reserveSignalAttempt(db, {
      ...first, slot: 1, authorizationGeneration: 1, notificationRevision: 2,
      idempotencyHash: unresolvedHash, expectedVersion: versions[1], nowMs: 210_000,
    })).toBe(true);
    versions[1] = unresolvedHash;
    await expect(readSignalSnapshot(db, {
      sessionHash: first.sessionHash, idempotencyHash: unresolvedHash, nowMs: 220_000,
    })).resolves.toEqual({ available: true, state: 'ambiguous', retryAfterMs: signalCooldownMs });
    await expect(readSignalSnapshot(db, {
      sessionHash: first.sessionHash, idempotencyHash: hash('8'), nowMs: 220_000,
    })).resolves.toEqual({ available: true, state: 'cooldown', retryAfterMs: signalCooldownMs });

    const lateTimes = [280_000, 280_000, 280_000, 290_001];
    let lateTimeIndex = 0;
    const lateBoundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };
    await expect(submit(
      2,
      second,
      'late-result',
      lateBoundary,
      () => lateTimes[Math.min(lateTimeIndex++, lateTimes.length - 1)],
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'ambiguous', retryAfterMs: signalCooldownMs - 1 },
    });
    expect(await env.TEST_DB.prepare(`
      SELECT cooldown_until_ms AS cooldownUntilMs
      FROM operational_reservations WHERE principal_slot = 2
    `).first<number>('cooldownUntilMs')).toBe(305_000);
    await expect(submit(
      2,
      second,
      'late-cooldown',
      lateBoundary,
      () => 304_999,
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: 1 },
    });
    expect(lateBoundary.deliver).toHaveBeenCalledTimes(1);

    nowMs = 360_000;
    let releaseDisabled!: () => void;
    const disabledHold = new Promise<void>((resolve) => { releaseDisabled = resolve; });
    const disableBoundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => { await disabledHold; return 'confirmed' as const; }),
    };
    const pendingDisable = submit(1, first, 'disable-race', disableBoundary);
    await vi.waitFor(() => expect(disableBoundary.deliver).toHaveBeenCalledTimes(1));
    expect(await setNotificationState(db, { enabled: false, expectedRevision: 2, updatedAtMs: ++nowMs })).toBe(true);
    expect(await setNotificationState(db, { enabled: true, expectedRevision: 3, updatedAtMs: ++nowMs })).toBe(true);
    await expect(submit(
      1,
      firstOtherSession,
      'new-revision-while-prior-work-is-live',
      disableBoundary,
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'pending', retryAfterMs: 9_998 },
    });
    expect(disableBoundary.deliver).toHaveBeenCalledTimes(1);
    releaseDisabled();
    await expect(pendingDisable).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'pending', retryAfterMs: 9_998 },
    });
    nowMs = 370_000;
    await expect(submit(
      1,
      firstOtherSession,
      'new-revision-during-prior-cooldown',
      disableBoundary,
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: signalCooldownMs },
    });
    expect(disableBoundary.deliver).toHaveBeenCalledTimes(1);
    nowMs = 385_000;
    await expect(submit(
      1,
      firstOtherSession,
      'new-revision-after-prior-cooldown',
      disableBoundary,
    )).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });
    expect(disableBoundary.deliver).toHaveBeenCalledTimes(2);

    expect(await revokePrincipalSessions(db, 1, ++nowMs)).toMatchObject({ confirmed: true });
    const revokedBoundary = { deliver: vi.fn(async () => 'confirmed' as const) };
    await expect(submit(
      1,
      first,
      'revoked',
      revokedBoundary,
      () => ++nowMs,
    )).resolves.toEqual({ accepted: false });
    expect(revokedBoundary.deliver).not.toHaveBeenCalled();

    expect(await advancePrincipalGeneration(db, 2, ++nowMs)).toBe(true);
    const staleBoundary = { deliver: vi.fn(async () => 'confirmed' as const) };
    await expect(submit(
      2,
      second,
      'stale-generation',
      staleBoundary,
      () => ++nowMs,
    )).resolves.toEqual({ accepted: false });
    expect(staleBoundary.deliver).not.toHaveBeenCalled();
    expect(await resetPrincipalAuthorization(db, 2, ++nowMs)).toBe(true);

    await cleanupExpiredState(db, { nowMs: 500_000, terminalBeforeMs: 500_000, limit: 10 });
    expect(await env.TEST_DB.prepare('SELECT COUNT(*) AS count FROM principals').first<number>('count')).toBe(2);
    expect(await env.TEST_DB.prepare('SELECT COUNT(*) AS count FROM credentials').first<number>('count')).toBe(2);
    expect(await env.TEST_DB.prepare('SELECT COUNT(*) AS count FROM operational_reservations').first<number>('count')).toBeLessThanOrEqual(2);
    const forbidden = await env.TEST_DB.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND (name LIKE '%signal%' OR name LIKE '%event%' OR name LIKE '%history%')
    `).all();
    expect(forbidden.results).toEqual([]);
  });
});
