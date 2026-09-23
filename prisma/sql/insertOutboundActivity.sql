-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:kind
-- @param {String} $4:payloadJson
-- @param {String} $5:createdAt
INSERT INTO outbound_activities (id, account_id, kind, payload_json, created_at)
VALUES ($1, $2, $3, $4, $5)
