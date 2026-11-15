-- @param {String} $1:actorUri
-- Each hashtag the actor features, in its order, with the number of its
-- public and unlisted posts this server holds under that tag and the newest
-- one's date, as Mastodon's `FeaturedTag#reset_data` counts its
-- `distributable_visibility` statuses. Each count reads the actor's posts,
-- not every post under the tag.
SELECT f.tag_name, f.name,
  (
    SELECT COUNT(*) FROM remote_statuses s
    CROSS JOIN remote_status_tags t ON t.status_id = s.id AND t.tag = f.tag_name
    WHERE s.actor_uri = f.actor_uri AND s.visibility IN ('public', 'unlisted')
  ) AS statuses_count,
  (
    SELECT MAX(s.published_at) FROM remote_statuses s
    CROSS JOIN remote_status_tags t ON t.status_id = s.id AND t.tag = f.tag_name
    WHERE s.actor_uri = f.actor_uri AND s.visibility IN ('public', 'unlisted')
  ) AS last_status_at
FROM remote_featured_tags f
WHERE f.actor_uri = $1
ORDER BY f.position ASC
