-- Remote direct messages reach `/api/v1/conversations` and the direct
-- timeline: `remote_status_mentions` records which local accounts a cached
-- remote note addresses, and `in_reply_to_uri` keeps the note's `inReplyTo`
-- so replies group into one conversation.

ALTER TABLE remote_statuses ADD COLUMN in_reply_to_uri TEXT;

CREATE TABLE remote_status_mentions (
  status_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (status_id, account_id),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_remote_status_mentions_account
  ON remote_status_mentions (account_id, status_id DESC);

-- Notes cached before this migration kept no addressing, but each mention
-- notification names the account a remote note addressed.
INSERT OR IGNORE INTO remote_status_mentions (status_id, account_id)
  SELECT n.status_id, n.account_id FROM notifications n
  WHERE n.kind = 'mention' AND n.status_id IN (SELECT id FROM remote_statuses)
    AND n.account_id IN (SELECT id FROM accounts);
