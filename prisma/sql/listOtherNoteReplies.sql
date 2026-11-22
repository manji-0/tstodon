-- @param {String} $1:statusId
-- @param {String} $2:authorId
-- @param {String} $3:noteUri
-- @param {String} $4:afterId
-- @param {Int} $5:limit
-- Up to `limit` public and unlisted replies to the local note `statusId` (at
-- `noteUri`) by accounts other than its author `authorId`, after `afterId`
-- ('' for the first page), in one id order whether local (with `username`)
-- or cached from another server (with `object_uri`), as Mastodon's
-- `only_other_accounts` page. Leaves out suspended accounts and the actors of
-- the servers the instance suspends (a suspension of a domain covers its
-- subdomains).
SELECT id, username, object_uri
FROM (
  SELECT s.id, a.username, NULL AS object_uri
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
  WHERE s.in_reply_to_id = $1 AND s.kind = 'LocalNote'
    AND s.visibility IN ('public', 'unlisted')
    AND s.id > $4
    AND s.account_id <> $2
    AND s.account_id NOT IN (SELECT account_id FROM account_moderation WHERE moderation = 'Suspended')
  ORDER BY s.id
  LIMIT $5
)
UNION ALL
SELECT id, username, object_uri
FROM (
  SELECT r.id, NULL AS username, r.object_uri
  FROM remote_statuses r
  WHERE r.in_reply_to_uri = $3
    AND r.visibility IN ('public', 'unlisted')
    AND r.id > $4
    AND r.actor_uri NOT IN (
      SELECT actor_uri FROM remote_actor_moderation WHERE moderation = 'Suspended'
    )
    AND r.actor_uri NOT IN (
      SELECT actor_uri FROM remote_actor_domain_rules WHERE severity = 'suspend'
    )
  ORDER BY r.id
  LIMIT $5
)
ORDER BY id
LIMIT $5
