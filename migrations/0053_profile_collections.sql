-- Account preferences that Mastodon reports on every account document:
-- `indexable` (search-engine indexing) and `hide_collections` (hide the
-- followers/following lists from everyone but the account itself).

ALTER TABLE account_profiles ADD COLUMN indexable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE account_profiles ADD COLUMN hide_collections INTEGER NOT NULL DEFAULT 0;
