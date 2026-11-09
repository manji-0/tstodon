-- Tags an admin made unusable or unlisted: they leave search and trends.
SELECT name FROM tags WHERE usable = 0 OR listable = 0
