-- @param {String} $1:domain
-- @param {String} $2:kind
-- @param {Int} $3:failureDays
-- @param {String} $4:lastFailureDay
-- @param {String} $5:unavailableSince?
-- @param {String} $6:updatedAt
INSERT INTO delivery_domain_health
 (domain, kind, failure_days, last_failure_day, unavailable_since, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT(domain) DO UPDATE SET kind = $2, failure_days = $3, last_failure_day = $4,
 unavailable_since = $5, updated_at = $6
