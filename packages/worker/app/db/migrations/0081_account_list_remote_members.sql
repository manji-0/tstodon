-- A remote actor on a local account's list. As in Mastodon, where a list
-- account belongs to the owner's follow, the member is the owner's accepted
-- follow of the actor: unfollowing, a `Reject`, or a `Move` deletes the
-- follow and with it every membership.
CREATE TABLE account_list_remote_members (
  list_id TEXT NOT NULL,
  outbound_follow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (list_id, outbound_follow_id),
  FOREIGN KEY (list_id) REFERENCES account_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (outbound_follow_id) REFERENCES outbound_follows(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_list_remote_members_follow
  ON account_list_remote_members (outbound_follow_id, list_id);
