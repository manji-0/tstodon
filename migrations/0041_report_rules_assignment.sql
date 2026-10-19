-- Report metadata Mastodon lets moderators edit: the rules a violation broke
-- and the moderator who took the case.

ALTER TABLE reports ADD COLUMN assigned_account_id TEXT;
ALTER TABLE reports ADD COLUMN rule_ids_json TEXT NOT NULL DEFAULT '[]';
