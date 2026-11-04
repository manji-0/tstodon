-- @param {String} $1:id
-- @param {String} $2:accountId?
-- @param {String} $3:reporterActorUri?
-- @param {String} $4:targetAccountId?
-- @param {String} $5:targetActorUri?
-- @param {String} $6:statusIdsJson
-- @param {String} $7:comment
-- @param {String} $8:category
-- @param {String} $9:ruleIdsJson
-- @param {Int} $10:forwarded
-- @param {String} $11:flagUri?
-- @param {String} $12:createdAt
-- @param {String} $13:reporterAcct?
-- @param {String} $14:targetAcct?
-- No row comes back when a report for the same `Flag` was already filed.
INSERT INTO reports (id, account_id, reporter_actor_uri, target_account_id, target_actor_uri,
                     status_ids_json, comment, category, rule_ids_json, forwarded, flag_uri,
                     created_at, reporter_acct, target_acct)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (flag_uri) DO NOTHING
RETURNING id
