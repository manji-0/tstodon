-- @param {String} $1:accountId
SELECT data_json FROM web_settings WHERE account_id = $1
