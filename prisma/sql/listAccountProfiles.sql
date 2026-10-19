-- @param {String} $1:idsJson
SELECT account_id, note, fields_json, bot, discoverable FROM account_profiles
WHERE account_id IN (SELECT value FROM json_each($1))
