-- @param {String} $1:accountId
SELECT account_id, note, fields_json, bot, discoverable FROM account_profiles WHERE account_id = $1
