import 'server-only';

import type {
  CleanupResult,
  D1Bindable,
  D1DatabaseLike,
  D1PreparedStatementLike,
  InvitationEligibility,
  InvitationPurpose,
  NotificationEligibility,
  PrincipalSlot,
  PrincipalSessionRevocationResult,
  SyntheticCredential,
} from './types';

interface InvitationInput {
  invitationId: string;
  tokenHash: string;
  slot: PrincipalSlot;
  purpose: InvitationPurpose;
  createdAtMs: number;
  expiresAtMs: number;
}

interface InvitationSelector {
  tokenHash: string;
  slot: PrincipalSlot;
  purpose: InvitationPurpose;
  nowMs: number;
  pendingClaimHash?: string;
}

interface EnrollmentInput extends InvitationSelector {
  principalId?: string;
  credential: SyntheticCredential;
}

interface SessionInput {
  sessionHash: string;
  slot: PrincipalSlot;
  createdAtMs: number;
  expiresAtMs: number;
}

const successfulBatch = async (
  db: D1DatabaseLike,
  statements: D1PreparedStatementLike[],
): Promise<boolean> => {
  try {
    const results = await db.batch(statements);
    return (
      results.length === statements.length
      && results.every((result) => result?.success === true)
    );
  } catch {
    return false;
  }
};

const pendingEligibilitySql = `(
  i.pending_claim_hash IS NULL
  OR i.pending_expires_at_ms <= ?3
  OR (?4 IS NOT NULL AND i.pending_claim_hash = ?4)
)`;

const invitationBindings = (input: InvitationSelector): D1Bindable[] => [
  input.tokenHash,
  input.slot,
  input.nowMs,
  input.pendingClaimHash ?? null,
  input.purpose,
];

const assertionId = (operation: string, identity: string) =>
  `${operation}:${identity}`.slice(0, 256);

export async function createInvitation(
  db: D1DatabaseLike,
  input: InvitationInput,
): Promise<boolean> {
  const assertion = assertionId('create-invitation', input.invitationId);
  const commonBindings: D1Bindable[] = [
    assertion,
    input.invitationId,
    input.tokenHash,
    input.slot,
    input.purpose,
    input.createdAtMs,
    input.expiresAtMs,
  ];

  const precondition = input.purpose === 'initial'
    ? `EXISTS (SELECT 1 FROM principal_slots WHERE slot = ?4)
       AND NOT EXISTS (SELECT 1 FROM principals WHERE slot = ?4)`
    : `EXISTS (
         SELECT 1
         FROM principals AS p
         JOIN credentials AS c ON c.principal_slot = p.slot
         WHERE p.slot = ?4
           AND p.authorization_state = 'reset'
           AND c.authorization_state = 'revoked'
       )`;

  const insertInvitation = input.purpose === 'initial'
    ? db.prepare(`
        INSERT INTO invitations (
          invitation_id, token_hash, principal_slot, purpose,
          required_generation, created_at_ms, expires_at_ms
        ) VALUES (?2, ?3, ?4, ?5, NULL, ?6, ?7)
      `).bind(...commonBindings)
    : db.prepare(`
        INSERT INTO invitations (
          invitation_id, token_hash, principal_slot, purpose,
          required_generation, created_at_ms, expires_at_ms
        )
        SELECT ?2, ?3, ?4, ?5, p.authorization_generation, ?6, ?7
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?4
          AND p.authorization_state = 'reset'
          AND c.authorization_state = 'revoked'
      `).bind(...commonBindings);

  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN ${precondition} THEN 1 ELSE 0 END)
    `).bind(...commonBindings.slice(0, 4)),
    insertInvitation,
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1 FROM invitations
        WHERE invitation_id = ?2
          AND token_hash = ?3
          AND principal_slot = ?4
          AND purpose = ?5
          AND revoked_at_ms IS NULL
          AND consumed_at_ms IS NULL
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...commonBindings.slice(0, 5)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function revokeInvitation(
  db: D1DatabaseLike,
  tokenHash: string,
  revokedAtMs: number,
): Promise<boolean> {
  const assertion = assertionId('revoke-invitation', tokenHash);
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      SELECT ?1, CASE WHEN EXISTS (
        SELECT 1 FROM invitations
        WHERE token_hash = ?2
          AND revoked_at_ms IS NULL
          AND consumed_at_ms IS NULL
          AND created_at_ms <= ?3
      ) THEN 1 ELSE 0 END
    `).bind(assertion, tokenHash, revokedAtMs),
    db.prepare(`
      UPDATE invitations
      SET revoked_at_ms = ?2,
          pending_claim_hash = NULL,
          pending_expires_at_ms = NULL,
          pending_principal_id = NULL
      WHERE token_hash = ?1
        AND revoked_at_ms IS NULL
        AND consumed_at_ms IS NULL
    `).bind(tokenHash, revokedAtMs),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function validateInvitationEligibility(
  db: D1DatabaseLike,
  input: InvitationSelector,
): Promise<InvitationEligibility> {
  try {
    const row = await db.prepare(`
      SELECT i.invitation_id AS invitationId
      FROM invitations AS i
      WHERE i.token_hash = ?1
        AND i.principal_slot = ?2
        AND i.purpose = ?5
        AND i.revoked_at_ms IS NULL
        AND i.consumed_at_ms IS NULL
        AND i.expires_at_ms > ?3
        AND ${pendingEligibilitySql}
        AND (
          (i.purpose = 'initial' AND NOT EXISTS (
            SELECT 1 FROM principals WHERE slot = i.principal_slot
          ))
          OR (
            i.purpose = 'replacement'
            AND EXISTS (
              SELECT 1
              FROM principals AS p
              JOIN credentials AS c ON c.principal_slot = p.slot
              WHERE p.slot = i.principal_slot
                AND p.authorization_state = 'reset'
                AND c.authorization_state = 'revoked'
                AND p.authorization_generation = i.required_generation
            )
          )
        )
      LIMIT 1
    `).bind(...invitationBindings(input)).first<{ invitationId?: unknown }>();

    if (!row || typeof row.invitationId !== 'string' || row.invitationId.length === 0) {
      return { eligible: false };
    }
    return { eligible: true, invitationId: row.invitationId };
  } catch {
    return { eligible: false };
  }
}

export async function reserveInvitationPendingClaim(
  db: D1DatabaseLike,
  input: InvitationSelector & { pendingClaimHash: string; pendingExpiresAtMs: number },
): Promise<boolean> {
  const assertion = assertionId('reserve-invitation', input.pendingClaimHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.tokenHash,
    input.slot,
    input.purpose,
    input.nowMs,
    input.pendingClaimHash,
    input.pendingExpiresAtMs,
  ];
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM invitations AS i
        WHERE i.token_hash = ?2
          AND i.principal_slot = ?3
          AND i.purpose = ?4
          AND i.revoked_at_ms IS NULL
          AND i.consumed_at_ms IS NULL
          AND i.expires_at_ms > ?5
          AND ?7 > ?5
          AND ?7 <= i.expires_at_ms
          AND (i.pending_claim_hash IS NULL OR i.pending_expires_at_ms <= ?5)
          AND (
            (i.purpose = 'initial' AND NOT EXISTS (
              SELECT 1 FROM principals WHERE slot = i.principal_slot
            ))
            OR (
              i.purpose = 'replacement'
              AND EXISTS (
                SELECT 1
                FROM principals AS p
                JOIN credentials AS c ON c.principal_slot = p.slot
                WHERE p.slot = i.principal_slot
                  AND p.authorization_state = 'reset'
                  AND c.authorization_state = 'revoked'
                  AND p.authorization_generation = i.required_generation
              )
            )
          )
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings),
    db.prepare(`
      UPDATE invitations
      SET pending_claim_hash = ?6,
          pending_expires_at_ms = ?7,
          pending_principal_id = NULL
      WHERE token_hash = ?2 AND principal_slot = ?3 AND purpose = ?4
    `).bind(...bindings),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function clearInvitationPendingClaim(
  db: D1DatabaseLike,
  tokenHash: string,
  pendingClaimHash: string,
): Promise<boolean> {
  try {
    const result = await db.prepare(`
      UPDATE invitations
      SET pending_claim_hash = NULL,
          pending_expires_at_ms = NULL,
          pending_principal_id = NULL
      WHERE token_hash = ?1
        AND pending_claim_hash = ?2
        AND revoked_at_ms IS NULL
        AND consumed_at_ms IS NULL
    `).bind(tokenHash, pendingClaimHash).run();
    return result.success === true && result.meta?.changes === 1;
  } catch {
    return false;
  }
}

const enrollmentPreconditionSql = (purpose: InvitationPurpose) => `EXISTS (
  SELECT 1
  FROM invitations AS i
  ${purpose === 'replacement'
    ? 'JOIN principals AS p ON p.slot = i.principal_slot JOIN credentials AS c ON c.principal_slot = p.slot'
    : ''}
  WHERE i.token_hash = ?2
    AND i.principal_slot = ?3
    AND i.purpose = '${purpose}'
    AND i.revoked_at_ms IS NULL
    AND i.consumed_at_ms IS NULL
    AND i.expires_at_ms > ?4
    AND i.pending_principal_id IS NULL
    AND (
      i.pending_claim_hash IS NULL
      OR i.pending_expires_at_ms <= ?4
      OR (?5 IS NOT NULL AND i.pending_claim_hash = ?5)
    )
    ${purpose === 'initial'
      ? 'AND NOT EXISTS (SELECT 1 FROM principals WHERE slot = i.principal_slot)'
      : `AND p.authorization_state = 'reset'
         AND c.authorization_state = 'revoked'
         AND p.authorization_generation = i.required_generation`}
)`;

export async function consumeInitialEnrollment(
  db: D1DatabaseLike,
  input: EnrollmentInput & { principalId: string; purpose: 'initial' },
): Promise<boolean> {
  const assertion = assertionId('initial-enrollment', input.tokenHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.tokenHash,
    input.slot,
    input.nowMs,
    input.pendingClaimHash ?? null,
    input.principalId,
    input.credential.identifier,
    input.credential.verificationMaterial,
  ];
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN ${enrollmentPreconditionSql('initial')} THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 5)),
    db.prepare(`
      INSERT INTO principals (
        slot, principal_id, credential_slot, authorization_generation,
        authorization_state, created_at_ms, updated_at_ms
      ) VALUES (?3, ?6, ?3, 1, 'active', ?4, ?4)
    `).bind(...bindings.slice(0, 6)),
    db.prepare(`
      INSERT INTO credentials (
        principal_slot, credential_identifier, verification_material,
        authorization_state, activated_generation, created_at_ms, updated_at_ms
      ) VALUES (?3, ?7, ?8, 'active', 1, ?4, ?4)
    `).bind(...bindings),
    db.prepare(`
      UPDATE invitations
      SET consumed_at_ms = ?4,
          pending_claim_hash = NULL,
          pending_expires_at_ms = NULL,
          pending_principal_id = NULL
      WHERE token_hash = ?2 AND principal_slot = ?3 AND purpose = 'initial'
    `).bind(...bindings.slice(0, 4)),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM invitations AS i
        JOIN principals AS p ON p.slot = i.principal_slot
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE i.token_hash = ?2
          AND i.consumed_at_ms = ?4
          AND p.slot = ?3
          AND p.principal_id = ?6
          AND p.authorization_generation = 1
          AND p.authorization_state = 'active'
          AND c.credential_identifier = ?7
          AND c.authorization_state = 'active'
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...bindings.slice(0, 7)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function consumeReplacementEnrollment(
  db: D1DatabaseLike,
  input: EnrollmentInput & { purpose: 'replacement' },
): Promise<boolean> {
  const assertion = assertionId('replacement-enrollment', input.tokenHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.tokenHash,
    input.slot,
    input.nowMs,
    input.pendingClaimHash ?? null,
    input.credential.identifier,
    input.credential.verificationMaterial,
  ];
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN ${enrollmentPreconditionSql('replacement')} THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 5)),
    db.prepare(`
      UPDATE principals
      SET authorization_generation = authorization_generation + 1,
          authorization_state = 'active',
          updated_at_ms = ?4
      WHERE slot = ?3 AND authorization_state = 'reset'
    `).bind(...bindings.slice(0, 4)),
    db.prepare(`
      UPDATE credentials
      SET credential_identifier = ?6,
          verification_material = ?7,
          signature_counter = 0,
          canonical_transports = NULL,
          authorization_state = 'active',
          activated_generation = (
            SELECT authorization_generation FROM principals WHERE slot = ?3
          ),
          updated_at_ms = ?4
      WHERE principal_slot = ?3 AND authorization_state = 'revoked'
    `).bind(...bindings),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?4)
      WHERE principal_slot = ?3
    `).bind(...bindings.slice(0, 4)),
    db.prepare(`
      UPDATE invitations
      SET consumed_at_ms = ?4,
          pending_claim_hash = NULL,
          pending_expires_at_ms = NULL,
          pending_principal_id = NULL
      WHERE token_hash = ?2 AND principal_slot = ?3 AND purpose = 'replacement'
    `).bind(...bindings.slice(0, 4)),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM invitations AS i
        JOIN principals AS p ON p.slot = i.principal_slot
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE i.token_hash = ?2
          AND i.consumed_at_ms = ?4
          AND p.slot = ?3
          AND p.authorization_state = 'active'
          AND p.authorization_generation = i.required_generation + 1
          AND c.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
          AND c.credential_identifier = ?6
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE principal_slot = ?3 AND revoked_at_ms IS NULL
          )
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...bindings.slice(0, 6)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function resetPrincipalAuthorization(
  db: D1DatabaseLike,
  slot: PrincipalSlot,
  nowMs: number,
): Promise<boolean> {
  const assertion = assertionId('reset-principal', String(slot));
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?2
          AND p.authorization_state = 'active'
          AND c.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
      ) THEN 1 ELSE 0 END)
    `).bind(assertion, slot),
    db.prepare(`
      UPDATE credentials
      SET authorization_state = 'revoked', updated_at_ms = ?2
      WHERE principal_slot = ?1 AND authorization_state = 'active'
    `).bind(slot, nowMs),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?2)
      WHERE principal_slot = ?1
    `).bind(slot, nowMs),
    db.prepare(`
      DELETE FROM operational_reservations WHERE principal_slot = ?1
    `).bind(slot),
    db.prepare(`
      UPDATE principals
      SET authorization_state = 'reset', updated_at_ms = ?2
      WHERE slot = ?1 AND authorization_state = 'active'
    `).bind(slot, nowMs),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?2
          AND p.authorization_state = 'reset'
          AND c.authorization_state = 'revoked'
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE principal_slot = ?2 AND revoked_at_ms IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM operational_reservations WHERE principal_slot = ?2
          )
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(assertion, slot),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function advancePrincipalGeneration(
  db: D1DatabaseLike,
  slot: PrincipalSlot,
  nowMs: number,
): Promise<boolean> {
  const assertion = assertionId('advance-generation', String(slot));
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?2
          AND p.authorization_state = 'active'
          AND c.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
      ) THEN 1 ELSE 0 END)
    `).bind(assertion, slot),
    db.prepare(`
      DELETE FROM operational_reservations WHERE principal_slot = ?1
    `).bind(slot),
    db.prepare(`
      UPDATE principals
      SET authorization_generation = authorization_generation + 1,
          updated_at_ms = ?2
      WHERE slot = ?1 AND authorization_state = 'active'
    `).bind(slot, nowMs),
    db.prepare(`
      UPDATE credentials
      SET activated_generation = (
            SELECT authorization_generation FROM principals WHERE slot = ?1
          ),
          updated_at_ms = ?2
      WHERE principal_slot = ?1 AND authorization_state = 'active'
    `).bind(slot, nowMs),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?2)
      WHERE principal_slot = ?1
    `).bind(slot, nowMs),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?2
          AND p.authorization_state = 'active'
          AND c.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
          AND NOT EXISTS (
            SELECT 1 FROM sessions
            WHERE principal_slot = ?2 AND revoked_at_ms IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM operational_reservations WHERE principal_slot = ?2
          )
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(assertion, slot),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function createSession(
  db: D1DatabaseLike,
  input: SessionInput,
): Promise<boolean> {
  const assertion = assertionId('create-session', input.sessionHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.sessionHash,
    input.slot,
    input.createdAtMs,
    input.expiresAtMs,
  ];
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO sessions (
        session_hash, principal_slot, authorization_generation,
        created_at_ms, expires_at_ms
      )
      SELECT ?2, p.slot, p.authorization_generation, ?4, ?5
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = ?3
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
    `).bind(...bindings),
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM sessions
        WHERE session_hash = ?2 AND principal_slot = ?3
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 3)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function validateSession(
  db: D1DatabaseLike,
  sessionHash: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const row = await db.prepare(`
      SELECT 1 AS authorized
      FROM sessions AS s
      JOIN principals AS p ON p.slot = s.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE s.session_hash = ?1
        AND s.revoked_at_ms IS NULL
        AND s.expires_at_ms > ?2
        AND s.authorization_generation = p.authorization_generation
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
      LIMIT 1
    `).bind(sessionHash, nowMs).first<{ authorized?: unknown }>();
    return row?.authorized === 1;
  } catch {
    return false;
  }
}

export async function revokeSession(
  db: D1DatabaseLike,
  sessionHash: string,
  revokedAtMs: number,
): Promise<boolean> {
  try {
    const result = await db.prepare(`
      UPDATE sessions SET revoked_at_ms = ?2
      WHERE session_hash = ?1 AND revoked_at_ms IS NULL
    `).bind(sessionHash, revokedAtMs).run();
    return result.success === true && result.meta?.changes === 1;
  } catch {
    return false;
  }
}

export async function revokePrincipalSessions(
  db: D1DatabaseLike,
  slot: PrincipalSlot,
  revokedAtMs: number,
): Promise<PrincipalSessionRevocationResult> {
  try {
    const result = await db.prepare(`
      UPDATE sessions SET revoked_at_ms = ?2
      WHERE principal_slot = ?1 AND revoked_at_ms IS NULL
    `).bind(slot, revokedAtMs).run();
    const revoked = result.meta?.changes;
    if (
      result.success !== true
      || typeof revoked !== 'number'
      || !Number.isInteger(revoked)
      || revoked < 0
    ) {
      return { confirmed: false };
    }
    return { confirmed: true, revoked };
  } catch {
    return { confirmed: false };
  }
}

export async function readNotificationEligibility(
  db: D1DatabaseLike,
): Promise<NotificationEligibility> {
  try {
    const row = await db.prepare(`
      SELECT enabled, revision
      FROM notification_control
      WHERE singleton = 1
      LIMIT 1
    `).first<{ enabled?: unknown; revision?: unknown }>();
    if (
      !row
      || row.enabled !== 1
      || typeof row.revision !== 'number'
      || !Number.isInteger(row.revision)
      || row.revision < 1
    ) {
      return { eligible: false };
    }
    return { eligible: true, revision: row.revision };
  } catch {
    return { eligible: false };
  }
}

export async function setNotificationState(
  db: D1DatabaseLike,
  input: { enabled: boolean; expectedRevision: number; updatedAtMs: number },
): Promise<boolean> {
  const assertion = assertionId('notification-state', String(input.expectedRevision));
  const enabled = input.enabled ? 1 : 0;
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM notification_control
        WHERE singleton = 1 AND revision = ?2
      ) THEN 1 ELSE 0 END)
    `).bind(assertion, input.expectedRevision),
    db.prepare(`
      UPDATE notification_control
      SET enabled = ?1, revision = revision + 1, updated_at_ms = ?3
      WHERE singleton = 1 AND revision = ?2
    `).bind(enabled, input.expectedRevision, input.updatedAtMs),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1 FROM notification_control
        WHERE singleton = 1 AND enabled = ?2 AND revision = ?3 + 1
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(assertion, enabled, input.expectedRevision),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function reserveOperationalState(
  db: D1DatabaseLike,
  input: {
    slot: PrincipalSlot;
    authorizationGeneration: number;
    idempotencyHash: string;
    nowMs: number;
    expiresAtMs: number;
    cooldownUntilMs: number;
  },
): Promise<boolean> {
  const assertion = assertionId('reserve-operational', input.idempotencyHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.slot,
    input.authorizationGeneration,
    input.idempotencyHash,
    input.nowMs,
    input.expiresAtMs,
    input.cooldownUntilMs,
  ];
  return successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1
        FROM principals AS p
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE p.slot = ?2
          AND p.authorization_generation = ?3
          AND p.authorization_state = 'active'
          AND c.authorization_state = 'active'
          AND c.activated_generation = ?3
      ) AND NOT EXISTS (
        SELECT 1 FROM operational_reservations
        WHERE principal_slot = ?2
          AND (expires_at_ms > ?5 OR cooldown_until_ms > ?5)
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 5)),
    db.prepare(`
      INSERT INTO operational_reservations (
        principal_slot, authorization_generation, idempotency_hash, state,
        reserved_at_ms, expires_at_ms, cooldown_until_ms
      ) VALUES (?2, ?3, ?4, 'reserved', ?5, ?6, ?7)
      ON CONFLICT(principal_slot) DO UPDATE SET
        authorization_generation = excluded.authorization_generation,
        idempotency_hash = excluded.idempotency_hash,
        state = excluded.state,
        reserved_at_ms = excluded.reserved_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        cooldown_until_ms = excluded.cooldown_until_ms,
        session_hash = NULL,
        notification_revision = NULL,
        delivery_state = NULL,
        settled_at_ms = NULL
    `).bind(...bindings),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function settleOperationalState(
  db: D1DatabaseLike,
  slot: PrincipalSlot,
  authorizationGeneration: number,
  idempotencyHash: string,
): Promise<boolean> {
  try {
    const result = await db.prepare(`
      UPDATE operational_reservations SET state = 'settled'
      WHERE principal_slot = ?1
        AND authorization_generation = ?2
        AND idempotency_hash = ?3
        AND state = 'reserved'
        AND EXISTS (
          SELECT 1
          FROM principals AS p
          JOIN credentials AS c ON c.principal_slot = p.slot
          WHERE p.slot = ?1
            AND p.authorization_generation = ?2
            AND p.authorization_state = 'active'
            AND c.authorization_state = 'active'
            AND c.activated_generation = ?2
        )
    `).bind(slot, authorizationGeneration, idempotencyHash).run();
    return result.success === true && result.meta?.changes === 1;
  } catch {
    return false;
  }
}

export async function clearOperationalState(
  db: D1DatabaseLike,
  slot: PrincipalSlot,
  authorizationGeneration: number,
  idempotencyHash: string,
): Promise<boolean> {
  try {
    const result = await db.prepare(`
      DELETE FROM operational_reservations
      WHERE principal_slot = ?1
        AND authorization_generation = ?2
        AND idempotency_hash = ?3
    `).bind(slot, authorizationGeneration, idempotencyHash).run();
    return result.success === true && result.meta?.changes === 1;
  } catch {
    return false;
  }
}

export async function cleanupExpiredState(
  db: D1DatabaseLike,
  input: { nowMs: number; terminalBeforeMs: number; limit: number },
): Promise<CleanupResult> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
    return { invitations: 0, sessions: 0, operationalReservations: 0 };
  }
  try {
    const results = await db.batch([
      db.prepare(`
        DELETE FROM invitations
        WHERE invitation_id IN (
          SELECT invitation_id
          FROM invitations
          WHERE (
            expires_at_ms <= ?1
            OR revoked_at_ms <= ?2
            OR consumed_at_ms <= ?2
          )
            AND (pending_expires_at_ms IS NULL OR pending_expires_at_ms <= ?1)
          ORDER BY expires_at_ms, invitation_id
          LIMIT ?3
        )
      `).bind(input.nowMs, input.terminalBeforeMs, input.limit),
      db.prepare(`
        DELETE FROM sessions
        WHERE session_hash IN (
          SELECT session_hash
          FROM sessions
          WHERE expires_at_ms <= ?1 OR revoked_at_ms <= ?2
          ORDER BY expires_at_ms, session_hash
          LIMIT ?3
        )
      `).bind(input.nowMs, input.terminalBeforeMs, input.limit),
      db.prepare(`
        DELETE FROM operational_reservations
        WHERE principal_slot IN (
          SELECT principal_slot
          FROM operational_reservations
          WHERE expires_at_ms <= ?1 AND cooldown_until_ms <= ?1
          ORDER BY expires_at_ms, principal_slot
          LIMIT ?2
        )
      `).bind(input.nowMs, input.limit),
    ]);
    if (results.length !== 3 || results.some((result) => result.success !== true)) {
      return { invitations: 0, sessions: 0, operationalReservations: 0 };
    }
    return {
      invitations: results[0].meta?.changes ?? 0,
      sessions: results[1].meta?.changes ?? 0,
      operationalReservations: results[2].meta?.changes ?? 0,
    };
  } catch {
    return { invitations: 0, sessions: 0, operationalReservations: 0 };
  }
}
