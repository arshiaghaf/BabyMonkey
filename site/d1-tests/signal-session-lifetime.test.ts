import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { signalCooldownMs } from '@/lib/signal-timing';
import { issueIdentitySession, revokeIdentitySession } from '@/server/d1/identity-repository';
import { setNotificationState } from '@/server/d1/repository';
import type { FixedDeliveryBoundary } from '@/server/signal/delivery-boundary';
import { submitProtectedSignal } from '@/server/signal/service';
import { bytes, db, enrollIdentity, hash } from './helpers';

describe('signal state across source-session lifetime', () => {
  it('preserves pending and confirmed cooldown state for other principal sessions', async () => {
    const signingOutSource = { sessionHash: hash('0'), csrfHash: hash('1') };
    await enrollIdentity({
      invitationId: 'signal-signout-invitation',
      principalId: 'A'.repeat(43),
      slot: 1,
      tokenHash: hash('4'),
      claimHash: hash('5'),
      ...signingOutSource,
      credentialMarker: 'signal-signout-credential',
      sessionExpiresAtMs: 100_000,
    });
    const signoutOther = { sessionHash: hash('2'), csrfHash: hash('3') };
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('signal-signout-credential'),
      principalId: 'A'.repeat(43),
      expectedAuthorizationGeneration: 1,
      expectedCounter: 0,
      sessionHash: signoutOther.sessionHash,
      sessionCsrfHash: signoutOther.csrfHash,
      nowMs: 302,
      sessionExpiresAtMs: 100_000,
    })).toBe(true);

    const expiringSource = { sessionHash: hash('6'), csrfHash: hash('7') };
    await enrollIdentity({
      invitationId: 'signal-expiry-invitation',
      principalId: 'B'.repeat(43),
      slot: 2,
      tokenHash: hash('8'),
      claimHash: hash('9'),
      ...expiringSource,
      credentialMarker: 'signal-expiry-credential',
      sessionExpiresAtMs: 1_000,
    });
    const expiryOther = { sessionHash: hash('a'), csrfHash: hash('b') };
    expect(await issueIdentitySession(db, {
      credentialIdentifier: bytes('signal-expiry-credential'),
      principalId: 'B'.repeat(43),
      expectedAuthorizationGeneration: 1,
      expectedCounter: 0,
      sessionHash: expiryOther.sessionHash,
      sessionCsrfHash: expiryOther.csrfHash,
      nowMs: 302,
      sessionExpiresAtMs: 100_000,
    })).toBe(true);
    expect(await setNotificationState(db, {
      enabled: true,
      expectedRevision: 1,
      updatedAtMs: 350,
    })).toBe(true);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pendingDeliveryCount = 0;
    const pendingDelivery = vi.fn(async () => {
      pendingDeliveryCount += 1;
      if (pendingDeliveryCount === 1) await held;
      return pendingDeliveryCount === 1
        ? 'confirmed' as const
        : 'definitive-failure' as const;
    });
    const pendingBoundary: FixedDeliveryBoundary = { deliver: pendingDelivery };
    const sourceSubmission = submitProtectedSignal(db, {
      ...signingOutSource,
      attempt: 'source-session-attempt',
      expectedVersion: null,
      now: () => 400,
    }, pendingBoundary);
    await vi.waitFor(() => expect(pendingDelivery).toHaveBeenCalledTimes(1));

    expect(await revokeIdentitySession(db, {
      ...signingOutSource,
      revokedAtMs: 401,
    })).toBe(true);
    expect(await env.TEST_DB.prepare(
      'SELECT COUNT(*) AS count FROM operational_reservations WHERE principal_slot = 1',
    ).first<number>('count')).toBe(1);
    await expect(submitProtectedSignal(db, {
      ...signoutOther,
      attempt: 'other-session-attempt',
      expectedVersion: null,
      now: () => 402,
    }, pendingBoundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'pending', retryAfterMs: 9_998 },
    });
    expect(pendingDelivery).toHaveBeenCalledTimes(1);

    release();
    await expect(sourceSubmission).resolves.toEqual({ accepted: false });
    await expect(submitProtectedSignal(db, {
      ...signoutOther,
      attempt: 'other-session-attempt',
      expectedVersion: null,
      now: () => 10_400,
    }, pendingBoundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: signalCooldownMs },
    });
    expect(pendingDelivery).toHaveBeenCalledTimes(1);

    const confirmedDelivery = vi.fn(async () => 'confirmed' as const);
    const confirmedBoundary: FixedDeliveryBoundary = { deliver: confirmedDelivery };
    const confirmed = await submitProtectedSignal(db, {
      ...expiringSource,
      attempt: 'confirmed-before-expiry',
      expectedVersion: null,
      now: () => 900,
    }, confirmedBoundary);
    expect(confirmed).toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });
    if (!confirmed.accepted) throw new Error('Synthetic confirmed attempt was rejected.');
    await expect(submitProtectedSignal(db, {
      ...expiryOther,
      attempt: 'during-expired-source-cooldown',
      expectedVersion: null,
      now: () => 1_001,
    }, confirmedBoundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'cooldown', retryAfterMs: signalCooldownMs - 101 },
    });
    expect(confirmedDelivery).toHaveBeenCalledTimes(1);

    await expect(submitProtectedSignal(db, {
      ...expiryOther,
      attempt: 'after-expired-source-cooldown',
      expectedVersion: confirmed.version,
      now: () => 900 + signalCooldownMs,
    }, confirmedBoundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });
    expect(confirmedDelivery).toHaveBeenCalledTimes(2);
  });
});
