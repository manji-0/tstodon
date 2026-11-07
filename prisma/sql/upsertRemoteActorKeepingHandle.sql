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
-- @param {String} $15:followersUri?
-- @param {String} $16:followingUri?
-- `upsertRemoteActor` for a round trip that settled nothing: a new row takes
-- the handle given ($2, $3: the URI's authority), unconfirmed; a cached row
-- keeps the handle and confirmation time it holds as this runs, so a
-- confirmation another actor made during the round trip is not undone with a
-- value read before it. Returns the handle the row ends up with.
INSERT INTO remote_actors (
  actor_uri, username, domain, inbox_uri, shared_inbox_uri,
  public_key_id, public_key_pem, display_name, fetched_at, created_at, updated_at, profile_json,
  outbox_uri, featured_uri, last_webfingered_at, followers_uri, following_uri
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, $15, $16)
ON CONFLICT(actor_uri) DO UPDATE SET
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
  updated_at = excluded.updated_at
RETURNING username, domain, last_webfingered_at
