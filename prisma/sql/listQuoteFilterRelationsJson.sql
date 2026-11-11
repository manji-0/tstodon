-- @param {String} $1:viewerId
-- @param {String} $2:accountIdsJson
-- @param {String} $3:actorUrisJson
-- @param {String} $4:now
-- What `StatusFilter#filter_state_for_quote` asks of the viewer and each quoted author: `target` is a local account id or a remote actor URI.
SELECT 'blocking' AS relation, COALESCE(target_account_id, target_actor_uri) AS target FROM blocks
WHERE blocker_account_id = $1
  AND (target_account_id IN (SELECT value FROM json_each($2))
    OR target_actor_uri IN (SELECT value FROM json_each($3)))
UNION ALL
SELECT 'muting' AS relation, COALESCE(target_account_id, target_actor_uri) AS target FROM mutes
WHERE account_id = $1
  AND (target_account_id IN (SELECT value FROM json_each($2))
    OR target_actor_uri IN (SELECT value FROM json_each($3)))
  AND (expires_at IS NULL OR expires_at > $4)
UNION ALL
SELECT 'domain_blocking' AS relation, remote_actors.actor_uri AS target FROM remote_actors
WHERE remote_actors.actor_uri IN (SELECT value FROM json_each($3))
  AND EXISTS (
    SELECT 1 FROM account_domain_blocks
    WHERE account_domain_blocks.account_id = $1
      AND account_domain_blocks.domain IN (remote_actors.host, remote_actors.uri_host)
  )
