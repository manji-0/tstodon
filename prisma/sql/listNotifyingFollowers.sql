-- @param {String} $1:accountId
-- @param {String} $2:now
-- A follower who mutes the account, notifications on or not, is left out:
-- Mastodon's `filter_from_home` filters a muted author's status.
SELECT f.follower_account_id, f.languages_json FROM follows f
WHERE f.target_account_id = $1 AND f.follower_account_id != $1 AND f.kind = 'Accepted' AND f.notify != 0
  AND NOT EXISTS (
    SELECT 1 FROM mutes m
    WHERE m.account_id = f.follower_account_id AND m.target_account_id = $1
      AND (m.expires_at IS NULL OR m.expires_at > $2)
  )
