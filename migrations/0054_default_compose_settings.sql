-- Account-level posting defaults that Mastodon exposes through `source`:
-- the language and `sensitive` flag a new status inherits when it omits them.

ALTER TABLE accounts ADD COLUMN default_language TEXT;
ALTER TABLE accounts ADD COLUMN default_sensitive INTEGER NOT NULL DEFAULT 0;
