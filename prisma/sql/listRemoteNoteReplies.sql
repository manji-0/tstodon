-- @param {String} $1:noteUri
-- @param {String} $2:afterId
-- @param {Int} $3:limit
-- The public and unlisted cached remote replies to the note at `noteUri`,
-- oldest stored first after `afterId` ('' for the first page), leaving out
-- the actors and the servers the instance suspends (a suspension of a domain
-- covers its subdomains).
SELECT r.id, r.object_uri
FROM remote_statuses r
WHERE r.in_reply_to_uri = $1
  AND r.visibility IN ('public', 'unlisted')
  AND r.id > $2
  AND r.actor_uri NOT IN (
    SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended'
  )
  AND r.actor_uri NOT IN (
    SELECT actor_uri FROM remote_actor_domain_rules WHERE severity = 'suspend'
  )
ORDER BY r.id
LIMIT $3
