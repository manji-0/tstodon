-- Mastodon's silent mention (`mentions.silent`): a row that grants the
-- account access to the note without counting as a mention they were told
-- about. A quote's `ensure_quoted_access` writes one for the quoted author.

ALTER TABLE remote_status_mentions ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
