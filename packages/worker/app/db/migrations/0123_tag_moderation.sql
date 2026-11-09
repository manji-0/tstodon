-- What an admin decides about a hashtag (`/api/v1/admin/tags`), as Mastodon's
-- `tags` columns: `usable` (posts may use it: its timeline lists posts and
-- accounts may feature it), `listable` (it appears in search and trends) and
-- `display_name` (another casing of the name, shown as the tag's name).
-- `trendable` stays in `trend_reviews`, where approving or rejecting a
-- trending tag already records it.

ALTER TABLE tags ADD COLUMN usable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tags ADD COLUMN listable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tags ADD COLUMN display_name TEXT;
