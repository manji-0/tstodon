-- Mastodon's per-follow options: whether the follow shows up in the home
-- timeline (`reblogs`), whether every new status notifies (`notify`), and the
-- languages to keep from that account (`languages_json`, a JSON array).

ALTER TABLE follows ADD COLUMN reblogs INTEGER NOT NULL DEFAULT 1;
ALTER TABLE follows ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
ALTER TABLE follows ADD COLUMN languages_json TEXT NOT NULL DEFAULT '[]';
