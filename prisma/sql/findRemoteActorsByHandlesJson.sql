-- @param {String} $1:handlesJson
-- `handlesJson` lists `[username, domain]` pairs, compared without case. As
-- in findRemoteActorByHandle, the row WebFinger confirmed last answers for a
-- handle that several rows share.
SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, display_name, profile_json, moved_to, outbox_uri, featured_uri, featured_tags_uri, followers_uri, following_uri, fetched_at, last_webfingered_at
FROM (
  SELECT actor_uri, username, domain, inbox_uri, shared_inbox_uri, display_name, profile_json, moved_to, outbox_uri, featured_uri, featured_tags_uri, followers_uri, following_uri, fetched_at, last_webfingered_at,
    ROW_NUMBER() OVER (
      PARTITION BY lower(username), lower(domain)
      ORDER BY last_webfingered_at IS NULL, last_webfingered_at DESC, fetched_at DESC, actor_uri
    ) AS handle_rank
  FROM remote_actors
  JOIN json_each($1) AS handle
    ON lower(domain) = lower(json_extract(handle.value, '$[1]'))
    AND lower(username) = lower(json_extract(handle.value, '$[0]'))
)
WHERE handle_rank = 1
