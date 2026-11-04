SELECT DISTINCT host AS domain FROM remote_actors
WHERE host != ''
ORDER BY domain ASC
