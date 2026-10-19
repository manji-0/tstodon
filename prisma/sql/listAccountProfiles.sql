-- @param {String} $1:idsJson
SELECT account_id, note, fields_json, bot, discoverable,
       avatar_object_key, avatar_content_type, header_object_key, header_content_type
FROM account_profiles
WHERE account_id IN (SELECT value FROM json_each($1))
