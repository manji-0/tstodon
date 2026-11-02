-- @param {String} $1:remoteAccountId
DELETE FROM notification_request_groups WHERE from_account_id = $1
