ALTER TABLE credentials ADD COLUMN signature_counter INTEGER NOT NULL DEFAULT 0
  CHECK (signature_counter BETWEEN 0 AND 4294967295);

ALTER TABLE credentials ADD COLUMN canonical_transports TEXT
  CHECK (
    canonical_transports IS NULL
    OR (
      length(canonical_transports) BETWEEN 3 AND 128
      AND canonical_transports NOT GLOB '*[^a-z,-]*'
    )
  );

ALTER TABLE invitations ADD COLUMN pending_principal_id TEXT
  CHECK (
    pending_principal_id IS NULL
    OR length(pending_principal_id) = 43
  );

ALTER TABLE invitations ADD COLUMN committed_claim_hash TEXT
  CHECK (
    committed_claim_hash IS NULL
    OR (
      length(committed_claim_hash) = 64
      AND committed_claim_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE sessions ADD COLUMN csrf_hash TEXT
  CHECK (
    csrf_hash IS NULL
    OR (
      length(csrf_hash) = 64
      AND csrf_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE UNIQUE INDEX invitations_by_committed_claim
  ON invitations (committed_claim_hash)
  WHERE committed_claim_hash IS NOT NULL;

CREATE TRIGGER invitation_pending_principal_requires_pending_claim
BEFORE UPDATE OF pending_principal_id ON invitations
WHEN NEW.pending_principal_id IS NOT NULL
  AND (
    NEW.pending_claim_hash IS NULL
    OR NEW.pending_expires_at_ms IS NULL
    OR NEW.revoked_at_ms IS NOT NULL
    OR NEW.consumed_at_ms IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'pending principal requires active pending claim');
END;

CREATE TRIGGER invitation_commit_proof_is_terminal
BEFORE UPDATE OF committed_claim_hash ON invitations
WHEN NEW.committed_claim_hash IS NOT NULL
  AND (
    OLD.committed_claim_hash IS NOT NULL
    OR NEW.consumed_at_ms IS NULL
    OR NEW.revoked_at_ms IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'invitation commit proof is terminal');
END;

CREATE TRIGGER invitation_commit_proof_is_immutable
BEFORE UPDATE OF committed_claim_hash ON invitations
WHEN OLD.committed_claim_hash IS NOT NULL
  AND NEW.committed_claim_hash IS NOT OLD.committed_claim_hash
BEGIN
  SELECT RAISE(ABORT, 'invitation commit proof is immutable');
END;

CREATE TRIGGER session_csrf_binding_is_immutable
BEFORE UPDATE OF csrf_hash ON sessions
BEGIN
  SELECT RAISE(ABORT, 'session csrf binding is immutable');
END;

CREATE TABLE webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY
    CHECK (
      length(challenge_hash) = 64
      AND challenge_hash NOT GLOB '*[^0-9a-f]*'
    ),
  owner_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(owner_hash) = 64
      AND owner_hash NOT GLOB '*[^0-9a-f]*'
    ),
  csrf_hash TEXT NOT NULL
    CHECK (
      length(csrf_hash) = 64
      AND csrf_hash NOT GLOB '*[^0-9a-f]*'
    ),
  ceremony_type TEXT NOT NULL
    CHECK (ceremony_type IN ('registration', 'authentication')),
  invitation_id TEXT,
  enrollment_claim_hash TEXT
    CHECK (
      enrollment_claim_hash IS NULL
      OR (
        length(enrollment_claim_hash) = 64
        AND enrollment_claim_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
  candidate_principal_id TEXT
    CHECK (
      candidate_principal_id IS NULL
      OR length(candidate_principal_id) = 43
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  CHECK (
    (
      ceremony_type = 'registration'
      AND invitation_id IS NOT NULL
      AND enrollment_claim_hash IS NOT NULL
      AND candidate_principal_id IS NOT NULL
    )
    OR (
      ceremony_type = 'authentication'
      AND invitation_id IS NULL
      AND enrollment_claim_hash IS NULL
      AND candidate_principal_id IS NULL
    )
  ),
  FOREIGN KEY (invitation_id) REFERENCES invitations(invitation_id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX webauthn_challenges_by_expiry
  ON webauthn_challenges (expires_at_ms, challenge_hash);

CREATE UNIQUE INDEX webauthn_registration_challenges_by_claim
  ON webauthn_challenges (enrollment_claim_hash)
  WHERE ceremony_type = 'registration';

CREATE TRIGGER webauthn_authentication_challenges_live_cardinality
BEFORE INSERT ON webauthn_challenges
WHEN NEW.ceremony_type = 'authentication'
BEGIN
  DELETE FROM webauthn_challenges
  WHERE expires_at_ms <= NEW.created_at_ms;

  DELETE FROM webauthn_challenges
  WHERE challenge_hash = (
    SELECT challenge_hash
    FROM webauthn_challenges
    WHERE ceremony_type = 'authentication'
    ORDER BY created_at_ms, challenge_hash
    LIMIT 1
  )
  AND (
    SELECT COUNT(*)
    FROM webauthn_challenges
    WHERE ceremony_type = 'authentication'
  ) >= 64;
END;
