-- @param {String} $1:accountId
-- @param {String} $2:note
-- @param {String} $3:fieldsJson
-- @param {Int} $4:bot
-- @param {Int} $5:discoverable
-- @param {Int} $6:indexable
-- @param {Int} $7:hideCollections
-- @param {String} $8:avatarObjectKey?
-- @param {String} $9:avatarContentType?
-- @param {String} $10:headerObjectKey?
-- @param {String} $11:headerContentType?
-- @param {String} $12:now
INSERT INTO account_profiles (
  account_id, note, fields_json, bot, discoverable, indexable, hide_collections,
  avatar_object_key, avatar_content_type, header_object_key, header_content_type, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT(account_id) DO UPDATE SET
  note = $2, fields_json = $3, bot = $4, discoverable = $5,
  indexable = $6, hide_collections = $7,
  avatar_object_key = $8, avatar_content_type = $9,
  header_object_key = $10, header_content_type = $11, updated_at = $12
