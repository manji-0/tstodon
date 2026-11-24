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
-- @param {String} $17:legacyPublicKeyPem
-- The actor's keys are in `remote_actor_keys`; `public_key_id` and
-- `public_key_pem` are unread (migration 0152) and written as the actor URI
-- and a placeholder key, which a build from before 0152 can still read.
-- A suspended actor's profile and `fetched_at` stay as cached
-- (`suspended_remote_actors`, migration 0179).
INSERT INTO remote_actors (
  actor_uri, username, domain, inbox_uri, shared_inbox_uri,
  public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at, profile_json,
  outbox_uri, featured_uri, last_webfingered_at, followers_uri, following_uri, featured_tags_uri
) VALUES ($1, $2, $3, $4, $5, $1, $17, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT(actor_uri) DO UPDATE SET
  username = excluded.username,
  domain = excluded.domain,
  inbox_uri = excluded.inbox_uri,
  shared_inbox_uri = excluded.shared_inbox_uri,
  display_name = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.display_name ELSE excluded.display_name END,
  profile_json = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.profile_json ELSE excluded.profile_json END,
  outbox_uri = excluded.outbox_uri,
  featured_uri = excluded.featured_uri,
  featured_tags_uri = excluded.featured_tags_uri,
  followers_uri = excluded.followers_uri,
  following_uri = excluded.following_uri,
  fetched_at = CASE WHEN EXISTS (SELECT 1 FROM suspended_remote_actors s WHERE s.actor_uri = excluded.actor_uri)
    THEN remote_actors.fetched_at ELSE excluded.fetched_at END,
  last_webfingered_at = excluded.last_webfingered_at,
  updated_at = excluded.updated_at
