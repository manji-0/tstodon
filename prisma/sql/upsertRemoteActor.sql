-- @param {String} $1:actorUri
-- @param {String} $2:username
-- @param {String} $3:domain
-- @param {String} $4:inboxUri
-- @param {String} $5:sharedInboxUri?
-- @param {String} $6:publicKeyId
-- @param {String} $7:publicKeyPem
-- @param {String} $8:displayName
-- @param {String} $9:fetchedAt
-- @param {String} $10:createdAt
-- @param {String} $11:updatedAt
-- @param {String} $12:profileJson
-- @param {String} $13:outboxUri?
-- @param {String} $14:featuredUri?
-- @param {String} $15:webfingeredAt?
-- @param {String} $16:followersUri?
-- @param {String} $17:followingUri?
INSERT INTO remote_actors (
  actor_uri, username, domain, inbox_uri, shared_inbox_uri,
  public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at, profile_json,
  outbox_uri, featured_uri, last_webfingered_at, followers_uri, following_uri
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
ON CONFLICT(actor_uri) DO UPDATE SET
  username = excluded.username,
  domain = excluded.domain,
  inbox_uri = excluded.inbox_uri,
  shared_inbox_uri = excluded.shared_inbox_uri,
  public_key_id = excluded.public_key_id,
  public_key_pem = excluded.public_key_pem,
  display_name = excluded.display_name,
  profile_json = excluded.profile_json,
  outbox_uri = excluded.outbox_uri,
  featured_uri = excluded.featured_uri,
  followers_uri = excluded.followers_uri,
  following_uri = excluded.following_uri,
  fetched_at = excluded.fetched_at,
  last_webfingered_at = excluded.last_webfingered_at,
  updated_at = excluded.updated_at
