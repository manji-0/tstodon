-- @param {String} $1:verifiedAt
-- @param {String} $2:actorUri
-- @param {Int} $3:fieldIndex
-- @param {String} $4:value
-- Only while the field still holds the value that was checked.
UPDATE remote_actors
SET profile_json = json_set(profile_json, '$.fields[' || CAST($3 AS INTEGER) || '].verifiedAt', $1)
WHERE actor_uri = $2 AND json_extract(profile_json, '$.fields[' || CAST($3 AS INTEGER) || '].value') = $4
