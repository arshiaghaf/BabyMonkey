CREATE TABLE invitations (
  invitation_id TEXT PRIMARY KEY CHECK (length(invitation_id) BETWEEN 16 AND 128),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(token_hash) = 64
      AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
  principal_slot INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('initial', 'replacement')),
  required_generation INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms >= created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms >= created_at_ms),
  pending_claim_hash TEXT
    CHECK (
      pending_claim_hash IS NULL
      OR (
        length(pending_claim_hash) = 64
        AND pending_claim_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  pending_expires_at_ms INTEGER,
  CHECK (
    (purpose = 'initial' AND required_generation IS NULL)
    OR (
      purpose = 'replacement'
      AND required_generation IS NOT NULL
      AND required_generation >= 1
    )
  ),
  CHECK (NOT (revoked_at_ms IS NOT NULL AND consumed_at_ms IS NOT NULL)),
  CHECK (
    (pending_claim_hash IS NULL AND pending_expires_at_ms IS NULL)
    OR (
      pending_claim_hash IS NOT NULL
      AND pending_expires_at_ms IS NOT NULL
      AND pending_expires_at_ms > created_at_ms
      AND pending_expires_at_ms <= expires_at_ms
    )
  ),
  FOREIGN KEY (principal_slot) REFERENCES principal_slots(slot) ON DELETE RESTRICT
) STRICT;

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY
    CHECK (
      length(session_hash) = 64
      AND session_hash NOT GLOB '*[^0-9a-f]*'
    ),
  principal_slot INTEGER NOT NULL,
  authorization_generation INTEGER NOT NULL
    CHECK (authorization_generation >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms >= created_at_ms),
  FOREIGN KEY (principal_slot) REFERENCES principals(slot) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER invitation_terminal_state_is_immutable
BEFORE UPDATE OF revoked_at_ms, consumed_at_ms ON invitations
WHEN OLD.revoked_at_ms IS NOT NULL OR OLD.consumed_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'terminal invitation state is immutable');
END;

CREATE TRIGGER invitation_identity_is_immutable
BEFORE UPDATE OF invitation_id, token_hash, principal_slot, purpose,
  required_generation, created_at_ms, expires_at_ms ON invitations
BEGIN
  SELECT RAISE(ABORT, 'invitation identity and binding are immutable');
END;

CREATE TRIGGER terminal_invitation_cannot_gain_pending_state
BEFORE UPDATE OF pending_claim_hash, pending_expires_at_ms ON invitations
WHEN (OLD.revoked_at_ms IS NOT NULL OR OLD.consumed_at_ms IS NOT NULL)
  AND (NEW.pending_claim_hash IS NOT NULL OR NEW.pending_expires_at_ms IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'terminal invitation cannot gain pending state');
END;

CREATE TRIGGER invitation_consumption_requires_eligibility
BEFORE UPDATE OF consumed_at_ms ON invitations
WHEN NEW.consumed_at_ms IS NOT NULL
  AND (
    OLD.consumed_at_ms IS NOT NULL
    OR OLD.revoked_at_ms IS NOT NULL
    OR NEW.consumed_at_ms >= OLD.expires_at_ms
    OR NOT EXISTS (
      SELECT 1
      FROM principals AS p
      JOIN credentials AS c ON c.principal_slot = p.slot
      WHERE p.slot = OLD.principal_slot
        AND p.authorization_state = 'active'
        AND c.authorization_state = 'active'
        AND c.activated_generation = p.authorization_generation
        AND (
          (OLD.purpose = 'initial' AND OLD.required_generation IS NULL AND p.authorization_generation = 1)
          OR (
            OLD.purpose = 'replacement'
            AND OLD.required_generation IS NOT NULL
            AND p.authorization_generation = OLD.required_generation + 1
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invitation is not eligible for consumption');
END;

CREATE TRIGGER sessions_require_current_authorization
BEFORE INSERT ON sessions
WHEN NOT EXISTS (
  SELECT 1
  FROM principals AS p
  JOIN credentials AS c ON c.principal_slot = p.slot
  WHERE p.slot = NEW.principal_slot
    AND p.authorization_state = 'active'
    AND c.authorization_state = 'active'
    AND p.authorization_generation = NEW.authorization_generation
    AND c.activated_generation = p.authorization_generation
)
BEGIN
  SELECT RAISE(ABORT, 'session requires current active authorization');
END;

CREATE TRIGGER sessions_keep_binding
BEFORE UPDATE OF session_hash, principal_slot, authorization_generation,
  created_at_ms, expires_at_ms ON sessions
BEGIN
  SELECT RAISE(ABORT, 'session binding is immutable');
END;

CREATE TRIGGER session_revocation_is_terminal
BEFORE UPDATE OF revoked_at_ms ON sessions
WHEN OLD.revoked_at_ms IS NOT NULL
  AND (NEW.revoked_at_ms IS NULL OR NEW.revoked_at_ms != OLD.revoked_at_ms)
BEGIN
  SELECT RAISE(ABORT, 'session revocation is terminal');
END;

CREATE TRIGGER principal_reset_requires_revoked_sessions
BEFORE UPDATE OF authorization_state ON principals
WHEN NEW.authorization_state = 'reset'
  AND EXISTS (
    SELECT 1
    FROM sessions
    WHERE principal_slot = OLD.slot AND revoked_at_ms IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'sessions must be revoked before principal reset');
END;

CREATE INDEX invitations_by_eligibility
  ON invitations (token_hash, principal_slot, purpose, expires_at_ms)
  WHERE revoked_at_ms IS NULL AND consumed_at_ms IS NULL;

CREATE INDEX invitations_by_cleanup
  ON invitations (expires_at_ms, revoked_at_ms, consumed_at_ms);

CREATE INDEX sessions_by_principal
  ON sessions (principal_slot, revoked_at_ms, expires_at_ms);

CREATE INDEX sessions_by_cleanup
  ON sessions (expires_at_ms, revoked_at_ms);
