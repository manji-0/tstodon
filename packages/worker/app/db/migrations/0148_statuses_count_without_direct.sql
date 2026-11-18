-- `account_stats.statuses_count` leaves direct statuses out, as Mastodon's
-- `Status#increment_counter_caches` does: the REST `statuses_count` and the
-- ActivityPub outbox's `totalItems` no longer reveal how many direct
-- messages an account sent. The triggers of 0138 counted every row.

DROP TRIGGER IF EXISTS statuses_insert_stats;
DROP TRIGGER IF EXISTS statuses_delete_stats;

CREATE TRIGGER statuses_insert_stats AFTER INSERT ON statuses
BEGIN
    INSERT INTO account_stats (account_id, statuses_count)
    VALUES (NEW.account_id, CASE WHEN NEW.visibility = 'direct' THEN 0 ELSE 1 END)
    ON CONFLICT (account_id) DO UPDATE
    SET statuses_count = statuses_count + CASE WHEN NEW.visibility = 'direct' THEN 0 ELSE 1 END;
END;

CREATE TRIGGER statuses_delete_stats AFTER DELETE ON statuses
BEGIN
    UPDATE account_stats SET statuses_count = statuses_count - 1
    WHERE account_id = OLD.account_id AND OLD.visibility <> 'direct';
    DELETE FROM status_stats WHERE status_id = OLD.id;
END;

-- An edit stores the visibility again (`updateLocalNote`); a change into or
-- out of direct moves the status out of or into the count.
CREATE TRIGGER statuses_update_visibility_stats
AFTER UPDATE OF visibility ON statuses
WHEN (OLD.visibility = 'direct') <> (NEW.visibility = 'direct')
BEGIN
    UPDATE account_stats
    SET statuses_count = statuses_count + CASE WHEN NEW.visibility = 'direct' THEN -1 ELSE 1 END
    WHERE account_id = NEW.account_id;
END;

UPDATE account_stats
SET statuses_count = (
    SELECT COUNT(*) FROM statuses
    WHERE statuses.account_id = account_stats.account_id AND statuses.visibility <> 'direct'
);
