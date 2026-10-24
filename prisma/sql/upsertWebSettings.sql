-- @param {String} $1:accountId
-- @param {String} $2:dataJson
-- @param {String} $3:now
INSERT INTO web_settings (account_id, data_json, updated_at) VALUES ($1, $2, $3)
ON CONFLICT (account_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
