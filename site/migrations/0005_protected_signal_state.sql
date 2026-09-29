ALTER TABLE operational_reservations ADD COLUMN session_hash TEXT
  CHECK (
    session_hash IS NULL
    OR (
      length(session_hash) = 64
      AND session_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE operational_reservations ADD COLUMN notification_revision INTEGER
  CHECK (notification_revision IS NULL OR notification_revision >= 1);

ALTER TABLE operational_reservations ADD COLUMN delivery_state TEXT
  CHECK (
    delivery_state IS NULL
    OR delivery_state IN ('confirmed', 'definitive_failure', 'ambiguous')
  );

ALTER TABLE operational_reservations ADD COLUMN settled_at_ms INTEGER
  CHECK (settled_at_ms IS NULL OR settled_at_ms >= reserved_at_ms);

CREATE INDEX operational_reservations_by_session
  ON operational_reservations (session_hash, authorization_generation);
