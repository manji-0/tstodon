-- @param {String} $1:id
-- @param {String} $2:accountId
-- @param {String} $3:fromAccountId
-- @param {String} $4:fromActorUri?
-- @param {String} $5:kind
-- @param {String} $6:statusId?
-- @param {String} $7:createdAt
-- @param {String} $8:targetAccountId?
-- @param {String} $9:reportId?
-- @param {String} $10:severanceEventId?
INSERT INTO notifications (id, account_id, from_account_id, from_actor_uri, kind, status_id, created_at, target_account_id, report_id, severance_event_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
