import 'server-only';

import type {
  D1Bindable,
  D1DatabaseLike,
  D1PreparedStatementLike,
  PrincipalSlot,
} from './types';

export const canonicalAuthenticatorTransports = [
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
] as const;

export type CanonicalAuthenticatorTransport =
  (typeof canonicalAuthenticatorTransports)[number];

export type EnrollmentClaimAuthority =
  | {
      state: 'pending';
      invitationId: string;
      principalId: string;
    }
  | { state: 'committed' }
  | { state: 'unavailable' };

export type ConsumedWebAuthnChallenge =
  | {
      ceremony: 'registration';
      challengeHash: string;
      invitationId: string;
      enrollmentClaimHash: string;
      candidatePrincipalId: string;
    }
  | {
      ceremony: 'authentication';
      challengeHash: string;
    };

export interface ActiveCredentialAuthority {
  slot: PrincipalSlot;
  authorizationGeneration: number;
  principalId: string;
  credentialIdentifier: Uint8Array;
  verificationMaterial: Uint8Array;
  signatureCounter: number;
  transports?: CanonicalAuthenticatorTransport[];
}

export type EnrollmentCommitResult =
  | {
      state: 'committed';
      authorizationGeneration: number;
      signatureCounter: number;
    }
  | { state: 'not-committed' }
  | { state: 'unknown' };

export type SessionAuthority =
  | {
      authorized: true;
      slot: PrincipalSlot;
      authorizationGeneration: number;
    }
  | { authorized: false };

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

const assertionId = (operation: string, identity: string) =>
  `${operation}:${identity}`.slice(0, 256);

const isIntegerInRange = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= minimum
  && value <= maximum;

const isPrincipalSlot = (value: unknown): value is PrincipalSlot =>
  value === 1 || value === 2;

const isLowercaseSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

const isPrincipalId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

const asBytes = (value: unknown): Uint8Array<ArrayBuffer> | null => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }
  if (
    Array.isArray(value)
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    return Uint8Array.from(value);
  }
  return null;
};

export function canonicalizeAuthenticatorTransports(
  transports: readonly string[] | undefined,
): CanonicalAuthenticatorTransport[] | undefined {
  if (!transports || transports.length === 0) return undefined;
  const allowed = new Set<string>(canonicalAuthenticatorTransports);
  if (transports.some((transport) => !allowed.has(transport))) return undefined;
  return Array.from(new Set(transports))
    .sort((left, right) => left.localeCompare(right)) as CanonicalAuthenticatorTransport[];
}

const serializeTransports = (transports: readonly string[] | undefined) =>
  canonicalizeAuthenticatorTransports(transports)?.join(',') ?? null;

const parseTransports = (
  value: unknown,
): CanonicalAuthenticatorTransport[] | undefined | null => {
  if (value === null) return undefined;
  if (typeof value !== 'string') return null;
  const values = value.split(',');
  const canonical = canonicalizeAuthenticatorTransports(values);
  return canonical && canonical.join(',') === value ? canonical : null;
};

export async function reserveInvitationForEnrollment(
  db: D1DatabaseLike,
  input: {
    tokenHash: string;
    enrollmentClaimHash: string;
    initialPrincipalId: string;
    nowMs: number;
    pendingExpiresAtMs: number;
  },
): Promise<boolean> {
  if (
    !isLowercaseSha256(input.tokenHash)
    || !isLowercaseSha256(input.enrollmentClaimHash)
    || !isPrincipalId(input.initialPrincipalId)
  ) {
    return false;
  }

  try {
    const result = await db.prepare(`
      UPDATE invitations AS i
      SET pending_claim_hash = ?2,
          pending_expires_at_ms = MIN(?5, i.expires_at_ms),
          pending_principal_id = CASE i.purpose
            WHEN 'initial' THEN ?3
            ELSE (
              SELECT p.principal_id
              FROM principals AS p
              WHERE p.slot = i.principal_slot
            )
          END
      WHERE i.token_hash = ?1
        AND i.revoked_at_ms IS NULL
        AND i.consumed_at_ms IS NULL
        AND i.expires_at_ms > ?4
        AND ?5 > ?4
        AND (
          i.pending_claim_hash IS NULL
          OR i.pending_expires_at_ms <= ?4
        )
        AND (
          (
            i.purpose = 'initial'
            AND NOT EXISTS (
              SELECT 1 FROM principals WHERE slot = i.principal_slot
            )
            AND NOT EXISTS (
              SELECT 1 FROM principals WHERE principal_id = ?3
            )
          )
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
                AND length(p.principal_id) = 43
            )
          )
        )
      RETURNING invitation_id AS invitationId
    `).bind(
      input.tokenHash,
      input.enrollmentClaimHash,
      input.initialPrincipalId,
      input.nowMs,
      input.pendingExpiresAtMs,
    ).run<{ invitationId?: unknown }>();

    return (
      result.success === true
      && result.meta?.changes === 1
      && typeof result.results?.[0]?.invitationId === 'string'
    );
  } catch {
    return false;
  }
}

export async function resolveEnrollmentClaim(
  db: D1DatabaseLike,
  enrollmentClaimHash: string,
  nowMs: number,
): Promise<EnrollmentClaimAuthority> {
  if (!isLowercaseSha256(enrollmentClaimHash)) return { state: 'unavailable' };
  try {
    const row = await db.prepare(`
      SELECT state, invitationId, principalId
      FROM (
        SELECT
          'pending' AS state,
          i.invitation_id AS invitationId,
          i.pending_principal_id AS principalId,
          1 AS priority
        FROM invitations AS i
        WHERE i.pending_claim_hash = ?1
          AND i.pending_principal_id IS NOT NULL
          AND i.pending_expires_at_ms > ?2
          AND i.expires_at_ms > ?2
          AND i.revoked_at_ms IS NULL
          AND i.consumed_at_ms IS NULL
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
                  AND p.principal_id = i.pending_principal_id
              )
            )
          )
        UNION ALL
        SELECT
          'committed' AS state,
          NULL AS invitationId,
          NULL AS principalId,
          2 AS priority
        FROM invitations
        WHERE committed_claim_hash = ?1
          AND consumed_at_ms IS NOT NULL
          AND revoked_at_ms IS NULL
      )
      ORDER BY priority
      LIMIT 1
    `).bind(enrollmentClaimHash, nowMs).first<{
      state?: unknown;
      invitationId?: unknown;
      principalId?: unknown;
    }>();

    if (row?.state === 'committed') return { state: 'committed' };
    if (
      row?.state === 'pending'
      && typeof row.invitationId === 'string'
      && isPrincipalId(row.principalId)
    ) {
      return {
        state: 'pending',
        invitationId: row.invitationId,
        principalId: row.principalId,
      };
    }
    return { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function replaceRegistrationChallenge(
  db: D1DatabaseLike,
  input: {
    challengeHash: string;
    ownerHash: string;
    csrfHash: string;
    invitationId: string;
    enrollmentClaimHash: string;
    candidatePrincipalId: string;
    createdAtMs: number;
    expiresAtMs: number;
  },
): Promise<boolean> {
  const assertion = assertionId('registration-challenge', input.ownerHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.challengeHash,
    input.ownerHash,
    input.csrfHash,
    input.invitationId,
    input.enrollmentClaimHash,
    input.candidatePrincipalId,
    input.createdAtMs,
    input.expiresAtMs,
  ];
  return successfulBatch(db, [
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at_ms <= ?1')
      .bind(input.createdAtMs),
    db.prepare(`
      DELETE FROM webauthn_challenges
      WHERE ceremony_type = 'registration' AND enrollment_claim_hash = ?1
    `).bind(input.enrollmentClaimHash),
    db.prepare('DELETE FROM webauthn_challenges WHERE owner_hash = ?3')
      .bind(...bindings.slice(0, 3)),
    db.prepare(`
      INSERT INTO webauthn_challenges (
        challenge_hash, owner_hash, csrf_hash, ceremony_type,
        invitation_id, enrollment_claim_hash, candidate_principal_id,
        created_at_ms, expires_at_ms
      )
      SELECT ?2, ?3, ?4, 'registration', i.invitation_id,
        i.pending_claim_hash, i.pending_principal_id, ?8, ?9
      FROM invitations AS i
      WHERE i.invitation_id = ?5
        AND i.pending_claim_hash = ?6
        AND i.pending_principal_id = ?7
        AND i.pending_expires_at_ms > ?8
        AND i.expires_at_ms > ?8
        AND i.revoked_at_ms IS NULL
        AND i.consumed_at_ms IS NULL
    `).bind(...bindings.slice(0, 9)),
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM webauthn_challenges
        WHERE challenge_hash = ?2
          AND owner_hash = ?3
          AND invitation_id = ?5
          AND enrollment_claim_hash = ?6
          AND candidate_principal_id = ?7
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 7)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function replaceAuthenticationChallenge(
  db: D1DatabaseLike,
  input: {
    challengeHash: string;
    ownerHash: string;
    csrfHash: string;
    createdAtMs: number;
    expiresAtMs: number;
  },
): Promise<boolean> {
  const assertion = assertionId('authentication-challenge', input.ownerHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.challengeHash,
    input.ownerHash,
    input.csrfHash,
    input.createdAtMs,
    input.expiresAtMs,
  ];
  return successfulBatch(db, [
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at_ms <= ?1')
      .bind(input.createdAtMs),
    db.prepare('DELETE FROM webauthn_challenges WHERE owner_hash = ?3')
      .bind(...bindings.slice(0, 3)),
    db.prepare(`
      INSERT INTO webauthn_challenges (
        challenge_hash, owner_hash, csrf_hash, ceremony_type,
        invitation_id, enrollment_claim_hash, candidate_principal_id,
        created_at_ms, expires_at_ms
      ) VALUES (?2, ?3, ?4, 'authentication', NULL, NULL, NULL, ?5, ?6)
    `).bind(...bindings),
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1 FROM webauthn_challenges
        WHERE challenge_hash = ?2 AND owner_hash = ?3
          AND ceremony_type = 'authentication'
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 3)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
}

export async function consumeWebAuthnChallenge(
  db: D1DatabaseLike,
  input: {
    ownerHash: string;
    csrfHash: string;
    nowMs: number;
  },
): Promise<ConsumedWebAuthnChallenge | null> {
  try {
    const result = await db.prepare(`
      DELETE FROM webauthn_challenges
      WHERE owner_hash = ?1
        AND csrf_hash = ?2
        AND expires_at_ms > ?3
      RETURNING ceremony_type AS ceremony,
        challenge_hash AS challengeHash,
        invitation_id AS invitationId,
        enrollment_claim_hash AS enrollmentClaimHash,
        candidate_principal_id AS candidatePrincipalId
    `).bind(
      input.ownerHash,
      input.csrfHash,
      input.nowMs,
    ).run<{
      ceremony?: unknown;
      challengeHash?: unknown;
      invitationId?: unknown;
      enrollmentClaimHash?: unknown;
      candidatePrincipalId?: unknown;
    }>();
    if (result.success !== true || result.meta?.changes !== 1) return null;
    const row = result.results?.[0];
    if (!row || !isLowercaseSha256(row.challengeHash)) return null;
    if (row.ceremony === 'authentication') {
      return { ceremony: 'authentication', challengeHash: row.challengeHash };
    }
    if (
      row.ceremony === 'registration'
      && typeof row.invitationId === 'string'
      && isLowercaseSha256(row.enrollmentClaimHash)
      && isPrincipalId(row.candidatePrincipalId)
    ) {
      return {
        ceremony: 'registration',
        challengeHash: row.challengeHash,
        invitationId: row.invitationId,
        enrollmentClaimHash: row.enrollmentClaimHash,
        candidatePrincipalId: row.candidatePrincipalId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function readActiveCredentialByIdentifier(
  db: D1DatabaseLike,
  credentialIdentifier: ArrayBuffer | ArrayBufferView,
): Promise<ActiveCredentialAuthority | null> {
  try {
    const row = await db.prepare(`
      SELECT p.slot,
        p.authorization_generation AS authorizationGeneration,
        p.principal_id AS principalId,
        c.credential_identifier AS credentialIdentifier,
        c.verification_material AS verificationMaterial,
        c.signature_counter AS signatureCounter,
        c.canonical_transports AS canonicalTransports
      FROM credentials AS c
      JOIN principals AS p ON p.slot = c.principal_slot
      WHERE c.credential_identifier = ?1
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
        AND length(p.principal_id) = 43
      LIMIT 1
    `).bind(credentialIdentifier).first<{
      slot?: unknown;
      authorizationGeneration?: unknown;
      principalId?: unknown;
      credentialIdentifier?: unknown;
      verificationMaterial?: unknown;
      signatureCounter?: unknown;
      canonicalTransports?: unknown;
    }>();
    if (!row) return null;
    const storedIdentifier = asBytes(row.credentialIdentifier);
    const verificationMaterial = asBytes(row.verificationMaterial);
    const transports = parseTransports(row.canonicalTransports);
    if (
      !isPrincipalSlot(row.slot)
      || !isIntegerInRange(row.authorizationGeneration, 1, Number.MAX_SAFE_INTEGER)
      || !isPrincipalId(row.principalId)
      || !storedIdentifier
      || !verificationMaterial
      || !isIntegerInRange(row.signatureCounter, 0, 4_294_967_295)
      || transports === null
    ) {
      return null;
    }
    return {
      slot: row.slot,
      authorizationGeneration: row.authorizationGeneration,
      principalId: row.principalId,
      credentialIdentifier: storedIdentifier,
      verificationMaterial,
      signatureCounter: row.signatureCounter,
      transports,
    };
  } catch {
    return null;
  }
}

const enrollmentPrecondition = `EXISTS (
  SELECT 1
  FROM invitations AS i
  WHERE i.invitation_id = ?2
    AND i.pending_claim_hash = ?3
    AND i.pending_principal_id = ?4
    AND i.pending_expires_at_ms > ?9
    AND i.expires_at_ms > ?9
    AND i.revoked_at_ms IS NULL
    AND i.consumed_at_ms IS NULL
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
            AND p.principal_id = i.pending_principal_id
            AND p.authorization_state = 'reset'
            AND c.authorization_state = 'revoked'
            AND p.authorization_generation = i.required_generation
        )
      )
    )
)`;

export async function commitVerifiedEnrollment(
  db: D1DatabaseLike,
  input: {
    invitationId: string;
    enrollmentClaimHash: string;
    candidatePrincipalId: string;
    credentialIdentifier: ArrayBuffer | ArrayBufferView;
    verificationMaterial: ArrayBuffer | ArrayBufferView;
    signatureCounter: number;
    transports?: readonly string[];
    nowMs: number;
  },
): Promise<EnrollmentCommitResult> {
  const canonicalTransports = serializeTransports(input.transports);
  const assertion = assertionId('verified-enrollment', input.enrollmentClaimHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.invitationId,
    input.enrollmentClaimHash,
    input.candidatePrincipalId,
    input.credentialIdentifier,
    input.verificationMaterial,
    input.signatureCounter,
    canonicalTransports,
    input.nowMs,
  ];
  const statements = [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN ${enrollmentPrecondition} THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 9)),
    db.prepare(`
      INSERT INTO principals (
        slot, principal_id, credential_slot, authorization_generation,
        authorization_state, created_at_ms, updated_at_ms
      )
      SELECT i.principal_slot, i.pending_principal_id, i.principal_slot,
        1, 'active', ?9, ?9
      FROM invitations AS i
      WHERE i.invitation_id = ?2 AND i.purpose = 'initial'
    `).bind(...bindings),
    db.prepare(`
      INSERT INTO credentials (
        principal_slot, credential_identifier, verification_material,
        authorization_state, activated_generation, created_at_ms, updated_at_ms,
        signature_counter, canonical_transports
      )
      SELECT i.principal_slot, ?5, ?6, 'active', 1, ?9, ?9, ?7, ?8
      FROM invitations AS i
      WHERE i.invitation_id = ?2 AND i.purpose = 'initial'
    `).bind(...bindings),
    db.prepare(`
      UPDATE principals
      SET authorization_generation = authorization_generation + 1,
          authorization_state = 'active',
          updated_at_ms = ?9
      WHERE slot = (
        SELECT principal_slot FROM invitations
        WHERE invitation_id = ?2 AND purpose = 'replacement'
      ) AND authorization_state = 'reset'
    `).bind(...bindings),
    db.prepare(`
      UPDATE credentials
      SET credential_identifier = ?5,
          verification_material = ?6,
          signature_counter = ?7,
          canonical_transports = ?8,
          authorization_state = 'active',
          activated_generation = (
            SELECT authorization_generation FROM principals
            WHERE slot = credentials.principal_slot
          ),
          updated_at_ms = ?9
      WHERE principal_slot = (
        SELECT principal_slot FROM invitations
        WHERE invitation_id = ?2 AND purpose = 'replacement'
      ) AND authorization_state = 'revoked'
    `).bind(...bindings),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?9)
      WHERE principal_slot = (
        SELECT principal_slot FROM invitations
        WHERE invitation_id = ?2 AND purpose = 'replacement'
      )
    `).bind(...bindings),
    db.prepare(`
      UPDATE invitations
      SET consumed_at_ms = ?9,
          committed_claim_hash = ?3,
          pending_claim_hash = NULL,
          pending_expires_at_ms = NULL,
          pending_principal_id = NULL
      WHERE invitation_id = ?2
        AND pending_claim_hash = ?3
        AND pending_principal_id = ?4
    `).bind(...bindings),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM invitations AS i
        JOIN principals AS p ON p.slot = i.principal_slot
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE i.invitation_id = ?2
          AND i.committed_claim_hash = ?3
          AND i.consumed_at_ms = ?9
          AND p.principal_id = ?4
          AND p.authorization_state = 'active'
          AND c.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
          AND c.credential_identifier = ?5
          AND c.signature_counter = ?7
          AND (
            i.purpose = 'initial'
            OR NOT EXISTS (
              SELECT 1 FROM sessions
              WHERE principal_slot = p.slot AND revoked_at_ms IS NULL
            )
          )
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...bindings),
    db.prepare(`
      SELECT CASE i.purpose
        WHEN 'initial' THEN 1
        ELSE i.required_generation + 1
      END AS authorizationGeneration
      FROM invitations AS i
      JOIN principals AS p ON p.slot = i.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE i.invitation_id = ?2
        AND i.committed_claim_hash = ?3
        AND i.consumed_at_ms = ?9
        AND p.principal_id = ?4
        AND c.credential_identifier = ?5
        AND c.verification_material = ?6
        AND c.signature_counter = ?7
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
      LIMIT 1
    `).bind(...bindings),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ];

  try {
    const results = await db.batch<{ authorizationGeneration?: unknown }>(statements);
    const snapshot = results.at(-2)?.results?.[0];
    if (
      results.length === statements.length
      && results.every((result) => result?.success === true)
      && isIntegerInRange(
        snapshot?.authorizationGeneration,
        1,
        Number.MAX_SAFE_INTEGER,
      )
    ) {
      return {
        state: 'committed',
        authorizationGeneration: snapshot.authorizationGeneration,
        signatureCounter: input.signatureCounter,
      };
    }
  } catch {
    // Ambiguous batch outcomes are reconciled from the committed claim below.
  }

  try {
    const row = await db.prepare(`
      SELECT CASE i.purpose
        WHEN 'initial' THEN 1
        ELSE i.required_generation + 1
      END AS authorizationGeneration
      FROM invitations AS i
      JOIN principals AS p ON p.slot = i.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE i.invitation_id = ?1
        AND i.committed_claim_hash = ?2
        AND i.consumed_at_ms IS NOT NULL
        AND p.principal_id = ?3
        AND c.credential_identifier = ?4
        AND c.verification_material = ?5
        AND c.signature_counter = ?6
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
      LIMIT 1
    `).bind(
      input.invitationId,
      input.enrollmentClaimHash,
      input.candidatePrincipalId,
      input.credentialIdentifier,
      input.verificationMaterial,
      input.signatureCounter,
    ).first<{ authorizationGeneration?: unknown }>();
    return isIntegerInRange(
      row?.authorizationGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    )
      ? {
          state: 'committed',
          authorizationGeneration: row.authorizationGeneration,
          signatureCounter: input.signatureCounter,
        }
      : { state: 'not-committed' };
  } catch {
    return { state: 'unknown' };
  }
}

export async function issueIdentitySession(
  db: D1DatabaseLike,
  input: {
    credentialIdentifier: ArrayBuffer | ArrayBufferView;
    principalId: string;
    expectedAuthorizationGeneration: number;
    expectedCounter: number;
    sessionHash: string;
    sessionCsrfHash: string;
    previousSessionHash?: string;
    nowMs: number;
    sessionExpiresAtMs: number;
  },
): Promise<boolean> {
  if (
    !isIntegerInRange(input.expectedAuthorizationGeneration, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(input.expectedCounter, 0, 4_294_967_295)
  ) {
    return false;
  }
  const assertion = assertionId('identity-session', input.sessionHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.credentialIdentifier,
    input.principalId,
    input.expectedAuthorizationGeneration,
    input.expectedCounter,
    input.sessionHash,
    input.sessionCsrfHash,
    input.previousSessionHash ?? null,
    input.nowMs,
    input.sessionExpiresAtMs,
  ];
  const committed = await successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1
        FROM credentials AS c
        JOIN principals AS p ON p.slot = c.principal_slot
        WHERE c.credential_identifier = ?2
          AND p.principal_id = ?3
          AND p.authorization_generation = ?4
          AND c.activated_generation = ?4
          AND c.signature_counter = ?5
          AND c.authorization_state = 'active'
          AND p.authorization_state = 'active'
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings.slice(0, 5)),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?9)
      WHERE ?8 IS NOT NULL
        AND session_hash = ?8
        AND principal_slot = (
          SELECT p.slot
          FROM credentials AS c
          JOIN principals AS p ON p.slot = c.principal_slot
          WHERE c.credential_identifier = ?2
            AND p.principal_id = ?3
            AND p.authorization_generation = ?4
            AND c.activated_generation = ?4
        )
    `).bind(...bindings.slice(0, 9)),
    db.prepare(`
      INSERT INTO sessions (
        session_hash, principal_slot, authorization_generation,
        created_at_ms, expires_at_ms, csrf_hash
      )
      SELECT ?6, p.slot, p.authorization_generation, ?9, ?10, ?7
      FROM credentials AS c
      JOIN principals AS p ON p.slot = c.principal_slot
      WHERE c.credential_identifier = ?2
        AND p.principal_id = ?3
        AND p.authorization_generation = ?4
        AND c.activated_generation = ?4
        AND c.signature_counter = ?5
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
    `).bind(...bindings),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM sessions AS s
        JOIN principals AS p ON p.slot = s.principal_slot
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE s.session_hash = ?6
          AND s.csrf_hash = ?7
          AND s.revoked_at_ms IS NULL
          AND p.principal_id = ?3
          AND p.authorization_generation = ?4
          AND s.authorization_generation = ?4
          AND c.activated_generation = ?4
          AND c.credential_identifier = ?2
          AND c.signature_counter = ?5
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...bindings.slice(0, 7)),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
  if (committed) return true;
  try {
    const row = await db.prepare(`
      SELECT 1 AS issued
      FROM sessions AS s
      JOIN principals AS p ON p.slot = s.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE s.session_hash = ?1
        AND s.csrf_hash = ?2
        AND s.revoked_at_ms IS NULL
        AND p.principal_id = ?3
        AND p.authorization_generation = ?4
        AND s.authorization_generation = ?4
        AND c.activated_generation = ?4
        AND c.credential_identifier = ?5
        AND c.signature_counter = ?6
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
      LIMIT 1
    `).bind(
      input.sessionHash,
      input.sessionCsrfHash,
      input.principalId,
      input.expectedAuthorizationGeneration,
      input.credentialIdentifier,
      input.expectedCounter,
    ).first<{ issued?: unknown }>();
    return row?.issued === 1;
  } catch {
    return false;
  }
}

export async function acceptAuthenticationAndIssueSession(
  db: D1DatabaseLike,
  input: {
    credentialIdentifier: ArrayBuffer | ArrayBufferView;
    principalId: string;
    expectedAuthorizationGeneration: number;
    expectedCounter: number;
    newCounter: number;
    sessionHash: string;
    sessionCsrfHash: string;
    previousSessionHash?: string;
    nowMs: number;
    sessionExpiresAtMs: number;
  },
): Promise<boolean> {
  if (
    !isIntegerInRange(input.expectedAuthorizationGeneration, 1, Number.MAX_SAFE_INTEGER)
    || !isIntegerInRange(input.expectedCounter, 0, 4_294_967_295)
    || !isIntegerInRange(input.newCounter, 0, 4_294_967_295)
  ) {
    return false;
  }
  if (
    (input.expectedCounter > 0 || input.newCounter > 0)
    && input.newCounter <= input.expectedCounter
  ) {
    return false;
  }
  const acceptedCounter = input.newCounter;
  const assertion = assertionId('authentication-session', input.sessionHash);
  const bindings: D1Bindable[] = [
    assertion,
    input.credentialIdentifier,
    input.principalId,
    input.expectedCounter,
    acceptedCounter,
    input.sessionHash,
    input.sessionCsrfHash,
    input.previousSessionHash ?? null,
    input.nowMs,
    input.sessionExpiresAtMs,
    input.expectedAuthorizationGeneration,
  ];
  const committed = await successfulBatch(db, [
    db.prepare(`
      INSERT INTO transaction_assertions (assertion_id, satisfied)
      VALUES (?1, CASE WHEN EXISTS (
        SELECT 1
        FROM credentials AS c
        JOIN principals AS p ON p.slot = c.principal_slot
        WHERE c.credential_identifier = ?2
          AND p.principal_id = ?3
          AND c.signature_counter = ?4
          AND p.authorization_generation = ?11
          AND c.activated_generation = ?11
          AND c.authorization_state = 'active'
          AND p.authorization_state = 'active'
          AND c.activated_generation = p.authorization_generation
      ) THEN 1 ELSE 0 END)
    `).bind(...bindings),
    db.prepare(`
      UPDATE credentials
      SET signature_counter = ?5, updated_at_ms = ?9
      WHERE credential_identifier = ?2
        AND signature_counter = ?4
        AND authorization_state = 'active'
        AND activated_generation = ?11
    `).bind(...bindings),
    db.prepare(`
      UPDATE sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?9)
      WHERE ?8 IS NOT NULL
        AND session_hash = ?8
        AND principal_slot = (
          SELECT p.slot
          FROM credentials AS c
          JOIN principals AS p ON p.slot = c.principal_slot
          WHERE c.credential_identifier = ?2
            AND p.principal_id = ?3
            AND p.authorization_generation = ?11
            AND c.activated_generation = ?11
        )
    `).bind(...bindings),
    db.prepare(`
      INSERT INTO sessions (
        session_hash, principal_slot, authorization_generation,
        created_at_ms, expires_at_ms, csrf_hash
      )
      SELECT ?6, p.slot, p.authorization_generation, ?9, ?10, ?7
      FROM credentials AS c
      JOIN principals AS p ON p.slot = c.principal_slot
      WHERE c.credential_identifier = ?2
        AND p.principal_id = ?3
        AND c.signature_counter = ?5
        AND p.authorization_generation = ?11
        AND c.activated_generation = ?11
        AND c.authorization_state = 'active'
        AND p.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
    `).bind(...bindings),
    db.prepare(`
      UPDATE transaction_assertions
      SET satisfied = CASE WHEN EXISTS (
        SELECT 1
        FROM sessions AS s
        JOIN principals AS p ON p.slot = s.principal_slot
        JOIN credentials AS c ON c.principal_slot = p.slot
        WHERE s.session_hash = ?6
          AND s.csrf_hash = ?7
          AND s.revoked_at_ms IS NULL
          AND p.principal_id = ?3
          AND c.credential_identifier = ?2
          AND c.signature_counter = ?5
          AND p.authorization_generation = ?11
          AND s.authorization_generation = ?11
          AND c.activated_generation = ?11
      ) THEN 1 ELSE 0 END
      WHERE assertion_id = ?1
    `).bind(...bindings),
    db.prepare('DELETE FROM transaction_assertions WHERE assertion_id = ?1')
      .bind(assertion),
  ]);
  if (committed) return true;

  try {
    const row = await db.prepare(`
      SELECT 1 AS accepted
      FROM sessions AS s
      JOIN principals AS p ON p.slot = s.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE s.session_hash = ?1
        AND s.csrf_hash = ?2
        AND s.revoked_at_ms IS NULL
        AND p.principal_id = ?3
        AND p.authorization_generation = ?4
        AND s.authorization_generation = ?4
        AND c.activated_generation = ?4
        AND c.credential_identifier = ?5
        AND c.signature_counter = ?6
      LIMIT 1
    `).bind(
      input.sessionHash,
      input.sessionCsrfHash,
      input.principalId,
      input.expectedAuthorizationGeneration,
      input.credentialIdentifier,
      acceptedCounter,
    ).first<{ accepted?: unknown }>();
    return row?.accepted === 1;
  } catch {
    return false;
  }
}

export async function resolveSessionAuthority(
  db: D1DatabaseLike,
  sessionHash: string,
  nowMs: number,
): Promise<SessionAuthority> {
  try {
    const row = await db.prepare(`
      SELECT p.slot, p.authorization_generation AS authorizationGeneration
      FROM sessions AS s
      JOIN principals AS p ON p.slot = s.principal_slot
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE s.session_hash = ?1
        AND s.csrf_hash IS NOT NULL
        AND s.revoked_at_ms IS NULL
        AND s.expires_at_ms > ?2
        AND s.authorization_generation = p.authorization_generation
        AND p.authorization_state = 'active'
        AND length(p.principal_id) = 43
        AND c.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
      LIMIT 1
    `).bind(sessionHash, nowMs).first<{
      slot?: unknown;
      authorizationGeneration?: unknown;
    }>();
    if (
      !row
      || !isPrincipalSlot(row.slot)
      || !isIntegerInRange(row.authorizationGeneration, 1, Number.MAX_SAFE_INTEGER)
    ) {
      return { authorized: false };
    }
    return {
      authorized: true,
      slot: row.slot,
      authorizationGeneration: row.authorizationGeneration,
    };
  } catch {
    return { authorized: false };
  }
}

export async function revokeIdentitySession(
  db: D1DatabaseLike,
  input: {
    sessionHash: string;
    csrfHash: string;
    revokedAtMs: number;
  },
): Promise<boolean> {
  try {
    const result = await db.prepare(`
      UPDATE sessions AS s
      SET revoked_at_ms = ?3
      WHERE s.session_hash = ?1
        AND s.csrf_hash = ?2
        AND s.revoked_at_ms IS NULL
        AND s.expires_at_ms > ?3
        AND EXISTS (
          SELECT 1
          FROM principals AS p
          JOIN credentials AS c ON c.principal_slot = p.slot
          WHERE p.slot = s.principal_slot
            AND p.authorization_state = 'active'
            AND c.authorization_state = 'active'
            AND s.authorization_generation = p.authorization_generation
            AND c.activated_generation = p.authorization_generation
        )
    `).bind(input.sessionHash, input.csrfHash, input.revokedAtMs).run();
    return result.success === true && result.meta?.changes === 1;
  } catch {
    return false;
  }
}

export async function cleanupExpiredWebAuthnChallenges(
  db: D1DatabaseLike,
  nowMs: number,
  limit: number,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return 0;
  try {
    const result = await db.prepare(`
      DELETE FROM webauthn_challenges
      WHERE challenge_hash IN (
        SELECT challenge_hash
        FROM webauthn_challenges
        WHERE expires_at_ms <= ?1
        ORDER BY expires_at_ms, challenge_hash
        LIMIT ?2
      )
    `).bind(nowMs, limit).run();
    const changes = result.meta?.changes;
    return result.success === true && typeof changes === 'number' ? changes : 0;
  } catch {
    return 0;
  }
}
