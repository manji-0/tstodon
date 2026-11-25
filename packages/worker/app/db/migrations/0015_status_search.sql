-- Status text search (`StatusesSearchService`): an FTS5 index over the
-- searchable text of local notes and cached remote notes, as Mastodon's
-- `PublicStatusesIndex` and `StatusesIndex` hold it. Triggers keep it in step
-- with every table its rows are read from. See
-- docs/architecture/status-search.md.

-- One row per searchable note. `id` is the status id as an integer, so the
-- index's rowid orders as the status ids do and a page reads the newest
-- matches first without sorting. `content_text` is a remote note's content as
-- plain text, which only the Worker can compute from its HTML
-- (`htmlToText`); a local note's is `statuses.content_text`. A note whose
-- integer id another note already holds is not indexed.
CREATE TABLE status_search_documents (
  id INTEGER PRIMARY KEY,
  status_id TEXT UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  remote_status_id TEXT UNIQUE REFERENCES remote_statuses(id) ON DELETE CASCADE,
  content_text TEXT,
  CHECK ((status_id IS NULL) <> (remote_status_id IS NULL))
);

-- Contentless: the text lives in the tables the views below read, and a row
-- is replaced by rowid (`contentless_delete`). `text` is Mastodon's
-- `searchable_text`; `tags` the note's hashtags; `scope` who finds it: `p`
-- when it is in `PublicStatusesIndex` (public, and its author `indexable`),
-- and `v<account id>` for each local account whose library holds it
-- (`Status#searchable_by`).
CREATE VIRTUAL TABLE status_search USING fts5(
  text, tags, scope,
  content = '',
  contentless_delete = 1,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- What a row of the index holds, before CJK segmentation.
CREATE VIEW status_search_sources AS
SELECT
  d.id AS id,
  CASE WHEN d.status_id IS NOT NULL THEN (
    SELECT s.spoiler_text || char(10) || s.content_text
      || COALESCE(char(10) || (
        SELECT group_concat(CASE WHEN o.type = 'object' THEN json_extract(o.value, '$.title') END, char(10))
        FROM polls p, json_each(CASE WHEN json_valid(p.options_json) THEN p.options_json ELSE '[]' END) o
        WHERE p.status_id = s.id
      ), '')
      || COALESCE(char(10) || (
        SELECT group_concat(m.description, char(10))
        FROM media_attachments m WHERE m.status_id = s.id AND m.description <> ''
      ), '')
    FROM statuses s WHERE s.id = d.status_id
  ) ELSE (
    SELECT r.spoiler_text || char(10) || COALESCE(d.content_text, '')
      || COALESCE(char(10) || (
        SELECT group_concat(CASE WHEN o.type = 'object' THEN json_extract(o.value, '$.title') END, char(10))
        FROM json_each(CASE WHEN json_valid(r.poll_json) THEN r.poll_json ELSE '{}' END, '$.options') o
      ), '')
      || COALESCE(char(10) || (
        SELECT group_concat(CASE WHEN a.type = 'object' THEN json_extract(a.value, '$.description') END, char(10))
        FROM json_each(CASE WHEN json_valid(r.media_json) THEN r.media_json ELSE '[]' END) a
        WHERE (CASE WHEN a.type = 'object' THEN json_extract(a.value, '$.description') END) <> ''
      ), '')
    FROM remote_statuses r WHERE r.id = d.remote_status_id
  ) END AS text,
  CASE WHEN d.status_id IS NOT NULL THEN COALESCE(
    (SELECT group_concat(t.tag, ' ') FROM local_status_tags t WHERE t.status_id = d.status_id), ''
  ) ELSE COALESCE(
    (SELECT group_concat(t.tag, ' ') FROM remote_status_tags t WHERE t.status_id = d.remote_status_id), ''
  ) END AS tags,
  CASE WHEN d.status_id IS NOT NULL THEN (
    SELECT
      CASE WHEN s.visibility = 'public' AND COALESCE(
        (SELECT p.indexable FROM account_profiles p WHERE p.account_id = s.account_id), 1
      ) <> 0 THEN 'p ' ELSE '' END
      || 'v' || s.account_id
      || COALESCE(' ' || (
        SELECT group_concat('v' || m.account_id, ' ') FROM status_mentions m
        WHERE m.status_id = s.id AND m.silent = 0
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || f.account_id, ' ') FROM favourites f WHERE f.local_status_id = s.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || b.account_id, ' ') FROM statuses b WHERE b.reblog_of_id = s.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || k.account_id, ' ') FROM bookmarks k WHERE k.local_status_id = s.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat(DISTINCT 'v' || v.account_id) FROM polls p
        JOIN poll_votes v ON v.poll_id = p.id WHERE p.status_id = s.id
      ), '')
    FROM statuses s WHERE s.id = d.status_id
  ) ELSE (
    SELECT
      CASE WHEN r.visibility = 'public' AND EXISTS (
        SELECT 1 FROM remote_actors a
        WHERE a.actor_uri = r.actor_uri AND json_valid(a.profile_json)
          AND json_extract(a.profile_json, '$.indexable') = 1
      ) THEN 'p' ELSE '' END
      || COALESCE(' ' || (
        SELECT group_concat('v' || m.account_id, ' ') FROM remote_status_mentions m
        WHERE m.status_id = r.id AND m.silent = 0
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || f.account_id, ' ') FROM favourites f WHERE f.remote_status_id = r.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || b.account_id, ' ') FROM statuses b WHERE b.reblog_of_remote_id = r.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat('v' || k.account_id, ' ') FROM bookmarks k WHERE k.remote_status_id = r.id
      ), '')
      || COALESCE(' ' || (
        SELECT group_concat(DISTINCT 'v' || v.account_id) FROM remote_poll_own_votes v
        WHERE v.status_id = r.id
      ), '')
    FROM remote_statuses r WHERE r.id = d.remote_status_id
  ) END AS scope
FROM status_search_documents d;

-- The rows the index is written from. The tokenizer reads a run of Han, kana
-- and other unspaced CJK characters as one token, where Elasticsearch's
-- `standard` tokenizer makes each character one: each such character is set
-- apart with spaces, so a query for part of a run finds it as a phrase
-- (`segmentCjk` in `server/status-search-store.ts` does the same to queries,
-- and lists the same code points). `json_each` over a run of zeros walks
-- the characters; text that is all ASCII is used as is.
CREATE VIEW status_search_rows AS
SELECT
  src.id AS id,
  CASE WHEN length(CAST(t.value AS BLOB)) = length(t.value) THEN t.value ELSE (
    SELECT group_concat(
      CASE WHEN unicode(c.ch) BETWEEN 12293 AND 12295   -- U+3005..3007
        OR unicode(c.ch) BETWEEN 12352 AND 12543        -- U+3040..30FF kana
        OR unicode(c.ch) BETWEEN 12784 AND 12799        -- U+31F0..31FF
        OR unicode(c.ch) BETWEEN 13312 AND 19903        -- U+3400..4DBF
        OR unicode(c.ch) BETWEEN 19968 AND 40959        -- U+4E00..9FFF
        OR unicode(c.ch) BETWEEN 63744 AND 64255        -- U+F900..FAFF
        OR unicode(c.ch) BETWEEN 65382 AND 65439        -- U+FF66..FF9F
        OR unicode(c.ch) BETWEEN 131072 AND 262143      -- U+20000..3FFFF
      THEN ' ' || c.ch || ' ' ELSE c.ch END, '')
    FROM (
      SELECT substr(t.value, j.key + 1, 1) AS ch
      FROM json_each('[' || rtrim(replace(hex(zeroblob(length(t.value))), '00', '0,'), ',') || ']') j
    ) c
  ) END AS text,
  src.tags AS tags,
  src.scope AS scope
-- `t.value` is the text, computed once per row: the view's columns are
-- correlated subqueries, which each reference would run again.
FROM status_search_sources src, json_each(json_array(src.text)) t;

-- A document row writes its index row; its delete (with its note's, through
-- the foreign key) removes it.
CREATE TRIGGER status_search_document_added AFTER INSERT ON status_search_documents
BEGIN
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows WHERE id = NEW.id;
END;

CREATE TRIGGER status_search_document_removed AFTER DELETE ON status_search_documents
BEGIN
  DELETE FROM status_search WHERE rowid = OLD.id;
END;

CREATE TRIGGER status_search_document_changed AFTER UPDATE OF content_text ON status_search_documents
WHEN OLD.content_text IS NOT NEW.content_text
BEGIN
  DELETE FROM status_search WHERE rowid = NEW.id;
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows WHERE id = NEW.id;
END;

-- A local note gets its document when it is written. A remote note's is
-- written by the Worker with the note (`remoteSearchDocumentStatements`).
CREATE TRIGGER status_search_local_added AFTER INSERT ON statuses
WHEN NEW.kind = 'LocalNote'
BEGIN
  INSERT OR IGNORE INTO status_search_documents (id, status_id)
    VALUES (CAST(NEW.id AS INTEGER), NEW.id);
END;

-- The local notes written before this migration. The remote ones are indexed
-- by the `BackfillStatusSearch` job, which walks `remote_statuses` by id
-- from this cursor.
INSERT OR IGNORE INTO status_search_documents (id, status_id)
  SELECT CAST(id AS INTEGER), id FROM statuses WHERE kind = 'LocalNote';

INSERT OR IGNORE INTO backfill_cursors (name) VALUES ('status_search');

-- A local note's text, media descriptions and poll: a change resyncs its row.
CREATE TRIGGER status_search_local_edited AFTER UPDATE OF content_text, spoiler_text, visibility, poll_id ON statuses
WHEN NEW.kind = 'LocalNote'
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.id);
END;

CREATE TRIGGER status_search_poll_added AFTER INSERT ON polls
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_poll_options AFTER UPDATE OF options_json, status_id ON polls
WHEN OLD.status_id IS NOT NEW.status_id
  OR (SELECT group_concat(CASE WHEN type = 'object' THEN json_extract(value, '$.title') END, char(10)) FROM json_each(CASE WHEN json_valid(OLD.options_json) THEN OLD.options_json ELSE '[]' END))
    IS NOT (SELECT group_concat(CASE WHEN type = 'object' THEN json_extract(value, '$.title') END, char(10)) FROM json_each(CASE WHEN json_valid(NEW.options_json) THEN NEW.options_json ELSE '[]' END))
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id IN (OLD.status_id, NEW.status_id)
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id IN (OLD.status_id, NEW.status_id));
END;

CREATE TRIGGER status_search_poll_removed AFTER DELETE ON polls
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.status_id);
END;

CREATE TRIGGER status_search_media_added AFTER INSERT ON media_attachments
WHEN NEW.status_id IS NOT NULL
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_media_changed AFTER UPDATE OF status_id, description ON media_attachments
WHEN OLD.status_id IS NOT NEW.status_id OR OLD.description IS NOT NEW.description
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id IN (OLD.status_id, NEW.status_id)
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id IN (OLD.status_id, NEW.status_id));
END;

CREATE TRIGGER status_search_media_removed AFTER DELETE ON media_attachments
WHEN OLD.status_id IS NOT NULL
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.status_id);
END;

CREATE TRIGGER status_search_local_tag_added AFTER INSERT ON local_status_tags
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_local_tag_removed AFTER DELETE ON local_status_tags
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.status_id);
END;

-- A remote note's columns other than its content (which `content_text` holds).
CREATE TRIGGER status_search_remote_edited AFTER UPDATE OF spoiler_text, visibility, media_json, poll_json, actor_uri ON remote_statuses
WHEN OLD.spoiler_text IS NOT NEW.spoiler_text OR OLD.visibility IS NOT NEW.visibility
  OR OLD.media_json IS NOT NEW.media_json OR OLD.poll_json IS NOT NEW.poll_json
  OR OLD.actor_uri IS NOT NEW.actor_uri
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = NEW.id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = NEW.id);
END;

CREATE TRIGGER status_search_remote_tag_added AFTER INSERT ON remote_status_tags
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_remote_tag_removed AFTER DELETE ON remote_status_tags
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id);
END;

-- Who may find a note in their library (`searchable_by`): its local author,
-- the local accounts it mentions, and those that favourite, boost, bookmark
-- it or vote in its poll.
CREATE TRIGGER status_search_boost_added AFTER INSERT ON statuses
WHEN NEW.reblog_of_id IS NOT NULL OR NEW.reblog_of_remote_id IS NOT NULL
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.reblog_of_id OR remote_status_id = NEW.reblog_of_remote_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.reblog_of_id OR remote_status_id = NEW.reblog_of_remote_id);
END;

CREATE TRIGGER status_search_boost_removed AFTER DELETE ON statuses
WHEN OLD.reblog_of_id IS NOT NULL OR OLD.reblog_of_remote_id IS NOT NULL
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.reblog_of_id OR remote_status_id = OLD.reblog_of_remote_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.reblog_of_id OR remote_status_id = OLD.reblog_of_remote_id);
END;

CREATE TRIGGER status_search_mention_added AFTER INSERT ON status_mentions
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_mention_removed AFTER DELETE ON status_mentions
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.status_id);
END;

CREATE TRIGGER status_search_mention_silenced AFTER UPDATE OF silent ON status_mentions
WHEN OLD.silent IS NOT NEW.silent
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_remote_mention_added AFTER INSERT ON remote_status_mentions
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_remote_mention_removed AFTER DELETE ON remote_status_mentions
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id);
END;

CREATE TRIGGER status_search_remote_mention_silenced AFTER UPDATE OF silent ON remote_status_mentions
WHEN OLD.silent IS NOT NEW.silent
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_favourite_added AFTER INSERT ON favourites
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.local_status_id OR remote_status_id = NEW.remote_status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.local_status_id OR remote_status_id = NEW.remote_status_id);
END;

CREATE TRIGGER status_search_favourite_removed AFTER DELETE ON favourites
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.local_status_id OR remote_status_id = OLD.remote_status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.local_status_id OR remote_status_id = OLD.remote_status_id);
END;

CREATE TRIGGER status_search_bookmark_added AFTER INSERT ON bookmarks
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = NEW.local_status_id OR remote_status_id = NEW.remote_status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = NEW.local_status_id OR remote_status_id = NEW.remote_status_id);
END;

CREATE TRIGGER status_search_bookmark_removed AFTER DELETE ON bookmarks
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = OLD.local_status_id OR remote_status_id = OLD.remote_status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = OLD.local_status_id OR remote_status_id = OLD.remote_status_id);
END;

CREATE TRIGGER status_search_vote_added AFTER INSERT ON poll_votes
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = (SELECT status_id FROM polls WHERE id = NEW.poll_id)
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = (SELECT status_id FROM polls WHERE id = NEW.poll_id));
END;

CREATE TRIGGER status_search_vote_removed AFTER DELETE ON poll_votes
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id = (SELECT status_id FROM polls WHERE id = OLD.poll_id)
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = (SELECT status_id FROM polls WHERE id = OLD.poll_id));
END;

CREATE TRIGGER status_search_remote_vote_added AFTER INSERT ON remote_poll_own_votes
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = NEW.status_id);
END;

CREATE TRIGGER status_search_remote_vote_removed AFTER DELETE ON remote_poll_own_votes
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id = OLD.status_id);
END;

-- An author's `indexable` puts its public notes in or out of `PublicStatusesIndex`.
CREATE TRIGGER status_search_local_indexable_set AFTER INSERT ON account_profiles
WHEN NEW.indexable = 0
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id IN (
      SELECT id FROM statuses WHERE account_id = NEW.account_id AND visibility = 'public'
    )
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id IN (
      SELECT id FROM statuses WHERE account_id = NEW.account_id AND visibility = 'public'
    ));
END;

CREATE TRIGGER status_search_local_indexable_changed AFTER UPDATE OF indexable ON account_profiles
WHEN OLD.indexable IS NOT NEW.indexable
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE status_id IN (
      SELECT id FROM statuses WHERE account_id = NEW.account_id AND visibility = 'public'
    )
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE status_id IN (
      SELECT id FROM statuses WHERE account_id = NEW.account_id AND visibility = 'public'
    ));
END;

CREATE TRIGGER status_search_remote_indexable_changed AFTER UPDATE OF profile_json ON remote_actors
WHEN (CASE WHEN json_valid(OLD.profile_json) THEN json_extract(OLD.profile_json, '$.indexable') END)
  IS NOT (CASE WHEN json_valid(NEW.profile_json) THEN json_extract(NEW.profile_json, '$.indexable') END)
BEGIN
  DELETE FROM status_search WHERE rowid IN (
    SELECT id FROM status_search_documents WHERE remote_status_id IN (
      SELECT id FROM remote_statuses WHERE actor_uri = NEW.actor_uri AND visibility = 'public'
    )
  );
  INSERT INTO status_search (rowid, text, tags, scope)
    SELECT id, text, tags, scope FROM status_search_rows
    WHERE id IN (SELECT id FROM status_search_documents WHERE remote_status_id IN (
      SELECT id FROM remote_statuses WHERE actor_uri = NEW.actor_uri AND visibility = 'public'
    ));
END;

