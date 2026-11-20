-- @param {String} $1:prefix
-- @param {Int} $2:limit
SELECT DISTINCT host AS domain FROM remote_actors
WHERE host != '' AND substr(host, 1, length($1)) = $1
  AND host NOT IN (SELECT lower(domain) FROM domain_blocks)
ORDER BY domain ASC
LIMIT $2
