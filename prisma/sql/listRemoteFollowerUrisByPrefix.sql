-- @param {String} $1:accountId
-- @param {String} $2:prefix
-- The URIs of the account's accepted remote followers that are `prefix` or
-- under `prefix/`, compared case-sensitively (Mastodon's
-- `Account.matches_uri_prefix`). The range keeps the read on the account's
-- follower URIs; the last test leaves out other hosts that start alike.
SELECT remote_actor_uri
FROM remote_follows
WHERE target_account_id = $1
  AND remote_actor_uri >= $2
  AND remote_actor_uri < $2 || '0'
  AND (remote_actor_uri = $2 OR substr(remote_actor_uri, length($2) + 1, 1) = '/')
  AND follow_kind = 'Accepted'
