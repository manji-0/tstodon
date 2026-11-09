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
-- @param {Int} $13:avatarFileSize?
-- @param {Int} $14:headerFileSize?
INSERT INTO account_profiles (
  account_id, note, fields_json, bot, discoverable, indexable, hide_collections,
  avatar_object_key, avatar_content_type, header_object_key, header_content_type, updated_at,
  avatar_metadata_stripped_at, header_metadata_stripped_at, avatar_file_size, header_file_size
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
  CASE WHEN $8 IS NULL THEN NULL ELSE $12 END, CASE WHEN $10 IS NULL THEN NULL ELSE $12 END,
  CASE WHEN $8 IS NULL THEN NULL ELSE $13 END, CASE WHEN $10 IS NULL THEN NULL ELSE $14 END
)
ON CONFLICT(account_id) DO UPDATE SET
  note = $2, fields_json = $3, bot = $4, discoverable = $5,
  indexable = $6, hide_collections = $7,
  avatar_object_key = $8, avatar_content_type = $9,
  header_object_key = $10, header_content_type = $11, updated_at = $12,
  -- A new key is a new upload, stored stripped of its metadata (the backfill
  -- skips it); the same key keeps its marks.
  avatar_metadata_stripped_at = CASE
    WHEN $8 IS NULL THEN NULL
    WHEN avatar_object_key IS $8 THEN avatar_metadata_stripped_at
    ELSE $12 END,
  avatar_metadata_strip_error = CASE
    WHEN avatar_object_key IS $8 THEN avatar_metadata_strip_error END,
  header_metadata_stripped_at = CASE
    WHEN $10 IS NULL THEN NULL
    WHEN header_object_key IS $10 THEN header_metadata_stripped_at
    ELSE $12 END,
  header_metadata_strip_error = CASE
    WHEN header_object_key IS $10 THEN header_metadata_strip_error END,
  -- A new key takes the size of the new upload; the same key keeps
  -- the size the backfills recorded; no image has no size.
  avatar_file_size = CASE
    WHEN $8 IS NULL THEN NULL
    WHEN avatar_object_key IS $8 THEN COALESCE(avatar_file_size, $13)
    ELSE $13 END,
  header_file_size = CASE
    WHEN $10 IS NULL THEN NULL
    WHEN header_object_key IS $10 THEN COALESCE(header_file_size, $14)
    ELSE $14 END
