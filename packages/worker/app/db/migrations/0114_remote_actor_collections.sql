-- A remote actor's own `followers` and `following` collection URIs, as
-- Mastodon's `accounts.followers_url` / `following_url`, so a note's
-- `interactionPolicy.canQuote` names them by URI rather than by path. NULL:
-- the actor document named none on its own host, or the row was cached
-- before this column and has not been refreshed since.
ALTER TABLE remote_actors ADD COLUMN followers_uri TEXT;
ALTER TABLE remote_actors ADD COLUMN following_uri TEXT;
