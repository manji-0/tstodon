-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:targetAccountId
-- @param {String} $4:statusIdsJson
-- @param {String} $5:comment
-- @param {String} $6:createdAt
INSERT INTO reports (id, account_id, target_account_id, status_ids_json, comment, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
