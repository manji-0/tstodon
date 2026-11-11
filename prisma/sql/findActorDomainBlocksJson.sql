-- @param {String} $1:accountId
-- @param {String} $2:actorUrisJson
-- The actors the account blocks by either host, as `findActorDomainBlock` decides one.
SELECT ra.actor_uri FROM remote_actors ra
WHERE ra.actor_uri IN (SELECT value FROM json_each($2))
  AND EXISTS (
    SELECT 1 FROM account_domain_blocks adb
    WHERE adb.account_id = $1 AND adb.domain IN (ra.host, ra.uri_host)
  )
