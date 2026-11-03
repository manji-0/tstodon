-- The account a notification points at besides its sender: the new account of
-- a `move` notification (Mastodon renders it as `target`).
ALTER TABLE notifications ADD COLUMN target_account_id TEXT;
