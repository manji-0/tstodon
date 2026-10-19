-- Admin report workflow: the category a report was filed under, and the
-- resolution Mastodon tracks with `action_taken_at` / `action_taken_by_account`.

ALTER TABLE reports ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE reports ADD COLUMN action_taken_at TEXT;
ALTER TABLE reports ADD COLUMN action_taken_by_account_id TEXT;
ALTER TABLE reports ADD COLUMN updated_at TEXT;
