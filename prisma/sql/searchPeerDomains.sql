-- @param {String} $1:prefix
-- @param {Int} $2:limit
SELECT DISTINCT host AS domain FROM remote_actors
WHERE host != '' AND host >= $1 AND host < $1 || char(1114111)
  AND host NOT IN (SELECT lower(domain) FROM domain_blocks)
ORDER BY domain ASC
LIMIT $2
