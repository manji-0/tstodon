-- void:allow-destructive
-- (Void gate: the DROP TABLE belongs to a SQLite table rebuild; rows are copied first.)
-- The instance actor (`/actor`, Mastodon's representative Application actor)
-- signs activities that speak for the server rather than for one of its
-- users, such as the `Flag` of a forwarded report. Its key pair is generated
-- on first use and kept in `instance_actor_keys`, which holds one row.
--
-- `outbound_activities.account_id` becomes nullable: NULL marks an activity
-- the instance actor signs. Nothing references `outbound_activities`, so the
-- rebuild needs no scratch tables.

CREATE TABLE instance_actor_keys (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    public_key_pem TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE outbound_activities_new (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT INTO outbound_activities_new (id, account_id, kind, payload_json, created_at)
  SELECT id, account_id, kind, payload_json, created_at FROM outbound_activities;

DROP TABLE outbound_activities;
ALTER TABLE outbound_activities_new RENAME TO outbound_activities;

CREATE INDEX idx_outbound_activities_account ON outbound_activities (account_id, id);
