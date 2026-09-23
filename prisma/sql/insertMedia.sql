-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:objectKey
-- @param {String} $4:contentType
-- @param {String} $5:createdAt
INSERT INTO media_attachments (id, account_id, object_key, content_type, created_at)
VALUES ($1, $2, $3, $4, $5)
