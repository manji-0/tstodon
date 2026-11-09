-- @param {String} $1:domain
DELETE FROM delivery_domain_health WHERE domain = $1
