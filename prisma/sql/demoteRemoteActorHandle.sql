-- @param {String} $1:username
-- @param {String} $2:domain
-- @param {String} $3:actorUri
-- WebFinger now confirms `username@domain` for `actorUri` (or the handle's
-- own domain says it names `actorUri`, or, with '', nobody), so every other
-- row cached under that handle falls back to its own URI's authority. Mastodon
-- keys accounts by handle and hands the row to the newly verified URI
-- (`Account.find_remote` in `ActivityPub::ProcessAccountService`); rows here
-- are keyed by URI, so the other row gives the handle up instead. Matched as
-- `findRemoteActorByHandle` matches. Only a confirmed row can hold a domain
-- other than its URI's authority, and a confirmed row's URI passed actor
-- fetch's authority check, so `uri_authority` is a host it may take. A row
-- never confirmed keeps its domain: it is already its own URI's host (the URL
-- parser's, for a row cached before that check, whose `uri_authority` may
-- carry userinfo or a default port), and the confirmed row wins lookups.
UPDATE remote_actors
SET domain = lower(uri_authority), last_webfingered_at = NULL
WHERE lower(username) = lower($1) AND lower(domain) = lower($2) AND actor_uri <> $3
  AND last_webfingered_at IS NOT NULL
