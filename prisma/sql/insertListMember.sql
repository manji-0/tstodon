-- @param {String} $1:listId
-- @param {String} $2:memberAccountId
-- @param {String} $3:createdAt
INSERT OR IGNORE INTO account_list_members (list_id, member_account_id, created_at)
VALUES ($1, $2, $3)
