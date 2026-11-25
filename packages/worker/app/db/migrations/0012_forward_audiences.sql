-- The local accounts whose remote followers a forward reaches
-- (`ActivityPub::Forwarder#inboxes`): the local accounts that boosted or
-- quoted the status, and the local author it replies to. Stored with the
-- forward when the inbound activity arrives, as Mastodon reads them before
-- it applies the activity (a `Delete` removes the boosts). The
-- `ExpandForward` jobs page over them by account id, and the last one
-- deletes them.
CREATE TABLE forward_audiences (
  activity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (activity_id, account_id),
  FOREIGN KEY (activity_id) REFERENCES outbound_activities(id) ON DELETE CASCADE
) WITHOUT ROWID;
