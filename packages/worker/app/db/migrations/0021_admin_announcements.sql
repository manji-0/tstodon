-- Admin-managed announcements. The ANNOUNCEMENTS var still supplies static
-- ones; these rows are authored at runtime and merged into the public list.

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    starts_at TEXT,
    ends_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_announcements_published
    ON announcements (published_at DESC, id DESC);
