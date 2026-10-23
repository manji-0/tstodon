-- void:allow-destructive
-- (Void gate: the DROP TABLEs belong to a SQLite table rebuild; rows are copied first.)
-- Suggestion dismissals go away with either account, like every other
-- per-account row (0055 created the table without foreign keys).

CREATE TABLE suggestion_dismissals_new (
  account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, target_account_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

INSERT INTO suggestion_dismissals_new (account_id, target_account_id, created_at)
  SELECT d.account_id, d.target_account_id, d.created_at FROM suggestion_dismissals d
  WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = d.account_id)
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = d.target_account_id);

DROP TABLE suggestion_dismissals;
ALTER TABLE suggestion_dismissals_new RENAME TO suggestion_dismissals;
