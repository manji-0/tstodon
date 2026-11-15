-- @param {String} $1:actorUri
-- @param {String} $2:tagName
-- @param {String} $3:name
-- @param {Int} $4:limit
-- A new featured hashtag goes last, as Mastodon lists them in the order they
-- were featured; one already featured keeps its place, and an actor that
-- features `limit` hashtags keeps those.
INSERT INTO remote_featured_tags (actor_uri, tag_name, name, position)
SELECT $1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM remote_featured_tags WHERE actor_uri = $1)
WHERE (SELECT COUNT(*) FROM remote_featured_tags WHERE actor_uri = $1) < $4
ON CONFLICT(actor_uri, tag_name) DO NOTHING
