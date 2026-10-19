-- @param {String} $1:accountId
-- @param {String} $2:note
-- @param {String} $3:fieldsJson
-- @param {Int} $4:bot
-- @param {Int} $5:discoverable
-- @param {String} $6:avatarObjectKey?
-- @param {String} $7:avatarContentType?
-- @param {String} $8:headerObjectKey?
-- @param {String} $9:headerContentType?
-- @param {String} $10:now
INSERT INTO account_profiles (
  account_id, note, fields_json, bot, discoverable,
  avatar_object_key, avatar_content_type, header_object_key, header_content_type, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT(account_id) DO UPDATE SET
  note = $2, fields_json = $3, bot = $4, discoverable = $5,
  avatar_object_key = $6, avatar_content_type = $7,
  header_object_key = $8, header_content_type = $9, updated_at = $10
