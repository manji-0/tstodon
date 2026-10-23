-- Accounts a viewer removed from their follow suggestions
-- (`DELETE /api/v1/suggestions/:account_id`). Suggestions skip these for good.

CREATE TABLE suggestion_dismissals (
  account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, target_account_id)
);
