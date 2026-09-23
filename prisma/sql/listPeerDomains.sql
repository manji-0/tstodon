SELECT DISTINCT domain FROM remote_actors
WHERE domain IS NOT NULL AND domain != ''
ORDER BY domain ASC
