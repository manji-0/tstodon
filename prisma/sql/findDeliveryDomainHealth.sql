-- @param {String} $1:domain
SELECT domain, kind, failure_days, last_failure_day, unavailable_since
FROM delivery_domain_health WHERE domain = $1
