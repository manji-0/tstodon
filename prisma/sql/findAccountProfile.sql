-- @param {String} $1:accountId
SELECT account_id, note, fields_json, bot, discoverable,
       avatar_object_key, avatar_content_type, header_object_key, header_content_type
FROM account_profiles WHERE account_id = $1
