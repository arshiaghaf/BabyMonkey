import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { signalCooldownMs } from '@/lib/signal-timing';
import {
  reserveOperationalState,
  setNotificationState,
  settleOperationalState,
} from '@/server/d1/repository';
import { readSignalSnapshot } from '@/server/d1/signal-repository';
import type { FixedDeliveryBoundary } from '@/server/signal/delivery-boundary';
import { submitProtectedSignal } from '@/server/signal/service';
import { db, enrollIdentity, hash } from './helpers';

describe('signal state compatibility with the landed operational repository', () => {
  it('preserves live reservations and reuses expired rows across both APIs', async () => {
    const session = { sessionHash: hash('0'), csrfHash: hash('1') };
    await enrollIdentity({
      invitationId: 'signal-legacy-compatibility-invitation',
      principalId: 'A'.repeat(43),
      slot: 1,
      tokenHash: hash('2'),
      claimHash: hash('3'),
      ...session,
      credentialMarker: 'signal-legacy-compatibility-credential',
      sessionExpiresAtMs: 100_000,
    });
    expect(await setNotificationState(db, {
      enabled: true,
      expectedRevision: 1,
      updatedAtMs: 350,
    })).toBe(true);

    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };
    await expect(submitProtectedSignal(db, {
      ...session,
      attempt: 'signal-owned-row',
      expectedVersion: null,
      now: () => 400,
    }, boundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });

    const legacyHash = hash('4');
    expect(await reserveOperationalState(db, {
      slot: 1,
      authorizationGeneration: 1,
      idempotencyHash: legacyHash,
      nowMs: 400 + signalCooldownMs,
      expiresAtMs: 1_400 + signalCooldownMs,
      cooldownUntilMs: 2_400 + signalCooldownMs,
    })).toBe(true);
    expect(await env.TEST_DB.prepare(`
      SELECT idempotency_hash, state, session_hash, notification_revision,
        delivery_state, settled_at_ms
      FROM operational_reservations
      WHERE principal_slot = 1
    `).first()).toEqual({
      idempotency_hash: legacyHash,
      state: 'reserved',
      session_hash: null,
      notification_revision: null,
      delivery_state: null,
      settled_at_ms: null,
    });
    expect(await settleOperationalState(db, 1, 1, legacyHash)).toBe(true);

    const secondSession = { sessionHash: hash('5'), csrfHash: hash('6') };
    await enrollIdentity({
      invitationId: 'legacy-signal-compatibility-invitation',
      principalId: 'B'.repeat(43),
      slot: 2,
      tokenHash: hash('7'),
      claimHash: hash('8'),
      ...secondSession,
      credentialMarker: 'legacy-signal-compatibility-credential',
      sessionExpiresAtMs: 100_000,
    });
    const liveLegacyHash = hash('9');
    expect(await reserveOperationalState(db, {
      slot: 2,
      authorizationGeneration: 1,
      idempotencyHash: liveLegacyHash,
      nowMs: 1_000,
      expiresAtMs: 2_000,
      cooldownUntilMs: 3_000,
    })).toBe(true);

    const signalBoundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };
    await expect(submitProtectedSignal(db, {
      ...secondSession,
      attempt: 'blocked-by-live-legacy-row',
      expectedVersion: null,
      now: () => 1_500,
    }, signalBoundary)).resolves.toEqual({ accepted: false });
    expect(signalBoundary.deliver).not.toHaveBeenCalled();
    await expect(readSignalSnapshot(db, {
      sessionHash: secondSession.sessionHash,
      nowMs: 1_500,
    })).resolves.toEqual({
      available: true,
      state: 'pending',
      retryAfterMs: 500,
    });
    expect(await env.TEST_DB.prepare(`
      SELECT idempotency_hash, reserved_at_ms, expires_at_ms, cooldown_until_ms,
        session_hash, notification_revision, delivery_state, settled_at_ms
      FROM operational_reservations
      WHERE principal_slot = 2
    `).first()).toEqual({
      idempotency_hash: liveLegacyHash,
      reserved_at_ms: 1_000,
      expires_at_ms: 2_000,
      cooldown_until_ms: 3_000,
      session_hash: null,
      notification_revision: null,
      delivery_state: null,
      settled_at_ms: null,
    });

    await expect(submitProtectedSignal(db, {
      ...secondSession,
      attempt: 'after-legacy-row-expiry',
      expectedVersion: null,
      now: () => 3_000,
    }, signalBoundary)).resolves.toMatchObject({
      accepted: true,
      snapshot: { available: true, state: 'confirmed', retryAfterMs: signalCooldownMs },
    });
    expect(signalBoundary.deliver).toHaveBeenCalledTimes(1);
  });
});
