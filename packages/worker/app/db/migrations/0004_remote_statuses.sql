CREATE TABLE IF NOT EXISTS remote_statuses (
    id TEXT PRIMARY KEY,
    actor_uri TEXT NOT NULL,
    object_uri TEXT NOT NULL UNIQUE,
    url TEXT,
    content_html TEXT NOT NULL,
    spoiler_text TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL,
    sensitive INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_uri) REFERENCES remote_actors(actor_uri) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_remote_statuses_visibility_published
    ON remote_statuses (visibility, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_remote_statuses_actor_published
    ON remote_statuses (actor_uri, published_at DESC);
