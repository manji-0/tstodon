-- Mastodon's silent mention (`mentions.silent`) on a local note, as 0113 added
-- it to a cached remote note: a row that lets the account or actor read the
-- note without counting as a mention. A quote's `Quote#ensure_quoted_access`
-- writes one for the quoted author, and an edit that drops a mention keeps it
-- silent (`ProcessMentionsService`), so whoever was told about the note keeps
-- access to it.

ALTER TABLE status_mentions ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_remote_mentions ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;

-- The quotes stored before this migration get the silent mention their
-- quoted author would have now. Each statement walks the local quoting
-- notes once by `status_quotes`' unique `status_id` index, or the remote
-- ones by `activity_uri`'s, and seeks the quoted note by primary key, so it
-- reads each quote once however many there are. A mention already stored is
-- kept as it is.
INSERT OR IGNORE INTO status_mentions (status_id, account_id, silent)
SELECT q.status_id, s.account_id, 1
FROM status_quotes q
CROSS JOIN statuses s ON s.id = q.quoted_status_id
WHERE q.status_id IS NOT NULL;

-- Only a cached actor can be named: `status_remote_mentions` references
-- `remote_actors`.
INSERT OR IGNORE INTO status_remote_mentions (status_id, actor_uri, silent)
SELECT q.status_id, r.actor_uri, 1
FROM status_quotes q
CROSS JOIN remote_statuses r ON r.id = q.quoted_remote_status_id
CROSS JOIN remote_actors a ON a.actor_uri = r.actor_uri
WHERE q.status_id IS NOT NULL;

-- A remote quote of a local note an answered `QuoteRequest` accepted (its
-- `activity_uri`) before the inbox recorded the mention itself.
INSERT OR IGNORE INTO remote_status_mentions (status_id, account_id, silent)
SELECT q.remote_status_id, s.account_id, 1
FROM status_quotes q
CROSS JOIN statuses s ON s.id = q.quoted_status_id
WHERE q.activity_uri IS NOT NULL AND q.remote_status_id IS NOT NULL
  AND q.state IN ('accepted', 'revoked');
