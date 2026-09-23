-- @param {String} $1:id
-- @param {String} $2:remoteActorUri
-- @param {String} $3:targetAccountId
-- @param {String} $4:remoteRequestKind
-- @param {String} $5:followKind
-- @param {String} $6:createdAt
INSERT INTO remote_follows (
  id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at
) VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT(remote_actor_uri, target_account_id) DO UPDATE SET
  remote_request_kind = excluded.remote_request_kind,
  follow_kind = excluded.follow_kind
