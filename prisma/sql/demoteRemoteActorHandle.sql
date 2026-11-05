-- @param {String} $1:username
-- @param {String} $2:domain
-- @param {String} $3:actorUri
-- WebFinger now confirms `username@domain` for `actorUri`, so every other row
-- cached under that handle falls back to its own URI's authority. Mastodon
-- keys accounts by handle and hands the row to the newly verified URI
-- (`Account.find_remote` in `ActivityPub::ProcessAccountService`); rows here
-- are keyed by URI, so the other row gives the handle up instead. Matched as
-- `findRemoteActorByHandle` matches.
UPDATE remote_actors
SET domain = lower(uri_authority), last_webfingered_at = NULL
WHERE lower(username) = lower($1) AND lower(domain) = lower($2) AND actor_uri <> $3
