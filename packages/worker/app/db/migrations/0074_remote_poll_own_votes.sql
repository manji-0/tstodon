-- A local account's votes on a poll a remote `Question` carries. One row per
-- chosen option; `activity_id` is the `Create` that carried the vote to the
-- author. `optimistic` is 1 while the vote is added to the cached counts on
-- top of the author's own tally, and 0 once the author's next count refresh
-- has replaced them.
CREATE TABLE remote_poll_own_votes (
  status_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  choice_index INTEGER NOT NULL,
  activity_id TEXT NOT NULL,
  optimistic INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (status_id, account_id, choice_index),
  FOREIGN KEY (status_id) REFERENCES remote_statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
