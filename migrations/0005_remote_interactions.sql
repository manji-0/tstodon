CREATE TABLE IF NOT EXISTS remote_favourites (
    remote_actor_uri TEXT NOT NULL,
    status_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (remote_actor_uri, status_id),
    FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_favourites_status
    ON remote_favourites (status_id);

CREATE TABLE IF NOT EXISTS remote_announces (
    remote_actor_uri TEXT NOT NULL,
    status_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (remote_actor_uri, status_id),
    FOREIGN KEY (remote_actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE,
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_announces_status
    ON remote_announces (status_id);
