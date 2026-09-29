import type { D1DatabaseLike, D1ResultLike } from '../../../site/server/d1/types.ts';

import { MaintenanceError } from './errors.ts';
import type {
  InvitationPurpose,
  InvitationRecord,
  MaintenanceSnapshot,
  NotificationStatus,
  PrincipalStatus,
  StatusReader,
} from './types.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const integer = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new MaintenanceError('status-unavailable');
  }
  return value;
};

const nullableInteger = (value: unknown, minimum = 0): number | null => (
  value === null ? null : integer(value, minimum)
);

const rows = (result: D1ResultLike): Record<string, unknown>[] => {
  if (
    result.success !== true
    || !Array.isArray(result.results)
    || result.results.some((row) => !isRecord(row))
  ) {
    throw new MaintenanceError('status-unavailable');
  }
  return result.results;
};

const parsePrincipal = (row: Record<string, unknown>): PrincipalStatus => {
  const slot = integer(row.slot, 1);
  if (slot !== 1 && slot !== 2) throw new MaintenanceError('status-unavailable');
  const activeSessions = integer(row.activeSessions);
  const operationalReservations = integer(row.operationalReservations);
  if (operationalReservations > 1) throw new MaintenanceError('status-unavailable');
  if (row.principalState === null) {
    if (
      row.generation !== null
      || row.credentialState !== null
      || row.credentialGeneration !== null
      || activeSessions !== 0
      || operationalReservations !== 0
    ) {
      throw new MaintenanceError('status-unavailable');
    }
    return {
      slot,
      state: 'unfilled',
      generation: null,
      credentialState: null,
      credentialGeneration: null,
      activeSessions,
      operationalReservations,
    };
  }
  if (
    (row.principalState !== 'active' && row.principalState !== 'reset')
    || (row.credentialState !== 'active' && row.credentialState !== 'revoked')
  ) {
    throw new MaintenanceError('status-unavailable');
  }
  const state = row.principalState;
  const generation = integer(row.generation, 1);
  const credentialState = row.credentialState;
  const credentialGeneration = integer(row.credentialGeneration, 1);
  if (
    credentialGeneration !== generation
    || (state === 'active' && credentialState !== 'active')
    || (state === 'reset' && (
      credentialState !== 'revoked'
      || activeSessions !== 0
      || operationalReservations !== 0
    ))
  ) {
    throw new MaintenanceError('status-unavailable');
  }
  return {
    slot,
    state,
    generation,
    credentialState,
    credentialGeneration,
    activeSessions,
    operationalReservations,
  };
};

const parseInvitation = (row: Record<string, unknown>): InvitationRecord => {
  const slot = integer(row.slot, 1);
  if (slot !== 1 && slot !== 2) throw new MaintenanceError('status-unavailable');
  if (
    typeof row.invitationId !== 'string'
    || row.invitationId.length < 16
    || typeof row.tokenHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.tokenHash)
    || (row.purpose !== 'initial' && row.purpose !== 'replacement')
  ) {
    throw new MaintenanceError('status-unavailable');
  }
  const purpose: InvitationPurpose = row.purpose;
  const requiredGeneration = nullableInteger(row.requiredGeneration, 1);
  const createdAtMs = integer(row.createdAtMs);
  const expiresAtMs = integer(row.expiresAtMs, 1);
  const revokedAtMs = nullableInteger(row.revokedAtMs);
  const consumedAtMs = nullableInteger(row.consumedAtMs);
  if (
    (purpose === 'initial' && requiredGeneration !== null)
    || (purpose === 'replacement' && requiredGeneration === null)
    || expiresAtMs <= createdAtMs
    || (revokedAtMs !== null && revokedAtMs < createdAtMs)
    || (consumedAtMs !== null && (
      consumedAtMs < createdAtMs
      || consumedAtMs >= expiresAtMs
    ))
    || (revokedAtMs !== null && consumedAtMs !== null)
  ) {
    throw new MaintenanceError('status-unavailable');
  }
  return {
    invitationId: row.invitationId,
    tokenHash: row.tokenHash,
    slot,
    purpose,
    requiredGeneration,
    createdAtMs,
    expiresAtMs,
    revokedAtMs,
    consumedAtMs,
  };
};

const parseNotification = (row: Record<string, unknown>): NotificationStatus => {
  if (row.enabled !== 0 && row.enabled !== 1) {
    throw new MaintenanceError('status-unavailable');
  }
  return { enabled: row.enabled === 1, revision: integer(row.revision, 1) };
};

const principalSql = `
  SELECT ps.slot,
         p.authorization_state AS principalState,
         p.authorization_generation AS generation,
         c.authorization_state AS credentialState,
         c.activated_generation AS credentialGeneration,
         (SELECT COUNT(*) FROM sessions AS s
          WHERE s.principal_slot = ps.slot
            AND s.revoked_at_ms IS NULL
            AND s.expires_at_ms > ?1) AS activeSessions,
         (SELECT COUNT(*) FROM operational_reservations AS o
          WHERE o.principal_slot = ps.slot) AS operationalReservations
  FROM principal_slots AS ps
  LEFT JOIN principals AS p ON p.slot = ps.slot
  LEFT JOIN credentials AS c ON c.principal_slot = p.slot
`;

const invitationColumns = `
  invitation_id AS invitationId,
  token_hash AS tokenHash,
  principal_slot AS slot,
  purpose,
  required_generation AS requiredGeneration,
  created_at_ms AS createdAtMs,
  expires_at_ms AS expiresAtMs,
  revoked_at_ms AS revokedAtMs,
  consumed_at_ms AS consumedAtMs
`;

export const createStatusReader = (db: D1DatabaseLike): StatusReader => ({
  async readSnapshot(nowMs): Promise<MaintenanceSnapshot> {
    try {
      const results = await db.batch([
        db.prepare(`${principalSql} ORDER BY ps.slot`).bind(nowMs),
        db.prepare(`
          SELECT ${invitationColumns}
          FROM invitations
          WHERE revoked_at_ms IS NULL
            AND consumed_at_ms IS NULL
            AND expires_at_ms > ?1
          ORDER BY principal_slot, expires_at_ms, invitation_id
        `).bind(nowMs),
        db.prepare(`
          SELECT enabled, revision
          FROM notification_control
          WHERE singleton = 1
        `),
      ]);
      if (results.length !== 3) throw new MaintenanceError('status-unavailable');
      const principals = rows(results[0]).map(parsePrincipal);
      const notifications = rows(results[2]);
      if (
        principals.length !== 2
        || principals[0]?.slot !== 1
        || principals[1]?.slot !== 2
        || notifications.length !== 1
      ) {
        throw new MaintenanceError('status-unavailable');
      }
      return {
        principals: [principals[0], principals[1]],
        invitations: rows(results[1]).map(parseInvitation),
        notification: parseNotification(notifications[0]),
      };
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('status-unavailable');
    }
  },

  async readPrincipal(slot, nowMs): Promise<PrincipalStatus> {
    try {
      const row = await db.prepare(`${principalSql} WHERE ps.slot = ?2`)
        .bind(nowMs, slot).first<Record<string, unknown>>();
      if (!row) throw new MaintenanceError('status-unavailable');
      return parsePrincipal(row);
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('status-unavailable');
    }
  },

  async readInvitationById(invitationId): Promise<InvitationRecord | null> {
    try {
      const row = await db.prepare(`
        SELECT ${invitationColumns}
        FROM invitations
        WHERE invitation_id = ?1
        LIMIT 1
      `).bind(invitationId).first<Record<string, unknown>>();
      return row ? parseInvitation(row) : null;
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('status-unavailable');
    }
  },

  async readOutstandingInvitations(slot, nowMs): Promise<InvitationRecord[]> {
    try {
      const result = await db.prepare(`
        SELECT ${invitationColumns}
        FROM invitations
        WHERE principal_slot = ?1
          AND revoked_at_ms IS NULL
          AND consumed_at_ms IS NULL
          AND expires_at_ms > ?2
        ORDER BY expires_at_ms, invitation_id
      `).bind(slot, nowMs).run<Record<string, unknown>>();
      return rows(result).map(parseInvitation);
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('status-unavailable');
    }
  },

  async readNotification(): Promise<NotificationStatus> {
    try {
      const row = await db.prepare(`
        SELECT enabled, revision
        FROM notification_control
        WHERE singleton = 1
        LIMIT 1
      `).first<Record<string, unknown>>();
      if (!row) throw new MaintenanceError('status-unavailable');
      return parseNotification(row);
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError('status-unavailable');
    }
  },
});
