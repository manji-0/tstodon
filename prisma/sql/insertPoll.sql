-- @param {String} $1:id
-- @param {String} $2:statusId
-- @param {Int} $3:multiple
-- @param {String} $4:expiresAt
-- @param {String} $5:optionsJson
INSERT INTO polls (id, status_id, multiple, expires_at, options_json)
VALUES ($1, $2, $3, $4, $5)
