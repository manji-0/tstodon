-- @param {Int} $1:limit
SELECT domain, kind, failure_days, last_failure_day, unavailable_since
FROM delivery_domain_health ORDER BY kind DESC, domain LIMIT $1
