import 'server-only';

import { signalCooldownMs } from '@/lib/signal-timing';
import {
  readSignalAuthority,
  readSignalObservation,
  reserveSignalAttempt,
  settleSignalAttempt,
  settleUninvokedSignalAttempt,
  signalExecutionWindowMs,
  validateReservedSignalAuthority,
  type SignalSnapshot,
} from '@/server/d1/signal-repository';
import type { D1DatabaseLike } from '@/server/d1/types';
import { sha256Hex } from '@/server/identity/crypto';
import type { FixedDeliveryBoundary } from './delivery-boundary';

export type SignalSubmissionResult =
  | { accepted: false }
  | { accepted: true; snapshot: SignalSnapshot; version: string };

export async function submitProtectedSignal(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    attempt: string;
    expectedVersion: string | null;
    now: () => number;
  },
  boundary: FixedDeliveryBoundary,
): Promise<SignalSubmissionResult> {
  const startedAtMs = input.now();
  const authority = await readSignalAuthority(db, {
    sessionHash: input.sessionHash,
    csrfHash: input.csrfHash,
    nowMs: startedAtMs,
  });
  if (!authority.authorized) return { accepted: false };

  const idempotencyHash = await sha256Hex(`signal:${authority.slot}:${input.attempt}`);
  const existing = await readSignalObservation(db, {
    sessionHash: input.sessionHash,
    nowMs: startedAtMs,
    idempotencyHash,
  });
  if (!existing.snapshot.available) return { accepted: false };
  if (existing.snapshot.state !== 'ready') {
    if (
      existing.version
      && (
        existing.version === idempotencyHash
        || existing.snapshot.state === 'pending'
        || existing.snapshot.state === 'cooldown'
      )
    ) {
      return {
        accepted: true,
        snapshot: existing.snapshot,
        version: existing.version,
      };
    }
    return { accepted: false };
  }
  if (existing.version !== input.expectedVersion) return { accepted: false };

  const reserved = await reserveSignalAttempt(db, {
    ...authority,
    sessionHash: input.sessionHash,
    csrfHash: input.csrfHash,
    idempotencyHash,
    expectedVersion: input.expectedVersion,
    nowMs: startedAtMs,
  });
  if (!reserved) {
    const current = await readSignalObservation(db, {
      sessionHash: input.sessionHash,
      nowMs: input.now(),
      idempotencyHash,
    });
    if (!current.snapshot.available || !current.version) return { accepted: false };
    if (
      current.version === idempotencyHash
      && current.snapshot.state !== 'ready'
    ) {
      return {
        accepted: true,
        snapshot: current.snapshot,
        version: current.version,
      };
    }
    if (current.snapshot.state === 'pending' || current.snapshot.state === 'cooldown') {
      return {
        accepted: true,
        snapshot: current.snapshot,
        version: current.version,
      };
    }
    return { accepted: false };
  }

  const deadlineMs = startedAtMs + signalExecutionWindowMs;
  const invocationAtMs = input.now();
  const reservedAuthorityValid = await validateReservedSignalAuthority(db, {
    ...authority,
    sessionHash: input.sessionHash,
    csrfHash: input.csrfHash,
    idempotencyHash,
    nowMs: invocationAtMs,
  });
  const validatedAtMs = input.now();
  if (!reservedAuthorityValid || validatedAtMs >= deadlineMs) {
    const settledUninvoked = await settleUninvokedSignalAttempt(db, {
      ...authority,
      sessionHash: input.sessionHash,
      csrfHash: input.csrfHash,
      idempotencyHash,
      nowMs: validatedAtMs,
    });
    if (!settledUninvoked) {
      const current = await readSignalObservation(db, {
        sessionHash: input.sessionHash,
        nowMs: validatedAtMs,
        idempotencyHash,
      });
      if (
        !current.snapshot.available
        || current.version !== idempotencyHash
        || current.snapshot.state !== 'definitive-failure'
      ) return { accepted: false };
      return {
        accepted: true,
        snapshot: current.snapshot,
        version: current.version,
      };
    }
    return {
      accepted: true,
      snapshot: {
        available: true,
        state: 'definitive-failure',
        retryAfterMs: 0,
      },
      version: idempotencyHash,
    };
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<FixedDeliveryBoundary['deliver']>>;
  try {
    result = await Promise.race([
      boundary.deliver(controller.signal),
      new Promise<'ambiguous'>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve('ambiguous');
        }, Math.max(0, deadlineMs - validatedAtMs));
      }),
    ]);
  } catch {
    result = 'ambiguous';
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const settledAtMs = input.now();
  if (settledAtMs - startedAtMs >= signalExecutionWindowMs) result = 'ambiguous';
  const settled = await settleSignalAttempt(db, {
    ...authority,
    sessionHash: input.sessionHash,
    csrfHash: input.csrfHash,
    idempotencyHash,
    result,
    nowMs: settledAtMs,
  });
  if (!settled) {
    const current = await readSignalObservation(db, {
      sessionHash: input.sessionHash,
      nowMs: settledAtMs,
      idempotencyHash,
    });
    if (
      !current.snapshot.available
      || current.version !== idempotencyHash
      || current.snapshot.state === 'ready'
      || current.snapshot.state === 'cooldown'
    ) return { accepted: false };
    return {
      accepted: true,
      snapshot: current.snapshot,
      version: current.version,
    };
  }
  return {
    accepted: true,
    snapshot: {
      available: true,
      state: result,
      retryAfterMs: result === 'definitive-failure'
        ? 0
        : Math.max(
            0,
            (result === 'ambiguous' && settledAtMs > deadlineMs
              ? deadlineMs
              : settledAtMs) + signalCooldownMs - settledAtMs,
          ),
    },
    version: idempotencyHash,
  };
}
