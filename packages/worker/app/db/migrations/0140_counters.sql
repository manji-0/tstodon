-- Counters that triggers keep, so rendering an account or a status reads one
-- row instead of counting every status, follow, favourite or boost it has.
-- A missing row counts 0. Each row holds exactly what the counting queries it
-- replaces returned:
--
-- `account_stats` (local accounts):
--   statuses_count  every `statuses` row of the account (notes and boosts of
--                   any visibility),
--   followers_count accepted local `follows` and accepted `remote_follows` of it,
--   following_count accepted local `follows` by it and accepted `outbound_follows`.
-- `status_stats` (local and remote statuses: their ids never collide):
--   favourites_count local `favourites` and `remote_favourites`,
--   reblogs_count    local boosts (`LocalReblog` statuses) and `remote_announces`,
--   quotes_count     accepted `status_quotes` quoting it,
--   replies_count    public and unlisted replies, as Mastodon counts them: local
--                    notes by `in_reply_to_id`, or by `in_reply_to_uri` for a
--                    remote parent, and remote statuses by `in_reply_to_uri`
--                    (a local parent's URI ends in
--                    `/users/<username>/statuses/<id>`; the instance's origin
--                    is configuration, so it is not compared).
--
-- One row per account or status keeps the writes at one per counted change.
-- A migration that rebuilds a counted table must recreate its triggers.

CREATE TABLE IF NOT EXISTS account_stats (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    statuses_count INTEGER NOT NULL DEFAULT 0,
    followers_count INTEGER NOT NULL DEFAULT 0,
    following_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS status_stats (
    status_id TEXT PRIMARY KEY,
    favourites_count INTEGER NOT NULL DEFAULT 0,
    reblogs_count INTEGER NOT NULL DEFAULT 0,
    quotes_count INTEGER NOT NULL DEFAULT 0,
    replies_count INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Backfill one source per statement: D1 caps a compound SELECT at a few terms.
INSERT INTO account_stats (account_id, statuses_count)
SELECT account_id, COUNT(*) FROM statuses WHERE true GROUP BY account_id;

INSERT INTO account_stats (account_id, followers_count)
SELECT target_account_id, COUNT(*) FROM follows WHERE kind = 'Accepted' GROUP BY target_account_id
ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + excluded.followers_count;

INSERT INTO account_stats (account_id, followers_count)
SELECT target_account_id, COUNT(*) FROM remote_follows WHERE follow_kind = 'Accepted'
GROUP BY target_account_id
ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + excluded.followers_count;

INSERT INTO account_stats (account_id, following_count)
SELECT follower_account_id, COUNT(*) FROM follows WHERE kind = 'Accepted' GROUP BY follower_account_id
ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + excluded.following_count;

INSERT INTO account_stats (account_id, following_count)
SELECT account_id, COUNT(*) FROM outbound_follows WHERE state = 'Accepted' GROUP BY account_id
ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + excluded.following_count;

INSERT INTO status_stats (status_id, favourites_count)
SELECT COALESCE(local_status_id, remote_status_id) AS status_id, COUNT(*) FROM favourites
WHERE true GROUP BY 1;

INSERT INTO status_stats (status_id, favourites_count)
SELECT status_id, COUNT(*) FROM remote_favourites WHERE true GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + excluded.favourites_count;

INSERT INTO status_stats (status_id, reblogs_count)
SELECT COALESCE(reblog_of_id, reblog_of_remote_id) AS status_id, COUNT(*) FROM statuses
WHERE kind = 'LocalReblog' AND COALESCE(reblog_of_id, reblog_of_remote_id) IS NOT NULL
GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + excluded.reblogs_count;

INSERT INTO status_stats (status_id, reblogs_count)
SELECT status_id, COUNT(*) FROM remote_announces WHERE true GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + excluded.reblogs_count;

-- `status_quotes` has no foreign key to the quoted status, which may be gone.
INSERT INTO status_stats (status_id, quotes_count)
SELECT COALESCE(quoted_status_id, quoted_remote_status_id) AS status_id, COUNT(*) FROM status_quotes
WHERE state = 'accepted'
  AND (quoted_status_id IN (SELECT id FROM statuses)
       OR quoted_remote_status_id IN (SELECT id FROM remote_statuses))
GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET quotes_count = quotes_count + excluded.quotes_count;

INSERT INTO status_stats (status_id, replies_count)
SELECT parent_id, COUNT(*)
FROM (
    SELECT COALESCE(
        s.in_reply_to_id,
        (SELECT p.id FROM remote_statuses p WHERE p.object_uri = s.in_reply_to_uri)
    ) AS parent_id
    FROM statuses s
    WHERE s.kind = 'LocalNote' AND s.visibility IN ('public', 'unlisted')
)
WHERE parent_id IS NOT NULL
GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + excluded.replies_count;

INSERT INTO status_stats (status_id, replies_count)
SELECT parent_id, COUNT(*)
FROM (
    SELECT COALESCE(
        (SELECT p.id FROM remote_statuses p WHERE p.object_uri = r.in_reply_to_uri AND p.id <> r.id),
        (SELECT p.id FROM statuses p JOIN accounts a ON a.id = p.account_id
         WHERE p.id = substr(r.in_reply_to_uri, -18)
           AND substr(r.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || p.id))
               = '/users/' || a.username || '/statuses/' || p.id)
    ) AS parent_id
    FROM remote_statuses r
    WHERE r.in_reply_to_uri IS NOT NULL AND r.visibility IN ('public', 'unlisted')
)
WHERE parent_id IS NOT NULL
GROUP BY 1
ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + excluded.replies_count;

-- statuses: the author's statuses_count, a boost's reblogs_count, and the
-- status's own counters leaving with it.

CREATE TRIGGER IF NOT EXISTS statuses_insert_stats AFTER INSERT ON statuses
BEGIN
    INSERT INTO account_stats (account_id, statuses_count) VALUES (NEW.account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET statuses_count = statuses_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS statuses_delete_stats AFTER DELETE ON statuses
BEGIN
    UPDATE account_stats SET statuses_count = statuses_count - 1
    WHERE account_id = OLD.account_id;
    DELETE FROM status_stats WHERE status_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS statuses_insert_reblogs_count AFTER INSERT ON statuses
WHEN NEW.kind = 'LocalReblog' AND COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) IS NOT NULL
BEGIN
    INSERT INTO status_stats (status_id, reblogs_count)
    VALUES (COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS statuses_delete_reblogs_count AFTER DELETE ON statuses
WHEN OLD.kind = 'LocalReblog' AND COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id) IS NOT NULL
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id);
END;

CREATE TRIGGER IF NOT EXISTS statuses_update_reblogs_count
AFTER UPDATE OF kind, reblog_of_id, reblog_of_remote_id ON statuses
WHEN (CASE WHEN OLD.kind = 'LocalReblog' THEN COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id) END)
  IS NOT (CASE WHEN NEW.kind = 'LocalReblog' THEN COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) END)
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE OLD.kind = 'LocalReblog'
      AND status_id = COALESCE(OLD.reblog_of_id, OLD.reblog_of_remote_id);
    INSERT INTO status_stats (status_id, reblogs_count)
    SELECT COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id), 1
    WHERE NEW.kind = 'LocalReblog' AND COALESCE(NEW.reblog_of_id, NEW.reblog_of_remote_id) IS NOT NULL
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

-- A local note's parent: a local status by id, else a cached remote one by URI.

CREATE TRIGGER IF NOT EXISTS statuses_insert_replies_count AFTER INSERT ON statuses
WHEN NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted')
  AND (NEW.in_reply_to_id IS NOT NULL OR NEW.in_reply_to_uri IS NOT NULL)
BEGIN
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        NEW.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS statuses_delete_replies_count AFTER DELETE ON statuses
WHEN OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted')
  AND (OLD.in_reply_to_id IS NOT NULL OR OLD.in_reply_to_uri IS NOT NULL)
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE status_id = COALESCE(
        OLD.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri)
    );
END;

CREATE TRIGGER IF NOT EXISTS statuses_update_replies_count
AFTER UPDATE OF kind, visibility, in_reply_to_id, in_reply_to_uri ON statuses
WHEN (OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted'))
       IS NOT (NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted'))
  OR OLD.in_reply_to_id IS NOT NEW.in_reply_to_id
  OR OLD.in_reply_to_uri IS NOT NEW.in_reply_to_uri
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.kind = 'LocalNote' AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          OLD.in_reply_to_id,
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri)
      );
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        NEW.in_reply_to_id,
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.kind = 'LocalNote' AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

-- remote_statuses: a reply's parent, cached remote by URI or local by the URI's
-- tail. A parent cached after its replies counts them when it arrives.

CREATE TRIGGER IF NOT EXISTS remote_statuses_insert_replies_count AFTER INSERT ON remote_statuses
BEGIN
    INSERT INTO status_stats (status_id, replies_count)
    SELECT NEW.id, replies
    FROM (SELECT
        (SELECT COUNT(*) FROM remote_statuses
         WHERE in_reply_to_uri = NEW.object_uri AND id <> NEW.id
           AND visibility IN ('public', 'unlisted'))
        + (SELECT COUNT(*) FROM statuses
           WHERE in_reply_to_uri = NEW.object_uri AND in_reply_to_id IS NULL
             AND kind = 'LocalNote' AND visibility IN ('public', 'unlisted')) AS replies)
    WHERE replies > 0
    ON CONFLICT (status_id) DO UPDATE SET replies_count = excluded.replies_count;
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri AND id <> NEW.id),
        (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = substr(NEW.in_reply_to_uri, -18)
           AND substr(NEW.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
               = '/users/' || a.username || '/statuses/' || s.id)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.in_reply_to_uri IS NOT NULL AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS remote_statuses_delete_stats AFTER DELETE ON remote_statuses
BEGIN
    DELETE FROM status_stats WHERE status_id = OLD.id;
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.in_reply_to_uri IS NOT NULL AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri),
          (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
           WHERE s.id = substr(OLD.in_reply_to_uri, -18)
             AND substr(OLD.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
                 = '/users/' || a.username || '/statuses/' || s.id)
      );
END;

CREATE TRIGGER IF NOT EXISTS remote_statuses_update_replies_count
AFTER UPDATE OF visibility, in_reply_to_uri ON remote_statuses
WHEN (OLD.visibility IN ('public', 'unlisted')) IS NOT (NEW.visibility IN ('public', 'unlisted'))
  OR OLD.in_reply_to_uri IS NOT NEW.in_reply_to_uri
BEGIN
    UPDATE status_stats SET replies_count = replies_count - 1
    WHERE OLD.in_reply_to_uri IS NOT NULL AND OLD.visibility IN ('public', 'unlisted')
      AND status_id = COALESCE(
          (SELECT id FROM remote_statuses WHERE object_uri = OLD.in_reply_to_uri AND id <> OLD.id),
          (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
           WHERE s.id = substr(OLD.in_reply_to_uri, -18)
             AND substr(OLD.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
                 = '/users/' || a.username || '/statuses/' || s.id)
      );
    INSERT INTO status_stats (status_id, replies_count)
    SELECT parent_id, 1
    FROM (SELECT COALESCE(
        (SELECT id FROM remote_statuses WHERE object_uri = NEW.in_reply_to_uri AND id <> NEW.id),
        (SELECT s.id FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = substr(NEW.in_reply_to_uri, -18)
           AND substr(NEW.in_reply_to_uri, -length('/users/' || a.username || '/statuses/' || s.id))
               = '/users/' || a.username || '/statuses/' || s.id)
    ) AS parent_id)
    WHERE parent_id IS NOT NULL
      AND NEW.in_reply_to_uri IS NOT NULL AND NEW.visibility IN ('public', 'unlisted')
    ON CONFLICT (status_id) DO UPDATE SET replies_count = replies_count + 1;
END;

-- follows: accepted local follows count on both sides.

CREATE TRIGGER IF NOT EXISTS follows_insert_stats AFTER INSERT ON follows
WHEN NEW.kind = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, followers_count) VALUES (NEW.target_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
    INSERT INTO account_stats (account_id, following_count) VALUES (NEW.follower_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS follows_delete_stats AFTER DELETE ON follows
WHEN OLD.kind = 'Accepted'
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE account_id = OLD.target_account_id;
    UPDATE account_stats SET following_count = following_count - 1
    WHERE account_id = OLD.follower_account_id;
END;

CREATE TRIGGER IF NOT EXISTS follows_update_stats
AFTER UPDATE OF kind, follower_account_id, target_account_id ON follows
WHEN (OLD.kind = 'Accepted') IS NOT (NEW.kind = 'Accepted')
  OR (NEW.kind = 'Accepted' AND (OLD.follower_account_id IS NOT NEW.follower_account_id
                                 OR OLD.target_account_id IS NOT NEW.target_account_id))
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE OLD.kind = 'Accepted' AND account_id = OLD.target_account_id;
    UPDATE account_stats SET following_count = following_count - 1
    WHERE OLD.kind = 'Accepted' AND account_id = OLD.follower_account_id;
    INSERT INTO account_stats (account_id, followers_count)
    SELECT NEW.target_account_id, 1 WHERE NEW.kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
    INSERT INTO account_stats (account_id, following_count)
    SELECT NEW.follower_account_id, 1 WHERE NEW.kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

-- remote_follows: a remote actor's accepted follow of a local account.

CREATE TRIGGER IF NOT EXISTS remote_follows_insert_stats AFTER INSERT ON remote_follows
WHEN NEW.follow_kind = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, followers_count) VALUES (NEW.target_account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS remote_follows_delete_stats AFTER DELETE ON remote_follows
WHEN OLD.follow_kind = 'Accepted'
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE account_id = OLD.target_account_id;
END;

CREATE TRIGGER IF NOT EXISTS remote_follows_update_stats
AFTER UPDATE OF follow_kind, target_account_id ON remote_follows
WHEN (CASE WHEN OLD.follow_kind = 'Accepted' THEN OLD.target_account_id END)
  IS NOT (CASE WHEN NEW.follow_kind = 'Accepted' THEN NEW.target_account_id END)
BEGIN
    UPDATE account_stats SET followers_count = followers_count - 1
    WHERE OLD.follow_kind = 'Accepted' AND account_id = OLD.target_account_id;
    INSERT INTO account_stats (account_id, followers_count)
    SELECT NEW.target_account_id, 1 WHERE NEW.follow_kind = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET followers_count = followers_count + 1;
END;

-- outbound_follows: a local account's accepted follow of a remote actor.

CREATE TRIGGER IF NOT EXISTS outbound_follows_insert_stats AFTER INSERT ON outbound_follows
WHEN NEW.state = 'Accepted'
BEGIN
    INSERT INTO account_stats (account_id, following_count) VALUES (NEW.account_id, 1)
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS outbound_follows_delete_stats AFTER DELETE ON outbound_follows
WHEN OLD.state = 'Accepted'
BEGIN
    UPDATE account_stats SET following_count = following_count - 1
    WHERE account_id = OLD.account_id;
END;

CREATE TRIGGER IF NOT EXISTS outbound_follows_update_stats
AFTER UPDATE OF state, account_id ON outbound_follows
WHEN (CASE WHEN OLD.state = 'Accepted' THEN OLD.account_id END)
  IS NOT (CASE WHEN NEW.state = 'Accepted' THEN NEW.account_id END)
BEGIN
    UPDATE account_stats SET following_count = following_count - 1
    WHERE OLD.state = 'Accepted' AND account_id = OLD.account_id;
    INSERT INTO account_stats (account_id, following_count)
    SELECT NEW.account_id, 1 WHERE NEW.state = 'Accepted'
    ON CONFLICT (account_id) DO UPDATE SET following_count = following_count + 1;
END;

-- favourites (local accounts, local or remote status) and remote_favourites.

CREATE TRIGGER IF NOT EXISTS favourites_insert_count AFTER INSERT ON favourites
BEGIN
    INSERT INTO status_stats (status_id, favourites_count)
    VALUES (COALESCE(NEW.local_status_id, NEW.remote_status_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS favourites_delete_count AFTER DELETE ON favourites
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = COALESCE(OLD.local_status_id, OLD.remote_status_id);
END;

CREATE TRIGGER IF NOT EXISTS favourites_update_count
AFTER UPDATE OF local_status_id, remote_status_id ON favourites
WHEN COALESCE(OLD.local_status_id, OLD.remote_status_id)
  IS NOT COALESCE(NEW.local_status_id, NEW.remote_status_id)
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = COALESCE(OLD.local_status_id, OLD.remote_status_id);
    INSERT INTO status_stats (status_id, favourites_count)
    VALUES (COALESCE(NEW.local_status_id, NEW.remote_status_id), 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS remote_favourites_insert_count AFTER INSERT ON remote_favourites
BEGIN
    INSERT INTO status_stats (status_id, favourites_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS remote_favourites_delete_count AFTER DELETE ON remote_favourites
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = OLD.status_id;
END;

CREATE TRIGGER IF NOT EXISTS remote_favourites_update_count
AFTER UPDATE OF status_id ON remote_favourites
WHEN OLD.status_id IS NOT NEW.status_id
BEGIN
    UPDATE status_stats SET favourites_count = favourites_count - 1
    WHERE status_id = OLD.status_id;
    INSERT INTO status_stats (status_id, favourites_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET favourites_count = favourites_count + 1;
END;

-- remote_announces: a remote actor's boost of a local status.

CREATE TRIGGER IF NOT EXISTS remote_announces_insert_count AFTER INSERT ON remote_announces
BEGIN
    INSERT INTO status_stats (status_id, reblogs_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS remote_announces_delete_count AFTER DELETE ON remote_announces
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = OLD.status_id;
END;

CREATE TRIGGER IF NOT EXISTS remote_announces_update_count
AFTER UPDATE OF status_id ON remote_announces
WHEN OLD.status_id IS NOT NEW.status_id
BEGIN
    UPDATE status_stats SET reblogs_count = reblogs_count - 1
    WHERE status_id = OLD.status_id;
    INSERT INTO status_stats (status_id, reblogs_count) VALUES (NEW.status_id, 1)
    ON CONFLICT (status_id) DO UPDATE SET reblogs_count = reblogs_count + 1;
END;

-- status_quotes: an accepted quote counts on the quoted status, local or remote.
-- It has no foreign key to the quoted status, so a quote of a deleted status
-- adds no row.

CREATE TRIGGER IF NOT EXISTS status_quotes_insert_count AFTER INSERT ON status_quotes
WHEN NEW.state = 'accepted'
  AND COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id) IS NOT NULL
BEGIN
    INSERT INTO status_stats (status_id, quotes_count)
    SELECT COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id), 1
    WHERE EXISTS (SELECT 1 FROM statuses WHERE id = NEW.quoted_status_id)
       OR EXISTS (SELECT 1 FROM remote_statuses WHERE id = NEW.quoted_remote_status_id)
    ON CONFLICT (status_id) DO UPDATE SET quotes_count = quotes_count + 1;
END;

CREATE TRIGGER IF NOT EXISTS status_quotes_delete_count AFTER DELETE ON status_quotes
WHEN OLD.state = 'accepted'
  AND COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id) IS NOT NULL
BEGIN
    UPDATE status_stats SET quotes_count = quotes_count - 1
    WHERE status_id = COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id);
END;

CREATE TRIGGER IF NOT EXISTS status_quotes_update_count
AFTER UPDATE OF state, quoted_status_id, quoted_remote_status_id ON status_quotes
WHEN (CASE WHEN OLD.state = 'accepted' THEN COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id) END)
  IS NOT (CASE WHEN NEW.state = 'accepted' THEN COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id) END)
BEGIN
    UPDATE status_stats SET quotes_count = quotes_count - 1
    WHERE OLD.state = 'accepted'
      AND status_id = COALESCE(OLD.quoted_status_id, OLD.quoted_remote_status_id);
    INSERT INTO status_stats (status_id, quotes_count)
    SELECT COALESCE(NEW.quoted_status_id, NEW.quoted_remote_status_id), 1
    WHERE NEW.state = 'accepted'
      AND (EXISTS (SELECT 1 FROM statuses WHERE id = NEW.quoted_status_id)
           OR EXISTS (SELECT 1 FROM remote_statuses WHERE id = NEW.quoted_remote_status_id))
    ON CONFLICT (status_id) DO UPDATE SET quotes_count = quotes_count + 1;
END;
