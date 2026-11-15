-- @param {String} $1:actorUri
-- Each hashtag the actor features, in its order, with the number of its
-- public and unlisted posts this server holds under that tag and the newest
-- one's date, as Mastodon's `FeaturedTag#reset_data` counts its
-- `distributable_visibility` statuses.
SELECT f.tag_name, f.name, COUNT(s.id) AS statuses_count, MAX(s.published_at) AS last_status_at
FROM remote_featured_tags f
LEFT JOIN remote_status_tags t ON t.tag = f.tag_name
LEFT JOIN remote_statuses s
  ON s.id = t.status_id AND s.actor_uri = f.actor_uri AND s.visibility IN ('public', 'unlisted')
WHERE f.actor_uri = $1
GROUP BY f.tag_name, f.name, f.position
ORDER BY f.position ASC
