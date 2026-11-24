-- @param {String} $1:actorUri
-- @param {String} $2:username
-- @param {String} $3:domain
-- @param {String} $4:inboxUri
-- @param {String} $5:sharedInboxUri?
-- @param {String} $6:displayName
-- @param {String} $7:fetchedAt
-- @param {String} $8:createdAt
-- @param {String} $9:updatedAt
-- @param {String} $10:profileJson
-- @param {String} $11:outboxUri?
-- @param {String} $12:featuredUri?
-- @param {String} $13:webfingeredAt?
-- @param {String} $14:followersUri?
-- @param {String} $15:followingUri?
-- @param {String} $16:featuredTagsUri?
-- A suspended actor (`suspended_remote_actors`) keeps its
-- cached name, profile, featured collection and `fetched_at`, as Mastodon's
-- `ProcessAccountService` skips `set_immediate_attributes!` and
-- `set_fetchable_attributes!`; its profile URL, `bot` and `publishedAt`
-- follow the document, as `set_immediate_protocol_attributes!` writes `url`,
-- `actor_type` and `created_at`. Returns what the row holds.
INSERT INTO remote_actors (
  actor_uri, username, domain, inbox_uri, shared_inbox_uri,
  display_name, fetched_at, created_at, updated_at, profile_json,
  outbox_uri, featured_uri, last_webfingered_at, followers_uri, following_uri, featured_tags_uri
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT(actor_uri) DO UPDATE SET
  username = excluded.username,
  domain = excluded.domain,
  inbox_uri = excluded.inbox_uri,
  shared_inbox_uri = excluded.shared_inbox_uri,
  display_name = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.display_name ELSE excluded.display_name END,
  profile_json = CASE WHEN NOT EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN excluded.profile_json
    WHEN json_valid(remote_actors.profile_json) THEN json_set(remote_actors.profile_json,
      '$.profileUrl', json(excluded.profile_json -> '$.profileUrl'),
      '$.bot', json(excluded.profile_json -> '$.bot'),
      '$.publishedAt', json(excluded.profile_json -> '$.publishedAt'))
    ELSE remote_actors.profile_json END,
  outbox_uri = excluded.outbox_uri,
  featured_uri = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.featured_uri ELSE excluded.featured_uri END,
  featured_tags_uri = excluded.featured_tags_uri,
  followers_uri = excluded.followers_uri,
  following_uri = excluded.following_uri,
  fetched_at = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.fetched_at ELSE excluded.fetched_at END,
  last_webfingered_at = excluded.last_webfingered_at,
  updated_at = excluded.updated_at
RETURNING display_name, profile_json, featured_uri, fetched_at
