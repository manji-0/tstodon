-- @param {String} $1:accountId
-- @param {String} $2:note
-- @param {String} $3:fieldsJson
-- @param {Int} $4:bot
-- @param {Int} $5:discoverable
-- @param {String} $6:now
INSERT INTO account_profiles (account_id, note, fields_json, bot, discoverable, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT(account_id) DO UPDATE SET
  note = $2, fields_json = $3, bot = $4, discoverable = $5, updated_at = $6
