-- @param {String} $1:accountId
-- @param {String} $2:actorUri
-- @param {Int} $3:reblogs?
-- @param {Int} $4:notify?
-- @param {String} $5:languagesJson?
UPDATE outbound_follows
SET reblogs = COALESCE($3, reblogs),
  notify = COALESCE($4, notify),
  languages_json = COALESCE($5, languages_json)
WHERE account_id = $1 AND actor_uri = $2
