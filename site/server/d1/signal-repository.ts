import 'server-only';

import { signalCooldownMs } from '@/lib/signal-timing';
import type { D1Bindable, D1DatabaseLike, PrincipalSlot } from './types';

export const signalExecutionWindowMs = 10_000;

export type DeliveryResult = 'confirmed' | 'definitive-failure' | 'ambiguous';

export type SignalSnapshot =
  | { available: false }
  | { available: true; state: 'ready' }
  | { available: true; state: 'pending'; retryAfterMs: number }
  | { available: true; state: 'cooldown'; retryAfterMs: number }
  | {
      available: true;
      state: DeliveryResult;
      retryAfterMs: number;
    };

export type SignalObservation = {
  snapshot: SignalSnapshot;
  version: string | null;
};

type SignalRow = {
  slot?: unknown;
  authorizationGeneration?: unknown;
  notificationRevision?: unknown;
  reservationNotificationRevision?: unknown;
  idempotencyHash?: unknown;
  reservationState?: unknown;
  deliveryState?: unknown;
  expiresAtMs?: unknown;
  cooldownUntilMs?: unknown;
};

const isInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum;

const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

const isSlot = (value: unknown): value is PrincipalSlot => value === 1 || value === 2;

const parseDeliveryState = (value: unknown): DeliveryResult | null => {
  if (value === 'confirmed' || value === 'ambiguous') return value;
  return value === 'definitive_failure' ? 'definitive-failure' : null;
};

const readAuthorityRow = async (
  db: D1DatabaseLike,
  input: { sessionHash: string; nowMs: number; csrfHash?: string },
): Promise<SignalRow | null> => {
  try {
    return await db.prepare(`
      SELECT
        p.slot,
        p.authorization_generation AS authorizationGeneration,
        n.revision AS notificationRevision,
        r.notification_revision AS reservationNotificationRevision,
        r.idempotency_hash AS idempotencyHash,
        r.state AS reservationState,
        r.delivery_state AS deliveryState,
        r.expires_at_ms AS expiresAtMs,
        r.cooldown_until_ms AS cooldownUntilMs
      FROM sessions AS s
      JOIN principals AS p ON p.slot = s.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      JOIN notification_control AS n
        ON n.singleton = 1 AND n.enabled = 1 AND n.revision >= 1
      LEFT JOIN operational_reservations AS r
        ON r.principal_slot = p.slot
        AND r.authorization_generation = p.authorization_generation
      WHERE s.session_hash = ?1
        AND s.csrf_hash IS NOT NULL
        AND s.revoked_at_ms IS NULL
        AND s.expires_at_ms > ?2
        AND s.authorization_generation = p.authorization_generation
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
        AND (?3 IS NULL OR s.csrf_hash = ?3)
      LIMIT 1
    `).bind(input.sessionHash, input.nowMs, input.csrfHash ?? null).first<SignalRow>();
  } catch {
    return null;
  }
};

const snapshotFromRow = (
  row: SignalRow | null,
  nowMs: number,
  expectedIdempotencyHash?: string,
): SignalSnapshot => {
  if (
    !row
    || !isSlot(row.slot)
    || !isInteger(row.authorizationGeneration, 1)
    || !isInteger(row.notificationRevision, 1)
  ) {
    return { available: false };
  }
  if (row.idempotencyHash === null || row.idempotencyHash === undefined) {
    return { available: true, state: 'ready' };
  }
  if (
    !isHash(row.idempotencyHash)
    || (row.reservationState !== 'reserved' && row.reservationState !== 'settled')
    || !isInteger(row.expiresAtMs)
    || !isInteger(row.cooldownUntilMs)
  ) {
    return { available: false };
  }
  if (row.reservationNotificationRevision === null) {
    if (row.deliveryState !== null) return { available: false };
    if (row.reservationState === 'reserved' && nowMs < row.expiresAtMs) {
      return {
        available: true,
        state: 'pending',
        retryAfterMs: row.expiresAtMs - nowMs,
      };
    }
    if (nowMs < row.cooldownUntilMs) {
      return {
        available: true,
        state: 'cooldown',
        retryAfterMs: row.cooldownUntilMs - nowMs,
      };
    }
    return { available: true, state: 'ready' };
  }
  if (
    !isInteger(row.reservationNotificationRevision, 1)
    || row.reservationNotificationRevision > row.notificationRevision
  ) {
    return { available: false };
  }
  const exactReplay = expectedIdempotencyHash === row.idempotencyHash;
  const differentSubmission = expectedIdempotencyHash !== undefined && !exactReplay;
  if (row.reservationState === 'reserved') {
    if (nowMs < row.expiresAtMs) {
      return {
        available: true,
        state: 'pending',
        retryAfterMs: row.expiresAtMs - nowMs,
      };
    }
    if (differentSubmission && nowMs < row.cooldownUntilMs) {
      return {
        available: true,
        state: 'cooldown',
        retryAfterMs: row.cooldownUntilMs - nowMs,
      };
    }
    if (exactReplay || nowMs < row.cooldownUntilMs) {
      return {
        available: true,
        state: 'ambiguous',
        retryAfterMs: Math.max(0, row.cooldownUntilMs - nowMs),
      };
    }
    return { available: true, state: 'ready' };
  }
  const result = parseDeliveryState(row.deliveryState);
  if (!result) return { available: false };
  if (result === 'definitive-failure') {
    if (differentSubmission) return { available: true, state: 'ready' };
    return { available: true, state: result, retryAfterMs: 0 };
  }
  if (differentSubmission && nowMs < row.cooldownUntilMs) {
    return {
      available: true,
      state: 'cooldown',
      retryAfterMs: row.cooldownUntilMs - nowMs,
    };
  }
  if (exactReplay || nowMs < row.cooldownUntilMs) {
    return {
      available: true,
      state: result,
      retryAfterMs: Math.max(0, row.cooldownUntilMs - nowMs),
    };
  }
  return { available: true, state: 'ready' };
};

export async function readSignalSnapshot(
  db: D1DatabaseLike,
  input: { sessionHash: string; nowMs: number; idempotencyHash?: string },
): Promise<SignalSnapshot> {
  return (await readSignalObservation(db, input)).snapshot;
}

export async function readSignalObservation(
  db: D1DatabaseLike,
  input: { sessionHash: string; nowMs: number; idempotencyHash?: string },
): Promise<SignalObservation> {
  const row = await readAuthorityRow(db, input);
  const snapshot = snapshotFromRow(row, input.nowMs, input.idempotencyHash);
  return {
    snapshot,
    version: snapshot.available
      && isInteger(row?.reservationNotificationRevision, 1)
      && isHash(row?.idempotencyHash)
      ? row.idempotencyHash
      : null,
  };
}

export async function reserveSignalAttempt(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    slot: PrincipalSlot;
    authorizationGeneration: number;
    notificationRevision: number;
    idempotencyHash: string;
    expectedVersion: string | null;
    nowMs: number;
  },
): Promise<boolean> {
  const assertion = `reserve-signal:${input.idempotencyHash}`.slice(0, 256);
  const expiresAtMs = input.nowMs + signalExecutionWindowMs;
  const bindings: D1Bindable[] = [
    assertion,
    input.sessionHash,
    input.csrfHash,
    input.slot,
    input.authorizationGeneration,
    input.notificationRevision,
    input.idempotencyHash,
    input.nowMs,
    expiresAtMs,
    expiresAtMs + signalCooldownMs,
    input.expectedVersion,
  ];
  try {
    const results = await db.batch([
      db.prepare(`
        INSERT INTO transaction_assertions (assertion_id, satisfied)
        VALUES (?1, CASE WHEN EXISTS (
          SELECT 1
          FROM sessions AS s
          JOIN principals AS p ON p.slot = s.principal_slot
          JOIN credentials AS c ON c.principal_slot = p.slot
          JOIN notification_control AS n
            ON n.singleton = 1 AND n.enabled = 1 AND n.revision = ?6
          WHERE s.session_hash = ?2
            AND s.csrf_hash = ?3
            AND s.principal_slot = ?4
            AND s.authorization_generation = ?5
            AND s.revoked_at_ms IS NULL
            AND s.expires_at_ms > ?8
            AND p.authorization_generation = ?5
            AND p.authorization_state = 'active'
            AND c.authorization_state = 'active'
            AND c.activated_generation = ?5
        ) AND (
          (?11 IS NULL AND NOT EXISTS (
            SELECT 1 FROM operational_reservations AS r
            WHERE r.principal_slot = ?4
              AND r.authorization_generation = ?5
              AND (r.expires_at_ms > ?8 OR r.cooldown_until_ms > ?8)
          ))
          OR (?11 IS NOT NULL AND EXISTS (
            SELECT 1 FROM operational_reservations AS r
            WHERE r.principal_slot = ?4
              AND r.authorization_generation = ?5
              AND r.notification_revision IS NOT NULL
              AND r.idempotency_hash = ?11
              AND (
                (r.state = 'reserved' AND r.cooldown_until_ms <= ?8)
                OR (
                  r.state = 'settled'
                  AND (
                    r.delivery_state = 'definitive_failure'
                    OR (
                      r.delivery_state IN ('confirmed', 'ambiguous')
                      AND r.cooldown_until_ms <= ?8
                    )
                  )
                )
              )
          ))
        ) THEN 1 ELSE 0 END)
      `).bind(...bindings),
      db.prepare(`
        INSERT INTO operational_reservations (
          principal_slot, authorization_generation, idempotency_hash, state,
          reserved_at_ms, expires_at_ms, cooldown_until_ms, session_hash,
          notification_revision, delivery_state, settled_at_ms
        ) VALUES (?4, ?5, ?7, 'reserved', ?8, ?9, ?10, ?2, ?6, NULL, NULL)
        ON CONFLICT(principal_slot) DO UPDATE SET
          authorization_generation = excluded.authorization_generation,
          idempotency_hash = excluded.idempotency_hash,
          state = excluded.state,
          reserved_at_ms = excluded.reserved_at_ms,
          expires_at_ms = excluded.expires_at_ms,
          cooldown_until_ms = excluded.cooldown_until_ms,
          session_hash = excluded.session_hash,
          notification_revision = excluded.notification_revision,
          delivery_state = NULL,
          settled_at_ms = NULL
      `).bind(...bindings.slice(0, 10)),
      db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
        .bind(assertion),
    ]);
    return results.length === 3 && results.every((result) => result.success === true);
  } catch {
    return false;
  }
}

export async function validateReservedSignalAuthority(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    authorizationGeneration: number;
    notificationRevision: number;
    idempotencyHash: string;
    nowMs: number;
  },
): Promise<boolean> {
  try {
    const row = await db.prepare(`
      SELECT 1 AS authorized
      FROM operational_reservations AS r
      JOIN sessions AS s ON s.session_hash = r.session_hash
      JOIN principals AS p ON p.slot = r.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      JOIN notification_control AS n
        ON n.singleton = 1 AND n.enabled = 1
      WHERE r.session_hash = ?1
        AND s.csrf_hash = ?2
        AND s.principal_slot = r.principal_slot
        AND r.authorization_generation = ?3
        AND r.notification_revision = ?4
        AND r.idempotency_hash = ?5
        AND r.state = 'reserved'
        AND r.expires_at_ms > ?6
        AND s.revoked_at_ms IS NULL
        AND s.expires_at_ms > ?6
        AND s.authorization_generation = ?3
        AND p.authorization_generation = ?3
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
        AND c.activated_generation = ?3
        AND n.revision = ?4
      LIMIT 1
    `).bind(
      input.sessionHash,
      input.csrfHash,
      input.authorizationGeneration,
      input.notificationRevision,
      input.idempotencyHash,
      input.nowMs,
    ).first<{ authorized?: unknown }>();
    return row?.authorized === 1;
  } catch {
    return false;
  }
}

export async function settleSignalAttempt(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    authorizationGeneration: number;
    notificationRevision: number;
    idempotencyHash: string;
    result: DeliveryResult;
    nowMs: number;
  },
): Promise<boolean> {
  const storedResult = input.result === 'definitive-failure'
    ? 'definitive_failure'
    : input.result;
  try {
    const update = await db.prepare(`
      UPDATE operational_reservations
      SET state = 'settled', delivery_state = ?6, settled_at_ms = ?7,
          cooldown_until_ms = CASE
            WHEN ?6 = 'definitive_failure' THEN ?7
            WHEN ?6 = 'ambiguous' AND ?7 > expires_at_ms
              THEN expires_at_ms + ?8
            ELSE ?7 + ?8
          END
      WHERE session_hash = ?1
        AND authorization_generation = ?3
        AND notification_revision = ?4
        AND idempotency_hash = ?5
        AND state = 'reserved'
        AND (?6 = 'ambiguous' OR expires_at_ms >= ?7)
        AND EXISTS (
          SELECT 1
          FROM sessions AS s
          JOIN principals AS p ON p.slot = s.principal_slot
          JOIN credentials AS c ON c.principal_slot = p.slot
          JOIN notification_control AS n
            ON n.singleton = 1 AND n.enabled = 1 AND n.revision = ?4
          WHERE s.session_hash = ?1
            AND s.csrf_hash = ?2
            AND s.principal_slot = operational_reservations.principal_slot
            AND s.revoked_at_ms IS NULL
            AND s.expires_at_ms > ?7
            AND s.authorization_generation = ?3
            AND p.authorization_generation = ?3
            AND p.authorization_state = 'active'
            AND c.authorization_state = 'active'
            AND c.activated_generation = ?3
        )
    `).bind(
      input.sessionHash,
      input.csrfHash,
      input.authorizationGeneration,
      input.notificationRevision,
      input.idempotencyHash,
      storedResult,
      input.nowMs,
      signalCooldownMs,
    ).run();
    return update.success === true && update.meta?.changes === 1;
  } catch {
    return false;
  }
}

/** Settle only while the caller still knows the delivery boundary was never invoked. */
export async function settleUninvokedSignalAttempt(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    authorizationGeneration: number;
    notificationRevision: number;
    idempotencyHash: string;
    nowMs: number;
  },
): Promise<boolean> {
  try {
    const update = await db.prepare(`
      UPDATE operational_reservations
      SET state = 'settled', delivery_state = 'definitive_failure',
          settled_at_ms = ?6, cooldown_until_ms = ?6
      WHERE session_hash = ?1
        AND authorization_generation = ?3
        AND notification_revision = ?4
        AND idempotency_hash = ?5
        AND state = 'reserved'
        AND EXISTS (
          SELECT 1
          FROM sessions AS s
          JOIN principals AS p ON p.slot = s.principal_slot
          JOIN credentials AS c ON c.principal_slot = p.slot
          JOIN notification_control AS n
            ON n.singleton = 1 AND n.enabled = 1 AND n.revision = ?4
          WHERE s.session_hash = ?1
            AND s.csrf_hash = ?2
            AND s.principal_slot = operational_reservations.principal_slot
            AND s.revoked_at_ms IS NULL
            AND s.expires_at_ms > ?6
            AND s.authorization_generation = ?3
            AND p.authorization_generation = ?3
            AND p.authorization_state = 'active'
            AND c.authorization_state = 'active'
            AND c.activated_generation = ?3
        )
    `).bind(
      input.sessionHash,
      input.csrfHash,
      input.authorizationGeneration,
      input.notificationRevision,
      input.idempotencyHash,
      input.nowMs,
    ).run();
    return update.success === true && update.meta?.changes === 1;
  } catch {
    return false;
  }
}

export async function readSignalAuthority(
  db: D1DatabaseLike,
  input: { sessionHash: string; nowMs: number; csrfHash?: string },
): Promise<{
  authorized: true;
  slot: PrincipalSlot;
  authorizationGeneration: number;
  notificationRevision: number;
} | { authorized: false }> {
  const row = await readAuthorityRow(db, input);
  if (
    !row
    || !isSlot(row.slot)
    || !isInteger(row.authorizationGeneration, 1)
    || !isInteger(row.notificationRevision, 1)
  ) return { authorized: false };
  return {
    authorized: true,
    slot: row.slot,
    authorizationGeneration: row.authorizationGeneration,
    notificationRevision: row.notificationRevision,
  };
}
