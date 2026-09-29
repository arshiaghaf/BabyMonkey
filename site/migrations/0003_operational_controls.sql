CREATE TABLE notification_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO notification_control (singleton, enabled, revision, updated_at_ms)
VALUES (1, 0, 1, 0);

CREATE TABLE operational_reservations (
  principal_slot INTEGER PRIMARY KEY,
  authorization_generation INTEGER NOT NULL
    CHECK (authorization_generation >= 1),
  idempotency_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(idempotency_hash) = 64
      AND idempotency_hash NOT GLOB '*[^0-9a-f]*'
    ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled')),
  reserved_at_ms INTEGER NOT NULL CHECK (reserved_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > reserved_at_ms),
  cooldown_until_ms INTEGER NOT NULL CHECK (cooldown_until_ms >= reserved_at_ms),
  CHECK (state != 'reserved' OR expires_at_ms <= cooldown_until_ms),
  FOREIGN KEY (principal_slot, authorization_generation)
    REFERENCES principals(slot, authorization_generation) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER notification_singleton_cannot_move
BEFORE UPDATE OF singleton ON notification_control
BEGIN
  SELECT RAISE(ABORT, 'notification singleton is immutable');
END;

CREATE TRIGGER notification_singleton_cannot_be_deleted
BEFORE DELETE ON notification_control
BEGIN
  SELECT RAISE(ABORT, 'notification singleton cannot be deleted');
END;

CREATE TRIGGER notification_revision_must_increment_once
BEFORE UPDATE ON notification_control
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'notification revision must increment by one');
END;

CREATE INDEX operational_reservations_by_cleanup
  ON operational_reservations (expires_at_ms, cooldown_until_ms);
