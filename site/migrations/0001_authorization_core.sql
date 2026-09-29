CREATE TABLE principal_slots (
  slot INTEGER PRIMARY KEY CHECK (slot IN (1, 2)),
  ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal IN (1, 2) AND ordinal = slot)
) STRICT;

INSERT INTO principal_slots (slot, ordinal) VALUES (1, 1), (2, 2);

CREATE TRIGGER principal_slots_are_immutable_on_update
BEFORE UPDATE ON principal_slots
BEGIN
  SELECT RAISE(ABORT, 'principal slots are immutable');
END;

CREATE TRIGGER principal_slots_are_immutable_on_delete
BEFORE DELETE ON principal_slots
BEGIN
  SELECT RAISE(ABORT, 'principal slots are immutable');
END;

CREATE TABLE principals (
  slot INTEGER PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE
    CHECK (length(principal_id) BETWEEN 16 AND 128),
  credential_slot INTEGER NOT NULL UNIQUE CHECK (credential_slot = slot),
  authorization_generation INTEGER NOT NULL
    CHECK (authorization_generation >= 1),
  authorization_state TEXT NOT NULL
    CHECK (authorization_state IN ('active', 'reset')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (slot) REFERENCES principal_slots(slot) ON DELETE RESTRICT,
  FOREIGN KEY (credential_slot) REFERENCES credentials(principal_slot)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE credentials (
  principal_slot INTEGER PRIMARY KEY,
  credential_identifier BLOB NOT NULL UNIQUE
    CHECK (
      typeof(credential_identifier) = 'blob'
      AND length(credential_identifier) BETWEEN 1 AND 4096
    ),
  verification_material BLOB NOT NULL
    CHECK (
      typeof(verification_material) = 'blob'
      AND length(verification_material) BETWEEN 1 AND 16384
    ),
  authorization_state TEXT NOT NULL
    CHECK (authorization_state IN ('active', 'revoked')),
  activated_generation INTEGER NOT NULL CHECK (activated_generation >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (principal_slot) REFERENCES principals(slot) ON DELETE RESTRICT
) STRICT;

CREATE TABLE transaction_assertions (
  assertion_id TEXT PRIMARY KEY CHECK (length(assertion_id) BETWEEN 1 AND 256),
  satisfied INTEGER NOT NULL CHECK (satisfied = 1)
) STRICT;

CREATE TRIGGER principals_require_initial_state
BEFORE INSERT ON principals
WHEN NEW.authorization_generation != 1 OR NEW.authorization_state != 'active'
BEGIN
  SELECT RAISE(ABORT, 'invalid initial principal state');
END;

CREATE TRIGGER principals_keep_stable_identity
BEFORE UPDATE OF slot, principal_id, credential_slot ON principals
BEGIN
  SELECT RAISE(ABORT, 'principal identity is immutable');
END;

CREATE TRIGGER principals_are_stable
BEFORE DELETE ON principals
BEGIN
  SELECT RAISE(ABORT, 'principal records are stable');
END;

CREATE TRIGGER principal_generation_must_increment_once
BEFORE UPDATE OF authorization_generation ON principals
WHEN NEW.authorization_generation != OLD.authorization_generation + 1
BEGIN
  SELECT RAISE(ABORT, 'authorization generation must increment by one');
END;

CREATE TRIGGER principal_reactivation_requires_generation
BEFORE UPDATE OF authorization_state ON principals
WHEN OLD.authorization_state = 'reset'
  AND NEW.authorization_state = 'active'
  AND NEW.authorization_generation != OLD.authorization_generation + 1
BEGIN
  SELECT RAISE(ABORT, 'reactivation must advance authorization generation');
END;

CREATE TRIGGER principal_reset_requires_revoked_credential
BEFORE UPDATE OF authorization_state ON principals
WHEN NEW.authorization_state = 'reset'
  AND EXISTS (
    SELECT 1
    FROM credentials
    WHERE principal_slot = OLD.slot AND authorization_state != 'revoked'
  )
BEGIN
  SELECT RAISE(ABORT, 'credential must be revoked before principal reset');
END;

CREATE TRIGGER credentials_require_active_principal_on_insert
BEFORE INSERT ON credentials
WHEN NEW.authorization_state != 'active'
  OR NOT EXISTS (
    SELECT 1
    FROM principals
    WHERE slot = NEW.principal_slot
      AND authorization_state = 'active'
      AND authorization_generation = NEW.activated_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'credential requires matching active principal');
END;

CREATE TRIGGER credentials_keep_stable_slot
BEFORE UPDATE OF principal_slot ON credentials
BEGIN
  SELECT RAISE(ABORT, 'credential slot is immutable');
END;

CREATE TRIGGER credentials_are_stable
BEFORE DELETE ON credentials
BEGIN
  SELECT RAISE(ABORT, 'credential records are replaceable, not deletable');
END;

CREATE TRIGGER credential_generation_cannot_decrease
BEFORE UPDATE OF activated_generation ON credentials
WHEN NEW.activated_generation < OLD.activated_generation
BEGIN
  SELECT RAISE(ABORT, 'credential generation cannot decrease');
END;

CREATE TRIGGER active_credential_requires_current_principal
BEFORE UPDATE ON credentials
WHEN NEW.authorization_state = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM principals
    WHERE slot = NEW.principal_slot
      AND authorization_state = 'active'
      AND authorization_generation = NEW.activated_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'active credential must match current principal generation');
END;

CREATE INDEX principals_by_state
  ON principals (authorization_state, slot);

CREATE UNIQUE INDEX principals_by_slot_and_generation
  ON principals (slot, authorization_generation);

CREATE INDEX credentials_by_state
  ON credentials (authorization_state, principal_slot);
