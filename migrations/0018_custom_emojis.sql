-- Admin-managed custom emojis. Images live in the media bucket under `emoji/`.
-- The CUSTOM_EMOJIS var still provides read-only, config-supplied emojis.

CREATE TABLE IF NOT EXISTS custom_emojis (
    id TEXT PRIMARY KEY,
    shortcode TEXT NOT NULL UNIQUE,
    object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    visible_in_picker INTEGER NOT NULL DEFAULT 1,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_custom_emojis_shortcode
    ON custom_emojis (shortcode);
