CREATE TABLE IF NOT EXISTS remote_actors (
    actor_uri TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    domain TEXT NOT NULL,
    inbox_uri TEXT NOT NULL,
    shared_inbox_uri TEXT,
    public_key_id TEXT NOT NULL UNIQUE,
    public_key_pem TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_remote_actors_domain_username
    ON remote_actors (domain, username);

CREATE TABLE IF NOT EXISTS remote_follows (
    id TEXT PRIMARY KEY,
    remote_actor_uri TEXT NOT NULL,
    target_account_id TEXT NOT NULL,
    remote_request_kind TEXT NOT NULL,
    follow_kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (remote_actor_uri, target_account_id),
    FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_follows_target
    ON remote_follows (target_account_id, follow_kind);
