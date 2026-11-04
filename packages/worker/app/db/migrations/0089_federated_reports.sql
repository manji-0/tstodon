-- void:allow-destructive
-- (Void gate: the DROP TABLE belongs to a SQLite table rebuild; rows are copied first.)
-- Reports federate as Mastodon's do. Either side of a report can be a remote
-- actor: the reporter of a `Flag` received from another server, and the
-- target of a report a local user files against a remote account. Each side
-- is a local account (`account_id`, `target_account_id`) or a remote actor
-- URI (`reporter_actor_uri`, `target_actor_uri`), exactly one of the two.
--
-- `flag_uri` is the id of the `Flag` a remote report arrived as, so a
-- redelivered `Flag` files no second report. `forwarded` is set when a local
-- report was forwarded to the target's server.
--
-- Nothing references `reports`, so the rebuild needs no scratch tables.

CREATE TABLE reports_new (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    reporter_actor_uri TEXT,
    target_account_id TEXT,
    target_actor_uri TEXT,
    status_ids_json TEXT NOT NULL DEFAULT '[]',
    comment TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    assigned_account_id TEXT,
    rule_ids_json TEXT NOT NULL DEFAULT '[]',
    action_taken_at TEXT,
    action_taken_by_account_id TEXT,
    forwarded INTEGER NOT NULL DEFAULT 0,
    flag_uri TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    CHECK ((account_id IS NULL) <> (reporter_actor_uri IS NULL)),
    CHECK ((target_account_id IS NULL) <> (target_actor_uri IS NULL))
);

INSERT INTO reports_new (id, account_id, target_account_id, status_ids_json, comment, category,
                         assigned_account_id, rule_ids_json, action_taken_at,
                         action_taken_by_account_id, created_at, updated_at)
  SELECT id, account_id, target_account_id, status_ids_json, comment, category,
         assigned_account_id, rule_ids_json, action_taken_at,
         action_taken_by_account_id, created_at, updated_at
  FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

CREATE INDEX idx_reports_account ON reports (account_id);
CREATE INDEX idx_reports_reporter_actor ON reports (reporter_actor_uri);
CREATE INDEX idx_reports_target_account ON reports (target_account_id);
CREATE INDEX idx_reports_target_actor ON reports (target_actor_uri);
