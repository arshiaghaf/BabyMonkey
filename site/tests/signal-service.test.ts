import { afterEach, describe, expect, it, vi } from 'vitest';

import { signalCooldownMs } from '@/lib/signal-timing';

const repository = vi.hoisted(() => ({
  readSignalAuthority: vi.fn(),
  readSignalObservation: vi.fn(),
  reserveSignalAttempt: vi.fn(),
  settleSignalAttempt: vi.fn(),
  settleUninvokedSignalAttempt: vi.fn(),
  validateReservedSignalAuthority: vi.fn(),
}));

vi.mock('@/server/d1/signal-repository', () => ({
  ...repository,
  signalExecutionWindowMs: 10_000,
}));

vi.mock('@/server/identity/crypto', () => ({
  sha256Hex: vi.fn(async () => 'a'.repeat(64)),
}));

import type { D1DatabaseLike } from '@/server/d1/types';
import type { FixedDeliveryBoundary } from '@/server/signal/delivery-boundary';
import { submitProtectedSignal } from '@/server/signal/service';

describe('protected signal delivery timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('aborts a non-returning boundary and settles ambiguity at the fixed deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repository.readSignalAuthority.mockResolvedValue({
      authorized: true,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
    });
    repository.readSignalObservation.mockResolvedValue({
      snapshot: { available: true, state: 'ready' },
      version: null,
    });
    repository.reserveSignalAttempt.mockResolvedValue(true);
    repository.validateReservedSignalAuthority.mockResolvedValue(true);
    repository.settleSignalAttempt.mockResolvedValue(true);
    let deliverySignal: AbortSignal | undefined;
    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn((signal: AbortSignal): Promise<never> => {
        deliverySignal = signal;
        return new Promise<never>(() => {});
      }),
    };

    const submission = submitProtectedSignal({} as D1DatabaseLike, {
      sessionHash: 'b'.repeat(64),
      csrfHash: 'c'.repeat(64),
      attempt: 'A'.repeat(43),
      expectedVersion: null,
      now: Date.now,
    }, boundary);
    await vi.waitFor(() => expect(boundary.deliver).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(submission).resolves.toEqual({
      accepted: true,
      snapshot: { available: true, state: 'ambiguous', retryAfterMs: signalCooldownMs },
      version: 'a'.repeat(64),
    });
    expect(deliverySignal?.aborted).toBe(true);
    expect(repository.settleSignalAttempt).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ result: 'ambiguous', nowMs: 11_000 }));
  });

  it('fails closed when reservation fails without a persisted contender', async () => {
    repository.readSignalAuthority.mockResolvedValue({
      authorized: true,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
    });
    repository.readSignalObservation
      .mockResolvedValueOnce({
        snapshot: { available: true, state: 'ready' },
        version: null,
      })
      .mockResolvedValueOnce({
        snapshot: { available: true, state: 'ready' },
        version: null,
      });
    repository.reserveSignalAttempt.mockResolvedValue(false);
    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };

    await expect(submitProtectedSignal({} as D1DatabaseLike, {
      sessionHash: 'b'.repeat(64),
      csrfHash: 'c'.repeat(64),
      attempt: 'A'.repeat(43),
      expectedVersion: null,
      now: () => 1_000,
    }, boundary)).resolves.toEqual({ accepted: false });
    expect(boundary.deliver).not.toHaveBeenCalled();
  });

  it('settles a rejected pre-delivery reservation as known unsent after its lease', async () => {
    repository.readSignalAuthority.mockResolvedValue({
      authorized: true,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
    });
    repository.readSignalObservation.mockResolvedValue({
      snapshot: { available: true, state: 'ready' },
      version: null,
    });
    repository.reserveSignalAttempt.mockResolvedValue(true);
    repository.validateReservedSignalAuthority.mockResolvedValue(false);
    repository.settleUninvokedSignalAttempt.mockResolvedValue(true);
    const times = [1_000, 11_001, 11_002];
    let timeIndex = 0;
    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };

    await expect(submitProtectedSignal({} as D1DatabaseLike, {
      sessionHash: 'b'.repeat(64),
      csrfHash: 'c'.repeat(64),
      attempt: 'A'.repeat(43),
      expectedVersion: null,
      now: () => times[Math.min(timeIndex++, times.length - 1)],
    }, boundary)).resolves.toEqual({
      accepted: true,
      snapshot: { available: true, state: 'definitive-failure', retryAfterMs: 0 },
      version: 'a'.repeat(64),
    });
    expect(boundary.deliver).not.toHaveBeenCalled();
    expect(repository.settleUninvokedSignalAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyHash: 'a'.repeat(64),
        nowMs: 11_002,
      }),
    );
  });

  it('does not invoke delivery when final authority validation completes after the lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repository.readSignalAuthority.mockResolvedValue({
      authorized: true,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
    });
    repository.readSignalObservation.mockResolvedValue({
      snapshot: { available: true, state: 'ready' },
      version: null,
    });
    repository.reserveSignalAttempt.mockResolvedValue(true);
    repository.validateReservedSignalAuthority.mockImplementation(async () => {
      vi.setSystemTime(11_001);
      return true;
    });
    repository.settleSignalAttempt.mockResolvedValue(true);
    repository.settleUninvokedSignalAttempt.mockResolvedValue(true);
    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };

    await expect(submitProtectedSignal({} as D1DatabaseLike, {
      sessionHash: 'b'.repeat(64),
      csrfHash: 'c'.repeat(64),
      attempt: 'A'.repeat(43),
      expectedVersion: null,
      now: Date.now,
    }, boundary)).resolves.toEqual({
      accepted: true,
      snapshot: { available: true, state: 'definitive-failure', retryAfterMs: 0 },
      version: 'a'.repeat(64),
    });
    expect(boundary.deliver).not.toHaveBeenCalled();
    expect(repository.settleUninvokedSignalAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nowMs: 11_001 }),
    );
  });

  it('fails closed when a notification revision change hides unsettled work', async () => {
    repository.readSignalAuthority.mockResolvedValue({
      authorized: true,
      slot: 1,
      authorizationGeneration: 1,
      notificationRevision: 2,
    });
    repository.readSignalObservation
      .mockResolvedValueOnce({
        snapshot: { available: true, state: 'ready' },
        version: null,
      })
      .mockResolvedValueOnce({
        snapshot: { available: true, state: 'ready' },
        version: null,
      });
    repository.reserveSignalAttempt.mockResolvedValue(true);
    repository.validateReservedSignalAuthority.mockResolvedValue(true);
    repository.settleSignalAttempt.mockResolvedValue(false);
    const boundary: FixedDeliveryBoundary = {
      deliver: vi.fn(async () => 'confirmed' as const),
    };

    await expect(submitProtectedSignal({} as D1DatabaseLike, {
      sessionHash: 'b'.repeat(64),
      csrfHash: 'c'.repeat(64),
      attempt: 'A'.repeat(43),
      expectedVersion: null,
      now: () => 1_000,
    }, boundary)).resolves.toEqual({ accepted: false });
    expect(boundary.deliver).toHaveBeenCalledTimes(1);
    expect(repository.readSignalAuthority).toHaveBeenCalledTimes(1);
  });
});
