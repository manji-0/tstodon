-- A status that mentions an account in a notification the account's policy
-- held back as a request (INT-2). As Mastodon's `NotifyService`, which adds a
-- direct message to the recipient's conversations only when its notification
-- is not filtered, the account's conversations leave the status out while
-- the row stands. `held` is 1 while the request holds the notification:
-- accepting the sender deletes those rows, as Mastodon's
-- `UnfilterNotificationsWorker` adds the held direct messages then.
-- Dismissing the request sets it to 0, as Mastodon deletes the filtered
-- notifications, so a later accept does not add the status.
CREATE TABLE withheld_conversation_statuses (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL,
  status_id TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, status_id)
);

CREATE INDEX idx_withheld_conversation_statuses_sender
  ON withheld_conversation_statuses (account_id, from_account_id);
