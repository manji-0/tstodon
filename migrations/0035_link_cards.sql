-- Link previews: a per-status card plus a small URL cache so the same link is
-- only unfurled once.

ALTER TABLE statuses ADD COLUMN card_json TEXT;

CREATE TABLE IF NOT EXISTS link_cards (
    url TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
