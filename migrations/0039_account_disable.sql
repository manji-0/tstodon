-- Mastodon's `disable` moderation action: the login is blocked while the
-- account stays visible. A separate bit from silence and suspension.

ALTER TABLE account_flags ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
