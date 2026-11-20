-- @param {String} $1:verifiedAt
-- @param {String} $2:accountId
-- @param {Int} $3:fieldIndex
-- @param {String} $4:value
-- Only while the field still holds the value that was checked.
UPDATE account_profiles
SET fields_json = json_set(fields_json, '$[' || CAST($3 AS INTEGER) || '].verifiedAt', $1)
WHERE account_id = $2 AND json_extract(fields_json, '$[' || CAST($3 AS INTEGER) || '].value') = $4
