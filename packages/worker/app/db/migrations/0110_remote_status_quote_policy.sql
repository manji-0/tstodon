-- Who the remote author lets quote the note, parsed from
-- `interactionPolicy.canQuote`: {"automatic":[...],"manual":[...]} with
-- Mastodon's REST keys. NULL: the note advertised no policy, which Mastodon
-- reads as nobody but the author.
ALTER TABLE remote_statuses ADD COLUMN quote_policy_json TEXT;
